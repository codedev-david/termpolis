// crashWatch.ts — make a NATIVE crash visible.
//
// The gap this closes (found the hard way in v1.27.4): a native fatal — a V8 abort, an OOM kill, a
// power cut — never becomes a JS exception. @sentry/electron uploads the minidump, but the
// Sentry→GitHub "Auto-file Production crashes" alert only matches catchable JS errors, so the worst
// outage in the app's history (a 3-second crash-loop that made Termpolis unusable) opened ZERO
// GitHub issues while sitting in Sentry the whole time.
//
// The trick: you cannot catch your own abort, but you CAN notice it afterwards. Stamp a marker at
// boot and clear it on a clean quit; if the NEXT boot finds the marker uncleared, the previous
// session died hard. Report that as an ordinary JS-level event — which the existing alert does file.
//
// Uptime is the triage signal: a marker whose lastSeen never advanced past startedAt means the app
// died within one heartbeat of launch — a crash-loop (v1.27.4's was ~3 s), not a random one-off.
// Everything here is best-effort: crash reporting must never itself break startup or shutdown.

/** What we persist about the running session. */
export interface SessionMarker {
  version: string
  pid: number
  startedAt: number
  /** Advanced by the heartbeat; how we approximate the previous session's uptime. */
  lastSeen: number
  cleanExit: boolean
}

/** Injected so the whole module is unit-testable with no fs, no clock, and no Sentry. */
export interface CrashWatchDeps {
  readMarker: () => string | null
  writeMarker: (json: string) => void
  now: () => number
  version: string
  pid: number
  report: (ctx: { prevVersion: string; uptimeMs: number }) => void
}

/** Parse a marker. Null when absent, unparseable, or not shaped like one — a corrupt marker must
 *  never be reported as a crash (that would cry wolf) nor throw during startup. */
export function parseMarker(raw: string | null): SessionMarker | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Partial<SessionMarker>
    if (typeof o?.version !== 'string' || !Number.isFinite(o?.startedAt as number)) return null
    return {
      version: o.version,
      pid: Number.isFinite(o.pid as number) ? (o.pid as number) : 0,
      startedAt: o.startedAt as number,
      lastSeen: Number.isFinite(o.lastSeen as number) ? (o.lastSeen as number) : (o.startedAt as number),
      cleanExit: o.cleanExit === true,
    }
  } catch {
    return null
  }
}

/** What to report about the previous session — null when it exited cleanly or never ran. Pure. */
export function uncleanExitOf(prev: SessionMarker | null): { prevVersion: string; uptimeMs: number } | null {
  if (!prev || prev.cleanExit) return null
  // lastSeen < startedAt would mean a clock jump; clamp rather than report a negative uptime.
  return { prevVersion: prev.version, uptimeMs: Math.max(0, prev.lastSeen - prev.startedAt) }
}

let deps: CrashWatchDeps | null = null
let marker: SessionMarker | null = null

function persist(): void {
  if (!deps || !marker) return
  try {
    deps.writeMarker(JSON.stringify(marker))
  } catch {
    /* best effort — a marker we can't write just means we can't detect the next crash */
  }
}

/**
 * Check whether the LAST session died hard (reporting it if so), then stamp this one.
 * Returns what was reported, for tests/callers. Never throws.
 */
export function initCrashWatch(d: CrashWatchDeps): { prevVersion: string; uptimeMs: number } | null {
  deps = d
  let reported: { prevVersion: string; uptimeMs: number } | null = null
  try {
    reported = uncleanExitOf(parseMarker(d.readMarker()))
    if (reported) d.report(reported)
  } catch {
    /* a bad marker must not block launch */
  }
  const t = d.now()
  marker = { version: d.version, pid: d.pid, startedAt: t, lastSeen: t, cleanExit: false }
  persist()
  return reported
}

/** Advance lastSeen — call on a timer. Cheap: one small JSON write. */
export function heartbeat(): void {
  if (!deps || !marker) return
  marker.lastSeen = deps.now()
  persist()
}

/** Mark this session as a clean exit — call on before-quit, so the next boot reports nothing. */
export function markCleanExit(): void {
  if (!deps || !marker) return
  marker.cleanExit = true
  marker.lastSeen = deps.now()
  persist()
}

/**
 * Termination signals that mean "someone asked us to stop", not "we died".
 *
 * SIGTERM is the OS/`taskkill`/`killall` polite stop, SIGINT the console interrupt, SIGHUP a closed
 * console window or a terminated login session. None of them is a crash.
 */
export const TERMINATION_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

export interface CleanExitGuardDeps {
  /** `app.on` — Electron's OS session-end event. */
  onAppEvent: (event: 'session-end', handler: () => void) => void
  /** `process.on` — POSIX-style termination signals. */
  onSignal: (signal: string, handler: () => void) => void
  /** `app.quit` — see below; registering a signal listener disables Node's default terminate. */
  quit: () => void
}

/**
 * Cover the shutdown paths that never reach `before-quit` — and are NOT crashes.
 *
 * `markCleanExit()` hangs off `before-quit`, which fires for a normal quit, a Cmd+Q, and the
 * restart-to-install. It does NOT fire when the OS ends the session (Windows shutdown / logoff /
 * restart, macOS logout) or when the process is asked to terminate by signal. Without this, every
 * one of those exits leaves the marker uncleared and the NEXT launch files a phantom "native crash"
 * — which is exactly the shape of Sentry ELECTRON-D / GitHub #20: one unclean exit after ~8 minutes
 * of healthy uptime, with no accompanying native crash to explain it. Crying wolf here is worse than
 * silence: a detector nobody trusts is a detector nobody reads.
 *
 * A SIGKILL still can't be caught — that one is genuinely indistinguishable from a fatal, and should
 * be reported.
 */
export function installCleanExitGuards(d: CleanExitGuardDeps): void {
  const clean = (): void => {
    try { markCleanExit() } catch { /* best effort — shutdown must never throw */ }
  }
  try { d.onAppEvent('session-end', clean) } catch { /* best effort */ }
  for (const sig of TERMINATION_SIGNALS) {
    try {
      d.onSignal(sig, () => {
        clean()
        // Registering a listener REPLACES Node's default terminate-on-signal, so without this the
        // app would just keep running after a `taskkill`/`kill`. Quit through the normal path so
        // before-quit still tears everything down.
        try { d.quit() } catch { /* best effort */ }
      })
    } catch { /* a signal this platform refuses to register is not an error */ }
  }
}

/** @internal test-only */
export function _resetCrashWatchForTests(): void {
  deps = null
  marker = null
}
