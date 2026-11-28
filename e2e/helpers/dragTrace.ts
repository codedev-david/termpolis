// The divider-drag check's clock (e2e/world-responsive.spec.ts, "dragging the pane divider with a line card open stays
// smooth"; look plan A2.1 note (10), PENDING SIGN-OFF). The page times its resizes (RESIZE_MEASURE), its long tasks and
// its fits (BUFFER_FIT_MEASURE) on the wall, and records each into the trace under a name of its own (pageMeasure), so a
// CDP trace of the drag holds each span on the thread's clock beside the work that holds it. ownTimes finds each by its
// name and gives each resize, long task and fit its own time: the thread time of the work that holds it plus its waits,
// so CPU the runner took from the page is not charged to it and a wait on another process is. dragVerdict holds every
// rule the check keeps, with the limits in DRAG_LIMITS, so the rules can be tried on made-up traces (tests/scripts/
// dragTrace.test.ts) as well as on the drag's.
import { LOOK_CHECK_MEASURE } from '../../src/renderer/src/world/engine/bufferFit'

/** A Chromium trace event, as Tracing.dataCollected hands it over (times in microseconds). */
export type TraceEvent = { name: string; ph: string; ts: number; dur?: number; tdur?: number; tts?: number; pid: number; tid: number; cat: string; id?: string; id2?: { local?: string; global?: string }; args?: { name?: string } }
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
/**
 * Microseconds: how far a fit's measure may lie outside the task that holds it. The page's clock is coarsened (100 us
 * and a jitter, the page not being cross-origin isolated), and the measure is named from it: on the runners a fit's
 * measure began up to 0.17 ms before its task and ended up to 0.07 ms after it (diag 45983711383, 45983723838,
 * 45983738302), so SLACK left a fit in no task and charged it its long task's wall.
 */
const FIT_SLACK = 250
const end = (e: TraceEvent): number => e.ts + (e.dur as number)

/** A slice for heaviest: its bounds and its weight. */
export type Weighed = { a: number; b: number; w: number }
/**
 * The most weight a family of slices that do not overlap one another can hold (weighted interval scheduling): two that
 * share an instant are not both taken, two side by side (one ending where the other begins) are. 0 with none.
 */
export function heaviest(xs: Weighed[]): number {
  const sorted = [...xs].sort((p, q) => p.b - q.b)
  const best: number[] = []
  sorted.forEach((x, i) => {
    let j = i - 1
    while (j >= 0 && sorted[j].b > x.a) j--
    best.push(Math.max(i ? best[i - 1] : 0, x.w + (j >= 0 ? best[j] : 0)))
  })
  return best.length ? best[best.length - 1] : 0
}

/** A wait cut to a span: its bounds there, and the least of its thread time that must lie inside them. */
type Cut = { a: number; b: number; lo: number }
/**
 * The pieces of the union of the cut waits, each with the least thread time it must hold (at most its length). From
 * the earliest on, a wait that begins before the piece ends and runs past it adds the part past the end, with what of
 * its thread time cannot lie in the part already counted. A wait inside the piece (nested, or with its very bounds) adds
 * nothing to it, but the thread time of the waits inside (their own pieces, the same way) is in the piece too, so a
 * piece holds at least as much as they do.
 */
function pieces(cut: Cut[]): Cut[] {
  const out: Cut[] = []
  let piece: (Cut & { inner: Cut[] }) | undefined
  const close = (x: Cut & { inner: Cut[] }): void => {
    const inner = pieces(x.inner).reduce((t, y) => t + y.lo, 0)
    out.push({ a: x.a, b: x.b, lo: Math.min(x.b - x.a, Math.max(x.lo, inner)) })
  }
  for (const c of [...cut].sort((p, q) => p.a - q.a || q.b - p.b)) {
    if (!piece || c.a >= piece.b) {
      if (piece) close(piece)
      piece = { ...c, inner: [] }
    } else if (c.b > piece.b) {
      piece.lo += Math.max(0, c.lo - (piece.b - c.a))
      piece.b = c.b
    } else piece.inner.push(c)
  }
  if (piece) close(piece)
  return out
}

/** The instants of [s, e] a list of slices covers, each once: their union cut to [s, e], as pieces that do not overlap. */
function union(xs: TraceEvent[], s: number, e: number): Array<{ a: number; b: number }> {
  const out: Array<{ a: number; b: number }> = []
  for (const x of xs.map((y) => ({ a: Math.max(s, y.ts), b: Math.min(e, end(y)) })).filter((y) => y.b > y.a).sort((p, q) => p.a - q.a)) {
    const last = out[out.length - 1]
    if (last && x.a <= last.b) last.b = Math.max(last.b, x.b)
    else out.push(x)
  }
  return out
}
/** How much of a slice lies in pieces that do not overlap one another. */
const inside = (x: TraceEvent, u: Array<{ a: number; b: number }>): number => u.reduce((t, p) => t + Math.max(0, Math.min(p.b, end(x)) - Math.max(p.a, x.ts)), 0)

