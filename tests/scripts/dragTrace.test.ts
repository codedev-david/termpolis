import { describe, expect, it } from 'vitest'
import { DRAG_LIMITS, DRAG_TRACE, disjoint, dragVerdict, fitsNamed, isGpu, isWait, ownTimes, waitedIn, widestGap, type DragInput, type TraceEvent } from '../../e2e/helpers/dragTrace'
import { RESIZE_MEASURE } from '../../src/renderer/src/world/engine/bufferFit'

// The divider-drag check's clock and rules (e2e/helpers/dragTrace.ts) on made-up traces: the page's clock is OFF ms
// behind the trace's, the page's main thread is 1:1, and every time is in ms on the page's clock.
const OFF = 5000
const us = (ms: number): number => Math.round((ms + OFF) * 1000)
const META: TraceEvent = { name: 'thread_name', ph: 'M', ts: 0, pid: 1, tid: 1, cat: '__metadata', args: { name: 'CrRendererMain' } }
/** A complete event on the page's main thread (or `tid`), from `start` for `dur` ms of the wall and `tdur` of the thread. */
const X = (name: string, cat: string, start: number, dur: number, tdur: number, tid = 1): TraceEvent => ({ name, cat, ph: 'X', ts: us(start), dur: Math.round(dur * 1000), tdur: Math.round(tdur * 1000), pid: 1, tid })
let ids = 0
/** A resize the page named, as the trace holds it: a begin and an end in blink.user_timing (of process `pid`). */
const named = (start: number, ms: number, pid = 1): TraceEvent[] => {
  const id = `0x${(++ids).toString(16)}`
  return [
    { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'b', ts: us(start), pid, tid: 1, id },
    { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'e', ts: us(start + ms), pid, tid: 1, id },
  ]
}
/**
 * A quiet drag: `n` resizes of 2 ms of the thread, each in a task of its own 100 ms apart, the page naming each, and a
 * fit's task at 2500 ms: 80 ms on the wall, 75 of them waiting on the GPU.
 */
