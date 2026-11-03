// loopGovernor.ts: the main-thread event-loop governor (1.54.5 hotfix, lane G; plan package P13, reduced).
//
// WHY. node-pty runs inside Electron's main process, so every keystroke and every echo crosses the main event
// loop. When something else holds that loop for 100 ms to 1.5 s (a synchronous open under Defender, a process
// creation, a whole-file parse), typing lags, and several background jobs together can hold it for seconds.
// This module watches the loop and, while it is struggling ("SHED"), lets the background timers that are
// registered with it stand down. It never touches the typing path: the PTY pump, the phone keystroke path and
// anything a user asked for are not registered and are never paused.
//
// THREE PARTS, each usable alone:
//   1. A tiny registry. register(name, {pause, resume}) returns an unregister function; isShed(); onShedChange().
//      Entering SHED calls every registered pause once, leaving calls every resume once, a registration made
//      while shed is paused immediately, registering one name twice replaces the old entry, and a throwing
//      callback never breaks the others.
//   2. createShedGate: the helper a recurring job uses (`if (gate.skip()) return`), with an optional single
//      make-up run a minute after calm returns, so nothing bursts at the instant SHED ends.
//   3. The watchdog. A native event-loop-delay histogram, read every 2 s: SHED after 3 samples in a row whose
//      delay is over 100 ms, back to calm after 10 s with every sample under 40 ms. Hysteresis, no flapping.
//
// THE SENSOR, and what was measured to get it right (this laptop, Node 24, own processes only):
//   - monitorEventLoopDelay reports the whole tick interval, not just the lateness. At resolution 20 an IDLE
//     Windows loop reports p50 31.5 ms and p99 42-44 ms (the 15.6 ms timer tick), so a literal "raw p99 under
//     40 ms" could never be met there. The governor compares DELAY = rawP99 - idleFloor, where the floor is what
//     an idle loop reports on this platform (31.25 ms on Windows at resolution 20, the resolution elsewhere).
//   - histogram.reset() clears the histogram's previous-tick marker, so a stall that starts right after a reset
//     is DROPPED by the histogram (a 300 ms block measured as a 35 ms max). The sampler's own lateness (how much
//     later than 2 s it ran) still sees it. The sensor is therefore max(histogram delay, sampler lateness).
//   - an empty histogram answers percentile(99) = 511 (nanoseconds), not 0: under 1 ms means "no data".
//
// COST AND SAFETY, because the v1.25.16 freeze detector WAS the freeze (a profiler wired into the loop that
// reacted to it): per sample one histogram read, one reset and one clock read; os.freemem at most once per
// 10 s, and only for the diagnostics block (free memory never decides SHED). No node:inspector, no profiler, no
// per-process metrics, nothing that enumerates processes (tests/electron/loopGovernor.test.ts scans for all of
// them). The governor creates no timer except its one unref'd sampling interval, and its transitions do nothing
// heavier than call the registered hooks and write one rate-limited app-log line.
//
// FAIL OPEN. TERMPOLIS_NO_GOVERNOR=1 (or true) means no histogram, no timer and no SHED: behaviour identical
// to before this module existed. Three failed samples in a row stop the watchdog and release everything. stop()
// while shed resumes everything. A forced "max dwell" valve leaves SHED after 30 continuous minutes and stays
// open for 5, so a measurement artifact can never starve the background jobs for good.
import { monitorEventLoopDelay } from 'perf_hooks'
import { freemem as osFreemem } from 'os'
import { logToApp } from './appLog'

// ── 1. the registry ────────────────────────────────────────────────

export interface ShedHooks {
  /** The loop is struggling: stop doing optional background work. Must be cheap and must not throw (it is guarded anyway). */
  pause(): void
  /** The loop has been calm long enough: carry on. Never do a burst of owed work here (stagger it). */
  resume(): void
}

export interface ShedRegistry {
  /** Register a pausable. Returns an unregister function; a stale one (its entry was replaced) does nothing. */
  register(name: string, hooks: ShedHooks): () => void
  isShed(): boolean
  /** Hear each transition, after the hooks have run. Returns an unsubscribe function. */
  onShedChange(cb: (shed: boolean) => void): () => void
  /** Drive the state (the watchdog does; tests do). True when the state changed. */
  setShed(shed: boolean): boolean
  names(): string[]
}