/**
 * The time the thread waited inside [s, e] (microseconds) in the waits of a list: the instants one or more of them
 * covers there, each once (their union U, each wait cut to [s, e], so a wait that runs past either end counts only
 * inside, and one that overlaps another counts what the other does not cover), less the thread time in U. `most`, for a
 * wait charged (the waits in a resize's or a task's own time), takes as little thread time to lie in U as the trace
 * allows; `least`, for a wait excused (a fit's waits on the GPU), as much as the trace allows, so neither is ever made
 * out kinder than the trace shows (look plan A2.1 note (10), PENDING SIGN-OFF).
 *
 * `most`: a wait with no thread time given has none of its own; of a wait's thread time, the part that cannot lie where
 * it was cut off or in the part of U already counted lies in its own part (pieces).
 *
 * `least`: U less the most thread time a family of timed slices that do not overlap can hold in it (heaviest), each of
 * the waits, of `known` (any slice of the thread, whatever its category) and of the window [s, e] itself, whose thread
 * time is `cpu` (the most the thread can have spent in it: the task or the call it is cut to), holding at most min(its
 * thread time, its part of U), so the family holds no more than U and nothing outside [s, e] is credited. It is a lower
 * bound of the wait in U whenever `cpu` is at least the thread time in [s, e]. The proof: every instant of thread time
 * in U lies in the window, which holds at most min(cpu, |U|) of it; alone it is a family, so the family taken holds at
 * least as much as the thread spent in U, and what is left of U is waiting. The window is always in the family, so no
 * caller can leave the slice around U out (look plan A2.1 note (10), Round 5). Of slices nested or overlapping only the
 * heaviest counts; of ones apart, each. So the thread time of a wait cannot count as waiting where the trace does not
 * say where it lies, nor can the thread time of a fit's own work inside a wait the trace gives none (Round 4).
 */
export function waitedIn(xs: TraceEvent[], s: number, e: number, bound: 'most'): number
export function waitedIn(xs: TraceEvent[], s: number, e: number, bound: 'least', cpu: number, known?: TraceEvent[]): number
export function waitedIn(xs: TraceEvent[], s: number, e: number, bound: 'least' | 'most', cpu = 0, known: TraceEvent[] = []): number {
  if (bound === 'least') {
    const u = union(xs, s, e)
    const window: TraceEvent = { name: '', cat: '', ph: 'X', ts: s, dur: e - s, tdur: cpu, pid: 0, tid: 0 }
    // A slice both a wait and known is taken once: two of the very bounds overlap, so the family holds one of them.
    const timed = [...xs, ...known, window].filter((x) => typeof x.tdur === 'number')
    const held = heaviest(timed.map((x) => ({ a: x.ts, b: end(x), w: Math.min(x.tdur as number, inside(x, u)) })))
    return u.reduce((t, p) => t + p.b - p.a, 0) - held
  }
  const cut = xs.flatMap((x): Cut[] => {
    const a = Math.max(s, x.ts)
    const b = Math.min(e, end(x))
    return b > a ? [{ a, b, lo: Math.max(0, (x.tdur ?? 0) - ((x.dur as number) - (b - a))) }] : []
  })
  return pieces(cut).reduce((w, p) => w + (p.b - p.a) - p.lo, 0)
}

/** A begin or an end the trace does not pair (paired): its kind, its name, its instant and its thread (pid:tid). */
export type Unpaired = { kind: 'mismatched' | 'lone' | 'unclosed'; name: string; ts: number; thread: string }
/**
 * The trace's events with each begin (B) and end (E) on a thread made one complete event (X) from the begin to the end:
 * an end closes the latest begin still open on its thread when it has the begin's name or none (an end of the JSON
 * trace format may leave its name out, and closes the latest begin on its thread: look plan A2.1 note (10), Round 6),
 * and its thread time is the end's thread clock less the begin's when both have one (tts). A wait the thread logs that way (a lock, an event) is
 * then a wait as any other. Where the trace leaves a pair in doubt, the wait runs to the edge that charges the page the
 * most, with no thread time given (`open`: charged as all waiting whatever its name, excused nothing), and is listed in
 * `unpaired` (look plan A2.1 note (10), Round 5):
 * - an end named, but not with the latest open begin's name (`mismatched`), or an end with no begin open (`lone`), runs
 *   from the trace's first instant to the end, and closes nothing;
 * - a begin the trace never ends (`unclosed`) runs to the trace's last instant.
 * `pairs` counts the pairs by thread (pid:tid) and name.
 */
export function paired(events: TraceEvent[]): { events: TraceEvent[]; open: Set<TraceEvent>; pairs: Map<string, Map<string, number>>; unpaired: Unpaired[] } {
  const last = events.reduce((t, e) => Math.max(t, e.ts + (e.dur ?? 0)), 0)
  const first = events.reduce((t, e) => (e.ph === 'M' ? t : Math.min(t, e.ts)), Infinity)
  const stacks = new Map<string, TraceEvent[]>()
  const pairs = new Map<string, Map<string, number>>()
  const open = new Set<TraceEvent>()
  const unpaired: Unpaired[] = []
  const out: TraceEvent[] = []
  const made = (b: TraceEvent, from: number, until: number, tdur: number | undefined): TraceEvent => ({ name: b.name, cat: b.cat, ph: 'X', ts: from, dur: until - from, ...(tdur === undefined ? {} : { tdur }), pid: b.pid, tid: b.tid })
  const doubt = (x: TraceEvent, kind: Unpaired['kind'], at: TraceEvent, thread: string): void => {
    open.add(x)
    out.push(x)
    unpaired.push({ kind, name: at.name, ts: at.ts, thread })
  }
  const order = events.map((e, i) => [e, i] as const).sort((p, q) => p[0].ts - q[0].ts || p[1] - q[1])
  for (const [e] of order) {
    if (e.ph !== 'B' && e.ph !== 'E') {
      out.push(e)
      continue
    }
    const k = `${e.pid}:${e.tid}`
    const stack = stacks.get(k) ?? []
    stacks.set(k, stack)
    if (e.ph === 'B') {
      stack.push(e)
      continue
    }
    const b = stack[stack.length - 1]
    if (!b || (e.name && b.name !== e.name)) {
      doubt(made(e, first, e.ts, undefined), b ? 'mismatched' : 'lone', e, k)
      continue
    }
    stack.pop()
    out.push(made(b, b.ts, e.ts, typeof b.tts === 'number' && typeof e.tts === 'number' ? e.tts - b.tts : undefined))
    const byName = pairs.get(k) ?? new Map<string, number>()
    pairs.set(k, byName)
    byName.set(b.name, (byName.get(b.name) ?? 0) + 1)
  }
  for (const [k, stack] of stacks) for (const b of stack) doubt(made(b, b.ts, last, undefined), 'unclosed', b, k)
  return { events: out, open, pairs, unpaired }
}

