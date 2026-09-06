// appLog.test.ts (main)
//
// src/main/appLog.ts is the state-and-fs half of the app's own log: a ring buffer the
// viewer reads, plus a serialised, self-rotating mirror on disk. Two properties matter
// more than any single behaviour here and drive most of these cases:
//
//   1. It must never break the thing it logs. Every fs failure below is asserted to
//      stay inside the module — a logger that can throw turns a cosmetic bug into a
//      crash in a packaged build where nobody can see the console anyway.
//   2. The ring survives initAppLog(). Console capture starts at module load, long
//      before Electron knows userData, so clearing on init would silently discard
//      every startup line — exactly the lines worth having when startup is what broke.
//
// The fs is injected, so everything except the one deliberate end-to-end case runs
// against a fake and touches no disk.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as nodeFs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  MAX_APP_LOG_FILE_BYTES,
  initAppLog,
  appLogFilePath,
  logToApp,
  readAppLog,
  clearAppLog,
  captureConsole,
  type AppLogFs,
  type ConsoleLike,
} from '../../src/main/appLog'
import {
  formatLogArgs,
  formatLogLine,
  MAX_APP_LOG_LINE_CHARS,
  type AppLogEntry,
  type AppLogLevel,
} from '../../src/shared/appLog'

/** A fixed clock, so an asserted line is the same line on every machine. */
const T = 1_700_000_000_123

const DIR = path.join(os.tmpdir(), 'appLog-tests-never-written')
const LOG = path.join(DIR, 'app.log')

interface RecordingFs extends AppLogFs {
  appended: { path: string; data: string }[]
  renames: { from: string; to: string }[]
  statCalls: string[]
}

/** A fake AppLogFs that records every call and, optionally, defers or fails one of
 *  them. Recording happens before the override runs, so a rejected write is still
 *  visible as an attempt. */
function makeFs(
  opts: {
    appendFile?: (p: string, d: string) => Promise<void>
    rename?: (a: string, b: string) => Promise<void>
    stat?: (p: string) => Promise<{ size: number }>
  } = {}
): RecordingFs {
  const api: RecordingFs = {
    appended: [],
    renames: [],
    statCalls: [],
    appendFile: async (p, d) => {
      api.appended.push({ path: p, data: d })
      if (opts.appendFile) await opts.appendFile(p, d)
    },
    rename: async (a, b) => {
      api.renames.push({ from: a, to: b })
      if (opts.rename) await opts.rename(a, b)
    },
    stat: async (p) => {
      api.statCalls.push(p)
      return opts.stat ? opts.stat(p) : { size: 0 }
    },
  }
  return api
}

/** Writes are queued on a promise chain, so nothing is on the fake until the
 *  microtask queue has drained. Two macrotask turns is belt and braces. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

/** An argument long enough to be clamped by the shared formatter, so every pumped
 *  line is exactly the same size and the byte maths below is exact. */
const BIG = 'x'.repeat(MAX_APP_LOG_LINE_CHARS + 1_000)

function pumpedLine(now = T): string {
  const entry: AppLogEntry = { t: now, level: 'log', source: 'main', msg: formatLogArgs([BIG]) }
  return `${formatLogLine(entry)}\n`
}

/** Push just past MAX_APP_LOG_FILE_BYTES/8 so the next queued write performs its size
 *  check. All calls are synchronous, so the whole total is in place before the chain
 *  runs and exactly ONE check happens for the batch. */
function pump(now = T): { lines: number; bytes: number } {
  const line = pumpedLine(now)
  const lines = Math.ceil(MAX_APP_LOG_FILE_BYTES / 8 / line.length)
  for (let i = 0; i < lines; i++) logToApp('log', 'main', [BIG], now)
  return { lines, bytes: lines * line.length }
}

/** Poll until a real-disk condition holds; the write chain finishes on its own time. */
async function settle(done: () => boolean, tries = 2_000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    let ok = false
    try {
      ok = done()
    } catch {
      ok = false
    }
    if (ok) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('timed out waiting for the app log to settle')
}

let api: RecordingFs

// The module is module-level stateful — one ring, one path, one fs handle, one write
// chain shared by every test in the process. Both halves of the reset matter.
beforeEach(() => {
  api = makeFs()
  initAppLog(DIR, { fs: api })
  clearAppLog()
})

