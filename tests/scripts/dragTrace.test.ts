import { describe, expect, it } from 'vitest'
import { DRAG_LIMITS, DRAG_TRACE, disjoint, dragVerdict, isWait, ownTimes, type DragInput, type TraceEvent } from '../../e2e/helpers/dragTrace'
import { RESIZE_MEASURE } from '../../src/renderer/src/world/engine/bufferFit'

// The divider-drag check's clock and rules (e2e/helpers/dragTrace.ts) on made-up traces: the page's clock is OFF ms
// behind the trace's, the page's main thread is 1:1, and every time is in ms on the page's clock.
const OFF = 5000
const us = (ms: number): number => Math.round((ms + OFF) * 1000)
const META: TraceEvent = { name: 'thread_name', ph: 'M', ts: 0, pid: 1, tid: 1, cat: '__metadata', args: { name: 'CrRendererMain' } }
/** A complete event on the page's main thread (or `tid`), from `start` for `dur` ms of the wall and `tdur` of the thread. */
const X = (name: string, cat: string, start: number, dur: number, tdur: number, tid = 1): TraceEvent => ({ name, cat, ph: 'X', ts: us(start), dur: Math.round(dur * 1000), tdur: Math.round(tdur * 1000), pid: 1, tid })
let ids = 0
/** A resize the page named, as the trace holds it: a begin and an end in blink.user_timing. */
const named = (start: number, ms: number): TraceEvent[] => {
  const id = `0x${(++ids).toString(16)}`
  return [
    { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'b', ts: us(start), pid: 1, tid: 1, id },
    { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'e', ts: us(start + ms), pid: 1, tid: 1, id },
  ]
}
/**
 * A quiet drag: `n` resizes of 2 ms of the thread, each in a task of its own 100 ms apart, the page naming each.
 */