/**
 * The most thread time a set of tasks can hold in all (microseconds): of tasks nested in one another, the outer one's
 * or its inner ones' in all, whichever is more (the inner ones' thread time is the outer's, unless the trace's clocks
 * disagree); of tasks apart, or overlapping (which a thread's tasks do not), each. One with no thread time given is
 * charged its wall.
 */
export function heldAll(xs: TraceEvent[]): number {
  const stack: Array<{ x: TraceEvent; inner: number }> = []
  let total = 0
  const close = (): void => {
    const n = stack.pop() as { x: TraceEvent; inner: number }
    const v = Math.max(n.x.tdur ?? (n.x.dur as number), n.inner)
    if (stack.length) stack[stack.length - 1].inner += v
    else total += v
  }
  for (const x of [...xs].sort((p, q) => p.ts - q.ts || end(q) - end(p))) {
    while (stack.length && end(x) > end(stack[stack.length - 1].x)) close()
    stack.push({ x, inner: 0 })
  }
  while (stack.length) close()
  return total
}

/** The kinds of span the drag check's page records into the trace under names of their own (pageMeasure). */
export type PageKind = 'resize' | 'task' | 'fit'
/**
 * The name the drag's page records its `k`-th span of a kind under (performance.measure, from the span's start to its
 * end on the page's clock, before the trace ends): the resizes it named (RESIZE_MEASURE), its long tasks and the fits
 * it named (BUFFER_FIT_MEASURE), each in the order handed to ownTimes (look plan A2.1 note (10), Round 11). The browser
 * puts each on the trace's clock as it does every measure, so the check finds each span by its name there: no number
 * of the page's is put on the trace's clock, nor any span paired by its time.
 */
export const pageMeasure = (marker: string, kind: PageKind, k: number): string => `${marker}:${kind}:${k}`

/** A fit the page named: its measure in the trace, its own time in it, and its place (look plan A2.1 note (10), Round 11). */
export type FitTime = {
  /** The fit as the page measured it (ms, the page's clock). */
  start: number
  ms: number
  /** The fit's measure on the wall (ms; the page's when the trace does not place it). */
  wall: number
  /** The most thread time its measure can hold, the page clock's grain each side too (all of that window in its task when the trace gives no thread time). */
  cpu: number
  /** The least the thread waited on the GPU inside its measure. */
  gpu: number
  /**
   * Why the trace does not place it (each fails the drag, Round 11): 'dropped', the trace names no measure of it;
   * 'unmatched', it names one, but not once, on the page's thread inside the marker and of the page's length; 'straddles',
   * the measure lies in two tasks or more across the boundary between them, to the page clock's grain; 'untasked', in
   * no task the trace holds whole.
   */
  reason?: 'dropped' | 'unmatched' | 'straddles' | 'untasked'
}
/**
 * A task that holds fits (look plan A2.1 note (10), Round 11): its wall and its own time (the trace's task, and the long
 * task the page timed over it if any, whichever is more), how many fits it holds, their measured time taken off it (each
 * fit's wall less FIT_SLACK: an uncertain fit takes less off, never more), and what is left on the wall and of its own:
 * the task's work but the fits', held to a resize's limits (note (k)).
 */
export type FitTask = { wall: number; own: number; fits: number; off: number; restWall: number; restOwn: number }

/**
 * The page's own time in each resize and each long task of a trace, and each fit's (look plan A2.1 note (10), PENDING
 * SIGN-OFF): the thread time of the work that holds it (the innermost JS call or task around a resize, less what of its
 * thread time is shown to lie outside the resize; the task around a long task), plus the waits inside it (isWait: each
 * one's wall beyond its thread time, waitedIn), at most its time on the wall. The trace's begins and ends are made
 * complete events first (paired), `pairs` counts them on the page's thread by name, and `unpaired` lists those the trace
 * leaves in doubt there (at: ms after the marker's start).
 *
 * Each span is found in the trace by its own name (Round 11): the page records each resize, long task and fit it hands
 * in under pageMeasure's name, and the browser puts it on the trace's clock as it does every measure. No clock is put
 * together from the page's numbers and no span is paired by its time, so no pairing can be in doubt. A span counts as
 * traced when the trace names its measure once, on the page's thread inside the marker, of the page's length (to SLACK).
 * A resize or a long task the trace does not so hold (the macOS runner's trace once lost one or two resizes of 40, soak
 * 45933131129) is timed on the wall; a fit is not placed, which fails the drag (Round 11).
 *
 * The page's thread is the one that names the page's marker (look plan A2.1 note (10), Round 6): two measures named for
 * the drag alone, `${marker}:from` (from the instant the page names it to the same instant, before the drag's first move)
 * and `${marker}:to` (from that instant to the drag's end, DRAG_AFTER_MS after the mouse-up). Each must be in the trace
 * once, both on one thread and from the same instant (`marker.held`); else no thread is the page's, and every span is
 * timed on the wall (dragVerdict fails the drag). A measure is logged when the page names it, so the trace holding the
 * first proves the page's thread was traced from that instant on. Only work inside the marker counts as traced: a
 * resize, a long task's window or a fit's task the trace holds, the trace's tasks begun before it (their records may be
 * cut where the trace began) or ended after it (cut where it stopped) left out, and none of the trace leaves open.
 *
 * Where the trace leaves in doubt what work or wait a span holds, the page is charged the most it allows (look plan
 * A2.1 note (10), Round 5): a wait counts only inside the window scored (the page's task, the resize's call) as an
 * excuse, and the whole window counts when charged. The page's clock is coarsened (FIT_SLACK), so a measure may begin
 * that much after the work it names and end that much before it: a resize's thread time and waits are taken over its
 * measure widened by FIT_SLACK each side, and at most its wall and the grain (Round 11, Codex: a measure 0.2 ms late
 * scored a 16.1 ms resize 15.9).
 *
 * A fit (Round 11) belongs to the one task the trace holds whole that holds its measure whole, to the page clock's grain
 * (FIT_SLACK: every task that holds the measure to it may be the fit's, the true one always among them, and only when the
 * outermost of them are one is it the fit's). Of the task, only the fit's measured time is the fit's: `fits` gives each
 * fit's wall, thread time and GPU waits inside its measure (the fit's limits), and `fitTasks` each task that holds fits,
 * the fits' measured time less FIT_SLACK each taken off it, and what is left, held to a resize's limits (note (k)). A
 * long task is a fit's (`taskFit`) when its task holds one, and is judged by its remainder; `fitCpu` is the fits' thread
 * time in all, and `fitsTraced` counts the fits placed.
 */
