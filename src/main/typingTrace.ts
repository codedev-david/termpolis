// typingTrace.ts -- echo trace, loop-delay and pressure counters for the main process.
//
// WHY: typing lags for seconds on David's laptop, in a plain shell too, while a browser and VS Code
// next to it do not. node-pty lives inside this process, so every keystroke and every echo crosses
// the main event loop, and until now nothing could tell the three suspects apart: this app blocking
// its own loop, the agent CLI being slow to echo, or the machine being too busy to run anything. No
// loop delay, no echo latency, no per-handler time was recorded anywhere. This module records them.
//
// WHAT IT RECORDS (numbers only: no key, no path, no terminal id, nothing leaves the machine):
//   * event-loop delay, per 5 s window: p50 / p99 / max beyond the 10 ms period, from the Node
//     histogram (one read per window), and the loop's busy share (ELU) for the window;
//   * V8 garbage collections: count and longest pause for major and incremental, count for minor;
//   * per-IPC-handler {count, msSum, msMax}: terminal:write, terminal:resize, memory:reflect-session,
//     agentWatcher:attach, and each MCP tool by name (see timedIpc, traceMcpTool);
//   * T1, the time from the renderer's key handler to this process (the renderer stamps 1 printable
//     key in 10 with its clock, see echoTrace.ts), and T2, from our write into the pty to the first
//     output byte that leaves for the renderer afterwards (a lower bound: output already in flight
//     answers it early);
//   * free memory, RSS and V8 heap, every 10 s.
// One log line per active minute goes to the app log, and the same numbers sit in the snapshot that
// `diagnostics:collect` returns.
//
// WHAT IT MUST NEVER BE (the v1.25.16 lesson, project_freeze_diagnosis.md): an instrument whose cost
// was measured somewhere cheap, wired into the loop that reacts to that cost, is a positive feedback
// loop waiting for a big enough heap. v1.25.15's stall profiler called a call that blocked ~1 s in the
// real heap from its own watchdog, so every freeze it reported was one it had just caused. So:
//   * every sample is O(1) and read-only; the only timer is ONE interval on a fixed 5 s cadence that
//     never reacts to what it reads (no "stalled, so look harder"); a stall changes the numbers, not
//     the work;
//   * the loop histogram is Node's own, read with one pass per window; there is no profiler and no
//     inspector, and tests/electron/noMainThreadInstruments.test.ts keeps it that way;
//   * the per-event hooks (a write, an output chunk, a handler call) touch a few numbers and a Map, and
//     do no I/O, no clock read beyond one monotonic read, and no allocation beyond one small record;
//   * nothing here enumerates processes, connections or credential stores (the endpoint guard).
//
// KILL SWITCH: TERMPOLIS_TYPING_TRACE=0 (or off/false/no). Switched off, no timer, histogram or
// observer is created and every wrapper returns the function it was given: today's behaviour,
// exactly. Every sensor and every hook fails open: a throwing sensor leaves its field null, a throwing
// hook leaves the write, the resize or the tool call untouched.
//
// WIRING (one call each, in index.ts): startTypingTrace() after initAppLog; traceTerminalWrite(...)
// around the terminal:write handler; noteTerminalOutput(id) in each pty output callback;
// timedIpc(name, ...) around terminal:resize, memory:reflect-session and agentWatcher:attach;
// traceMcpTool(name, ...) around executeTool. The pass counters of the conversation ingest and the
// session reflect plug in later through registerTypingTraceSource(name, read): whatever it returns
// appears under `extra` in the snapshot.

import * as perfHooks from 'perf_hooks'
import { freemem as osFreemem } from 'os'
import { getHeapStatistics } from 'v8'

/** Set to 0 / off / false / no to turn the whole trace off. */
export const KILL_SWITCH_ENV = 'TERMPOLIS_TYPING_TRACE'

