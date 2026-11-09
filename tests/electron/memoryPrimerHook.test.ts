// Tests for the SessionStart memory hook (src/mcp-adapter/memory-primer-hook.cjs):
// the script that injects Termpolis project memory into every Claude session.
// Pure helpers are unit-tested; the never-throws / never-block invariant is proven
// by spawning the real script with no server (CI-safe — no network assertions).

import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const HOOK_PATH = join(process.cwd(), 'src', 'mcp-adapter', 'memory-primer-hook.cjs')
const hook = require(HOOK_PATH) as {
  tokenPath: () => string
  shouldPrime: (s: unknown) => boolean
  parseHookInput: (s: string) => Record<string, unknown>
  extractPrimer: (s: string) => string
  buildOutput: (p: string) => string
}

describe('memory-primer-hook', () => {
  describe('shouldPrime — start, resume, compact and clear', () => {
    it('primes on startup', () => expect(hook.shouldPrime('startup')).toBe(true))
    it('primes on resume', () => expect(hook.shouldPrime('resume')).toBe(true))
    it('defaults a missing/empty source to prime', () => {
      expect(hook.shouldPrime(undefined)).toBe(true)
      expect(hook.shouldPrime('')).toBe(true)
    })
    it('primes again after a compaction or /clear, which drop the digest', () => {
      expect(hook.shouldPrime('compact')).toBe(true)
      expect(hook.shouldPrime('clear')).toBe(true)
    })
    it('does NOT prime on unknown sources', () => {
      expect(hook.shouldPrime('whatever')).toBe(false)
    })
  })

  describe('parseHookInput — defensive JSON', () => {
    it('parses a valid hook object', () =>
      expect(hook.parseHookInput('{"source":"startup","cwd":"/x"}')).toEqual({ source: 'startup', cwd: '/x' }))
    it('returns {} for an empty string', () => expect(hook.parseHookInput('')).toEqual({}))
    it('returns {} for garbage', () => expect(hook.parseHookInput('not json {{{')).toEqual({}))
    it('returns {} for non-object JSON (array / primitive / null)', () => {
      expect(hook.parseHookInput('[1,2,3]')).toEqual({})
      expect(hook.parseHookInput('42')).toEqual({})
      expect(hook.parseHookInput('null')).toEqual({})
      expect(hook.parseHookInput('"a string"')).toEqual({})
    })
  })

  describe('extractPrimer — drills result.content[0].text.primer', () => {
    const wrap = (inner: unknown) =>
      JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(inner) }] } })

    it('extracts .primer from a well-formed MCP response', () =>
      expect(hook.extractPrimer(wrap({ project: 'termpolis', primer: 'HELLO MEMORY' }))).toBe('HELLO MEMORY'))
    it('returns "" when .primer is missing', () => expect(hook.extractPrimer(wrap({ project: 'x' }))).toBe(''))
    it('returns "" when .primer is not a string', () => expect(hook.extractPrimer(wrap({ primer: 123 }))).toBe(''))
    it('returns "" for an empty response', () => expect(hook.extractPrimer('')).toBe(''))
    it('returns "" for malformed outer JSON', () => expect(hook.extractPrimer('garbage{{{')).toBe(''))
    it('returns "" when result/content/text layers are missing', () => {
      expect(hook.extractPrimer(JSON.stringify({}))).toBe('')
      expect(hook.extractPrimer(JSON.stringify({ result: {} }))).toBe('')
      expect(hook.extractPrimer(JSON.stringify({ result: { content: [] } }))).toBe('')
      expect(hook.extractPrimer(JSON.stringify({ result: { content: [{}] } }))).toBe('')
    })
    it('returns "" when the inner text is not JSON', () =>
      expect(hook.extractPrimer(JSON.stringify({ result: { content: [{ text: 'not json' }] } }))).toBe(''))
  })

  describe('buildOutput — SessionStart additionalContext contract', () => {
    it('emits the correct hook output shape', () => {
      const out = JSON.parse(hook.buildOutput('CTX')) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string }
      }
      expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
      expect(out.hookSpecificOutput.additionalContext).toBe('CTX')
    })
    it('round-trips multi-line / special-character digests intact', () => {
      const digest = 'line1\nline2 "quoted" \\ backslash\ttab'
      const out = JSON.parse(hook.buildOutput(digest)) as {
        hookSpecificOutput: { additionalContext: string }
      }
      expect(out.hookSpecificOutput.additionalContext).toBe(digest)
    })
  })

  describe('tokenPath — cross-platform (matches termpolis-cli findToken)', () => {
    const orig = process.platform
    const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p })
    afterEach(() => Object.defineProperty(process, 'platform', { value: orig }))

    it('win32 → %APPDATA%\\termpolis\\mcp-token', () => {
      setPlatform('win32')
      expect(hook.tokenPath().replace(/\\/g, '/')).toMatch(/termpolis\/mcp-token$/)
    })
    it('darwin → ~/Library/Application Support/termpolis/mcp-token', () => {
      setPlatform('darwin')
      expect(hook.tokenPath().replace(/\\/g, '/')).toContain('Library/Application Support/termpolis/mcp-token')
    })
    it('linux → ~/.config/termpolis/mcp-token', () => {
      setPlatform('linux')
      expect(hook.tokenPath().replace(/\\/g, '/')).toContain('.config/termpolis/mcp-token')
    })
  })

  // The hook MUST never block or fail session start. Spawning the real script with
  // no priming source needs no server, so these are deterministic + CI-safe.
  describe('script invariant — never blocks or crashes', () => {
    const run = (stdin: string) => {
      // Isolate the token path to an empty home so the hook NEVER reaches the network,
      // regardless of whether a real Termpolis server happens to be running on this
      // machine (CI has none; a dev box often does). With no token file the hook
      // returns before any POST — keeping these invariants deterministic and fast.
      const emptyHome = mkdtempSync(join(tmpdir(), 'primer-hook-'))
      const env = { ...process.env, APPDATA: emptyHome, HOME: emptyHome, USERPROFILE: emptyHome, XDG_CONFIG_HOME: emptyHome }
      try {
        const r = spawnSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8', timeout: 10000, env })
        return { stdout: r.stdout || '', status: r.status }
      } finally {
        try {
          rmSync(emptyHome, { recursive: true, force: true })
        } catch {
          /* temp cleanup is best-effort */
        }
      }
    }

    it('exits 0 and injects nothing for source=compact', () => {
      const r = run('{"source":"compact","cwd":"/tmp"}')
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
    })
    it('exits 0 and injects nothing for source=clear', () => {
      const r = run('{"source":"clear"}')
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
    })
    it('exits 0 on malformed stdin (and any output is still valid SessionStart JSON)', () => {
      const r = run('not json at all {{{')
      expect(r.status).toBe(0)
      if (r.stdout) {
        const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string } }
        expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
      }
    })
  })
})