export function ownTimes(raw: TraceEvent[], named: PageSpan[], longTasks: PageSpan[], fits: PageSpan[], marker: string): { traced: number; thread: string; marker: { held: boolean; from: number; to: number; threads: string[] }; resizes: OwnTime[]; tasks: OwnTime[]; taskFit: boolean[]; fits: FitTime[]; fitTasks: FitTask[]; recorded: Record<PageKind, number>; fitSkew: number; fitCpu: number; fitsTraced: number; looks: Array<{ own: number; wall: number }>; pairs: Record<string, number>; unpaired: Array<{ kind: Unpaired['kind']; name: string; at: number }> } {
  const { events, open, pairs: allPairs, unpaired } = paired(raw)
  const key = (e: { pid: number; tid: number }): string => `${e.pid}:${e.tid}`
  const asyncId = (e: TraceEvent): string => e.id ?? e.id2?.local ?? e.id2?.global ?? ''
  // Each span the trace named `measure`, from its start to its end: a begin with the end of its process and id, one
  // complete event, or one instant, as Chromium names a measure of no length (an async instant, `n`; 148 and Electron 43,
  // the Round 6 runs, where the marker's `:from` was never found).
  const spansOf = (measure: string): Array<{ key: string; s: number; e: number }> => {
    const timing = events.filter((e) => e.name === measure && e.cat.includes('blink.user_timing'))
    const ends = timing.filter((e) => e.ph === 'e').sort((p, q) => p.ts - q.ts)
    const taken = new Set<TraceEvent>()
    return timing.filter((e) => e.ph === 'b' || e.ph === 'n' || (e.ph === 'X' && typeof e.dur === 'number')).sort((p, q) => p.ts - q.ts).flatMap((b) => {
      if (b.ph === 'n') return [{ key: key(b), s: b.ts, e: b.ts }]
      if (b.ph === 'X') return [{ key: key(b), s: b.ts, e: b.ts + (b.dur as number) }]
      const found = ends.find((x) => !taken.has(x) && x.pid === b.pid && asyncId(x) === asyncId(b) && x.ts >= b.ts)
      if (!found) return []
      taken.add(found)
      return [{ key: key(b), s: b.ts, e: found.ts }]
    })
  }
  // The page's marker: its thread is the page's, and its span the part of the trace that counts.
  const marks = { from: spansOf(`${marker}:from`), to: spansOf(`${marker}:to`) }
  const markThreads = [...new Set([...marks.from, ...marks.to].map((x) => x.key))].sort()
  const mark = marks.from.length === 1 && marks.to.length === 1 && markThreads.length === 1 && Math.abs(marks.from[0].s - marks.to[0].s) <= SLACK ? marks.to[0] : undefined
  const main = mark?.key ?? ''
  const inMark = (s: number, e: number): boolean => !!mark && s >= mark.s && e <= mark.e
  const names = new Map(events.filter((e) => e.ph === 'M' && e.name === 'thread_name').map((e) => [key(e), e.args?.name ?? ''] as const))
  // Each span the page handed in, found by its own name (pageMeasure): its measure when the trace names it once, on the
  // page's thread inside the marker, of the page's length; else why not ('dropped': named nowhere; 'unmatched': named,
  // but not so).
  type Span = { key: string; s: number; e: number }
  const measured = (kind: PageKind, k: number, m: PageSpan): { span?: Span; why?: 'dropped' | 'unmatched' } => {
    const xs = spansOf(pageMeasure(marker, kind, k))
    if (!xs.length) return { why: 'dropped' }
    const x = xs[0]
    return xs.length === 1 && x.key === main && inMark(x.s, x.e) && Math.abs((x.e - x.s) / 1000 - m.ms) * 1000 <= SLACK ? { span: x } : { why: 'unmatched' }
  }
  const recorded = { resize: 0, task: 0, fit: 0 }
  const find = (kind: PageKind, xs: PageSpan[]): Array<{ span?: Span; why?: 'dropped' | 'unmatched' }> => xs.map((m, k) => {
    const found = measured(kind, k, m)
    if (found.span) recorded[kind]++
    return found
  })
  const onMain = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number' && key(e) === main)
  const timed = onMain.filter((x) => typeof x.tdur === 'number')
  // The thread's waits (waitedIn), a begin or an end the trace does not pair whatever its name, and of them the GPU's:
  // one the trace does not pair is no wait on the GPU.
  const waitsOn = onMain.filter((x) => isWait(x) || open.has(x))
  const gpuOn = onMain.filter((x) => isGpu(x) && !open.has(x))
  // The thread time inside [s, e] of an event around it, at most: its own less the most a family of slices in it that do
  // not overlap (itself among them) is shown to hold outside [s, e], each one's thread time less its part of [s, e]
  // (heaviest), plus the part of [s, e] outside the event, at most all thread time. What a slice of the family holds in
  // [s, e] is at most its part of it, so the rest of its thread time lies outside, and the slices do not overlap, so no
  // instant is counted twice: the charge is never less than the thread time in [s, e] (look plan A2.1 note (10), Round 4).
  const within = (around: TraceEvent, s: number, e: number): number => {
    const part = (x: TraceEvent): number => Math.max(0, Math.min(e, end(x)) - Math.max(s, x.ts))
    const family = timed.filter((x) => x.ts >= around.ts && end(x) <= end(around)).map((x) => ({ a: x.ts, b: end(x), w: Math.max(0, (x.tdur as number) - part(x)) }))
    return Math.max(0, (around.tdur as number) - heaviest(family)) + Math.max(0, around.ts - s) + Math.max(0, e - end(around))
  }
  const grain = FIT_SLACK / 1000
  // Each resize (Round 11): its measure, widened by the page clock's grain each side (the work it names may begin that
  // much before it and end that much after), in the innermost timed slice that holds the measure less the grain each side.
  const resizeSpans = find('resize', named)
  const resizes = named.map((m, i): OwnTime => {
    const span = resizeSpans[i].span
    const around = span ? timed.filter((x) => x.ts <= span.s + FIT_SLACK && end(x) >= span.e - FIT_SLACK).sort((p, q) => (p.dur as number) - (q.dur as number))[0] : undefined
    if (!span || !around) return { wall: m.ms, own: m.ms, cpu: m.ms, waited: 0, gpu: 0, matched: false }
    const [s, e] = [span.s - FIT_SLACK, span.e + FIT_SLACK]
    const waited = waitedIn(waitsOn, s, e, 'most') / 1000
    const cpu = within(around, s, e) / 1000
    const gpu = waitedIn(gpuOn, Math.max(span.s, around.ts), Math.min(span.e, end(around)), 'least', around.tdur as number, timed) / 1000
    return { wall: m.ms, own: Math.min(m.ms + grain, cpu + waited), cpu, waited, gpu, matched: true, by: `${around.name} ${((around.dur as number) / 1000).toFixed(1)}/${((around.tdur as number) / 1000).toFixed(1)}` }
  })
  const overlap = (x: TraceEvent, s: number, e: number): number => Math.max(0, Math.min(e, end(x)) - Math.max(s, x.ts))
  // The tasks the trace holds whole: inside the marker, and none it leaves open (Round 6; Opus m6-2: a task cut at the
  // trace's edge holds only its part inside the trace, so a fit in it would be charged that part alone).
  const runs = onMain.filter((x) => /RunTask/.test(x.name) && !open.has(x) && inMark(x.ts, end(x)))
  // Each long task's window, its measure on the trace's clock, and the task the trace holds over most of it (of two as
  // much, the longer), whether or not the trace gives its thread time; a long task the trace does not hold has none.
  const windows = find('task', longTasks).map((x) => x.span)
  const taskRuns = longTasks.map((t, i) => {
    const w = windows[i]
    return w ? runs.filter((x) => overlap(x, w.s, w.e) > 0.5 * t.ms * 1000).sort((p, q) => overlap(q, w.s, w.e) - overlap(p, w.s, w.e) || (q.dur as number) - (p.dur as number))[0] : undefined
  })
  // A long task's own time: its task's thread time, its waits inside the window, and the part of the window outside the
  // task whole; its waits on the GPU only inside both (look plan A2.1 note (10), Round 5: a wait is cut to the window
  // scored, and nothing outside it is credited). A task with no thread time given is timed on the wall.
  const tasks = longTasks.map((t, i): OwnTime => {
    const run = taskRuns[i]
    if (!run || typeof run.tdur !== 'number') return { wall: t.ms, own: t.ms, cpu: t.ms, waited: 0, gpu: 0, matched: false }
    const { s, e } = windows[i] as Span
    const [ws, we] = [Math.max(s, run.ts), Math.min(e, end(run))]
    const waited = waitedIn(waitsOn, ws, we, 'most') / 1000
    const cpu = ((run.tdur as number) + Math.max(0, run.ts - s) + Math.max(0, e - end(run))) / 1000
    const gpu = waitedIn(gpuOn, ws, we, 'least', run.tdur as number, timed) / 1000
    return { wall: t.ms, own: Math.min(t.ms, cpu + waited), cpu, waited, gpu, matched: true }
  })
  // Each fit's place (Round 11): the tasks that hold its measure to FIT_SLACK (`all`), and its task (`run`) when the
  // outermost of them are one (of two with the very same bounds, the first one the trace gives is the outer). A fit
  // belongs to no other task: no number of the page's is put on the trace's clock to find one.
  const fitSpans = find('fit', fits)
  const place = fits.map((m, j): { run?: TraceEvent; held?: TraceEvent[]; span?: Span; reason?: FitTime['reason'] } => {
    const { span: x, why } = fitSpans[j]
    if (!x) return { reason: why }
    const all = runs.filter((r) => r.ts <= x.s + FIT_SLACK && end(r) >= x.e - FIT_SLACK)
    const inside = (r: TraceEvent, o: TraceEvent): boolean => o.ts <= r.ts && end(o) >= end(r) && (o.ts < r.ts || end(o) > end(r) || all.indexOf(o) < all.indexOf(r))
    const outer = all.filter((r) => !all.some((o) => o !== r && inside(r, o)))
    return outer.length === 1 ? { run: outer[0], held: all, span: x } : { reason: all.length ? 'straddles' : 'untasked' }
  })
  // Each fit's own time (Round 11): only its measure is the fit's. Its thread time at most (within, over the measure
  // widened by the grain inside each task that holds it, the fit's work being in them, the most any gives: a task
  // inside another may show more than the outer one's clock allows; the whole of that window inside its task when the
  // trace gives its task no thread time) and its GPU waits at least, inside the measure and its task alone; one not
  // placed is the page's wall, and fails the drag.
  const fitTimes = fits.map((m, j): FitTime => {
    const { run, held, span: x, reason } = place[j]
    if (!run || !held || !x) return { start: m.start, ms: m.ms, wall: m.ms, cpu: m.ms, gpu: 0, reason }
    const wall = (x.e - x.s) / 1000
    if (typeof run.tdur !== 'number') return { start: m.start, ms: m.ms, wall, cpu: (Math.min(end(run), x.e + FIT_SLACK) - Math.max(run.ts, x.s - FIT_SLACK)) / 1000, gpu: 0 }
    const cpu = Math.max(...held.filter((r) => typeof r.tdur === 'number').map((r) => within(r, Math.max(r.ts, x.s - FIT_SLACK), Math.min(end(r), x.e + FIT_SLACK)))) / 1000
    const gpu = waitedIn(gpuOn, Math.max(x.s, run.ts), Math.min(x.e, end(run)), 'least', run.tdur as number, timed) / 1000
    return { start: m.start, ms: m.ms, wall, cpu, gpu }
  })
  // Each task that holds fits (Round 11, R11-2): its wall and own time, the trace's task's (its thread time and its
  // waits, at most its wall; its wall when the trace gives no thread time) or the long task's over it, whichever is
  // more, less each fit's measured wall less FIT_SLACK (the exemption is the fit's measured time alone, an uncertain
  // one taking less off), the rest held to a resize's limits.
  const fitRuns = [...new Set(place.flatMap((p) => (p.run ? [p.run] : [])))]
  const fitTasks = fitRuns.map((run): FitTask => {
    const wall0 = (run.dur as number) / 1000
    const own0 = typeof run.tdur === 'number' ? Math.min(wall0, ((run.tdur as number) + waitedIn(waitsOn, run.ts, end(run), 'most')) / 1000) : wall0
    const long = tasks.filter((_, i) => taskRuns[i] === run)
    const wall = Math.max(wall0, ...long.map((t) => t.wall))
    const own = Math.max(own0, ...long.map((t) => t.own))
    const mine = fitTimes.filter((_, j) => place[j].run === run)
    const off = mine.reduce((t, f) => t + Math.max(0, f.wall - grain), 0)
    return { wall, own, fits: mine.length, off, restWall: Math.max(0, wall - off), restOwn: Math.max(0, own - off) }
  })
  // Each long task a fit's or not: whether its task holds a fit (dragVerdict judges it by its remainder, fitTasks).
  const taskFit = taskRuns.map((r) => !!r && fitRuns.includes(r))
  // How far a fit's measure lies outside the nearest task the trace holds whole, the worst (ms; 0 with none, or no task):
  // the margin FIT_SLACK keeps, logged by the e2e (Round 7).
  const fitSkew = runs.length ? Math.max(0, ...fitSpans.flatMap(({ span: x }) => (x ? [Math.min(...runs.map((r) => Math.max(0, r.ts - x.s, x.e - end(r)))) / 1000] : []))) : 0
  const fitCpu = fitTimes.reduce((t, f) => t + f.cpu, 0)
  // Each look check after a settle (LOOK_CHECK_MEASURE) on the page's thread inside the marker, for the log alone (Round
  // 10, R10-6: a task like any other, judged by the ordinary limits): its wall, and the thread time of the tasks that
  // hold it to FIT_SLACK (NaN in none).
  const looks = spansOf(LOOK_CHECK_MEASURE).filter((x) => x.key === main && inMark(x.s, x.e)).map((x) => {
    const holding = runs.filter((r) => r.ts <= x.s + FIT_SLACK && end(r) >= x.e - FIT_SLACK)
    return { own: holding.length ? heldAll(holding) / 1000 : NaN, wall: (x.e - x.s) / 1000 }
  })
  const onPage = allPairs.get(main) ?? new Map<string, number>()
  return { traced: recorded.resize, thread: names.get(main) ?? main, marker: { held: !!mark, from: marks.from.length, to: marks.to.length, threads: markThreads.map((k) => names.get(k) || k) }, resizes, tasks, taskFit, fits: fitTimes, fitTasks, recorded, fitSkew, fitCpu, fitsTraced: fitTimes.filter((f) => !f.reason).length, looks, pairs: Object.fromEntries(onPage), unpaired: unpaired.filter((u) => u.thread === main).map((u) => ({ kind: u.kind, name: u.name, at: (u.ts - (mark as Span).s) / 1000 })) }
}