const WINDOW_MS = 5_000
const MEMORY_EVERY_TICKS = 2 // 10 s
const MINUTE_EVERY_TICKS = 12 // 60 s
const RING_WINDOWS = 12
/** The histogram's timer period. It records the interval between firings, so the delay is the excess. */
const LOOP_RESOLUTION_MS = 10
const STALL_MS = 250
const LONG_STALL_MS = 1_000
/** A minute with a stall at least this long is worth a line even if nobody typed. */
const LOG_STALL_MS = 100
/** A stamp this far in the future is a clock that disagrees; older than a minute is not a keystroke. */
const T1_SKEW_MS = 1_000
const T1_MAX_MS = 60_000
/** An echo later than this never was one (a password prompt echoes nothing). */
const T2_EXPIRE_MS = 5_000
const MAX_PENDING_T2 = 64
const MAX_NAMES = 64
const LOG_HANDLERS = 6
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,64}$/

export type GcKind = 'major' | 'minor' | 'incremental' | 'other'

/** One window of the loop-delay histogram. Milliseconds of delay beyond the 10 ms period. */
export interface LoopDelayReading { count: number; p50: number; p99: number; max: number }
export interface LoopDelaySource {
  /** One pass over the histogram, then a reset: the per-window cost, whatever the loop did. */
  readAndReset(): LoopDelayReading
  stop(): void
}
export interface EluReading { idle: number; active: number }

export interface TypingTraceDeps {
  env?: Record<string, string | undefined>
  /** Monotonic ms. */
  now?: () => number
  /** Epoch ms: the renderer's key stamps are read against it. */
  wallNow?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  openLoopDelay?: () => LoopDelaySource | null
  readElu?: () => EluReading | null
  observeGc?: (cb: (kind: GcKind, ms: number) => void) => (() => void) | null
  freemem?: () => number
  rss?: () => number
  heap?: () => { used: number; total: number; limit: number }
  log?: (line: string) => void
}

export interface LatencyStat { n: number; avg: number; max: number }
export interface IpcStat { count: number; msSum: number; msMax: number }

export interface TypingTraceSnapshot {
  /** False when the kill switch is thrown. */
  enabled: boolean
  started: boolean
  uptimeMs: number
  loopDelay: {
    /** The last completed 5 s window, or null before the first (or with no histogram). */
    last: LoopDelayReading | null
    /** The worst of the last minute of windows, or null. */
    minute: { windows: number; p50Median: number; p99Max: number; max: number; over250: number; over1000: number } | null
  }
  /** Busy share of the last window, 0..1. */
  elu: number | null
  /** What the sampler itself cost, per 5 s tick, since start. Recorded and reported, never reacted to:
   *  an instrument that got expensive has to show in its own record (the v1.25.16 lesson). */
  sampler: { ticks: number; msSum: number; msMax: number }
  gc: { majorCount: number; majorMaxMs: number; incrementalCount: number; incrementalMaxMs: number; minorCount: number }
  /** Renderer key handler to this process, for stamped keys, since start. */
  t1: LatencyStat
  /** Our pty write to the first output after it, for stamped keys, since start. */
  t2: LatencyStat & { expired: number }
  ipc: Record<string, IpcStat>
  memory: { freeMB: number; rssMB: number; heapUsedMB: number; heapTotalMB: number; heapLimitMB: number } | null
  /** Whatever registerSource callers return: the pass counters of the ingest and reflect passes. */
  extra: Record<string, unknown>
}

export interface TypingTrace {
  readonly enabled: boolean
  start(): void
  stop(): void
  traceTerminalWrite<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R
  noteTerminalOutput(id: string): void
  timedIpc<A extends unknown[], R>(name: string, fn: (...args: A) => R): (...args: A) => R
  traceMcpTool<T>(name: string, run: () => Promise<T>): Promise<T>
  registerSource(name: string, read: () => unknown): void
  snapshot(): TypingTraceSnapshot
}

// ---------------------------------------------------------------------------------------------
// The real sensors. Each takes the Node module as a parameter so a test can hand it a stand-in.
// ---------------------------------------------------------------------------------------------