describe('initAppLog / appLogFilePath', () => {
  it('points the log at app.log inside the given directory', () => {
    initAppLog(DIR, { fs: api })
    expect(appLogFilePath()).toBe(LOG)
  })

  it('leaves the path null when there is no directory yet', () => {
    // Logging happens before app.getPath('userData') resolves; that must mean "ring
    // only", not "crash" or "write to some guessed path".
    initAppLog(null)
    expect(appLogFilePath()).toBeNull()
  })

  it('does NOT clear the ring — startup lines survive init', () => {
    // The regression this guards: console capture is installed at module load, so
    // everything printed before Electron is ready is already in the ring when
    // whenReady calls initAppLog. Clearing there silently threw away every line
    // describing a failed startup — the one case the log exists for.
    logToApp('info', 'main', ['printed before userData was known'], T)
    initAppLog(DIR, { fs: api })
    expect(readAppLog().map((e) => e.msg)).toEqual(['printed before userData was known'])
  })

  it('swaps the fs handle so writes follow the newest init', async () => {
    const replacement = makeFs()
    initAppLog(DIR, { fs: replacement })
    logToApp('log', 'main', ['after the swap'], T)
    await flush()
    expect(replacement.appended).toHaveLength(1)
    expect(api.appended).toHaveLength(0)
  })
})

describe('logToApp — the ring', () => {
  it('keeps the entry in memory when no file is configured, and writes nothing', async () => {
    initAppLog(null, { fs: api })
    logToApp('error', 'main', ['no file, still visible in the viewer'], T)
    await flush()
    expect(readAppLog()).toHaveLength(1)
    expect(api.appended).toEqual([])
  })

  it('records level, source, timestamp and console-joined arguments', () => {
    logToApp('warn', 'renderer', ['spawn failed', 42, { code: 'ENOENT' }], T)
    expect(readAppLog()).toEqual([
      { t: T, level: 'warn', source: 'renderer', msg: 'spawn failed 42 {"code":"ENOENT"}' },
    ])
  })

  it('stamps Date.now() when the caller does not supply a time', () => {
    // Every production call site omits the timestamp; the parameter exists only so
    // tests can pin it.
    const before = Date.now()
    logToApp('log', 'main', ['unstamped'])
    const after = Date.now()
    const [entry] = readAppLog()
    expect(entry.t).toBeGreaterThanOrEqual(before)
    expect(entry.t).toBeLessThanOrEqual(after)
  })
})

describe('logToApp — the file', () => {
  it('appends the formatted line, newline-terminated, to the configured path', async () => {
    logToApp('info', 'main', ['shell resolved to', 'pwsh.exe'], T)
    await flush()
    expect(api.appended).toHaveLength(1)
    const { path: p, data } = api.appended[0]
    expect(p).toBe(LOG)
    // One entry per line is what makes the file greppable at all.
    expect(data.endsWith('\n')).toBe(true)
    expect(data).toBe(
      `${formatLogLine({ t: T, level: 'info', source: 'main', msg: 'shell resolved to pwsh.exe' })}\n`
    )
    expect(data).toContain('[INFO] [main] shell resolved to pwsh.exe')
  })

  it('does not stat the file on the common path', async () => {
    // The in-process byte counter exists so ordinary logging costs no syscall beyond
    // the append; a stat per line would be a measurable regression.
    for (let i = 0; i < 50; i++) logToApp('log', 'main', [`line ${i}`], T)
    await flush()
    expect(api.appended).toHaveLength(50)
    expect(api.statCalls).toEqual([])
  })

  it('redacts credentials before they reach the disk', async () => {
    // Redaction is applied on write, not on read: the point is that the secret never
    // exists in the file for a later "copy this log into an issue" to leak.
    const fakeKey = `sk-ant-${'a'.repeat(40)}`
    logToApp('log', 'main', ['auth header', fakeKey], T)
    await flush()
    expect(api.appended[0].data).not.toContain(fakeKey)
    expect(api.appended[0].data).toContain('<redacted-key>')
  })
})

