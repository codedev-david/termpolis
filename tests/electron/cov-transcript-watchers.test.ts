import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Coverage backfill for the transcript-watcher trio:
 *   src/main/transcriptWatchers/baseWatcher.ts
 *   src/main/transcriptWatchers/codexWatcher.ts
 *   src/main/transcriptWatchers/geminiWatcher.ts
 *
 * Every test here drives a failure arm the existing suites never reach: a read that
 * fails mid-tail, a pathological run of bytes with no newline, an fs.watch that errors
 * or refuses to start, directory listings holding traversal names / vanished files /
 * unreadable sub-directories, and the live-tail callbacks the attach helpers install.
 *
 * HOME/USERPROFILE are redirected at module-load time (CODEX_SESSIONS_DIR and GEMINI_DIR
 * are computed once from os.homedir()), so every watcher reads a throwaway temp home.
 *
 * `fs` is mocked rather than spied on: vi.spyOn cannot redefine an ESM namespace export,
 * and three of the arms below (a traversal name coming back from readdirSync, an EACCES
 * on a sub-directory, an FSWatcher that emits 'error') simply cannot be produced with a
 * real filesystem. Everything not explicitly overridden delegates to the real fs, so the
 * temp trees these tests build and read are genuine.
 */

const hooks = vi.hoisted(() => ({
  /** Absolute path whose openSync() must fail, or null for "open everything normally". */
  failOpenFor: null as string | null,
  /** Return an entry list to override readdirSync for that dir, undefined to fall through. */
  readdir: null as ((dir: string) => string[] | undefined) | null,
  watchMode: 'real' as 'real' | 'throw' | 'fake',
  fake: {
    onError: undefined as ((err: unknown) => void) | undefined,
    onChange: undefined as (() => void) | undefined,
    closeCalls: 0,
  },
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const call = (fn: unknown, args: unknown[]): unknown => (fn as (...a: unknown[]) => unknown)(...args)
  const patched = {
    ...actual,
    openSync: (...args: unknown[]): unknown => {
      if (hooks.failOpenFor !== null && String(args[0]) === hooks.failOpenFor) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      }
      return call(actual.openSync, args)
    },
    readdirSync: (...args: unknown[]): unknown => {
      const override = hooks.readdir?.(String(args[0]))
      if (override !== undefined) return override
      return call(actual.readdirSync, args)
    },
    watch: (...args: unknown[]): unknown => {
      if (hooks.watchMode === 'throw') {
        throw Object.assign(new Error('ENOSPC: watchers exhausted'), { code: 'ENOSPC' })
      }
      if (hooks.watchMode === 'fake') {
        // args[2] is the change listener tailFile hands to fs.watch — holding it lets a test
        // fire a watch event at a moment the real filesystem would never schedule one.
        hooks.fake.onChange = args[2] as (() => void) | undefined
        return {
          on(event: string, cb: (err: unknown) => void): void {
            if (event === 'error') hooks.fake.onError = cb
          },
          close(): void {
            hooks.fake.closeCalls += 1
            throw new Error('close() after an error is not always legal')
          },
        }
      }
      return call(actual.watch, args)
    },
  }
  return { ...patched, default: patched }
})

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

type BaseWatcherModule = typeof import('../../src/main/transcriptWatchers/baseWatcher')
type BusModule = typeof import('../../src/main/agentEventBus')

const BASE_WATCHER = '../../src/main/transcriptWatchers/baseWatcher'

let tmpHome: string
let origHome: string | undefined
let origUserProfile: string | undefined

beforeEach(() => {
  hooks.failOpenFor = null
  hooks.readdir = null
  hooks.watchMode = 'real'
  hooks.fake = { onError: undefined, onChange: undefined, closeCalls: 0 }

  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-cov-tw-'))
  origHome = process.env.HOME
  origUserProfile = process.env.USERPROFILE
  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome
  vi.resetModules()
})

afterEach(() => {
  hooks.failOpenFor = null
  hooks.readdir = null
  hooks.watchMode = 'real'
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  if (origUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = origUserProfile
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best effort */ }
  vi.resetModules()
})

const loadBase = (): Promise<BaseWatcherModule> => import(BASE_WATCHER)

