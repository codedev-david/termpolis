// A native fatal can't be caught — but it CAN be noticed on the next boot. These tests lock in that
// detection, because the alternative is what actually happened in v1.27.4: a 3-second crash-loop that
// made the app unusable and filed ZERO GitHub issues, since the Sentry→GitHub alert only matches
// catchable JS errors and a V8 abort is not one.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseMarker,
  uncleanExitOf,
  initCrashWatch,
  heartbeat,
  markCleanExit,
  installCleanExitGuards,
  TERMINATION_SIGNALS,
  _resetCrashWatchForTests,
  type CrashWatchDeps,
  type SessionMarker,
} from '../../src/main/crashWatch'

const marker = (over: Partial<SessionMarker> = {}): SessionMarker => ({
  version: '1.27.5',
  pid: 123,
  startedAt: 1_000,
  lastSeen: 1_000,
  cleanExit: false,
  ...over,
})

function harness(initial: string | null = null) {
  let stored = initial
  let clock = 10_000
  const report = vi.fn()
  const deps: CrashWatchDeps = {
    readMarker: () => stored,
    writeMarker: (json) => { stored = json },
    now: () => clock,
    version: '1.27.6',
    pid: 999,
    report,
  }
  return {
    deps,
    report,
    read: () => (stored ? (JSON.parse(stored) as SessionMarker) : null),
    tick: (ms: number) => { clock += ms },
  }
}

beforeEach(() => _resetCrashWatchForTests())

describe('parseMarker', () => {
  it('round-trips a real marker', () => {
    expect(parseMarker(JSON.stringify(marker()))).toEqual(marker())
  })
  it('defaults lastSeen to startedAt when absent (pre-heartbeat marker)', () => {
    const raw = JSON.stringify({ version: '1.0.0', pid: 1, startedAt: 500, cleanExit: false })
    expect(parseMarker(raw)?.lastSeen).toBe(500)
  })
  // A corrupt marker must never be reported as a crash — crying wolf is worse than staying quiet.
  it('returns null for absent / unparseable / wrong-shaped markers', () => {
    expect(parseMarker(null)).toBeNull()
    expect(parseMarker('')).toBeNull()
    expect(parseMarker('{ not json')).toBeNull()
    expect(parseMarker('null')).toBeNull()
    expect(parseMarker(JSON.stringify({ version: 5, startedAt: 1 }))).toBeNull() // version not a string
    expect(parseMarker(JSON.stringify({ version: '1.0.0' }))).toBeNull() // no startedAt
    expect(parseMarker(JSON.stringify({ version: '1.0.0', startedAt: NaN }))).toBeNull()
  })
})

describe('uncleanExitOf', () => {
  it('reports an uncleared marker as a crash', () => {
    expect(uncleanExitOf(marker({ version: '1.27.4', startedAt: 1_000, lastSeen: 4_000 })))
      .toEqual({ prevVersion: '1.27.4', uptimeMs: 3_000 })
  })
  it('says nothing about a clean exit', () => {
    expect(uncleanExitOf(marker({ cleanExit: true }))).toBeNull()
  })
  it('says nothing on a first-ever launch (no marker)', () => {
    expect(uncleanExitOf(null)).toBeNull()
  })
  // The crash-loop signature: died before the first heartbeat could advance lastSeen.
  it('reports ~0 uptime when the app died within one heartbeat of launch', () => {
    expect(uncleanExitOf(marker({ startedAt: 1_000, lastSeen: 1_000 }))?.uptimeMs).toBe(0)
  })
  it('clamps a backwards clock instead of reporting negative uptime', () => {
    expect(uncleanExitOf(marker({ startedAt: 5_000, lastSeen: 1_000 }))?.uptimeMs).toBe(0)
  })
})

describe('initCrashWatch', () => {
  it('reports the previous hard death, then stamps a fresh uncleared marker', () => {
    const h = harness(JSON.stringify(marker({ version: '1.27.4', startedAt: 1_000, lastSeen: 1_000 })))
    const reported = initCrashWatch(h.deps)

    expect(reported).toEqual({ prevVersion: '1.27.4', uptimeMs: 0 })
    expect(h.report).toHaveBeenCalledWith({ prevVersion: '1.27.4', uptimeMs: 0 })
    // This session is now in-flight: its own marker is uncleared, so ITS crash is detectable too.
    expect(h.read()).toEqual({ version: '1.27.6', pid: 999, startedAt: 10_000, lastSeen: 10_000, cleanExit: false })
  })

  it('stays silent after a clean previous exit', () => {
    const h = harness(JSON.stringify(marker({ cleanExit: true })))
    expect(initCrashWatch(h.deps)).toBeNull()
    expect(h.report).not.toHaveBeenCalled()
  })

  it('stays silent on a first-ever launch', () => {
    const h = harness(null)
    expect(initCrashWatch(h.deps)).toBeNull()
    expect(h.report).not.toHaveBeenCalled()
    expect(h.read()?.cleanExit).toBe(false)
  })

  // Startup must survive a broken disk/marker — the whole point is to be invisible until it isn't.
  it('never throws when the marker is unreadable or unwritable', () => {
    const report = vi.fn()
    const deps: CrashWatchDeps = {
      readMarker: () => { throw new Error('EACCES') },
      writeMarker: () => { throw new Error('EROFS') },
      now: () => 1,
      version: '1.27.6',
      pid: 1,
      report,
    }
    expect(() => initCrashWatch(deps)).not.toThrow()
    expect(report).not.toHaveBeenCalled()
  })

  it('does not report a corrupt marker as a crash', () => {
    const h = harness('{ corrupt')
    expect(initCrashWatch(h.deps)).toBeNull()
    expect(h.report).not.toHaveBeenCalled()
  })
})

