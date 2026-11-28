// The divider-drag check's clock (e2e/world-responsive.spec.ts, "dragging the pane divider with a line card open stays
// smooth"; look plan A2.1 note (10), PENDING SIGN-OFF). The page times its resizes (RESIZE_MEASURE) and its long tasks
// on the wall; a CDP trace of the drag holds the same work on the thread's clock. ownTimes puts the two together and
// gives each resize and each long task its own time: the thread time of the work that holds it plus its waits, so CPU
// the runner took from the page is not charged to it and a wait on another process is. dragVerdict holds every rule
// the check keeps, with the limits in DRAG_LIMITS, so the rules can be tried on made-up traces (tests/scripts/
// dragTrace.test.ts) as well as on the drag's.
import { BUFFER_FIT_MEASURE, RESIZE_MEASURE } from '../../src/renderer/src/world/engine/bufferFit'

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

/**
 * The page's own time in each named resize and each long task of a trace (look plan A2.1 note (10), PENDING SIGN-OFF):
 * the thread time of the work that holds it (the innermost JS call or task around a resize, less what of its thread time
 * is shown to lie outside the resize; the task around a long task), plus the waits inside it (isWait: each one's wall
 * beyond its thread time, waitedIn), at most its time on the wall. The page's clock is put on the trace's by the resizes
 * the page named (RESIZE_MEASURE), which the trace holds too: the offset most of them agree on, each paired with the span
 * of its length there (an end is paired with a begin of its own process and id, as each renderer numbers its own). A
 * resize the trace dropped (the macOS runner's trace lost one or two of 40 in three drags of four, soak 45933131129), and
 * a task with no task around it there, is timed on the wall. The trace's begins and ends are made complete events first
 * (paired), `pairs` counts them on the page's thread by name, and `unpaired` lists those the trace leaves in doubt there
 * (at: the page's clock, ms).
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
 * excuse, and the whole window counts when charged.
 *
 * The fits the page named (`fits`, BUFFER_FIT_MEASURE) are put on the thread's clock the same way, each in every task
 * around it: `fitCpu` is the thread time of those tasks (each once, heldAll, the fit's fence and wake and whatever else
 * the task runs too), and of the fits in one long task at least that long task's thread time as `tasks` gives it (each
 * long task once; Round 6: the trace may hold only a task inside it); a fit the trace does not hold is charged so too
 * (in a long task the trace does not hold, its wall) or, in none, 50 ms (a task as long would be a long task);
 * `fitsTraced` counts the fits in a task.
 */