/**
 * The bus and the watcher must come out of the SAME module registry — vi.resetModules()
 * in beforeEach means a static import would hand us a different ring than the watcher
 * publishes into, and every assertion would read empty and pass for the wrong reason.
 */
async function loadBus(): Promise<BusModule> {
  const bus = await import('../../src/main/agentEventBus')
  bus._resetForTests()
  return bus
}

function setMtime(file: string, msAgo: number): void {
  const seconds = (Date.now() - msAgo) / 1000
  fs.utimesSync(file, seconds, seconds)
}

const waitOpts = { timeout: 10_000, interval: 50 } as const

// ---------------------------------------------------------------------------
// baseWatcher
// ---------------------------------------------------------------------------

describe('baseWatcher — tailFile failure arms', () => {
  it('does not consume the offset when the read fails, and re-delivers once reads work again', async () => {
    const { tailFile } = await loadBase()
    const file = path.join(tmpHome, 'unreadable.jsonl')
    fs.writeFileSync(file, 'first-line\n')

    const seen: string[] = []
    hooks.failOpenFor = file
    const handle = tailFile(file, (l) => { seen.push(l) })
    // tailFile ticks synchronously at construction, so the failing open already happened.
    expect(seen).toEqual([])

    hooks.failOpenFor = null
    // The offset only advances after a SUCCESSFUL read, so the line was not skipped —
    // the 1.5s poller re-reads it from the same place.
    await vi.waitFor(() => expect(seen).toEqual(['first-line']), waitOpts)
    handle.stop()
  })

  it('drops a >MAX_LINE_BYTES run with no newline instead of buffering it, and keeps tailing', async () => {
    const { tailFile, MAX_LINE_BYTES } = await loadBase()
    const file = path.join(tmpHome, 'pathological.jsonl')
    // No trailing newline: the whole thing lands in `leftover`, which is what the guard caps.
    fs.writeFileSync(file, 'x'.repeat(MAX_LINE_BYTES + 10))

    const seen: string[] = []
    const handle = tailFile(file, (l) => { seen.push(l) })
    expect(seen).toEqual([]) // no complete line yet

    fs.appendFileSync(file, '\n   \nafter-the-drop\n')
    await vi.waitFor(() => expect(seen).toContain('after-the-drop'), waitOpts)
    handle.stop()

    // The oversized partial was discarded rather than prepended, and the blank +
    // whitespace-only lines never reached the consumer.
    expect(seen).toEqual(['after-the-drop'])
  })

  it('closes and forgets the watcher when fs.watch emits an error, then keeps polling', async () => {
    const { tailFile } = await loadBase()
    const file = path.join(tmpHome, 'watch-error.jsonl')
    fs.writeFileSync(file, '')
    hooks.watchMode = 'fake'

    const seen: string[] = []
    const handle = tailFile(file, (l) => { seen.push(l) })
    expect(typeof hooks.fake.onError).toBe('function')

    // The error handler closes the watcher once and swallows the throw from close().
    expect(() => hooks.fake.onError?.(new Error('EPERM'))).not.toThrow()
    expect(hooks.fake.closeCalls).toBe(1)

    // Polling is the safety net: appended lines still arrive with no watcher at all.
    fs.appendFileSync(file, 'polled-after-watch-error\n')
    await vi.waitFor(() => expect(seen).toContain('polled-after-watch-error'), waitOpts)

    handle.stop()
    expect(hooks.fake.closeCalls).toBe(1) // stop() must not re-close the watcher it dropped
  })

  it('survives fs.watch throwing outright and falls back to polling only', async () => {
    const { tailFile } = await loadBase()
    const file = path.join(tmpHome, 'watch-throws.jsonl')
    fs.writeFileSync(file, '')
    hooks.watchMode = 'throw'

    const seen: string[] = []
    const handle = tailFile(file, (l) => { seen.push(l) })
    fs.appendFileSync(file, 'poll-only\n')
    await vi.waitFor(() => expect(seen).toEqual(['poll-only']), waitOpts)
    // No watcher was ever created — stop() must still be safe.
    expect(() => handle.stop()).not.toThrow()
  })

  it('isolates a throwing onLine so the rest of the batch still arrives', async () => {
    const { tailFile } = await loadBase()
    const file = path.join(tmpHome, 'throwing-consumer.jsonl')
    fs.writeFileSync(file, '')

    const seen: string[] = []
    const handle = tailFile(file, (l) => {
      seen.push(l)
      if (l === 'boom') throw new Error('parser exploded on this line')
    })

    fs.appendFileSync(file, 'boom\nafter-boom\n')
    await vi.waitFor(() => expect(seen).toContain('after-boom'), waitOpts)
    expect(seen).toEqual(['boom', 'after-boom'])
    handle.stop()
  })

  it('ignores a watch event that lands after stop()', async () => {
    const { tailFile } = await loadBase()
    const file = path.join(tmpHome, 'after-stop.jsonl')
    fs.writeFileSync(file, '')
    hooks.watchMode = 'fake'

    const seen: string[] = []
    const handle = tailFile(file, (l) => { seen.push(l) })
    expect(typeof hooks.fake.onChange).toBe('function')

    handle.stop()
    fs.appendFileSync(file, 'written-after-stop\n')

    // fs.watch events can already be queued when stop() runs, so the callback still fires
    // against a stopped handle. It must neither throw nor deliver the line.
    expect(() => hooks.fake.onChange?.()).not.toThrow()
    expect(seen).toEqual([])
  })

  it('startAtEnd on a file that does not exist yet starts at zero and reads what arrives', async () => {
    const { tailFile } = await loadBase()
    const file = path.join(tmpHome, 'created-later.jsonl')

    const seen: string[] = []
    // Both the startAtEnd stat and fs.watch fail here — neither may throw out of tailFile.
    const handle = tailFile(file, (l) => { seen.push(l) }, { startAtEnd: true })

    fs.writeFileSync(file, 'written-after-attach\n')
    await vi.waitFor(() => expect(seen).toEqual(['written-after-attach']), waitOpts)
    handle.stop()
  })
})