interface Entry {
  name: string
  hooks: ShedHooks
  /** True between a pause() call and the matching resume(), so each pair stays balanced. */
  paused: boolean
}

export function createShedRegistry(): ShedRegistry {
  const entries = new Map<string, Entry>()
  const listeners = new Set<(shed: boolean) => void>()
  let shed = false

  const pauseEntry = (e: Entry): void => {
    if (e.paused) return
    e.paused = true // before the call: a hook that threw half-way still gets its resume
    try { e.hooks.pause() } catch { /* one bad hook must not stop the others */ }
  }
  const resumeEntry = (e: Entry): void => {
    if (!e.paused) return
    e.paused = false
    try { e.hooks.resume() } catch { /* same */ }
  }

  return {
    register(name, hooks) {
      const entry: Entry = { name, hooks, paused: false }
      entries.set(name, entry) // an existing entry of that name is simply dropped: no callback to it
      if (shed) pauseEntry(entry)
      return () => { if (entries.get(name) === entry) entries.delete(name) }
    },
    isShed: () => shed,
    onShedChange(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    setShed(next) {
      if (next === shed) return false
      shed = next
      for (const e of [...entries.values()]) {
        if (shed !== next) break // a hook flipped the state again: that call already handled every entry
        if (entries.get(e.name) !== e) continue // removed or replaced by an earlier hook in this pass
        if (next) pauseEntry(e)
        else resumeEntry(e)
      }
      for (const l of [...listeners]) {
        try { l(next) } catch { /* a listener must not break the transition */ }
      }
      return true
    },
    names: () => [...entries.keys()],
  }
}

/** The process-wide registry: the watchdog drives it, the background jobs register with it. */
export const shedRegistry: ShedRegistry = createShedRegistry()
export const registerShed = (name: string, hooks: ShedHooks): (() => void) => shedRegistry.register(name, hooks)
export const isShed = (): boolean => shedRegistry.isShed()
export const onShedChange = (cb: (shed: boolean) => void): (() => void) => shedRegistry.onShedChange(cb)

// ── 2. the gate helper ────────────────────────────────────────────────

/** How long after calm returns a skipped run is made up: staggered, so SHED ending never causes a burst. */
export const MAKE_UP_DELAY_MS = 60_000

export interface ShedGate {
  /** True while shed: the caller skips this run. Remembers that one run is owed. */
  skip(): boolean
  /** Unregister and cancel any pending make-up. */
  dispose(): void
}

export interface ShedGateOptions {
  /** Run once, MAKE_UP_DELAY_MS after calm returns, if at least one run was skipped. Omit for "the next tick catches up". */
  makeUp?: () => void
  makeUpDelayMs?: number
  registry?: ShedRegistry
}

export function createShedGate(name: string, opts: ShedGateOptions = {}): ShedGate {
  const registry = opts.registry ?? shedRegistry
  let owed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (timer) { clearTimeout(timer); timer = null }
  }
  const unregister = registry.register(name, {
    // Struggling again before the make-up fired: cancel it, but the run is still owed.
    pause: () => { if (timer) { cancel(); owed = true } },
    resume: () => {
      const due = owed
      owed = false
      if (!due || !opts.makeUp) return
      cancel()
      // No isShed() check in the callback: the pause hook above cancels this timer the moment SHED returns, so it
      // cannot fire while shed.
      timer = setTimeout(() => {
        timer = null
        try { opts.makeUp?.() } catch { /* best effort */ }
      }, opts.makeUpDelayMs ?? MAKE_UP_DELAY_MS)
      timer.unref?.()
    },
  })
  return {
    skip() {
      if (!registry.isShed()) return false
      owed = true
      return true
    },
    dispose() {
      cancel()
      unregister()
    },
  }
}

// ── 3. the watchdog ────────────────────────────────────────────────

/** What the governor needs of a Node event-loop-delay histogram (perf_hooks' IntervalHistogram has all of it). */
export interface LoopHistogram {
  enable(): unknown
  disable(): unknown
  /** Nanoseconds. */
  percentile(p: number): number
  reset(): void
}

