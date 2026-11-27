// The divider-drag check's clock (e2e/world-responsive.spec.ts, "dragging the pane divider with a line card open stays
// smooth"; look plan A2.1 note (10), PENDING SIGN-OFF). The page times its resizes (RESIZE_MEASURE) and its long tasks
// on the wall; a CDP trace of the drag holds the same work on the thread's clock. ownTimes puts the two together and
// gives each resize and each long task its own time: the thread time of the work that holds it plus its waits, so CPU
// the runner took from the page is not charged to it and a wait on another process is. dragVerdict holds every rule
// the check keeps, with the limits in DRAG_LIMITS, so the rules can be tried on made-up traces (tests/scripts/
// dragTrace.test.ts) as well as on the drag's.
import { RESIZE_MEASURE } from '../../src/renderer/src/world/engine/bufferFit'

/** A Chromium trace event, as Tracing.dataCollected hands it over (times in microseconds). */
export type TraceEvent = { name: string; ph: string; ts: number; dur?: number; tdur?: number; pid: number; tid: number; cat: string; id?: string; id2?: { local?: string; global?: string }; args?: { name?: string } }
/**
 * What the drag check traces: each task and JS call with its thread time, the page's measures, and what the thread
 * waits in: the GPU process (gpu), a message to another process (ipc, mojom), a lock or an event (base: WaitableEvent::Wait,
 * ScopedBlockingCall) or the compositor (cc).
 */
export const DRAG_TRACE = ['toplevel', 'devtools.timeline', 'blink.user_timing', 'gpu', 'ipc', 'mojom', 'base', 'cc']
/**
 * A span of the page's work, on the wall (`wall`) and its own (`own`): its thread time (`cpu`) and its waits on another
 * process or thread (`waited`), at most its wall. `matched` when the trace held the span; one it did not is timed on the
 * wall (`own` and `cpu` are its wall).
 */
export type OwnTime = { wall: number; own: number; cpu: number; waited: number; matched: boolean; by?: string }
/** A span on the page's clock (ms). */
export type PageSpan = { start: number; ms: number }

/** Whether a trace event is a wait: one on the GPU process or a message (gpu, ipc), or a wait, sync call or blocking call by its name in any category. */
export const isWait = (e: TraceEvent): boolean => /(^|,)(gpu|ipc)(,|$)/.test(e.cat) || /Wait|Sync|Blocking/.test(e.name)

/** Microseconds: the trace's clock and the page's round apart by this much. */
const SLACK = 50
const end = (e: TraceEvent): number => e.ts + (e.dur as number)

/**
 * The pieces of a list that do not overlap one another, the widest of any that do: from the earliest on, each piece is
 * taken unless it begins before the last one taken ends (a piece nested in it, or with its very bounds, is part of it).
 * Each instant of the thread is then counted once.
 */
export function disjoint(xs: TraceEvent[]): TraceEvent[] {
  const sorted = [...xs].sort((p, q) => p.ts - q.ts || (q.dur as number) - (p.dur as number))
  const out: TraceEvent[] = []
  let last = -Infinity
  for (const x of sorted) {
    if (x.ts < last) continue
    out.push(x)
    last = end(x)
  }
  return out
}

/**
 * The page's own time in each named resize and each long task of a trace (look plan A2.1 note (10), PENDING SIGN-OFF):
 * the thread time of the work that holds it (the innermost JS call or task around a resize, less the work in it wholly
 * before or after the resize; the task around a long task), plus the waits inside it (isWait: each one's wall beyond its
 * thread time), at most its time on the wall. The page's clock is put on the trace's by the resizes the page named
 * (`measure`), which the trace holds too: the offset most of them agree on, each paired with the span of its length
 * there. A resize the trace dropped (the macOS runner's trace lost one or two of 40 in three drags of four, soak
 * 45933131129), and a task with no task around it there, is timed on the wall.
 */