/**
 * The drag check's limits, in ms (look plan A2.1 note (10), PENDING SIGN-OFF, where each one's numbers are):
 * - resizeOwn: each resize's own time, and what is left of each task that holds fits, the fits' measured time off (note
 *   (k), Round 11);
 * - resizeWall: each resize on the wall, for a wait the trace does not name, and what is left of each fit's task on it;
 * - taskOwn: each long task's own time, the ones that hold a fit left out (they are held to resizeOwn, the fits off);
 * - taskWall: each such long task on the wall, for a wait the trace does not name;
 * - fitCpu: each fit's thread time, inside its measure (the buffer fitted), its waits left out;
 * - fitWall: each fit's measure on the wall beyond its waits on the GPU (in software its GL calls wait for the GPU
 *   process), so a wait on anything else (a sync call, a lock, an event) or one the trace does not name counts;
 * - fitCeiling: by OS (process.platform), each fit's measure on the wall, its waits on the GPU too (the worst seen of the
 *   fits' tasks: 457 ms on Windows, 518 on ubuntu, 5204 on macOS, soak 45933131129; macOS's about 1.5 times its worst);
 *   an OS it does not name gets the widest;
 * - fitCpuTotal: the fits' thread time in all (ownTimes' fitCpu), so fits too short to be long tasks are held too (the
 *   worst seen of their tasks: 41 ms on Windows, 31 on ubuntu, 82 on macOS, 72 drags, diag 45985754504, 45985767956,
 *   45985786689; about 2.5 times the worst);
 * - tracedResizes: the share of the resizes the page named that the trace holds on the thread's clock, each in the work
 *   around it (a share, not ms; the macOS trace once dropped up to 4 of 39, and one it drops is timed on the wall);
 * - gap: by OS (process.platform), the widest gap between two of the drag's pointer moves the page handled, or between
 *   the last and the pointer's release (the page answers none in it).
 * A fit the trace does not place fails the drag whatever its numbers (Round 11, R11-3).
 */