function quiet(n = 10): { events: TraceEvent[]; resizes: Array<{ start: number; ms: number }> } {
  const events: TraceEvent[] = [META]
  const resizes: Array<{ start: number; ms: number }> = []
  for (let k = 0; k < n; k++) {
    const t = 1000 + k * 100
    events.push(X('ThreadControllerImpl::RunTask', 'toplevel', t, 3, 3), X('FunctionCall', 'devtools.timeline', t + 0.5, 2.2, 2.2), ...named(t + 0.6, 2))
    resizes.push({ start: t + 0.6, ms: 2 })
  }
  return { events, resizes }
}
const input = (over: Partial<DragInput> = {}): DragInput => {
  const q = quiet()
  return { events: q.events, resizes: q.resizes, resizeCount: q.resizes.length, tasks: [], fitCount: 3, widestGap: 600, ...over }
}
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
    expect(lost.resizes.filter((x) => !x.matched)).toEqual([{ wall: 2, own: 2, cpu: 2, waited: 0, matched: false }, { wall: 3, own: 3, cpu: 3, waited: 0, matched: false }])
    const none = ownTimes([META], q.resizes, [{ start: 1300, ms: 60 }])
    expect(none.traced).toBe(0)
    expect(none.spread).toBeNaN()
    expect(none.thread).toBe('')
    expect(none.tasks).toEqual([{ wall: 60, own: 60, cpu: 60, waited: 0, matched: false }])
    // A resize as one complete event in the trace is paired the same way, and an end with no begin is no resize.
    const complete: TraceEvent = { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'X', ts: us(3000), dur: 4000, pid: 1, tid: 1 }
    const orphan: TraceEvent = { name: RESIZE_MEASURE, cat: 'blink.user_timing', ph: 'b', ts: us(3500), pid: 1, tid: 1, id2: { local: '0xbeef' } }
    const one = ownTimes([META, X('RunTask', 'toplevel', 2999, 6, 6), complete, orphan], [{ start: 3000, ms: 4 }], [])
    expect(one.resizes[0]).toMatchObject({ matched: true, wall: 4, cpu: 6, own: 4 })
    // A resize with no work around it in the trace is timed on the wall.
    const bare = ownTimes([META, ...named(100, 5)], [{ start: 100, ms: 5 }], [])
    expect(bare.resizes[0]).toEqual({ wall: 5, own: 5, cpu: 5, waited: 0, matched: false })
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
    expect(v.others).toEqual([{ wall: 450, own: 35, cpu: 35, waited: 0, matched: true }])
    expect(fails(v, 'on the wall, the fit\'s left out')).toEqual(['450'])
    expect(fails(v, 'of its own, the fit\'s left out')).toEqual([])
  })

  it("charges a long task its thread time and its waits, and one the trace does not hold its wall", () => {
    const events = [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 300, 150), X('CommandBufferProxyImpl::WaitForGetOffsetInRange', 'gpu', 4100, 100, 1)]
    const v = dragVerdict(input({ events, tasks: [{ start: 4000, ms: 300, fit: false }, { start: 9000, ms: 210, fit: false }] }))
    expect(v.others[0]).toEqual({ wall: 300, own: 249, cpu: 150, waited: 99, matched: true })
    expect(v.others[1]).toEqual({ wall: 210, own: 210, cpu: 210, waited: 0, matched: false })
    expect(fails(v, 'of its own, the fit\'s left out')).toEqual(['300/249', '210/210'])
  })

  // Opus I-2, Codex major 3: every task that held a fit's measure was left out of every rule.
  it("bounds the thread time of a fit's task, the work after the fit's measure too (a 600 ms loop after the fit)", () => {
    const events = [...quiet().events, X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 700, 640), X('TimerFire', 'devtools.timeline', 4000.1, 699.8, 639.8)]
    const v = dragVerdict(input({ events, tasks: [{ start: 4000, ms: 700, fit: true }] }))
    expect(v.fits).toEqual([{ wall: 700, own: 640, cpu: 640, waited: 0, matched: true }])
    expect(v.others).toEqual([])
    expect(fails(v, 'of thread time, its waits on the GPU left out')).toEqual(['700/640'])
  })

  it("lets a fit's task wait on the GPU (in software its GL calls do), and bounds it on the wall beyond its waits", () => {
    const events = [...quiet().events,
      X('ThreadControllerImpl::RunTask', 'toplevel', 4000, 700, 60), X('CommandBufferProxyImpl::WaitForGetOffsetInRange', 'gpu', 4010, 600, 1),
      X('ThreadControllerImpl::RunTask', 'toplevel', 6000, 1500, 60)]
    const v = dragVerdict(input({ events, tasks: [{ start: 4000, ms: 700, fit: true }, { start: 6000, ms: 1500, fit: true }] }))
    expect(v.fits.map((x) => [x.cpu, x.waited])).toEqual([[60, 599], [60, 0]])
    expect(fails(v, 'of thread time, its waits on the GPU left out')).toEqual([])
    expect(fails(v, 'on the wall beyond its waits')).toEqual(['1500/0'])
  })

  it("does not judge the thread time of a fit's task the trace does not hold, only its wall, and wants most of them held", () => {
    const v = dragVerdict(input({ tasks: [{ start: 9000, ms: 400, fit: true }] }))
    expect(v.fits).toEqual([{ wall: 400, own: 400, cpu: 400, waited: 0, matched: false }])
    expect(fails(v, 'of thread time, its waits on the GPU left out')).toEqual([])
    expect(fails(v, 'on the wall beyond its waits')).toEqual([])
    expect(fails(v, "the trace holds most of the fits' tasks")).toEqual(['0/1'])
  })

  // Codex minor: a resize whose measure the page failed to name dropped out of every rule.
  it('holds the resizes the page named to the ones the renderer timed, so a resize left unnamed shows', () => {
    const q = quiet()
    expect(fails(dragVerdict(input({ resizes: q.resizes.slice(1), resizeCount: q.resizes.length })), 'each resize named')).toEqual(['9/10'])
    expect(fails(dragVerdict(input({ resizes: [], resizeCount: 0 })), 'each resize named')).toEqual(['0/0'])
    expect(fails(dragVerdict(input({ resizes: [], resizeCount: 0 })), 'the trace holds most of the resizes')).toEqual([])
    expect(fails(dragVerdict(input({ events: [META] })), 'the trace holds most of the resizes')).toEqual(['0/10'])
  })

  it('wants a fit named, and the pointer moves answered no more than the gap apart', () => {
    expect(fails(dragVerdict(input({ fitCount: 0 })), 'its fit named')).toEqual(['no fit'])
    expect(fails(dragVerdict(input({ widestGap: DRAG_LIMITS.gap + 1 })), 'pointer moves')).toEqual([`${DRAG_LIMITS.gap + 1}`])
    expect(fails(dragVerdict(input({ widestGap: DRAG_LIMITS.gap })), 'pointer moves')).toEqual([])
  })

  it('a quiet drag breaks no rule, and the limits can be handed in', () => {
    expect(broken(dragVerdict(input()))).toEqual([])
    expect(broken(dragVerdict(input(), { ...DRAG_LIMITS, resizeOwn: 1 }))).toEqual([expect.stringContaining('under 1 ms of its own')])
  })
})
