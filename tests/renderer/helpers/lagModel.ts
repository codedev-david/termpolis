// The lag, as a model (harness s1 of the analysis, in virtual time), shared by the scheduler test and the pane tests.
//
// 6 terminals on ONE thread that parses 6,000 chars per virtual ms, half of which something else uses (the
// renderer has more to do than parse); each agent prints `load` x its share of what is left; a key is typed
// into terminal 0 every 200 ms and its echo (one char) arrives 12 ms later. `ahead` is what the echo waits
// behind: chars terminal 0 was sent that its xterm has not parsed yet, the queue the scheduler holds included.
// No wall clock anywhere: every number is a count, or virtual ms.
import { vi } from 'vitest'
import { createWriteScheduler, type PaneWriter, type SchedulerLimits, type WriteScheduler } from '../../../src/renderer/src/lib/writeScheduler'
import { createOutputThrottle } from '../../../src/renderer/src/lib/outputThrottle'
import { VirtualLoop, ModelXterm } from './schedulerHarness'

export const CAPACITY = 6_000
export const STARVE = 0.5
export const T = 6
export const RUN_MS = 3_000

export interface LagResult {
  echoes: number
  visible: number
  ahead: number[]
  aheadMax: number
  latencyMax: number
  batch: number
  offered: number[]
  parsed: number[]
  queued: number[]
  held: number[]
  focusedMaxInflight: number
  background: number
  stats?: ReturnType<WriteScheduler['stats']>
}

export interface LagOptions {
  /** The shortest a setTimeout(fn, 0) waits (Chromium clamps nested timers to 4 ms). */
  minTimerMs?: number
  /** The first key is typed this many ms later than usual, so the keys fall elsewhere against the frames. */
  phaseMs?: number
  /** Keys are typed this far apart. */
  keyEveryMs?: number
  /** How long the run lasts, in virtual ms (default RUN_MS). A longer overload is a deeper backlog on a path that does not bound it. */
  runMs?: number
  /** Scheduler limits to try instead of the defaults. */
  limits?: Partial<SchedulerLimits>
  /** Called every 20 virtual ms with what is waiting where (for looking at a run, not for asserting). */
  onSample?: (s: { t: number; behind: number; queued: number; inflight: number; othersInflight: number; parsed: number; offered: number }) => void
}

export function runLagModel(variant: 'shipped' | 'scheduler', load: number, options: LagOptions = {}): LagResult {
  const { minTimerMs = 1, phaseMs = 0, keyEveryMs = 200, limits, onSample, runMs = RUN_MS } = options
  const loop = new VirtualLoop(minTimerMs)
  const xt = Array.from({ length: T }, () => new ModelXterm(loop, CAPACITY))
  const perMs = (load * CAPACITY * (1 - STARVE)) / T
  const batch = Math.max(1, Math.round(perMs * 8))
  const filler = 'x'.repeat(batch)
  const offered: number[] = Array(T).fill(0)
  const parsed: number[] = Array(T).fill(0)
  const markers: Array<{ target: number; t0: number }> = []
  const ahead: number[] = []
  const latency: number[] = []

  const onParsed = (i: number, n: number): void => {
    parsed[i] += n
    if (i !== 0) return
    while (markers.length > 0 && parsed[0] >= markers[0].target) latency.push(loop.now - markers.shift()!.t0)
  }

  let sink: (i: number, d: string) => void
  let queuedOf: (i: number) => number
  let typed: () => void
  let sch: WriteScheduler | undefined
  let writers: PaneWriter[] = []
  let throttles: Array<ReturnType<typeof createOutputThrottle>> = []
  if (variant === 'shipped') {
    vi.stubGlobal('requestAnimationFrame', loop.requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', loop.cancelAnimationFrame)
    vi.stubGlobal('setTimeout', loop.setTimeout)
    vi.stubGlobal('clearTimeout', loop.clearTimeout)
    throttles = xt.map((x, i) => createOutputThrottle((d) => x.write(d, () => onParsed(i, d.length))))
    sink = (i, d) => throttles[i](d)
    queuedOf = (i) => throttles[i].pending()
    typed = () => undefined
  } else {
    sch = createWriteScheduler({ clock: loop.clock(), limits })
    writers = xt.map((x, i) => sch!.attach(`t${i}`, {
      write: (d, ack) => x.write(d, () => { onParsed(i, d.length); ack() }),
      classify: () => (i === 0 ? 'focused' : i === 1 ? 'visible' : 'hidden'),
    }))
    sink = (i, d) => writers[i](d)
    queuedOf = (i) => writers[i].pending()
    typed = () => writers[0].typed('k')
  }

  try {
    // The agents print on their own clock, not the renderer's: a message that comes while the thread is busy
    // is delivered late, never dropped.
    for (let i = 0; i < T; i++) {
      let k = 0
      const fire = (): void => {
        offered[i] += batch
        sink(i, filler)
        k++
        loop.setTimeoutAt(fire, i + k * 8)
      }
      loop.setTimeoutAt(fire, i)
    }
    // Whatever else the thread is doing: 8 ms of every 16, on the clock rather than after the last run (the
    // CPU is taken from the thread whether or not it has a queue to get through, so it catches up when late).
    let rounds = 1
    const hog = (): void => {
      loop.busy(16 * STARVE)
      rounds++
      loop.setTimeoutAt(hog, 16 * rounds)
    }
    loop.setTimeoutAt(hog, 16)
    if (onSample) {
      let n = 1
      const sample = (): void => {
        onSample({
          t: loop.now, behind: offered[0] - parsed[0], queued: queuedOf(0), inflight: xt[0].pending,
          othersInflight: xt.slice(1).reduce((a, x) => a + x.pending, 0), parsed: parsed[0], offered: offered[0],
        })
        n++
        loop.setTimeoutAt(sample, 20 * n)
      }
      loop.setTimeoutAt(sample, 20)
    }
    // The user types every 200 ms; the echo comes back 12 ms later.
    for (let key = keyEveryMs + phaseMs; key < runMs - 188; key += keyEveryMs) {
      loop.setTimeout(() => { typed(); xt[0].handleUserInput() }, key)
      loop.setTimeout(() => {
        ahead.push(offered[0] - parsed[0])
        offered[0] += 1
        markers.push({ target: offered[0], t0: loop.now })
        sink(0, 'x')
      }, key + 12)
    }
    loop.runUntil(runMs)
  } finally {
    vi.unstubAllGlobals()
  }

  const res: LagResult = {
    echoes: ahead.length,
    visible: latency.length,
    ahead,
    aheadMax: Math.max(...ahead),
    latencyMax: Math.max(0, ...latency),
    batch,
    offered,
    parsed,
    queued: xt.map((x, i) => queuedOf(i) + x.pending),
    held: xt.map((_, i) => queuedOf(i)),
    focusedMaxInflight: sch?.stats().maxInflight.focused ?? 0,
    background: parsed.slice(1).reduce((a, b) => a + b, 0),
    stats: sch?.stats(),
  }
  sch?.dispose()
  return res
}
