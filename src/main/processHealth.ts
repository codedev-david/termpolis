// Main-process health: is THIS thread actually struggling, and are the vectors why?
//
// Termpolis pumps the PTY on the main thread. That is the whole reason vector RAM is worth a
// setting at all: a multi-gigabyte Float32Array here means GC pressure on the one thread whose
// stalls the user feels as TYPING LAG. (We have been here before — an in-process WASM embedder
// pinning the main thread was a real, shipped lag bug.)
//
// So the quantization toggle should not be sold on a number nobody can interpret ("4x less vector
// RAM!"). It should be answered with evidence from THIS install:
//
//   - Is the main thread stalling?           -> event-loop delay histogram
//   - Is GC the reason?                      -> GC pause count / total / max
//   - Are the VECTORS a meaningful share?    -> vector bytes vs resident set
//
// Which lets the panel give the one answer an honest tool must be willing to give:
// "your stalls are not coming from vector RAM — quantizing will not help you."

import { monitorEventLoopDelay, PerformanceObserver, constants, type EventLoopDelayMonitor } from 'perf_hooks'

export interface ProcessHealth {
  /** Resident set size — everything this process holds in RAM. */
  rssBytes: number
  /** V8 heap. Note the packed vector store is NOT here — typed arrays live off-heap. */
  heapUsedBytes: number
  /** Off-heap ArrayBuffers. THIS is where the packed vector store actually lives. */
  arrayBufferBytes: number
  /** Main-thread stall, in ms. p99 is the one that matches "the app felt janky". */
  loopDelayP50Ms: number
  loopDelayP99Ms: number
  loopDelayMaxMs: number
  /** Major (full, stop-the-world) collections since the last reset. */
  gcMajorCount: number
  /** Total ms spent paused in GC since the last reset. */
  gcTotalPauseMs: number
  /** The single longest GC pause. A >50 ms stop-the-world pause is a visible hitch. */
  gcMaxPauseMs: number
  /** How long we have been sampling — a rate is meaningless without it. */
  sampleWindowMs: number
  /** GC as a share of wall-clock. Above a few percent the thread is fighting the collector. */
  gcTimeFraction: number
}

// A main-thread stall you can actually feel while typing. 50 ms is roughly three dropped frames
// and is the point at which keystroke echo stops feeling instant.
export const STALL_MS = 50
// Below this, freeing vector RAM cannot plausibly change anything — you would be trading exactness
// for a saving the OS will not even notice.
export const VECTOR_RAM_FLOOR_BYTES = 256 * 1024 * 1024 // 256 MB
// If the vectors are less than this share of the resident set, they are not what is hurting you,
// no matter how bad the stalls are.
export const VECTOR_SHARE_FLOOR = 0.2 // 20%

let loop: EventLoopDelayMonitor | null = null
let gcObserver: PerformanceObserver | null = null
let gcMajorCount = 0
let gcTotalPauseMs = 0
let gcMaxPauseMs = 0
let startedAt = 0

/** Begin sampling. Safe to call twice; safe to never call (the getters degrade to zeroes). */
export function startProcessHealth(now: () => number = Date.now): void {
  if (loop) return
  startedAt = now()
  try {
    loop = monitorEventLoopDelay({ resolution: 10 })
    loop.enable()
  } catch {
    loop = null // platform without the histogram — we simply report zeroes rather than crash
  }
  lastTick = startedAt
  gcPauseAtLastTick = 0
  try {
    ticker = setInterval(() => onTick(now), TICK_MS)
    // A watchdog that keeps the process alive would be a bug in a desktop app.
    ;(ticker as unknown as { unref?: () => void }).unref?.()
  } catch {
    ticker = null
  }
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const ms = entry.duration
        gcTotalPauseMs += ms
        if (ms > gcMaxPauseMs) gcMaxPauseMs = ms
        // `detail.kind` is a numeric constant; a MAJOR gc is the stop-the-world one that stalls
        // the PTY pump. Minor (scavenge) collections are sub-millisecond and are not the problem.
        const kind = (entry as unknown as { detail?: { kind?: number } }).detail?.kind
        if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) gcMajorCount++
      }
    })
    gcObserver.observe({ entryTypes: ['gc'] })
  } catch {
    gcObserver = null
  }
}

export function stopProcessHealth(): void {
  try { if (ticker) clearInterval(ticker) } catch { /* ignore */ }
  ticker = null
  try { loop?.disable() } catch { /* ignore */ }
  try { gcObserver?.disconnect() } catch { /* ignore */ }
  loop = null
  gcObserver = null
}

