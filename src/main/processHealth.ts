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
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import {
  startStallProfiler,
  stopStallProfiler,
  sampleStallWindow,
  rotateStallProfileIfStale,
  type SampledFrame,
  type SampledWindow,
} from './stallProfiler'

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

/**
 * Begin sampling. Safe to call twice; safe to never call (the getters degrade to zeroes).
 *
 * `profileStacks` arms V8's sampling CPU profiler, which is what lets a freeze in UNLABELLED code
 * still be named. It samples on its own native thread, so it keeps working while this one is dead.
 */
export function startProcessHealth(now: () => number = Date.now, profileStacks = true): void {
  if (loop) return
  startedAt = now()
  if (profileStacks) {
    try { startStallProfiler(now) } catch { /* attribution degrades to labels only; the app does not */ }
  }
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
  try { stopStallProfiler() } catch { /* ignore */ }
  loop = null
  gcObserver = null
}

/** @internal test-only — clears the accumulators without touching the observers. */
export function _resetProcessHealthForTests(): void {
  try { if (ticker) clearInterval(ticker) } catch { /* ignore */ }
  ticker = null
  stalls = []
  breadcrumb = null
  openSpans.length = 0
  doneSpans = []
  stallLogPath = null
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
  /** Wall-clock ms when the freeze began. */
  startedAt: number
  /** How long the event loop was blocked. */
  durationMs: number
  /** What we can actually attribute it to. */
  cause: 'gc' | 'sync-work'
  /** Stop-the-world GC time inside this stall, when GC is the cause. */
  gcPauseMs: number
  heapUsedMB: number
  rssMB: number
  /** The labelled operation that held the thread longest. Null only when nothing was labelled. */
  breadcrumb: string | null
  /** EVERY labelled operation that overlapped the freeze, with how much of it each accounts for. */
  spans?: SpanAttribution[]
  /** What the CPU was actually executing, sampled straight through the freeze. Names the unlabelled. */
  stack?: SampledFrame[]
  /** GC time per the SAMPLER — an independent witness to gcPauseMs, which can under-report. */
  sampledGcMs?: number
}