interface HistogramLike {
  count?: number
  max: number
  enable(): unknown
  disable(): unknown
  reset(): void
  percentile(p: number): number
}
interface LoopHooks { monitorEventLoopDelay: (o: { resolution: number }) => HistogramLike }
interface EluHooks { performance: { eventLoopUtilization: () => { idle: number; active: number } } }
interface GcEntryLike { duration: number; detail?: { kind?: number } | null; kind?: number }
interface GcHooks {
  PerformanceObserver: new (cb: (list: { getEntries: () => GcEntryLike[] }) => void) => {
    observe: (o: { entryTypes: string[] }) => void
    disconnect: () => void
  }
  constants: Record<string, number>
}

const realHooks = perfHooks as unknown as LoopHooks & EluHooks & GcHooks

/**
 * Node's event-loop-delay histogram. It records the time between its own 10 ms timer firings, so the
 * delay is the excess over the period. An EMPTY histogram does not read zero (percentile() answers
 * 511 ns), hence the count guard: unknown is not a healthy loop.
 *
 * READING IT ON WINDOWS: the OS timer floor is about 15.6 ms, so a 10 ms timer fires roughly every
 * 15.6 ms even on an idle loop and p50 reads about 5 to 6 ms here. That is the clock, not lag
 * (project_v1_47_learning_loop.md measured the same floor). Compare windows with each other, and
 * look at max and the over-250 ms counts, not at the idle baseline.
 */
export function openLoopDelay(hooks: LoopHooks = realHooks): LoopDelaySource | null {
  try {
    const h = hooks.monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS })
    h.enable()
    const excess = (ns: number): number => Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS)
    return {
      readAndReset: (): LoopDelayReading => {
        const count = h.count ?? 0
        const reading: LoopDelayReading = count > 0
          ? { count, p50: excess(h.percentile(50)), p99: excess(h.percentile(99)), max: excess(h.max) }
          : { count: 0, p50: 0, p99: 0, max: 0 }
        h.reset()
        return reading
      },
      stop: (): void => { h.disable() },
    }
  } catch {
    return null
  }
}

/** Absolute event-loop utilisation since start; the sampler differences two of them. */
export function openEluReader(hooks: EluHooks = realHooks): () => EluReading | null {
  return (): EluReading | null => {
    try {
      const e = hooks.performance.eventLoopUtilization()
      return { idle: e.idle, active: e.active }
    } catch {
      return null
    }
  }
}

/** A 'gc' PerformanceObserver. The kind sits on entry.detail; the old entry.kind accessor is deprecated. */
export function observeGc(cb: (kind: GcKind, ms: number) => void, hooks: GcHooks = realHooks): (() => void) | null {
  try {
    const c = hooks.constants
    const kindOf = (entry: GcEntryLike): GcKind => {
      const k = entry.detail !== undefined && entry.detail !== null ? entry.detail.kind : entry.kind
      if (k === c.NODE_PERFORMANCE_GC_MAJOR) return 'major'
      if (k === c.NODE_PERFORMANCE_GC_INCREMENTAL) return 'incremental'
      if (k === c.NODE_PERFORMANCE_GC_MINOR || k === c.NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP) return 'minor'
      return 'other'
    }
    const obs = new hooks.PerformanceObserver((list) => {
      for (const entry of list.getEntries()) cb(kindOf(entry), entry.duration)
    })
    obs.observe({ entryTypes: ['gc'] })
    return () => { obs.disconnect() }
  } catch {
    return null
  }
}

// The real timers are taken once, at load. A test that installs fake timers afterwards must not be
// able to turn this module's interval into a runaway: tests inject their own through TypingTraceDeps.
const nativeSetInterval = globalThis.setInterval.bind(globalThis)
const nativeClearInterval = globalThis.clearInterval.bind(globalThis)

const realNow = (): number => perfHooks.performance.now()

// ---------------------------------------------------------------------------------------------

interface Acc { n: number; sum: number; max: number }
interface IpcEntry { count: number; msSum: number; msMax: number; mCount: number; mSum: number; mMax: number }