export const DRAG_LIMITS: { resizeOwn: number; resizeWall: number; taskOwn: number; taskWall: number; fitCpu: number; fitWall: number; fitCeiling: Record<string, number>; fitCpuTotal: number; tracedResizes: number; gap: Record<string, number> } = {
  resizeOwn: 16, resizeWall: 50, taskOwn: 200, taskWall: 350, fitCpu: 200, fitWall: 1000, fitCeiling: { win32: 2000, darwin: 8000, linux: 2000 }, fitCpuTotal: 200, tracedResizes: 0.8, gap: { win32: 5000, darwin: 7000, linux: 2000 },
}

/** What the drag check is handed: the trace, and what the page measured from the first move to DRAG_AFTER_MS after the mouse-up. */
export type DragInput = {
  events: TraceEvent[]
  /** The resizes the page named (RESIZE_MEASURE) in the frame-time window, each recorded into the trace (pageMeasure). */
  resizes: PageSpan[]
  /** The resizes the renderer timed in the same window (RendererPerf.resizeCount): each one it named, or failed to. */
  resizeCount: number
  /** The long tasks, `fit` for one that holds a fit's measure (BUFFER_FIT_MEASURE) as the page tags it, each recorded into the trace. */
  tasks: Array<PageSpan & { fit: boolean }>
  /** The fits named (BUFFER_FIT_MEASURE) from the first move to DRAG_AFTER_MS after the mouse-up, each recorded into the trace. */
  fits: PageSpan[]
  /** The widest gap between two pointer moves the page handled, or between the last and the pointer's release. */
  widestGap: number
  /** The OS the drag ran on (process.platform), for its gap limit; one DRAG_LIMITS does not name gets the widest. */
  platform: string
  /** The page's marker for this drag (ownTimes): the name its `:from` and `:to` measures and its spans' (pageMeasure) begin with, the drag's alone. */
  marker: string
  /** Whether the trace says it lost events (Tracing.tracingComplete's dataLossOccurred): then nothing it holds is sure. */
  dataLoss: boolean
}
/**
 * The widest gap between two pointer moves the page handled, or between the last and the pointer's release (`upAt`),
 * on the page's clock (ms): 0 with no move.
 */