export const DEFAULT_GOVERNOR_CONFIG = {
  /** monitorEventLoopDelay resolution. */
  resolutionMs: 20,
  /** How often the histogram is read (and reset). */
  sampleMs: 2000,
  /** A sample is "slow" when its delay is strictly above this. */
  enterDelayMs: 100,
  /** Slow samples in a row that enter SHED. */
  enterSamples: 3,
  /** A sample is "calm" when its delay is strictly under this. */
  leaveDelayMs: 40,
  /** Calm for this long (every sample calm) leaves SHED. */
  leaveHoldMs: 10_000,
  /** Valve: SHED never lasts longer than this without a break. */
  maxShedMs: 30 * 60_000,
  /** Valve: after a forced leave, SHED cannot be entered again for this long. */
  forcedOpenMs: 5 * 60_000,
  /** os.freemem is read at most this often. */
  freememEveryMs: 10_000,
  /** At most logMaxPerWindow transition lines per logWindowMs. */
  logWindowMs: 60_000,
  logMaxPerWindow: 6,
  /** This many failed samples in a row stop the governor (fail open). */
  maxConsecutiveErrors: 3,
}

export type GovernorConfig = { [K in keyof typeof DEFAULT_GOVERNOR_CONFIG]: number } & {
  /** What an idle loop reports; default derived from the platform (see idleFloorMs). 0 maps raw numbers 1:1 (tests). */
  idleFloorMs?: number
}

export interface GovernorDeps {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  config?: Partial<GovernorConfig>
  createHistogram?: (resolutionMs: number) => LoopHistogram
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  /** Milliseconds, monotonic. */
  now?: () => number
  /** Bytes. */
  freemem?: () => number
  log?: (line: string) => void
  registry?: ShedRegistry
}

export interface GovernorSnapshot {
  /** The watchdog is running (false: kill switch, never started, stopped, or failed open). */
  enabled: boolean
  shed: boolean
  transitions: number
  enters: number
  forcedLeaves: number
  samples: number
  /** The last histogram p99 as Node reports it (includes the timer tick), 1 decimal; null before the first sample. */
  lastP99Ms: number | null
  /** The last sample's delay beyond the idle floor (or the sampler's lateness, if larger). */
  lastDelayMs: number | null
  maxDelayMs: number
  /** How long the current SHED has lasted; 0 when calm. */
  shedForMs: number
  totalShedMs: number
  /** Free memory at the last read (at most every 10 s); a diagnostic, it never decides SHED. */
  freeMB: number | null
  registered: string[]
  errors: number
}

export interface GovernorHandle {
  readonly enabled: boolean
  stop(): void
  snapshot(): GovernorSnapshot
}

/** What an idle event loop reports at this resolution: Windows rounds timers up to its 15.625 ms tick. */
export function idleFloorMs(resolutionMs: number, platform: NodeJS.Platform): number {
  return platform === 'win32' ? Math.ceil(resolutionMs / 15.625) * 15.625 : resolutionMs
}

export const GOVERNOR_KILL_SWITCH = 'TERMPOLIS_NO_GOVERNOR'
const killSwitchOn = (v: string | undefined): boolean => v === '1' || v === 'true'

const round = (n: number, places: number): number => {
  const f = 10 ** places
  return Math.round(n * f) / f
}

function emptySnapshot(registry: ShedRegistry): GovernorSnapshot {
  return {
    enabled: false, shed: false, transitions: 0, enters: 0, forcedLeaves: 0, samples: 0, lastP99Ms: null,
    lastDelayMs: null, maxDelayMs: 0, shedForMs: 0, totalShedMs: 0, freeMB: null, registered: registry.names(), errors: 0,
  }
}

let active: GovernorHandle | null = null

/** Stop any running governor and forget it. For tests. */
export function __resetLoopGovernorForTests(): void {
  active?.stop()
  active = null
}

/** The running (or last) governor's numbers; a disabled, empty block when none was ever started. */
export function getGovernorSnapshot(): GovernorSnapshot {
  return active ? active.snapshot() : emptySnapshot(shedRegistry)
}

export function startLoopGovernor(deps: GovernorDeps = {}): GovernorHandle {
  active?.stop() // starting again replaces the previous run
  const registry = deps.registry ?? shedRegistry
  const handle = createWatchdog(deps, registry)
  active = handle
  return handle
}