describe('logToApp — serialisation', () => {
  it('runs queued writes one at a time and in order', async () => {
    // Two overlapping appendFile calls can interleave mid-line and the file stops
    // being parseable, so the chain must never have more than one write in flight.
    const started: string[] = []
    const release: (() => void)[] = []
    let inFlight = 0
    let maxInFlight = 0
    const slow = makeFs({
      appendFile: (_p, d) => {
        started.push(d.trim())
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        return new Promise<void>((resolve) => {
          release.push(() => {
            inFlight -= 1
            resolve()
          })
        })
      },
    })
    initAppLog(DIR, { fs: slow })

    logToApp('log', 'main', ['first'], T)
    logToApp('log', 'main', ['second'], T)
    logToApp('log', 'main', ['third'], T)
    await flush()
    expect(started).toHaveLength(1)

    release[0]()
    await flush()
    expect(started).toHaveLength(2)

    release[1]()
    await flush()
    expect(started).toHaveLength(3)
    release[2]()
    await flush()

    expect(maxInFlight).toBe(1)
    expect(started.map((s) => s.split('] ').pop())).toEqual(['first', 'second', 'third'])
  })
})

describe('logToApp — failures stay inside the module', () => {
  it('swallows a rejecting append without throwing or leaking an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const failing = makeFs({
        appendFile: async () => {
          throw new Error('EACCES: profile on a dead network share')
        },
      })
      initAppLog(DIR, { fs: failing })
      // logToApp is fire-and-forget: the caller is an ipc handler or a console
      // wrapper that has no way to await, so a rejection with no catch would take the
      // process down under --unhandled-rejections=throw.
      expect(() => logToApp('error', 'main', ['disk is gone'], T)).not.toThrow()
      await flush()
      expect(failing.appended).toHaveLength(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('keeps logging after a failed write', async () => {
    // A single bad write must not poison the chain for the rest of the session.
    let failNext = true
    const flaky = makeFs({
      appendFile: async () => {
        if (failNext) {
          failNext = false
          throw new Error('transient')
        }
      },
    })
    initAppLog(DIR, { fs: flaky })
    logToApp('log', 'main', ['doomed'], T)
    await flush()
    logToApp('log', 'main', ['still here'], T)
    await flush()
    expect(flaky.appended.map((a) => a.data.trim().split('] ').pop())).toEqual(['doomed', 'still here'])
  })
})

describe('rotation', () => {
  it('renames the file aside once it has outgrown the cap', async () => {
    const rotating = makeFs({ stat: async () => ({ size: MAX_APP_LOG_FILE_BYTES }) })
    initAppLog(DIR, { fs: rotating })
    const { lines } = pump()
    await flush()
    expect(rotating.renames).toEqual([{ from: LOG, to: `${LOG}.old` }])
    // Rotation happens before the append, so no line is lost to it.
    expect(rotating.appended).toHaveLength(lines)
  })

  it('leaves the file alone below the cap, and checks once per batch of bytes', async () => {
    const small = makeFs({ stat: async () => ({ size: MAX_APP_LOG_FILE_BYTES - 1 }) })
    initAppLog(DIR, { fs: small })
    pump()
    await flush()
    expect(small.renames).toEqual([])
    // The counter resets at each check, so one batch buys exactly one stat — and the
    // next batch has to earn its own.
    expect(small.statCalls).toEqual([LOG])
    pump()
    await flush()
    expect(small.statCalls).toEqual([LOG, LOG])
    expect(small.renames).toEqual([])
  })

  it('keeps appending when the size check itself fails', async () => {
    // There may be no file yet, or Windows may have it locked; either way the answer
    // is to carry on logging, not to stop.
    const unstattable = makeFs({
      stat: async () => {
        throw new Error('ENOENT')
      },
    })
    initAppLog(DIR, { fs: unstattable })
    const { lines } = pump()
    await flush()
    expect(unstattable.renames).toEqual([])
    expect(unstattable.appended).toHaveLength(lines)
    logToApp('log', 'main', ['after the failed check'], T)
    await flush()
    expect(unstattable.appended).toHaveLength(lines + 1)
  })

  it('keeps appending when the rename itself fails', async () => {
    // The classic Windows case: the file is open elsewhere, so the rotation cannot
    // happen. An un-rotated log is better than a stopped one.
    const locked = makeFs({
      stat: async () => ({ size: MAX_APP_LOG_FILE_BYTES * 2 }),
      rename: async () => {
        throw new Error('EBUSY')
      },
    })
    initAppLog(DIR, { fs: locked })
    const { lines } = pump()
    await flush()
    expect(locked.renames).toHaveLength(1)
    expect(locked.appended).toHaveLength(lines)
  })
})