export function ownTimes(events: TraceEvent[], named: PageSpan[], longTasks: PageSpan[], measure = RESIZE_MEASURE): { traced: number; spread: number; thread: string; resizes: OwnTime[]; tasks: OwnTime[] } {
  const key = (e: { pid: number; tid: number }): string => `${e.pid}:${e.tid}`
  const asyncId = (e: TraceEvent): string => e.id ?? e.id2?.local ?? e.id2?.global ?? ''
  const timing = events.filter((e) => e.name === measure && e.cat.includes('blink.user_timing'))
  const ends = timing.filter((e) => e.ph === 'e').sort((p, q) => p.ts - q.ts)
  const taken = new Set<TraceEvent>()
  // Each resize the trace named, from its start to its end: a begin with its end, or one complete event.
  const spans = timing.filter((e) => e.ph === 'b' || (e.ph === 'X' && typeof e.dur === 'number')).sort((p, q) => p.ts - q.ts).flatMap((b) => {
    if (b.ph === 'X') return [{ key: key(b), s: b.ts, e: b.ts + (b.dur as number) }]
    const found = ends.find((x) => !taken.has(x) && asyncId(x) === asyncId(b) && x.ts >= b.ts)
    if (!found) return []
    taken.add(found)
    return [{ key: key(b), s: b.ts, e: found.ts }]
  })
  const main = spans[0]?.key ?? ''
  const names = new Map(events.filter((e) => e.ph === 'M' && e.name === 'thread_name').map((e) => [key(e), e.args?.name ?? ''] as const))
  const page = [...named].sort((p, q) => p.start - q.start)
  // The clocks are put together by the offset most resizes agree on, a resize and a span of its length (to 0.1 ms).
  const alike = (m: { ms: number }, x: { s: number; e: number }): boolean => Math.abs((x.e - x.s) / 1000 - m.ms) < 0.1
  const votes = new Map<number, number[]>()
  for (const m of page) for (const x of spans) if (alike(m, x)) {
    const o = x.s / 1000 - m.start
    const bin = Math.round(o * 10)
    votes.set(bin, [...(votes.get(bin) ?? []), o])
  }
  const best = [...votes.values()].sort((p, q) => q.length - p.length)[0] ?? []
  const off = best.length ? [...best].sort((p, q) => p - q)[Math.floor(best.length / 2)] : NaN
  const used = new Set<{ s: number; e: number }>()
  const pairs = page.map((m) => {
    const x = Number.isFinite(off) ? spans.find((y) => !used.has(y) && alike(m, y) && Math.abs(y.s / 1000 - m.start - off) < 0.5) : undefined
    if (x) used.add(x)
    return x
  })
  const offs = page.flatMap((m, i) => (pairs[i] ? [(pairs[i] as { s: number }).s / 1000 - m.start] : [])).sort((p, q) => p - q)
  const spread = offs.length ? offs[offs.length - 1] - offs[0] : NaN
  const onMain = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number' && key(e) === main)
  // The waits inside [s, e]: the waits there that do not overlap (disjoint), each one's wall beyond its thread time.
  const waits = (s: number, e: number): number => disjoint(onMain.filter((x) => isWait(x) && x.ts >= s - SLACK && end(x) <= e + SLACK))
    .reduce((t, x) => t + (x.dur as number) - Math.min(x.dur as number, x.tdur ?? 0), 0)
  // The thread time inside [s, e] of an event around it, at most: its own less that of the work in it wholly before s or
  // after e (the pieces of it that do not overlap, each one's thread time, so no time is taken off twice), so a resize
  // run inside a frame's task is not charged with the frame's other work. What is taken off lies outside [s, e] and
  // inside the event, each instant once: the resize is charged at least its own thread time.
  const within = (around: TraceEvent, s: number, e: number): number => {
    const outside = onMain.filter((x) => x !== around && typeof x.tdur === 'number' && x.ts >= around.ts && end(x) <= end(around) && (end(x) <= s + SLACK || x.ts >= e - SLACK))
    return Math.max(0, (around.tdur as number) - disjoint(outside).reduce((t, x) => t + (x.tdur as number), 0))
  }
  const resizes = page.map((m, i): OwnTime => {
    const span = pairs[i]
    const around = span ? onMain.filter((x) => typeof x.tdur === 'number' && x.ts <= span.s + SLACK && end(x) >= span.e - SLACK).sort((p, q) => (p.dur as number) - (q.dur as number))[0] : undefined
    if (!span || !around) return { wall: m.ms, own: m.ms, cpu: m.ms, waited: 0, matched: false }
    const waited = waits(span.s, span.e) / 1000
    const cpu = within(around, span.s, span.e) / 1000
    return { wall: m.ms, own: Math.min(m.ms, cpu + waited), cpu, waited, matched: true, by: `${around.name} ${((around.dur as number) / 1000).toFixed(1)}/${((around.tdur as number) / 1000).toFixed(1)}` }
  })
  const overlap = (x: TraceEvent, s: number, e: number): number => Math.max(0, Math.min(e, end(x)) - Math.max(s, x.ts))
  const tasks = longTasks.map((t): OwnTime => {
    const s = (t.start + off) * 1000
    const e = s + t.ms * 1000
    const run = Number.isFinite(off) ? onMain.filter((x) => /RunTask/.test(x.name) && typeof x.tdur === 'number' && overlap(x, s, e) > 0.5 * t.ms * 1000).sort((p, q) => overlap(q, s, e) - overlap(p, s, e) || (q.dur as number) - (p.dur as number))[0] : undefined
    if (!run) return { wall: t.ms, own: t.ms, cpu: t.ms, waited: 0, matched: false }
    const waited = waits(run.ts, end(run)) / 1000
    const cpu = (run.tdur as number) / 1000
    return { wall: t.ms, own: Math.min(t.ms, cpu + waited), cpu, waited, matched: true }
  })
  return { traced: offs.length, spread, thread: names.get(main) ?? main, resizes, tasks }
}

