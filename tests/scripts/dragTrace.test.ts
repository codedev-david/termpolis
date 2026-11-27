import { describe, expect, it } from 'vitest'
import { DRAG_LIMITS, DRAG_TRACE, dragVerdict, fitsNamed, heaviest, isGpu, isWait, ownTimes, paired, waitedIn, widestGap, type DragInput, type TraceEvent } from '../../e2e/helpers/dragTrace'
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
const input = (over: Partial<DragInput> = {}): DragInput => {
  const q = quiet()
  return { events: q.events, resizes: q.resizes, resizeCount: q.resizes.length, tasks: [FIT], fits: q.fits, widestGap: 600, platform: 'linux', ...over }
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
    const both = (xs: TraceEvent[], s: number, e: number): number[] => [waitedIn(xs, s, e, 'least'), waitedIn(xs, s, e, 'most')]
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
    // takes the heavier of the two that overlap, 10, so 5 too: it relies on a slice around them, as ownTimes hands in
    // (`known`), and with one of 14 (all the two can hold) it is 1.
    expect(both([at(0, 10, 10), at(5, 10, 4)], 0, 100)).toEqual([5, 5])
    expect(waitedIn([at(0, 10, 10), at(5, 10, 4)], 0, 100, 'least', [at(0, 15, 14)])).toBe(1)
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
    expect(waitedIn([at(90, 110)], 0, 1000, 'least', [at(0, 100, 30), at(150, 10, 10)])).toBe(90)
    // Codex's case (Round 4, dragTrace.ts:63): [0,600] of no thread time, [50,150] of 100 nested in it, [500,800] of 70
    // past it: 800 less 100 and 70, which lie apart, 630 (Round 3: 700, the 70 counted only past 600).
    expect(waitedIn([at(0, 600), at(50, 100, 100), at(500, 300, 70)], 0, 1000, 'least')).toBe(630)
    // The thread time of a slice of any category inside counts, the heaviest of those that overlap (item 2).
    // A call of 150 ms of thread time inside a 1000 ms wait on the GPU of none, in a task of 150: 850 (item 2), with or
    // without the task (Round 3: 1000, a call not being a wait).
    const call = { ...at(100, 300, 150), name: 'FunctionCall', cat: 'devtools.timeline' }
    expect(waitedIn([at(0, 1000)], 0, 1000, 'least', [call, at(-10, 1020, 150)])).toBe(850)
    expect(waitedIn([at(0, 1000)], 0, 1000, 'least', [call])).toBe(850)
    // A slice in `known` that is also a wait counts once.
    const both150 = at(0, 1000, 150)
    expect(waitedIn([both150], 0, 1000, 'least', [both150])).toBe(850)
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

  // Round 3, Opus m3-3 (mutant R9, >=): of two threads as many resizes agree with, the one that named a resize first is the page's.
  it('of two threads as many resizes agree with, takes the one that named a resize first', () => {
    const page = [{ start: 100, ms: 2 }, { start: 200, ms: 3 }]
    const thread2: TraceEvent = { ...META, pid: 2, args: { name: 'Other' } }
    const mine = [...named(100, 2), ...named(200, 3)]
    expect(ownTimes([META, thread2, ...mine, ...named(100.01, 2, 2), ...named(200.01, 3, 2)], page, []).thread).toBe('CrRendererMain')
    expect(ownTimes([META, thread2, ...named(99.99, 2, 2), ...named(199.99, 3, 2), ...mine], page, []).thread).toBe('Other')
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
    const E = (start: number, tts?: number): TraceEvent => ({ name: '', cat: '', ph: 'E', ts: us(start), pid: 1, tid: 1, ...(tts === undefined ? {} : { tts: us(tts) }) })
    const resizes = [...q.resizes, { start: 3000, ms: 20 }]
    const at = (wait: TraceEvent[]): ReturnType<typeof dragVerdict> => dragVerdict(input({ events: [...q.events, X('FunctionCall', 'devtools.timeline', 2999.9, 20.2, 2), ...named(3000, 20), ...wait], resizes, resizeCount: resizes.length }))
    const v = at([B('WaitableEvent::Wait', 'base', 3001), E(3019)])
    expect(v.own.resizes[10]).toMatchObject({ cpu: 2, waited: 18, own: 20 })
    expect(fails(v, 'of its own (wall/own ms)')).toEqual(['20.0/20.0'])
    expect(v.own.pairs).toEqual({ 'WaitableEvent::Wait': 1 })
    // The thread clocks of both give its thread time: 0.5 of the 18.
    expect(at([B('WaitableEvent::Wait', 'base', 3001, 100), E(3019, 100.5)]).own.resizes[10]).toMatchObject({ waited: 17.5, own: 19.5 })
    // A begin the trace never ends runs to its last instant, waiting all of it: charged to the fit's task, excused nothing.
    const open = dragVerdict(input({ events: [...q.events, B('GLES2::Finish', 'gpu', 2510, 0)] }))
    expect(open.fits[0].gpu).toBe(70)
    expect(open.fits[0].waited).toBeCloseTo(77.5, 9)
    // An end with no begin open is dropped.
    expect(dragVerdict(input({ events: [...q.events, E(2510)] })).fits[0]).toEqual(dragVerdict(input()).fits[0])
  })

  it('paired: an end closes the latest begin open on its thread, in the trace\'s order; one never ended runs to the last instant', () => {
    const ev = (ph: string, name: string, ts: number, tid = 1, tts?: number): TraceEvent => ({ name, cat: 'base', ph, ts, pid: 1, tid, ...(tts === undefined ? {} : { tts }) })
    const x: TraceEvent = { name: 'x', cat: 'base', ph: 'X', ts: 8, dur: 2, pid: 1, tid: 1 }
    const r = paired([ev('E', '', 5, 1, 3), ev('B', 'b', 1, 1, 1), ev('E', '', 2, 1, 1.5), x, ev('B', 'a', 0, 1, 0), ev('B', 'c', 3, 2), ev('E', '', 4, 2, 9), ev('E', '', 0, 3), ev('B', 'd', 6, 1)])
    const made = (name: string, ts: number, dur: number, tid: number, tdur?: number): TraceEvent => ({ name, cat: 'base', ph: 'X', ts, dur, ...(tdur === undefined ? {} : { tdur }), pid: 1, tid })
    expect(r.events).toEqual([made('b', 1, 1, 1, 0.5), made('c', 3, 1, 2), made('a', 0, 5, 1, 3), x, made('d', 6, 4, 1)])
    expect([...r.open]).toEqual([made('d', 6, 4, 1)])
    expect(r.pairs).toEqual(new Map([['1:1', new Map([['b', 1], ['a', 1]])], ['1:2', new Map([['c', 1]])]]))
    // A begin and an end at one instant pair in the trace's order.
    const later: TraceEvent = { name: 'y', cat: 'base', ph: 'X', ts: 4, dur: 1, pid: 1, tid: 1 }
    expect(paired([ev('B', 'p', 1), ev('E', '', 1), later])).toEqual({ events: [made('p', 1, 0, 1), later], open: new Set(), pairs: new Map([['1:1', new Map([['p', 1]])]]) })
    expect(paired([])).toEqual({ events: [], open: new Set(), pairs: new Map() })
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
    // One before every long task is in none (50). A fit in a task in a task is charged the inner one (4 of 8), and one
    // that ends 0.03 ms past its task on the thread's clock is still in it (2).
    const fits = [...q.fits, { start: 2501.6, ms: 0.5 }, { start: 4000.5, ms: 1 }, { start: 4001.5, ms: 1 }, { start: 6000, ms: 1 }, { start: 1500, ms: 1 }, { start: 7002, ms: 2 }, { start: 8000.5, ms: 4.53 }]
    const events = [...q.events, ...fitNamed(2501.6, 0.5), X('ThreadControllerImpl::RunTask', 'toplevel', 7000, 10, 8), X('ThreadControllerImpl::RunTask', 'toplevel', 7001, 5, 4), ...fitNamed(7002, 2)]
    events.push(X('ThreadControllerImpl::RunTask', 'toplevel', 8000, 5, 2), ...fitNamed(8000.5, 4.53))
    const own = ownTimes(events, q.resizes, [FIT, { start: 4000, ms: 120 }], fits)
    expect(own).toMatchObject({ fitCpu: 7 + 120 + 50 + 50 + 4 + 2, fitsTraced: 6 })
    // On a trace the page's clock cannot be put on, every fit is charged so.
    expect(ownTimes([META, ...fitNamed(2500.5, 1)], [], [FIT], [{ start: 2500.5, ms: 1 }])).toMatchObject({ fitCpu: 80, fitsTraced: 0 })
    expect(ownTimes(events, q.resizes, [])).toMatchObject({ fitCpu: 0, fitsTraced: 0 })
  })

  // Round 4 data (diag 45983711383, 45983723838, 45983738302): a fit's measure, named from the page's coarsened clock,
  // began up to 0.17 ms before its task and ended up to 0.07 ms after it, so the 50 us slack left it in no task and
  // charged the fit its long task's wall (1142 ms of a drag whose fits' tasks took 31).
  it("finds a fit's task by its measure within 0.25 ms, the one holding most of it; else the long task's own task the trace holds", () => {
    const q = quiet()
    const fits = [...q.fits, { start: 4000, ms: 120 }, { start: 5000, ms: 0.4 }, { start: 6000, ms: 150 }, { start: 7000, ms: 100 }]
    const events = [...q.events,
      // The measure 0.17 ms before its task's start and 0.07 ms past its end: 3 of thread time, not the long task's 130.
      X('ThreadControllerImpl::RunTask', 'toplevel', 4000.17, 119.76, 3), ...fitNamed(4000, 120),
      // Two tasks within 0.25 ms of a 0.4 ms measure, the shorter ending 0.15 ms into it, the other holding the rest of it
      // (0.25): that one (2), not the shorter's 0.1.
      X('ThreadControllerImpl::RunTask', 'toplevel', 4999.95, 0.2, 0.1), X('ThreadControllerImpl::RunTask', 'toplevel', 5000.15, 0.35, 2), ...fitNamed(5000, 0.4),
      // A measure the trace drops, in a long task whose own task the trace holds: that task's thread time (6).
      X('ThreadControllerImpl::RunTask', 'toplevel', 5999, 152, 6),
      // A measure 0.3 ms before its task: in no task; its long task's own task (4).
      X('ThreadControllerImpl::RunTask', 'toplevel', 7000.3, 99.8, 4), ...fitNamed(7000, 100)]
    const long = [FIT, { start: 4000, ms: 130 }, { start: 5999, ms: 152 }, { start: 7000, ms: 101 }]
    expect(ownTimes(events, q.resizes, long, fits)).toMatchObject({ fitCpu: 7 + 3 + 2 + 6 + 4, fitsTraced: 7 })
    // 0.26 ms before and after: in no task, and its long task's wall (none of the trace's tasks hold half of it).
    const far = [...q.events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000.26, 49, 3), ...fitNamed(4000, 49.52)]
    expect(ownTimes(far, q.resizes, [FIT, { start: 4000, ms: 110 }], [...q.fits, { start: 4000, ms: 49.52 }])).toMatchObject({ fitCpu: 7 + 110, fitsTraced: 3 })
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
