import { describe, expect, it } from 'vitest'
import { DRAG_LIMITS, DRAG_TRACE, dragVerdict, fitsNamed, heaviest, heldAll, isGpu, isWait, ownTimes as ownTimesOf, pageMeasure, paired, waitedIn, widestGap, type DragInput, type PageKind, type PageSpan, type TraceEvent } from '../../e2e/helpers/dragTrace'
import { BUFFER_FIT_MEASURE, LOOK_CHECK_MEASURE, RESIZE_MEASURE } from '../../src/renderer/src/world/engine/bufferFit'

// The divider-drag check's clock and rules (e2e/helpers/dragTrace.ts) on made-up traces: the page's clock is OFF ms
// behind the trace's, the page's main thread is 1:1, and every time is in ms on the page's clock.
const OFF = 5000
const us = (ms: number): number => Math.round((ms + OFF) * 1000)
const META: TraceEvent = { name: 'thread_name', ph: 'M', ts: 0, pid: 1, tid: 1, cat: '__metadata', args: { name: 'CrRendererMain' } }
/** A complete event on the page's main thread (or `tid`), from `start` for `dur` ms of the wall and `tdur` of the thread. */
const X = (name: string, cat: string, start: number, dur: number, tdur: number, tid = 1): TraceEvent => ({ name, cat, ph: 'X', ts: us(start), dur: Math.round(dur * 1000), tdur: Math.round(tdur * 1000), pid: 1, tid })
let ids = 0
/** A resize the page named (or a span of another `name`), as the trace holds it: a begin and an end in blink.user_timing (of process `pid`). */
const named = (start: number, ms: number, pid = 1, name = RESIZE_MEASURE): TraceEvent[] => {
  const id = `0x${(++ids).toString(16)}`
  return [
    { name, cat: 'blink.user_timing', ph: 'b', ts: us(start), pid, tid: 1, id },
    { name, cat: 'blink.user_timing', ph: 'e', ts: us(start + ms), pid, tid: 1, id },
  ]
}
/** The page's marker for the drag (look plan A2.1 note (10), Round 6). */
const MARKER = 'world-drag-test'
/** The page's marker as the trace holds it, on the page's thread (or `pid`:`tid`): its start at `s`, its span to `e` (us). */
// Its `:from` is one async instant, as Chromium 148 and Electron 43 trace a measure of no length; its `:to` a begin and an end.
const mark = (s: number, e: number, pid = 1, tid = 1, name = MARKER): TraceEvent[] => {
  const one = (n: string, a: number, b: number): TraceEvent[] => {
    const id = `0x${(++ids).toString(16)}`
    return [{ name: n, cat: 'blink.user_timing', ph: 'b', ts: a, pid, tid, id }, { name: n, cat: 'blink.user_timing', ph: 'e', ts: b, pid, tid, id }]
  }
  return [{ name: `${name}:from`, cat: 'blink.user_timing', ph: 'n', ts: s, pid, tid, id2: { local: `0x${(++ids).toString(16)}` } }, ...one(`${name}:to`, s, e)]
}
/** The marker around a trace and the page's spans, from the first instant of either to the last; none on a trace of no events. */
const markOf = (raw: TraceEvent[], spans: Array<{ start: number; ms: number }>): TraceEvent[] => {
  const xs = raw.filter((e) => e.ph !== 'M')
  if (!xs.length) return []
  const s = [...xs.map((e) => e.ts), ...spans.map((m) => us(m.start))].reduce((t, x) => Math.min(t, x), Infinity)
  const e = [...xs.map((x) => x.ts + (x.dur ?? 0)), ...spans.map((m) => us(m.start + m.ms))].reduce((t, x) => Math.max(t, x), -Infinity)
  return mark(s, e)
}
/**
 * The page's spans recorded into the trace under names of their own (pageMeasure, look plan A2.1 note (10), Round 11):
 * each resize and fit the trace names (RESIZE_MEASURE, BUFFER_FIT_MEASURE from the page's start, wherever the trace holds
 * it) named again from the same instants, and each long task on the page's thread. A span the trace does not name is not
 * named again either: a measure the trace drops is dropped whatever its name.
 */
const indexed = (raw: TraceEvent[], resizes: PageSpan[], longTasks: PageSpan[], fits: PageSpan[]): TraceEvent[] => {
  const asyncId = (e: TraceEvent): string => e.id ?? e.id2?.local ?? e.id2?.global ?? ''
  const again = (measure: string, kind: PageKind, xs: PageSpan[]): TraceEvent[] => xs.flatMap((m, k) => raw.filter((b) => b.name === measure && b.ts === us(m.start) && ['b', 'n', 'X'].includes(b.ph)).slice(0, 1).flatMap((b) => {
    const name = pageMeasure(MARKER, kind, k)
    if (b.ph !== 'b') return [{ ...b, name }]
    const e = raw.find((x) => x.name === measure && x.ph === 'e' && x.pid === b.pid && asyncId(x) === asyncId(b) && x.ts >= b.ts)
    const id = `0x${(++ids).toString(16)}`
    return [{ ...b, name, id, id2: undefined }, ...(e ? [{ ...e, name, id, id2: undefined }] : [])]
  }))
  const tasks = longTasks.flatMap((t, k) => named(t.start, t.ms, 1, pageMeasure(MARKER, 'task', k)))
  return [...raw, ...again(RESIZE_MEASURE, 'resize', resizes), ...again(BUFFER_FIT_MEASURE, 'fit', fits), ...tasks]
}
/** ownTimes on a trace the page's marker spans whole (markOf), the page's spans recorded into it (indexed). */
const ownTimes = (raw: TraceEvent[], named: PageSpan[], longTasks: PageSpan[], fits: PageSpan[] = []): ReturnType<typeof ownTimesOf> => {
  const events = indexed(raw, named, longTasks, fits)
  return ownTimesOf([...events, ...markOf(events, [...named, ...longTasks, ...fits])], named, longTasks, fits, MARKER)
}
/** A fit the page named, as the trace holds it. */
const fitNamed = (start: number, ms: number): TraceEvent[] => named(start, ms, 1, BUFFER_FIT_MEASURE)
/**
 * A quiet drag: `n` resizes of 2 ms of the thread, each in a task of its own about 100 ms apart, the page naming each; a
 * fit's task at 2500 ms: 80 ms on the wall, 75 of them waiting on the GPU inside the fit's measure (78 ms from 2500.5),
 * 5 of thread time; and two more fits in tasks
 * too short to be long tasks, at 2700 and 2800 ms (5 ms, 1 of thread time): 7 ms of the fits' thread time in all.
 */
function quiet(n = 10): { events: TraceEvent[]; resizes: Array<{ start: number; ms: number }>; fits: Array<{ start: number; ms: number }> } {
  const events: TraceEvent[] = [META]
  const resizes: Array<{ start: number; ms: number }> = []
  for (let k = 0; k < n; k++) {
    const t = 1000 + k * 100 + k * k * 0.7 // unevenly spaced, as a drag's are: an offset one resize off gets no bloc of votes
    events.push(X('ThreadControllerImpl::RunTask', 'toplevel', t, 3, 3), X('FunctionCall', 'devtools.timeline', t + 0.5, 2.2, 2.2), ...named(t + 0.6, 2))
    resizes.push({ start: t + 0.6, ms: 2 })
  }
  events.push(X('ThreadControllerImpl::RunTask', 'toplevel', 2500, 80, 5), X('CommandBufferProxyImpl::WaitForGetOffset', 'gpu', 2502, 75, 0.5), ...fitNamed(2500.5, 78))
  events.push(X('ThreadControllerImpl::RunTask', 'toplevel', 2700, 5, 1), ...fitNamed(2700.5, 0.5), X('ThreadControllerImpl::RunTask', 'toplevel', 2800, 5, 1), ...fitNamed(2800.5, 0.5))
  return { events, resizes, fits: [{ start: 2500.5, ms: 78 }, { start: 2700.5, ms: 0.5 }, { start: 2800.5, ms: 0.5 }] }
}
const FIT = { start: 2500, ms: 80, fit: true }
/**
 * A drag's input, the quiet drag's but for `over`, with the page's marker around its trace (markOf). The page tags a
 * long task the fit's when a fit it named lies in it (within 1 ms), and the check asks the trace (Round 7): so each
 * long task tagged the fit's that holds none of the fits named gets one over the whole of it, named and in the trace,
 * where its task is the long task's own (Round 11: only the fit's measure is the fit's, so the fit is the task's work).
 * The page's spans are recorded into the trace (indexed); `unmarked` is the same input with no marker.
 */
const unmarked = (over: Partial<DragInput> = {}): DragInput => {
  const q = quiet()
  const v = { events: q.events, resizes: q.resizes, resizeCount: q.resizes.length, tasks: [FIT], fits: q.fits, widestGap: 600, platform: 'linux', marker: MARKER, dataLoss: false, ...over }
  const fits = [...v.fits]
  const events = [...v.events]
  for (const t of v.tasks) if (t.fit && !fits.some((f) => f.start >= t.start - 1 && f.start + f.ms <= t.start + t.ms + 1)) {
    fits.push({ start: t.start, ms: t.ms })
    events.push(...fitNamed(t.start, t.ms))
  }
  return { ...v, fits, events: indexed(events, v.resizes, v.tasks, fits) }
}
const input = (over: Partial<DragInput> = {}): DragInput => {
  const v = unmarked(over)
  return { ...v, events: [...v.events, ...markOf(v.events, [...v.resizes, ...v.tasks, ...v.fits])] }
}
/** A task on the page's main thread the trace gives no thread time of. */
const U = (start: number, dur: number): TraceEvent => ({ ...X('ThreadControllerImpl::RunTask', 'toplevel', start, dur, 0), tdur: undefined })
/** A wait on the page's main thread with no thread time given. */
const W = (name: string, cat: string, start: number, dur: number): TraceEvent => ({ name, cat, ph: 'X', ts: us(start), dur: Math.round(dur * 1000), pid: 1, tid: 1 })
/** What broke the rule whose text holds `word` (the rule must be there). */
const fails = (v: ReturnType<typeof dragVerdict>, word: string): string[] => {
  const c = v.checks.filter((x) => x.rule.includes(word))
  expect(c, `one rule says "${word}"`).toHaveLength(1)
  return c[0].fails
}
const broken = (v: ReturnType<typeof dragVerdict>): string[] => v.checks.filter((c) => c.fails.length).map((c) => c.rule)