export function widestGap(moves: number[], upAt: number): number {
  return Math.max(0, ...[...moves.slice(1), ...(moves.length ? [upAt] : [])].map((m, i) => m - moves[i]))
}
/** The fits named (BUFFER_FIT_MEASURE spans, page clock) that end after `from` and begin before `until`: the long tasks' window. */
export function fitsNamed(fits: Array<{ start: number; end: number }>, from: number, until: number): PageSpan[] {
  return fits.filter((f) => f.end > from && f.start < until).map((f) => ({ start: f.start, ms: f.end - f.start }))
}
/** One rule of the check: what it says, and what broke it (empty when it holds). */
export type DragCheck = { rule: string; fails: string[] }

/**
 * The drag check's rules on a drag (DRAG_LIMITS), each with what broke it, and the times they were judged on. A wall the
 * page's clock measured (a resize's, a long task's, a fit's measure) is judged at its most, the grain (FIT_SLACK) on:
 * an uncertain number counts against passing (Round 11).
 */
export function dragVerdict(input: DragInput, limits = DRAG_LIMITS): { checks: DragCheck[]; own: ReturnType<typeof ownTimes>; others: OwnTime[]; fits: OwnTime[]; retagged: Array<{ start: number; ms: number; page: boolean }> } {
  const own = ownTimes(input.events, input.resizes, input.tasks, input.fits, input.marker)
  const fitCount = input.fits.length
  const grain = FIT_SLACK / 1000
  // Each long task judged as ownTimes tags it (Round 7: the trace's say where it holds the task), not by the page's tag;
  // the ones the two disagree on, logged by the e2e.
  const others = own.tasks.filter((_, i) => !own.taskFit[i])
  const fits = own.tasks.filter((_, i) => own.taskFit[i])
  const retagged = input.tasks.flatMap((t, i) => (t.fit === own.taskFit[i] ? [] : [{ start: t.start, ms: t.ms, page: t.fit }]))
  const pair = (x: OwnTime, digits = 1): string => `${x.wall.toFixed(digits)}/${x.own.toFixed(digits)}`
  const share = (x: number): string => `${Math.round(x * 100)}%`
  const timed = own.resizes.filter((x) => x.matched).length
  const byOs = (x: Record<string, number>): number => x[input.platform] ?? Math.max(...Object.values(x))
  const gap = byOs(limits.gap)
  const ceiling = byOs(limits.fitCeiling)
  const placed = own.fits.filter((f) => !f.reason)
  const rest = (t: FitTask): string => `${t.wall.toFixed(1)}/${t.own.toFixed(1)} less ${t.off.toFixed(1)} of ${t.fits} fit${t.fits === 1 ? '' : 's'}`
  const checks: DragCheck[] = [
    { rule: "the trace lost no events (Tracing.tracingComplete's dataLossOccurred)", fails: input.dataLoss ? ['events lost'] : [] },
    { rule: "the trace holds the page's marker once, on one thread, from one instant (its from/to measures on threads)", fails: own.marker.held ? [] : [`${own.marker.from}/${own.marker.to} on ${own.marker.threads.join(', ') || 'none'}`] },
    { rule: 'the drag resized the view, each resize named (named/timed)', fails: input.resizeCount > 0 && input.resizes.length === input.resizeCount ? [] : [`${input.resizes.length}/${input.resizeCount}`] },
    { rule: `the trace holds at least ${share(limits.tracedResizes)} of the resizes the page named on the thread's clock, each in the work around it (one it dropped is timed on the wall): timed/named`, fails: timed >= Math.ceil(input.resizes.length * limits.tracedResizes) ? [] : [`${timed}/${input.resizes.length}`] },
    { rule: `each resize takes under ${limits.resizeOwn} ms of its own (wall/own ms)`, fails: own.resizes.filter((x) => x.own >= limits.resizeOwn).map((x) => pair(x)) },
    { rule: `each resize, the page clock's grain on, takes under ${limits.resizeWall} ms on the wall, a wait the trace does not name (ms)`, fails: own.resizes.filter((x) => x.wall + grain >= limits.resizeWall).map((x) => x.wall.toFixed(1)) },
    { rule: 'the buffer was fitted during or after the drag, its fit named', fails: fitCount > 0 ? [] : ['no fit'] },
    { rule: "the trace places every fit the page named: its measure once, on the page's thread inside the marker, of the page's length, in one task it holds whole (start+ms: why not)", fails: own.fits.filter((f) => f.reason).map((f) => `${f.start.toFixed(2)}+${f.ms.toFixed(2)} ms: ${f.reason as string}`) },
    { rule: `no task runs over ${limits.taskOwn} ms of its own, the fit's left out (wall/own ms)`, fails: others.filter((x) => x.own > limits.taskOwn).map((x) => pair(x, 0)) },
    { rule: `no task, the page clock's grain on, runs over ${limits.taskWall} ms on the wall, the fit's left out, a wait the trace does not name (ms)`, fails: others.filter((x) => x.wall + grain > limits.taskWall).map((x) => x.wall.toFixed(0)) },
    { rule: `each task that holds fits, the fits' measured time off (less the page clock's grain each), takes under ${limits.resizeOwn} ms of its own (wall/own ms less the fits')`, fails: own.fitTasks.filter((t) => t.restOwn >= limits.resizeOwn).map(rest) },
    { rule: `each task that holds fits, the fits' measured time off (less the page clock's grain each), takes under ${limits.resizeWall} ms on the wall (wall/own ms less the fits')`, fails: own.fitTasks.filter((t) => t.restWall >= limits.resizeWall).map(rest) },
    { rule: `no fit takes over ${limits.fitCpu} ms of thread time in its measure, its waits left out (wall/thread ms)`, fails: placed.filter((f) => f.cpu > limits.fitCpu).map((f) => `${f.wall.toFixed(0)}/${f.cpu.toFixed(0)}`) },
    { rule: `no fit's measure runs over ${limits.fitWall} ms on the wall beyond its waits on the GPU, the page clock's grain on, any other wait counted (wall/GPU-waited ms)`, fails: placed.filter((f) => f.wall + grain - f.gpu > limits.fitWall).map((f) => `${f.wall.toFixed(0)}/${f.gpu.toFixed(0)}`) },
    { rule: `no fit's measure runs over ${ceiling} ms on the wall on ${input.platform}, the page clock's grain on, its waits on the GPU too (ms)`, fails: placed.filter((f) => f.wall + grain > ceiling).map((f) => f.wall.toFixed(0)) },
    { rule: `the drag's fits take no more than ${limits.fitCpuTotal} ms of the thread in all, each in its measure, one not placed its wall (ms, fits placed/named)`, fails: own.fitCpu > limits.fitCpuTotal ? [`${own.fitCpu.toFixed(0)} (${own.fitsTraced}/${fitCount})`] : [] },
    { rule: `the page handles the drag's pointer moves no more than ${gap} ms apart on ${input.platform}, the release too (ms)`, fails: input.widestGap > gap ? [input.widestGap.toFixed(0)] : [] },
  ]
  return { checks, own, others, fits, retagged }
}