describe('readAppLog', () => {
  it('returns entries oldest first', () => {
    // Reading order, not stack order: the viewer shows a transcript.
    logToApp('log', 'main', ['one'], T)
    logToApp('log', 'main', ['two'], T + 1)
    logToApp('log', 'main', ['three'], T + 2)
    expect(readAppLog().map((e) => e.msg)).toEqual(['one', 'two', 'three'])
  })

  it('defaults to the newest 500 entries', () => {
    initAppLog(null, { fs: api })
    for (let i = 0; i < 600; i++) logToApp('log', 'main', [`entry ${i}`], T + i)
    const entries = readAppLog()
    expect(entries).toHaveLength(500)
    expect(entries[0].msg).toBe('entry 100')
    expect(entries[499].msg).toBe('entry 599')
  })

  it('returns the whole ring when the limit exceeds it', () => {
    initAppLog(null, { fs: api })
    for (let i = 0; i < 3; i++) logToApp('log', 'main', [`entry ${i}`], T + i)
    expect(readAppLog(10_000)).toHaveLength(3)
  })

  it('falls back to the default for a zero or NaN limit', () => {
    // The limit arrives from the renderer over IPC, so it can be anything.
    initAppLog(null, { fs: api })
    for (let i = 0; i < 3; i++) logToApp('log', 'main', [`entry ${i}`], T + i)
    expect(readAppLog(0).map((e) => e.msg)).toEqual(['entry 0', 'entry 1', 'entry 2'])
    expect(readAppLog(Number.NaN).map((e) => e.msg)).toEqual(['entry 0', 'entry 1', 'entry 2'])
  })

  it('clamps a negative limit instead of throwing', () => {
    initAppLog(null, { fs: api })
    for (let i = 0; i < 3; i++) logToApp('log', 'main', [`entry ${i}`], T + i)
    // Math.max(1, …) keeps a hostile value from turning slice() into "everything but
    // the last n" — the worst outcome is one entry, never a crash.
    expect(readAppLog(-5).map((e) => e.msg)).toEqual(['entry 2'])
  })

  it('returns [] for an empty ring', () => {
    // ring.length || 1 makes the floor 1, so this is the case that proves slice(-1)
    // of nothing is still nothing rather than a phantom entry.
    expect(readAppLog()).toEqual([])
    expect(readAppLog(50)).toEqual([])
  })
})

describe('clearAppLog', () => {
  it('empties the ring but keeps the file path', async () => {
    logToApp('log', 'main', ['before the clear'], T)
    await flush()
    clearAppLog()
    expect(readAppLog()).toEqual([])
    // "Clear the view" must not destroy the crash evidence on disk, and the viewer
    // still needs somewhere to point its "open folder" button.
    expect(appLogFilePath()).toBe(LOG)
    expect(api.appended).toHaveLength(1)
  })
})