function createWatchdog(deps: GovernorDeps, registry: ShedRegistry): GovernorHandle {
  const env = deps.env ?? process.env
  const log = deps.log ?? ((line: string) => logToApp('info', 'main', [line]))
  const safeLog = (line: string): void => { try { log(line) } catch { /* logging never breaks the governor */ } }
  const inert: GovernorHandle = {
    enabled: false,
    stop: () => {},
    snapshot: () => emptySnapshot(registry),
  }
  if (killSwitchOn(env[GOVERNOR_KILL_SWITCH])) return inert

  // An explicit `undefined` in the overrides means "use the default" (idleFloorMs: undefined = the platform's).
  const overrides = Object.fromEntries(Object.entries(deps.config ?? {}).filter(([, v]) => v !== undefined)) as Partial<GovernorConfig>
  const cfg: GovernorConfig = { ...DEFAULT_GOVERNOR_CONFIG, ...overrides }
  const platform = deps.platform ?? process.platform
  const floor = typeof cfg.idleFloorMs === 'number' ? cfg.idleFloorMs : idleFloorMs(cfg.resolutionMs, platform)
  const now = deps.now ?? ((): number => performance.now())
  const freemem = deps.freemem ?? osFreemem
  const setTimer = deps.setInterval ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms))
  const clearTimer = deps.clearInterval ?? ((h: unknown): void => clearInterval(h as ReturnType<typeof setInterval>))

  let hist: LoopHistogram
  try {
    hist = (deps.createHistogram ?? ((res) => monitorEventLoopDelay({ resolution: res })))(cfg.resolutionMs)
    hist.enable()
  } catch (err) {
    safeLog(`loop governor: disabled, the event-loop histogram is unavailable (${(err as Error)?.message ?? String(err)})`)
    return inert
  }

  // state ---------------------------------------------------------------
  let running = true
  let shed = false
  let shedSince = 0
  let lastBadAt = 0
  let slowStreak = 0
  let blockedUntil = 0
  let lastSampleAt = now()
  let lastFreeAt: number | null = null
  let freeMB: number | null = null
  let samples = 0
  let transitions = 0
  let enters = 0
  let forcedLeaves = 0
  let totalShedMs = 0
  let errors = 0
  let errorsInRow = 0
  let lastP99Ms: number | null = null
  let lastDelayMs: number | null = null
  let maxDelayMs = 0
  const logTimes: number[] = []
  let suppressed = 0
  // The sampler's handle lives in an object: sample() (which can stop the governor) is created before it exists.
  const loop: { timer?: unknown } = {}

  const logTransition = (t: number, text: string): void => {
    while (logTimes.length > 0 && t - logTimes[0] >= cfg.logWindowMs) logTimes.shift()
    if (logTimes.length >= cfg.logMaxPerWindow) { suppressed++; return }
    logTimes.push(t)
    const extra = suppressed > 0 ? ` (${suppressed} earlier transition${suppressed === 1 ? '' : 's'} not logged)` : ''
    suppressed = 0
    safeLog(text + extra)
  }

  const enter = (t: number, delay: number, rawMs: number): void => {
    shed = true
    shedSince = t
    lastBadAt = t
    slowStreak = 0
    enters++
    transitions++
    registry.setShed(true)
    logTransition(t, `loop governor: SHED on (event-loop delay ${round(delay, 1)} ms, p99 ${round(rawMs, 1)} ms, ${cfg.enterSamples} samples in a row); background timers paused`)
  }

  const leave = (t: number, why: 'calm' | 'max-dwell'): void => {
    const lasted = t - shedSince
    totalShedMs += lasted
    shed = false
    slowStreak = 0
    transitions++
    if (why === 'max-dwell') {
      forcedLeaves++
      blockedUntil = t + cfg.forcedOpenMs
    }
    registry.setShed(false)
    logTransition(
      t,
      why === 'calm'
        ? `loop governor: SHED off after ${round(lasted / 1000, 1)} s (loop calm for ${round(cfg.leaveHoldMs / 1000, 1)} s); background timers resumed`
        : `loop governor: SHED off after ${round(lasted / 60_000, 1)} min (max dwell reached, background work gets a ${round(cfg.forcedOpenMs / 60_000, 1)} min window); background timers resumed`,
    )
  }

  const stop = (): void => {
    if (!running) return
    running = false
    try { clearTimer(loop.timer) } catch { /* already gone */ }
    try { hist.disable() } catch { /* already gone */ }
    if (shed) {
      shed = false
      totalShedMs += now() - shedSince
      registry.setShed(false) // fail open: nothing stays paused because the watchdog went away
      safeLog('loop governor: stopped while shed; background timers resumed')
    }
  }

  const failOpen = (): void => {
    safeLog(`loop governor: stopped after ${cfg.maxConsecutiveErrors} failed samples in a row; background timers run as before`)
    stop()
  }

  const sample = (): void => {
    if (!running) return
    const t = now()
    let rawMs = 0
    try {
      rawMs = hist.percentile(99) / 1e6 // the ONE histogram read of this sample
      if (!Number.isFinite(rawMs)) rawMs = 0 // garbage reads as no data, never as calm or slow
      hist.reset()
      errorsInRow = 0
    } catch {
      errors++
      errorsInRow++
      lastSampleAt = t
      if (errorsInRow >= cfg.maxConsecutiveErrors) failOpen()
      return
    }
    samples++
    // The histogram counts the whole tick interval; under 1 ms means it had no data at all (an empty one says 511 ns).
    const histDelay = rawMs < 1 ? 0 : Math.max(0, rawMs - floor)
    // How much later than its own period this very sample ran: sees the stalls the histogram dropped at reset().
    const lateness = Math.max(0, t - lastSampleAt - cfg.sampleMs)
    lastSampleAt = t
    const delay = Math.max(histDelay, lateness)
    lastP99Ms = round(rawMs, 1)
    lastDelayMs = round(delay, 2)
    if (delay > maxDelayMs) maxDelayMs = round(delay, 2)

    if (lastFreeAt === null || t - lastFreeAt >= cfg.freememEveryMs) {
      lastFreeAt = t
      try { freeMB = Math.round(freemem() / (1024 * 1024)) } catch { /* diagnostic only */ }
    }

    if (!shed) {
      if (t < blockedUntil) { slowStreak = 0; return } // forced-open window after the max-dwell valve
      if (delay > cfg.enterDelayMs) {
        slowStreak++
        if (slowStreak >= cfg.enterSamples) enter(t, delay, rawMs)
      } else {
        slowStreak = 0
      }
      return
    }
    if (delay >= cfg.leaveDelayMs) lastBadAt = t // not calm: the 10 s start again
    if (t - lastBadAt >= cfg.leaveHoldMs) leave(t, 'calm')
    else if (t - shedSince >= cfg.maxShedMs) leave(t, 'max-dwell')
  }

  loop.timer = setTimer(sample, cfg.sampleMs)
  try { (loop.timer as { unref?: () => void } | undefined)?.unref?.() } catch { /* a fake timer handle */ }

  return {
    get enabled() { return running },
    stop,
    snapshot: () => ({
      enabled: running,
      shed,
      transitions,
      enters,
      forcedLeaves,
      samples,
      lastP99Ms,
      lastDelayMs,
      maxDelayMs,
      shedForMs: shed ? Math.max(0, now() - shedSince) : 0,
      totalShedMs: Math.round(totalShedMs),
      freeMB,
      registered: registry.names(),
      errors,
    }),
  }
}

/**
 * The ONE call src/main/index.ts makes: start the watchdog now and stop it at will-quit. Never throws and always
 * returns a handle (inert when the kill switch is on or the histogram is unavailable).
 */
export function installLoopGovernor(
  app: { once?: (event: 'will-quit', listener: () => void) => unknown } | null | undefined,
  deps: GovernorDeps = {},
): GovernorHandle {
  let handle: GovernorHandle
  try {
    handle = startLoopGovernor(deps)
  } catch {
    return { enabled: false, stop: () => {}, snapshot: () => emptySnapshot(shedRegistry) }
  }
  if (handle.enabled) {
    try { app?.once?.('will-quit', () => handle.stop()) } catch { /* the sampler is unref'd: quitting never waits for it */ }
  }
  return handle
}
