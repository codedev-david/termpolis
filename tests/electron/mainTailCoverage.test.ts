// Tail-coverage suite for seven small main-process modules whose ERROR PATHS, early returns and
// fallback arms were the last untested code in each: sensitiveFileWatcher, aiSecurity,
// contextPrimer, memoryGraph, aiSessions, codeGraph, egressAudit.
//
// Everything here targets a branch that no other suite reaches — the `catch`, the `?? fallback`,
// the "already initialised" no-op, the corrupt-file path. Those are where the bugs live, which is
// exactly why they are worth a test. Nothing in this file asserts merely that a function ran.
//
// aiSecurity invariant respected throughout: an audit note names WHAT leaked (DB_PASSWORD), never
// the value. `hit.sample` carries a fragment of the secret for the named rules, so it is only ever
// asserted where the rule proves it CANNOT (the <=8-char '****' case).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readFileSync as readSync,
} from 'fs'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  matchSensitiveFile,
  matchToolEvent,
  extractPathsFromCommand,
  subscribeSensitiveReads,
  clearReadCount,
  RULES as FILE_RULES,
  _resetForTests as resetSensitiveWatcher,
  type SensitiveReadEvent,
} from '../../src/main/sensitiveFileWatcher'
import { publish, _resetForTests as resetEventBus, type AgentEvent } from '../../src/main/agentEventBus'

import { buildContextPrimer, type PrimerHit, type PrimerSearch } from '../../src/main/contextPrimer'

import {
  bfsTraverse,
  initMemoryGraph,
  addMemoryEdge,
  removeNodeEdges,
  traverseGraph,
  edgesFrom,
  neighboursOf,
  graphStats,
  importGraphEdges,
  expandWithGraph,
  _resetGraphForTests,
  type MemoryEdge,
} from '../../src/main/memoryGraph'

import { listAISessions, digestAISession } from '../../src/main/aiSessions'

import {
  ALL_REPOS,
  initCodeGraph,
  indexFileContent,
  persistCodeGraph,
  reindexPaths,
  reindexRepoGraph,
  reindexWatchedChange,
  resolveToken,
  resolveCodeRefs,
  codeSymbols,
  codeCallers,
  codeGraphStats,
  graphKeyForRoot,
  _resetCodeGraphForTests,
} from '../../src/main/codeGraph'

import {
  parseNetstatWindows,
  parseSsLinux,
  parseLsofMac,
  pollAgentEgress,
  recordEgress,
  getRecentEgress,
  clearEgress,
} from '../../src/main/egressAudit'

// ── electron stub (aiSecurity writes its settings + audit log under app.getPath('userData')) ──
const hoisted = vi.hoisted(() => ({
  userData: '',
  getPathCalls: 0,
  /** When set, overrides os.homedir() — used to point the AI-session scan at a fake home, and to
   *  prove the sensitive-file watcher survives a homedir() that throws. Null = the real thing. */
  homedir: null as null | (() => string),
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => {
      hoisted.getPathCalls++
      return hoisted.userData
    },
  },
}))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const homedir = (): string => (hoisted.homedir ? hoisted.homedir() : actual.homedir())
  return { ...actual, homedir, default: { ...actual, homedir } }
})

/** A pristine aiSecurity module instance (module-level `initialized` back to false). */
async function freshSecurity(): Promise<typeof import('../../src/main/aiSecurity')> {
  vi.resetModules()
  return await import('../../src/main/aiSecurity')
}

const tmps: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), 'tail7-' + prefix + '-'))
  tmps.push(d)
  return d
}

beforeEach(() => {
  hoisted.userData = tmp('userdata')
  hoisted.getPathCalls = 0
  hoisted.homedir = null
  resetSensitiveWatcher()
  resetEventBus()
  clearReadCount()
  clearEgress()
  _resetGraphForTests()
  _resetCodeGraphForTests()
})