/** A labelled operation, and how much of a given freeze it accounts for. */
export interface SpanAttribution {
  label: string
  ms: number
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
 *
 * THE BUG THIS FILE SHIPPED WITH, AND WHY IT WAS INVISIBLE:
 *
 * These marks used to be read as a LIVE VARIABLE, at tick time — the watchdog asked "what is running
 * right now?" the moment it noticed it had been late. That question can never be answered, because of
 * the ordering:
 *
 *     markBusy('memory:load-shard')     // label set
 *     reloadFromImpl()                  // blocks 18.8 s — the watchdog timer CANNOT run
 *     clearBusy('memory:load-shard')    // label destroyed, in the `finally`
 *     ...stack unwinds, event loop finally runs...
 *     onTick()                          // watchdog fires, reads `breadcrumb` -> null
 *
 * The label is erased microseconds before the only observer that would read it. Every freeze wiped
 * its own name on the way out, so seven real 400 ms-18.8 s freezes on David's machine were all
 * recorded as `sync-work, breadcrumb: null` — including the ones that WERE labelled, correctly, and
 * had been for two releases. The instrumentation was pointed straight at the culprit and still said
 * nothing. Only work that YIELDS mid-flight could ever be caught, which is precisely the work that
 * is not freezing you.
 *
 * So we stop asking what is running now (nothing is — that is why we are running) and start asking
 * what OVERLAPPED THE WINDOW THE THREAD WAS GONE FOR. That needs spans with start and end times, and
 * finished spans have to outlive themselves long enough to testify. Hence the two lists below.
 */
// `depth` is how many marks were already open when this one began. It is the only thing that can
// distinguish an operation from the wrapper around it when the two are exactly coextensive — and
// relying on the incidental order the spans happened to be closed in, as an earlier draft of this
// did, is precisely the kind of implicit assumption that produced the bug above.
interface OpenSpan { label: string; startedAt: number; depth: number }
interface DoneSpan { label: string; startedAt: number; endedAt: number; depth: number }

const openSpans: OpenSpan[] = []
let doneSpans: DoneSpan[] = []

/** Finished work is only evidence for as long as a freeze could still be blamed on it. */
const SPAN_RETENTION_MS = 60_000
const MAX_DONE_SPANS = 256

export function markBusy(label: string, now: () => number = Date.now): void {
  openSpans.push({ label, startedAt: now(), depth: openSpans.length })
  breadcrumb = label
}

/** Close one span (the matching mark), or — with no argument — every open one. */
export function clearBusy(label?: string, now: () => number = Date.now): void {
  const at = now()
  const close = (i: number): void => {
    const [s] = openSpans.splice(i, 1)
    doneSpans.push({ label: s.label, startedAt: s.startedAt, endedAt: at, depth: s.depth })
  }
  if (label === undefined) {
    for (let i = openSpans.length - 1; i >= 0; i--) close(i)
  } else {
    const i = openSpans.map((s) => s.label).lastIndexOf(label)
    if (i >= 0) close(i)
  }
  if (doneSpans.length > MAX_DONE_SPANS) doneSpans = doneSpans.slice(-MAX_DONE_SPANS)
  breadcrumb = openSpans.length > 0 ? openSpans[openSpans.length - 1].label : null
}

/** Drop finished spans too old to explain any freeze we would still record. */
function pruneSpans(nowMs: number): void {
  if (doneSpans.length === 0) return
  const cutoff = nowMs - SPAN_RETENTION_MS
  if (doneSpans[0].endedAt >= cutoff) return // hot path: nothing to do
  doneSpans = doneSpans.filter((s) => s.endedAt >= cutoff)
}

/**
 * How much of the window [start, end] each labelled operation accounts for, most first.
 *
 * PURE, so every shape that bit us is pinned in a test rather than argued about: nested spans (a
 * sweep persisting the graph inside itself), concurrent spans, spans that began long BEFORE the
 * freeze, and spans still open when the tick finally fires.
 *
 * Nested spans both overlap, and both are reported — "the sweep held the thread for 17.9 s, and
 * 2.1 s of that was persisting" is a better answer than either line alone. Ranking is by how much of
 * the freeze each operation owns; an exact tie (a wrapper that is entirely one inner op) breaks
 * toward the DEEPER span, because a wrapper that only wraps must not out-rank the work it wraps.
 */
export function attributeSpans(
  windowStart: number,
  windowEnd: number,
  open: readonly OpenSpan[] = openSpans,
  done: readonly DoneSpan[] = doneSpans,
): SpanAttribution[] {
  const overlap = new Map<string, { ms: number; depth: number }>()
  const add = (label: string, startedAt: number, endedAt: number, depth: number): void => {
    const ms = Math.min(endedAt, windowEnd) - Math.max(startedAt, windowStart)
    if (ms <= 0) return
    const prev = overlap.get(label)
    if (prev) {
      prev.ms += ms
      prev.depth = Math.max(prev.depth, depth)
    } else {
      overlap.set(label, { ms, depth })
    }
  }
  for (const s of done) add(s.label, s.startedAt, s.endedAt, s.depth)
  // Still open when the thread came back: it was running for the whole tail of the freeze.
  for (const s of open) add(s.label, s.startedAt, windowEnd, s.depth)

  return [...overlap.entries()]
    .map(([label, v]) => ({ label, ms: Math.round(v.ms), depth: v.depth }))
    .filter((a) => a.ms > 0)
    .sort((a, b) => b.ms - a.ms || b.depth - a.depth)
    .map(({ label, ms }) => ({ label, ms }))
}

/** Run `fn` with a breadcrumb attached. Any freeze during it is attributed to `label`. */
export function tracked<T>(label: string, fn: () => T): T {
  markBusy(label)
  try {
    return fn()
  } finally {
    clearBusy(label)
  }
}

/** Async twin of `tracked` — for work that spans awaits (a repo sweep, a shard reload). */
export async function trackedAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  markBusy(label)
  try {
    return await fn()
  } finally {
    clearBusy(label)
  }
}