export function ownTimes(raw: TraceEvent[], named: PageSpan[], longTasks: PageSpan[], fits: PageSpan[], marker: string): { traced: number; spread: number; thread: string; marker: { held: boolean; from: number; to: number; threads: string[] }; resizes: OwnTime[]; tasks: OwnTime[]; taskFit: boolean[]; fitSkew: number; fitCpu: number; fitsTraced: number; pairs: Record<string, number>; unpaired: Array<{ kind: Unpaired['kind']; name: string; at: number }> } {
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
  const spans = spansOf(RESIZE_MEASURE).filter((x) => x.key === main)
  const names = new Map(events.filter((e) => e.ph === 'M' && e.name === 'thread_name').map((e) => [key(e), e.args?.name ?? ''] as const))
  const page = [...named].sort((p, q) => p.start - q.start)
  // The clocks are put together by the offset most resizes agree on, a resize and a span of its length (to 0.1 ms) on
  // the page's thread.
  const alike = (m: { ms: number }, x: { s: number; e: number }): boolean => Math.abs((x.e - x.s) / 1000 - m.ms) < 0.1
  const votes = new Map<number, number[]>()
  for (const m of page) for (const x of spans) if (alike(m, x)) {
    const o = x.s / 1000 - m.start
    const bin = Math.round(o * 10)
    votes.set(bin, [...(votes.get(bin) ?? []), o])
  }
  const best = [...votes.values()].sort((p, q) => q.length - p.length)[0] ?? []
  const off = best.length ? [...best].sort((p, q) => p - q)[Math.floor(best.length / 2)] : NaN
  // Each span of the page's paired with one of the trace's on the page's thread: its length, at the offset (to 0.5 ms).
  const pairUp = (xs: PageSpan[], found: Array<{ key: string; s: number; e: number }>): Array<{ s: number; e: number } | undefined> => {
    const used = new Set<{ s: number; e: number }>()
    return xs.map((m) => {
      const x = Number.isFinite(off) ? found.find((y) => !used.has(y) && alike(m, y) && Math.abs(y.s / 1000 - m.start - off) < 0.5) : undefined
      if (x) used.add(x)
      return x
    })
  }
  const pairs = pairUp(page, spans)
  const offs = page.flatMap((m, i) => (pairs[i] ? [(pairs[i] as { s: number }).s / 1000 - m.start] : [])).sort((p, q) => p - q)
  const spread = offs.length ? offs[offs.length - 1] - offs[0] : NaN
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
  const resizes = page.map((m, i): OwnTime => {
    const span = pairs[i]
    const around = span ? timed.filter((x) => x.ts <= span.s + SLACK && end(x) >= span.e - SLACK).sort((p, q) => (p.dur as number) - (q.dur as number))[0] : undefined
    if (!span || !around || !inMark(span.s, span.e)) return { wall: m.ms, own: m.ms, cpu: m.ms, waited: 0, gpu: 0, matched: false }
    const waited = waitedIn(waitsOn, span.s, span.e, 'most') / 1000
    const cpu = within(around, span.s, span.e) / 1000
    const gpu = waitedIn(gpuOn, Math.max(span.s, around.ts), Math.min(span.e, end(around)), 'least', around.tdur as number, timed) / 1000
    return { wall: m.ms, own: Math.min(m.ms, cpu + waited), cpu, waited, gpu, matched: true, by: `${around.name} ${((around.dur as number) / 1000).toFixed(1)}/${((around.tdur as number) / 1000).toFixed(1)}` }
  })
  const overlap = (x: TraceEvent, s: number, e: number): number => Math.max(0, Math.min(e, end(x)) - Math.max(s, x.ts))
  // The tasks the trace holds whole: inside the marker, and none it leaves open (Round 6; Opus m6-2: a task cut at the
  // trace's edge holds only its part inside the trace, so a fit in it would be charged that part alone).
  const runs = onMain.filter((x) => /RunTask/.test(x.name) && !open.has(x) && inMark(x.ts, end(x)))
  // Each long task's window on the thread's clock, and the task the trace holds over most of it (of two as much, the
  // longer), whether or not the trace gives its thread time; a window not inside the marker has none.
  const windows = longTasks.map((t) => ({ s: (t.start + off) * 1000, e: (t.start + off + t.ms) * 1000 }))
  const taskRuns = longTasks.map((t, i) => {
    const { s, e } = windows[i]
    return inMark(s, e) ? runs.filter((x) => overlap(x, s, e) > 0.5 * t.ms * 1000).sort((p, q) => overlap(q, s, e) - overlap(p, s, e) || (q.dur as number) - (p.dur as number))[0] : undefined
  })
  // A long task's own time: its task's thread time, its waits inside the window, and the part of the window outside the
  // task whole; its waits on the GPU only inside both (look plan A2.1 note (10), Round 5: a wait is cut to the window
  // scored, and nothing outside it is credited). A task with no thread time given is timed on the wall.
  const tasks = longTasks.map((t, i): OwnTime => {
    const run = taskRuns[i]
    if (!run || typeof run.tdur !== 'number') return { wall: t.ms, own: t.ms, cpu: t.ms, waited: 0, gpu: 0, matched: false }
    const { s, e } = windows[i]
    const [ws, we] = [Math.max(s, run.ts), Math.min(e, end(run))]
    const waited = waitedIn(waitsOn, ws, we, 'most') / 1000
    const cpu = ((run.tdur as number) + Math.max(0, run.ts - s) + Math.max(0, e - end(run))) / 1000
    const gpu = waitedIn(gpuOn, ws, we, 'least', run.tdur as number, timed) / 1000
    return { wall: t.ms, own: Math.min(t.ms, cpu + waited), cpu, waited, gpu, matched: true }
  })
  // The fits' tasks (look plan A2.1 note (10), Round 5): every task around a fit's measure the trace holds (FIT_SLACK),
  // as any of them may be the fit's (all of them charged, heldAll, each once: a fit that could be in either of two is
  // charged both); else the task of the long task that holds the fit, if the trace holds one. A fit whose measure is in
  // doubt (the trace dropped it, or a measure of its length is as near another fit) is charged every task around each
  // measure it may be, every task around it on the thread's clock put from the page's (within the 0.5 ms a measure is
  // paired in, and FIT_SLACK), and its long task's (any of them may be its). So is every fit when the resizes paired
  // disagree on the offset by more than FIT_SLACK / 2 (`spread`; Round 6, Opus m6-1: a clock that drifts so far may put
  // a measure as far from its task as FIT_SLACK). The fits in a long task are charged at least its thread time (`tasks`:
  // the trace may hold only a task inside it, and the part of its window outside the task the trace holds is charged
  // whole); a fit in none that the trace does not hold, 50 ms each. A task with no thread time given is charged its wall
  // (heldAll).
  const fitMeasures = spansOf(BUFFER_FIT_MEASURE).filter((x) => x.key === main)
  const near = fits.map((m) => (Number.isFinite(off) ? fitMeasures.filter((y) => alike(m, y) && Math.abs(y.s / 1000 - m.start - off) < 0.5) : []))
  const claims = new Map<object, number>()
  for (const xs of near) for (const x of xs) claims.set(x, (claims.get(x) ?? 0) + 1)
  const aroundOf = (s: number, e: number, slack: number): TraceEvent[] => runs.filter((x) => x.ts <= s + slack && end(x) >= e - slack)
  // A spread of NaN (no resize paired) leaves no clock to put a fit on, so no fit has a measure near it either way.
  const settled = spread <= FIT_SLACK / 2000
  // Whether long task `t` holds fit `j` (look plan A2.1 note (10), Round 7). When the trace holds the long task's task,
  // the trace says: a measure of the fit's near it (or, if the trace dropped them, where the page's number puts it on
  // the thread's clock) within FIT_SLACK of that task, the slack its charge is found in. Codex and Opus, Round 7: the
  // page's 1 ms made a 400 ms task (4 ms of thread time, 395 waiting on the GPU) the fit's when a timer's fit began 0.4
  // ms after it, as one does after a stall, so the stall was judged by the fit's limits and passed (4 / 9). A fit's
  // measure begun within FIT_SLACK after the task's end still tags it (the residual, as note (10) (f)'s). Else, as the
  // page tags it, the fit within 1 ms of it on the page's clock (a long task's numbers may be whole ms): a task the trace
  // does not hold is charged its wall by both rule sets. The trace holds a long task only on a clock put from the page's
  // (`off`), so the fit's place there is defined.
  const holds = (t: number, j: number): boolean => {
    const run = taskRuns[t]
    if (!run) return fits[j].start >= longTasks[t].start - 1 && fits[j].start + fits[j].ms <= longTasks[t].start + longTasks[t].ms + 1
    const at = near[j].length ? near[j] : [{ s: (fits[j].start + off) * 1000, e: (fits[j].start + off + fits[j].ms) * 1000 }]
    return at.some((x) => x.s >= run.ts - FIT_SLACK && x.e <= end(run) + FIT_SLACK)
  }
  // Each long task a fit's or not, by `holds` (dragVerdict judges each by the rules this gives it).
  const taskFit = longTasks.map((_, t) => fits.some((_, j) => holds(t, j)))
  // How far a fit's measure lies outside the nearest task the trace holds whole, the worst (ms; 0 with none, or no task):
  // the margin FIT_SLACK keeps, logged by the e2e (Round 7).
  const fitSkew = runs.length ? Math.max(0, ...near.flat().map((x) => Math.min(...runs.map((r) => Math.max(0, r.ts - x.s, x.e - end(r)))) / 1000)) : 0
  // The tasks charged, by the long task the fits are in (-1: in none).
  const held = new Map<number, Set<TraceEvent>>()
  let fitWalls = 0
  let fitsTraced = 0
  fits.forEach((f, i) => {
    const sure = settled && near[i].length === 1 && claims.get(near[i][0]) === 1
    const at = longTasks.findIndex((_, t) => holds(t, i))
    const long = longTasks[at]
    const run = taskRuns[at]
    const around = sure ? aroundOf(near[i][0].s, near[i][0].e, FIT_SLACK) : [
      ...near[i].flatMap((x) => aroundOf(x.s, x.e, FIT_SLACK)),
      ...(Number.isFinite(off) ? aroundOf((f.start + off) * 1000, (f.start + off + f.ms) * 1000, 500 + FIT_SLACK) : []),
    ]
    const found = sure && around.length ? around : run ? [...around, run] : around
    if (found.length) fitsTraced++
    else if (!long) {
      fitWalls += 50
      return
    }
    const xs = held.get(at) ?? new Set<TraceEvent>()
    held.set(at, xs)
    for (const x of found) xs.add(x)
  })
  // Each long task once, at least its thread time; the groups are not taken together, as a task in two is charged twice.
  const fitCpu = [...held].reduce((t, [at, xs]) => t + Math.max(heldAll([...xs]) / 1000, at < 0 ? 0 : tasks[at].cpu), 0) + fitWalls
  const onPage = allPairs.get(main) ?? new Map<string, number>()
  return { traced: offs.length, spread, thread: names.get(main) ?? main, marker: { held: !!mark, from: marks.from.length, to: marks.to.length, threads: markThreads.map((k) => names.get(k) || k) }, resizes, tasks, taskFit, fitSkew, fitCpu, fitsTraced, pairs: Object.fromEntries(onPage), unpaired: unpaired.filter((u) => u.thread === main).map((u) => ({ kind: u.kind, name: u.name, at: u.ts / 1000 - off })) }
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
 *   on Windows, 518 on ubuntu, 5204 on macOS, soak 45933131129; macOS's about 1.5 times its worst); an OS it does not
 *   name gets the widest;
 * - fitCpuTotal: the thread time of the tasks that hold the drag's fits, in all, each once (ownTimes' fitCpu: the fits
 *   in a long task at least that long task's charge, Round 6; a fit in no task the trace holds whole charged its long
 *   task's, or 50 ms), so fits too short to be long tasks are held too
 *   (the worst seen: 41 ms on Windows, 31 on ubuntu, 82 on macOS, 72 drags, diag 45985754504, 45985767956, 45985786689;
 *   about 2.5 times the worst);
 * - tracedResizes: the share of the resizes the page named that the trace holds on the thread's clock, each in the work
 *   around it (a share, not ms; the macOS trace drops up to 4 of 39, and one it drops is timed on the wall);
 * - tracedFits: the share of the fits' tasks the trace must hold (a share; one it drops is charged its wall), less
 *   fitsDropped of them at most (a count), so one dropped of fewer than 10 fails no drag;
 * - gap: by OS (process.platform), the widest gap between two of the drag's pointer moves the page handled, or between
 *   the last and the pointer's release (the page answers none in it).
 */
export const DRAG_LIMITS: { resizeOwn: number; resizeWall: number; taskOwn: number; taskWall: number; fitCpu: number; fitWall: number; fitCeiling: Record<string, number>; fitCpuTotal: number; tracedResizes: number; tracedFits: number; fitsDropped: number; gap: Record<string, number> } = {
  resizeOwn: 16, resizeWall: 50, taskOwn: 200, taskWall: 350, fitCpu: 200, fitWall: 1000, fitCeiling: { win32: 2000, darwin: 8000, linux: 2000 }, fitCpuTotal: 200, tracedResizes: 0.8, tracedFits: 0.9, fitsDropped: 1, gap: { win32: 5000, darwin: 7000, linux: 2000 },
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
  /** The fits named (BUFFER_FIT_MEASURE) from the first move to DRAG_AFTER_MS after the mouse-up, the long tasks' window (fitsNamed). */
  fits: PageSpan[]
  /** The widest gap between two pointer moves the page handled, or between the last and the pointer's release. */
  widestGap: number
  /** The OS the drag ran on (process.platform), for its gap limit; one DRAG_LIMITS does not name gets the widest. */
  platform: string
  /** The page's marker for this drag (ownTimes): the name its `:from` and `:to` measures begin with, the drag's alone. */
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

/** The drag check's rules on a drag (DRAG_LIMITS), each with what broke it, and the times they were judged on. */
export function dragVerdict(input: DragInput, limits = DRAG_LIMITS): { checks: DragCheck[]; own: ReturnType<typeof ownTimes>; others: OwnTime[]; fits: OwnTime[]; retagged: Array<{ start: number; ms: number; page: boolean }> } {
  const own = ownTimes(input.events, input.resizes, input.tasks, input.fits, input.marker)
  const fitCount = input.fits.length
  // Each long task judged as ownTimes tags it (Round 7: the trace's say where it holds the task), not by the page's tag;
  // the ones the two disagree on, logged by the e2e.
  const others = own.tasks.filter((_, i) => !own.taskFit[i])
  const fits = own.tasks.filter((_, i) => own.taskFit[i])
  const retagged = input.tasks.flatMap((t, i) => (t.fit === own.taskFit[i] ? [] : [{ start: t.start, ms: t.ms, page: t.fit }]))
  const pair = (x: OwnTime, digits = 1): string => `${x.wall.toFixed(digits)}/${x.own.toFixed(digits)}`
  const share = (x: number): string => `${Math.round(x * 100)}%`
  const held = fits.filter((x) => x.matched).length
  const timed = own.resizes.filter((x) => x.matched).length
  const byOs = (x: Record<string, number>): number => x[input.platform] ?? Math.max(...Object.values(x))
  const gap = byOs(limits.gap)
  const ceiling = byOs(limits.fitCeiling)
  const fitsHeld = Math.min(Math.ceil(fits.length * limits.tracedFits), fits.length - limits.fitsDropped)
  const checks: DragCheck[] = [
    { rule: "the trace lost no events (Tracing.tracingComplete's dataLossOccurred)", fails: input.dataLoss ? ['events lost'] : [] },
    { rule: "the trace holds the page's marker once, on one thread, from one instant (its from/to measures on threads)", fails: own.marker.held ? [] : [`${own.marker.from}/${own.marker.to} on ${own.marker.threads.join(', ') || 'none'}`] },
    { rule: 'the drag resized the view, each resize named (named/timed)', fails: input.resizeCount > 0 && input.resizes.length === input.resizeCount ? [] : [`${input.resizes.length}/${input.resizeCount}`] },
    { rule: `the trace holds at least ${share(limits.tracedResizes)} of the resizes the page named on the thread's clock, each in the work around it (one it dropped is timed on the wall): timed/named`, fails: timed >= Math.ceil(input.resizes.length * limits.tracedResizes) ? [] : [`${timed}/${input.resizes.length}`] },
    { rule: `each resize takes under ${limits.resizeOwn} ms of its own (wall/own ms)`, fails: own.resizes.filter((x) => x.own >= limits.resizeOwn).map((x) => pair(x)) },
    { rule: `each resize takes under ${limits.resizeWall} ms on the wall, a wait the trace does not name (ms)`, fails: own.resizes.filter((x) => x.wall >= limits.resizeWall).map((x) => x.wall.toFixed(1)) },
    { rule: 'the buffer was fitted during or after the drag, its fit named', fails: fitCount > 0 ? [] : ['no fit'] },
    { rule: "a long task holds a fit named, so the fits are scored (fits' tasks/fits named)", fails: fitCount > 0 && fits.length === 0 ? [`0/${fitCount}`] : [] },
    { rule: `no task runs over ${limits.taskOwn} ms of its own, the fit's left out (wall/own ms)`, fails: others.filter((x) => x.own > limits.taskOwn).map((x) => pair(x, 0)) },
    { rule: `no task runs over ${limits.taskWall} ms on the wall, the fit's left out, a wait the trace does not name (ms)`, fails: others.filter((x) => x.wall > limits.taskWall).map((x) => x.wall.toFixed(0)) },
    { rule: `the trace holds at least ${share(limits.tracedFits)} of the fits' tasks, or all but ${limits.fitsDropped}: traced/fits`, fails: held >= fitsHeld ? [] : [`${held}/${fits.length}`] },
    { rule: `no fit's task runs over ${limits.fitCpu} ms of thread time, its waits left out, one the trace does not hold charged its wall (wall/thread ms)`, fails: fits.filter((x) => x.cpu > limits.fitCpu).map((x) => `${x.wall.toFixed(0)}/${x.cpu.toFixed(0)}${x.matched ? '' : ' (not traced)'}`) },
    { rule: `no fit's task runs over ${limits.fitWall} ms on the wall beyond its waits on the GPU, any other wait counted (wall/GPU-waited ms)`, fails: fits.filter((x) => x.wall - x.gpu > limits.fitWall).map((x) => `${x.wall.toFixed(0)}/${x.gpu.toFixed(0)}`) },
    { rule: `no fit's task runs over ${ceiling} ms on the wall on ${input.platform}, its waits on the GPU too (ms)`, fails: fits.filter((x) => x.wall > ceiling).map((x) => x.wall.toFixed(0)) },
    { rule: `the tasks that hold the drag's fits take no more than ${limits.fitCpuTotal} ms of the thread in all, each once, the fits in a long task at least its charge, a fit the trace does not hold charged its long task's or 50 ms (ms, fits traced/named)`, fails: own.fitCpu > limits.fitCpuTotal ? [`${own.fitCpu.toFixed(0)} (${own.fitsTraced}/${fitCount})`] : [] },
    { rule: `the page handles the drag's pointer moves no more than ${gap} ms apart on ${input.platform}, the release too (ms)`, fails: input.widestGap > gap ? [input.widestGap.toFixed(0)] : [] },
  ]
  return { checks, own, others, fits, retagged }
}