function quiet(n = 10): { events: TraceEvent[]; resizes: Array<{ start: number; ms: number }> } {
  const events: TraceEvent[] = [META]
  const resizes: Array<{ start: number; ms: number }> = []
  for (let k = 0; k < n; k++) {
    const t = 1000 + k * 100
    events.push(X('ThreadControllerImpl::RunTask', 'toplevel', t, 3, 3), X('FunctionCall', 'devtools.timeline', t + 0.5, 2.2, 2.2), ...named(t + 0.6, 2))
    resizes.push({ start: t + 0.6, ms: 2 })
  }
  events.push(X('ThreadControllerImpl::RunTask', 'toplevel', 2500, 80, 5), X('CommandBufferProxyImpl::WaitForGetOffset', 'gpu', 2502, 75, 0.5))
  return { events, resizes }
}
const FIT = { start: 2500, ms: 80, fit: true }
const input = (over: Partial<DragInput> = {}): DragInput => {
  const q = quiet()
  return { events: q.events, resizes: q.resizes, resizeCount: q.resizes.length, tasks: [FIT], fitCount: 3, widestGap: 600, platform: 'linux', ...over }
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

  it('pieces that overlap are counted once: one nested in another, or with its very bounds, is part of it; ones side by side are both', () => {
    const a = X('a', 'x', 0, 10, 10)
    const twin = X('twin', 'x', 0, 10, 10)
    const inner = X('inner', 'x', 2, 3, 3)
    const next = X('next', 'x', 10, 5, 5)
    const across = X('across', 'x', 12, 8, 8) // begins inside `next`: part of it
    expect(disjoint([inner, twin, a, next, across]).map((x) => x.dur)).toEqual([10_000, 5000])
    expect(disjoint([])).toEqual([])
  })

  it("puts the page's clock on the trace's by the resizes both name, and times each on the thread's clock", () => {
    const q = quiet()
    const own = ownTimes(q.events, q.resizes, [])
    expect(own.traced).toBe(10)
    expect(own.spread).toBeCloseTo(0, 3)
    expect(own.thread).toBe('CrRendererMain')
    expect(own.resizes.every((x) => x.matched && Math.abs(x.cpu - 2.2) < 1e-9 && x.own === 2 && x.waited === 0)).toBe(true)
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
    expect(one.resizes[0]).toMatchObject({ matched: true, wall: 4, cpu: 6, own: 4 })
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
    expect(r.cpu).toBe(23) // 40 less 10 and 7: the 2 ms and 1 ms between are not known to be outside
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
    expect(v.others[0]).toEqual({ wall: 300, own: 249, cpu: 150, waited: 99, gpu: 99, matched: true })
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
    expect(v.fits.map((x) => [x.cpu, x.waited, x.gpu])).toEqual([[60, 599, 599], [60, 0, 0]])
    expect(fails(v, 'ms of thread time')).toEqual([])
    expect(fails(v, 'beyond its waits on the GPU')).toEqual(['1500/0'])
  })

  // Round 2, Codex major 2: a fit's task the trace dropped skipped the thread-time rule, and "most" was 1 of 2.
  it("charges a fit's task the trace does not hold its wall as thread time, and wants 90% of them held (60 ms held and 600 ms dropped)", () => {
    const v = dragVerdict(input({ tasks: [FIT, { start: 9000, ms: 600, fit: true }] }))
    expect(v.fits[1]).toEqual({ wall: 600, own: 600, cpu: 600, waited: 0, gpu: 0, matched: false })
    expect(fails(v, 'ms of thread time')).toEqual(['600/600 (not traced)'])
    expect(fails(v, "of the fits' tasks")).toEqual(['1/2'])
    // Nine held of ten is enough, eight is not.
    const many = (held: number): string[] => fails(dragVerdict(input({ tasks: [...Array(held).fill(FIT), ...Array(10 - held).fill({ start: 9000, ms: 100, fit: true })] })), "of the fits' tasks")
    expect(many(9)).toEqual([])
    expect(many(8)).toEqual(['8/10'])
  })

  // Round 2, Codex minor: a fit named whose task the check never scored passed.
  it('wants a long task to hold a fit named, so the fits are scored', () => {
    expect(fails(dragVerdict(input({ tasks: [] })), 'a long task holds a fit named')).toEqual(['0/3'])
    expect(fails(dragVerdict(input({ tasks: [{ start: 4000, ms: 60, fit: false }] })), 'a long task holds a fit named')).toEqual(['0/3'])
    expect(fails(dragVerdict(input()), 'a long task holds a fit named')).toEqual([])
    // With no fit named, the rule that wants one fails alone.
    expect(fails(dragVerdict(input({ tasks: [], fitCount: 0 })), 'a long task holds a fit named')).toEqual([])
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
    expect(fails(g, `${DRAG_LIMITS.fitCeiling} ms on the wall`)).toEqual(['20000'])
    expect(fails(g, 'beyond its waits on the GPU')).toEqual([])
    const cc = at('cc', 'ProxyMain::SynchronizeState')
    expect(fails(cc, 'beyond its waits on the GPU')).toEqual(['20000/0'])
    expect(fails(cc, `${DRAG_LIMITS.fitCeiling} ms on the wall`)).toEqual(['20000'])
    // At the ceiling it passes.
    const edge = dragVerdict(input({ events: [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 8000, 50), X('ImplementationBase::WaitForCmd', 'gpu', 4010, 7900, 0)], tasks: [FIT, { start: 4000, ms: 8000, fit: true }] }))
    expect(broken(edge)).toEqual([])
  })

  // Round 2, Opus D11: a wait that runs past its task's end excused more than the task waited.
  it("counts a wait that runs past a fit's task, or a resize, only inside it", () => {
    // 1500 ms on the wall; a 2000 ms wait on the GPU of which 100 ms are inside the task.
    const v = dragVerdict(input({
      events: [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 1500, 60), X('ImplementationBase::WaitForCmd', 'gpu', 5400, 2000, 0)],
      tasks: [FIT, { start: 4000, ms: 1500, fit: true }],
    }))
    expect(v.fits[1]).toMatchObject({ gpu: 100, waited: 100 })
    expect(fails(v, 'beyond its waits on the GPU')).toEqual(['1500/100'])
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

  it('waitedIn: the union of the waits cut to the span, less the thread time of its outermost ones, pro rata', () => {
    const at = (a: number, d: number, td?: number): TraceEvent => ({ name: 'Wait', cat: 'base', ph: 'X', ts: a, dur: d, ...(td === undefined ? {} : { tdur: td }), pid: 1, tid: 1 })
    expect(waitedIn([], 0, 100)).toBe(0)
    expect(waitedIn([at(0, 10), at(5, 20)], 0, 100)).toBe(25) // [0,10] and [5,25]
    expect(waitedIn([at(0, 10), at(20, 10)], 0, 100)).toBe(20) // apart
    expect(waitedIn([at(0, 10), at(10, 10)], 0, 100)).toBe(20) // side by side
    expect(waitedIn([at(0, 20, 4), at(5, 5, 5)], 0, 100)).toBe(16) // nested: the outer's thread time holds the inner's
    expect(waitedIn([at(0, 10, 0), at(0, 10, 4)], 0, 100)).toBe(6) // the very bounds: the one with more thread time
    expect(waitedIn([at(0, 10, 10), at(5, 10, 4)], 0, 100)).toBe(3) // [0,10] all thread, [10,15] new: 5 less 4 pro rata (2)
    expect(waitedIn([at(-50, 100, 50)], 0, 20)).toBe(10) // cut to the span: 20 of it, 10 of its thread time pro rata
    expect(waitedIn([at(30, 10), at(-10, 5)], 0, 20)).toBe(0) // outside the span
    expect(waitedIn([at(0, 10, 30)], 0, 100)).toBe(0) // thread time over its wall: no wait
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
    expect(DRAG_LIMITS).toEqual({ resizeOwn: 16, resizeWall: 50, taskOwn: 200, taskWall: 350, fitCpu: 200, fitWall: 1000, fitCeiling: 8000, tracedResizes: 0.8, tracedFits: 0.9, gap: { win32: 5000, darwin: 7000, linux: 2000 } })
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

  // Round 2, Opus m2-2, Codex minor: one 7000 ms gap for every OS, and the release after the last move not counted.
  it("wants a fit named, and the pointer moves answered no more than each OS's gap apart, the release too", () => {
    expect(fails(dragVerdict(input({ fitCount: 0 })), 'its fit named')).toEqual(['no fit'])
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
    expect(fitsNamed(fits, 100, 1000)).toBe(3)
    expect(fitsNamed([], 0, 10)).toBe(0)
  })

  it('a GPU wait is one on the GPU process by its category, matched whole', () => {
    expect(isGpu(X('ImplementationBase::WaitForCmd', 'gpu', 0, 1, 0))).toBe(true)
    expect(isGpu(X('x', 'disabled-by-default-y,gpu', 0, 1, 0))).toBe(true)
    expect(isGpu(X('GpuChannel::WaitForGetOffsetInRange', 'mojom', 0, 1, 0))).toBe(false)
    expect(isGpu(X('x', 'gpuish', 0, 1, 0))).toBe(false)
  })

  it('a quiet drag breaks no rule, and the limits can be handed in', () => {
    expect(broken(dragVerdict(input()))).toEqual([])
    expect(dragVerdict(input()).fits).toEqual([{ wall: 80, own: 79.5, cpu: 5, waited: 74.5, gpu: 74.5, matched: true }])
    expect(broken(dragVerdict(input(), { ...DRAG_LIMITS, resizeOwn: 1 }))).toEqual([expect.stringContaining('under 1 ms of its own')])
  })
})