/** What the main thread says it is doing right now — the innermost active mark, or null if idle. */
export function currentBreadcrumb(): string | null {
  return breadcrumb
}

export function recentStalls(): Stall[] {
  return [...stalls]
}

/** @internal test-only */
export function _pushStallForTests(s: Stall): void { stalls.push(s) }
/** @internal test-only */
export function _clearStallsForTests(): void { stalls = [] }
/** @internal test-only — the span ledger, so tests can assert on what the watchdog will see. */
export function _spansForTests(): { open: OpenSpan[]; done: DoneSpan[] } {
  return { open: [...openSpans], done: [...doneSpans] }
}

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
    pruneSpans(t)
    // Keep the live CPU profile short on the healthy ticks, so its own harvest stays a few ms and
    // this instrument never becomes the disease it diagnoses.
    try { rotateStallProfileIfStale(now) } catch { /* the profiler is a bonus, never a dependency */ }
    return
  }

  const gcObserved = Math.max(0, gcTotalPauseMs - gcPauseAtLastTick)
  gcPauseAtLastTick = gcTotalPauseMs

  // THE FREEZE ITSELF: the tick was due at (lastTick + TICK_MS) and arrived `drift` late, so the
  // thread was gone across [t - drift, t]. Attribute against THAT, not against the whole gap since
  // the previous tick — the gap includes up to TICK_MS of perfectly healthy time before the freeze
  // began, and crediting a span for it produces the nonsense of "18.9 s of an 18.8 s freeze".
  // Everything we report is now bounded by the freeze it is explaining.
  const from = t - drift

  // What was LABELLED, and what the CPU was actually executing. The first names the operation in the
  // user's terms ("loading the memory shard"); the second names the code, and needs nobody to have
  // predicted the freeze in advance — which is the only way to catch the freeze you did not expect.
  const spans = attributeSpans(from, t)
  let sampled: SampledWindow | null = null
  try {
    sampled = sampleStallWindow(from, t, now)
  } catch {
    sampled = null // a profiler that fails must cost us the stack, not the stall record
  }

  // GC, cross-examined. The PerformanceObserver delivers its entries through the event loop, so a
  // freeze can end with some of its own GC time not yet reported — which would silently reclassify a
  // GC freeze as "synchronous work" and send you hunting for code that was never running. The
  // sampler saw the collector directly, on its own thread. Believe whichever witness saw more.
  const gcInStall = Math.max(gcObserved, sampled?.gcMs ?? 0)

  const mem = process.memoryUsage()
  const stall: Stall = {
    ts: t,
    startedAt: Math.round(from),
    durationMs: Math.round(drift),
    cause: gcInStall >= drift * 0.5 ? 'gc' : 'sync-work',
    gcPauseMs: Math.round(gcInStall),
    heapUsedMB: Math.round(mem.heapUsed / 1048576),
    rssMB: Math.round(mem.rss / 1048576),
    breadcrumb: spans[0]?.label ?? null,
    ...(spans.length > 0 ? { spans } : {}),
    ...(sampled && sampled.frames.length > 0 ? { stack: sampled.frames } : {}),
    ...(sampled ? { sampledGcMs: sampled.gcMs } : {}),
  }
  stalls.push(stall)
  if (stalls.length > MAX_STALLS) stalls = stalls.slice(-MAX_STALLS)
  appendStall(stall)
  pruneSpans(t)
}

// --- persistence -------------------------------------------------------------------------------
//
// A freeze you can no longer see is a freeze you cannot fix. Held only in memory, the stall history
// died with the process — so the one artifact worth having (what froze, how long, how big the heap
// was) was gone by the time anyone came to look. Append each stall to a device-local JSONL instead:
// small, bounded, and readable straight off disk after the fact.

