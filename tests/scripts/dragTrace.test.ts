import { describe, expect, it } from 'vitest'
import { DRAG_LIMITS, DRAG_TRACE, dragVerdict, fitsNamed, heaviest, heldAll, isGpu, isWait, ownTimes as ownTimesOf, paired, waitedIn, widestGap, type DragInput, type TraceEvent } from '../../e2e/helpers/dragTrace'
import { BUFFER_FIT_MEASURE, RESIZE_MEASURE } from '../../src/renderer/src/world/engine/bufferFit'

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
const mark = (s: number, e: number, pid = 1, tid = 1, name = MARKER): TraceEvent[] => {
  const one = (n: string, a: number, b: number): TraceEvent[] => {
    const id = `0x${(++ids).toString(16)}`
    return [{ name: n, cat: 'blink.user_timing', ph: 'b', ts: a, pid, tid, id }, { name: n, cat: 'blink.user_timing', ph: 'e', ts: b, pid, tid, id }]
  }
  return [...one(`${name}:from`, s, s), ...one(`${name}:to`, s, e)]
}
/** The marker around a trace and the page's spans, from the first instant of either to the last; none on a trace of no events. */
const markOf = (raw: TraceEvent[], spans: Array<{ start: number; ms: number }>): TraceEvent[] => {
  const xs = raw.filter((e) => e.ph !== 'M')
  if (!xs.length) return []
  const s = [...xs.map((e) => e.ts), ...spans.map((m) => us(m.start))].reduce((t, x) => Math.min(t, x), Infinity)
  const e = [...xs.map((x) => x.ts + (x.dur ?? 0)), ...spans.map((m) => us(m.start + m.ms))].reduce((t, x) => Math.max(t, x), -Infinity)
  return mark(s, e)
}
/** ownTimes on a trace the page's marker spans whole (markOf). */
const ownTimes = (raw: TraceEvent[], named: Array<{ start: number; ms: number }>, longTasks: Array<{ start: number; ms: number }>, fits: Array<{ start: number; ms: number }> = []): ReturnType<typeof ownTimesOf> =>
  ownTimesOf([...raw, ...markOf(raw, [...named, ...longTasks, ...fits])], named, longTasks, fits, MARKER)
/** A fit the page named, as the trace holds it. */
const fitNamed = (start: number, ms: number): TraceEvent[] => named(start, ms, 1, BUFFER_FIT_MEASURE)
/**
 * A quiet drag: `n` resizes of 2 ms of the thread, each in a task of its own 100 ms apart, the page naming each; a
 * fit's task at 2500 ms: 80 ms on the wall, 75 of them waiting on the GPU, 5 of thread time; and two more fits in tasks
 * too short to be long tasks, at 2700 and 2800 ms (5 ms, 1 of thread time): 7 ms of the fits' thread time in all.
 */