const round1 = (x: number): number => Math.round(x * 10) / 10
const round2 = (x: number): number => Math.round(x * 100) / 100
const toMB = (bytes: number): number => Math.round(bytes / 1_048_576)
const newAcc = (): Acc => ({ n: 0, sum: 0, max: 0 })
const addAcc = (a: Acc, v: number): void => { a.n++; a.sum += v; if (v > a.max) a.max = v }
const viewAcc = (a: Acc): LatencyStat => ({ n: a.n, avg: a.n === 0 ? 0 : round1(a.sum / a.n), max: round1(a.max) })
const isOff = (v: string | undefined): boolean => typeof v === 'string' && ['0', 'off', 'false', 'no'].includes(v.trim().toLowerCase())
const safe = <T>(read: () => T, fallback: T): T => { try { return read() } catch { return fallback } }
const isThenable = (x: unknown): x is PromiseLike<unknown> =>
  x !== null && (typeof x === 'object' || typeof x === 'function') && typeof (x as { then?: unknown }).then === 'function'

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function createTypingTrace(deps: TypingTraceDeps = {}): TypingTrace {
  const enabled = !isOff((deps.env ?? process.env)[KILL_SWITCH_ENV])
  const now = deps.now ?? realNow
  const wallNow = deps.wallNow ?? ((): number => Date.now())
  const setIntervalFn = deps.setInterval ?? ((fn: () => void, ms: number): unknown => nativeSetInterval(fn, ms))
  const clearIntervalFn = deps.clearInterval ?? ((h: unknown): void => nativeClearInterval(h as ReturnType<typeof setInterval>))
  const openLoop = deps.openLoopDelay ?? ((): LoopDelaySource | null => openLoopDelay())
  const readEluFn = deps.readElu ?? openEluReader()
  const observeGcFn = deps.observeGc ?? ((cb: (kind: GcKind, ms: number) => void): (() => void) | null => observeGc(cb))
  const freememFn = deps.freemem ?? osFreemem
  const rssFn = deps.rss ?? ((): number => process.memoryUsage.rss())
  const heapFn = deps.heap ?? ((): { used: number; total: number; limit: number } => {
    const h = getHeapStatistics()
    return { used: h.used_heap_size, total: h.total_heap_size, limit: h.heap_size_limit }
  })
  const log = deps.log ?? ((line: string): void => { console.info(line) })

  let started = false
  let startedAt = 0
  let timer: unknown = null
  let tick = 0
  let loop: LoopDelaySource | null = null
  let stopGc: (() => void) | null = null
  let prevElu: EluReading | null = null
  let elu: number | null = null
  let memory: TypingTraceSnapshot['memory'] = null
  let lastWindow: LoopDelayReading | null = null
  const ring: LoopDelayReading[] = []
  let samplerTicks = 0
  let samplerSum = 0
  let samplerMax = 0
  let samplerMinuteMax = 0

  const gc = { majorCount: 0, majorMaxMs: 0, incrementalCount: 0, incrementalMaxMs: 0, minorCount: 0 }
  const gcMinute = { majorCount: 0, majorMaxMs: 0, incrementalCount: 0, incrementalMaxMs: 0, minorCount: 0 }
  const t1 = newAcc()
  const t1m = newAcc()
  const t2 = newAcc()
  const t2m = newAcc()
  let t2Expired = 0
  const pendingT2 = new Map<string, number>()
  const ipc = new Map<string, IpcEntry>()
  const sources = new Map<string, () => unknown>()

  // -- per-event hooks -------------------------------------------------------------------------

  function ipcEntry(wanted: string): IpcEntry {
    let name = wanted
    if (ipc.size >= MAX_NAMES && !ipc.has(name)) name = name.startsWith('mcp:') ? 'mcp:other' : 'other'
    let e = ipc.get(name)
    if (e === undefined) {
      e = { count: 0, msSum: 0, msMax: 0, mCount: 0, mSum: 0, mMax: 0 }
      ipc.set(name, e)
    }
    return e
  }

  function record(name: string, ms: number): void {
    const e = ipcEntry(name)
    e.count++
    e.msSum += ms
    if (ms > e.msMax) e.msMax = ms
    e.mCount++
    e.mSum += ms
    if (ms > e.mMax) e.mMax = ms
  }

  /** Time `run`, a sync call or one that returns a promise, and hand back exactly what it returned. */
  function timedCall<R>(name: string, run: () => R): R {
    const t0 = now()
    let out: R
    try {
      out = run()
    } catch (e) {
      try { record(name, now() - t0) } catch { /* tracing never changes what a call does */ }
      throw e
    }
    try {
      if (isThenable(out)) {
        const done = (): void => { try { record(name, now() - t0) } catch { /* see above */ } }
        out.then(done, done)
      } else {
        record(name, now() - t0)
      }
    } catch { /* see above */ }
    return out
  }

  function startT2(id: string, at: number): void {
    if (pendingT2.size >= MAX_PENDING_T2) pendingT2.clear()
    pendingT2.set(id, at)
  }

  function traceTerminalWrite<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    if (!enabled) return fn
    const call = fn as unknown as (...args: unknown[]) => unknown
    return ((...args: unknown[]): unknown => {
      const t0 = now()
      let id: string | null = null
      try {
        const p = args[1] as { id?: unknown; t?: unknown } | null | undefined
        if (p !== null && typeof p === 'object' && typeof p.t === 'number' && Number.isFinite(p.t)) {
          const d = wallNow() - p.t
          if (d >= -T1_SKEW_MS && d <= T1_MAX_MS) {
            addAcc(t1, Math.max(0, d))
            addAcc(t1m, Math.max(0, d))
            if (typeof p.id === 'string') id = p.id
          }
        }
      } catch { id = null }
      try {
        return call(...args)
      } finally {
        try {
          const done = now()
          record('terminal:write', done - t0)
          if (id !== null) startT2(id, done)
        } catch { /* a write is never held up by its own trace */ }
      }
    }) as unknown as (...args: A) => R
  }

  function noteTerminalOutput(id: string): void {
    if (pendingT2.size === 0) return // the hot path: output with no stamped key waiting leaves at once
    try {
      const t0 = pendingT2.get(id)
      if (t0 === undefined) return
      pendingT2.delete(id)
      const d = now() - t0
      if (d > T2_EXPIRE_MS) { t2Expired++; return }
      addAcc(t2, d)
      addAcc(t2m, d)
    } catch { /* output is never held up by its own trace */ }
  }

  function timedIpc<A extends unknown[], R>(name: string, fn: (...args: A) => R): (...args: A) => R {
    if (!enabled) return fn
    const call = fn as unknown as (...args: unknown[]) => unknown
    return ((...args: unknown[]): unknown => timedCall(name, () => call(...args))) as unknown as (...args: A) => R
  }

  function traceMcpTool<T>(name: string, run: () => Promise<T>): Promise<T> {
    if (!enabled) return run()
    return timedCall('mcp:' + (typeof name === 'string' && SAFE_NAME.test(name) ? name : 'other'), run)
  }

  function onGc(kind: GcKind, ms: number): void {
    for (const g of [gc, gcMinute]) {
      if (kind === 'major') { g.majorCount++; if (ms > g.majorMaxMs) g.majorMaxMs = ms }
      else if (kind === 'incremental') { g.incrementalCount++; if (ms > g.incrementalMaxMs) g.incrementalMaxMs = ms }
      else if (kind === 'minor') g.minorCount++
    }
  }

  // -- the 5 s tick ----------------------------------------------------------------------------

  function sampleWindow(): void {
    if (loop !== null) {
      try {
        const r = loop.readAndReset()
        lastWindow = r
        ring.push(r)
        if (ring.length > RING_WINDOWS) ring.shift()
      } catch { /* the window is skipped; the histogram stays as it was */ }
    }
    try {
      const cur = readEluFn()
      if (cur !== null) {
        if (prevElu !== null) {
          const active = cur.active - prevElu.active
          const total = active + (cur.idle - prevElu.idle)
          elu = total > 0 ? round2(active / total) : null
        }
        prevElu = cur
      }
    } catch { elu = null }
  }

  function sampleMemory(): void {
    const free = freememFn()
    const rss = rssFn()
    const h = heapFn()
    memory = { freeMB: toMB(free), rssMB: toMB(rss), heapUsedMB: toMB(h.used), heapTotalMB: toMB(h.total), heapLimitMB: toMB(h.limit) }
  }

  function minuteLoop(): NonNullable<TypingTraceSnapshot['loopDelay']['minute']> | null {
    if (ring.length === 0) return null
    return {
      windows: ring.length,
      p50Median: round1(median(ring.map((w) => w.p50))),
      p99Max: round1(Math.max(...ring.map((w) => w.p99))),
      max: round1(Math.max(...ring.map((w) => w.max))),
      over250: ring.filter((w) => w.max >= STALL_MS).length,
      over1000: ring.filter((w) => w.max >= LONG_STALL_MS).length,
    }
  }

  function minuteLine(): string | null {
    const loopAgg = minuteLoop()
    const writes = ipc.get('terminal:write')
    const typed = writes !== undefined && writes.mCount > 0
    const stalled = loopAgg !== null && loopAgg.max >= LOG_STALL_MS
    if (!typed && !stalled && gcMinute.majorCount === 0) return null // an idle minute stays out of the app log

    const parts: string[] = ['[typing-trace] 60s']
    if (loopAgg !== null) {
      parts.push(`loop p50med=${loopAgg.p50Median}ms p99max=${loopAgg.p99Max}ms max=${loopAgg.max}ms over250=${loopAgg.over250}`)
    }
    if (elu !== null) parts.push(`elu=${elu}`)
    parts.push(`| gc major=${gcMinute.majorCount}/${round1(gcMinute.majorMaxMs)}ms incr=${gcMinute.incrementalCount}/${round1(gcMinute.incrementalMaxMs)}ms minor=${gcMinute.minorCount}`)
    if (t1m.n > 0) parts.push(`| t1 n=${t1m.n} avg=${viewAcc(t1m).avg}ms max=${viewAcc(t1m).max}ms`)
    if (t2m.n > 0) parts.push(`| t2 n=${t2m.n} avg=${viewAcc(t2m).avg}ms max=${viewAcc(t2m).max}ms`)
    if (memory !== null) parts.push(`| mem free=${memory.freeMB}MB rss=${memory.rssMB}MB heap=${memory.heapUsedMB}/${memory.heapTotalMB}MB`)
    parts.push(`| sampler max=${round1(samplerMinuteMax)}ms`)
    const busiest = [...ipc.entries()]
      .filter(([, e]) => e.mCount > 0)
      .sort((a, b) => b[1].mSum - a[1].mSum || b[1].mCount - a[1].mCount)
      .slice(0, LOG_HANDLERS)
    if (busiest.length > 0) {
      parts.push('| ipc ' + busiest.map(([name, e]) => `${name} n=${e.mCount} sum=${round1(e.mSum)}ms max=${round1(e.mMax)}ms`).join('; '))
    }
    return parts.join(' ')
  }

  function resetMinute(): void {
    t1m.n = 0; t1m.sum = 0; t1m.max = 0
    t2m.n = 0; t2m.sum = 0; t2m.max = 0
    gcMinute.majorCount = 0; gcMinute.majorMaxMs = 0
    gcMinute.incrementalCount = 0; gcMinute.incrementalMaxMs = 0
    gcMinute.minorCount = 0
    samplerMinuteMax = 0
    for (const e of ipc.values()) { e.mCount = 0; e.mSum = 0; e.mMax = 0 }
  }

  function logMinute(): void {
    try {
      const line = minuteLine()
      if (line !== null) log(line)
    } finally {
      resetMinute()
    }
  }

  function onTick(): void {
    const t0 = safe(now, 0)
    tick++
    sampleWindow()
    if (tick % MEMORY_EVERY_TICKS === 0) { try { sampleMemory() } catch { /* the last sample stays */ } }
    if (tick % MINUTE_EVERY_TICKS === 0) { try { logMinute() } catch { /* the log sink is not ours to fix */ } }
    const cost = Math.max(0, safe(now, t0) - t0)
    samplerTicks++
    samplerSum += cost
    if (cost > samplerMax) samplerMax = cost
    if (cost > samplerMinuteMax) samplerMinuteMax = cost
  }

  // -- lifecycle -------------------------------------------------------------------------------

  function start(): void {
    if (!enabled || started) return
    started = true
    startedAt = safe(now, 0)
    tick = 0
    try { loop = openLoop() } catch { loop = null }
    try { stopGc = observeGcFn(onGc) } catch { stopGc = null }
    try { prevElu = readEluFn() } catch { prevElu = null }
    timer = setIntervalFn(onTick, WINDOW_MS)
    // Not the thing that keeps the process alive.
    try { (timer as { unref?: () => void } | null)?.unref?.() } catch { /* a fake timer handle */ }
  }

  function stop(): void {
    if (!started) return
    started = false
    if (timer !== null) { try { clearIntervalFn(timer) } catch { /* already gone */ } timer = null }
    try { loop?.stop() } catch { /* already stopped */ }
    loop = null
    try { stopGc?.() } catch { /* already disconnected */ }
    stopGc = null
  }

  function snapshot(): TypingTraceSnapshot {
    const ipcOut: Record<string, IpcStat> = {}
    for (const [name, e] of ipc) ipcOut[name] = { count: e.count, msSum: round1(e.msSum), msMax: round1(e.msMax) }
    const extra: Record<string, unknown> = {}
    for (const [name, read] of sources) {
      try { extra[name] = read() } catch { /* a broken source is left out, not the snapshot */ }
    }
    return {
      enabled,
      started,
      uptimeMs: started ? Math.max(0, Math.round(safe(now, startedAt) - startedAt)) : 0,
      loopDelay: {
        last: lastWindow === null ? null : { count: lastWindow.count, p50: round1(lastWindow.p50), p99: round1(lastWindow.p99), max: round1(lastWindow.max) },
        minute: minuteLoop(),
      },
      elu,
      sampler: { ticks: samplerTicks, msSum: round1(samplerSum), msMax: round1(samplerMax) },
      gc: { ...gc, majorMaxMs: round1(gc.majorMaxMs), incrementalMaxMs: round1(gc.incrementalMaxMs) },
      t1: viewAcc(t1),
      t2: { ...viewAcc(t2), expired: t2Expired },
      ipc: ipcOut,
      memory: memory === null ? null : { ...memory },
      extra,
    }
  }

  return {
    enabled,
    start,
    stop,
    traceTerminalWrite,
    noteTerminalOutput,
    timedIpc,
    traceMcpTool,
    registerSource: (name: string, read: () => unknown): void => { sources.set(name, read) },
    snapshot,
  }
}

// ---------------------------------------------------------------------------------------------
// The shared instance index.ts, mcpServer.ts and diagnostics.ts call.
// ---------------------------------------------------------------------------------------------

const shared = createTypingTrace()

export const startTypingTrace = (): void => shared.start()
export const stopTypingTrace = (): void => shared.stop()
export const traceTerminalWrite = <A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) => shared.traceTerminalWrite(fn)
export const noteTerminalOutput = (id: string): void => shared.noteTerminalOutput(id)
export const timedIpc = <A extends unknown[], R>(name: string, fn: (...args: A) => R): ((...args: A) => R) => shared.timedIpc(name, fn)
export const traceMcpTool = <T>(name: string, run: () => Promise<T>): Promise<T> => shared.traceMcpTool(name, run)
export const registerTypingTraceSource = (name: string, read: () => unknown): void => shared.registerSource(name, read)
export const getTypingTraceSnapshot = (): TypingTraceSnapshot => shared.snapshot()