let stallLogPath: string | null = null

/**
 * The log is a diagnostic, not an archive — and it is read on the MAIN THREAD, every 3 seconds, for
 * as long as the panel is open. An unbounded file re-read and re-parsed on that cadence is a freeze
 * waiting to happen, which would make this the first diagnostic to cause the disease it reports. So
 * the file is capped, only its tail is ever read, and the parse is cached against the file's stat.
 */
const MAX_LOG_BYTES = 512 * 1024
/** Enough to hold MAX_STALLS records with their stacks; we still drop the torn first line. */
const TAIL_READ_BYTES = MAX_LOG_BYTES

let cache: { size: number; mtimeMs: number; stalls: Stall[] } | null = null

/** Point the stall recorder at `dir` (userData). Best-effort: a log failure never affects the app. */
export function initStallLog(dir: string): void {
  cache = null
  try {
    stallLogPath = nodePath.join(dir, 'stalls.jsonl')
  } catch {
    stallLogPath = null
  }
}

function appendStall(s: Stall): void {
  if (!stallLogPath) return
  try {
    nodeFs.appendFileSync(stallLogPath, JSON.stringify(s) + '\n')
    cache = null
    trimStallLog()
  } catch {
    /* best effort — the in-memory stall is still recorded */
  }
}

/** Once the log outgrows its cap, rewrite it as just the recent past. */
function trimStallLog(): void {
  if (!stallLogPath) return
  try {
    if (nodeFs.statSync(stallLogPath).size <= MAX_LOG_BYTES) return
    const keep = parseTail(readTail())
    nodeFs.writeFileSync(stallLogPath, keep.slice(-MAX_STALLS).map((s) => JSON.stringify(s)).join('\n') + '\n')
    cache = null
  } catch {
    /* a log we cannot trim is still a log we can append to */
  }
}

/** The last TAIL_READ_BYTES of the file, plus whether we started mid-line. */
function readTail(): { text: string; partialFirstLine: boolean } {
  if (!stallLogPath) return { text: '', partialFirstLine: false }
  let fd: number | null = null
  try {
    fd = nodeFs.openSync(stallLogPath, 'r')
    const size = nodeFs.fstatSync(fd).size
    const len = Math.min(size, TAIL_READ_BYTES)
    const from = size - len
    const buf = Buffer.alloc(len)
    nodeFs.readSync(fd, buf, 0, len, from)
    return { text: buf.toString('utf8'), partialFirstLine: from > 0 }
  } catch {
    return { text: '', partialFirstLine: false }
  } finally {
    if (fd !== null) { try { nodeFs.closeSync(fd) } catch { /* ignore */ } }
  }
}

function parseTail({ text, partialFirstLine }: { text: string; partialFirstLine: boolean }): Stall[] {
  const lines = text.split('\n')
  if (partialFirstLine) lines.shift() // we sliced into the middle of a record; it is not ours to parse
  const out: Stall[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as Stall)
    } catch {
      /* skip a torn line rather than losing the whole history */
    }
  }
  return out
}

/** Stalls recorded on previous runs too — the file, newest last. Used by the dashboard. */
export function persistedStalls(limit = MAX_STALLS): Stall[] {
  if (!stallLogPath) return []
  try {
    // The panel polls this every 3 s. The file only changes when a freeze is appended, so a stat is
    // the whole cost of the common case.
    const st = nodeFs.statSync(stallLogPath)
    if (cache && cache.size === st.size && cache.mtimeMs === st.mtimeMs) return cache.stalls.slice(-limit)
    const parsed = parseTail(readTail())
    cache = { size: st.size, mtimeMs: st.mtimeMs, stalls: parsed }
    return parsed.slice(-limit)
  } catch {
    return []
  }
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