function quiet(n = 10): { events: TraceEvent[]; resizes: Array<{ start: number; ms: number }>; fits: Array<{ start: number; ms: number }> } {
  const events: TraceEvent[] = [META]
  const resizes: Array<{ start: number; ms: number }> = []
  for (let k = 0; k < n; k++) {
    const t = 1000 + k * 100
    events.push(X('ThreadControllerImpl::RunTask', 'toplevel', t, 3, 3), X('FunctionCall', 'devtools.timeline', t + 0.5, 2.2, 2.2), ...named(t + 0.6, 2))
    resizes.push({ start: t + 0.6, ms: 2 })
  }
  events.push(X('ThreadControllerImpl::RunTask', 'toplevel', 2500, 80, 5), X('CommandBufferProxyImpl::WaitForGetOffset', 'gpu', 2502, 75, 0.5), ...fitNamed(2500.5, 1))
  events.push(X('ThreadControllerImpl::RunTask', 'toplevel', 2700, 5, 1), ...fitNamed(2700.5, 0.5), X('ThreadControllerImpl::RunTask', 'toplevel', 2800, 5, 1), ...fitNamed(2800.5, 0.5))
  return { events, resizes, fits: [{ start: 2500.5, ms: 1 }, { start: 2700.5, ms: 0.5 }, { start: 2800.5, ms: 0.5 }] }
}
const FIT = { start: 2500, ms: 80, fit: true }
/** A drag's input, the quiet drag's but for `over`, with the page's marker around its trace (markOf). */
const input = (over: Partial<DragInput> = {}): DragInput => {
  const q = quiet()
  const v = { events: q.events, resizes: q.resizes, resizeCount: q.resizes.length, tasks: [FIT], fits: q.fits, widestGap: 600, platform: 'linux', marker: MARKER, dataLoss: false, ...over }
  return { ...v, events: [...v.events, ...markOf(v.events, [...v.resizes, ...v.tasks, ...v.fits])] }
}
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
    expect(own.spread).toBeCloseTo(0, 3)
    expect(own.thread).toBe('CrRendererMain')
    // The call around each resize holds 2.2 ms of thread time and only 2 of its wall are the resize's: 0.2 lie outside.
    expect(own.resizes.every((x) => x.matched && Math.abs(x.cpu - 2) < 1e-9 && x.own === 2 && x.waited === 0)).toBe(true)
    expect(own.resizes[0].by).toBe('FunctionCall 2.2/2.2')
    // A resize the trace dropped is timed on the wall; with no resize in the trace there is no clock, and every span is.
    const lost = ownTimes(q.events.filter((e) => !(e.ph === 'b' && e.ts === us(1000.6))), [...q.resizes, { start: 5000, ms: 3 }], [{ start: 1300, ms: 60 }])
    expect(lost.traced).toBe(9)
    expect(lost.resizes.filter((x) => !x.matched)).toEqual([{ wall: 2, own: 2, cpu: 2, waited: 0, gpu: 0, matched: false }, { wall: 3, own: 3, cpu: 3, waited: 0, gpu: 0, matched: false }])
    const none = ownTimes([META], q.resizes, [{ start: 1300, ms: 60 }])
    expect(none.traced).toBe(0)
    expect(none.spread).toBeNaN()
    expect(none.thread).toBe('')
    expect(none.tasks).toEqual([{ wall: 60, own: 60, cpu: 60, waited: 0, gpu: 0, matched: false }])
    // A resize as one complete event in the trace is paired the same way, and an end with no begin is no resize.
    const complete: TraceEvent = { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'X', ts: us(3000), dur: 4000, pid: 1, tid: 1 }
    const orphan: TraceEvent = { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'b', ts: us(3500), pid: 1, tid: 1, id2: { local: '0xbeef' } }
    const one = ownTimes([META, X('RunTask', 'toplevel', 2999, 6, 6), complete, orphan], [{ start: 3000, ms: 4 }], [])
    expect(one.resizes[0]).toMatchObject({ matched: true, wall: 4, cpu: 4, own: 4 }) // 6 less the 2 that lie outside the 4 ms
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
    expect(slow.own).toBeCloseTo(120.5, 2)
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
    // 40 less 20: the task's 40 ms of thread time and 20 of its wall in the resize put at least 20 outside it, more than
    // the 10 and 7 of the work before and after (17: the twins counted twice would be 27 and score it 13).
    expect(r.cpu).toBe(20)
    expect(r.own).toBe(20)
    expect(fails(v, 'of its own (wall/own ms)')).toEqual(['20.0/20.0'])
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

  // Round 2, Codex major 2: a fit's task the trace dropped skipped the thread-time rule, and "most" was 1 of 2.
  it("charges a fit's task the trace does not hold its wall as thread time, and wants 90% of them held (60 ms held and 600 ms dropped)", () => {
    const v = dragVerdict(input({ tasks: [FIT, { start: 9000, ms: 600, fit: true }] }))
    expect(v.fits[1]).toEqual({ wall: 600, own: 600, cpu: 600, waited: 0, gpu: 0, matched: false })
    expect(fails(v, 'ms of thread time')).toEqual(['600/600 (not traced)'])
    expect(fails(v, "of the fits' tasks")).toEqual([]) // one dropped is allowed (fitsDropped), its wall charged
    expect(fails(dragVerdict(input({ tasks: [FIT, ...Array(2).fill({ start: 9000, ms: 100, fit: true })] })), "of the fits' tasks")).toEqual(['1/3'])
    // Nine held of ten is enough, eight is not.
    const many = (held: number): string[] => fails(dragVerdict(input({ tasks: [...Array(held).fill(FIT), ...Array(10 - held).fill({ start: 9000, ms: 100, fit: true })] })), "of the fits' tasks")
    expect(many(9)).toEqual([])
    expect(many(8)).toEqual(['8/10'])
  })

  // Round 3, Opus m3-2: with fewer than 10 fits one dropped failed the 90% (ubuntu's drags name 6 to 9 at the least).
  it("lets the trace drop one fit's task of any number: 6 of 7, not 5; 18 of 20, not 17", () => {
    const of = (n: number, held: number): string[] => fails(dragVerdict(input({ tasks: [...Array(held).fill(FIT), ...Array(n - held).fill({ start: 9000, ms: 100, fit: true })] })), "of the fits' tasks")
    expect(of(7, 6)).toEqual([])
    expect(of(7, 5)).toEqual(['5/7'])
    expect(of(20, 18)).toEqual([])
    expect(of(20, 17)).toEqual(['17/20'])
    expect(of(1, 0)).toEqual([]) // one fit dropped: charged its wall as thread time, which holds it to 200 ms
    expect(fails(dragVerdict(input({ tasks: [{ start: 9000, ms: 250, fit: true }] })), 'ms of thread time')).toEqual(['250/250 (not traced)'])
  })

  // Round 2, Codex minor: a fit named whose task the check never scored passed.
  it('wants a long task to hold a fit named, so the fits are scored', () => {
    expect(fails(dragVerdict(input({ tasks: [] })), 'a long task holds a fit named')).toEqual(['0/3'])
    expect(fails(dragVerdict(input({ tasks: [{ start: 4000, ms: 60, fit: false }] })), 'a long task holds a fit named')).toEqual(['0/3'])
    expect(fails(dragVerdict(input()), 'a long task holds a fit named')).toEqual([])
    // With no fit named, the rule that wants one fails alone.
    expect(fails(dragVerdict(input({ tasks: [], fits: [] })), 'a long task holds a fit named')).toEqual([])
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
    expect(broken(fit('linux', 2000))).toEqual([])
    expect(broken(fit('win32', 2000))).toEqual([])
    // Round 4, Opus m4-1: 8000 on macOS, about 1.5 times its worst clean fit (5204 ms): 6765 would be 30% over it.
    expect(ceiling('darwin', 9000)).toEqual(['9000'])
    expect(ceiling('darwin', 8001)).toEqual(['8001'])
    expect(broken(fit('darwin', 8000))).toEqual([])
    expect(broken(fit('darwin', 6800))).toEqual([])
    expect(ceiling('freebsd', 8001)).toEqual(['8001']) // an OS the limits do not name gets the widest
    expect(ceiling('freebsd', 8000)).toEqual([])
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
    expect(own.resizes[own.resizes.length - 1].waited).toBeCloseTo(15, 6)
  })

  // Round 2, Codex major 3: of two waits that overlap, the second was dropped, the part the first does not cover too.
  it('counts the instants of waits that overlap once each, the part of one the other does not cover too (a 25 ms resize scores 25)', () => {
    const q = quiet()
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 3000, 26, 0.2), X('FunctionCall', 'devtools.timeline', 3000.1, 25.6, 0.1), ...named(3000.2, 25), W('WaitableEvent::Wait', 'base', 3000.2, 10), W('WaitableEvent::Wait', 'base', 3005.2, 20)]
    const v = dragVerdict(input({ events, resizes: [...q.resizes, { start: 3000.2, ms: 25 }], resizeCount: 11 }))
    const r = v.own.resizes[v.own.resizes.length - 1]
    expect(r.waited).toBeCloseTo(25, 6)
    expect(r.own).toBeCloseTo(25, 6)
    expect(fails(v, 'of its own (wall/own ms)')).toEqual(['25.0/25.0'])
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
    expect(one(49.9)).toEqual([])
  })

  // Round 2, Opus m2-3: the limits are pinned, so a change of one touches a test.
  it('pins the limits (look plan A2.1 note (10), PENDING SIGN-OFF)', () => {
    expect(DRAG_LIMITS).toEqual({ resizeOwn: 16, resizeWall: 50, taskOwn: 200, taskWall: 350, fitCpu: 200, fitWall: 1000, fitCeiling: { win32: 2000, darwin: 8000, linux: 2000 }, fitCpuTotal: 200, tracedResizes: 0.8, tracedFits: 0.9, fitsDropped: 1, gap: { win32: 5000, darwin: 7000, linux: 2000 } })
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
    // With the marker on the other thread, it is the page's, though both name the resizes alike.
    const other = ownTimesOf([META, thread2, ...theirs, ...mine, ...mark(us(99), us(300), 2)], page, [], [], MARKER)
    expect(other).toMatchObject({ thread: 'Other', traced: 2, marker: { held: true, from: 1, to: 1, threads: ['Other'] } })
  })

  // Round 6, Codex: a second renderer with the page's resize cadence 333 ms earlier, its fits in tasks of 1 ms, won the
  // clock vote 10 to 9 when the trace dropped one of the page's resizes: the six fits' 40 ms tasks of 39 ms of thread
  // time went uncharged (13 ms, against 241). The marker puts the page's thread on its renderer: 241, and it fails.
  it("charges the page's fits on its marker's thread, though a second renderer wins the resizes' vote (Codex: 13, now 241)", () => {
    const q = quiet()
    const on2 = (e: TraceEvent): TraceEvent => ({ ...e, pid: 2 })
    // The trace drops one of the page's resizes: nine of its resizes against ten of the other renderer's.
    const events = q.events.filter((e) => !(e.name === RESIZE_MEASURE && e.ts >= us(1500.6) && e.ts <= us(1502.6)))
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
    expect(v.own).toMatchObject({ thread: 'CrRendererMain', traced: 9 })
    expect(v.own.fitCpu).toBeCloseTo(7 + 6 * 39, 9)
    expect(fails(v, 'ms of the thread in all')).toEqual(['241 (9/9)'])
  })

  // Round 6: with no marker, or one the trace holds more than once, on two threads, or without its start, no thread is
  // the page's: every span is timed on the wall, and the drag fails.
  it("fails a drag whose trace does not hold the page's marker once, on one thread, from one instant", () => {
    const q = quiet()
    const thread2: TraceEvent = { ...META, pid: 2, args: { name: 'Other' } }
    const a = us(900)
    const b = us(3000)
    const at = (events: TraceEvent[]): ReturnType<typeof dragVerdict> => dragVerdict({ ...input(), events: [...q.events, thread2, ...events] })
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
    expect(fails(at([...mark(a, b), ...mark(a, b).slice(0, 2)]), "the page's marker")).toEqual(['2/1 on CrRendererMain'])
    expect(fails(at([...mark(a, b), ...mark(a, b).slice(2)]), "the page's marker")).toEqual(['1/2 on CrRendererMain'])
    // Its span without its start: the trace may have begun on the page's thread after it.
    expect(fails(at(mark(a, b).slice(2)), "the page's marker")).toEqual(['0/1 on CrRendererMain'])
    expect(fails(at(mark(a, b).slice(0, 2)), "the page's marker")).toEqual(['1/0 on CrRendererMain'])
    // Its start on one thread and its span on another.
    expect(fails(at([...mark(a, b).slice(0, 2), ...mark(a, b, 2).slice(2)]), "the page's marker")).toEqual(['1/1 on CrRendererMain, Other'])
    // Its start at another instant than its span's: 0.05 ms apart holds, 0.06 not.
    const apart = (d: number): TraceEvent[] => [...mark(a + d, a + d).slice(0, 2), ...mark(a, b).slice(2)]
    expect(fails(at(apart(50)), "the page's marker")).toEqual([])
    expect(fails(at(apart(-50)), "the page's marker")).toEqual([])
    expect(fails(at(apart(60)), "the page's marker")).toEqual(['1/1 on CrRendererMain'])
    expect(fails(at(apart(-60)), "the page's marker")).toEqual(['1/1 on CrRendererMain'])
    // A marker of another drag is not this one's.
    expect(fails(at(mark(a, b, 1, 1, 'world-drag-other')), "the page's marker")).toEqual(['0/0 on none'])
  })

  // Round 6: a span of the page outside its marker is timed on the wall, and a task of the trace outside it is no fit's.
  it("times on the wall a resize or a long task outside the page's marker, and charges no task outside it", () => {
    const q = quiet()
    const at = (s: number, e: number): ReturnType<typeof dragVerdict> => dragVerdict({ ...input(), events: [...q.events, ...mark(us(s), us(e))] })
    // From the second resize's task on: the first resize is the wall's (2 ms), the rest traced.
    const late = at(1100, 3000)
    expect(late.own.resizes.map((x) => x.matched)).toEqual([false, ...Array(9).fill(true)])
    expect(late.own.resizes[0]).toMatchObject({ wall: 2, own: 2 })
    // To the long task's start: its window is the wall's, 80 of thread time, and its fit charged that.
    const early = at(900, 2500.4)
    expect(early.own.tasks[0]).toMatchObject({ matched: false, cpu: 80 })
    expect(early.own.fitCpu).toBeCloseTo(80 + 2 * 50, 9)
  })

  // Round 2, Opus m2-2, Codex minor: one 7000 ms gap for every OS, and the release after the last move not counted.
  it("wants a fit named, and the pointer moves answered no more than each OS's gap apart, the release too", () => {
    expect(fails(dragVerdict(input({ fits: [] })), 'its fit named')).toEqual(['no fit'])
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
    expect(r.cpu).toBeCloseTo(0.04, 9)
    expect(r.waited).toBeCloseTo(15.98, 9)
    expect(r.own).toBeCloseTo(16.02, 9)
    expect(fails(v, 'of its own (wall/own ms)')).toEqual(['17.0/16.0'])
    // Work before and after a resize lies outside it whole; the call's own thread time beyond its part of the resize too.
    const e2 = [...q.events, X('FunctionCall', 'devtools.timeline', 2990, 40, 30), X('a', 'v8', 2990, 10, 10), X('b', 'v8', 3020, 10, 9), ...named(3000, 20)]
    const r2 = ownTimes(e2, [...q.resizes, { start: 3000, ms: 20 }], []).resizes[10]
    expect(r2).toMatchObject({ cpu: 11, waited: 0, own: 11 }) // 30 less 19: a and b, apart, outweigh the call's 30 less 20
    // A resize longer than its call (by the slack): the part outside the call is charged as thread time.
    const e3 = [...q.events, X('FunctionCall', 'devtools.timeline', 3000.03, 9.94, 2), ...named(3000, 10)]
    expect(ownTimes(e3, [...q.resizes, { start: 3000, ms: 10 }], []).resizes[10].cpu).toBeCloseTo(2.06, 9)
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
    expect(v.own.resizes[10]).toMatchObject({ waited: 10, own: 18.5, by: 'FunctionCall 29.8/10.3' })
    expect(v.own.resizes[10].cpu).toBeCloseTo(10.3, 9)
    expect(fails(v, 'of its own (wall/own ms)')).toEqual(['18.5/18.5'])
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
    expect(v.own.resizes[10]).toMatchObject({ cpu: 2, waited: 18, own: 20 })
    expect(fails(v, 'of its own (wall/own ms)')).toEqual(['20.0/20.0'])
    expect(v.own.pairs).toEqual({ 'WaitableEvent::Wait': 1 })
    expect(v.own.unpaired).toEqual([])
    // The thread clocks of both give its thread time: 0.5 of the 18.
    expect(at([B('WaitableEvent::Wait', 'base', 3001, 100), E('WaitableEvent::Wait', 3019, 100.5)]).own.resizes[10]).toMatchObject({ waited: 17.5, own: 19.5 })
    // A begin the trace never ends runs to its last instant, waiting all of it: charged to the fit's task, excused nothing.
    const open = dragVerdict(input({ events: [...q.events, B('GLES2::Finish', 'gpu', 2510, 0)] }))
    expect(open.fits[0].gpu).toBe(70)
    expect(open.fits[0].waited).toBeCloseTo(77.5, 9)
    expect(open.own.unpaired).toEqual([{ kind: 'unclosed', name: 'GLES2::Finish', at: 2510 }])
    // An end with no begin open (Round 5) runs from the trace's first instant, waiting all of it: the fit's task waits
    // [2500,2510] too, and that much is no wait on the GPU.
    const lone = dragVerdict(input({ events: [...q.events, E('', 2510)] }))
    expect(lone.fits[0]).toMatchObject({ gpu: 70, matched: true })
    expect(lone.fits[0].waited).toBeCloseTo(77, 9)
    expect(lone.own.unpaired).toEqual([{ kind: 'lone', name: '', at: 2510 }])
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
    expect(crossed.own.resizes[10]).toMatchObject({ cpu: 2, waited: 19, own: 20 })
    expect(fails(crossed, 'of its own (wall/own ms)')).toEqual(['20.0/20.0'])
    expect(crossed.own.unpaired).toEqual([{ kind: 'mismatched', name: 'Nested', at: 3003 }])
    expect(crossed.own.pairs).toEqual({ 'WaitableEvent::Wait': 1 })
    const lone = at([E('WaitableEvent::Wait', 3019)])
    expect(lone.own.resizes[10]).toMatchObject({ waited: 19, own: 20 })
    expect(fails(lone, 'of its own (wall/own ms)')).toEqual(['20.0/20.0'])
    expect(lone.own.unpaired).toEqual([{ kind: 'lone', name: 'WaitableEvent::Wait', at: 3019 }])
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

  it("charges a fit the trace does not hold its long task's wall, each long task once, or 50 ms in none; and a task with two fits once", () => {
    const q = quiet()
    // Two fits in the 2500 task: charged once; two the trace does not hold in a 120 ms long task: 120 once; one in none: 50.
    // One before every long task is in none (50). A fit in a task in a task is charged the outer one (8 of the inner's
    // 4: Round 5, Opus m5-1, either may be the fit's), and one that ends 0.03 ms past its task on the thread's clock is
    // still in it (2).
    const fits = [...q.fits, { start: 2501.6, ms: 0.5 }, { start: 4000.5, ms: 1 }, { start: 4001.5, ms: 1 }, { start: 6000, ms: 1 }, { start: 1550, ms: 1 }, { start: 7002, ms: 2 }, { start: 8000.5, ms: 4.53 }]
    const events = [...q.events, ...fitNamed(2501.6, 0.5), X('ThreadControllerImpl::RunTask', 'toplevel', 7000, 10, 8), X('ThreadControllerImpl::RunTask', 'toplevel', 7001, 5, 4), ...fitNamed(7002, 2)]
    events.push(X('ThreadControllerImpl::RunTask', 'toplevel', 8000, 5, 2), ...fitNamed(8000.5, 4.53))
    const own = ownTimes(events, q.resizes, [FIT, { start: 4000, ms: 120 }], fits)
    expect(own).toMatchObject({ fitCpu: 7 + 120 + 50 + 50 + 8 + 2, fitsTraced: 6 })
    // A fit the trace drops at 1500 on the page's clock, where a 3 ms task runs: that task may be its (3, not 50).
    expect(ownTimes(events, q.resizes, [FIT], [...q.fits, { start: 1500.2, ms: 1 }])).toMatchObject({ fitCpu: 7 + 3, fitsTraced: 4 })
    // On a trace the page's clock cannot be put on, every fit is charged so.
    expect(ownTimes([META, ...fitNamed(2500.5, 1)], [], [FIT], [{ start: 2500.5, ms: 1 }])).toMatchObject({ fitCpu: 80, fitsTraced: 0 })
    expect(ownTimes(events, q.resizes, [])).toMatchObject({ fitCpu: 0, fitsTraced: 0 })
  })

  // Round 4 data (diag 45983711383, 45983723838, 45983738302): a fit's measure, named from the page's coarsened clock,
  // began up to 0.17 ms before its task and ended up to 0.07 ms after it, so the 50 us slack left it in no task and
  // charged the fit its long task's wall (1142 ms of a drag whose fits' tasks took 31).
  it("finds a fit's tasks by its measure within 0.25 ms, every one around it; else the long task's own task the trace holds", () => {
    const q = quiet()
    const fits = [...q.fits, { start: 4000, ms: 120 }, { start: 5000, ms: 0.4 }, { start: 6000, ms: 150 }, { start: 7000, ms: 100 }]
    const events = [...q.events,
      // The measure 0.17 ms before its task's start and 0.07 ms past its end: 3 of thread time, not the long task's 130.
      X('ThreadControllerImpl::RunTask', 'toplevel', 4000.17, 119.76, 3), ...fitNamed(4000, 120),
      // Two tasks within 0.25 ms of a 0.4 ms measure, the shorter ending 0.15 ms into it, the other holding the rest of it
      // (0.25): both (2.1), as either may be the fit's (Round 5; Round 4 took the one holding more of it, 2).
      X('ThreadControllerImpl::RunTask', 'toplevel', 4999.95, 0.2, 0.1), X('ThreadControllerImpl::RunTask', 'toplevel', 5000.15, 0.35, 2), ...fitNamed(5000, 0.4),
      // A measure the trace drops, in a long task whose own task the trace holds: that task's thread time (6).
      X('ThreadControllerImpl::RunTask', 'toplevel', 5999, 152, 6),
      // A measure 0.3 ms before its task: in no task; its long task's own task (4).
      X('ThreadControllerImpl::RunTask', 'toplevel', 7000.3, 99.8, 4), ...fitNamed(7000, 100)]
    const long = [FIT, { start: 4000, ms: 130 }, { start: 5999, ms: 152 }, { start: 7000, ms: 101 }]
    // The fits in a long task are charged at least its own charge (Round 6, Codex: the tasks found 25, the long task 175):
    // its task's thread time and the part of its window outside that task, 3 + 0.17 + 10.07 for [4000,4130] and 4 + 0.3 +
    // 0.9 for [7000,7101]. Without the floor, 7 + 3 + 2.1 + 6 + 4.
    expect(ownTimes(events, q.resizes, long, fits).fitCpu).toBeCloseTo(7 + 13.24 + 2.1 + 6 + 5.2, 9)
    expect(ownTimes(events, q.resizes, long, fits).fitsTraced).toBe(7)
    // 0.26 ms before and after: in no task, and its long task's wall (none of the trace's tasks hold half of it).
    const far = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000.26, 49, 3), ...fitNamed(4000, 49.52)]
    expect(ownTimes(far, q.resizes, [FIT, { start: 4000, ms: 110 }], [...q.fits, { start: 4000, ms: 49.52 }])).toMatchObject({ fitCpu: 7 + 110, fitsTraced: 3 })
  })

  // Round 5, the property test's trace 1764: a fit whose measure the trace dropped, 0.44 ms before another fit of its
  // length, was paired with that one's measure, and its own task (0.38 ms of thread time) went uncharged.
  it("charges a fit whose measure is in doubt every task it may be in: those around each measure, around it, and its long task's", () => {
    const q = quiet()
    const events = [...q.events,
      X('ThreadControllerImpl::RunTask', 'toplevel', 5000, 0.62, 0.38),
      X('ThreadControllerImpl::RunTask', 'toplevel', 5000.85, 0.4, 0.29), ...fitNamed(5001, 0.01)]
    const fits = [...q.fits, { start: 5000.56, ms: 0.01 }, { start: 5001, ms: 0.01 }]
    // Both fits may be the one measure's, so both are charged its task and the tasks near them: 0.38 + 0.29.
    expect(ownTimes(events, q.resizes, [FIT], fits)).toMatchObject({ fitCpu: 7 + 0.38 + 0.29, fitsTraced: 5 })
    // A measure that is one fit's alone charges only the tasks around it (0.29); the dropped one far off, its wall (50).
    expect(ownTimes(events, q.resizes, [FIT], [...q.fits, { start: 5001, ms: 0.01 }, { start: 9000, ms: 0.01 }])).toMatchObject({ fitCpu: 7 + 0.29 + 50, fitsTraced: 4 })
    // In its long task, one in doubt is charged that task's too, though the tasks near it are found.
    const long = [...events, X('ThreadControllerImpl::RunTask', 'toplevel', 4950, 50.5, 30)]
    expect(ownTimes(long, q.resizes, [FIT, { start: 4950, ms: 50.5 }], fits).fitCpu).toBeCloseTo(7 + 30 + 0.38 + 0.29, 9)
    // And so when that task the trace holds ends before it, around nothing it may be in (the page's runs 0.5 ms on): the
    // long task's own charge, 30 and the 1.5 ms of its window outside its task, is more than the tasks found (30.67).
    const short = [...events, X('ThreadControllerImpl::RunTask', 'toplevel', 4950, 49.5, 30)]
    expect(ownTimes(short, q.resizes, [FIT, { start: 4950, ms: 51 }], fits).fitCpu).toBeCloseTo(7 + 31.5, 9)
  })

  // Round 5: where a fit in doubt may be. Its measure dropped, every task around it on the thread's clock within the
  // 0.5 ms a measure is paired in and FIT_SLACK; each measure near it of its length, every task around that one; and a
  // measure on another thread is none of the page's, so it puts no fit in doubt.
  it('charges a fit in doubt the tasks around it to 0.75 ms and around each measure near it, and no other thread puts one in doubt', () => {
    const q = quiet()
    const lost = [...q.fits, { start: 6000, ms: 2 }]
    // No measure: a task 0.5 ms after it starts is around it (0.4); one 0.8 ms after is not, so 50 on the wall.
    expect(ownTimes([...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 6000.5, 1, 0.4)], q.resizes, [FIT], lost)).toMatchObject({ fitCpu: 7 + 0.4, fitsTraced: 4 })
    expect(ownTimes([...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 6000.8, 1, 0.4)], q.resizes, [FIT], lost)).toMatchObject({ fitCpu: 7 + 50, fitsTraced: 3 })
    // Two measures near it (0.45 before, 0.3 after): the task around the first ends 0.76 ms before it does, around it
    // not, so only the measure finds it (0.3).
    const two = [...q.events, ...fitNamed(6999.55, 0.92), ...fitNamed(7000.3, 0.95), X('ThreadControllerImpl::RunTask', 'toplevel', 6999.6, 0.64, 0.3)]
    expect(ownTimes(two, q.resizes, [FIT], [...q.fits, { start: 7000, ms: 1 }])).toMatchObject({ fitCpu: 7 + 0.3, fitsTraced: 4 })
    // One measure on the page's thread and one alike on another: the fit is sure, charged the task around its measure
    // (0.5) and not the one before it that is around it only (0.2).
    const other = [...q.events, ...fitNamed(8000.4, 1), ...named(8000.4, 1, 2, BUFFER_FIT_MEASURE),
      X('ThreadControllerImpl::RunTask', 'toplevel', 8000.35, 1.2, 0.5), X('ThreadControllerImpl::RunTask', 'toplevel', 7999.8, 0.5, 0.2)]
    expect(ownTimes(other, q.resizes, [FIT], [...q.fits, { start: 8000, ms: 1 }])).toMatchObject({ fitCpu: 7 + 0.5, fitsTraced: 4 })
  })

  // Round 5, Codex (a): six fits, each at the end of a 40 ms task of 39 ms of thread time, its measure 0.15 ms late, so
  // it lies 0.05 ms in that task and 0.15 in the 0.2 ms task after it (0.1 of thread time). The task holding most of it
  // was charged, 0.1 each: 7.6 ms in all. Both may be the fit's, so both are charged: 7 + 6 x 39.1, over the 200.
  // Round 6, Opus m6-1: the six fits of Codex (a) with their measures 0.26 ms past the 40 ms task's end and 0.30 past
  // the 0.2 ms task's start: beyond FIT_SLACK of the 40 ms task, so a sure fit is charged the 0.2 ms task alone (7.6).
  // When the resizes paired disagree on the offset by more than FIT_SLACK / 2, every fit is in doubt: 241.6, and it
  // fails. With the resizes agreeing, 7.6 still: the limit note (10) states, Round 6 (c) (a measure as far from its task as that,
  // on a clock the resizes show steady, is not seen; the worst seen in the e2e is 0.17 ms).
  it('puts every fit in doubt when the resizes disagree on the offset by more than FIT_SLACK / 2 (Opus m6-1: 7.6, now 241.6)', () => {
    const q = quiet()
    const events = [...q.events]
    const fits = [...q.fits]
    for (let k = 0; k < 6; k++) {
      const t = 3000 + k * 100
      events.push(X('ThreadControllerImpl::RunTask', 'toplevel', t, 40, 39), X('ThreadControllerImpl::RunTask', 'toplevel', t + 40, 0.2, 0.1), ...fitNamed(t + 40.26, 0.04))
      fits.push({ start: t + 40.26, ms: 0.04 })
    }
    // The page's sixth resize 0.12 or 0.13 ms earlier than the trace puts it (its first would tie the vote, the resizes
    // being alike and 100 ms apart, between the offset and one 100 ms off).
    const apart = (d: number): ReturnType<typeof dragVerdict> => dragVerdict(input({ events, fits, resizes: q.resizes.map((r, i) => (i !== 5 ? r : { ...r, start: r.start - d })) }))
    const steady = apart(0)
    expect(steady.own.spread).toBe(0)
    expect(steady.own.fitCpu).toBeCloseTo(7 + 6 * 0.1, 9)
    expect(fails(steady, 'ms of the thread in all')).toEqual([])
    expect(apart(0.12).own.spread).toBeCloseTo(0.12, 6)
    expect(apart(0.12).own.fitCpu).toBeCloseTo(7 + 6 * 0.1, 9)
    const drift = apart(0.13)
    expect(drift.own.spread).toBeCloseTo(0.13, 6)
    expect(drift.own.fitCpu).toBeCloseTo(7 + 6 * 39.1, 9)
    expect(fails(drift, 'ms of the thread in all')).toEqual(['242 (9/9)'])
  })

  // Round 6, Codex: a fit's long task [4000,4200], the task the trace holds over most of it from 4000 to 4150 (125 ms of
  // thread time), and the fit's measure in another task the trace holds, of 25: the fit's task was charged (25), though
  // the long task scored 175 (its task's 125 and the 50 ms of its window outside it). The fits in a long task are now
  // charged at least what it scores.
  it('charges the fits in a long task at least what the long task scores (Codex: 25, now 175)', () => {
    const q = quiet()
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 150, 125), X('ThreadControllerImpl::RunTask', 'toplevel', 4160, 25, 25), ...fitNamed(4170, 1)]
    const v = dragVerdict(input({ events, tasks: [FIT, { start: 4000, ms: 200, fit: true }], fits: [...q.fits, { start: 4170, ms: 1 }] }))
    expect(v.fits[1]).toMatchObject({ cpu: 175, matched: true })
    expect(v.own).toMatchObject({ fitCpu: 7 + 175, fitsTraced: 4 })
    // Two fits in it, each sure of its task: the long task once, at least its score.
    const two = [...events, X('ThreadControllerImpl::RunTask', 'toplevel', 4186, 10, 10), ...fitNamed(4190, 1)]
    expect(dragVerdict(input({ events: two, tasks: [FIT, { start: 4000, ms: 200, fit: true }], fits: [...q.fits, { start: 4170, ms: 1 }, { start: 4190, ms: 1 }] })).own.fitCpu).toBeCloseTo(7 + 175, 9)
    // Its task of little thread time (10): its score still, 10 and the 50 outside, more than the fit's task (25).
    const heavy = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 150, 10), X('ThreadControllerImpl::RunTask', 'toplevel', 4160, 25, 25), ...fitNamed(4170, 1)]
    expect(dragVerdict(input({ events: heavy, tasks: [FIT, { start: 4000, ms: 200, fit: true }], fits: [...q.fits, { start: 4170, ms: 1 }] })).own.fitCpu).toBeCloseTo(7 + 60, 9)
    // A fit the trace dropped the measure of, at its long task's end: the task around where it is put on the thread's
    // clock runs past the long task's window, so the floor (60 and the 1 ms of the window after its task) holds only
    // 0.8 ms of it; the long task's task and that one are charged both, 80, not 61.
    const edge = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 99, 60), X('ThreadControllerImpl::RunTask', 'toplevel', 4099.2, 1.8, 20)]
    expect(dragVerdict(input({ events: edge, tasks: [FIT, { start: 4000, ms: 100, fit: true }], fits: [...q.fits, { start: 4099.5, ms: 1 }] })).own.fitCpu).toBeCloseTo(7 + 80, 9)
  })

  // Round 6, Opus m6-2: a fit in a task the trace cut, its begin never ended (the trace stopped in it) or its end with
  // no begin (it began before the trace), is in no task the trace holds whole: such a task holds only the part of it
  // inside the trace, so it is charged as one the trace does not hold, 50 ms, or its long task's score.
  it('charges a fit in a task the trace cut at its edge as one it does not hold (Opus m6-2)', () => {
    const q = quiet()
    const B = (name: string, start: number, tts: number): TraceEvent => ({ name, cat: 'toplevel', ph: 'B', ts: us(start), tts: us(tts), pid: 1, tid: 1 })
    const E = (name: string, start: number, tts: number): TraceEvent => ({ name, cat: 'toplevel', ph: 'E', ts: us(start), tts: us(tts), pid: 1, tid: 1 })
    const at = (events: TraceEvent[], fit: number, long: Array<{ start: number; ms: number; fit: boolean }> = []): ReturnType<typeof dragVerdict> =>
      dragVerdict({ ...input(), events: [...q.events, ...events, ...fitNamed(fit, 1), ...mark(us(900), us(3010))], tasks: [FIT, ...long], fits: [...q.fits, { start: fit, ms: 1 }] })
    // Its begin never ended, the trace's last instant 10 ms on: 50, not the 10 of it the trace holds.
    const stop = at([B('ThreadControllerImpl::RunTask', 3000, 0)], 3000.5)
    expect(stop.own).toMatchObject({ fitCpu: 7 + 50, fitsTraced: 3 })
    expect(stop.own.unpaired).toEqual([{ kind: 'unclosed', name: 'ThreadControllerImpl::RunTask', at: 3000 }])
    // Its end with no begin, 5 ms after the trace's first instant: 50, not the 5.
    const start = at([E('ThreadControllerImpl::RunTask', 905, 4)], 901)
    expect(start.own).toMatchObject({ fitCpu: 7 + 50, fitsTraced: 3 })
    expect(start.own.unpaired).toEqual([{ kind: 'lone', name: 'ThreadControllerImpl::RunTask', at: 905 }])
    // In a long task: its score, the trace's task for it cut too, so its window on the wall (60).
    expect(at([B('ThreadControllerImpl::RunTask', 2950, 0)], 2950.5, [{ start: 2950, ms: 60, fit: true }]).own).toMatchObject({ fitCpu: 7 + 60, fitsTraced: 3 })
  })

  // Round 6, Codex: an end the trace logs with no name (the JSON trace format lets an end leave it out) closing a
  // begin at +17 inside a 20 ms resize of 2 ms of thread time: an end of another name than the begin open, so it waited
  // from the trace's first instant, and the resize scored 20. It closes the begin open on its thread: 2.
  it('closes the begin open with an end of no name (Codex: a 2 ms resize scored 20, now 2)', () => {
    const q = quiet()
    const B = (name: string, start: number): TraceEvent => ({ name, cat: 'v8', ph: 'B', ts: us(start), pid: 1, tid: 1 })
    const E = (name: string, start: number): TraceEvent => ({ name, cat: 'v8', ph: 'E', ts: us(start), pid: 1, tid: 1 })
    const resizes = [...q.resizes, { start: 3000, ms: 20 }]
    const at = (scope: TraceEvent[]): ReturnType<typeof dragVerdict> => dragVerdict(input({ events: [...q.events, X('FunctionCall', 'devtools.timeline', 2999.9, 20.2, 2), ...named(3000, 20), ...scope], resizes, resizeCount: resizes.length }))
    const v = at([B('V8.Execute', 3017), E('', 3018)])
    expect(v.own.resizes[10]).toMatchObject({ cpu: 2, waited: 0, own: 2 })
    expect(v.own.pairs).toEqual({ 'V8.Execute': 1 })
    expect(v.own.unpaired).toEqual([])
    expect(fails(v, 'of its own (wall/own ms)')).toEqual([])
    // An end named, but not as the begin open, still waits from the first instant: 20.
    const other = at([B('V8.Execute', 3017), E('V8.Other', 3018)])
    expect(other.own.resizes[10]).toMatchObject({ own: 20 })
    expect(other.own.unpaired).toEqual([{ kind: 'mismatched', name: 'V8.Other', at: 3018 }, { kind: 'unclosed', name: 'V8.Execute', at: 3017 }])
  })

  // Round 6: a trace that lost events (Tracing.tracingComplete's dataLossOccurred) may have dropped any task or wait,
  // the outer of two nested ones among them, which nothing left in it shows: the drag fails.
  it('fails a drag whose trace lost events', () => {
    expect(fails(dragVerdict(input({ dataLoss: true })), 'lost no events')).toEqual(['events lost'])
    expect(fails(dragVerdict(input()), 'lost no events')).toEqual([])
  })

  it('charges every task around a fit within the slack (Codex: six fits on the edge of a 40 ms task, 7.6 ms, now 241.6)', () => {
    const q = quiet()
    const events = [...q.events]
    const fits = [...q.fits]
    for (let k = 0; k < 6; k++) {
      const t = 3000 + k * 100
      events.push(X('ThreadControllerImpl::RunTask', 'toplevel', t, 40, 39), X('ThreadControllerImpl::RunTask', 'toplevel', t + 40, 0.2, 0.1), ...fitNamed(t + 39.95, 0.2))
      fits.push({ start: t + 39.95, ms: 0.2 })
    }
    const v = dragVerdict(input({ events, fits }))
    expect(v.own.fitCpu).toBeCloseTo(7 + 6 * 39.1, 9)
    expect(v.own.fitsTraced).toBe(9)
    expect(fails(v, 'ms of the thread in all')).toEqual(['242 (9/9)'])
  })

  // Round 5, Codex (b): a fit's long task [5400,6550] in a task the trace holds from 5000, 25 ms of thread time, 400 ms
  // of it waiting on the GPU before the page's task began: 375 of it was excused, so 1150 on the wall passed the 1000.
  // Only a wait inside the window scored counts, so none, and the fit's task fails.
  it("excuses only the waits on the GPU inside the page's task (Codex: 375 ms excused before the task began, now 0)", () => {
    const q = quiet()
    const events = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 5000, 1550, 25), W('CommandBufferProxyImpl::WaitForGetOffset', 'gpu', 5000, 400), ...fitNamed(5500, 1)]
    const v = dragVerdict(input({ events, tasks: [{ start: 5400, ms: 1150, fit: true }], fits: [...q.fits, { start: 5500, ms: 1 }] }))
    expect(v.fits).toEqual([{ wall: 1150, own: 25, cpu: 25, waited: 0, gpu: 0, matched: true }])
    expect(fails(v, 'beyond its waits on the GPU')).toEqual(['1150/0'])
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
    // One with no thread time given is timed on the wall; a fit in it is charged the task's wall (240), and at least the
    // long task's own charge, its window's wall (300, Round 6).
    const bare = [...q.events, { ...X('ThreadControllerImpl::RunTask', 'toplevel', 5010, 240, 0), tdur: undefined }]
    const fit = ownTimes(bare, q.resizes, [{ start: 5000, ms: 300 }], [{ start: 5100, ms: 1 }])
    expect(fit.tasks[0]).toMatchObject({ own: 300, matched: false })
    expect(fit).toMatchObject({ fitCpu: 300, fitsTraced: 1 })
  })

  // Round 5: a seeded brute force. Each trace is a thread's timeline cut in 10 us cells, each one thread time, a wait on
  // the GPU, another wait, or neither (the thread descheduled, or idle between tasks), and the events a trace would hold
  // of it: tasks side by side, apart or within the slack, nested ones, calls holding the resizes, waits as complete
  // events or begins and ends, split in ones that overlap, nested in one another, reaching into the thread time beside
  // them, their thread time dropped now and then, and begins and ends of other names, lone ends and begins never ended.
  // The measures (the resizes', the fits', the long tasks') are off by up to 0.25 ms at each end, and a fit's is dropped
  // now and then. Whatever the trace, the charge is never less than the truth.
  // Round 6 (PENDING SIGN-OFF): of every eight traces, four are as above, and one each:
  // - loses a tenth of its events (Tracing.tracingComplete's dataLossOccurred): the drag must fail that rule;
  // - is cut at both edges: the trace begins in a task (that task's end alone, a lone end) and stops in one (its begin
  //   alone, never ended), the page's marker from a task's start after the first cut to a moment no task runs, before
  //   the second; the page names only the spans inside its marker, as the e2e does;
  // - holds a second renderer: the page's measures 333 ms earlier on another process, twice over for its resizes, each
  //   fit's in a cheap task, its thread named as the page's; one in four names the marker too, and then no thread is
  //   the page's;
  // - has the page's numbers apart from the trace's measures by up to 0.15 ms (0.3 between its first two resizes, each
  //   at least 1 ms after the last, as the page's resizes are frames apart), and
  //   its fits' measures up to 0.4 ms from the work they time, past FIT_SLACK: the resizes' spread puts every fit in
  //   doubt. Its long tasks' windows are put on the trace's clock by an offset as far off, so their scores are left to
  //   the other traces; a skew past FIT_SLACK the spread does not show is the limit of note (10), Round 6 (c), its own test.
  it('never charges less than the truth, or fails the drag: 4000 seeded traces, nested, overlapping, skewed, with B/E noise, events lost, cut at both edges, a second renderer, the page\'s clock apart', () => {
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
    const seen = { loss: 0, edges: 0, renderer: 0, two: 0, skew: 0 }
    for (let n = 0; n < 4000 && bad.length < 5; n++) {
      const mode = n % 8 < 4 ? 'plain' : (['loss', 'edges', 'renderer', 'skew'] as const)[(n % 8) - 4]
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
      const truth: { resizes: Array<{ a: number; b: number; d: number }>; tasks: Array<{ a: number; b: number }>; fitTops: Set<number> } = { resizes: [], tasks: [], fitTops: new Set() }
      const sub = (t: { a: number; b: number }): { a: number; b: number } => {
        const a = int(t.a, t.b - 1)
        return { a, b: int(a + 1, t.b) }
      }
      const skew = (): number => int(-25, 25)
      let resizesLeft = int(1, 4)
      if (mode === 'skew') resizesLeft = Math.max(2, resizesLeft)
      // The top each span of the page's is in, and where the last resize ended (the page's resizes are frames apart).
      const topOf = { resizes: [] as number[], fits: [] as number[], tasks: [] as number[] }
      let lastResize = -Infinity
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
        if (resizesLeft > 0 && (rnd() < 0.5 || i === tops.length - 1 || (mode === 'skew' && i >= tops.length - resizesLeft)) && (mode !== 'skew' || t.a >= lastResize + 100)) {
          resizesLeft--
          const call = sub(t)
          const r = sub(call)
          const rs = r.a + skew()
          const re = Math.max(rs + 1, r.b + skew())
          events.push(x('FunctionCall', 'devtools.timeline', call.a, call.b, 0.05))
          const id = `0x${(++ids).toString(16)}`
          events.push({ name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'b', ts: at(rs), pid: 1, tid: 1, id }, { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'e', ts: at(re), pid: 1, tid: 1, id })
          const d = mode !== 'skew' ? 0 : resizes.length === 0 ? -15 : resizes.length === 1 ? 15 : int(-15, 15)
          resizes.push({ start: at(rs + d) / 1000 - OFF, ms: ((re - rs) * UNIT) / 1000 })
          truth.resizes.push({ a: rs, b: re, d })
          topOf.resizes.push(i)
          lastResize = re
        }
        // The fits.
        for (let f = rnd() < 0.5 ? int(1, 2) : 0; f > 0; f--) {
          const span = sub(t)
          const fs = span.a + (mode === 'skew' ? int(-40, 40) : skew())
          const fe = Math.max(fs + 1, span.b + (mode === 'skew' ? int(-40, 40) : skew()))
          if (rnd() >= 0.05) {
            const id = `0x${(++ids).toString(16)}`
            events.push({ name: BUFFER_FIT_MEASURE, cat: 'blink.user_timing', ph: 'b', ts: at(fs), pid: 1, tid: 1, id }, { name: BUFFER_FIT_MEASURE, cat: 'blink.user_timing', ph: 'e', ts: at(fe), pid: 1, tid: 1, id })
          }
          fits.push({ start: at(fs + (mode === 'skew' ? int(-15, 15) : 0)) / 1000 - OFF, ms: ((fe - fs) * UNIT) / 1000 })
          truth.fitTops.add(i)
          topOf.fits.push(i)
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
      if (mode === 'skew' && resizes.length < 2) continue
      if (mode === 'loss') {
        const kept = events.filter((e) => e.ph === 'M' || rnd() >= 0.1)
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
        inside(fits, topOf.fits)
        inside(longTasks, [...topOf.tasks])
        inside(truth.tasks, topOf.tasks)
        for (const i of [...truth.fitTops]) if (i < j || i >= k) truth.fitTops.delete(i)
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
        own = ownTimesOf([...cut, ...mark(at(tops[j].a), at(me))], resizes, longTasks, fits, MARKER)
      } else if (mode === 'renderer') {
        // The page's measures on another process 333 ms earlier, its resizes' twice (133 ms earlier too), each in a task
        // of 10 us of thread time, and its thread named as the page's.
        const copies: TraceEvent[] = [{ ...META, pid: 2 }]
        for (const shift of [333000, 133000]) for (const e of events) if ((e.ph === 'b' || e.ph === 'e') && (shift === 333000 || e.name === RESIZE_MEASURE)) copies.push({ ...e, pid: 2, ts: e.ts - shift, id: `${e.id}:${shift}` })
        for (const f of [...fits, ...resizes]) copies.push({ name: 'ThreadControllerImpl::RunTask', cat: 'toplevel', ph: 'X', ts: us(f.start) - 333000 - 30, dur: Math.round(f.ms * 1000) + 60, tdur: 10, pid: 2, tid: 1 })
        const two = rnd() < 0.25
        own = ownTimesOf([...events, ...copies, ...markOf(events, spans()), ...(two ? markOf(events, spans()).map((e) => ({ ...e, pid: 2 })) : [])], resizes, longTasks, fits, MARKER)
        seen.renderer++
        if (two) {
          checked++
          seen.two++
          if (own.marker.held || own.thread !== '' || own.traced) bad.push(`trace ${n}: the marker on two threads, and ${own.thread} taken`)
          continue
        }
      } else own = ownTimes(events, resizes, longTasks, fits)
      if (mode === 'skew') {
        checked++
        seen.skew++
        if (!(own.spread > 0.125)) bad.push(`trace ${n}: the page's numbers apart, and a spread of ${own.spread}`)
      }
      const ms = (us: number): number => us / 1000
      const fail = (what: string, got: number, want: number, ge: boolean): void => {
        checked++
        if (ge ? got < want - 1e-6 : got > want + 1e-6) bad.push(`trace ${n}: ${what} ${got} ${ge ? '<' : '>'} ${want}`)
      }
      // The page's resizes in the order ownTimes takes them, by their start (a skew can put one before the one ahead of it).
      truth.resizes.sort((p, q) => p.a + p.d - (q.a + q.d)).forEach((r, i) => fail(`resize ${i} own`, own.resizes[i].own, ms(cpu(r.a, r.b) + count(2, r.a, r.b) + count(3, r.a, r.b)), true))
      if (mode !== 'skew') truth.tasks.forEach((t, i) => {
        fail(`task ${i} own`, own.tasks[i].own, ms(cpu(t.a, t.b) + count(2, t.a, t.b) + count(3, t.a, t.b)), true)
        fail(`task ${i} cpu`, own.tasks[i].cpu, ms(cpu(t.a, t.b)), true)
        fail(`task ${i} gpu`, own.tasks[i].gpu, ms(count(2, t.a, t.b)), false)
      })
      fail('fitCpu', own.fitCpu, [...truth.fitTops].reduce((sum, i) => sum + ms(cpu(tops[i].a, tops[i].b)), 0), true)
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
    expect(broken(dragVerdict(input(), { ...DRAG_LIMITS, resizeOwn: 1 }))).toEqual([expect.stringContaining('under 1 ms of its own')])
  })
})
