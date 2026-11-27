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
 * process or thread (`waited`), at most its wall, of which `gpu` on the GPU process. `matched` when the trace held the
 * span; one it did not is timed on the wall (`own` and `cpu` are its wall, and it waited on nothing).
 */
export type OwnTime = { wall: number; own: number; cpu: number; waited: number; gpu: number; matched: boolean; by?: string }
/** A span on the page's clock (ms). */
export type PageSpan = { start: number; ms: number }

/** Whether a trace event is a wait: one on the GPU process or a message (gpu, ipc), or a wait, sync call or blocking call by its name in any category. */
export const isWait = (e: TraceEvent): boolean => /(^|,)(gpu|ipc)(,|$)/.test(e.cat) || /Wait|Sync|Blocking/.test(e.name)
/** Whether a trace event is on the GPU process by its category (gpu): a GL call, a flush, a wait for the command buffer. */
export const isGpu = (e: TraceEvent): boolean => /(^|,)gpu(,|$)/.test(e.cat)

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

/** A wait cut to a span: its bounds there, and the least and the most of its thread time that can lie inside them. */
type Cut = { a: number; b: number; lo: number; hi: number }
/**
 * The pieces of the union of the cut waits, each with the least and the most thread time it can hold (at most its
 * length). From the earliest on, a wait that begins before the piece ends and runs past it adds the part past the end:
 * at most all of its thread time there (at most that part's length), at least what of it cannot lie in the part already
 * counted. A wait inside the piece (nested, or with its very bounds) adds nothing to it, but the thread time of the waits
 * inside (their own pieces, the same way) is in the piece too, so a piece holds at least as much as they do: an outer
 * wait the trace gives no thread time is no proof that the thread spent none in it.
 */
function pieces(cut: Cut[]): Cut[] {
  const out: Cut[] = []
  let piece: (Cut & { inner: Cut[] }) | undefined
  const close = (x: Cut & { inner: Cut[] }): void => {
    const sub = pieces(x.inner)
    const len = x.b - x.a
    const sum = (k: 'lo' | 'hi'): number => sub.reduce((t, y) => t + y[k], 0)
    out.push({ a: x.a, b: x.b, lo: Math.min(len, Math.max(x.lo, sum('lo'))), hi: Math.min(len, Math.max(x.hi, sum('hi'))) })
  }
  for (const c of [...cut].sort((p, q) => p.a - q.a || q.b - p.b)) {
    if (!piece || c.a >= piece.b) {
      if (piece) close(piece)
      piece = { ...c, inner: [] }
    } else if (c.b > piece.b) {
      piece.hi += Math.min(c.hi, c.b - piece.b)
      piece.lo += Math.max(0, c.lo - (piece.b - c.a))
      piece.b = c.b
    } else piece.inner.push(c)
  }
  if (piece) close(piece)
  return out
}

/**
 * The time the thread waited inside [s, e] (microseconds) in the waits of a list: the instants one or more of them
 * covers there, each once (the union of the waits, each cut to [s, e], so a wait that runs past either end counts only
 * inside, and one that overlaps another counts what the other does not cover), less the thread time in them. Where the
 * trace does not say where a wait's thread time lies (in the part of it cut off, or in the part another wait covers
 * too), `least` takes as much of it as can to lie in the waits and `most` as little: `least` for a wait excused (a fit's
 * waits on the GPU), `most` for one charged (the waits in a resize's or a task's own time), so neither is ever made out
 * kinder than the trace shows (look plan A2.1 note (10)). A wait with no thread time given has none of its own.
 */
export function waitedIn(xs: TraceEvent[], s: number, e: number, bound: 'least' | 'most'): number {
  const cut = xs.flatMap((x): Cut[] => {
    const a = Math.max(s, x.ts)
    const b = Math.min(e, end(x))
    const t = x.tdur ?? 0
    return b > a ? [{ a, b, lo: Math.max(0, t - ((x.dur as number) - (b - a))), hi: Math.min(t, b - a) }] : []
  })
  return pieces(cut).reduce((w, p) => w + (p.b - p.a) - (bound === 'least' ? p.hi : p.lo), 0)
}

/**
 * The page's own time in each named resize and each long task of a trace (look plan A2.1 note (10), PENDING SIGN-OFF):
 * the thread time of the work that holds it (the innermost JS call or task around a resize, less the work in it wholly
 * before or after the resize; the task around a long task), plus the waits inside it (isWait: each one's wall beyond its
 * thread time, waitedIn), at most its time on the wall. The page's clock is put on the trace's by the resizes the page
 * named (`measure`), which the trace holds too: the offset most of them agree on, each paired with the span of its
 * length there, on the thread whose spans the most agree with (an end is paired with a begin of its own process and id,
 * as each renderer numbers its own). A resize the trace dropped (the macOS runner's trace lost one or two of 40 in three drags of four, soak
 * 45933131129), and a task with no task around it there, is timed on the wall.
 */