describe('the drag trace (dragTrace)', () => {
  it('traces the waits the thread can be blocked in: the GPU process, a message, a lock or an event, the compositor', () => {
    expect(DRAG_TRACE).toEqual(expect.arrayContaining(['toplevel', 'devtools.timeline', 'blink.user_timing', 'gpu', 'ipc', 'mojom', 'base', 'cc']))
  })

  it('a wait is one on the GPU process or a message by its category, or a wait, sync call or blocking call by its name', () => {
    expect(isWait(X('CommandBufferProxyImpl::OrderingBarrier', 'gpu', 0, 1, 0))).toBe(true)
    expect(isWait(X('IPC send', 'disabled-by-default-x,ipc', 0, 1, 0))).toBe(true)
    expect(isWait(X('WaitableEvent::Wait', 'base', 0, 1, 0))).toBe(true)
    expect(isWait(X('SyncChannel::Send', 'mojom', 0, 1, 0))).toBe(true)
    expect(isWait(X('ScopedBlockingCall', 'base', 0, 1, 0))).toBe(true)
    expect(isWait(X('FunctionCall', 'devtools.timeline', 0, 1, 0))).toBe(false)
    expect(isWait(X('ProxyMain::BeginMainFrame', 'cc', 0, 1, 0))).toBe(false)
    expect(isWait(X('Paint', 'gpuish', 0, 1, 0))).toBe(false) // a category is matched whole
  })

  it('heaviest: the most a family of slices that do not overlap can hold; side by side both count, overlapping or nested only one', () => {
    expect(heaviest([])).toBe(0)
    expect(heaviest([{ a: 0, b: 10, w: 5 }, { a: 10, b: 20, w: 4 }])).toBe(9) // side by side
    expect(heaviest([{ a: 0, b: 10, w: 5 }, { a: 9, b: 20, w: 4 }])).toBe(5) // one instant shared
    expect(heaviest([{ a: 0, b: 10, w: 5 }, { a: 0, b: 4, w: 3 }, { a: 5, b: 10, w: 3 }])).toBe(6) // two nested outweigh the outer
    expect(heaviest([{ a: 5, b: 10, w: 3 }, { a: 0, b: 10, w: 7 }, { a: 0, b: 4, w: 3 }])).toBe(7) // the outer outweighs them, in any order
    // Not the greedy pick: the earliest end first would take [0,6] and [6,9], 2; the best is [0,8] and [8,12], 6.
    expect(heaviest([{ a: 0, b: 6, w: 1 }, { a: 0, b: 8, w: 3 }, { a: 6, b: 9, w: 1 }, { a: 8, b: 12, w: 3 }])).toBe(6)
  })

  it("puts the page's clock on the trace's by the resizes both name, and times each on the thread's clock", () => {
    const q = quiet()
    const own = ownTimes(q.events, q.resizes, [])
    expect(own.traced).toBe(10)
    expect(own.recorded).toEqual({ resize: 10, task: 0, fit: 0 })
    expect(own.thread).toBe('CrRendererMain')
    // The call around each resize holds 2.2 ms of thread time, 2 of its wall the resize's measure: the measure widened by
    // the page clock's grain (FIT_SLACK) each side holds the call and 0.15 ms each side of it, all charged (Round 11), at
    // most the measure and the grain.
    expect(own.resizes.every((x) => x.matched && Math.abs(x.cpu - 2.5) < 1e-9 && Math.abs(x.own - 2.25) < 1e-9 && x.waited === 0)).toBe(true)
    expect(own.resizes[0].by).toBe('FunctionCall 2.2/2.2')
    // A resize the trace dropped is timed on the wall; with no resize in the trace there is no clock, and every span is.
    const lost = ownTimes(q.events.filter((e) => !(e.ph === 'b' && e.ts === us(1000.6))), [...q.resizes, { start: 5000, ms: 3 }], [{ start: 1300, ms: 60 }])
    expect(lost.traced).toBe(9)
    expect(lost.resizes.filter((x) => !x.matched)).toEqual([{ wall: 2, own: 2, cpu: 2, waited: 0, gpu: 0, matched: false }, { wall: 3, own: 3, cpu: 3, waited: 0, gpu: 0, matched: false }])
    const none = ownTimesOf([META], q.resizes, [{ start: 1300, ms: 60 }], [], MARKER)
    expect(none.traced).toBe(0)
    expect(none.thread).toBe('')
    expect(none.tasks).toEqual([{ wall: 60, own: 60, cpu: 60, waited: 0, gpu: 0, matched: false }])
    // A resize as one complete event in the trace is paired the same way, and an end with no begin is no resize.
    const complete: TraceEvent = { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'X', ts: us(3000), dur: 4000, pid: 1, tid: 1 }
    const orphan: TraceEvent = { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'b', ts: us(3500), pid: 1, tid: 1, id2: { local: '0xbeef' } }
    const one = ownTimes([META, X('RunTask', 'toplevel', 2999, 6, 6), complete, orphan], [{ start: 3000, ms: 4 }], [])
    expect(one.resizes[0]).toMatchObject({ matched: true, wall: 4, cpu: 4.5, own: 4.25 }) // 6 less the 1.5 that lie outside the 4 ms and the grain each side, at most 4 and the grain
    // A resize with no work around it in the trace is timed on the wall.
    const bare = ownTimes([META, ...named(100, 5)], [{ start: 100, ms: 5 }], [])
    expect(bare.resizes[0]).toEqual({ wall: 5, own: 5, cpu: 5, waited: 0, gpu: 0, matched: false })
    // A thread with no name is named by its process and thread.
    expect(ownTimes(q.events.slice(1), q.resizes, []).thread).toBe('1:1')
    expect(ownTimes([{ ...META, args: {} }, ...q.events.slice(1)], q.resizes, []).thread).toBe('')
  })

  it("pairs a resize's begin and end by their id however the trace gives it, a wait with no thread time is all wait, and of two tasks as long the wider is a long task's", () => {
    const pair = (id: Partial<TraceEvent>): TraceEvent[] => [
      { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'b', ts: us(100), pid: 1, tid: 1, ...id },
      { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'e', ts: us(105), pid: 1, tid: 1, ...id },
    ]
    for (const id of [{ id2: { global: '0x7' } }, {}]) {
      const waitNoThread: TraceEvent = { name: 'WaitableEvent::Wait', cat: 'base', ph: 'X', ts: us(101), dur: 3000, pid: 1, tid: 1 }
      const own = ownTimes([META, X('RunTask', 'toplevel', 99, 7, 1), ...pair(id), waitNoThread], [{ start: 100, ms: 5 }], [])
      expect(own.resizes[0]).toMatchObject({ matched: true, waited: 3, own: 4 })
    }
    const q = quiet()
    // Two tasks hold the long task alike: the one that runs longer is its.
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 100, 30), X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 120, 70)]
    expect(ownTimes(events, q.resizes, [{ start: 4000, ms: 100 }]).tasks[0]).toMatchObject({ cpu: 70, matched: true })
    // A task the trace gives no thread time holds it, a timed one inside: the untimed one is its, so it is timed on the wall.
    const bare = [...q.events, W('ThreadControllerImpl::RunTask', 'toplevel', 4000, 100), X('ThreadControllerImpl::RunTask', 'toplevel', 4010, 60, 5)]
    expect(ownTimes(bare, q.resizes, [{ start: 4000, ms: 100 }]).tasks[0]).toEqual({ wall: 100, own: 100, cpu: 100, waited: 0, gpu: 0, matched: false })
  })

  // Opus I-1, Codex major 1: a resize blocked on a wait outside `gpu` and `ipc` was charged its thread time only.
  it('charges a resize the wait it is blocked in, whatever its category (120 ms on a sync call: 0.6 ms of its own before)', () => {
    const q = quiet()
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 2000, 121.5, 1.5), X('FunctionCall', 'devtools.timeline', 2000.2, 121.2, 1.2), ...named(2000.5, 120.5), X('WaitableEvent::Wait', 'base', 2000.6, 120, 0.01)]
    const resizes = [...q.resizes, { start: 2000.5, ms: 120.5 }]
    const v = dragVerdict(input({ events, resizes, resizeCount: resizes.length }))
    const slow = v.own.resizes[v.own.resizes.length - 1]
    expect(slow.waited).toBeCloseTo(119.99, 2)
    expect(slow.own).toBeCloseTo(120.75, 2) // at most its measure and the page clock's grain
    expect(fails(v, 'of its own (wall/own ms)').length).toBe(1)
  })

  it('bounds a resize on the wall, for a wait the trace does not name at all', () => {
    const q = quiet()
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 2000, 121.5, 1.5), X('FunctionCall', 'devtools.timeline', 2000.2, 121.2, 1.2), ...named(2000.5, 120.5)]
    const resizes = [...q.resizes, { start: 2000.5, ms: 120.5 }]
    const v = dragVerdict(input({ events, resizes, resizeCount: resizes.length }))
    expect(v.own.resizes[v.own.resizes.length - 1].own).toBeLessThan(DRAG_LIMITS.resizeOwn) // the thread's clock sees nothing
    expect(fails(v, 'on the wall, a wait the trace does not name (ms)')).toEqual(['120.5'])
    expect(broken(v)).toHaveLength(1)
  })

  // Codex major 2: two pieces with the very same bounds were both taken off, so a 20 ms resize scored 13 ms.
  it('takes the work before and after a resize off its task once, two pieces with the same bounds being one (a 20 ms resize scores 20)', () => {
    const q = quiet()
    // A 40 ms task: a 10 ms timer and its callback (the very same bounds) before the resize, 7 ms after it.
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 3000, 40, 40), X('TimerFire', 'devtools.timeline', 3000, 10, 10), X('FunctionCall', 'devtools.timeline', 3000, 10, 10), ...named(3012, 20), X('FunctionCall', 'devtools.timeline', 3033, 7, 7)]
    const resizes = [...q.resizes, { start: 3012, ms: 20 }]
    const v = dragVerdict(input({ events, resizes, resizeCount: resizes.length }))
    const r = v.own.resizes[v.own.resizes.length - 1]
    // 40 less 19.5: the task's 40 ms of thread time and 20.5 of its wall in the resize and the grain each side put at least
    // 19.5 outside it, more than the 10 and 7 of the work before and after (17: the twins counted twice would be 27 and
    // score it 13); at most its measure and the grain.
    expect(r.cpu).toBe(20.5)
    expect(r.own).toBe(20.25)
    expect(fails(v, 'of its own (wall/own ms)')).toEqual(['20.0/20.3'])
  })

  it('counts two waits with the very same bounds once', () => {
    const q = quiet()
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 3000, 12, 2), X('FunctionCall', 'devtools.timeline', 3000.1, 11.8, 1.8), ...named(3000.2, 11.5), X('CommandBufferProxyImpl::WaitForToken', 'gpu', 3001, 10, 0), X('GLES2::Finish', 'gpu', 3001, 10, 0)]
    const own = ownTimes(events, [...q.resizes, { start: 3000.2, ms: 11.5 }], [])
    expect(own.resizes[own.resizes.length - 1].waited).toBe(10)
  })

  // Codex major 1: a 450 ms task with 35 ms of thread time and no wait the trace names passed the 500 ms wall rule.
  it('bounds a long task on the wall, for a wait the trace does not name (450 ms with 35 ms of its own)', () => {
    const events = [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 450, 35)]
    const v = dragVerdict(input({ events, tasks: [{ start: 4000, ms: 450, fit: false }] }))
    expect(v.others).toEqual([{ wall: 450, own: 35, cpu: 35, waited: 0, gpu: 0, matched: true }])
    expect(fails(v, 'on the wall, the fit\'s left out')).toEqual(['450'])
    expect(fails(v, 'of its own, the fit\'s left out')).toEqual([])
  })

  it("charges a long task its thread time and its waits, and one the trace does not hold its wall", () => {
    const events = [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 300, 150), X('CommandBufferProxyImpl::WaitForGetOffsetInRange', 'gpu', 4100, 100, 1)]
    const v = dragVerdict(input({ events, tasks: [{ start: 4000, ms: 300, fit: false }, { start: 9000, ms: 210, fit: false }] }))
    // The task's 150 ms of thread time could all lie in the 100 ms wait on the GPU: none of it is shown to be waiting (Round 4).
    expect(v.others[0]).toEqual({ wall: 300, own: 249, cpu: 150, waited: 99, gpu: 0, matched: true })
    expect(v.others[1]).toEqual({ wall: 210, own: 210, cpu: 210, waited: 0, gpu: 0, matched: false })
    expect(fails(v, 'of its own, the fit\'s left out')).toEqual(['300/249', '210/210'])
  })

  // Opus I-2, Codex major 3: every task that held a fit's measure was left out of every rule.
  it("bounds the thread time of a fit's task, the work after the fit's measure too (a 600 ms loop after the fit)", () => {
    const events = [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 700, 640), X('TimerFire', 'devtools.timeline', 4000.1, 699.8, 639.8)]
    const v = dragVerdict(input({ events, tasks: [{ start: 4000, ms: 700, fit: true }] }))
    expect(v.fits).toEqual([{ wall: 700, own: 640, cpu: 640, waited: 0, gpu: 0, matched: true }])
    expect(v.others).toEqual([])
    expect(fails(v, 'ms of thread time')).toEqual(['700/640'])
  })

  it("lets a fit's task wait on the GPU (in software its GL calls do), and bounds it on the wall beyond its waits", () => {
    const events = [...quiet().events,
      X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 700, 60), X('CommandBufferProxyImpl::WaitForGetOffsetInRange', 'gpu', 4010, 600, 1),
      X('ThreadControllerImpl::RunTask', 'toplevel', 6000, 1500, 60)]
    const v = dragVerdict(input({ events, tasks: [{ start: 4000, ms: 700, fit: true }, { start: 6000, ms: 1500, fit: true }] }))
    // 600 ms on the GPU of 1 ms of thread time, in a task of 60: at most 60 of them were the thread's, 540 waited (Round 4).
    expect(v.fits.map((x) => [x.cpu, x.waited, x.gpu])).toEqual([[60, 599, 540], [60, 0, 0]])
    expect(fails(v, 'ms of thread time')).toEqual([])
    expect(fails(v, 'beyond its waits on the GPU')).toEqual(['1500/0'])
  })

  // Round 2, Codex major 2: a fit's task the trace dropped skipped the thread-time rule. Round 10: a fit belongs only to
  // a task the trace holds, so one in a task the trace holds with no thread time is charged its wall as thread time;
  // Round 11: a fit in no task the trace holds is not placed, and fails the drag whatever its numbers.
  it("charges a fit in a task the trace gives no thread time its wall as thread time (600 ms), and fails one in no task", () => {
    const events = [...quiet().events, U(9000, 600)]
    const v = dragVerdict(input({ events, tasks: [FIT, { start: 9000, ms: 600, fit: true }] }))
    // Its thread time: the measure widened by the grain each side, inside its task: the task's whole wall.
    expect(v.own.fits[3]).toEqual({ start: 9000, ms: 600, wall: 600, cpu: 600, gpu: 0 })
    expect(v.fits[1]).toEqual({ wall: 600, own: 600, cpu: 600, waited: 0, gpu: 0, matched: false })
    expect(fails(v, 'ms of thread time')).toEqual(['600/600'])
    expect(fails(v, 'the trace places every fit')).toEqual([])
    // No task in the trace there: the fit is in none, and its long task is judged as one with none.
    const none = dragVerdict(input({ tasks: [FIT, { start: 9000, ms: 600, fit: true }] }))
    expect(none.own).toMatchObject({ taskFit: [true, false], fitsTraced: 3, fitCpu: 7 + 600 })
    expect(none.own.fits[3]).toEqual({ start: 9000, ms: 600, wall: 600, cpu: 600, gpu: 0, reason: 'untasked' })
    expect(fails(none, 'the trace places every fit')).toEqual(['9000.00+600.00 ms: untasked'])
    expect(fails(none, "of its own, the fit's left out")).toEqual(['600/600'])
  })

  // Round 2, Opus I2-1 (F1), Codex major 1: a fit's task blocked on a sync call passed, every named wait excused.
  it("bounds a fit's task on the wall beyond its waits on the GPU only: 3000 ms in a sync call counts (F1), 1400 ms on the GPU does not", () => {
    const v = dragVerdict(input({
      events: [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 3010, 8), X('ElectronApiIPC::MessageSync', 'mojom', 4004, 3000, 0.2), X('ScopedBlockingCallWithBaseSyncPrimitives', 'base', 4004.1, 2999.8, 0.1)],
      tasks: [FIT, { start: 4000, ms: 3010, fit: true }],
    }))
    expect(v.fits[1]).toMatchObject({ wall: 3010, cpu: 8, gpu: 0, matched: true })
    expect(v.fits[1].waited).toBeCloseTo(2999.8, 1)
    expect(fails(v, 'beyond its waits on the GPU')).toEqual(['3010/0'])
    expect(fails(v, 'ms of thread time')).toEqual([])
    // The subtraction itself (mutant D5): 1500 ms with 1400 on the GPU passes, with none it fails.
    const gpu = (waits: number): string[] => fails(dragVerdict(input({
      events: [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 1500, 60), ...(waits ? [X('ImplementationBase::WaitForCmd', 'gpu', 4050, waits, 1)] : [])],
      tasks: [FIT, { start: 4000, ms: 1500, fit: true }],
    })), 'beyond its waits on the GPU')
    expect(gpu(1400)).toEqual([])
    expect(gpu(0)).toEqual(['1500/0'])
  })

  // Round 2, Codex major 1: a 20 s fit with 190 ms of thread time and 19,720 ms waiting passed.
  it("bounds a fit's task on the wall, its waits on the GPU too (20 s, 19,720 ms on the GPU), and counts a compositor sync", () => {
    const at = (cat: string, name: string): ReturnType<typeof dragVerdict> => dragVerdict(input({
      events: [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 20_000, 190), X(name, cat, 4010, 19_720, 0)],
      tasks: [FIT, { start: 4000, ms: 20_000, fit: true }],
    }))
    const g = at('gpu', 'CommandBufferProxyImpl::WaitForGetOffset')
    expect(fails(g, 'ms on the wall on linux')).toEqual(['20000'])
    expect(fails(g, 'beyond its waits on the GPU')).toEqual([])
    const cc = at('cc', 'ProxyMain::SynchronizeState')
    expect(fails(cc, 'beyond its waits on the GPU')).toEqual(['20000/0'])
    expect(fails(cc, 'ms on the wall on linux')).toEqual(['20000'])
  })

  // Round 3, Opus I3-1, Codex major 1: an 8000 ms fit after the release, 7900 ms of it on the GPU, passed on every OS.
  it("bounds a fit's task on the wall by OS: 2 s on Windows and ubuntu, 8 s on macOS, the widest on another", () => {
    // A fit's task `ms` long on the wall, 50 ms of thread time, all but 100 ms of it waiting on the GPU.
    const fit = (platform: string, ms: number): ReturnType<typeof dragVerdict> => dragVerdict(input({
      platform,
      events: [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, ms, 50), X('ImplementationBase::WaitForCmd', 'gpu', 4010, ms - 100, 0)],
      tasks: [FIT, { start: 4000, ms, fit: true }],
    }))
    const ceiling = (platform: string, ms: number): string[] => fails(fit(platform, ms), `ms on the wall on ${platform}`)
    expect(broken(fit('linux', 2500))).toHaveLength(1) // the ceiling alone: it breaks no other rule
    expect(broken(fit('darwin', 8001))).toHaveLength(1)
    expect(ceiling('linux', 2500)).toEqual(['2500'])
    expect(ceiling('win32', 2500)).toEqual(['2500'])
    expect(ceiling('darwin', 2500)).toEqual([])
    expect(ceiling('linux', 2001)).toEqual(['2001'])
    expect(ceiling('win32', 2001)).toEqual(['2001'])
    // A measure's wall is judged at its most, the page clock's grain on (Round 11): 1999.75 passes, 1999.8 does not.
    expect(broken(fit('linux', 1999.75))).toEqual([])
    expect(broken(fit('win32', 1999.75))).toEqual([])
    expect(ceiling('linux', 1999.8)).toEqual(['2000'])
    // Round 4, Opus m4-1: 8000 on macOS, about 1.5 times its worst clean fit (5204 ms): 6765 would be 30% over it.
    expect(ceiling('darwin', 9000)).toEqual(['9000'])
    expect(ceiling('darwin', 8001)).toEqual(['8001'])
    expect(broken(fit('darwin', 7999.75))).toEqual([])
    expect(ceiling('darwin', 8000)).toEqual(['8000'])
    expect(broken(fit('darwin', 6800))).toEqual([])
    expect(ceiling('freebsd', 8001)).toEqual(['8001']) // an OS the limits do not name gets the widest
    expect(ceiling('freebsd', 7999.75)).toEqual([])
    expect(fails(fit('darwin', 8001), 'beyond its waits on the GPU')).toEqual([])
  })

  // Round 3, Codex major 2: the CPU of a wait was spread over the part another wait showed holds none, so a fit 1025 ms
  // on the wall beyond its waits on the GPU scored 975; and an outer wait with no thread time hid the inner's.
  it("excuses a fit no more GPU wait than the trace shows (1875 ms with waits [0,600] of no thread time and [400,1000] of 150, in a task of 160: 840, not 900)", () => {
    const fit = (ms: number, waits: TraceEvent[], tdur = 160): ReturnType<typeof dragVerdict> => dragVerdict(input({
      events: [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, ms, tdur), ...waits],
      tasks: [FIT, { start: 4000, ms, fit: true }],
    }))
    const overlapping = [X('ImplementationBase::WaitForCmd', 'gpu', 4100, 600, 0), X('CommandBufferProxyImpl::WaitForGetOffset', 'gpu', 4500, 600, 150)]
    const v = fit(1875, overlapping)
    // The task's 160 ms of thread time could all lie in the waits' 1000 (Round 4: more than the 150 of the second).
    expect(v.fits[1].gpu).toBeCloseTo(840, 6)
    expect(fails(v, 'beyond its waits on the GPU')).toEqual(['1875/840'])
    // A GPU wait the trace gives no thread time, with one inside it of 100 ms of thread time, in a task of 120: 880 ms
    // excused, not 1000 (Round 3: 900, the task's 120 then left out).
    const nested = fit(1950, [W('CommandBufferProxyImpl::WaitForToken', 'gpu', 4100, 1000), X('GLES2::Finish', 'gpu', 4300, 300, 100)], 120)
    expect(nested.fits[1].gpu).toBeCloseTo(880, 6)
    expect(fails(nested, 'beyond its waits on the GPU')).toEqual(['1950/880'])
  })

  // Round 3, Codex major 2: the same spreading charged a task less wait than the trace shows.
  it("charges a task no less wait than the trace shows (waits [10,70] and [50,110] of 30 ms of thread time each: 60, not 50)", () => {
    const events = [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 300, 145), X('WaitableEvent::Wait', 'base', 4010, 60, 30), X('WaitableEvent::Wait', 'base', 4050, 60, 30)]
    const v = dragVerdict(input({ events, tasks: [{ start: 4000, ms: 300, fit: false }] }))
    expect(v.others[0].waited).toBeCloseTo(60, 6)
    expect(fails(v, "of its own, the fit's left out")).toEqual(['300/205'])
  })

  // Round 2, Opus D11: a wait that runs past its task's end excused more than the task waited.
  it("counts a wait that runs past a fit's task, or a resize, only inside it", () => {
    // 1500 ms on the wall; a 2000 ms wait on the GPU of which 100 ms are inside the task.
    const v = dragVerdict(input({
      events: [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 1500, 60), X('ImplementationBase::WaitForCmd', 'gpu', 5400, 2000, 0)],
      tasks: [FIT, { start: 4000, ms: 1500, fit: true }],
    }))
    // Of the 100 ms inside, the task's 60 of thread time could lie in it: 40 excused (Round 4), 100 charged.
    expect(v.fits[1]).toMatchObject({ gpu: 40, waited: 100 })
    expect(fails(v, 'beyond its waits on the GPU')).toEqual(['1500/40'])
    // A 20 ms resize of no thread time and a wait from 5 ms into it to 20 ms past its end: 15 ms waited.
    const q = quiet()
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 3000, 45, 0.3), X('FunctionCall', 'devtools.timeline', 3000.1, 44, 0.2), ...named(3000.2, 20), X('WaitableEvent::Wait', 'base', 3005.2, 35, 0)]
    const own = ownTimes(events, [...q.resizes, { start: 3000.2, ms: 20 }], [])
    expect(own.resizes[own.resizes.length - 1].waited).toBeCloseTo(15.25, 6) // to the measure's end and the grain
  })

  // Round 2, Codex major 3: of two waits that overlap, the second was dropped, the part the first does not cover too.
  it('counts the instants of waits that overlap once each, the part of one the other does not cover too (a 25 ms resize scores 25)', () => {
    const q = quiet()
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 3000, 26, 0.2), X('FunctionCall', 'devtools.timeline', 3000.1, 25.6, 0.1), ...named(3000.2, 25), W('WaitableEvent::Wait', 'base', 3000.2, 10), W('WaitableEvent::Wait', 'base', 3005.2, 20)]
    const v = dragVerdict(input({ events, resizes: [...q.resizes, { start: 3000.2, ms: 25 }], resizeCount: 11 }))
    const r = v.own.resizes[v.own.resizes.length - 1]
    expect(r.waited).toBeCloseTo(25, 6)
    expect(r.own).toBeCloseTo(25.25, 6) // at most its measure and the grain (Round 11)
    expect(fails(v, 'of its own (wall/own ms)')).toEqual(['25.0/25.3'])
  })

  // Round 2, Codex minor: of two waits with the very bounds, one with no thread time given won over one with.
  it('of two waits with the very bounds takes the one with more thread time, so thread time is not counted as waiting', () => {
    const q = quiet()
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 3000, 12, 5), X('FunctionCall', 'devtools.timeline', 3000.1, 11.8, 4.8), ...named(3000.2, 11.5), W('GpuChannelHost::Send', 'ipc', 3001, 10), X('SyncChannel::Send', 'mojom', 3001, 10, 4)]
    const own = ownTimes(events, [...q.resizes, { start: 3000.2, ms: 11.5 }], [])
    expect(own.resizes[own.resizes.length - 1].waited).toBeCloseTo(6, 6)
  })

  it('waitedIn: the union of the waits cut to the span, less their thread time, the least or the most the trace allows', () => {
    const at = (a: number, d: number, td?: number): TraceEvent => ({ name: 'Wait', cat: 'base', ph: 'X', ts: a, dur: d, ...(td === undefined ? {} : { tdur: td }), pid: 1, tid: 1 })
    const both = (xs: TraceEvent[], s: number, e: number): number[] => [waitedIn(xs, s, e, 'least', 0), waitedIn(xs, s, e, 'most')]
    expect(both([], 0, 100)).toEqual([0, 0])
    expect(both([at(0, 10), at(5, 20)], 0, 100)).toEqual([25, 25]) // [0,10] and [5,25]
    expect(both([at(0, 10), at(20, 10)], 0, 100)).toEqual([20, 20]) // apart
    expect(both([at(0, 10), at(10, 10)], 0, 100)).toEqual([20, 20]) // side by side
    expect(both([at(0, 20, 4), at(5, 5, 3)], 0, 100)).toEqual([16, 16]) // nested: the outer's thread time holds the inner's
    expect(both([at(0, 20, 2), at(5, 5, 3)], 0, 100)).toEqual([17, 17]) // ... and is at least the inner's
    expect(both([at(0, 10, 0), at(0, 10, 4)], 0, 100)).toEqual([6, 6]) // the very bounds: the one with more thread time
    // Codex's case: [0,600] of no thread time shows [400,600] holds none, so the 150 of [400,1000] lie in [600,1000]:
    // the least is 850. The most takes 150 less the 200 ms it could have in [400,600]: none, 1000.
    expect(both([at(0, 600, 0), at(400, 600, 150)], 0, 1000)).toEqual([850, 1000])
    // [0,10] all thread time, [5,15] of 4: in [10,15] at most 4 of them, at least none (all 4 can lie in [5,10]).
    // [0,10] all thread time, [5,15] of 4: in [10,15] none at least (all 4 can lie in [5,10]): the most is 5. The least
    // takes the heavier of the two that overlap, 10, so 5 too: it relies on the window's thread time (`cpu`), and with
    // 14 (all the two can hold) it is 1, as with a slice of 14 around them (`known`).
    expect(both([at(0, 10, 10), at(5, 10, 4)], 0, 100)).toEqual([5, 5])
    expect(waitedIn([at(0, 10, 10), at(5, 10, 4)], 0, 100, 'least', 14)).toBe(1)
    expect(waitedIn([at(0, 10, 10), at(5, 10, 4)], 0, 100, 'least', 0, [at(0, 15, 14)])).toBe(1)
    expect(both([at(0, 10, 2), at(5, 10, 8)], 0, 100)).toEqual([7, 10]) // the least: the heavier, 8; the most: in [10,15] at least 8 less 5
    // A wait with no thread time given, a wait inside it with some: that much of the outer is not waited, nested deeper too.
    expect(both([at(0, 1000), at(200, 300, 100)], 0, 1000)).toEqual([900, 900])
    expect(both([at(0, 1000), at(100, 600), at(200, 300, 100), at(600, 50, 20)], 0, 1000)).toEqual([880, 880])
    // Cut to the span: of 50 ms of thread time in 100, the 20 inside hold at most 20 of it and at least none.
    expect(both([at(-50, 100, 50)], 0, 20)).toEqual([0, 20])
    expect(both([at(-50, 100, 90)], 0, 20)).toEqual([0, 10]) // at least 90 less the 80 cut off
    expect(both([at(30, 10), at(-10, 5)], 0, 20)).toEqual([0, 0]) // outside the span
    expect(both([at(0, 10, 30)], 0, 100)).toEqual([0, 0]) // thread time over its wall: no wait
    // Round 4, Opus mutant N10: a slice holds at most its part of the union. A call [0,100] of 30 ms of thread time,
    // 10 of its wall in a wait [90,200] of none, and one [150,160] of 10: 20 of the 110 are not shown waiting, so 90 (not 70).
    expect(waitedIn([at(90, 110)], 0, 1000, 'least', 0, [at(0, 100, 30), at(150, 10, 10)])).toBe(90)
    // Codex's case (Round 4, dragTrace.ts:63): [0,600] of no thread time, [50,150] of 100 nested in it, [500,800] of 70
    // past it: 800 less 100 and 70, which lie apart, 630 (Round 3: 700, the 70 counted only past 600).
    expect(waitedIn([at(0, 600), at(50, 100, 100), at(500, 300, 70)], 0, 1000, 'least', 0)).toBe(630)
    // The thread time of a slice of any category inside counts, the heaviest of those that overlap (item 2).
    // A call of 150 ms of thread time inside a 1000 ms wait on the GPU of none, in a task of 150: 850 (item 2), with or
    // without the task (Round 3: 1000, a call not being a wait).
    const call = { ...at(100, 300, 150), name: 'FunctionCall', cat: 'devtools.timeline' }
    expect(waitedIn([at(0, 1000)], 0, 1000, 'least', 0, [call, at(-10, 1020, 150)])).toBe(850)
    expect(waitedIn([at(0, 1000)], 0, 1000, 'least', 0, [call])).toBe(850)
    expect(waitedIn([at(0, 1000)], 0, 1000, 'least', 150)).toBe(850)
    // A slice in `known` that is also a wait counts once.
    const both150 = at(0, 1000, 150)
    expect(waitedIn([both150], 0, 1000, 'least', 0, [both150])).toBe(850)
    // The window holds at most its part of the union: a window of 300 of thread time, a union of 200 in it, none waited.
    expect(waitedIn([at(-100, 300)], 0, 1000, 'least', 300)).toBe(0)
  })

  // Round 5, Codex (c): two waits [0,600] and [400,1000], 100 us of thread time each in its part the other does not
  // overlap, called with no slice around them: the heavier alone was taken, 900. The window [0,1000] holds the 200 of
  // the call it is cut to (`cpu`, which every call now hands in), so 800.
  it("waitedIn's least always holds the window scored: two waits of 100 each that overlap, in a window of 200 of thread time, wait 800 (not 900)", () => {
    const at = (a: number, d: number, td: number): TraceEvent => ({ name: 'Wait', cat: 'base', ph: 'X', ts: a, dur: d, tdur: td, pid: 1, tid: 1 })
    expect(waitedIn([at(0, 600, 100), at(400, 600, 100)], 0, 1000, 'least', 200)).toBe(800)
    expect(waitedIn([at(0, 600, 100), at(400, 600, 100)], 0, 1000, 'least', 0)).toBe(900)
  })

  // Round 2, Codex minor: a resize's begin was paired with an end of another process by id, and spans on another
  // thread counted as traced.
  it("pairs a resize's begin with an end of its own process, and counts as traced only the resizes on the page's thread", () => {
    const q = quiet()
    // Another renderer begins a resize of the same id just before one of the page's, and never ends it.
    const firstId = (q.events.find((e) => e.ph === 'b') as TraceEvent).id
    const stray: TraceEvent = { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'b', ts: us(1000.5), pid: 2, tid: 1, id: firstId }
    const own = ownTimes([...q.events, stray], q.resizes, [])
    expect(own.traced).toBe(10)
    expect(own.resizes.every((x) => x.matched)).toBe(true)
    // Four of the page's ten resizes are named in the trace on another process's thread at the same times.
    const moved = q.events.flatMap((e) => (e.ph === 'b' || e.ph === 'e') && e.ts >= us(1600) && e.ts < us(2000) ? [{ ...e, pid: 2 }] : [e])
    const v = dragVerdict(input({ events: moved }))
    expect(v.own.traced).toBe(6)
    expect(v.own.thread).toBe('CrRendererMain')
    expect(fails(v, 'of the resizes the page named')).toEqual(['6/10'])
    // The thread most resizes agree with is the page's, though another names a resize first.
    const early = [...named(500, 2, 2), ...q.events]
    const page = [{ start: 500, ms: 2 }, ...q.resizes]
    expect(ownTimes(early, page, []).thread).toBe('CrRendererMain')
  })

  // Round 2, Opus m2-1: a resize blocked 90.5 ms on a wait the trace does not name passed the 100 ms wall (F4).
  it('bounds a resize at 50 ms on the wall (F4: 90.5 ms, 1.2 of its own)', () => {
    const q = quiet()
    const one = (ms: number): string[] => fails(dragVerdict(input({ events: [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 3000, ms + 1, 1.5), X('FunctionCall', 'devtools.timeline', 3000.2, ms + 0.6, 1.2), ...named(3000.5, ms)], resizes: [...q.resizes, { start: 3000.5, ms }], resizeCount: 11 })), 'on the wall, a wait the trace does not name (ms)')
    expect(one(90.5)).toEqual(['90.5'])
    expect(one(50)).toEqual(['50.0'])
    expect(one(49.75)).toEqual(['49.8']) // judged at its most, the page clock's grain on (Round 11): 50, not under
    expect(one(49.7)).toEqual([])
  })

  // Round 2, Opus m2-3: the limits are pinned, so a change of one touches a test.
  it('pins the limits (look plan A2.1 note (10), PENDING SIGN-OFF)', () => {
    expect(DRAG_LIMITS).toEqual({ resizeOwn: 16, resizeWall: 50, taskOwn: 200, taskWall: 350, fitCpu: 200, fitWall: 1000, fitCeiling: { win32: 2000, darwin: 8000, linux: 2000 }, fitCpuTotal: 200, tracedResizes: 0.8, gap: { win32: 5000, darwin: 7000, linux: 2000 } })
  })

  // Codex minor: a resize whose measure the page failed to name dropped out of every rule.
  it('holds the resizes the page named to the ones the renderer timed, so a resize left unnamed shows', () => {
    const q = quiet()
    expect(fails(dragVerdict(input({ resizes: q.resizes.slice(1), resizeCount: q.resizes.length })), 'each resize named')).toEqual(['9/10'])
    expect(fails(dragVerdict(input({ resizes: [], resizeCount: 0 })), 'each resize named')).toEqual(['0/0'])
    expect(fails(dragVerdict(input({ resizes: [], resizeCount: 0 })), 'of the resizes the page named')).toEqual([])
    expect(fails(dragVerdict(input({ events: [META] })), 'of the resizes the page named')).toEqual(['0/10'])
  })

  // Round 2, Codex minor: "most" of the resizes was 5 of 10. 80%, as the macOS trace drops up to 4 of 39.
  it('wants 80% of the resizes the page named in the trace: 8 of 10, not 7', () => {
    const q = quiet()
    const drop = (n: number): TraceEvent[] => q.events.filter((e) => !(e.ph === 'b' && e.ts < us(1000 + n * 100)))
    expect(fails(dragVerdict(input({ events: drop(2) })), 'of the resizes the page named')).toEqual([])
    expect(fails(dragVerdict(input({ events: drop(3) })), 'of the resizes the page named')).toEqual(['7/10'])
  })

  // Round 3, Opus m3-3 (mutant R6, floor): at 10 resizes floor and ceil agree; at 39 they do not (31.2).
  it('wants 80% of 39 resizes rounded up: 32, not 31', () => {
    const q = quiet(39)
    const drop = (n: number): TraceEvent[] => q.events.filter((e) => !(e.ph === 'b' && e.ts < us(1000 + n * 100)))
    const at = (n: number): string[] => fails(dragVerdict(input({ events: drop(n), resizes: q.resizes, resizeCount: 39 })), 'of the resizes the page named')
    expect(at(7)).toEqual([])
    expect(at(8)).toEqual(['31/39'])
  })

  // Round 3, Codex minor: ten resizes in the trace with none in the work around them passed as all traced.
  it("counts a resize toward the 80% only when it is timed on the thread's clock, in the work around it", () => {
    const bare = quiet().events.filter((e) => !(e.ts < us(2400) && (e.name === 'FunctionCall' || e.name === 'ThreadControllerImpl::RunTask')))
    const v = dragVerdict(input({ events: bare }))
    expect(v.own.traced).toBe(10)
    expect(v.own.resizes.every((x) => !x.matched)).toBe(true)
    expect(fails(v, 'of the resizes the page named')).toEqual(['0/10'])
    const some = quiet().events.filter((e) => !(e.ts < us(1300) && (e.name === 'FunctionCall' || e.name === 'ThreadControllerImpl::RunTask')))
    expect(fails(dragVerdict(input({ events: some })), 'of the resizes the page named')).toEqual(['7/10'])
  })

  // Round 6: the page's thread is the one its marker is on, not the one the resizes' vote picks (Round 3 took, of two
  // threads as many resizes agree with, the one that named a resize first).
  it("takes the page's thread from its marker, whichever thread names a resize first", () => {
    const page = [{ start: 100, ms: 2 }, { start: 200, ms: 3 }]
    const thread2: TraceEvent = { ...META, pid: 2, args: { name: 'Other' } }
    const mine = [...named(100, 2), ...named(200, 3)]
    const theirs = [...named(99.99, 2, 2), ...named(199.99, 3, 2)]
    expect(ownTimes([META, thread2, ...theirs, ...mine], page, []).thread).toBe('CrRendererMain')
    // With the marker on the other thread, it is the page's: the resizes recorded there are the page's (Round 11), and
    // the ones recorded on the first thread are no one's.
    const again = (xs: TraceEvent[], at: PageSpan[]): TraceEvent[] => indexed(xs, at, [], []).slice(xs.length)
    const theirPage = [{ start: 99.99, ms: 2 }, { start: 199.99, ms: 3 }]
    const marked = mark(us(99), us(300), 2)
    const other = ownTimesOf([META, thread2, ...theirs, ...mine, ...again(theirs, theirPage), ...marked], theirPage, [], [], MARKER)
    expect(other).toMatchObject({ thread: 'Other', traced: 2, marker: { held: true, from: 1, to: 1, threads: ['Other'] } })
    const lost = ownTimesOf([META, thread2, ...theirs, ...mine, ...again(mine, page), ...marked], page, [], [], MARKER)
    expect(lost).toMatchObject({ thread: 'Other', traced: 0, recorded: { resize: 0, task: 0, fit: 0 } })
  })

  // Round 6, Codex: a second renderer with the page's resize cadence 333 ms earlier, its fits in tasks of 1 ms, won the
  // clock vote 10 to 9 when the trace dropped one of the page's resizes: the six fits' 40 ms tasks of 39 ms of thread
  // time went uncharged (13 ms, against 241). The marker puts the page's thread on its renderer: 241, and it fails.
  it("charges the page's fits on its marker's thread, though a second renderer wins the resizes' vote (Codex: 13, now 241)", () => {
    const q = quiet()
    const on2 = (e: TraceEvent): TraceEvent => ({ ...e, pid: 2 })
    // The trace drops one of the page's resizes: nine of its resizes against ten of the other renderer's.
    const r5 = q.resizes[5]
    const events = q.events.filter((e) => !(e.name === RESIZE_MEASURE && e.ts >= us(r5.start) && e.ts <= us(r5.start + r5.ms)))
    const fits = [...q.fits]
    for (let k = 0; k < 6; k++) {
      const t = 3000 + k * 100
      events.push(X('ThreadControllerImpl::RunTask', 'toplevel', t, 40, 39), ...fitNamed(t + 20, 0.2))
      events.push(on2(X('ThreadControllerImpl::RunTask', 'toplevel', t + 19.9 - 333, 1, 1)), ...named(t + 20 - 333, 0.2, 2, BUFFER_FIT_MEASURE))
      fits.push({ start: t + 20, ms: 0.2 })
    }
    for (const r of q.resizes) events.push(...named(r.start - 333, r.ms, 2), on2(X('ThreadControllerImpl::RunTask', 'toplevel', r.start - 333.6, 3, 3)))
    events.push(on2(X('ThreadControllerImpl::RunTask', 'toplevel', 2500 - 333, 80, 5)), ...named(2500.5 - 333, 1, 2, BUFFER_FIT_MEASURE))
    const v = dragVerdict(input({ events, fits }))
    expect(v.own).toMatchObject({ thread: 'CrRendererMain', traced: 9, fitsTraced: 9, recorded: { resize: 9, task: 1, fit: 9 } })
    // Round 11: no vote; each of the six fits is placed in its 40 ms task on the page's thread, and only its measure is
    // its own: each task is left 39 of its own and 40 on the wall, and fails a resize's limits.
    expect(v.own.fitTasks.slice(3)).toEqual(Array(6).fill({ wall: 40, own: 39, fits: 1, off: 0, restWall: 40, restOwn: 39 }))
    expect(fails(v, "less the page clock's grain each), takes under 16 ms of its own")).toEqual(Array(6).fill('40.0/39.0 less 0.0 of 1 fit'))
    expect(fails(v, 'the trace places every fit')).toEqual([])
  })

  // Round 6: with no marker, or one the trace holds more than once, on two threads, or without its start, no thread is
  // the page's: every span is timed on the wall, and the drag fails.
  it("fails a drag whose trace does not hold the page's marker once, on one thread, from one instant", () => {
    const q = quiet()
    const thread2: TraceEvent = { ...META, pid: 2, args: { name: 'Other' } }
    const a = us(900)
    const b = us(3000)
    const at = (events: TraceEvent[]): ReturnType<typeof dragVerdict> => dragVerdict({ ...input(), events: [...unmarked().events, thread2, ...events] })
    const none = at([])
    expect(none.own).toMatchObject({ thread: '', traced: 0, fitsTraced: 0, marker: { held: false, from: 0, to: 0, threads: [] } })
    expect(none.own.resizes.every((x) => !x.matched)).toBe(true)
    expect(none.own.tasks.every((x) => !x.matched)).toBe(true)
    expect(fails(none, "the page's marker")).toEqual(['0/0 on none'])
    expect(fails(at(mark(a, b)), "the page's marker")).toEqual([])
    expect(at(mark(a, b)).own.traced).toBe(10)
    // On two threads: another renderer names one too (a page of the same test, or the same page twice).
    expect(fails(at([...mark(a, b), ...mark(a, b, 2)]), "the page's marker")).toEqual(['2/2 on CrRendererMain, Other'])
    expect(at([...mark(a, b), ...mark(a, b, 2)]).own.traced).toBe(0)
    // Twice on one thread.
    expect(fails(at([...mark(a, b), ...mark(a, b)]), "the page's marker")).toEqual(['2/2 on CrRendererMain'])
    // Its start twice and its span once, or its span twice and its start once.
    expect(fails(at([...mark(a, b), ...mark(a, b).slice(0, 1)]), "the page's marker")).toEqual(['2/1 on CrRendererMain'])
    expect(fails(at([...mark(a, b), ...mark(a, b).slice(1)]), "the page's marker")).toEqual(['1/2 on CrRendererMain'])
    // Its span without its start: the trace may have begun on the page's thread after it.
    expect(fails(at(mark(a, b).slice(1)), "the page's marker")).toEqual(['0/1 on CrRendererMain'])
    expect(fails(at(mark(a, b).slice(0, 1)), "the page's marker")).toEqual(['1/0 on CrRendererMain'])
    // Its start on one thread and its span on another.
    expect(fails(at([...mark(a, b).slice(0, 1), ...mark(a, b, 2).slice(1)]), "the page's marker")).toEqual(['1/1 on CrRendererMain, Other'])
    // Its start at another instant than its span's: 0.05 ms apart holds, 0.06 not.
    const apart = (d: number): TraceEvent[] => [...mark(a + d, a + d).slice(0, 1), ...mark(a, b).slice(1)]
    expect(fails(at(apart(50)), "the page's marker")).toEqual([])
    expect(fails(at(apart(-50)), "the page's marker")).toEqual([])
    expect(fails(at(apart(60)), "the page's marker")).toEqual(['1/1 on CrRendererMain'])
    expect(fails(at(apart(-60)), "the page's marker")).toEqual(['1/1 on CrRendererMain'])
    // Its start as a begin and an end at one instant, as a Chromium that traces a measure of no length so would.
    const paired = (s: number, e: number): TraceEvent[] => [{ name: `${MARKER}:from`, cat: 'blink.user_timing', ph: 'b', ts: s, pid: 1, tid: 1, id: '0xf0' }, { name: `${MARKER}:from`, cat: 'blink.user_timing', ph: 'e', ts: s, pid: 1, tid: 1, id: '0xf0' }, ...mark(s, e).slice(1)]
    expect(fails(at(paired(a, b)), "the page's marker")).toEqual([])
    expect(at(paired(a, b)).own.traced).toBe(10)
    // A marker of another drag is not this one's.
    expect(fails(at(mark(a, b, 1, 1, 'world-drag-other')), "the page's marker")).toEqual(['0/0 on none'])
  })

  // Round 6: a span of the page outside its marker is timed on the wall, and a task of the trace outside it is no fit's.
  // Round 10: the quiet drag's resizes are alike and 100 ms apart, so with its first left out the vote would tie
  // between the offset and one 100 ms off (no offset, below); the first here is 3 ms, a length no other has.
  it("times on the wall a resize or a long task outside the page's marker, and charges no task outside it", () => {
    const q = quiet()
    const first = [...q.events.filter((e) => !(e.name === RESIZE_MEASURE && e.ts < us(1050))), ...named(1000.6, 3)]
    const resizes = [{ start: 1000.6, ms: 3 }, ...q.resizes.slice(1)]
    const at = (s: number, e: number): ReturnType<typeof dragVerdict> => {
      const v = unmarked({ resizes, events: first })
      return dragVerdict({ ...v, events: [...v.events, ...mark(us(s), us(e))] })
    }
    // From the second resize's task on: the first resize is the wall's (3 ms), the rest traced.
    const late = at(1100, 3000)
    expect(late.own.resizes.map((x) => x.matched)).toEqual([false, ...Array(9).fill(true)])
    expect(late.own.resizes[0]).toMatchObject({ wall: 3, own: 3 })
    expect(late.own).toMatchObject({ traced: 9 })
    // To the long task's start: its window is the wall's, 80 of thread time, and no task outside the marker holds a fit:
    // each fit's measure outside the marker is none of the page's, so none is placed, and the drag fails (Round 11).
    const early = at(900, 2500.4)
    expect(early.own.tasks[0]).toMatchObject({ matched: false, cpu: 80 })
    expect(early.own).toMatchObject({ taskFit: [false], fitsTraced: 0 })
    expect(fails(early, 'the trace places every fit')).toEqual(['2500.50+78.00 ms: unmatched', '2700.50+0.50 ms: unmatched', '2800.50+0.50 ms: unmatched'])
  })

  // Round 2, Opus m2-2, Codex minor: one 7000 ms gap for every OS, and the release after the last move not counted.
  it("wants a fit named, and the pointer moves answered no more than each OS's gap apart, the release too", () => {
    expect(fails(dragVerdict(input({ fits: [], tasks: [] })), 'its fit named')).toEqual(['no fit'])
    const gap = (platform: string, widest: number): string[] => fails(dragVerdict(input({ platform, widestGap: widest })), 'pointer moves')
    expect(gap('linux', 2001)).toEqual(['2001'])
    expect(gap('linux', 2000)).toEqual([])
    expect(gap('win32', 5001)).toEqual(['5001'])
    expect(gap('win32', 5000)).toEqual([])
    expect(gap('darwin', 7001)).toEqual(['7001'])
    expect(gap('darwin', 7000)).toEqual([])
    expect(gap('freebsd', 7001)).toEqual(['7001']) // an OS the limits do not name gets the widest
    expect(gap('freebsd', 7000)).toEqual([])
    // The widest gap is between two moves, or the last and the release; with no move there is none.
    expect(widestGap([100, 150, 900, 950], 1000)).toBe(750)
    expect(widestGap([100, 150, 200], 2300)).toBe(2100)
    expect(widestGap([], 500)).toBe(0)
    expect(widestGap([100], 400)).toBe(300)
  })

  // Round 2, Codex minor: the fits were counted from the first move with no end, past the long tasks' window.
  it('counts the fits named in the long tasks\' window: ending after its start, beginning before its end', () => {
    const fits = [{ start: 50, end: 90 }, { start: 90, end: 130 }, { start: 500, end: 560 }, { start: 999, end: 1100 }, { start: 1000, end: 1050 }]
    expect(fitsNamed(fits, 100, 1000)).toEqual([{ start: 90, ms: 40 }, { start: 500, ms: 60 }, { start: 999, ms: 101 }])
    expect(fitsNamed([], 0, 10)).toEqual([])
  })

  it('a GPU wait is one on the GPU process by its category, matched whole', () => {
    expect(isGpu(X('ImplementationBase::WaitForCmd', 'gpu', 0, 1, 0))).toBe(true)
    expect(isGpu(X('x', 'disabled-by-default-y,gpu', 0, 1, 0))).toBe(true)
    expect(isGpu(X('GpuChannel::WaitForGetOffsetInRange', 'mojom', 0, 1, 0))).toBe(false)
    expect(isGpu(X('x', 'gpuish', 0, 1, 0))).toBe(false)
  })

  // Round 4, Opus: of a call's thread time, what lies outside the resize is taken off only as far as the trace shows it
  // there. A 17 ms resize, its call's 1.04 ms of thread time all in work that ends 0.04 ms into it, then 15.98 ms
  // waiting: 16.02 of its own (Round 3 took the work off whole, within the 50 us slack: 15.98).
  it('takes off a call only the thread time shown outside the resize (17 ms, 15.98 waiting and 0.04 of work in it: 16.02)', () => {
    const q = quiet()
    const events = [...q.events, X('FunctionCall', 'devtools.timeline', 2999, 18, 1.04), X('v8.compile', 'v8', 2999, 1.04, 1.04), W('WaitableEvent::Wait', 'base', 3001.02, 15.98), ...named(3000, 17)]
    const resizes = [...q.resizes, { start: 3000, ms: 17 }]
    const v = dragVerdict(input({ events, resizes, resizeCount: resizes.length }))
    const r = v.own.resizes[v.own.resizes.length - 1]
    // Round 11: the window is the measure widened by the grain each side, so 0.29 of the work and 0.25 past the call's
    // end are charged too: 0.54, and 16.52 of its own.
    expect(r.cpu).toBeCloseTo(0.54, 9)
    expect(r.waited).toBeCloseTo(15.98, 9)
    expect(r.own).toBeCloseTo(16.52, 9)
    expect(fails(v, 'of its own (wall/own ms)')).toEqual(['17.0/16.5'])
    // Work before and after a resize lies outside it whole; the call's own thread time beyond its part of the resize too.
    const e2 = [...q.events, X('FunctionCall', 'devtools.timeline', 2990, 40, 30), X('a', 'v8', 2990, 10, 10), X('b', 'v8', 3020, 10, 9), ...named(3000, 20)]
    const r2 = ownTimes(e2, [...q.resizes, { start: 3000, ms: 20 }], []).resizes[10]
    expect(r2).toMatchObject({ cpu: 11.5, waited: 0, own: 11.5 }) // 30 less 18.5: a and b, apart, outweigh the call's 30 less 20.5
    // A resize longer than its call (by the slack): the part of the window outside the call is charged as thread time.
    const e3 = [...q.events, X('FunctionCall', 'devtools.timeline', 3000.03, 9.94, 2), ...named(3000, 10)]
    expect(ownTimes(e3, [...q.resizes, { start: 3000, ms: 10 }], []).resizes[10].cpu).toBeCloseTo(2.56, 9)
    // Its wait on the GPU is the part inside the call less the call's thread time: 9.94 less 2.
    const e4 = [...e3, W('WaitForCmd', 'gpu', 3000, 10)]
    expect(ownTimes(e4, [...q.resizes, { start: 3000, ms: 10 }], []).resizes[10].gpu).toBeCloseTo(7.94, 9)
    // Children whose thread time outside the resize outweighs the call's (clocks the trace does not keep alike): none, not less.
    const e5 = [...q.events, X('FunctionCall', 'devtools.timeline', 2990, 30, 5), X('a', 'v8', 2990, 10, 4), X('b', 'v8', 3010, 10, 4), ...named(3000, 10)]
    expect(ownTimes(e5, [...q.resizes, { start: 3000, ms: 10 }], []).resizes[10]).toMatchObject({ cpu: 0, own: 0 })
  })

  // Round 4, Opus mutant N13: the waits charged to a resize are the most the trace allows, not the least. A 18.5 ms
  // resize in a call of 10.3 ms of thread time, 10 of its wall in a wait of 10 ms of thread time and 20 of wall: the
  // wait's thread time can all lie before the resize, so 10 waited and 18.5 of its own (the least would make it 10.3).
  it('charges a resize the most wait the trace allows (the twin of the task test: 18.5 ms, 10 of a wait of thread time)', () => {
    const q = quiet()
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 3000, 30, 10.5), X('FunctionCall', 'devtools.timeline', 3000.1, 29.8, 10.3), X('WaitableEvent::Wait', 'base', 3001, 20, 10), ...named(3011, 18.5)]
    const resizes = [...q.resizes, { start: 3011, ms: 18.5 }]
    const v = dragVerdict(input({ events, resizes, resizeCount: resizes.length }))
    expect(v.own.resizes[10]).toMatchObject({ waited: 10, own: 18.75, by: 'FunctionCall 29.8/10.3' }) // the grain on
    expect(v.own.resizes[10].cpu).toBeCloseTo(10.3, 9)
    expect(fails(v, 'of its own (wall/own ms)')).toEqual(['18.5/18.8'])
  })

  // Round 4, Codex: a wait the trace logs as a begin and an end (B/E) was not a wait at all: a 20 ms resize with an 18 ms
  // one scored 2.
  it('pairs the begins and ends the trace logs into waits: a 20 ms resize with an 18 ms one scores 20', () => {
    const q = quiet()
    const B = (name: string, cat: string, start: number, tts?: number): TraceEvent => ({ name, cat, ph: 'B', ts: us(start), pid: 1, tid: 1, ...(tts === undefined ? {} : { tts: us(tts) }) })
    const E = (name: string, start: number, tts?: number): TraceEvent => ({ name, cat: '', ph: 'E', ts: us(start), pid: 1, tid: 1, ...(tts === undefined ? {} : { tts: us(tts) }) })
    const resizes = [...q.resizes, { start: 3000, ms: 20 }]
    const at = (wait: TraceEvent[]): ReturnType<typeof dragVerdict> => dragVerdict(input({ events: [...q.events, X('FunctionCall', 'devtools.timeline', 2999.9, 20.2, 2), ...named(3000, 20), ...wait], resizes, resizeCount: resizes.length }))
    const v = at([B('WaitableEvent::Wait', 'base', 3001), E('WaitableEvent::Wait', 3019)])
    expect(v.own.resizes[10]).toMatchObject({ waited: 18, own: 20.25 }) // 0.15 each side of the call charged, the grain on
    expect(v.own.resizes[10].cpu).toBeCloseTo(2.3, 9)
    expect(fails(v, 'of its own (wall/own ms)')).toEqual(['20.0/20.3'])
    expect(v.own.pairs).toEqual({ 'WaitableEvent::Wait': 1 })
    expect(v.own.unpaired).toEqual([])
    // The thread clocks of both give its thread time: 0.5 of the 18.
    expect(at([B('WaitableEvent::Wait', 'base', 3001, 100), E('WaitableEvent::Wait', 3019, 100.5)]).own.resizes[10]).toMatchObject({ waited: 17.5, own: 19.8 })
    // A begin the trace never ends runs to its last instant, waiting all of it: charged to the fit's task, excused nothing.
    const open = dragVerdict(input({ events: [...q.events, B('GLES2::Finish', 'gpu', 2510, 0)] }))
    expect(open.fits[0].gpu).toBe(70)
    expect(open.fits[0].waited).toBeCloseTo(77.5, 9)
    expect(open.own.unpaired).toEqual([{ kind: 'unclosed', name: 'GLES2::Finish', at: 1510 }])
    // An end with no begin open (Round 5) runs from the trace's first instant, waiting all of it: the fit's task waits
    // [2500,2510] too, and that much is no wait on the GPU.
    const lone = dragVerdict(input({ events: [...q.events, E('', 2510)] }))
    expect(lone.fits[0]).toMatchObject({ gpu: 70, matched: true })
    expect(lone.fits[0].waited).toBeCloseTo(77, 9)
    expect(lone.own.unpaired).toEqual([{ kind: 'lone', name: '', at: 1510 }])
  })

  // Round 5, Codex (d): an end closed the begin open whatever its name. A begin of a wait at +1, an end of another name
  // at +3 and the wait's end at +19, in a 20 ms resize of 2 ms of thread time, scored 4 (a 2 ms wait); a lone end of the
  // wait's name was dropped, 2. An end of another name and a lone end now wait from the trace's first instant, so 20.
  it('pairs a begin and an end only of one name: an end of another name or none open waits from the first instant (Codex: 4 and 2, now 20)', () => {
    const q = quiet()
    const B = (name: string, start: number): TraceEvent => ({ name, cat: 'base', ph: 'B', ts: us(start), pid: 1, tid: 1 })
    const E = (name: string, start: number): TraceEvent => ({ name, cat: 'base', ph: 'E', ts: us(start), pid: 1, tid: 1 })
    const resizes = [...q.resizes, { start: 3000, ms: 20 }]
    const at = (wait: TraceEvent[]): ReturnType<typeof dragVerdict> => dragVerdict(input({ events: [...q.events, X('FunctionCall', 'devtools.timeline', 2999.9, 20.2, 2), ...named(3000, 20), ...wait], resizes, resizeCount: resizes.length }))
    const crossed = at([B('WaitableEvent::Wait', 3001), E('Nested', 3003), E('WaitableEvent::Wait', 3019)])
    expect(crossed.own.resizes[10]).toMatchObject({ waited: 19.25, own: 20.25 }) // from the window's start, the grain on
    expect(fails(crossed, 'of its own (wall/own ms)')).toEqual(['20.0/20.3'])
    expect(crossed.own.unpaired).toEqual([{ kind: 'mismatched', name: 'Nested', at: 2003 }])
    expect(crossed.own.pairs).toEqual({ 'WaitableEvent::Wait': 1 })
    const lone = at([E('WaitableEvent::Wait', 3019)])
    expect(lone.own.resizes[10]).toMatchObject({ waited: 19.25, own: 20.25 })
    expect(fails(lone, 'of its own (wall/own ms)')).toEqual(['20.0/20.3'])
    expect(lone.own.unpaired).toEqual([{ kind: 'lone', name: 'WaitableEvent::Wait', at: 2019 }])
    // An end of another name on another thread is not the page's.
    expect(dragVerdict(input({ events: [...q.events, { ...E('Other', 3003), tid: 2 }] })).own.unpaired).toEqual([])
  })

  it('paired: an end closes the latest begin open on its thread of its name or of none, in the trace\'s order; the rest are waits to the edge', () => {
    const ev = (ph: string, name: string, ts: number, tid = 1, tts?: number): TraceEvent => ({ name, cat: 'base', ph, ts, pid: 1, tid, ...(tts === undefined ? {} : { tts }) })
    const x: TraceEvent = { name: 'x', cat: 'base', ph: 'X', ts: 8, dur: 2, pid: 1, tid: 1 }
    const r = paired([ev('E', 'a', 5, 1, 3), ev('B', 'b', 1, 1, 1), ev('E', 'b', 2, 1, 1.5), x, ev('B', 'a', 0, 1, 0), ev('B', 'c', 3, 2), ev('E', 'c', 4, 2, 9), ev('E', 'z', 0.5, 3), ev('B', 'd', 6, 1), ev('E', 'q', 7, 1, 7), ev('E', '', 7.5, 1)])
    const made = (name: string, ts: number, dur: number, tid: number, tdur?: number): TraceEvent => ({ name, cat: 'base', ph: 'X', ts, dur, ...(tdur === undefined ? {} : { tdur }), pid: 1, tid })
    // The lone end (z) and the one of another name than the open begin's (q) wait from the first instant, 0, closing
    // nothing; the unnamed end closes the begin open (d: an end of the JSON format may leave its name out, Round 6).
    expect(r.events).toEqual([made('z', 0, 0.5, 3), made('b', 1, 1, 1, 0.5), made('c', 3, 1, 2), made('a', 0, 5, 1, 3), made('q', 0, 7, 1), made('d', 6, 1.5, 1), x])
    expect([...r.open]).toEqual([made('z', 0, 0.5, 3), made('q', 0, 7, 1)])
    expect(r.pairs).toEqual(new Map([['1:1', new Map([['b', 1], ['a', 1], ['d', 1]])], ['1:2', new Map([['c', 1]])]]))
    expect(r.unpaired).toEqual([
      { kind: 'lone', name: 'z', ts: 0.5, thread: '1:3' },
      { kind: 'mismatched', name: 'q', ts: 7, thread: '1:1' },
    ])
    // A begin never ended runs to the last instant (d without the unnamed end: to 10).
    expect(paired([ev('B', 'd', 6, 1), x])).toMatchObject({ events: [x, made('d', 6, 4, 1)], unpaired: [{ kind: 'unclosed', name: 'd', ts: 6, thread: '1:1' }] })
    // A begin and an end at one instant pair in the trace's order.
    const later: TraceEvent = { name: 'y', cat: 'base', ph: 'X', ts: 4, dur: 1, pid: 1, tid: 1 }
    expect(paired([ev('B', 'p', 1), ev('E', 'p', 1), later])).toEqual({ events: [made('p', 1, 0, 1), later], open: new Set(), pairs: new Map([['1:1', new Map([['p', 1]])]]), unpaired: [] })
    expect(paired([])).toEqual({ events: [], open: new Set(), pairs: new Map(), unpaired: [] })
    // The first instant is the first event's, a thread's name (metadata) aside.
    const meta: TraceEvent = { ...META, ts: -5 }
    const y: TraceEvent = { name: 'y', cat: 'base', ph: 'X', ts: 1, dur: 1, pid: 1, tid: 1 }
    expect(paired([meta, y, ev('E', 'w', 3)]).events).toEqual([meta, y, made('w', 1, 2, 1)])
  })

  it('heldAll: the most thread time a set of tasks can hold, of nested ones the outer or its inner ones in all, the wall of one untimed', () => {
    const t = (ts: number, dur: number, tdur?: number): TraceEvent => ({ name: 'RunTask', cat: 'toplevel', ph: 'X', ts, dur, ...(tdur === undefined ? {} : { tdur }), pid: 1, tid: 1 })
    expect(heldAll([])).toBe(0)
    expect(heldAll([t(0, 10, 8), t(1, 5, 4)])).toBe(8) // nested: the outer
    expect(heldAll([t(1, 5, 4), t(0, 10, 3), t(6, 3, 2)])).toBe(6) // ... or its inner ones, whichever is more, in any order
    expect(heldAll([t(0, 10, 3), t(10, 1, 1)])).toBe(4) // side by side
    expect(heldAll([t(0, 10, 3), t(5, 10, 4)])).toBe(7) // overlapping: each
    expect(heldAll([t(0, 10), t(2, 3, 2)])).toBe(10) // untimed: its wall
    expect(heldAll([t(0, 10, 9), t(0, 10, 4)])).toBe(9) // the very bounds: one in the other
    expect(heldAll([t(0, 20, 1), t(1, 10, 2), t(2, 3, 5), t(12, 3, 1)])).toBe(6) // deeper: (5 or 2) and 1, over the outer's 1
    expect(heldAll([t(0, 5, 4), t(0, 10, 3)])).toBe(4) // the same start: the longer holds the shorter
  })

  // Round 4, Codex: 40 fits of 39 ms, each in a task of 40, too short to be long tasks, broke no rule.
  it('holds the thread time of all the drag\'s fits, each task once (40 fits of 39 ms in tasks of 40: 1567 ms)', () => {
    const q = quiet()
    const events = [...q.events]
    const fits = [...q.fits]
    for (let k = 0; k < 40; k++) {
      const t = 3000 + k * 100
      events.push(X('ThreadControllerImpl::RunTask', 'toplevel', t, 40, 39), ...fitNamed(t + 0.5, 39))
      fits.push({ start: t + 0.5, ms: 39 })
    }
    const v = dragVerdict(input({ events, fits }))
    expect(v.own).toMatchObject({ fitCpu: 1567, fitsTraced: 43 })
    expect(fails(v, 'ms of the thread in all')).toEqual(['1567 (43/43)'])
    expect(broken(v)).toHaveLength(1)
    expect(fails(dragVerdict(input({ events, fits: fits.slice(0, 7) })), 'ms of the thread in all')).toEqual([])
    expect(fails(dragVerdict(input({ events, fits: fits.slice(0, 8) })), 'ms of the thread in all')).toEqual(['202 (8/8)'])
  })

  // Round 11 (R11-3): a fit the trace names no measure of is placed in no task and fails the drag, its long task's or
  // not (Round 10 charged it 50 ms; Round 6 to 9 its long task's wall). Nothing is pulled in by the page's number.
  it("fails a fit the trace names no measure of, its long task's or not, and places two fits in one task once", () => {
    const q = quiet()
    // Two fits in the 2500 task: one task holding two; two the trace names no measure of in a 120 ms long task, one in
    // no task and one before every long task: dropped. A fit in a task in a task is the outer one's, charged at most
    // the outer's thread time less what the inner shows outside the fit (2.5), and one that ends 0.03 ms past its task
    // on the thread's clock is still in it (2).
    const fits = [...q.fits, { start: 2501.6, ms: 0.5 }, { start: 4000.5, ms: 1 }, { start: 4001.5, ms: 1 }, { start: 6000, ms: 1 }, { start: 1550, ms: 1 }, { start: 7002, ms: 2 }, { start: 8000.5, ms: 4.53 }]
    const events = [...q.events, ...fitNamed(2501.6, 0.5), X('ThreadControllerImpl::RunTask', 'toplevel', 7000, 10, 8), X('ThreadControllerImpl::RunTask', 'toplevel', 7001, 5, 4), ...fitNamed(7002, 2)]
    events.push(X('ThreadControllerImpl::RunTask', 'toplevel', 8000, 5, 2), ...fitNamed(8000.5, 4.53))
    const tasks = [FIT, { start: 4000, ms: 120 }]
    const own = ownTimes(events, q.resizes, tasks, fits)
    expect(own.fits.map((f) => f.reason ?? '')).toEqual(['', '', '', '', 'dropped', 'dropped', 'dropped', 'dropped', '', ''])
    expect(own).toMatchObject({ fitsTraced: 6, taskFit: [true, false] })
    expect(own.fitCpu).toBeCloseTo(5 + 1 + 1 + 1 + 4 * 1 + 2.5 + 2, 9)
    expect(own.fitTasks[0]).toMatchObject({ fits: 2, wall: 80 })
    const v = dragVerdict(input({ events, fits, tasks }))
    expect(fails(v, 'the trace places every fit')).toEqual(['4000.50+1.00 ms: dropped', '4001.50+1.00 ms: dropped', '6000.00+1.00 ms: dropped', '1550.00+1.00 ms: dropped'])
    // A fit the trace drops at 1500 on the page's clock, where a 3 ms task runs: dropped, the task not pulled in.
    expect(ownTimes(events, q.resizes, [FIT], [...q.fits, { start: 1500.2, ms: 1 }]).fits[3]).toEqual({ start: 1500.2, ms: 1, wall: 1, cpu: 1, gpu: 0, reason: 'dropped' })
    // A fit in no task the trace holds: untasked.
    expect(ownTimes([META, ...fitNamed(2500.5, 1)], [], [FIT], [{ start: 2500.5, ms: 1 }])).toMatchObject({ fitCpu: 1, fitsTraced: 0, fits: [{ reason: 'untasked' }] })
    expect(ownTimes(events, q.resizes, [])).toMatchObject({ fitCpu: 0, fitsTraced: 0, fits: [] })
  })

  // Round 4 data (diag 45983711383, 45983723838, 45983738302): a fit's measure, named from the page's coarsened clock,
  // began up to 0.17 ms before its task and ended up to 0.07 ms after it, so the 50 us slack left it in no task and
  // charged the fit its long task's wall (1142 ms of a drag whose fits' tasks took 31). Round 11 (R11-3): a fit in two
  // tasks, in none, or whose measure the trace drops fails the drag, charged its measure's wall.
  it("finds a fit's task by its measure within 0.25 ms; a measure across two tasks straddles, one in no task or none fails", () => {
    const q = quiet()
    const fits = [...q.fits, { start: 4000, ms: 120 }, { start: 5000, ms: 0.4 }, { start: 6000, ms: 150 }, { start: 7000, ms: 100 }]
    const events = [...q.events,
      // The measure 0.17 ms before its task's start and 0.07 ms past its end: placed, 3 of thread time, not the long
      // task's 13.24.
      X('ThreadControllerImpl::RunTask', 'toplevel', 4000.17, 119.76, 3), ...fitNamed(4000, 120),
      // Two tasks within 0.25 ms of a 0.4 ms measure, the shorter ending 0.15 ms into it, the other holding the rest of
      // it: the fit is neither's (Round 10), it straddles.
      X('ThreadControllerImpl::RunTask', 'toplevel', 4999.95, 0.2, 0.1), X('ThreadControllerImpl::RunTask', 'toplevel', 5000.15, 0.35, 2), ...fitNamed(5000, 0.4),
      // A measure the trace drops, in a long task whose own task the trace holds: dropped, and the long task holds no
      // fit (Round 9).
      X('ThreadControllerImpl::RunTask', 'toplevel', 5999, 152, 6),
      // A measure 0.3 ms before its task: in no task (untasked), and the long task holds no fit (Round 7).
      X('ThreadControllerImpl::RunTask', 'toplevel', 7000.3, 99.8, 4), ...fitNamed(7000, 100)]
    const long = [FIT, { start: 4000, ms: 130 }, { start: 5999, ms: 152 }, { start: 7000, ms: 101 }]
    const own = ownTimes(events, q.resizes, long, fits)
    expect(own.fitCpu).toBeCloseTo(7 + 3 + 0.4 + 150 + 100, 9)
    expect(own).toMatchObject({ fitsTraced: 4, taskFit: [true, true, false, false] })
    expect(own.fits.slice(3).map((f) => f.reason ?? '')).toEqual(['', 'straddles', 'dropped', 'untasked'])
    // The fit's task is held to a resize's limits, the fit's measure off: its long task's 130 on the wall and 13.24 of
    // its own (its task's 3, and the window outside the task) less 119.75.
    expect(own.fitTasks[3].restWall).toBeCloseTo(10.25, 9)
    expect(own.fitTasks[3]).toMatchObject({ wall: 130, fits: 1, restOwn: 0 })
    // 0.26 ms before and after: in no task (Round 4 to 9: its long task's wall, 110; Round 10: 50).
    const far = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000.26, 49, 3), ...fitNamed(4000, 49.52)]
    const out = ownTimes(far, q.resizes, [FIT, { start: 4000, ms: 110 }], [...q.fits, { start: 4000, ms: 49.52 }])
    expect(out).toMatchObject({ fitsTraced: 3, taskFit: [true, false], fits: [{}, {}, {}, { reason: 'untasked', cpu: 49.52 }] })
  })

  // Round 5, the property test's trace 1764: a fit whose measure the trace dropped, 0.44 ms before another fit of its
  // length, was paired with that one's measure, and its own task (0.38 ms of thread time) went uncharged. Round 10
  // (R10-4) charged a pairing in doubt 50 ms each; Round 11 (R11-1) names each fit's measure for it alone, so no fit is
  // paired with another's measure, and one whose name the trace drops fails.
  it("places a fit by its own name alone: another fit's measure of its length nearby is not its, and a long task around it holds it", () => {
    const q = quiet()
    const events = [...q.events,
      X('ThreadControllerImpl::RunTask', 'toplevel', 5000, 0.62, 0.38),
      X('ThreadControllerImpl::RunTask', 'toplevel', 5000.85, 0.4, 0.29), ...fitNamed(5001, 0.01)]
    const fits = [...q.fits, { start: 5000.56, ms: 0.01 }, { start: 5001, ms: 0.01 }]
    const own = ownTimes(events, q.resizes, [FIT], fits)
    expect(own.fitCpu).toBeCloseTo(7 + 0.01 + 0.29, 9)
    expect(own).toMatchObject({ fitsTraced: 4, fits: [{}, {}, {}, { reason: 'dropped' }, { cpu: 0.29 }] })
    expect(own.fits[4].reason).toBeUndefined()
    // A long task around both: the fit named is its, and the long task is judged by what is left of it, the fit's
    // measure off (none of it, 0.01 ms being under the grain): 51.3 on the wall and 30 of its own, over a resize's
    // limits (Round 5 to 9 charged its 30 to the fits; Round 10 judged it as a task with none).
    const long = [...events, X('ThreadControllerImpl::RunTask', 'toplevel', 4950, 51.3, 30)]
    const v = dragVerdict(input({ events: long, tasks: [FIT, { start: 4950, ms: 51.3 }], fits }))
    expect(v.own.taskFit).toEqual([true, true])
    expect(v.own.fitTasks[3]).toMatchObject({ wall: 51.3, own: 30, fits: 1, off: 0 })
    expect(fails(v, 'takes under 16 ms of its own (wall/own ms less')).toEqual(['51.3/30.0 less 0.0 of 1 fit'])
    expect(fails(v, 'takes under 50 ms on the wall (wall/own ms less')).toEqual(['51.3/30.0 less 0.0 of 1 fit'])
    expect(fails(v, 'the trace places every fit')).toEqual(['5000.56+0.01 ms: dropped'])
    // Two measures of its length within 0.5 ms of one fit (0.45 before, 0.3 after), neither of its name: dropped.
    const two = [...q.events, ...fitNamed(6999.55, 0.92), ...fitNamed(7000.3, 0.95), X('ThreadControllerImpl::RunTask', 'toplevel', 6999.6, 0.64, 0.3)]
    expect(ownTimes(two, q.resizes, [FIT], [...q.fits, { start: 7000, ms: 1 }])).toMatchObject({ fitCpu: 8, fitsTraced: 3, fits: [{}, {}, {}, { reason: 'dropped' }] })
  })

  // Round 10 (R10-3): no number of the page's is put on the thread's clock to pull in a task for a fit. Round 5 to 9
  // charged a fit the trace names no measure of the tasks within 0.75 ms of where the page puts it; Round 10 50 ms.
  it("fails a fit the trace names no measure of, whatever task runs where the page puts it, and no other thread's measure is the page's", () => {
    const q = quiet()
    const lost = [...q.fits, { start: 6000, ms: 2 }]
    for (const at of [6000, 6000.5, 6000.8]) expect(ownTimes([...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', at, 1, 0.4)], q.resizes, [FIT], lost)).toMatchObject({ fitCpu: 9, fitsTraced: 3, fits: [{}, {}, {}, { reason: 'dropped' }] })
    // One measure on the page's thread and one alike on another: the fit is the page thread's, charged the task around
    // its measure (0.5) and not the one before it (0.2).
    const tasks = [X('ThreadControllerImpl::RunTask', 'toplevel', 8000.35, 1.2, 0.5), X('ThreadControllerImpl::RunTask', 'toplevel', 7999.8, 0.5, 0.2)]
    const other = [...q.events, ...fitNamed(8000.4, 1), ...named(8000.4, 1, 2, BUFFER_FIT_MEASURE), ...tasks]
    const own = ownTimes(other, q.resizes, [FIT], [...q.fits, { start: 8000.4, ms: 1 }])
    expect(own).toMatchObject({ fitsTraced: 4, fits: [{}, {}, {}, { cpu: 0.5 }] })
    expect(own.fitCpu).toBeCloseTo(7.5, 9)
    // Its name recorded on the other thread alone: unmatched.
    const theirs = ownTimes([...q.events, ...named(8000.4, 1, 2, BUFFER_FIT_MEASURE), ...tasks], q.resizes, [FIT], [...q.fits, { start: 8000.4, ms: 1 }])
    expect(theirs).toMatchObject({ fitsTraced: 3, fits: [{}, {}, {}, { reason: 'unmatched', cpu: 1 }] })
  })

  // Round 5, Codex (a): six fits, each at the end of a 40 ms task of 39 ms of thread time, its measure 0.15 ms late, so
  // it lies 0.05 ms in that task and 0.15 in the 0.2 ms task after it (0.1 of thread time). Round 6, Opus m6-1: the six
  // fits with their measures 0.26 ms past the 40 ms task's end and 0.30 past the 0.2 ms task's start, charged 241.6 when
  // the resizes disagreed on the clock's offset; Round 10 charged them 50 each when the page's one resize was in doubt.
  // Round 11 (R11-1): no clock is put together from the resizes, so nothing about them moves a fit: each lies in the
  // 0.2 ms task, 0.1 of thread time, 7.6 in all.
  it("places each fit by its name whatever the page's resizes (Opus m6-1: 7.6; Round 6 to 9 241.6 on drift, Round 10 450 on one resize; now 7.6)", () => {
    const q = quiet()
    const events = [...q.events]
    const fits = [...q.fits]
    for (let k = 0; k < 6; k++) {
      const t = 3000 + k * 100
      events.push(X('ThreadControllerImpl::RunTask', 'toplevel', t, 40, 39), X('ThreadControllerImpl::RunTask', 'toplevel', t + 40, 0.2, 0.1), ...fitNamed(t + 40.26, 0.04))
      fits.push({ start: t + 40.26, ms: 0.04 })
    }
    const all = dragVerdict(input({ events, fits }))
    expect(all.own).toMatchObject({ traced: 10, fitsTraced: 9 })
    expect(all.own.fitCpu).toBeCloseTo(7 + 6 * 0.1, 9)
    expect(all.own.fitTasks.slice(3)).toEqual(Array(6).fill({ wall: 0.2, own: 0.1, fits: 1, off: 0, restWall: 0.2, restOwn: 0.1 }))
    expect(broken(all)).toEqual([])
    // The page's sixth resize 0.625 ms earlier than the trace puts it: its name is not recorded, so it is timed on the
    // wall, and the fits are still their measures'.
    const out = dragVerdict(input({ events, fits, resizes: q.resizes.map((r, i) => (i !== 5 ? r : { ...r, start: r.start - 0.625 })) }))
    expect(out.own).toMatchObject({ traced: 9, fitsTraced: 9 })
    expect(out.own.fitCpu).toBeCloseTo(7 + 6 * 0.1, 9)
    expect(broken(out)).toEqual([])
    // One resize of the page's against the trace's ten alike: its own name finds it, and the fits are placed.
    const one = dragVerdict(input({ events, fits, resizes: [q.resizes[0]], resizeCount: 1 }))
    expect(one.own).toMatchObject({ traced: 1, fitsTraced: 9 })
    expect(one.own.fitCpu).toBeCloseTo(7 + 6 * 0.1, 9)
    expect(broken(one)).toEqual([])
  })

  // Round 6, Codex: a fit's long task [4000,4200], the task the trace holds over most of it from 4000 to 4150 (125 ms of
  // thread time), and the fit's measure in another task inside it, of 25: the fit's task was charged (25), though the
  // long task scored 175 (its task's 125 and the 50 ms of its window outside it). Round 6 to 10 charged the fits at
  // least what it scores. Round 11 (R11-2): a fit exempts only its measured time, so the long task that holds it (the
  // outer task the fit's measure lies in) is held to a resize's limits, the fit's measure less the grain off.
  it('holds a task with fits to what its long task scores, the fits off (Codex: 25; Round 6 to 10 175 to the fits; now 200/175 less 0.75)', () => {
    const q = quiet()
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 150, 125), X('ThreadControllerImpl::RunTask', 'toplevel', 4100, 25, 25), ...fitNamed(4110, 1)]
    const tasks = [FIT, { start: 4000, ms: 200, fit: true }]
    const v = dragVerdict(input({ events, tasks, fits: [...q.fits, { start: 4110, ms: 1 }] }))
    expect(v.fits[1]).toMatchObject({ wall: 200, cpu: 175, own: 175, matched: true })
    // The fit's own thread time is in its measure alone (1.5 at most, the grain on each side); its task, the outer one,
    // is the long task's 200 on the wall and 175 of its own, less the fit's 0.75.
    expect(v.own).toMatchObject({ fitCpu: 7 + 1.5, fitsTraced: 4 })
    expect(v.own.fitTasks[3]).toEqual({ wall: 200, own: 175, fits: 1, off: 0.75, restWall: 199.25, restOwn: 174.25 })
    expect(fails(v, 'takes under 16 ms of its own (wall/own ms less')).toEqual(['200.0/175.0 less 0.8 of 1 fit'])
    expect(fails(v, 'takes under 50 ms on the wall (wall/own ms less')).toEqual(['200.0/175.0 less 0.8 of 1 fit'])
    // Two fits in it: the task once, both fits off.
    const two = [...events, X('ThreadControllerImpl::RunTask', 'toplevel', 4130, 10, 10), ...fitNamed(4135, 1)]
    const both = dragVerdict(input({ events: two, tasks, fits: [...q.fits, { start: 4110, ms: 1 }, { start: 4135, ms: 1 }] }))
    expect(both.own.fitCpu).toBeCloseTo(7 + 3, 9)
    expect(both.own.fitTasks).toHaveLength(4)
    expect(both.own.fitTasks[3]).toMatchObject({ wall: 200, own: 175, fits: 2, off: 1.5 })
    // Its task of little thread time (10): its long task's score still, 10 and the 50 outside.
    const heavy = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 150, 10), X('ThreadControllerImpl::RunTask', 'toplevel', 4100, 25, 25), ...fitNamed(4110, 1)]
    expect(dragVerdict(input({ events: heavy, tasks, fits: [...q.fits, { start: 4110, ms: 1 }] })).own.fitTasks[3]).toMatchObject({ wall: 200, own: 60 })
    // A fit the trace dropped the measure of, at its long task's task's end: it fails (Round 10: 50; Round 6 to 9 the
    // tasks around where the page puts it, 80), and the long task holds no fit, so it is judged as a task with none.
    const edge = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 99.4, 60), X('ThreadControllerImpl::RunTask', 'toplevel', 4099.45, 1.55, 20)]
    const lost = dragVerdict(input({ events: edge, tasks: [FIT, { start: 4000, ms: 100, fit: true }], fits: [...q.fits, { start: 4099.5, ms: 0.1 }] }))
    expect(lost.own).toMatchObject({ taskFit: [true, false] })
    expect(fails(lost, 'the trace places every fit')).toEqual(['4099.50+0.10 ms: dropped'])
  })

  // Round 7, Codex and Opus: the page tags a long task the fit's when a fit lies within 1 ms of it, and the check took
  // the page's tag. A 400 ms task, 4 ms of thread time and 395 waiting on the GPU, with a timer's fit begun 0.4 ms after
  // it (as one begins after a stall) was judged by the fit's limits and passed: 4 ms of thread time, 9 on the wall beyond
  // its waits on the GPU. The trace holds the task, and the fit's measure lies outside it: it is judged by the limits of
  // a task that holds none, 399 of its own and 400 on the wall, and fails both.
  it("judges a long task the trace holds by the trace, not the page's 1 ms (Codex Round 7: a 400 ms stall passed as a fit's, 4 / 9; now 400/399 and 400)", () => {
    const q = quiet()
    const STALL = { start: 3000, ms: 400, fit: true }
    const stall = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 3000, 400, 4), X('CommandBufferProxyImpl::WaitForGetOffset', 'gpu', 3002, 395, 0.01)]
    // The timer's fit after it in a task of its own, its measure `after` ms past the stall's end.
    const at = (after: number, over: Partial<DragInput> = {}): ReturnType<typeof dragVerdict> => dragVerdict(input({
      events: [...stall, X('ThreadControllerImpl::RunTask', 'toplevel', 3400 + after - 0.1, 0.5, 0.3), ...fitNamed(3400 + after, 0.03)],
      tasks: [FIT, STALL],
      fits: [...q.fits, { start: 3400 + after, ms: 0.03 }],
      ...over,
    }))
    const v = at(0.4)
    expect(v.own.taskFit).toEqual([true, false])
    expect(v.others).toEqual([expect.objectContaining({ wall: 400, matched: true })])
    expect(v.others[0].own).toBeCloseTo(399, 1)
    expect(fails(v, "of its own, the fit's left out")).toEqual(['400/399'])
    expect(fails(v, "on the wall, the fit's left out")).toEqual(['400'])
    expect(broken(v)).toHaveLength(2)
    expect(v.fits).toEqual([dragVerdict(input()).fits[0]])
    expect(v.retagged).toEqual([{ start: 3000, ms: 400, page: true }])
    // Round 7 to 9's residual (note (10)): a measure begun within FIT_SLACK after the stall's end tagged it, and the stall
    // passed as the fit's. Round 10 (R10-1): the measure lies whole in its own task too, so it lies across two tasks to
    // the grain, straddles, and tags neither; the stall fails, and (Round 11, R11-3) so does the fit. 0.26 ms after, it
    // is its own task's alone.
    const near = at(0.2)
    expect(near.own.taskFit).toEqual([true, false])
    expect(fails(near, 'the trace places every fit')).toEqual(['3400.20+0.03 ms: straddles'])
    expect(fails(near, "of its own, the fit's left out")).toEqual(['400/399'])
    expect(at(0.26).own.taskFit).toEqual([true, false])
    expect(fails(at(0.26), 'the trace places every fit')).toEqual([])
    // The measure dropped: the fit gives the long task none (Round 9; Round 7 and 8 put the page's number on the
    // thread's clock, so in the task it tagged it), after the task (0.4 ms), in it, or ending past it; and it fails.
    const dropped = (start: number, ms = 0.03): ReturnType<typeof dragVerdict> => dragVerdict(input({ events: stall, tasks: [FIT, STALL], fits: [...q.fits, { start, ms }] }))
    for (const [start, ms] of [[3400.4, 0.03], [3399.9, 0.03], [3399.5, 0.6]]) {
      expect(dropped(start, ms).own.taskFit).toEqual([true, false])
      expect(fails(dropped(start, ms), 'the trace places every fit')).toEqual([`${start.toFixed(2)}+${ms.toFixed(2)} ms: dropped`])
    }
    // A long task the trace does not hold: no fit is its (Round 10: a fit is only a task's the trace holds; Round 7 to 9
    // let the page's 1 ms decide), measured or not, and it is judged on the wall as a task with none. (Tagged no fit's
    // here, so input adds it none.)
    const lost = (start: number, measured = true): ReturnType<typeof dragVerdict> => dragVerdict(input({ events: [...q.events, ...(measured ? fitNamed(start, 0.03) : [])], tasks: [FIT, { start: 9000, ms: 400, fit: false }], fits: [...q.fits, { start, ms: 0.03 }] }))
    for (const [start, measured] of [[9400.9, true], [9200, true], [8999, true], [9200, false]] as const) expect(lost(start, measured).own.taskFit).toEqual([true, false])
    expect(fails(lost(9200), 'the trace places every fit')).toEqual(['9200.00+0.03 ms: untasked'])
    expect(fails(lost(9200, false), 'the trace places every fit')).toEqual(['9200.00+0.03 ms: dropped'])
    expect(fails(lost(9200), "of its own, the fit's left out")).toEqual(['400/400'])
    // A quiet drag retags nothing; one the page tags wrongly the other way is the fit's by the trace, and logged.
    expect(dragVerdict(input()).retagged).toEqual([])
    const other = dragVerdict(input({ tasks: [{ ...FIT, fit: false }] }))
    expect(other.retagged).toEqual([{ start: 2500, ms: 80, page: false }])
    expect(other.fits).toHaveLength(1)
    expect(broken(other)).toEqual([])
  })

  // Round 9, Codex (a21-codex-review.md "Round 9"): Round 8 put the page's number for a fit whose measure the trace
  // dropped on the trace's clock when the clock read settled, and each of Codex's probes let a 400 ms stall pass as the
  // fit's: (a) a spread of exactly 0.125 ms, a 0.010 ms fit 0.350 ms after the stall put 0.225 ms after it, inside
  // FIT_SLACK; (b) one resize paired, a spread of 0; (c) a resize 0.625 ms off left out of the vote by the 0.5 ms
  // window, the other nine agreeing, and the fit's own measure, as far off, outside the window and taken as dropped.
  // Round 11 (R11-1, R11-3): there is no clock to settle, each fit's measure is found by its own name, and a fit the
  // trace does not place fails the drag; a fit placed in the stall exempts only its measure (R11-2), so the stall that
  // holds one fails a resize's limits.
  it("gives a long task no fit from a fit whose measure the trace dropped, and a stall that holds one keeps its time (Codex Round 9: (a) spread 0.125, (b) one pair, (c) a resize out of the window)", () => {
    const q = quiet()
    const STALL = { start: 3000, ms: 400, fit: true }
    const stall = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 3000, 400, 4), X('CommandBufferProxyImpl::WaitForGetOffset', 'gpu', 3002, 395, 0.01)]
    const run = (fit: { start: number; ms: number }, over: Partial<DragInput> = {}, events = stall): ReturnType<typeof dragVerdict> => dragVerdict(input({ events, tasks: [FIT, STALL], fits: [...q.fits, fit], ...over }))
    const failsOnTheStall = (v: ReturnType<typeof dragVerdict>): void => {
      expect(v.own.taskFit).toEqual([true, false])
      expect(fails(v, "of its own, the fit's left out")).toEqual(['400/399'])
      expect(fails(v, "on the wall, the fit's left out")).toEqual(['400'])
      expect(v.retagged).toEqual([{ start: 3000, ms: 400, page: true }])
    }
    const holdsTheStall = (v: ReturnType<typeof dragVerdict>): void => {
      expect(v.own.taskFit).toEqual([true, true])
      expect(fails(v, 'takes under 16 ms of its own (wall/own ms less')).toEqual(['400.0/399.0 less 0.0 of 1 fit'])
      expect(fails(v, 'takes under 50 ms on the wall (wall/own ms less')).toEqual(['400.0/399.0 less 0.0 of 1 fit'])
    }
    const placed = (v: ReturnType<typeof dragVerdict>): string[] => fails(v, 'the trace places every fit')
    // (a) A dropped 0.010 ms fit 0.350 ms after the stall, the page's resizes 0.125 ms off or not: the stall fails both
    // limits of a task with none, and the fit fails.
    for (const over of [{}, { resizes: q.resizes.map((r, i) => (i < 6 ? { ...r, start: r.start + 0.125 } : r)) }]) {
      const a = run({ start: 3400.35, ms: 0.01 }, over)
      failsOnTheStall(a)
      expect(placed(a)).toEqual(['3400.35+0.01 ms: dropped'])
    }
    // (b) One resize named: the quiet drag's fit is still placed (Round 10: no clock, so it was unmatched), and a dropped
    // fit 0.15 ms after the stall fails as above.
    const b = run({ start: 3400.15, ms: 0.03 }, { resizes: [q.resizes[0]], resizeCount: 1 })
    expect(b.own).toMatchObject({ traced: 1, fitsTraced: 3 })
    failsOnTheStall(b)
    expect(placed(b)).toEqual(['3400.15+0.03 ms: dropped'])
    // (c) The page's sixth resize 0.625 ms early: it is not recorded, so it is timed on the wall. A dropped fit 0.15 ms
    // after the stall; then a measure 0.6 ms after where the page puts the fit, in a task of its own, not of its name:
    // the fit is dropped all the same.
    const drift = { resizes: q.resizes.map((r, i) => (i !== 5 ? r : { ...r, start: r.start - 0.625 })) }
    const c = run({ start: 3400.15, ms: 0.03 }, drift)
    expect(c.own).toMatchObject({ traced: 9 })
    failsOnTheStall(c)
    expect(placed(c)).toEqual(['3400.15+0.03 ms: dropped'])
    const real = [...stall, X('ThreadControllerImpl::RunTask', 'toplevel', 3400.7, 0.2, 0.1), ...fitNamed(3400.75, 0.03)]
    const cReal = run({ start: 3400.15, ms: 0.03 }, drift, real)
    failsOnTheStall(cReal)
    expect(placed(cReal)).toEqual(['3400.15+0.03 ms: dropped'])
    // Nor is another fit's measure of its length (or of another length) this fit's.
    const taken = run({ start: 3400.15, ms: 0.03 }, { fits: [...q.fits, { start: 3400.15, ms: 0.03 }, { start: 3401, ms: 0.03 }] }, [...stall, ...fitNamed(3401, 0.03)])
    expect(placed(taken)).toEqual(['3400.15+0.03 ms: dropped', '3401.00+0.03 ms: untasked'])
    const other = run({ start: 3400.15, ms: 0.03 }, {}, [...stall, ...fitNamed(3401, 0.5)])
    failsOnTheStall(other)
    expect(placed(other)).toEqual(['3400.15+0.03 ms: dropped'])
    // A traced fit's measure in the stall makes it the fit's, though a dropped fit's page number is in it too: the
    // stall is held to a resize's limits, the fit's 0.03 ms off (none, under the grain), and the dropped fit fails.
    const both = dragVerdict(input({ events: [...stall, ...fitNamed(3399.9, 0.03)], tasks: [FIT, STALL], fits: [...q.fits, { start: 3399.9, ms: 0.03 }, { start: 3399.3, ms: 0.03 }] }))
    holdsTheStall(both)
    expect(placed(both)).toEqual(['3399.30+0.03 ms: dropped'])
    // A fit with its measure in the stall's task and another fit's alike past it (Round 10: in doubt, so neither): its
    // own name puts it in the stall, which keeps its time.
    const two = run({ start: 3399.9, ms: 0.03 }, {}, [...stall, ...fitNamed(3399.9, 0.03), X('ThreadControllerImpl::RunTask', 'toplevel', 3400.3, 0.2, 0.1), ...fitNamed(3400.32, 0.03)])
    holdsTheStall(two)
    expect(placed(two)).toEqual([])
    // A fit traced, its measure in the stall's task, whatever the page's resizes: the stall is the fit's task and keeps
    // its 399 (Round 9 and 10 passed it as the fit's: the GPU stall a fit inherited, R11-2).
    const inside = [...stall, ...fitNamed(3399.9, 0.03)]
    for (const over of [{}, drift, { resizes: q.resizes.slice(3, 5), resizeCount: 2 }]) {
      const v = run({ start: 3399.9, ms: 0.03 }, over, inside)
      holdsTheStall(v)
      expect(placed(v)).toEqual([])
      expect(broken(v)).toHaveLength(2)
    }
    // A fit dropped outside any long task the page tags fails all the same; a quiet drag places all its fits.
    expect(placed(run({ start: 3500, ms: 0.03 }))).toEqual(['3500.00+0.03 ms: dropped'])
    expect(dragVerdict(input()).own).toMatchObject({ fitsTraced: 3, recorded: { resize: 10, task: 1, fit: 3 } })
  })

  // Round 10, Codex (a21-codex-review.md "Round 10", job d07a14d72cfc13ab-8127b6e5f18f), each probe rebuilt by name.
  // Chromium gives a measure's begin and end its id as `id`, as `id2.local` or `id2.global`, or none: each pairs.
  it("pairs each recorded span's begin and end by its id, its global id, or none", () => {
    const q = quiet()
    const page = indexed(q.events, q.resizes, [], q.fits).map((e): TraceEvent => {
      if (!e.name.startsWith(`${MARKER}:resize:`)) return e
      const k = Number(e.name.split(':').pop())
      return k % 3 === 0 ? e : k % 3 === 1 ? { ...e, id: undefined, id2: { global: e.id as string } } : { ...e, id: undefined }
    })
    const own = ownTimesOf([...page, ...markOf(page, [...q.resizes, ...q.fits])], q.resizes, [], q.fits, MARKER)
    expect(own.traced).toBe(10)
    expect(own.resizes.every((r) => r.matched)).toBe(true)
  })

  describe('Round 11 probes (signoff-decisions.md "A2.1 R11")', () => {
    const run = (start: number, dur: number, tdur: number): TraceEvent => X('ThreadControllerImpl::RunTask', 'toplevel', start, dur, tdur)
    const gpu = (start: number, dur: number): TraceEvent => W('CommandBufferProxyImpl::WaitForGetOffset', 'gpu', start, dur)

    // HIGH R10-2 dragTrace.ts:389: a fit the trace names no measure of, or one not of the page's length, only gave
    // diagnostics and a 50 ms charge, and the drag passed. R11-3: each fails it, with its reason.
    it('fails a fit the trace drops, and one it names at another length (Codex: both passed)', () => {
      const q = quiet()
      const f = { start: 3000.1, ms: 1 }
      const dropped = dragVerdict(input({ events: [...q.events, run(3000, 4, 4)], fits: [...q.fits, f] }))
      expect(fails(dropped, 'the trace places every fit')).toEqual(['3000.10+1.00 ms: dropped'])
      const unmatched = dragVerdict(input({ events: [...q.events, run(3000, 4, 4), ...fitNamed(3000.1, 1.2)], fits: [...q.fits, f] }))
      expect(fails(unmatched, 'the trace places every fit')).toEqual(['3000.10+1.00 ms: unmatched'])
      expect(unmatched.own.fits[3]).toMatchObject({ reason: 'unmatched', cpu: 1 })
    })

    // A span is the page's when the trace names its measure once (note (10)(j)(h)): one named twice, each of the page's
    // length on its thread, is unmatched, whichever of the two the work is in.
    it('a span the trace names twice is unmatched, both of the page\'s length: a fit fails, a resize is timed on the wall', () => {
      const q = quiet()
      const f = { start: 3000.1, ms: 1 }
      const once = dragVerdict(input({ events: [...q.events, run(3000, 4, 4), ...fitNamed(3000.1, 1)], fits: [...q.fits, f] }))
      expect(fails(once, 'the trace places every fit')).toEqual([])
      const twice = dragVerdict(input({ events: [...q.events, run(3000, 4, 4), ...fitNamed(3000.1, 1), ...named(3000.1, 1, 1, pageMeasure(MARKER, 'fit', 3))], fits: [...q.fits, f] }))
      expect(fails(twice, 'the trace places every fit')).toEqual(['3000.10+1.00 ms: unmatched'])
      expect(twice.own.recorded.fit).toBe(3)
      const r0 = q.resizes[0]
      const own = ownTimes([...q.events, ...named(r0.start, r0.ms, 1, pageMeasure(MARKER, 'resize', 0))], q.resizes, [FIT], q.fits)
      expect(own.resizes[0]).toMatchObject({ matched: false, own: r0.ms })
      expect(own.resizes.slice(1).every((x) => x.matched)).toBe(true)
      expect(own.recorded.resize).toBe(q.resizes.length - 1)
    })

    // HIGH R10-1 dragTrace.ts:390: a measure across two tasks by more than the grain fell to untasked, charged its wall
    // (0.6), and the 200 ms of thread time around it passed. R11-3: it fails the drag, and both long tasks, holding no
    // fit, are judged as tasks with none (100 ms each, under a task's limits).
    it('fails a wide straddle, untasked, and judges both tasks as ones with no fit (Codex: 57 ms in all, passed)', () => {
      const q = quiet()
      const f = { start: 3099.7, ms: 0.6 }
      const v = dragVerdict(input({ events: [...q.events, run(3000, 100, 100), run(3100, 100, 100), ...fitNamed(f.start, f.ms)], fits: [...q.fits, f], tasks: [FIT, { start: 3000, ms: 100, fit: true }, { start: 3100, ms: 100, fit: true }] }))
      expect(fails(v, 'the trace places every fit')).toEqual(['3099.70+0.60 ms: untasked'])
      expect(v.own.taskFit).toEqual([true, false, false])
      expect(v.own.tasks.slice(1).map((t) => [t.wall, t.own])).toEqual([[100, 100], [100, 100]])
      expect(broken(v)).toEqual([expect.stringContaining('the trace places every fit')])
      expect(v.own.fitCpu).toBeCloseTo(7 + 0.6, 9)
    })

    // MEDIUM dragTrace.ts:293-303: one resize's measure dropped, evenly spaced resizes tied the clock offset with a
    // one-period alias, every pairing was rejected and the fits' attribution lost. R11-1: the page records its spans into
    // the trace on its clock, so there is no offset to find: the nine named are traced, the fits placed, nothing fails.
    it('traces the nine resizes named and places every fit when the first resize\'s measure is dropped (Codex: 0/10, 0/3)', () => {
      const q = quiet()
      const v = dragVerdict(input({ events: q.events.filter((e) => !(e.name === RESIZE_MEASURE && e.ts < us(1050))) }))
      expect(v.own).toMatchObject({ traced: 9, fitsTraced: 3 })
      expect(v.own.resizes[0].matched).toBe(false)
      expect(v.own.fits.every((f) => !f.reason)).toBe(true)
      expect(broken(v)).toEqual([])
    })

    // LOW dragTrace.ts:332-344: a coarsened measure 0.2 ms late omitted the first 0.2 ms of a 16.1 ms resize, scored 15.9,
    // and passed. Round 11: its thread time is taken over the measure widened by the grain each side, at most its wall and
    // the grain: 16.35, and it fails.
    it('charges a resize the work the grain before its measure holds (Codex: 16.1 ms of thread time scored 15.9, passed)', () => {
      const q = quiet()
      const r = { start: 3200.2, ms: 16.1 }
      const v = dragVerdict(input({ events: [...q.events, run(3200, 16.4, 16.1), X('FunctionCall', 'devtools.timeline', 3200, 0.2, 0.2), ...named(r.start, r.ms)], resizes: [...q.resizes, r], resizeCount: q.resizes.length + 1 }))
      expect(v.own.resizes[10].own).toBeGreaterThanOrEqual(16)
      expect(fails(v, 'each resize takes under 16 ms of its own')).toHaveLength(1)
    })

    // HIGH R10-2: a dropped measure in a task of 196 ms of thread time took the task under the fit's limits, 57 ms in all,
    // and passed. R11-3: the fit fails the drag, and its task, holding no fit placed, is judged as one with none (196 ms of
    // its own, under a task's 200).
    it('fails a dropped fit in a task of 196 ms of thread time, and judges the task as one with no fit (Codex: passed)', () => {
      const q = quiet()
      const f = { start: 3000.1, ms: 1 }
      const v = dragVerdict(input({ events: [...q.events, run(3000, 198, 196)], fits: [...q.fits, f], tasks: [FIT, { start: 3000, ms: 198, fit: true }] }))
      expect(fails(v, 'the trace places every fit')).toEqual(['3000.10+1.00 ms: dropped'])
      expect(v.own.taskFit).toEqual([true, false])
      expect(v.own.tasks[1]).toMatchObject({ wall: 198, own: 196 })
      expect(broken(v)).toEqual([expect.stringContaining('the trace places every fit')])
    })

    // HIGH R10-1: the fit's own task missing from the trace, a measure 0.15 ms after the 400 ms GPU stall ended was the
    // stall's to the grain, and the stall passed under the fit's exemption. R11-2: only the fit's measured time is the
    // fit's, so the stall keeps its 400 ms and fails as a task holding a fit.
    it('places a fit whose own task is missing in the stall before it, and the stall fails on its remainder (Codex: passed)', () => {
      const q = quiet()
      const f = { start: 3400.15, ms: 0.05 }
      const v = dragVerdict(input({ events: [...q.events, run(3000, 400, 4), gpu(3001, 395), ...fitNamed(f.start, f.ms)], fits: [...q.fits, f], tasks: [FIT, { start: 3000, ms: 400, fit: false }, { start: 3400, ms: 80, fit: true }] }))
      expect(fails(v, 'the trace places every fit')).toEqual([])
      expect(v.own.taskFit).toEqual([true, true, false])
      expect(v.own.fitTasks[3]).toMatchObject({ wall: 400, own: 399, fits: 1, off: 0, restWall: 400, restOwn: 399 })
      expect(fails(v, 'takes under 16 ms of its own (wall/own ms less')).toEqual(['400.0/399.0 less 0.0 of 1 fit'])
      expect(fails(v, 'takes under 50 ms on the wall (wall/own ms less')).toEqual(['400.0/399.0 less 0.0 of 1 fit'])
    })
  })

  describe('Round 10 probes (signoff-decisions.md "A2.1 R10")', () => {
    const STALL = { start: 3000, ms: 400, fit: true }
    const stallOf = (): TraceEvent[] => [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 3000, 400, 4), X('CommandBufferProxyImpl::WaitForGetOffset', 'gpu', 3002, 395, 0.01)]

    // MAJOR dragTrace.ts:399: a fit 0.15 ms into the task after the stall, 0.05 ms long, tagged both tasks, so the 400 ms
    // stall passed under the fit's limits. R10-1: a measure across a task's edge to the grain straddles, tags neither;
    // R11-3: and fails the drag.
    it('adjacent: a fit 0.15 ms into the next task straddles the stall\'s edge, tags neither, and fails, and the stall fails both limits of a task with none', () => {
      const q = quiet()
      const v = dragVerdict(input({ events: [...stallOf(), X('ThreadControllerImpl::RunTask', 'toplevel', 3400, 0.5, 0.3), ...fitNamed(3400.15, 0.05)], tasks: [FIT, STALL], fits: [...q.fits, { start: 3400.15, ms: 0.05 }] }))
      expect(v.own.taskFit).toEqual([true, false])
      expect(fails(v, "of its own, the fit's left out")).toEqual(['400/399'])
      expect(fails(v, "on the wall, the fit's left out")).toEqual(['400'])
      expect(fails(v, 'the trace places every fit')).toEqual(['3400.15+0.05 ms: straddles'])
      // The fit charged its measure's wall (Round 10: both tasks, 4 and 0.3).
      expect(v.own.fitCpu).toBeCloseTo(7 + 0.05, 9)
    })

    // A measure of no length (an async instant, as Chromium traces one) on the instant one task ends and the next begins.
    it('a zero-length measure on the instant two tasks share straddles both', () => {
      const q = quiet()
      const instant: TraceEvent = { name: BUFFER_FIT_MEASURE, cat: 'blink.user_timing', ph: 'n', ts: us(3400), pid: 1, tid: 1, id2: { local: '0xfeed' } }
      const v = dragVerdict(input({ events: [...stallOf(), X('ThreadControllerImpl::RunTask', 'toplevel', 3400, 0.5, 0.3), instant], tasks: [FIT, STALL], fits: [...q.fits, { start: 3400, ms: 0 }] }))
      expect(v.own.taskFit).toEqual([true, false])
      expect(fails(v, 'the trace places every fit')).toEqual(['3400.00+0.00 ms: straddles'])
      expect(broken(v)).toHaveLength(3)
    })

    // MAJOR dragTrace.ts:373: a real 400 ms fit bound on the GPU (4 ms of thread time) whose measure lies 0.625 ms from
    // where the page puts it is unmatched, and fails; a dropped measure the same. R10-2: no change, as ruled in R9.
    // R11: a fit whose name the trace does not hold fails itself; one placed in the stall exempts only its measure, so
    // the stall keeps its 399 and fails a resize's limits (R10 passed it under the fit's).
    it('late and dropped: a fit whose name the trace does not hold fails, and the stall a fit lies in keeps its time (R10-2, R11-2)', () => {
      const q = quiet()
      const late = dragVerdict(input({ events: [...stallOf(), ...fitNamed(3000.625, 0.03)], tasks: [FIT, STALL], fits: [...q.fits, { start: 3000, ms: 0.03 }] }))
      expect(late.own.taskFit).toEqual([true, false])
      expect(fails(late, 'the trace places every fit')).toEqual(['3000.00+0.03 ms: dropped'])
      expect(fails(late, "of its own, the fit's left out")).toEqual(['400/399'])
      const dropped = dragVerdict(input({ events: stallOf(), tasks: [FIT, STALL], fits: [...q.fits, { start: 3000.5, ms: 0.03 }] }))
      expect(dropped.own.taskFit).toEqual([true, false])
      expect(fails(dropped, 'the trace places every fit')).toEqual(['3000.50+0.03 ms: dropped'])
      expect(fails(dropped, "of its own, the fit's left out")).toEqual(['400/399'])
      // Its measure where the page puts it: the fit is placed in the stall, and the stall is held to a resize's limits.
      const real = dragVerdict(input({ events: [...stallOf(), ...fitNamed(3000.5, 0.03)], tasks: [FIT, STALL], fits: [...q.fits, { start: 3000.5, ms: 0.03 }] }))
      expect(real.own.taskFit).toEqual([true, true])
      expect(fails(real, 'takes under 16 ms of its own (wall/own ms less')).toEqual(['400.0/399.0 less 0.0 of 1 fit'])
      expect(fails(real, 'takes under 50 ms on the wall (wall/own ms less')).toEqual(['400.0/399.0 less 0.0 of 1 fit'])
      expect(broken(real)).toHaveLength(2)
    })

    // MAJOR dragTrace.ts:425: with the clock unsettled, a measured short fit pulled in the 198 ms task beside it: 206 ms
    // against the fits' 200. R10-3: only the task the measure lies in is charged.
    it('projected: no task beside a measured fit is pulled into the fits\' thread time, whatever the resizes (Codex: 206 of 200, now 7.6)', () => {
      const q = quiet()
      // The fit's measure in a 0.6 ms task, the 198 ms task beginning 0.1 ms after it ends (inside the window Round 9 put
      // around where the page puts a fit, 0.75 ms).
      const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 6000, 0.6, 0.6), ...fitNamed(6000.2, 0.3), X('ThreadControllerImpl::RunTask', 'toplevel', 6000.6, 198, 198)]
      // The page's sixth resize 0.625 ms off (Round 10: unpaired, the clock unsettled): timed on the wall.
      const v = dragVerdict(input({ events, fits: [...q.fits, { start: 6000.2, ms: 0.3 }], resizes: q.resizes.map((r, i) => (i !== 5 ? r : { ...r, start: r.start - 0.625 })) }))
      expect(v.own).toMatchObject({ traced: 9, fitsTraced: 4 })
      expect(v.own.fitCpu).toBeCloseTo(7 + 0.6, 9)
      expect(fails(v, 'ms of the thread in all')).toEqual([])
    })

    // MINOR dragTrace.ts:284: a resize before the drag's marker, as long as the page's, paired with the page's at a false
    // offset that two resizes agreed on, so the clock read settled though the real second resize drifted 0.625 ms.
    // R10-4: only the resizes inside the marker are paired. R11-1: no clock; a page's name the trace holds outside the
    // marker, or twice, is not its resize's: it is timed on the wall.
    it('markerAlias: a resize\'s name before the marker is not the page\'s, nor one named twice', () => {
      const q = quiet(2)
      const at = (k: number, start: number): TraceEvent[] => named(start, 2, 1, pageMeasure(MARKER, 'resize', k))
      const alias = q.resizes[0].start - (q.resizes[1].start - q.resizes[0].start)
      const run = (events: TraceEvent[]): ReturnType<typeof dragVerdict> => dragVerdict({ ...input(), resizes: q.resizes, resizeCount: 2, events: [...q.events, ...events, ...mark(us(950), us(3000))] })
      // The first resize's name before the marker alone: unmatched; the second's inside it: the page's.
      const before = run([...at(0, alias), ...at(1, q.resizes[1].start)])
      expect(before.own).toMatchObject({ traced: 1, recorded: { resize: 1, task: 0, fit: 0 } })
      expect(before.own.resizes.map((x) => x.matched)).toEqual([false, true])
      // Its name before the marker and inside it too: named twice, so neither is its.
      const twice = run([...at(0, alias), ...at(0, q.resizes[0].start), ...at(1, q.resizes[1].start)])
      expect(twice.own).toMatchObject({ traced: 1 })
      expect(twice.own.resizes.map((x) => x.matched)).toEqual([false, true])
      expect(run([...at(0, q.resizes[0].start), ...at(1, q.resizes[1].start)]).own.traced).toBe(2)
    })

    // R10-6: the look's check after a settle is a task like any other, judged by the ordinary limits; it is logged apart.
    it('logs each look check the page names, its wall and the thread time of the task it lies in (NaN in none), and judges none of it apart', () => {
      const q = quiet()
      const events = [
        ...q.events,
        X('ThreadControllerImpl::RunTask', 'toplevel', 2600, 30, 24), ...named(2600.1, 29.8, 1, LOOK_CHECK_MEASURE),
        ...named(2900, 12, 1, LOOK_CHECK_MEASURE), // in no task the trace holds
        X('ThreadControllerImpl::RunTask', 'toplevel', 2960, 3, 2), ...named(2959.8, 3.1, 1, LOOK_CHECK_MEASURE), // its task's to the page clock's grain
        X('ThreadControllerImpl::RunTask', 'toplevel', 2950, 5, 5, 2), ...named(2950, 4, 1, LOOK_CHECK_MEASURE).map((e) => ({ ...e, tid: 2 })), // another thread's
      ]
      const own = ownTimes(events, q.resizes, [FIT], q.fits)
      expect(own.looks).toHaveLength(3)
      expect(own.looks[0]).toEqual({ own: 24, wall: 29.8 })
      expect(own.looks[1].own).toBeNaN()
      expect(own.looks[1].wall).toBe(12)
      expect(own.looks[2].own).toBe(2)
      expect(own.looks[2].wall).toBeCloseTo(3.1, 9)
      expect(own.fitCpu).toBe(7) // no fit's
      expect(broken(dragVerdict(input({ events })))).toEqual([])
    })

    // The vote's tie (Round 10, withdrawn in Round 11): one page resize against two the trace holds alike, each in a task
    // of its own, gave two votes as well supported, and the later one's offset under 1 ms apart. Its own name now finds
    // the resize at its instant, however near the other.
    it('one page resize against two alike: its name finds the one at its instant, however near the other', () => {
      const two = (gap: number): ReturnType<typeof ownTimes> =>
        ownTimes([META, X('ThreadControllerImpl::RunTask', 'toplevel', 1000.3, 0.6, 0.3), ...named(1000.6, 0.2), X('ThreadControllerImpl::RunTask', 'toplevel', 1000.4 + gap, 0.8, 0.7), ...named(1000.6 + gap, 0.2)], [{ start: 1000.6, ms: 0.2 }], [])
      for (const gap of [0.6, 1.5]) {
        const v = two(gap)
        expect(v.traced).toBe(1)
        expect(v.resizes[0]).toMatchObject({ matched: true, by: 'ThreadControllerImpl::RunTask 0.6/0.3' })
      }
    })

    // Two tasks with the very same bounds (PENDING SIGN-OFF): neither is inside the other but by the trace's order, so the
    // first the trace gives is the outer one and the fit's; the fit neither straddles nor goes to the second.
    it('of two tasks with the very same bounds holding a fit, the first the trace gives is its', () => {
      const q = quiet()
      const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 60, 2), X('ThreadPool_RunTask', 'toplevel', 4000, 60, 1.5), ...fitNamed(4000.5, 0.5)]
      const v = ownTimes(events, q.resizes, [FIT, { start: 4000, ms: 60 }], [...q.fits, { start: 4000.5, ms: 0.5 }])
      expect(v).toMatchObject({ taskFit: [true, true], fitsTraced: 4 })
      expect(v.fits[3].reason).toBeUndefined()
    })

    // A fit in a task inside another is the outer one's, and charged the most thread time any task that holds it gives
    // in its measure: the inner's when the trace's clocks give it more than the outer's (3 ms of thread time in 3 of
    // the wall, so the whole 1 ms of the measure and its grain; the outer's 1 ms, all shown in the inner outside it,
    // would give none).
    it("a fit in a task inside another is the outer one's, charged the inner's thread time when that is more", () => {
      const q = quiet()
      const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 5, 1), X('ThreadPool_RunTask', 'toplevel', 4001, 3, 3), ...fitNamed(4001.5, 0.5)]
      const v = ownTimes(events, q.resizes, [FIT], [...q.fits, { start: 4001.5, ms: 0.5 }])
      expect(v).toMatchObject({ fitsTraced: 4, fitTasks: [{}, {}, {}, { wall: 5, own: 1, fits: 1 }] })
      expect(v.fits[3].cpu).toBeCloseTo(1, 9)
      expect(v.fitCpu).toBeCloseTo(7 + 1, 9)
    })

    // A straddling fit (Round 10: charged the tasks it may be in, floored by no long task's) is charged its measure's
    // wall, and fails: no long task's, not one the trace holds no task for.
    it("a straddling fit is charged its measure's wall and fails, not a long task's the trace holds no task for", () => {
      const q = quiet()
      const events = [...stallOf(), X('ThreadControllerImpl::RunTask', 'toplevel', 3400, 0.5, 0.3), ...fitNamed(3400.15, 0.05)]
      const v = ownTimes(events, q.resizes, [FIT, { start: 9000, ms: 100 }], [...q.fits, { start: 3400.15, ms: 0.05 }])
      expect(v).toMatchObject({ taskFit: [true, false], fits: [{}, {}, {}, { reason: 'straddles', cpu: 0.05 }] })
      expect(v.fitCpu).toBeCloseTo(7 + 0.05, 9)
    })

    // The limit of the page clock's grain (PENDING SIGN-OFF; a guard, as Round 9 did the same with a settled clock): a
    // measure as far as 0.3 ms past the work it times, beyond FIT_SLACK, is charged the task its measure lies in alone.
    it('a measure past the grain is charged only the task it lies in', () => {
      const q = quiet()
      const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 5000, 1, 1), X('ThreadControllerImpl::RunTask', 'toplevel', 5001, 2, 0.5), ...fitNamed(5001.3, 0.2)]
      expect(ownTimes(events, q.resizes, [FIT], [...q.fits, { start: 5001.3, ms: 0.2 }])).toMatchObject({ fitCpu: 7 + 0.5, fitsTraced: 4 })
    })
  })

  // Round 7: the worst a fit's measure lies outside every task the trace holds whole, logged by the e2e (the margin FIT_SLACK keeps).
  it("gives how far a fit's measure lies outside the nearest task the trace holds, the worst", () => {
    const q = quiet()
    expect(ownTimes(q.events, q.resizes, [FIT], q.fits).fitSkew).toBe(0)
    const late = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000.17, 119.76, 3), ...fitNamed(4000, 120.01)]
    expect(ownTimes(late, q.resizes, [FIT], [...q.fits, { start: 4000, ms: 120.01 }]).fitSkew).toBeCloseTo(0.17, 6)
    const early = [...late, X('ThreadControllerImpl::RunTask', 'toplevel', 7000, 10, 4), ...fitNamed(7009.7, 0.6)]
    expect(ownTimes(early, q.resizes, [FIT], [...q.fits, { start: 4000, ms: 120.01 }, { start: 7009.7, ms: 0.6 }]).fitSkew).toBeCloseTo(0.3, 6)
    // No task the trace holds: none to lie outside.
    expect(ownTimes([META, ...named(1000, 2), ...fitNamed(1500, 1)], [{ start: 1000, ms: 2 }], [], [{ start: 1500, ms: 1 }]).fitSkew).toBe(0)
  })

  // Round 6, Opus m6-2: a fit in a task the trace cut, its begin never ended (the trace stopped in it) or its end with
  // no begin (it began before the trace), is in no task the trace holds whole: such a task holds only the part of it
  // inside the trace, so it is charged as one the trace does not hold, 50 ms (Round 6 to 9: or its long task's score;
  // Round 10: a fit in no task is 50, and tags no long task). Round 11: a fit in no task fails the drag, charged its
  // measure's wall.
  it('fails a fit in a task the trace cut at its edge, as in none it holds (Opus m6-2)', () => {
    const q = quiet()
    const B = (name: string, start: number, tts: number): TraceEvent => ({ name, cat: 'toplevel', ph: 'B', ts: us(start), tts: us(tts), pid: 1, tid: 1 })
    const E = (name: string, start: number, tts: number): TraceEvent => ({ name, cat: 'toplevel', ph: 'E', ts: us(start), tts: us(tts), pid: 1, tid: 1 })
    const at = (events: TraceEvent[], fit: number, long: Array<{ start: number; ms: number; fit: boolean }> = []): ReturnType<typeof dragVerdict> =>
      (({ events: all, ...rest }) => dragVerdict({ ...rest, events: [...all, ...mark(us(900), us(3010))] }))(unmarked({ events: [...q.events, ...events, ...fitNamed(fit, 1)], tasks: [FIT, ...long], fits: [...q.fits, { start: fit, ms: 1 }] }))
    // Its begin never ended, the trace's last instant 10 ms on: untasked, not in the 10 of it the trace holds.
    const stop = at([B('ThreadControllerImpl::RunTask', 3000, 0)], 3000.5)
    expect(stop.own).toMatchObject({ fitCpu: 7 + 1, fitsTraced: 3 })
    expect(fails(stop, 'the trace places every fit')).toEqual(['3000.50+1.00 ms: untasked'])
    expect(stop.own.unpaired).toEqual([{ kind: 'unclosed', name: 'ThreadControllerImpl::RunTask', at: 2100 }])
    // Its end with no begin, 5 ms after the trace's first instant: untasked, not in the 5.
    const start = at([E('ThreadControllerImpl::RunTask', 905, 4)], 901)
    expect(start.own).toMatchObject({ fitCpu: 7 + 1, fitsTraced: 3 })
    expect(fails(start, 'the trace places every fit')).toEqual(['901.00+1.00 ms: untasked'])
    expect(start.own.unpaired).toEqual([{ kind: 'lone', name: 'ThreadControllerImpl::RunTask', at: 5 }])
    // In a long task, the trace's task for it cut too: untasked, and the long task holds no fit, judged on the wall (60).
    const cut = at([B('ThreadControllerImpl::RunTask', 2950, 0)], 2950.5, [{ start: 2950, ms: 60, fit: true }])
    expect(cut.own).toMatchObject({ fitCpu: 7 + 1, fitsTraced: 3, taskFit: [true, false] })
    expect(fails(cut, 'the trace places every fit')).toEqual(['2950.50+1.00 ms: untasked'])
    expect(cut.others).toEqual([expect.objectContaining({ wall: 60, own: 60, matched: false })])
  })

  // Round 6, Codex: an end the trace logs with no name (the JSON trace format lets an end leave it out) closing a
  // begin at +17 inside a 20 ms resize of 2 ms of thread time: an end of another name than the begin open, so it waited
  // from the trace's first instant, and the resize scored 20. It closes the begin open on its thread: 2, and the
  // call's 0.15 ms each side of the measure inside the grain (Round 11): 2.3.
  it('closes the begin open with an end of no name (Codex: a 2 ms resize scored 20, now 2.3)', () => {
    const q = quiet()
    const B = (name: string, start: number): TraceEvent => ({ name, cat: 'v8', ph: 'B', ts: us(start), pid: 1, tid: 1 })
    const E = (name: string, start: number): TraceEvent => ({ name, cat: 'v8', ph: 'E', ts: us(start), pid: 1, tid: 1 })
    const resizes = [...q.resizes, { start: 3000, ms: 20 }]
    const at = (scope: TraceEvent[]): ReturnType<typeof dragVerdict> => dragVerdict(input({ events: [...q.events, X('FunctionCall', 'devtools.timeline', 2999.9, 20.2, 2), ...named(3000, 20), ...scope], resizes, resizeCount: resizes.length }))
    const v = at([B('V8.Execute', 3017), E('', 3018)])
    expect(v.own.resizes[10].waited).toBe(0)
    expect(v.own.resizes[10].cpu).toBeCloseTo(2.3, 9)
    expect(v.own.resizes[10].own).toBeCloseTo(2.3, 9)
    expect(v.own.pairs).toEqual({ 'V8.Execute': 1 })
    expect(v.own.unpaired).toEqual([])
    expect(fails(v, 'of its own (wall/own ms)')).toEqual([])
    // An end named, but not as the begin open, still waits from the first instant: its wall and the grain.
    const other = at([B('V8.Execute', 3017), E('V8.Other', 3018)])
    expect(other.own.resizes[10].own).toBeCloseTo(20.25, 9)
    expect(other.own.unpaired).toEqual([{ kind: 'mismatched', name: 'V8.Other', at: 2018 }, { kind: 'unclosed', name: 'V8.Execute', at: 2017 }])
  })

  // Round 6: a trace that lost events (Tracing.tracingComplete's dataLossOccurred) may have dropped any task or wait,
  // the outer of two nested ones among them, which nothing left in it shows: the drag fails.
  it('fails a drag whose trace lost events', () => {
    expect(fails(dragVerdict(input({ dataLoss: true })), 'lost no events')).toEqual(['events lost'])
    expect(fails(dragVerdict(input()), 'lost no events')).toEqual([])
  })

  // Round 10: each measure lies across the two tasks to the grain, so it straddles: both charged, the fit neither's.
  // Round 11: a straddling fit fails the drag, each charged its measure's wall.
  it('fails every fit across a task\'s edge within the slack (Codex: six fits on the edge of a 40 ms task, 7.6 ms; Round 10 241.6; now each fails)', () => {
    const q = quiet()
    const events = [...q.events]
    const fits = [...q.fits]
    for (let k = 0; k < 6; k++) {
      const t = 3000 + k * 100
      events.push(X('ThreadControllerImpl::RunTask', 'toplevel', t, 40, 39), X('ThreadControllerImpl::RunTask', 'toplevel', t + 40, 0.2, 0.1), ...fitNamed(t + 39.95, 0.2))
      fits.push({ start: t + 39.95, ms: 0.2 })
    }
    const v = dragVerdict(input({ events, fits }))
    expect(v.own.fitCpu).toBeCloseTo(7 + 6 * 0.2, 9)
    expect(v.own.fitsTraced).toBe(3)
    expect(fails(v, 'the trace places every fit')).toEqual([0, 1, 2, 3, 4, 5].map((k) => `${(3039.95 + k * 100).toFixed(2)}+0.20 ms: straddles`))
  })

  // Round 5, Codex (b): a fit's long task [5400,6550] in a task the trace holds from 5000, 25 ms of thread time, 400 ms
  // of it waiting on the GPU before the page's task began: 375 of it was excused, so 1150 on the wall passed the 1000.
  // Only a wait inside the window scored counts, so none, and the fit's task fails. Round 11: only the fit's measure (1 ms)
  // is excused, so its task fails a resize's limits on the rest, its 400 ms of waits on the GPU too.
  it("excuses only the waits on the GPU inside the page's task (Codex: 375 ms excused before the task began, now 0; Round 11: only the fit's 1 ms)", () => {
    const q = quiet()
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 5000, 1550, 25), W('CommandBufferProxyImpl::WaitForGetOffset', 'gpu', 5000, 400), ...fitNamed(5500, 1)]
    const v = dragVerdict(input({ events, tasks: [{ start: 5400, ms: 1150, fit: true }], fits: [...q.fits, { start: 5500, ms: 1 }] }))
    expect(v.fits).toEqual([{ wall: 1150, own: 25, cpu: 25, waited: 0, gpu: 0, matched: true }])
    expect(v.own.fits[3]).toEqual({ start: 5500, ms: 1, wall: 1, cpu: 1.5, gpu: 0 })
    expect(fails(v, 'beyond its waits on the GPU')).toEqual([])
    expect(fails(v, 'takes under 16 ms of its own (wall/own ms less')).toEqual(['1550.0/425.0 less 0.8 of 1 fit'])
    expect(fails(v, 'takes under 50 ms on the wall (wall/own ms less')).toEqual(['1550.0/425.0 less 0.8 of 1 fit'])
    // A wait that ends 100 ms into it: 100 waited, and 75 excused, as the 25 of thread time may lie in those 100.
    const into = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 5000, 1550, 25), W('CommandBufferProxyImpl::WaitForGetOffset', 'gpu', 5000, 500), ...fitNamed(5500, 1)]
    expect(dragVerdict(input({ events: into, tasks: [{ start: 5400, ms: 1150, fit: true }], fits: [...q.fits, { start: 5500, ms: 1 }] })).fits[0]).toMatchObject({ waited: 100, gpu: 75 })
  })

  // Round 5: a long task's window wider than the task the trace holds for it charges the part outside it whole.
  it("charges a long task the part of its window outside the trace's task as thread time (300 ms, a task of 240 and 20 of thread time: 80)", () => {
    const q = quiet()
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 5010, 240, 20)]
    const own = ownTimes(events, q.resizes, [{ start: 5000, ms: 300 }])
    expect(own.tasks).toEqual([{ wall: 300, own: 80, cpu: 80, waited: 0, gpu: 0, matched: true }])
    // One with no thread time given is timed on the wall; a fit in it is charged its measure widened by the grain each
    // side, 1.5 (Round 11; Round 6 to 10: the task's wall, at least the long task's), and the task its window's wall less
    // the fit's measure. A fit the trace names no measure of, its wall, and it fails (Round 11; Round 10: 50).
    const bare = [...q.events, U(5010, 240), ...fitNamed(5100, 1)]
    const fit = ownTimes(bare, q.resizes, [{ start: 5000, ms: 300 }], [{ start: 5100, ms: 1 }])
    expect(fit.tasks[0]).toMatchObject({ own: 300, matched: false })
    expect(fit).toMatchObject({ fitCpu: 1.5, fitsTraced: 1, taskFit: [true], fitTasks: [{ wall: 300, own: 300, fits: 1, off: 0.75, restWall: 299.25, restOwn: 299.25 }] })
    const dropped = ownTimes(bare.filter((e) => e.name !== BUFFER_FIT_MEASURE), q.resizes, [{ start: 5000, ms: 300 }], [{ start: 5100, ms: 1 }])
    expect(dropped).toMatchObject({ fitCpu: 1, fitsTraced: 0, taskFit: [false], fits: [{ reason: 'dropped' }] })
  })

  // Round 5: a seeded brute force. Each trace is a thread's timeline cut in 10 us cells, each one thread time, a wait on
  // the GPU, another wait, or neither (the thread descheduled, or idle between tasks), and the events a trace would hold
  // of it: tasks side by side, apart or within the slack, nested ones, calls holding the resizes, waits as complete
  // events or begins and ends, split in ones that overlap, nested in one another, reaching into the thread time beside
  // them, their thread time dropped now and then, and begins and ends of other names, lone ends and begins never ended.
  // The measures (the resizes', the fits', the long tasks') are off by up to 0.25 ms at each end from the work they time,
  // and a fit's is dropped now and then. Whatever the trace, the charge is never less than the truth.
  // Round 6 (approved 2026-11-28, controller): of every eight traces, four are as above, and one each:
  // - loses a tenth of its events (Tracing.tracingComplete's dataLossOccurred): the drag must fail that rule;
  // - is cut at both edges: the trace begins in a task (that task's end alone, a lone end) and stops in one (its begin
  //   alone, never ended), the page's marker from a task's start after the first cut to a moment no task runs, before
  //   the second; the page names only the spans inside its marker, as the e2e does;
  // - holds a second renderer: the page's measures 333 ms earlier on another process, the names the page records too,
  //   twice over for its resizes, each fit's in a cheap task, its thread named as the page's; one in four names the
  //   marker too, and then no thread is the page's;
  // - Round 11 (in place of the page's clock apart from the trace's, a class withdrawn with the vote): loses names the
  //   page records, each resize's and fit's dropped one time in four, or held 0.1 ms longer than the page's one in six:
  //   such a resize is timed on the wall, and such a fit fails, dropped or unmatched.
  // Round 11: the page's spans are recorded into the trace (indexed). Each fit is charged no less thread time than the
  // work it times, nor excused more GPU wait than its measure holds; a fit whose measure the trace drops fails; and each task that holds fits
  // is charged no less than the truth, so its rest, the fits' measures off, no less than the truth less their walls.
  it('never charges less than the truth, or fails the drag: 4000 seeded traces, nested, overlapping, skewed, with B/E noise, events lost, cut at both edges, a second renderer, the page\'s names lost', () => {
    let seed = 0x5eed2a21
    const rnd = (): number => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const int = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1))
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
    const UNIT = 10
    const BASE = OFF * 1000
    const GPU = 'CommandBufferProxyImpl::WaitForGetOffset'
    const WAIT = 'WaitableEvent::Wait'
    const bad: string[] = []
    let checked = 0
    const seen = { loss: 0, edges: 0, renderer: 0, two: 0, names: 0, lost: 0, unmatched: 0 }
    for (let n = 0; n < 4000 && bad.length < 5; n++) {
      const mode = n % 8 < 4 ? 'plain' : (['loss', 'edges', 'renderer', 'names'] as const)[(n % 8) - 4]
      // cells: 0 idle, 1 thread time, 2 a wait on the GPU, 3 another wait, 4 descheduled.
      const cells: number[] = new Array(100).fill(0)
      const tops: Array<{ a: number; b: number }> = []
      let longs = 0
      for (let k = int(3, 8); k > 0; k--) {
        const gap = pick([0, int(1, 25), int(26, 3000)])
        for (let g = 0; g < gap; g++) cells.push(0)
        const len = longs < 2 && rnd() < 0.25 ? (longs++, int(5100, 6000)) : rnd() < 0.5 ? int(2, 50) : int(51, 1500)
        const a = cells.length
        while (cells.length < a + len) {
          const kind = pick([1, 1, 1, 2, 3, 4])
          const run = int(1, Math.max(1, Math.floor(len / 6)))
          for (let r = 0; r < run && cells.length < a + len; r++) cells.push(kind)
        }
        tops.push({ a, b: cells.length })
      }
      for (let g = 0; g < 100; g++) cells.push(0)
      const pre = (kind: number): number[] => {
        const p = [0]
        for (const c of cells) p.push(p[p.length - 1] + (c === kind ? 1 : 0))
        return p
      }
      const P = [pre(0), pre(1), pre(2), pre(3)]
      const count = (kind: number, a: number, b: number): number => (P[kind][Math.min(Math.max(b, 0), cells.length)] - P[kind][Math.min(Math.max(a, 0), cells.length)]) * UNIT
      const cpu = (a: number, b: number): number => count(1, a, b)
      const at = (u: number): number => BASE + u * UNIT
      const events: TraceEvent[] = [META]
      const x = (name: string, cat: string, a: number, b: number, drop = 0.05): TraceEvent => ({ name, cat, ph: 'X', ts: at(a), dur: (b - a) * UNIT, ...(rnd() < drop ? {} : { tdur: cpu(a, b) }), pid: 1, tid: 1 })
      const be = (name: string, cat: string, a: number, b: number): TraceEvent[] => {
        const tts = rnd() < 0.8
        return [
          { name, cat, ph: 'B', ts: at(a), pid: 1, tid: 1, ...(tts ? { tts: cpu(0, a) } : {}) },
          { name, cat, ph: 'E', ts: at(b), pid: 1, tid: 1, ...(tts ? { tts: cpu(0, b) } : {}) },
        ]
      }
      const resizes: Array<{ start: number; ms: number }> = []
      const fits: Array<{ start: number; ms: number }> = []
      const longTasks: Array<{ start: number; ms: number; fit?: boolean }> = []
      // The truth: each resize's and long task's cells, and each fit's measure, the work it times (w), its top, whether
      // the trace names it, and why it fails when the page's name for it is lost (names).
      type FitTruth = { a: number; b: number; w: { a: number; b: number }; top: number; kept: boolean; lost?: 'dropped' | 'unmatched' }
      const truth: { resizes: Array<{ a: number; b: number; lost?: boolean }>; tasks: Array<{ a: number; b: number }>; fits: FitTruth[] } = { resizes: [], tasks: [], fits: [] }
      const sub = (t: { a: number; b: number }): { a: number; b: number } => {
        const a = int(t.a, t.b - 1)
        return { a, b: int(a + 1, t.b) }
      }
      const skew = (): number => int(-25, 25)
      let resizesLeft = int(1, 4)
      // The top each span of the page's is in.
      const topOf = { resizes: [] as number[], tasks: [] as number[] }
      tops.forEach((t, i) => {
        const noise = rnd() < 0.15
        if (noise) events.push({ name: 'Noise', cat: 'toplevel', ph: 'B', ts: at(t.a), pid: 1, tid: 1, ...(rnd() < 0.5 ? { tts: cpu(0, t.a) } : {}) })
        events.push(x('ThreadControllerImpl::RunTask', 'toplevel', t.a, t.b))
        if (rnd() < 0.3 && t.b - t.a > 1) {
          const s2 = sub(t)
          events.push(x('ThreadControllerImpl::RunTask', 'toplevel', s2.a, s2.b))
        }
        // The waits: one event a run of the cells of one kind, or more.
        for (let u = t.a; u < t.b; ) {
          const kind = cells[u]
          let v = u
          while (v < t.b && cells[v] === kind) v++
          if (kind === 2 || kind === 3) {
            const name = kind === 2 ? GPU : WAIT
            const cat = kind === 2 ? 'gpu' : 'base'
            // Reaching into the thread time beside it, never into another wait or a descheduled cell.
            let a = u
            let b = v
            if (rnd() < 0.3) while (a > t.a && cells[a - 1] === 1 && rnd() < 0.7) a--
            if (rnd() < 0.3) while (b < t.b && cells[b] === 1 && rnd() < 0.7) b++
            const how = rnd()
            if (how < 0.2) events.push(...be(name, cat, a, b))
            else if (how < 0.35 && b - a > 2) {
              const m = int(a + 1, b - 1)
              events.push(x(name, cat, a, int(m, b), 0.1), x(name, cat, int(a, m), b, 0.1))
            } else if (how < 0.5 && b - a > 2) {
              const s2 = { a: int(a, b - 1), b: 0 }
              s2.b = int(s2.a + 1, b)
              events.push(x(name, cat, a, b, 0.1), x(name, cat, s2.a, s2.b, 0.1))
            } else events.push(x(name, cat, a, b, 0.1))
          }
          u = v
        }
        // The calls that hold the resizes.
        if (resizesLeft > 0 && (rnd() < 0.5 || i === tops.length - 1)) {
          resizesLeft--
          const call = sub(t)
          const r = sub(call)
          const rs = r.a + skew()
          const re = Math.max(rs + 1, r.b + skew())
          events.push(x('FunctionCall', 'devtools.timeline', call.a, call.b, 0.05))
          const id = `0x${(++ids).toString(16)}`
          events.push({ name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'b', ts: at(rs), pid: 1, tid: 1, id }, { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'e', ts: at(re), pid: 1, tid: 1, id })
          resizes.push({ start: at(rs) / 1000 - OFF, ms: ((re - rs) * UNIT) / 1000 })
          truth.resizes.push({ a: rs, b: re })
          topOf.resizes.push(i)
        }
        // The fits.
        for (let f = rnd() < 0.5 ? int(1, 2) : 0; f > 0; f--) {
          const span = sub(t)
          // The measure as far outside the span as the page clock's grain (FIT_SLACK, 25 cells) at most: past it, nothing
          // outside the measure is pulled in (Round 10; the test of a measure past the grain is its own).
          const fs = span.a + skew()
          const fe = Math.max(fs + 1, span.b + skew())
          // The page's names are found by where a measure begins (indexed): two fits begun at one instant are not drawn.
          if (truth.fits.some((g) => g.a === fs)) continue
          const kept = rnd() >= 0.05
          if (kept) {
            const id = `0x${(++ids).toString(16)}`
            events.push({ name: BUFFER_FIT_MEASURE, cat: 'blink.user_timing', ph: 'b', ts: at(fs), pid: 1, tid: 1, id }, { name: BUFFER_FIT_MEASURE, cat: 'blink.user_timing', ph: 'e', ts: at(fe), pid: 1, tid: 1, id })
          }
          fits.push({ start: at(fs) / 1000 - OFF, ms: ((fe - fs) * UNIT) / 1000 })
          truth.fits.push({ a: fs, b: fe, w: span, top: i, kept })
        }
        if (t.b - t.a > 5000) {
          const ls = t.a + skew()
          const le = t.b + skew()
          longTasks.push({ start: at(ls) / 1000 - OFF, ms: ((le - ls) * UNIT) / 1000 })
          truth.tasks.push({ a: ls, b: le })
          topOf.tasks.push(i)
        }
        if (noise) events.push({ name: 'Noise', cat: 'toplevel', ph: 'E', ts: at(t.b), pid: 1, tid: 1, ...(rnd() < 0.5 ? { tts: cpu(0, t.b) } : {}) })
      })
      // Stray ends and begins never ended.
      if (rnd() < 0.1) events.push({ name: WAIT, cat: 'base', ph: 'E', ts: at(int(0, cells.length)), pid: 1, tid: 1 })
      if (rnd() < 0.1) events.push({ name: pick([WAIT, 'Noise']), cat: 'base', ph: 'B', ts: at(int(0, cells.length)), pid: 1, tid: 1 })
      let own: ReturnType<typeof ownTimesOf>
      const spans = (): Array<{ start: number; ms: number }> => [...resizes, ...longTasks, ...fits]
      if (mode === 'loss') {
        const kept = indexed(events, resizes, longTasks, fits).filter((e) => e.ph === 'M' || rnd() >= 0.1)
        const v = dragVerdict({ events: [...kept, ...markOf(kept, spans())], resizes, resizeCount: resizes.length, tasks: longTasks.map((t) => ({ ...t, fit: false })), fits, widestGap: 0, platform: 'linux', marker: MARKER, dataLoss: true })
        checked++
        seen.loss++
        if (!v.checks.some((c) => c.rule.includes('lost no events') && c.fails.length)) bad.push(`trace ${n}: events lost, and the drag passed`)
        continue
      } else if (mode === 'edges') {
        // The marker from the start of top j to a moment no task runs (a later top's start, or the idle end), the trace
        // from cs (in the task before j, or before it) to ce (at or after the marker's end).
        const j = int(0, Math.min(2, tops.length - 1))
        const cs = int(j > 0 ? tops[j - 1].a : 0, tops[j].a)
        const k = int(j + 1, tops.length)
        const me = k < tops.length ? tops[k].a : cells.length - int(1, 100)
        const ce = int(me, cells.length)
        // The page names only the spans inside its marker, as the e2e does (its resizes and fits are of the drag, its
        // long tasks the ones after its first move, and the marker's measures are each in a task of its own).
        const inside = (xs: unknown[], tops: number[]): void => {
          for (let q = xs.length - 1; q >= 0; q--) if (tops[q] < j || tops[q] >= k) xs.splice(q, 1)
        }
        inside(resizes, [...topOf.resizes])
        inside(truth.resizes, topOf.resizes)
        const fitTops = truth.fits.map((f) => f.top)
        inside(fits, fitTops)
        inside(truth.fits, fitTops)
        inside(longTasks, [...topOf.tasks])
        inside(truth.tasks, topOf.tasks)
        const [from, to] = [at(cs), at(ce)]
        const cut = events.flatMap((e): TraceEvent[] => {
          if (e.ph === 'M') return [e]
          if (e.ph !== 'X') return e.ts >= from && e.ts <= to ? [e] : []
          const end = e.ts + (e.dur as number)
          const tts = (u: number): { tts?: number } => (e.tdur !== undefined && rnd() < 0.5 ? { tts: cpu(0, (u - BASE) / UNIT) } : {})
          if (e.ts < from) return end > from && end <= to ? [{ name: e.name, cat: e.cat, ph: 'E', ts: end, pid: 1, tid: 1, ...tts(end) }] : []
          if (end <= to) return [e]
          return e.ts <= to ? [{ name: e.name, cat: e.cat, ph: 'B', ts: e.ts, pid: 1, tid: 1, ...tts(e.ts) }] : []
        })
        seen.edges++
        own = ownTimesOf([...indexed(cut, resizes, longTasks, fits), ...mark(at(tops[j].a), at(me))], resizes, longTasks, fits, MARKER)
      } else if (mode === 'renderer') {
        // The page's measures, and the names it records, on another process 333 ms earlier, its resizes' twice (133 ms
        // earlier too), each in a task of 10 us of thread time, and its thread named as the page's.
        const all = indexed(events, resizes, longTasks, fits)
        const copies: TraceEvent[] = [{ ...META, pid: 2 }]
        const resize = (e: TraceEvent): boolean => e.name === RESIZE_MEASURE || e.name.startsWith(`${MARKER}:resize:`)
        for (const shift of [333000, 133000]) for (const e of all) if ((e.ph === 'b' || e.ph === 'e') && (shift === 333000 || resize(e))) copies.push({ ...e, pid: 2, ts: e.ts - shift, id: `${e.id}:${shift}` })
        for (const f of [...fits, ...resizes]) copies.push({ name: 'ThreadControllerImpl::RunTask', cat: 'toplevel', ph: 'X', ts: us(f.start) - 333000 - 30, dur: Math.round(f.ms * 1000) + 60, tdur: 10, pid: 2, tid: 1 })
        const two = rnd() < 0.25
        own = ownTimesOf([...all, ...copies, ...markOf(all, spans()), ...(two ? markOf(all, spans()).map((e) => ({ ...e, pid: 2 })) : [])], resizes, longTasks, fits, MARKER)
        seen.renderer++
        if (two) {
          checked++
          seen.two++
          if (own.marker.held || own.thread !== '' || own.traced) bad.push(`trace ${n}: the marker on two threads, and ${own.thread} taken`)
          continue
        }
      } else if (mode === 'names') {
        // Each resize's and fit's recorded name dropped one time in four, or its end 0.1 ms on (past SLACK) one in six.
        const lose = (): 'dropped' | 'unmatched' | undefined => {
          const r = rnd()
          return r < 0.25 ? 'dropped' : r < 0.25 + 1 / 6 ? 'unmatched' : undefined
        }
        const how = new Map<string, 'dropped' | 'unmatched'>()
        truth.resizes.forEach((r, k) => {
          const l = lose()
          if (!l) return
          how.set(pageMeasure(MARKER, 'resize', k), l)
          r.lost = true
        })
        truth.fits.forEach((f, k) => {
          const l = lose()
          if (!l || !f.kept) return
          how.set(pageMeasure(MARKER, 'fit', k), l)
          f.lost = l
          seen[l === 'dropped' ? 'lost' : 'unmatched']++
        })
        const all = indexed(events, resizes, longTasks, fits).flatMap((e): TraceEvent[] => (how.get(e.name) === 'dropped' ? [] : how.get(e.name) === 'unmatched' && e.ph === 'e' ? [{ ...e, ts: e.ts + 100 }] : [e]))
        seen.names++
        own = ownTimesOf([...all, ...markOf(all, spans())], resizes, longTasks, fits, MARKER)
        truth.resizes.forEach((r, k) => {
          checked++
          if (r.lost && own.resizes[k].matched) bad.push(`trace ${n}: resize ${k}'s name lost, and it is the page's`)
        })
      } else own = ownTimes(events, resizes, longTasks, fits)
      const ms = (us: number): number => us / 1000
      const fail = (what: string, got: number, want: number, ge: boolean): void => {
        checked++
        if (ge ? got < want - 1e-6 : got > want + 1e-6) bad.push(`trace ${n}: ${what} ${got} ${ge ? '<' : '>'} ${want}`)
      }
      const ownOf = (a: number, b: number): number => ms(cpu(a, b) + count(2, a, b) + count(3, a, b))
      truth.resizes.forEach((r, i) => fail(`resize ${i} own`, own.resizes[i].own, ownOf(r.a, r.b), true))
      truth.tasks.forEach((t, i) => {
        fail(`task ${i} own`, own.tasks[i].own, ownOf(t.a, t.b), true)
        fail(`task ${i} cpu`, own.tasks[i].cpu, ms(cpu(t.a, t.b)), true)
        fail(`task ${i} gpu`, own.tasks[i].gpu, ms(count(2, t.a, t.b)), false)
      })
      // Each fit placed: no less thread time than the work it times, no more GPU wait excused than its measure holds in
      // its task. One not placed fails the drag (its charge, the measure's wall, may be less than its work); one the
      // trace does not name is not placed.
      truth.fits.forEach((f, i) => {
        const got = own.fits[i]
        if (!got.reason) {
          fail(`fit ${i} cpu`, got.cpu, ms(cpu(f.w.a, f.w.b)), true)
          fail(`fit ${i} gpu`, got.gpu, ms(count(2, Math.max(f.a, tops[f.top].a), Math.min(f.b, tops[f.top].b))), false)
        }
        const want = f.lost ?? (f.kept ? undefined : 'dropped')
        checked++
        if (want && got.reason !== want) bad.push(`trace ${n}: fit ${i} ${want}, and ${got.reason ?? 'placed'}`)
      })
      fail('fitCpu', own.fitCpu, truth.fits.reduce((t, f, i) => t + (own.fits[i].reason ? 0 : ms(cpu(f.w.a, f.w.b))), 0), true)
      // Each task that holds fits (a placed fit's top, in the order placed): no less than its truth, and its rest no less
      // than the truth less the fits' walls.
      const held = [...new Set(truth.fits.flatMap((f, i) => (own.fits[i].reason ? [] : [f.top])))]
      checked++
      if (own.fitTasks.length !== held.length) bad.push(`trace ${n}: ${own.fitTasks.length} tasks hold fits, not ${held.length}`)
      held.forEach((i, j) => {
        const t = own.fitTasks[j]
        const top = tops[i]
        const walls = truth.fits.filter((f, k) => f.top === i && !own.fits[k].reason).reduce((s, f) => s + ms((f.b - f.a) * UNIT), 0)
        fail(`fit task ${j} wall`, t.wall, ms((top.b - top.a) * UNIT), true)
        fail(`fit task ${j} own`, t.own, ownOf(top.a, top.b), true)
        fail(`fit task ${j} rest`, t.restOwn, ownOf(top.a, top.b) - walls, true)
      })
    }
    expect(bad).toEqual([])
    expect(checked).toBeGreaterThan(8000)
    expect(Object.values(seen).every((x) => x > 50)).toBe(true)
  })

  // Round 5: with the window scored a slice of the family (its thread time the task's or the call's), the other slices
  // on the thread (known) still count where they may hold more of it: a task around the call, or children whose thread
  // time outweighs their parent's (clocks the trace does not keep alike). Each is less excused, never more.
  it("excuses less GPU wait for every slice on the thread that may hold thread time in it, not the window's alone", () => {
    const q = quiet()
    // A 20 ms resize all in a GPU wait, in a call of 2 ms of thread time, in a task of 30: the task's 30 may lie in the
    // wait, so none is excused (with the call alone, 18).
    const call = [...q.events, X('FunctionCall', 'devtools.timeline', 3000.4, 20.2, 2), W('WaitForCmd', 'gpu', 3000.5, 20), ...named(3000.5, 20)]
    const resizes = [...q.resizes, { start: 3000.5, ms: 20 }]
    expect(ownTimes([...call, X('ThreadControllerImpl::RunTask', 'toplevel', 2990, 40, 30)], resizes, []).resizes[10].gpu).toBe(0)
    expect(ownTimes(call, resizes, []).resizes[10].gpu).toBeCloseTo(18, 9)
    // A 1000 ms fit all in a GPU wait, its task giving 100 ms of thread time and two calls in it 100 each: 800, not 900.
    const fit = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 1000, 100), W('WaitForCmd', 'gpu', 4000, 1000), X('FunctionCall', 'devtools.timeline', 4100, 100, 100), X('FunctionCall', 'devtools.timeline', 4300, 100, 100)]
    expect(ownTimes(fit, q.resizes, [FIT, { start: 4000, ms: 1000, fit: true }]).tasks[1].gpu).toBeCloseTo(800, 9)
    expect(ownTimes(fit.slice(0, -2), q.resizes, [FIT, { start: 4000, ms: 1000, fit: true }]).tasks[1].gpu).toBeCloseTo(900, 9)
  })

  it('a quiet drag breaks no rule, and the limits can be handed in', () => {
    expect(broken(dragVerdict(input()))).toEqual([])
    // 75 ms on the GPU of 0.5 ms of thread time, in a task of 5: 70 excused (Round 4), 74.5 charged.
    expect(dragVerdict(input()).fits).toEqual([{ wall: 80, own: 79.5, cpu: 5, waited: 74.5, gpu: 70, matched: true }])
    expect(dragVerdict(input()).own).toMatchObject({ fitCpu: 7, fitsTraced: 3, pairs: {} })
    expect(broken(dragVerdict(input(), { ...DRAG_LIMITS, fitCpuTotal: 7 }))).toEqual([])
    expect(broken(dragVerdict(input(), { ...DRAG_LIMITS, fitCpuTotal: 6.9 }))).toEqual([expect.stringContaining('ms of the thread in all')])
    // A resize's limits hold a fit's task on the rest too, the fits' measures off (Round 11): the 80 ms task's 1.75 of its own.
    expect(broken(dragVerdict(input(), { ...DRAG_LIMITS, resizeOwn: 1 }))).toEqual([expect.stringContaining('each resize takes under 1 ms of its own'), expect.stringContaining('takes under 1 ms of its own (wall/own ms less')])
    expect(fails(dragVerdict(input(), { ...DRAG_LIMITS, resizeOwn: 1.75 }), 'takes under 1.75 ms of its own (wall/own ms less')).toEqual(['80.0/79.5 less 77.8 of 1 fit'])
    expect(fails(dragVerdict(input(), { ...DRAG_LIMITS, resizeOwn: 1.76 }), 'takes under 1.76 ms of its own (wall/own ms less')).toEqual([])
  })
})