describe('baseWatcher — resolvePathWithinRoot boundary', () => {
  it('rejects a sibling that merely shares the root as a name prefix', async () => {
    const { resolvePathWithinRoot } = await loadBase()
    const root = path.join(tmpHome, 'sessions')
    expect(() => resolvePathWithinRoot(root, path.join(tmpHome, 'sessions-evil', 'x.jsonl')))
      .toThrow(/escapes root/)
    expect(resolvePathWithinRoot(root, path.join(root, 'x.jsonl'))).toBe(path.join(root, 'x.jsonl'))
  })
})

// ---------------------------------------------------------------------------
// codexWatcher
// ---------------------------------------------------------------------------

describe('codexWatcher — session scan resilience', () => {
  it('walks past traversal names, vanished files and unreadable sub-directories', async () => {
    const { findLatestCodexSessionFile, CODEX_SESSIONS_DIR } =
      await import('../../src/main/transcriptWatchers/codexWatcher')

    const sessions = CODEX_SESSIONS_DIR
    const day = path.join(sessions, 'day')
    const locked = path.join(sessions, 'locked')
    fs.mkdirSync(day, { recursive: true })
    fs.mkdirSync(locked, { recursive: true })
    fs.writeFileSync(path.join(sessions, 'notes.txt'), 'not a transcript')
    fs.writeFileSync(path.join(sessions, 'good.jsonl'), '')
    fs.writeFileSync(path.join(day, 'readme.md'), 'not a transcript either')
    fs.writeFileSync(path.join(day, 'inner.jsonl'), '')

    // A real file one level ABOVE the sessions root, and the newest thing on disk. If the
    // containment check ever stopped being enforced it would win the mtime sort outright,
    // so the assertion below is a real guard and not a tautology.
    const outside = path.join(path.dirname(sessions), 'outside.jsonl')
    fs.writeFileSync(outside, '')
    setMtime(path.join(sessions, 'good.jsonl'), 60_000)
    setMtime(path.join(day, 'inner.jsonl'), 30_000)
    setMtime(outside, 0)

    hooks.readdir = (dir) => {
      if (dir === sessions) {
        return [path.join('..', 'outside.jsonl'), 'ghost.jsonl', 'notes.txt', 'good.jsonl', 'day', 'locked']
      }
      if (dir === day) {
        return [path.join('..', '..', 'outside.jsonl'), 'phantom.jsonl', 'readme.md', 'inner.jsonl']
      }
      if (dir === locked) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      return undefined
    }

    const result = findLatestCodexSessionFile()
    expect(result).toBe(path.join(day, 'inner.jsonl'))
    expect(result).not.toContain('outside.jsonl')
  })

  it('attachCodexWatcher publishes only lines appended after it attached', async () => {
    const bus = await loadBus()
    const { attachCodexWatcher, CODEX_SESSIONS_DIR } =
      await import('../../src/main/transcriptWatchers/codexWatcher')

    fs.mkdirSync(CODEX_SESSIONS_DIR, { recursive: true })
    const file = path.join(CODEX_SESSIONS_DIR, 'rollout.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'message', role: 'user', content: 'old history' }) + '\n')

    const handle = attachCodexWatcher('t-codex-live')
    expect(handle?.sessionFile).toBe(file)
    expect(handle?.terminalId).toBe('t-codex-live')
    expect(bus.query()).toHaveLength(0)

    fs.appendFileSync(
      file,
      JSON.stringify({ type: 'message', role: 'assistant', content: 'live reply' }) + '\n',
    )
    await vi.waitFor(() => expect(bus.query({ kind: 'message' })).toHaveLength(1), waitOpts)

    const [event] = bus.query({ kind: 'message' })
    expect(event.terminalId).toBe('t-codex-live')
    expect(event.agentType).toBe('codex')
    expect(event.summary).toContain('live reply')
    expect(event.summary).not.toContain('old history')

    handle?.stop()
  })

  it('attachCodexWatcher returns null when the containment re-check rejects the winner', async () => {
    const actual = await vi.importActual<BaseWatcherModule>(BASE_WATCHER)
    let calls = 0
    vi.doMock(BASE_WATCHER, () => ({
      ...actual,
      // Call 1 is the scan's own per-entry check; call 2 is attach re-validating the file
      // it is about to tail. Rejecting only the second proves attach has its own guard.
      resolvePathWithinRoot: (root: string, target: string): string => {
        calls += 1
        if (calls >= 2) throw new Error(`Path escapes root: ${target}`)
        return actual.resolvePathWithinRoot(root, target)
      },
    }))
    try {
      const { attachCodexWatcher, CODEX_SESSIONS_DIR } =
        await import('../../src/main/transcriptWatchers/codexWatcher')
      fs.mkdirSync(CODEX_SESSIONS_DIR, { recursive: true })
      fs.writeFileSync(path.join(CODEX_SESSIONS_DIR, 'session.jsonl'), '')

      expect(attachCodexWatcher('t-codex-reject')).toBeNull()
      expect(calls).toBe(2)
    } finally {
      vi.doUnmock(BASE_WATCHER)
    }
  })
})

describe('codexWatcher — processCodexLine tolerance', () => {
  it('labels a message that carries no role as "unknown"', async () => {
    const bus = await loadBus()
    const { processCodexLine } = await import('../../src/main/transcriptWatchers/codexWatcher')

    processCodexLine(JSON.stringify({ type: 'message', content: 'no role on this entry' }), 't1')

    const [event] = bus.query({ kind: 'message' })
    expect(event.summary).toBe('unknown: no role on this entry')
    expect(event.payload.role).toBe('unknown')
  })

  it('keeps only the non-empty text parts of a content array', async () => {
    const bus = await loadBus()
    const { processCodexLine } = await import('../../src/main/transcriptWatchers/codexWatcher')

    processCodexLine(JSON.stringify({
      role: 'assistant',
      content: [{ text: '' }, { type: 'text', text: 'kept' }, { nope: true }, null],
    }), 't1')

    const [event] = bus.query({ kind: 'message' })
    expect(event.summary).toBe('assistant: kept')
    // 4, not 7: the empty parts are filtered out rather than joined in as blanks.
    expect(event.payload.length).toBe(4)
  })

  it('publishes nothing for a message whose content is neither a string nor an array', async () => {
    const bus = await loadBus()
    const { processCodexLine } = await import('../../src/main/transcriptWatchers/codexWatcher')

    processCodexLine(JSON.stringify({ type: 'message', role: 'user', content: { nested: 'x' } }), 't1')
    expect(bus.query()).toHaveLength(0)

    // The same entry with usable content does publish — the assertion above is not vacuous.
    processCodexLine(JSON.stringify({ type: 'message', role: 'user', content: 'ok' }), 't1')
    expect(bus.query()).toHaveLength(1)
  })

  it('honours an ISO-8601 string timestamp, and falls back to now for an unparseable one', async () => {
    const bus = await loadBus()
    const { processCodexLine } = await import('../../src/main/transcriptWatchers/codexWatcher')

    const iso = '2026-07-14T12:00:00.000Z'
    processCodexLine(JSON.stringify({ role: 'user', content: 'dated', timestamp: iso }), 't1')
    expect(bus.query()[0].ts).toBe(Date.parse(iso))

    const before = Date.now()
    processCodexLine(JSON.stringify({ role: 'user', content: 'undated', timestamp: 'not a date' }), 't1')
    const after = Date.now()

    const [, second] = bus.query()
    expect(second.ts).toBeGreaterThanOrEqual(before)
    expect(second.ts).toBeLessThanOrEqual(after)
  })

  it('falls back to the current time for a non-finite numeric timestamp', async () => {
    const bus = await loadBus()
    const { processCodexLine } = await import('../../src/main/transcriptWatchers/codexWatcher')

    const before = Date.now()
    // 1e999 overflows to Infinity through JSON.parse — isFinite() is the guard being driven.
    processCodexLine('{"role":"user","content":"hi","timestamp":1e999}', 't1')
    const after = Date.now()

    const [event] = bus.query({ kind: 'message' })
    expect(event.ts).toBeGreaterThanOrEqual(before)
    expect(event.ts).toBeLessThanOrEqual(after)
  })

  it('ignores a usage field that is not an object', async () => {
    const bus = await loadBus()
    const { processCodexLine } = await import('../../src/main/transcriptWatchers/codexWatcher')

    processCodexLine(JSON.stringify({ role: 'user', content: 'x', usage: 5 }), 't1')

    expect(bus.query({ kind: 'token_update' })).toHaveLength(0)
    // The line was still processed — so the empty token query above is not vacuous.
    expect(bus.query({ kind: 'message' })).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// geminiWatcher
// ---------------------------------------------------------------------------

describe('geminiWatcher — session scan', () => {
  it('ignores a DIRECTORY whose name ends in .jsonl', async () => {
    const { findLatestGeminiSessionFile, GEMINI_DIR } =
      await import('../../src/main/transcriptWatchers/geminiWatcher')

    // Newer than the real transcript, and it passes the .jsonl suffix test — only the
    // isFile() check keeps it out of the candidate list.
    fs.mkdirSync(path.join(GEMINI_DIR, 'decoy.jsonl'), { recursive: true })
    const real = path.join(GEMINI_DIR, 'real.jsonl')
    fs.writeFileSync(real, '')
    setMtime(real, 60_000)

    expect(findLatestGeminiSessionFile()).toBe(real)
  })

  it('caps recursion: a transcript nested four levels deep is not picked up', async () => {
    const { findLatestGeminiSessionFile, GEMINI_DIR } =
      await import('../../src/main/transcriptWatchers/geminiWatcher')

    const deepDir = path.join(GEMINI_DIR, 'a', 'b', 'c')
    fs.mkdirSync(deepDir, { recursive: true })
    fs.writeFileSync(path.join(deepDir, 'too-deep.jsonl'), '') // newest on disk, past the cap
    const reachable = path.join(GEMINI_DIR, 'a', 'b', 'reachable.jsonl')
    fs.writeFileSync(reachable, '')
    setMtime(reachable, 60_000)

    expect(findLatestGeminiSessionFile()).toBe(reachable)
  })

  it('skips vanished files, traversal names and unreadable sub-directories', async () => {
    const { findLatestGeminiSessionFile, GEMINI_DIR } =
      await import('../../src/main/transcriptWatchers/geminiWatcher')

    const nested = path.join(GEMINI_DIR, 'nested')
    const locked = path.join(GEMINI_DIR, 'locked')
    fs.mkdirSync(nested, { recursive: true })
    fs.mkdirSync(locked, { recursive: true })
    const real = path.join(GEMINI_DIR, 'real.jsonl')
    fs.writeFileSync(real, '')
    const outside = path.join(tmpHome, 'outside.jsonl')
    fs.writeFileSync(outside, '') // newest, and above ~/.gemini
    setMtime(real, 60_000)

    hooks.readdir = (dir) => {
      if (dir === GEMINI_DIR) return ['phantom.jsonl', 'nested', 'locked', 'real.jsonl']
      if (dir === nested) return [path.join('..', '..', 'outside.jsonl')]
      if (dir === locked) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      return undefined
    }

    const result = findLatestGeminiSessionFile()
    expect(result).toBe(real)
    expect(result).not.toContain('outside.jsonl')
  })

  it('attachGeminiWatcher publishes only lines appended after it attached', async () => {
    const bus = await loadBus()
    const { attachGeminiWatcher, GEMINI_DIR } =
      await import('../../src/main/transcriptWatchers/geminiWatcher')

    fs.mkdirSync(GEMINI_DIR, { recursive: true })
    const file = path.join(GEMINI_DIR, 'session.jsonl')
    fs.writeFileSync(file, JSON.stringify({ role: 'user', content: 'old history' }) + '\n')

    const handle = attachGeminiWatcher('t-gemini-live')
    expect(handle?.sessionFile).toBe(file)
    expect(handle?.terminalId).toBe('t-gemini-live')
    expect(bus.query()).toHaveLength(0)

    fs.appendFileSync(file, JSON.stringify({ role: 'model', content: 'live reply' }) + '\n')
    await vi.waitFor(() => expect(bus.query({ kind: 'message' })).toHaveLength(1), waitOpts)

    const [event] = bus.query({ kind: 'message' })
    expect(event.terminalId).toBe('t-gemini-live')
    expect(event.agentType).toBe('gemini')
    expect(event.summary).toContain('live reply')
    expect(event.summary).not.toContain('old history')

    handle?.stop()
  })

  it('attachGeminiWatcher returns null when the containment re-check rejects the winner', async () => {
    const actual = await vi.importActual<BaseWatcherModule>(BASE_WATCHER)
    let calls = 0
    vi.doMock(BASE_WATCHER, () => ({
      ...actual,
      resolvePathWithinRoot: (root: string, target: string): string => {
        calls += 1
        if (calls >= 2) throw new Error(`Path escapes root: ${target}`)
        return actual.resolvePathWithinRoot(root, target)
      },
    }))
    try {
      const { attachGeminiWatcher, GEMINI_DIR } =
        await import('../../src/main/transcriptWatchers/geminiWatcher')
      fs.mkdirSync(GEMINI_DIR, { recursive: true })
      fs.writeFileSync(path.join(GEMINI_DIR, 'session.jsonl'), '')

      expect(attachGeminiWatcher('t-gemini-reject')).toBeNull()
      expect(calls).toBe(2)
    } finally {
      vi.doUnmock(BASE_WATCHER)
    }
  })
})

describe('geminiWatcher — processGeminiLine content shapes', () => {
  it('joins array parts and tolerates null, primitive and empty-text items', async () => {
    const bus = await loadBus()
    const { processGeminiLine } = await import('../../src/main/transcriptWatchers/geminiWatcher')

    processGeminiLine(JSON.stringify({
      role: 'model',
      content: [null, 'raw string', { text: '' }, { text: 'kept' }],
    }), 't1')

    const [event] = bus.query({ kind: 'message' })
    expect(event.summary).toContain('kept')
    expect(event.payload.role).toBe('model')
  })

  it('ignores an entry whose content is neither a string nor an array', async () => {
    const bus = await loadBus()
    const { processGeminiLine } = await import('../../src/main/transcriptWatchers/geminiWatcher')

    processGeminiLine(JSON.stringify({ role: 'user', content: 42 }), 't1')
    expect(bus.query()).toHaveLength(0)

    // The same shape with usable content does publish — the assertion above is not vacuous.
    processGeminiLine(JSON.stringify({ role: 'user', content: 'ok' }), 't1')
    expect(bus.query()).toHaveLength(1)
  })
})