/**
 * The drag check's limits, in ms (look plan A2.1 note (10), PENDING SIGN-OFF, where each one's numbers are):
 * - resizeOwn: each resize's own time;
 * - resizeWall: each resize on the wall, for a wait the trace does not name;
 * - taskOwn: each long task's own time, the buffer's fit left out;
 * - taskWall: each long task on the wall, the fit left out, for a wait the trace does not name;
 * - fitCpu: the thread time of each task that holds a fit (the fit, the fence and the wake after it, and whatever else
 *   it runs), its waits on the GPU left out: in software its GL calls wait for the GPU process;
 * - fitWall: each such task on the wall beyond its waits, for a wait the trace does not name;
 * - gap: the widest gap between two of the drag's pointer moves the page handled (the page answers none in it).
 */
export const DRAG_LIMITS = { resizeOwn: 16, resizeWall: 100, taskOwn: 200, taskWall: 350, fitCpu: 200, fitWall: 1000, gap: 7000 }

/** What the drag check is handed: the trace, and what the page measured from the first move to DRAG_AFTER_MS after the mouse-up. */
export type DragInput = {
  events: TraceEvent[]
  /** The resizes the page named (RESIZE_MEASURE) in the frame-time window. */
  resizes: PageSpan[]
  /** The resizes the renderer timed in the same window (RendererPerf.resizeCount): each one it named, or failed to. */
  resizeCount: number
  /** The long tasks, `fit` for one that holds a fit's measure (BUFFER_FIT_MEASURE). */
  tasks: Array<PageSpan & { fit: boolean }>
  /** The fits named during or after the drag. */
  fitCount: number
  /** The widest gap between two pointer moves the page handled. */
  widestGap: number
}
/** One rule of the check: what it says, and what broke it (empty when it holds). */
export type DragCheck = { rule: string; fails: string[] }

/** The drag check's rules on a drag (DRAG_LIMITS), each with what broke it, and the times they were judged on. */
export function dragVerdict(input: DragInput, limits = DRAG_LIMITS): { checks: DragCheck[]; own: ReturnType<typeof ownTimes>; others: OwnTime[]; fits: OwnTime[] } {
  const own = ownTimes(input.events, input.resizes, input.tasks)
  const others = own.tasks.filter((_, i) => !input.tasks[i].fit)
  const fits = own.tasks.filter((_, i) => input.tasks[i].fit)
  const pair = (x: OwnTime, digits = 1): string => `${x.wall.toFixed(digits)}/${x.own.toFixed(digits)}`
  const checks: DragCheck[] = [
    { rule: 'the drag resized the view, each resize named (named/timed)', fails: input.resizeCount > 0 && input.resizes.length === input.resizeCount ? [] : [`${input.resizes.length}/${input.resizeCount}`] },
    { rule: 'the trace holds most of the resizes the page named (one it dropped is timed on the wall): traced/named', fails: own.traced >= Math.ceil(input.resizes.length / 2) ? [] : [`${own.traced}/${input.resizes.length}`] },
    { rule: `each resize takes under ${limits.resizeOwn} ms of its own (wall/own ms)`, fails: own.resizes.filter((x) => x.own >= limits.resizeOwn).map((x) => pair(x)) },
    { rule: `each resize takes under ${limits.resizeWall} ms on the wall, a wait the trace does not name (ms)`, fails: own.resizes.filter((x) => x.wall >= limits.resizeWall).map((x) => x.wall.toFixed(1)) },
    { rule: 'the buffer was fitted during or after the drag, its fit named', fails: input.fitCount > 0 ? [] : ['no fit'] },
    { rule: `no task runs over ${limits.taskOwn} ms of its own, the fit's left out (wall/own ms)`, fails: others.filter((x) => x.own > limits.taskOwn).map((x) => pair(x, 0)) },
    { rule: `no task runs over ${limits.taskWall} ms on the wall, the fit's left out, a wait the trace does not name (ms)`, fails: others.filter((x) => x.wall > limits.taskWall).map((x) => x.wall.toFixed(0)) },
    { rule: 'the trace holds most of the fits\' tasks: traced/fits', fails: fits.filter((x) => x.matched).length >= Math.ceil(fits.length / 2) ? [] : [`${fits.filter((x) => x.matched).length}/${fits.length}`] },
    { rule: `no fit's task runs over ${limits.fitCpu} ms of thread time, its waits on the GPU left out (wall/thread ms)`, fails: fits.filter((x) => x.matched && x.cpu > limits.fitCpu).map((x) => `${x.wall.toFixed(0)}/${x.cpu.toFixed(0)}`) },
    { rule: `no fit's task runs over ${limits.fitWall} ms on the wall beyond its waits, a wait the trace does not name (wall/waited ms)`, fails: fits.filter((x) => x.wall - x.waited > limits.fitWall).map((x) => `${x.wall.toFixed(0)}/${x.waited.toFixed(0)}`) },
    { rule: `the page handles the drag's pointer moves no more than ${limits.gap} ms apart (ms)`, fails: input.widestGap > limits.gap ? [input.widestGap.toFixed(0)] : [] },
  ]
  return { checks, own, others, fits }
}