describe('heartbeat / markCleanExit', () => {
  it('heartbeat advances lastSeen so the next boot can measure uptime', () => {
    const h = harness(null)
    initCrashWatch(h.deps)
    h.tick(60_000)
    heartbeat()
    expect(h.read()?.lastSeen).toBe(70_000)
    expect(h.read()?.startedAt).toBe(10_000) // uptime would read 60s
    expect(h.read()?.cleanExit).toBe(false)
  })

  it('markCleanExit clears the marker so a normal quit reports nothing next boot', () => {
    const h = harness(null)
    initCrashWatch(h.deps)
    markCleanExit()
    expect(h.read()?.cleanExit).toBe(true)
    expect(uncleanExitOf(h.read())).toBeNull()
  })

  // End-to-end: quit cleanly, relaunch → silence. Then die hard, relaunch → reported.
  it('a clean quit then a hard death: only the hard death is reported', () => {
    const h = harness(null)
    initCrashWatch(h.deps)
    markCleanExit()
    _resetCrashWatchForTests()

    h.tick(1_000)
    expect(initCrashWatch(h.deps)).toBeNull() // clean quit → silence
    h.tick(3_000)
    heartbeat() // ran 3s, then the process is killed without markCleanExit
    _resetCrashWatchForTests()

    h.tick(1_000)
    expect(initCrashWatch(h.deps)).toEqual({ prevVersion: '1.27.6', uptimeMs: 3_000 })
    expect(h.report).toHaveBeenCalledTimes(1)
  })

  it('heartbeat/markCleanExit are no-ops before init (never throw)', () => {
    expect(() => heartbeat()).not.toThrow()
    expect(() => markCleanExit()).not.toThrow()
  })
})

// `before-quit` is not the only way the app stops. The exits BELOW never reach it, and reporting
// them as native crashes is what filed the phantom Sentry ELECTRON-D / #20.
describe('installCleanExitGuards — the exits that never reach before-quit', () => {
  function guardHarness() {
    const appEvents: Record<string, () => void> = {}
    const signals: Record<string, () => void> = {}
    const quit = vi.fn()
    installCleanExitGuards({
      onAppEvent: (event, handler) => { appEvents[event] = handler },
      onSignal: (signal, handler) => { signals[signal] = handler },
      quit,
    })
    return { appEvents, signals, quit }
  }

  it('registers session-end and every termination signal', () => {
    const g = guardHarness()
    expect(Object.keys(g.appEvents)).toEqual(['session-end'])
    expect(Object.keys(g.signals)).toEqual([...TERMINATION_SIGNALS])
  })

  it('an OS session end (Windows shutdown/logoff) is a CLEAN exit, not a crash', () => {
    const h = harness(null)
    initCrashWatch(h.deps)
    const g = guardHarness()

    h.tick(480_000) // ~8 minutes of healthy uptime — #20's shape exactly
    heartbeat()
    g.appEvents['session-end']()
    _resetCrashWatchForTests()

    // Next boot: silence.
    expect(initCrashWatch(h.deps)).toBeNull()
    expect(h.report).not.toHaveBeenCalled()
  })

  it.each([...TERMINATION_SIGNALS])('%s marks a clean exit and quits through the normal path', (sig) => {
    const h = harness(null)
    initCrashWatch(h.deps)
    const g = guardHarness()

    h.tick(5_000)
    g.signals[sig]()

    expect(h.read()?.cleanExit).toBe(true)
    // Registering a listener disables Node's default terminate — without an explicit quit the app
    // would survive its own `kill`.
    expect(g.quit).toHaveBeenCalledTimes(1)

    _resetCrashWatchForTests()
    expect(initCrashWatch(h.deps)).toBeNull()
  })

  it('a SIGKILL-shaped death (no handler runs) is STILL reported', () => {
    const h = harness(null)
    initCrashWatch(h.deps)
    guardHarness()

    h.tick(3_000)
    heartbeat() // ...and then the process vanishes without any handler firing
    _resetCrashWatchForTests()

    expect(initCrashWatch(h.deps)).toEqual({ prevVersion: '1.27.6', uptimeMs: 3_000 })
  })

  it('a platform that refuses a signal, and a throwing quit, never break shutdown', () => {
    const signals: Record<string, () => void> = {}
    expect(() =>
      installCleanExitGuards({
        onAppEvent: () => { throw new Error('no session-end on this platform') },
        onSignal: (signal, handler) => {
          if (signal === 'SIGHUP') throw new Error('unsupported signal')
          signals[signal] = handler
        },
        quit: () => { throw new Error('already quitting') },
      }),
    ).not.toThrow()
    // The signals that DID register still work, and a throwing quit is swallowed.
    expect(Object.keys(signals)).toEqual(['SIGTERM', 'SIGINT'])
    expect(() => signals['SIGTERM']()).not.toThrow()
  })

  it('the guards are safe before initCrashWatch — nothing to mark, nothing thrown', () => {
    const g = guardHarness()
    expect(() => g.appEvents['session-end']()).not.toThrow()
    expect(() => g.signals['SIGINT']()).not.toThrow()
    expect(g.quit).toHaveBeenCalledTimes(1)
  })
})