export function ownTimes(events: TraceEvent[], named: PageSpan[], longTasks: PageSpan[], measure = RESIZE_MEASURE): { traced: number; spread: number; thread: string; resizes: OwnTime[]; tasks: OwnTime[] } {
  const key = (e: { pid: number; tid: number }): string => `${e.pid}:${e.tid}`
  const asyncId = (e: TraceEvent): string => e.id ?? e.id2?.local ?? e.id2?.global ?? ''
  const timing = events.filter((e) => e.name === measure && e.cat.includes('blink.user_timing'))
  const ends = timing.filter((e) => e.ph === 'e').sort((p, q) => p.ts - q.ts)
  const taken = new Set<TraceEvent>()
  // Each resize the trace named, from its start to its end: a begin with the end of its process and id, or one complete event.
  const spans = timing.filter((e) => e.ph === 'b' || (e.ph === 'X' && typeof e.dur === 'number')).sort((p, q) => p.ts - q.ts).flatMap((b) => {
    if (b.ph === 'X') return [{ key: key(b), s: b.ts, e: b.ts + (b.dur as number) }]
    const found = ends.find((x) => !taken.has(x) && x.pid === b.pid && asyncId(x) === asyncId(b) && x.ts >= b.ts)
    if (!found) return []
    taken.add(found)
    return [{ key: key(b), s: b.ts, e: found.ts }]
  })
  const names = new Map(events.filter((e) => e.ph === 'M' && e.name === 'thread_name').map((e) => [key(e), e.args?.name ?? ''] as const))
  const page = [...named].sort((p, q) => p.start - q.start)
  // The clocks are put together by the offset most resizes agree on, a resize and a span of its length (to 0.1 ms), on
  // the thread where the most agree: the page's (of threads as many agree on, the one that named a resize first).
  const alike = (m: { ms: number }, x: { s: number; e: number }): boolean => Math.abs((x.e - x.s) / 1000 - m.ms) < 0.1
  let main = spans[0]?.key ?? ''
  let best: number[] = []
  for (const k of new Set(spans.map((x) => x.key))) {
    const votes = new Map<number, number[]>()
    for (const m of page) for (const x of spans) if (x.key === k && alike(m, x)) {
      const o = x.s / 1000 - m.start
      const bin = Math.round(o * 10)
      votes.set(bin, [...(votes.get(bin) ?? []), o])
    }
    const top = [...votes.values()].sort((p, q) => q.length - p.length)[0] ?? []
    if (top.length > best.length) {
      best = top
      main = k
    }
  }
  const off = best.length ? [...best].sort((p, q) => p - q)[Math.floor(best.length / 2)] : NaN
  const used = new Set<{ s: number; e: number }>()
  const pairs = page.map((m) => {
    const x = Number.isFinite(off) ? spans.find((y) => y.key === main && !used.has(y) && alike(m, y) && Math.abs(y.s / 1000 - m.start - off) < 0.5) : undefined
    if (x) used.add(x)
    return x
  })
  const offs = page.flatMap((m, i) => (pairs[i] ? [(pairs[i] as { s: number }).s / 1000 - m.start] : [])).sort((p, q) => p - q)
  const spread = offs.length ? offs[offs.length - 1] - offs[0] : NaN
  const onMain = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number' && key(e) === main)
  // The thread's waits (waitedIn), and of them the GPU's.
  const waitsOn = onMain.filter(isWait)
  const gpuOn = onMain.filter(isGpu)
  // The thread time inside [s, e] of an event around it, at most: its own less that of the work in it wholly before s or
  // after e (the pieces of it that do not overlap, each one's thread time, so no time is taken off twice), so a resize
  // run inside a frame's task is not charged with the frame's other work. What is taken off lies outside [s, e] and
  // inside the event, each instant once: the resize is charged at least its own thread time. The event's own work outside
  // the resize in no event of its own stays charged (look plan A2.1 note (10)): own is at most the resize's wall, so that
  // can only fail a resize at least resizeOwn on the wall.
  const within = (around: TraceEvent, s: number, e: number): number => {
    const outside = onMain.filter((x) => x !== around && typeof x.tdur === 'number' && x.ts >= around.ts && end(x) <= end(around) && (end(x) <= s + SLACK || x.ts >= e - SLACK))
    return Math.max(0, (around.tdur as number) - disjoint(outside).reduce((t, x) => t + (x.tdur as number), 0))
  }
  const resizes = page.map((m, i): OwnTime => {
    const span = pairs[i]
    const around = span ? onMain.filter((x) => typeof x.tdur === 'number' && x.ts <= span.s + SLACK && end(x) >= span.e - SLACK).sort((p, q) => (p.dur as number) - (q.dur as number))[0] : undefined
    if (!span || !around) return { wall: m.ms, own: m.ms, cpu: m.ms, waited: 0, gpu: 0, matched: false }
    const waited = waitedIn(waitsOn, span.s, span.e, 'most') / 1000
    const cpu = within(around, span.s, span.e) / 1000
    return { wall: m.ms, own: Math.min(m.ms, cpu + waited), cpu, waited, gpu: waitedIn(gpuOn, span.s, span.e, 'least') / 1000, matched: true, by: `${around.name} ${((around.dur as number) / 1000).toFixed(1)}/${((around.tdur as number) / 1000).toFixed(1)}` }
  })
  const overlap = (x: TraceEvent, s: number, e: number): number => Math.max(0, Math.min(e, end(x)) - Math.max(s, x.ts))
  const tasks = longTasks.map((t): OwnTime => {
    const s = (t.start + off) * 1000
    const e = s + t.ms * 1000
    const run = Number.isFinite(off) ? onMain.filter((x) => /RunTask/.test(x.name) && typeof x.tdur === 'number' && overlap(x, s, e) > 0.5 * t.ms * 1000).sort((p, q) => overlap(q, s, e) - overlap(p, s, e) || (q.dur as number) - (p.dur as number))[0] : undefined
    if (!run) return { wall: t.ms, own: t.ms, cpu: t.ms, waited: 0, gpu: 0, matched: false }
    const waited = waitedIn(waitsOn, run.ts, end(run), 'most') / 1000
    const cpu = (run.tdur as number) / 1000
    return { wall: t.ms, own: Math.min(t.ms, cpu + waited), cpu, waited, gpu: waitedIn(gpuOn, run.ts, end(run), 'least') / 1000, matched: true }
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
 *   it runs), its waits left out; one the trace does not hold is charged its wall;
 * - fitWall: each such task on the wall beyond its waits on the GPU (in software its GL calls wait for the GPU
 *   process), so a wait on anything else (a sync call, a lock, an event) or one the trace does not name counts;
 * - fitCeiling: by OS (process.platform), each such task on the wall, its waits on the GPU too (the worst seen: 457 ms
 *   on Windows, 518 on ubuntu, 5204 on macOS, soak 45933131129); an OS it does not name gets the widest;
 * - tracedResizes: the share of the resizes the page named that the trace holds on the thread's clock, each in the work
 *   around it (a share, not ms; the macOS trace drops up to 4 of 39, and one it drops is timed on the wall);
 * - tracedFits: the share of the fits' tasks the trace must hold (a share; one it drops is charged its wall), less
 *   fitsDropped of them at most (a count), so one dropped of fewer than 10 fails no drag;
 * - gap: by OS (process.platform), the widest gap between two of the drag's pointer moves the page handled, or between
 *   the last and the pointer's release (the page answers none in it).
 */
export const DRAG_LIMITS: { resizeOwn: number; resizeWall: number; taskOwn: number; taskWall: number; fitCpu: number; fitWall: number; fitCeiling: Record<string, number>; tracedResizes: number; tracedFits: number; fitsDropped: number; gap: Record<string, number> } = {
  resizeOwn: 16, resizeWall: 50, taskOwn: 200, taskWall: 350, fitCpu: 200, fitWall: 1000, fitCeiling: { win32: 2000, darwin: 6000, linux: 2000 }, tracedResizes: 0.8, tracedFits: 0.9, fitsDropped: 1, gap: { win32: 5000, darwin: 7000, linux: 2000 },
}

/** What the drag check is handed: the trace, and what the page measured from the first move to DRAG_AFTER_MS after the mouse-up. */
export type DragInput = {
  events: TraceEvent[]
  /** The resizes the page named (RESIZE_MEASURE) in the frame-time window. */
  resizes: PageSpan[]
  /** The resizes the renderer timed in the same window (RendererPerf.resizeCount): each one it named, or failed to. */
  resizeCount: number
  /** The long tasks, `fit` for one that holds a fit's measure (BUFFER_FIT_MEASURE). */
  tasks: Array<PageSpan & { fit: boolean }>
  /** The fits named from the first move to DRAG_AFTER_MS after the mouse-up, the long tasks' window. */
  fitCount: number
  /** The widest gap between two pointer moves the page handled, or between the last and the pointer's release. */
  widestGap: number
  /** The OS the drag ran on (process.platform), for its gap limit; one DRAG_LIMITS does not name gets the widest. */
  platform: string
}
/**
 * The widest gap between two pointer moves the page handled, or between the last and the pointer's release (`upAt`),
 * on the page's clock (ms): 0 with no move.
 */
export function widestGap(moves: number[], upAt: number): number {
  return Math.max(0, ...[...moves.slice(1), ...(moves.length ? [upAt] : [])].map((m, i) => m - moves[i]))
}
/** The fits named (BUFFER_FIT_MEASURE spans, page clock) that end after `from` and begin before `until`: the long tasks' window. */
export function fitsNamed(fits: Array<{ start: number; end: number }>, from: number, until: number): number {
  return fits.filter((f) => f.end > from && f.start < until).length
}
/** One rule of the check: what it says, and what broke it (empty when it holds). */
export type DragCheck = { rule: string; fails: string[] }

/** The drag check's rules on a drag (DRAG_LIMITS), each with what broke it, and the times they were judged on. */
export function dragVerdict(input: DragInput, limits = DRAG_LIMITS): { checks: DragCheck[]; own: ReturnType<typeof ownTimes>; others: OwnTime[]; fits: OwnTime[] } {
  const own = ownTimes(input.events, input.resizes, input.tasks)
  const others = own.tasks.filter((_, i) => !input.tasks[i].fit)
  const fits = own.tasks.filter((_, i) => input.tasks[i].fit)
  const pair = (x: OwnTime, digits = 1): string => `${x.wall.toFixed(digits)}/${x.own.toFixed(digits)}`
  const share = (x: number): string => `${Math.round(x * 100)}%`
  const held = fits.filter((x) => x.matched).length
  const timed = own.resizes.filter((x) => x.matched).length
  const byOs = (x: Record<string, number>): number => x[input.platform] ?? Math.max(...Object.values(x))
  const gap = byOs(limits.gap)
  const ceiling = byOs(limits.fitCeiling)
  const fitsHeld = Math.min(Math.ceil(fits.length * limits.tracedFits), fits.length - limits.fitsDropped)
  const checks: DragCheck[] = [
    { rule: 'the drag resized the view, each resize named (named/timed)', fails: input.resizeCount > 0 && input.resizes.length === input.resizeCount ? [] : [`${input.resizes.length}/${input.resizeCount}`] },
    { rule: `the trace holds at least ${share(limits.tracedResizes)} of the resizes the page named on the thread's clock, each in the work around it (one it dropped is timed on the wall): timed/named`, fails: timed >= Math.ceil(input.resizes.length * limits.tracedResizes) ? [] : [`${timed}/${input.resizes.length}`] },
    { rule: `each resize takes under ${limits.resizeOwn} ms of its own (wall/own ms)`, fails: own.resizes.filter((x) => x.own >= limits.resizeOwn).map((x) => pair(x)) },
    { rule: `each resize takes under ${limits.resizeWall} ms on the wall, a wait the trace does not name (ms)`, fails: own.resizes.filter((x) => x.wall >= limits.resizeWall).map((x) => x.wall.toFixed(1)) },
    { rule: 'the buffer was fitted during or after the drag, its fit named', fails: input.fitCount > 0 ? [] : ['no fit'] },
    { rule: "a long task holds a fit named, so the fits are scored (fits' tasks/fits named)", fails: input.fitCount > 0 && fits.length === 0 ? [`0/${input.fitCount}`] : [] },
    { rule: `no task runs over ${limits.taskOwn} ms of its own, the fit's left out (wall/own ms)`, fails: others.filter((x) => x.own > limits.taskOwn).map((x) => pair(x, 0)) },
    { rule: `no task runs over ${limits.taskWall} ms on the wall, the fit's left out, a wait the trace does not name (ms)`, fails: others.filter((x) => x.wall > limits.taskWall).map((x) => x.wall.toFixed(0)) },
    { rule: `the trace holds at least ${share(limits.tracedFits)} of the fits' tasks, or all but ${limits.fitsDropped}: traced/fits`, fails: held >= fitsHeld ? [] : [`${held}/${fits.length}`] },
    { rule: `no fit's task runs over ${limits.fitCpu} ms of thread time, its waits left out, one the trace does not hold charged its wall (wall/thread ms)`, fails: fits.filter((x) => x.cpu > limits.fitCpu).map((x) => `${x.wall.toFixed(0)}/${x.cpu.toFixed(0)}${x.matched ? '' : ' (not traced)'}`) },
    { rule: `no fit's task runs over ${limits.fitWall} ms on the wall beyond its waits on the GPU, any other wait counted (wall/GPU-waited ms)`, fails: fits.filter((x) => x.wall - x.gpu > limits.fitWall).map((x) => `${x.wall.toFixed(0)}/${x.gpu.toFixed(0)}`) },
    { rule: `no fit's task runs over ${ceiling} ms on the wall on ${input.platform}, its waits on the GPU too (ms)`, fails: fits.filter((x) => x.wall > ceiling).map((x) => x.wall.toFixed(0)) },
    { rule: `the page handles the drag's pointer moves no more than ${gap} ms apart on ${input.platform}, the release too (ms)`, fails: input.widestGap > gap ? [input.widestGap.toFixed(0)] : [] },
  ]
  return { checks, own, others, fits }
}