/** @internal test-only — clears the accumulators without touching the observers. */
export function _resetProcessHealthForTests(): void {
  try { if (ticker) clearInterval(ticker) } catch { /* ignore */ }
  ticker = null
  stalls = []
  breadcrumb = null
  lastTick = 0
  gcPauseAtLastTick = 0
  gcMajorCount = 0
  gcTotalPauseMs = 0
  gcMaxPauseMs = 0
  startedAt = 0
  loop = null
  gcObserver = null
}

const ms = (nanos: number): number => Math.round(nanos / 1e6 * 100) / 100

export function processHealth(now: () => number = Date.now): ProcessHealth {
  const mem = process.memoryUsage()
  const windowMs = startedAt ? Math.max(1, now() - startedAt) : 0
  return {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    arrayBufferBytes: mem.arrayBuffers ?? 0,
    loopDelayP50Ms: loop ? ms(loop.percentile(50)) : 0,
    loopDelayP99Ms: loop ? ms(loop.percentile(99)) : 0,
    loopDelayMaxMs: loop ? ms(loop.max) : 0,
    gcMajorCount,
    gcTotalPauseMs: Math.round(gcTotalPauseMs * 100) / 100,
    gcMaxPauseMs: Math.round(gcMaxPauseMs * 100) / 100,
    sampleWindowMs: windowMs,
    gcTimeFraction: windowMs > 0 ? Math.min(1, gcTotalPauseMs / windowMs) : 0,
  }
}

/**
 * A recorded FREEZE: a stretch where the main thread stopped serving the event loop entirely.
 *
 * This is the thing users actually feel. Windows paints the title bar "(Not Responding)" when the
 * message pump stalls, so a 2-3 second block here is not "a bit of lag" — it is the whole app going
 * dead and coming back. Averages and percentiles hide it (one 2.5 s freeze barely moves a p99 over a
 * 60 s window), which is exactly why it has to be recorded as a discrete EVENT, not a statistic.
 */
export interface Stall {
  /** Wall-clock ms when the thread came back. */
  ts: number
  /** How long the event loop was blocked. */
  durationMs: number
  /** What we can actually attribute it to. */
  cause: 'gc' | 'sync-work'
  /** Stop-the-world GC time inside this stall, when GC is the cause. */
  gcPauseMs: number
  heapUsedMB: number
  rssMB: number
  /** What was in flight, if anything marked itself. */
  breadcrumb: string | null
}

/** A freeze the user would notice. Below this it is lag; above it, the app is "not responding". */
export const STALL_RECORD_MS = 400
/** How often the watchdog checks in. Small enough to time a freeze, big enough to cost nothing. */
const TICK_MS = 250
/** Keep the recent past only — this is a diagnostic, not a log file. */
const MAX_STALLS = 100

let stalls: Stall[] = []
let ticker: ReturnType<typeof setInterval> | null = null
let lastTick = 0
let gcPauseAtLastTick = 0
let breadcrumb: string | null = null

/**
 * Mark what the main thread is busy with, so a freeze can name its cause instead of just its size.
 * A GC pause is attributed by the GC observer; everything else is synchronous work, and THIS is how
 * we find out which synchronous work.
 */
export function markBusy(label: string): void { breadcrumb = label }
export function clearBusy(): void { breadcrumb = null }

/** Run `fn` with a breadcrumb attached. Any freeze during it is attributed to `label`. */
export function tracked<T>(label: string, fn: () => T): T {
  markBusy(label)
  try {
    return fn()
  } finally {
    clearBusy()
  }
}

export function recentStalls(): Stall[] {
  return [...stalls]
}

/** @internal test-only */
export function _pushStallForTests(s: Stall): void { stalls.push(s) }
/** @internal test-only */
export function _clearStallsForTests(): void { stalls = [] }

/**
 * The watchdog.
 *
 * A timer set for TICK_MS that arrives LATE by more than STALL_RECORD_MS can only mean one thing:
 * the event loop was not being served. That is a direct measurement of the freeze — not a proxy for
 * it — and it costs one timer callback every 250 ms.
 */
function onTick(now: () => number): void {
  const t = now()
  const drift = t - lastTick - TICK_MS
  lastTick = t
  if (drift < STALL_RECORD_MS) {
    gcPauseAtLastTick = gcTotalPauseMs
    return
  }
  const gcInStall = Math.max(0, gcTotalPauseMs - gcPauseAtLastTick)
  gcPauseAtLastTick = gcTotalPauseMs
  const mem = process.memoryUsage()
  stalls.push({
    ts: t,
    durationMs: Math.round(drift),
    // If GC accounts for most of the freeze, GC IS the freeze. Otherwise something ran synchronously
    // on the thread and the breadcrumb is our only witness.
    cause: gcInStall >= drift * 0.5 ? 'gc' : 'sync-work',
    gcPauseMs: Math.round(gcInStall),
    heapUsedMB: Math.round(mem.heapUsed / 1048576),
    rssMB: Math.round(mem.rss / 1048576),
    breadcrumb,
  })
  if (stalls.length > MAX_STALLS) stalls = stalls.slice(-MAX_STALLS)
}