describe('captureConsole', () => {
  function makeTarget(): { target: ConsoleLike; seen: { level: AppLogLevel; args: unknown[] }[] } {
    const seen: { level: AppLogLevel; args: unknown[] }[] = []
    const target = {} as ConsoleLike
    for (const level of ['debug', 'info', 'log', 'warn', 'error'] as AppLogLevel[]) {
      target[level] = (...args: unknown[]) => {
        seen.push({ level, args })
      }
    }
    return { target, seen }
  }

  it('mirrors every captured level into the ring with the given source', () => {
    const { target } = makeTarget()
    const uninstall = captureConsole(target, 'renderer')
    target.debug('d')
    target.info('i')
    target.log('l')
    target.warn('w')
    target.error('e')
    uninstall()
    expect(readAppLog().map((e) => `${e.level}:${e.source}:${e.msg}`)).toEqual([
      'debug:renderer:d',
      'info:renderer:i',
      'log:renderer:l',
      'warn:renderer:w',
      'error:renderer:e',
    ])
  })

  it('calls the original first, with the original arguments', () => {
    // A dev build's console must behave exactly as it did before capture — same
    // output, same object identity, and printed before the mirror runs so a failure
    // inside the mirror cannot swallow the line.
    const ringSizeWhenOriginalRan: number[] = []
    const seen: unknown[][] = []
    const target = {} as ConsoleLike
    for (const level of ['debug', 'info', 'log', 'warn', 'error'] as AppLogLevel[]) {
      target[level] = (...args: unknown[]) => {
        seen.push(args)
        ringSizeWhenOriginalRan.push(readAppLog().length)
      }
    }
    const uninstall = captureConsole(target, 'main')
    const payload = { id: 7 }
    target.warn('context', payload)
    uninstall()
    expect(seen).toEqual([['context', payload]])
    expect(seen[0][1]).toBe(payload)
    expect(ringSizeWhenOriginalRan).toEqual([0])
    expect(readAppLog()).toHaveLength(1)
  })

  it('skips a level the target does not implement', () => {
    // The renderer bridge hands over a console-shaped object that is not `console`;
    // a missing method must be a no-op, not a TypeError at install time.
    const { target } = makeTarget()
    delete (target as Partial<ConsoleLike>).debug
    const uninstall = captureConsole(target, 'main')
    expect(target.debug).toBeUndefined()
    target.log('still captured')
    uninstall()
    // Uninstall must not invent a method that was never there.
    expect(target.debug).toBeUndefined()
    expect(readAppLog().map((e) => e.msg)).toEqual(['still captured'])
  })

  it('restores every original on uninstall', () => {
    const { target, seen } = makeTarget()
    const originals = { ...target }
    const uninstall = captureConsole(target, 'main')
    expect(target.log).not.toBe(originals.log)
    uninstall()
    for (const level of ['debug', 'info', 'log', 'warn', 'error'] as AppLogLevel[]) {
      expect(target[level]).toBe(originals[level])
    }
    target.log('after uninstall')
    expect(seen).toHaveLength(1)
    expect(readAppLog()).toEqual([])
  })

  it('survives an argument that cannot be stringified at all', () => {
    // The nastiest shape a console argument can take: JSON.stringify throws AND so does
    // String(). formatLogArgs absorbs both (renderArg -> safeString), so the mirror does
    // not throw -- and, the part worth asserting, the line is not LOST either. Dropping
    // it would take the surrounding arguments with it, and those are usually the
    // diagnosis; the one unprintable value is rarely the interesting part.
    //
    // captureConsole's own try/catch stays as the backstop for whatever future edit
    // reintroduces a throw further down. It is unreachable today by construction, which
    // is the point of it.
    const hostile = {
      toJSON() {
        throw new Error('no json for you')
      },
      toString() {
        throw new Error('no string either')
      },
    }
    const { target, seen } = makeTarget()
    const uninstall = captureConsole(target, 'main')
    expect(() => target.error('while handling', hostile)).not.toThrow()
    uninstall()
    expect(seen).toHaveLength(1)
    const entries = readAppLog()
    expect(entries).toHaveLength(1)
    expect(entries[0].level).toBe('error')
    expect(entries[0].source).toBe('main')
    expect(entries[0].msg).toBe('while handling <unprintable>')
  })
})

describe('the real filesystem (no injected fs)', () => {
  let dir: string

  beforeEach(() => {
    dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'applog-'))
  })

  afterEach(() => {
    initAppLog(null, { fs: makeFs() })
    try {
      nodeFs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* the OS can hold the handle briefly on Windows */
    }
  })

  it('writes and rotates through fs/promises when no fs is injected', async () => {
    // The default adapter is the one production actually uses; everything above runs
    // against a fake, so without this case a typo in the real appendFile/rename/stat
    // wiring would ship green.
    const file = path.join(dir, 'app.log')
    nodeFs.writeFileSync(file, Buffer.alloc(MAX_APP_LOG_FILE_BYTES, 0x41))
    initAppLog(dir)
    expect(appLogFilePath()).toBe(file)

    const { lines } = pump()
    await settle(() => nodeFs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length >= lines)

    // The oversized log was moved aside intact, not truncated…
    expect(nodeFs.statSync(`${file}.old`).size).toBe(MAX_APP_LOG_FILE_BYTES)
    // …and the new file holds every pumped line and none of the old content.
    const body = nodeFs.readFileSync(file, 'utf8')
    expect(body.split('\n').filter(Boolean)).toHaveLength(lines)
    expect(body.startsWith('A')).toBe(false)
    expect(body).toContain('[LOG] [main] ')
  })
})