// v1.55.0 Task 5: the same script on UserPromptSubmit.
describe('memory-primer-hook on the first prompt', () => {
  const h = require(HOOK_PATH) as {
    isSubstantive: (p: unknown) => boolean
    redactPrompt: (p: string) => string
    quietRun: (env: Record<string, string | undefined>) => boolean
    buildOutput: (primer: string, event?: string) => string
  }
  const long = 'please look at how the release workflow signs the windows installer and why it failed today'

  it('asks only for a real prompt: twelve words or more, and not a slash command', () => {
    expect(h.isSubstantive(long)).toBe(true)
    expect(h.isSubstantive('fix the build')).toBe(false)
    expect(h.isSubstantive(`/review ${long}`)).toBe(false)
    expect(h.isSubstantive(undefined)).toBe(false)
  })

  it('takes secrets out and cuts the query before it leaves the hook', () => {
    const q = h.redactPrompt(`${long} with key ghp_${'a1B2'.repeat(9)} ${'x'.repeat(600)}`)
    expect(q).not.toContain('ghp_')
    expect(q).toContain('[redacted]')
    expect(q.length).toBeLessThanOrEqual(400)
  })

  it('stays quiet in a linked job or a read-only run', () => {
    expect(h.quietRun({ TERMPOLIS_LINKED_JOB: 'j1' })).toBe(true)
    expect(h.quietRun({ TERMPOLIS_READ_ONLY_RUN: '1' })).toBe(true)
    expect(h.quietRun({})).toBe(false)
  })

  it('answers as UserPromptSubmit', () => {
    expect(JSON.parse(h.buildOutput('notes', 'UserPromptSubmit')).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
  })

  it('hook is silent and fast when Termpolis is down', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-prompt-hook-'))
    try {
      const env = { ...process.env, APPDATA: dir, XDG_CONFIG_HOME: dir, HOME: dir, USERPROFILE: dir }
      const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: dir, prompt: long })
      const t0 = Date.now()
      const r = spawnSync(process.execPath, [HOOK_PATH], { input, env, encoding: 'utf8', timeout: 10_000 })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
      expect(Date.now() - t0).toBeLessThan(5000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