export type QuantVerdict =
  /** Vectors are small. Nothing to gain — this is the correct state for most users, forever. */
  | 'not-needed'
  /** The thread IS stalling, but the vectors are not a meaningful share of memory. Be honest: this
   *  toggle will not fix it, and flipping it would only cost precision for nothing. */
  | 'wont-help'
  /** Vectors are big enough to matter, but nothing is actually degrading yet. Their call. */
  | 'optional'
  /** The thread is stalling AND the vectors are a large share of the footprint. Worth doing. */
  | 'recommended'
  /** Already on. */
  | 'enabled'

export interface QuantAdvice {
  verdict: QuantVerdict
  headline: string
  detail: string
  /** Bytes freed by turning it on (0 when it is already on). */
  savingBytes: number
}

const mb = (b: number): string => `${Math.round(b / 1048576)} MB`

/**
 * The recommendation. PURE — takes the numbers, returns advice — so every branch is unit-testable
 * and none of it depends on a live process.
 *
 * The design rule: this function must be willing to say "do not turn this on". A control that only
 * ever markets itself is not a decision aid, it is an upsell — and here the cost of a wrong yes
 * (quietly approximating the one thing the brain exists to do) is invisible, while the benefit is
 * imperceptible until the corpus is genuinely large. So the burden of proof sits on ENABLING.
 */
export function quantizationAdvice(
  v: { vectors: number; quantized: boolean; ramBytes: number; ramBytesInt8: number },
  h: Pick<ProcessHealth, 'rssBytes' | 'loopDelayP99Ms' | 'gcMaxPauseMs'>,
): QuantAdvice {
  const saving = Math.max(0, v.ramBytes - v.ramBytesInt8)

  if (v.quantized) {
    return {
      verdict: 'enabled',
      headline: 'int8 is on — vectors are using ' + mb(v.ramBytes),
      detail:
        'Exact floats are still on disk, so you can switch back at any time and lose nothing. ' +
        'The store simply re-packs at full precision on the next load.',
      savingBytes: 0,
    }
  }

  const stalling = h.loopDelayP99Ms >= STALL_MS || h.gcMaxPauseMs >= STALL_MS
  const vectorShare = h.rssBytes > 0 ? v.ramBytes / h.rssBytes : 0
  const bigEnoughToMatter = v.ramBytes >= VECTOR_RAM_FLOOR_BYTES

  // Small vectors: there is no version of this that helps, stalling or not.
  if (!bigEnoughToMatter) {
    return {
      verdict: 'not-needed',
      headline: `Not needed — your ${v.vectors.toLocaleString()} vectors use only ${mb(v.ramBytes)}`,
      detail:
        `Turning int8 on would free about ${mb(saving)}, which is not enough to change anything. ` +
        'Leave it off: exact vectors are the better default until memory is actually costing you something. ' +
        'This panel will tell you if that changes.',
      savingBytes: saving,
    }
  }

  // Vectors ARE big — but is that why the thread is struggling?
  if (stalling && vectorShare < VECTOR_SHARE_FLOOR) {
    return {
      verdict: 'wont-help',
      headline: 'Your main thread is stalling — but not because of the vectors',
      detail:
        `The main thread is hitting pauses (p99 ${h.loopDelayP99Ms} ms, longest GC ${h.gcMaxPauseMs} ms), ` +
        `but the vectors are only ${Math.round(vectorShare * 100)}% of this process's memory. ` +
        'Freeing them would not fix the stalls, and you would lose exactness for nothing. Look elsewhere.',
      savingBytes: saving,
    }
  }

  if (stalling) {
    return {
      verdict: 'recommended',
      headline: `Worth turning on — vectors are ${mb(v.ramBytes)} (${Math.round(vectorShare * 100)}% of this process)`,
      detail:
        `The main thread — the same one that echoes your keystrokes — is pausing (p99 ${h.loopDelayP99Ms} ms, ` +
        `longest GC ${h.gcMaxPauseMs} ms), and the vectors are a large share of what it is holding. ` +
        `int8 frees about ${mb(saving)} of that. Recall parity is benchmarked, and it is reversible: ` +
        'disk keeps exact floats, so if it does not help, switch back.',
      savingBytes: saving,
    }
  }

  return {
    verdict: 'optional',
    headline: `Your call — vectors are ${mb(v.ramBytes)}, and nothing is degrading`,
    detail:
      `int8 would free about ${mb(saving)}. The main thread is healthy right now ` +
      `(p99 ${h.loopDelayP99Ms} ms), so there is no problem to fix — but the memory is real, ` +
      'so turning it on is defensible if you want the headroom back.',
    savingBytes: saving,
  }
}