afterEach(() => {
  for (const d of tmps.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

// =============================================================================================
// sensitiveFileWatcher
// =============================================================================================
describe('sensitiveFileWatcher — path normalisation edges', () => {
  it('strips SINGLE quotes the agent wrapped the path in, and reports the path verbatim', () => {
    const m = matchSensitiveFile("'/projects/app/.env'")
    expect(m).not.toBeNull()
    expect(m!.rule).toBe('dotenv')
    expect(m!.filePath).toBe("'/projects/app/.env'") // what the agent said it read, unaltered
  })

  it('does NOT treat ".env." (a trailing dot, empty suffix) as a .env file', () => {
    expect(matchSensitiveFile('/projects/app/.env.')).toBeNull()
  })

  it('returns null for a path that has no basename (a bare root)', () => {
    expect(matchSensitiveFile('/')).toBeNull()
  })

  it('survives a homedir() that throws: basename rules keep firing, only ~-anchored ones degrade', async () => {
    // Baseline with a working homedir: `~/.ssh/agent.sock` resolves under the home dir, so the
    // "anything inside ~/.ssh" rule can see the /.ssh/ segment.
    expect(matchSensitiveFile('~/.ssh/agent.sock')!.rule).toBe('ssh-dir-content')

    hoisted.homedir = () => { throw new Error('no home on this box') }
    vi.resetModules()
    try {
      const sfw = await import('../../src/main/sensitiveFileWatcher') // HOME captured at load → ''
      // The guard must not crash the watcher, and rules that key off the BASENAME still work.
      expect(sfw.matchSensitiveFile('~/.env')!.rule).toBe('dotenv')
      expect(sfw.matchSensitiveFile('/repo/app/.env')!.rule).toBe('dotenv')
      // Only the rules that need the expanded home path lose their anchor.
      expect(sfw.matchSensitiveFile('~/.ssh/agent.sock')).toBeNull()
    } finally {
      hoisted.homedir = null
      vi.resetModules()
    }
  })
})

describe('sensitiveFileWatcher — rule edges', () => {
  it('flags an id_<algo>_<suffix> key that is NOT in the exact-name list', () => {
    const m = matchSensitiveFile('/backups/keys/id_rsa_work')
    expect(m).not.toBeNull()
    expect(m!.rule).toBe('ssh-private-key')
  })

  it('does NOT flag the matching public half (id_rsa_work.pub)', () => {
    expect(matchSensitiveFile('/backups/keys/id_rsa_work.pub')).toBeNull()
  })

  it('does NOT flag the GnuPG PUBLIC keyrings (pubring.kbx / pubring.gpg)', () => {
    expect(matchSensitiveFile('/home/u/.gnupg/pubring.kbx')).toBeNull()
    expect(matchSensitiveFile('/home/u/.gnupg/pubring.gpg')).toBeNull()
  })

  it('gpg-private matches a .key inside .gnupg; through the public matcher the PEM rule claims it first', () => {
    const gpg = FILE_RULES.find((r) => r.id === 'gpg-private')!
    expect(gpg.match('mykey.key', '/home/u/.gnupg/mykey.key')).toBe(true)
    expect(gpg.match('pubring.gpg', '/home/u/.gnupg/pubring.gpg')).toBe(false)
    // Either way the file IS flagged — only the attributed rule differs (precedence, not a gap).
    expect(matchSensitiveFile('/home/u/.gnupg/mykey.key')!.rule).toBe('private-key-pem')
  })
})

describe('sensitiveFileWatcher — shell command parsing edges', () => {
  it('skips empty command segments (a leading separator)', () => {
    expect(extractPathsFromCommand('; cat /repo/.env')).toEqual(['/repo/.env'])
  })

  it('survives a command that is nothing but prefixes ("sudo sudo") without crashing', () => {
    expect(extractPathsFromCommand('sudo sudo')).toEqual([])
  })

  it('tolerates repeated whitespace between tokens', () => {
    expect(extractPathsFromCommand('cat   /repo/.env')).toEqual(['/repo/.env'])
  })

  it('ignores an empty quoted argument at the end of the line', () => {
    expect(extractPathsFromCommand('cat /repo/.env ""')).toEqual(['/repo/.env'])
  })
})

describe('sensitiveFileWatcher — matchToolEvent edges', () => {
  const ev = (payload: Record<string, unknown>): AgentEvent => ({
    id: 'e1', ts: 1, terminalId: 't1', agentType: 'claude', kind: 'tool_call', summary: '', payload,
  })

  it('ignores a tool_call whose payload names no tool', () => {
    expect(matchToolEvent(ev({ input: { file_path: '/repo/.env' } }))).toEqual([])
  })

  it('ignores an fs tool whose input object carries no path at all', () => {
    expect(matchToolEvent(ev({ tool: 'Read', input: {} }))).toEqual([])
  })

  it('ignores a JSON-stringified fs input that points at a harmless file', () => {
    expect(matchToolEvent(ev({ tool: 'Read', input: '{"file_path":"/repo/README.md"}' }))).toEqual([])
  })

  it('still catches a JSON-stringified fs input that points at a secret', () => {
    const hits = matchToolEvent(ev({ tool: 'Read', input: '{"file_path":"/repo/.env"}' }))
    expect(hits.map((h) => h.rule)).toEqual(['dotenv'])
    expect(hits[0].source).toBe('path')
  })
})

describe('sensitiveFileWatcher — subscription lifecycle', () => {
  it('unsubscribing twice is a no-op, and no further events are delivered', () => {
    const seen: SensitiveReadEvent[] = []
    const off = subscribeSensitiveReads((e) => seen.push(e))
    off()
    expect(() => off()).not.toThrow() // second call: the handle is already released
    publish({
      terminalId: 't-off', agentType: 'claude', kind: 'tool_call', summary: 'Read',
      payload: { tool: 'Read', input: { file_path: '/repo/.env' } },
    })
    expect(seen).toEqual([])
  })
})

// =============================================================================================
// aiSecurity
// =============================================================================================
describe('aiSecurity — initialisation is idempotent', () => {
  it('a second initAiSecurity() is a no-op (userData is resolved exactly once)', async () => {
    const m = await freshSecurity()
    m.initAiSecurity()
    expect(hoisted.getPathCalls).toBe(1)
    m.initAiSecurity()
    expect(hoisted.getPathCalls).toBe(1) // early return — no second resolve, no second file read
  })
})

describe('aiSecurity — settings getters/setters self-initialise', () => {
  it('setCommitShield() as the FIRST call initialises, persists, and survives a reload', async () => {
    const m = await freshSecurity()
    const s = m.setCommitShield(false) // no initAiSecurity() first — the setter must bootstrap
    expect(s.commitShield).toBe(false)
    expect(existsSync(join(hoisted.userData, 'ai-security-settings.json'))).toBe(true)
    const reloaded = await freshSecurity()
    expect(reloaded.getSettings().commitShield).toBe(false)
  })

  it('setEgressGuard() as the FIRST call initialises, persists, and survives a reload', async () => {
    const m = await freshSecurity()
    expect(m.setEgressGuard(false).egressGuard).toBe(false)
    const reloaded = await freshSecurity()
    expect(reloaded.getSettings().egressGuard).toBe(false)
  })

  it('setStrictGeminiPaidOnly() as the FIRST call initialises and persists', async () => {
    const m = await freshSecurity()
    expect(m.setStrictGeminiPaidOnly(true).strictGeminiPaidOnly).toBe(true)
    const reloaded = await freshSecurity()
    expect(reloaded.getSettings().strictGeminiPaidOnly).toBe(true)
  })

  it('the setters run on an ALREADY-initialised module without re-reading userData', async () => {
    const m = await freshSecurity()
    m.initAiSecurity()
    expect(hoisted.getPathCalls).toBe(1)
    expect(m.setAuditEnabled(false).auditEnabled).toBe(false)
    expect(m.setCommitShield(true).commitShield).toBe(true)
    expect(m.setEgressGuard(true).egressGuard).toBe(true)
    expect(hoisted.getPathCalls).toBe(1) // none of them re-initialised
  })

  it('a non-boolean toggle value FAILS SECURE (coerced to false, never truthy-accepted)', async () => {
    const m = await freshSecurity()
    m.initAiSecurity()
    expect(m.setCommitShield('yes' as unknown as boolean).commitShield).toBe(false)
    expect(m.setEgressGuard(1 as unknown as boolean).egressGuard).toBe(false)
  })
})

describe('aiSecurity — audit file lifecycle', () => {
  it('appendAudit() as the FIRST call bootstraps the module and writes the entry', async () => {
    const m = await freshSecurity()
    await m.appendAudit({ agent: 'claude', event: 'terminal_open', terminalId: 't1' })
    const recent = await m.getRecentAudit()
    expect(recent).toHaveLength(1)
    expect(recent[0].event).toBe('terminal_open')
  })

  it('getAuditPath() as the FIRST call bootstraps the module and returns the userData path', async () => {
    const m = await freshSecurity()
    expect(m.getAuditPath()).toBe(join(hoisted.userData, 'ai-security-audit.jsonl'))
  })

  it('rotates an oversized log even when NO prior rotation exists', async () => {
    const m = await freshSecurity()
    m.setAuditEnabled(true)
    const auditPath = m.getAuditPath()
    const prevPath = auditPath.replace(/\.jsonl$/, '.prev.jsonl')
    expect(existsSync(prevPath)).toBe(false) // nothing to unlink — the branch the other suite skips
    writeFileSync(auditPath, 'x'.repeat(10 * 1024 * 1024 + 16))
    await m.appendAudit({ agent: 'claude', event: 'terminal_open' })
    expect(existsSync(prevPath)).toBe(true) // the old log was rolled aside...
    const after = readFileSync(auditPath, 'utf8')
    expect(after.length).toBeLessThan(1024) // ...and the live log restarted with just the new entry
    expect(after).toContain('terminal_open')
  })

  it('clearAudit() on a fresh module removes a stale .prev log and tolerates a missing live log', async () => {
    const m = await freshSecurity()
    const prevPath = join(hoisted.userData, 'ai-security-audit.prev.jsonl')
    writeFileSync(prevPath, '{"ts":"old"}\n')
    await m.clearAudit() // first call on the module: no live log exists, only the rotation
    expect(existsSync(prevPath)).toBe(false)
    expect(existsSync(join(hoisted.userData, 'ai-security-audit.jsonl'))).toBe(false)
    await expect(m.clearAudit()).resolves.toBeUndefined() // idempotent
  })
})

describe('aiSecurity — scanText / detector edges', () => {
  it('a match of 8 chars or fewer is sampled as **** (the fragment cannot leak the value)', async () => {
    const m = await freshSecurity()
    const r = m.scanText('Server=db;Pwd=abcd;')
    const hit = r.hits.find((h) => h.rule === 'conn_string_password')!
    expect(hit).toBeDefined()
    expect(hit.sample).toBe('****') // short match → nothing of it is echoed at all
    expect(hit.name).toBe('Pwd') // the NAME is what makes the audit actionable
    expect(r.redacted).toContain('[REDACTED:conn_string_password]')
    expect(r.redacted).not.toContain('abcd')
  })

  it('detectCodeChunk returns the empty signal set for empty / non-string input', async () => {
    const m = await freshSecurity()
    for (const bad of ['', undefined, null, 42]) {
      const r = m.detectCodeChunk(bad as unknown as string)
      expect(r).toEqual({ isCode: false, byteSize: 0, lineCount: 0, signals: [] })
    }
  })

  it('detectEnvDump returns the empty signal set for non-string input', async () => {
    const m = await freshSecurity()
    expect(m.detectEnvDump(null as unknown as string)).toEqual({ isEnvDump: false, varCount: 0, variableNames: [] })
  })
})

describe('aiSecurity — processOutboundChunk edges', () => {
  const AI = { isAiTerminal: true }

  it('a non-string chunk still yields the "don\'t touch" contract: writeChunk is "" and staging is kept', async () => {
    const m = await freshSecurity()
    const r = m.processOutboundChunk('half-typed', null as unknown as string, AI)
    expect(r.action).toBe('pass')
    expect(r.writeChunk).toBe('') // `data ?? ''` — never `undefined` into the PTY write
    expect(r.newStaging).toBe('half-typed')
    expect(r.scan).toBeUndefined()
  })

  it('an OBSERVED secret inside a big code paste carries the codeChunk hint too', async () => {
    const m = await freshSecurity()
    const code = Array.from({ length: 80 }, (_, i) =>
      `  function thing${i}(a) {\n    const x = a + 1;\n    return x;\n  }`,
    ).join('\n')
    const paste = code + '\nconst ghToken = "ghp_' + 'a'.repeat(36) + '"\n'
    const r = m.processOutboundChunk('', paste, AI)
    expect(r.action).toBe('observed') // a secret went out...
    expect(r.scan!.hits.some((h) => h.rule === 'gh_pat')).toBe(true)
    expect(r.codeChunk?.isCode).toBe(true) // ...inside something that also looks like source code
    expect(r.envDump).toBeUndefined() // but it is not a .env dump
    expect(r.writeChunk).toBe(paste) // THE INVARIANT: forwarded byte-for-byte, never rewritten
  })
})

// =============================================================================================
// contextPrimer
// =============================================================================================
describe('contextPrimer — search-contract edges', () => {
  const mk = (over: Partial<PrimerHit> & { content: string }): PrimerHit =>
    ({ kind: 'note', score: 0.9, ...over })

  it('scopes the project pass by the FULL cwd when projectPath is given (not the bare slug)', async () => {
    const search = vi.fn(async (o: { project?: string }) =>
      (o.project ? [mk({ id: 'p1', content: 'project decision about MCP ports', source: 'claude', kind: 'message' })] : []))
    const out = await buildContextPrimer(search, { query: 'q', project: 'myrepo', projectPath: 'C:/repos/two/myrepo' })
    expect(search).toHaveBeenCalledWith({ query: 'q', limit: 40, project: 'C:/repos/two/myrepo' })
    expect(out).toContain('This project (myrepo)') // display still uses the slug
  })

  it('a blank projectPath falls back to the slug rather than blanking the scope', async () => {
    const search = vi.fn(async (o: { project?: string }) =>
      (o.project ? [mk({ id: 'p1', content: 'project decision about MCP ports', source: 'claude', kind: 'message' })] : []))
    await buildContextPrimer(search, { query: 'q', project: 'myrepo', projectPath: '   ' })
    expect(search).toHaveBeenCalledWith({ query: 'q', limit: 40, project: 'myrepo' })
  })

  it('a search that RESOLVES to null/undefined yields no primer instead of throwing', async () => {
    const search = (async (o: { project?: string }) => (o.project ? undefined : null)) as unknown as PrimerSearch
    await expect(buildContextPrimer(search, { query: 'q', project: 'myrepo' })).resolves.toBeNull()
  })

  it('a FAILING global pass does not discard the project context that already succeeded', async () => {
    const search: PrimerSearch = async (o) => {
      if (o.project) return [mk({ id: 'p1', content: 'we pinned web-tree-sitter to 0.21', source: 'claude', kind: 'message' })]
      throw new Error('global index unavailable')
    }
    const out = await buildContextPrimer(search, { query: 'q', project: 'myrepo' })
    expect(out).toContain('we pinned web-tree-sitter to 0.21')
    expect(out).toContain('This project (myrepo)')
    expect(out).not.toContain('Other saved context') // there is no global bucket to show
  })
})

describe('contextPrimer — line rendering edges', () => {
  const mk = (over: Partial<PrimerHit> & { content: string }): PrimerHit =>
    ({ kind: 'note', score: 0.9, ...over })

  it('labels a hit with neither source nor kind as [note]', async () => {
    const out = await buildContextPrimer(async () => [mk({ content: 'a bare fact', kind: '' })], { query: 'q' })
    expect(out).toContain('- [note] a bare fact')
  })

  it('a hit with no content renders no line at all (and never a blank bullet)', async () => {
    const search = async (): Promise<PrimerHit[]> => [
      mk({ content: undefined as unknown as string, score: 0.95 }),
      mk({ content: 'the only real memory', score: 0.9 }),
    ]
    const out = await buildContextPrimer(search, { query: 'q' })
    expect(out).toContain('- [note] the only real memory')
    expect((out!.match(/^- \[/gm) || []).length).toBe(1)
  })

  it('a code memory with no parseable path is NOT guessed stale, even when the file probe says gone', async () => {
    // Leading newline → the "<path>:<line>" prefix is absent, so there is nothing to check.
    const out = await buildContextPrimer(
      async () => [mk({ content: '\nconst x = 1', source: 'code' })],
      { query: 'q', fileExists: () => false },
    )
    expect(out).toContain('[code] const x = 1')
    expect(out).not.toContain('STALE')
  })
})

describe('contextPrimer — project-bucket ordering and caps', () => {
  const mk = (over: Partial<PrimerHit> & { content: string; id: string }): PrimerHit =>
    ({ kind: 'note', score: 0.9, ...over })

  it('past conversations lead the bucket; a message from a NON-conversation source does not count as one', async () => {
    const search: PrimerSearch = async (o) => (o.project ? [
      mk({ id: 'a', content: 'claude chat about the MCP port', source: 'claude', kind: 'message', score: 0.9 }),
      mk({ id: 'b', content: 'a code chunk from the repo', source: 'code', kind: 'note', score: 0.85 }),
      mk({ id: 'c', content: 'a message whose source is not a transcript', source: 'note', kind: 'message', score: 0.8 }),
      mk({ id: 'd', content: 'a message carrying no source at all', kind: 'message', score: 0.75 }),
    ] : [])
    const out = await buildContextPrimer(search, { query: 'q', project: 'myrepo' })
    const at = (s: string): number => out!.indexOf(s)
    expect(at('claude chat about the MCP port')).toBeGreaterThan(-1)
    expect(at('claude chat about the MCP port')).toBeLessThan(at('a code chunk from the repo'))
    // The other three are NOT conversations, so the stable sort leaves their input order intact.
    expect(at('a code chunk from the repo')).toBeLessThan(at('a message whose source is not a transcript'))
    expect(at('a message whose source is not a transcript')).toBeLessThan(at('a message carrying no source at all'))
  })

  it('the inject limit is respected even when promoted global hits swell the project bucket', async () => {
    const search: PrimerSearch = async (o) => (o.project ? [
      mk({ id: 'p1', content: 'project hit one', source: 'claude', kind: 'message', score: 0.9 }),
      mk({ id: 'p2', content: 'project hit two', source: 'claude', kind: 'message', score: 0.88 }),
    ] : [
      // Both mention the slug, so both get PROMOTED into the project bucket — which would be 4
      // lines against a limit of 2 if the cap did not hold.
      mk({ id: 'g1', content: 'legacy note about myrepo deploys', source: 'claude', kind: 'message', score: 0.87 }),
      mk({ id: 'g2', content: 'another legacy myrepo note', source: 'claude', kind: 'message', score: 0.86 }),
    ])
    const out = await buildContextPrimer(search, { query: 'q', project: 'myrepo', limit: 2 })
    expect((out!.match(/^- \[/gm) || []).length).toBe(2)
    expect(out).toContain('project hit one')
    expect(out).toContain('project hit two')
    expect(out).not.toContain('legacy note about myrepo deploys')
    expect(out).not.toContain('Other saved context') // every global hit was promoted, none left over
  })

  it('blank hits are dropped from BOTH the project bucket and the "other context" bucket', async () => {
    const search: PrimerSearch = async (o) => (o.project ? [
      mk({ id: 'p0', content: '   ', score: 0.95 }),
      mk({ id: 'p1', content: 'the real project note', score: 0.9 }),
    ] : [
      mk({ id: 'g0', content: '  \t ', score: 0.95 }),
      mk({ id: 'g1', content: 'the real global note', score: 0.9 }),
    ])
    const out = await buildContextPrimer(search, { query: 'q', project: 'myrepo' })
    expect(out).toContain('the real project note')
    expect(out).toContain('the real global note')
    expect(out).toContain('Other saved context')
    expect((out!.match(/^- \[/gm) || []).length).toBe(2) // the two blanks rendered nothing
  })

  it('dedupes across the two passes by CONTENT when the entries carry no id', async () => {
    const shared = { content: 'a legacy entry with no id', source: 'claude', kind: 'message', score: 0.9 }
    const search: PrimerSearch = async () => [{ ...shared }]
    const out = await buildContextPrimer(search, { query: 'q', project: 'myrepo' })
    expect(out!.match(/a legacy entry with no id/g)).toHaveLength(1)
  })
})

// =============================================================================================
// memoryGraph
// =============================================================================================
describe('memoryGraph — bfsTraverse over incoming edges', () => {
  const edge = (from: string, to: string, over: Partial<MemoryEdge> = {}): MemoryEdge =>
    ({ from, to, relation: 'solves', weight: 1, ts: 0, ...over })

  it('an EXPIRED incoming edge is not traversed', () => {
    const now = 1_000_000
    const reverse = new Map<string, MemoryEdge[]>([['A', [
      edge('B', 'A', { validTo: now - 1 }), // out of force
      edge('C', 'A'), // windowless → always valid
    ]]])
    const hits = bfsTraverse(new Map(), 'A', { directed: false, reverse, now })
    expect(hits.map((h) => h.id)).toEqual(['C'])
    expect(hits[0].relation).toBe('solved-by') // walked backwards → relabelled from A's perspective
  })

  it('stops at the limit while expanding incoming edges', () => {
    const reverse = new Map<string, MemoryEdge[]>([['A', [edge('B', 'A'), edge('C', 'A'), edge('D', 'A')]]])
    const hits = bfsTraverse(new Map(), 'A', { directed: false, reverse, limit: 2 })
    expect(hits.map((h) => h.id)).toEqual(['B', 'C'])
  })
})

describe('memoryGraph — persisted removeNode markers', () => {
  it('applies a {removeNode} marker in APPEND ORDER: earlier edges pruned, later ones survive', () => {
    const dir = tmp('graph')
    writeFileSync(join(dir, 'memory-graph.jsonl'), [
      JSON.stringify({ from: 'a', to: 'x', relation: 'solves', weight: 1, ts: 1 }),
      JSON.stringify({ from: 'b', to: 'c', relation: 'relates-to', weight: 1, ts: 1 }),
      JSON.stringify({ removeNode: 'x' }),
      JSON.stringify({ from: 'd', to: 'x', relation: 'solves', weight: 1, ts: 2 }), // re-added AFTER
    ].join('\n') + '\n')

    initMemoryGraph(dir)

    expect(graphStats().edges).toBe(2)
    expect(edgesFrom('a')).toEqual([]) // pruned by the marker
    expect(edgesFrom('d').map((e) => e.to)).toEqual(['x']) // written after it → kept
    expect(edgesFrom('b').map((e) => e.to)).toEqual(['c'])
  })
})

describe('memoryGraph — removeNodeEdges', () => {
  it('prunes only the edges incident to the node, leaving every other adjacency intact', () => {
    initMemoryGraph(tmp('graph'))
    addMemoryEdge({ from: 'A', to: 'X', relation: 'solves' })
    addMemoryEdge({ from: 'B', to: 'X', relation: 'solves' })
    addMemoryEdge({ from: 'B', to: 'C', relation: 'relates-to' })
    addMemoryEdge({ from: 'X', to: 'D', relation: 'causes' })
    addMemoryEdge({ from: 'C', to: 'D', relation: 'follows' })

    expect(removeNodeEdges('X')).toBe(3) // A->X, B->X, X->D

    expect(graphStats().edges).toBe(2)
    expect(edgesFrom('A')).toEqual([]) // its ONLY edge pointed at X → the node drops out
    expect(edgesFrom('B').map((e) => e.to)).toEqual(['C']) // kept its surviving edge
    expect(edgesFrom('C').map((e) => e.to)).toEqual(['D']) // untouched
    expect(traverseGraph('X')).toEqual([]) // no dangling links back into the deleted node
    expect(neighboursOf('D').map((n) => n.id)).toEqual(['C']) // the reverse index was pruned too
  })

  it('is a no-op for an empty id', () => {
    initMemoryGraph(tmp('graph'))
    addMemoryEdge({ from: 'A', to: 'B' })
    expect(removeNodeEdges('')).toBe(0)
    expect(graphStats().edges).toBe(1)
  })
})

describe('memoryGraph — neighbour/edge accessors', () => {
  it('edgesFrom() returns [] for a node the graph has never seen', () => {
    initMemoryGraph(tmp('graph'))
    expect(edgesFrom('nobody')).toEqual([])
  })

  it('a weaker REVERSE edge never overrides the stronger forward relation to the same neighbour', () => {
    initMemoryGraph(tmp('graph'))
    addMemoryEdge({ from: 'A', to: 'B', relation: 'solves', weight: 0.9 })
    addMemoryEdge({ from: 'B', to: 'A', relation: 'relates-to', weight: 0.2 })
    const n = neighboursOf('A')
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ id: 'B', relation: 'solves', weight: 0.9 })
  })

  it('neighboursOf() works for a node that has only OUTGOING edges', () => {
    initMemoryGraph(tmp('graph'))
    addMemoryEdge({ from: 'S', to: 'T', relation: 'causes' })
    expect(neighboursOf('S').map((x) => x.id)).toEqual(['T'])
  })
})

describe('memoryGraph — importGraphEdges', () => {
  it('returns 0 for empty input', () => {
    initMemoryGraph(tmp('graph'))
    expect(importGraphEdges('')).toBe(0)
    expect(graphStats().edges).toBe(0)
  })

  it('skips blank and malformed lines, importing only the valid edges', () => {
    initMemoryGraph(tmp('graph'))
    const n = importGraphEdges([
      '{"from":"a","to":"b","relation":"solves","weight":0.5,"ts":7}',
      '', '   ',
      'this is not json',
      '{"to":"c"}', // no `from` → not an edge
      '{"from":"b","to":"c"}',
    ].join('\n'))
    expect(n).toBe(2)
    expect(graphStats().edges).toBe(2)
    expect(edgesFrom('a')[0]).toMatchObject({ to: 'b', relation: 'solves', weight: 0.5, ts: 7 })
  })
})

describe('memoryGraph — expandWithGraph (GraphRAG fusion)', () => {
  const hit = (id: string, score: number): { id: string; score: number } => ({ id, score })

  it('stops adding fused neighbours once the cap is reached, before the next seed', () => {
    const ranked = [hit('s1', 1), hit('s2', 0.9)]
    const neighbours = (id: string): Array<{ id: string; weight: number }> =>
      (id === 's1' ? [{ id: 'n1', weight: 0.8 }] : [{ id: 'n2', weight: 0.8 }])
    const out = expandWithGraph(ranked, neighbours, (id, score) => hit(id, score), { cap: 1 })
    expect(out.map((o) => o.id)).toEqual(['s1', 's2', 'n1']) // n2 never got in — the cap held
  })

  it('a zero-relevance seed drags no neighbour in (fused score must be > 0)', () => {
    const out = expandWithGraph([hit('s1', 0)], () => [{ id: 'n1', weight: 0.9 }], (id, score) => hit(id, score))
    expect(out.map((o) => o.id)).toEqual(['s1'])
  })
})

// =============================================================================================
// aiSessions
// =============================================================================================
describe('aiSessions — listAISessions edges', () => {
  let projectsRoot = ''
  beforeEach(() => { projectsRoot = tmp('aisess') })

  const write = (folder: string, name: string, body: string): string => {
    const dir = join(projectsRoot, folder)
    mkdirSync(dir, { recursive: true })
    const fp = join(dir, name)
    writeFileSync(fp, body, 'utf8')
    return fp
  }
  const jsonl = (...objs: object[]): string => objs.map((o) => JSON.stringify(o)).join('\n') + '\n'

  it('returns [] when the projects root cannot be read at all', async () => {
    expect(await listAISessions({ projectsRoot: join(projectsRoot, 'does-not-exist') })).toEqual([])
  })

  it('skips a stray FILE sitting directly in the projects root', async () => {
    writeFileSync(join(projectsRoot, 'notes.txt'), 'not a project folder', 'utf8')
    write('p', 'real.jsonl', jsonl({ type: 'user', message: { role: 'user', content: 'ok' }, cwd: '/repos/r' }))
    expect((await listAISessions({ projectsRoot })).map((s) => s.id)).toEqual(['real'])
  })

  it('skips a file named exactly ".jsonl" (there is no session id to key on)', async () => {
    write('p', '.jsonl', jsonl({ type: 'user', message: { role: 'user', content: 'x' }, cwd: '/repos/r' }))
    write('p', 'real.jsonl', jsonl({ type: 'user', message: { role: 'user', content: 'ok' }, cwd: '/repos/r' }))
    expect((await listAISessions({ projectsRoot })).map((s) => s.id)).toEqual(['real'])
  })

  it('skips a DIRECTORY that happens to be named *.jsonl (it cannot be read as a file)', async () => {
    mkdirSync(join(projectsRoot, 'p', 'weird.jsonl'), { recursive: true })
    write('p', 'ok.jsonl', jsonl({ type: 'user', message: { role: 'user', content: 'ok' }, cwd: '/repos/r' }))
    expect((await listAISessions({ projectsRoot })).map((s) => s.id)).toEqual(['ok'])
  })

  it('drops the last line when the head read may have truncated it mid-JSON', async () => {
    const l1 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'the goal' }, cwd: '/repos/t' })
    const l2 = JSON.stringify({ gitBranch: 'feature/only-in-the-tail' })
    write('p', 'trunc.jsonl', l1 + '\n' + l2) // no trailing newline → the tail is suspect
    const [s] = await listAISessions({ projectsRoot })
    expect(s.firstUserMessage).toBe('the goal')
    expect(s.gitBranch).toBeUndefined() // the possibly-truncated line contributed nothing
  })

  it('skips a malformed JSONL line without aborting the summary', async () => {
    write('p', 'mixed.jsonl',
      '{not json\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'good line' }, cwd: '/repos/m' }) + '\n')
    const [s] = await listAISessions({ projectsRoot })
    expect(s.firstUserMessage).toBe('good line')
  })

  it('ignores a type:user record whose message role is NOT the user', async () => {
    write('p', 'roles.jsonl', jsonl(
      { type: 'user', message: { role: 'assistant', content: 'tool output echoed back' }, cwd: '/repos/r' },
      { type: 'user', message: { content: 'the real ask (no role field)' } }, // role absent → still a user turn
    ))
    const [s] = await listAISessions({ projectsRoot })
    expect(s.firstUserMessage).toBe('the real ask (no role field)')
  })

  it('walks past non-text content blocks and non-array content to the first usable string', async () => {
    write('p', 'blocks.jsonl', jsonl(
      { type: 'user', message: { role: 'user', content: { unexpected: 'shape' } }, cwd: '/repos/b' }, // neither string nor array
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', id: 'x' }, 'a plain string part'] } },
    ))
    const [s] = await listAISessions({ projectsRoot })
    expect(s.firstUserMessage).toBe('a plain string part')
  })

  it('defaults the scan root to ~/.claude/projects when no root is given', async () => {
    const fakeHome = tmp('home')
    const dir = join(fakeHome, '.claude', 'projects', 'proj-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sess-home.jsonl'),
      jsonl({ type: 'user', message: { role: 'user', content: 'from the default root' }, cwd: '/repos/home' }), 'utf8')

    hoisted.homedir = () => fakeHome
    const sessions = await listAISessions() // no opts at all → the homedir fallback
    expect(sessions.map((s) => s.id)).toEqual(['sess-home'])
    expect(sessions[0].firstUserMessage).toBe('from the default root')
  })
})

describe('aiSessions — digestAISession edges', () => {
  let root = ''
  beforeEach(() => { root = tmp('digest') })

  it('returns null for a path that is a DIRECTORY (stat succeeds, read does not)', async () => {
    expect(await digestAISession(root)).toBeNull()
  })

  it('returns null for a file named exactly ".jsonl" (no session id)', async () => {
    const fp = join(root, '.jsonl')
    writeFileSync(fp, JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' }, cwd: '/x' }) + '\n', 'utf8')
    expect(await digestAISession(fp)).toBeNull()
  })

  it('counts only real turns — a mis-roled user record and a text-less assistant record are skipped', async () => {
    const fp = join(root, 'turns.jsonl')
    writeFileSync(fp, [
      { type: 'user', message: { role: 'user', content: 'the ask' }, cwd: '/repos/d' },
      { type: 'user', message: { role: 'assistant', content: 'echoed back, not a user turn' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1' }] } }, // no text
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the reply' }] } },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')

    const d = (await digestAISession(fp))!
    expect(d.totalUserTurns).toBe(1)
    expect(d.totalAssistantTurns).toBe(1)
    expect(d.recentUserMessages).toEqual(['the ask'])
    expect(d.lastAssistantText).toBe('the reply')
  })
})

// =============================================================================================
// codeGraph
// =============================================================================================
describe('codeGraph — loading a persisted graph', () => {
  const rec = (over: Record<string, unknown>): Record<string, unknown> => ({
    kind: 'function', lang: 'ts', refs: [], startLine: 1, endLine: 3, ...over,
  })

  it('loads a graph file that carries only symbols, and one that carries only imports', () => {
    const dir = tmp('cg')
    writeFileSync(join(dir, 'code-graph.json'), JSON.stringify({
      symbols: [rec({ id: '/r/a.ts#solo@1', name: 'solo', file: '/r/a.ts' })],
    })) // no `imports` key
    writeFileSync(join(dir, 'code-graph-0123456789abcdef.json'), JSON.stringify({
      imports: [['/r/b.ts', ['./dep']]],
    })) // no `symbols` key

    initCodeGraph(dir)

    expect(codeGraphStats().symbols).toBe(1)
    expect(codeGraphStats('0123456789abcdef').symbols).toBe(0)
    expect(codeGraphStats(ALL_REPOS).symbols).toBe(1)
    expect(codeSymbols('solo').map((s) => s.name)).toEqual(['solo'])
  })

  it('a symbol that references the same callee twice still produces exactly ONE edge', () => {
    const dir = tmp('cg')
    writeFileSync(join(dir, 'code-graph.json'), JSON.stringify({
      symbols: [
        rec({ id: '/r/a.ts#caller@1', name: 'caller', file: '/r/a.ts', refs: ['callee', 'callee'] }),
        rec({ id: '/r/a.ts#callee@10', name: 'callee', file: '/r/a.ts', startLine: 10, endLine: 12 }),
      ],
    }))

    initCodeGraph(dir)

    expect(codeGraphStats().edges).toBe(1)
    expect(codeCallers('callee').map((s) => s.name)).toEqual(['caller'])
  })

  it('a corrupt graph with DUPLICATE symbol ids re-indexes cleanly and yields no phantom hits', () => {
    const dir = tmp('cg')
    writeFileSync(join(dir, 'code-graph.json'), JSON.stringify({
      symbols: [
        rec({ id: '/r/u.ts#dup@1', name: 'alpha', file: '/r/u.ts' }),
        rec({ id: '/r/u.ts#dup@1', name: 'beta', file: '/r/u.ts', startLine: 5, endLine: 7 }), // SAME id
      ],
    }))
    initCodeGraph(dir)

    // Re-indexing the file must prune it even though the duplicate id breaks the 1:1 mapping.
    expect(indexFileContent('/r/u.ts', '')).toBe(0)
    expect(codeGraphStats().symbols).toBe(0)
    // Stale index entries survive the prune, but must NEVER resolve to a symbol that is gone.
    expect(resolveToken('u.ts')).toEqual({ symbols: [], files: [] })
    expect(resolveToken('alpha')).toEqual({ symbols: [], files: [] })
  })
})

describe('codeGraph — indexing edges', () => {
  it('extracts and PERSISTS a file\'s imports alongside its symbols', () => {
    const dir = tmp('cg')
    initCodeGraph(dir)
    const n = indexFileContent('/r/m.ts', "import { helper } from './helper'\nexport function main() {\n  return helper()\n}\n")
    expect(n).toBeGreaterThan(0)
    persistCodeGraph()

    const data = JSON.parse(readSync(join(dir, 'code-graph.json'), 'utf8'))
    expect(data.imports).toEqual([['/r/m.ts', ['./helper']]])
    expect(data.symbols.map((s: { name: string }) => s.name)).toContain('main')
  })

  it('returns 0 for a file whose extension has no extractor at all', () => {
    initCodeGraph(tmp('cg'))
    expect(indexFileContent('/r/readme.md', '# hello')).toBe(0)
    expect(codeGraphStats().symbols).toBe(0)
  })

  it('re-indexes a changed file with no tree-sitter grammar via the heuristic extractor', async () => {
    initCodeGraph(tmp('cg'))
    const n = await reindexPaths(
      ['/r/infra/main.tf'],
      async () => 'resource "aws_s3_bucket" "media" {\n  bucket = "x"\n}\n',
    )
    expect(n).toBe(1)
    const [sym] = codeSymbols('media')
    expect(sym).toMatchObject({ name: 'media', lang: 'terraform', file: '/r/infra/main.tf' })
  })
})

describe('codeGraph — resolveToken / resolveCodeRefs edges', () => {
  it('resolveToken() returns nothing for a null/undefined token', () => {
    initCodeGraph(tmp('cg'))
    expect(resolveToken(undefined as unknown as string)).toEqual({ symbols: [], files: [] })
    expect(resolveToken('   ')).toEqual({ symbols: [], files: [] })
  })

  it('resolveCodeRefs() dedupes repeated names and stamps the ACTIVE repo key', () => {
    initCodeGraph(tmp('cg'))
    indexFileContent('/r/svc.ts', 'export function doWork() {\n  return 1\n}\n')

    const refs = resolveCodeRefs(['doWork', 'doWork'])
    expect(refs).toHaveLength(1) // the second mention adds nothing
    expect(refs[0]).toMatchObject({ file: '/r/svc.ts', symbol: 'doWork', projectKey: '' })
  })

  it('resolveCodeRefs() leaves projectKey UNSET when querying across all repos', () => {
    initCodeGraph(tmp('cg'))
    indexFileContent('/r/svc.ts', 'export function doWork() {\n  return 1\n}\n')

    const [ref] = resolveCodeRefs(['doWork'], ALL_REPOS)
    expect(ref.symbol).toBe('doWork')
    expect(ref.projectKey).toBeUndefined() // a cross-repo ref cannot claim one repo's key
  })

  it('resolveCodeRefs() anchors a bare FILENAME token to the file (no symbol)', () => {
    initCodeGraph(tmp('cg'))
    indexFileContent('/r/svc.ts', 'export function doWork() {\n  return 1\n}\n')

    const refs = resolveCodeRefs(['svc.ts'])
    expect(refs).toEqual([{ file: '/r/svc.ts', projectKey: '' }])
  })

  it('resolveCodeRefs() returns [] when handed no names at all', () => {
    initCodeGraph(tmp('cg'))
    expect(resolveCodeRefs(undefined as unknown as string[])).toEqual([])
  })
})

describe('codeGraph — watched-change re-index against a real repo', () => {
  let repo = ''
  beforeEach(() => {
    repo = tmp('repo')
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'main.tf'), 'resource "aws_s3_bucket" "media" {\n  bucket = "x"\n}\n', 'utf8')
    execFileSync('git', ['add', 'main.tf'], { cwd: repo, stdio: 'ignore' })
    initCodeGraph(tmp('cg'))
  })

  it('reindexRepoGraph() discovers and reads the repo\'s files from disk', async () => {
    const stats = await reindexRepoGraph(repo)
    expect(stats.symbols).toBe(1)
    expect(codeSymbols('media', 50, graphKeyForRoot(repo)).map((s) => s.name)).toEqual(['media'])
  })

  it('a change set that cannot be joined to the root falls back to a FULL repo re-sweep', async () => {
    // A non-string path makes path.join throw inside the incremental pass. The graph must still
    // end up fresh — a watch event may never leave it stale.
    await reindexWatchedChange(repo, [null as unknown as string], async (f) => readFileSync(f, 'utf8'))
    expect(codeGraphStats(graphKeyForRoot(repo)).symbols).toBe(1)
  })
})

// =============================================================================================
// egressAudit
// =============================================================================================
describe('egressAudit — parser edges', () => {
  it('netstat: an unparseable LOCAL address still yields the remote endpoint (localPort 0)', () => {
    const r = parseNetstatWindows('  TCP    garbage    8.8.8.8:443    ESTABLISHED    12345', 12345)
    expect(r).toEqual([{ remoteHost: '8.8.8.8', remotePort: 443, localPort: 0, state: 'ESTABLISHED' }])
  })

  it('ss: skips short rows, listening peers, and unresolvable peers — but keeps the real one', () => {
    const stdout = [
      'pid=12345', // matches the pid but has too few columns
      'LISTEN 0 128 0.0.0.0:8080 0.0.0.0:0 users:(("node",pid=12345,fd=20))', // bound, not connected
      'LISTEN 0 128 *:9000 *:* users:(("node",pid=12345,fd=21))', // peer has no port at all
      'ESTAB 0 0 garbage 1.1.1.1:443 users:(("node",pid=12345,fd=22))', // local unparseable
    ].join('\n')
    const r = parseSsLinux(stdout, 12345)
    expect(r).toEqual([{ remoteHost: '1.1.1.1', remotePort: 443, localPort: 0, state: 'ESTAB' }])
  })

  it('lsof: skips rows with no TCP marker before the arrow, and rows whose peer has no port', () => {
    const stdout = [
      'node 12345 me 20u IPv4 0x1 0t0 UDP 10.0.0.1:5353->224.0.0.251:5353', // not TCP
      'node 12345 me 21u IPv4 0x2 0t0 10.0.0.1:1->2.2.2.2:2 TCP (ESTABLISHED)', // TCP marker after the arrow
      'node 12345 me 22u IPv4 0x3 0t0 TCP 10.0.0.1:62015->*:* (SYN_SENT)', // peer has no port
    ].join('\n')
    expect(parseLsofMac(stdout, 12345)).toEqual([])
  })

  it('lsof: a row with no trailing state and no local address parses with UNKNOWN state', () => {
    const r = parseLsofMac('node 12345 me 22u IPv4 0x3 0t0 TCP ->151.101.0.81:443', 12345)
    expect(r).toEqual([{ remoteHost: '151.101.0.81', remotePort: 443, localPort: 0, state: 'UNKNOWN' }])
  })
})

describe('egressAudit — recordEgress accumulation', () => {
  it('a second call for the same terminal ADDS to the existing endpoint set', () => {
    recordEgress('t1', [{ remoteHost: '1.1.1.1', remotePort: 443, localPort: 0, state: 'EST' }])
    recordEgress('t1', [
      { remoteHost: '1.1.1.1', remotePort: 443, localPort: 0, state: 'EST' }, // already known
      { remoteHost: '8.8.8.8', remotePort: 443, localPort: 0, state: 'EST' }, // new
    ])
    expect(getRecentEgress('t1').map((e) => e.remoteHost).sort()).toEqual(['1.1.1.1', '8.8.8.8'])
  })
})

describe('egressAudit — the default (shell-out) executor', () => {
  it('returns [] instead of crashing when the host has no usable child_process.execFile', async () => {
    const req = createRequire(import.meta.url)
    const cp = req('child_process') as { execFile?: unknown }
    const original = cp.execFile
    cp.execFile = undefined // the lazy require resolves, but the API is gone
    try {
      expect(await pollAgentEgress(1234, 'win32')).toEqual([])
      expect(await pollAgentEgress(1234, 'darwin')).toEqual([])
      expect(await pollAgentEgress(1234, 'linux')).toEqual([])
    } finally {
      cp.execFile = original
    }
  })

  it('really shells out for our own pid and every endpoint it reports is a resolved remote', async () => {
    // End-to-end through the lazy require: no injected executor, no forced platform. On a host
    // where the OS tool is missing the catch yields [] and the invariant holds vacuously.
    const r = await pollAgentEgress(process.pid)
    expect(Array.isArray(r)).toBe(true)
    for (const e of r) {
      expect(e.remoteHost).toBeTruthy()
      expect(e.remoteHost).not.toBe('0.0.0.0')
      expect(e.remotePort).toBeGreaterThan(0)
      expect(typeof e.localPort).toBe('number')
    }
  }, 20_000)
})
