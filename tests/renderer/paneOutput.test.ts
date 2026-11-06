import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createPaneOutput, classifyPane } from '../../src/renderer/src/lib/paneOutput'
import { createWriteScheduler, getWriteScheduler, resetWriteScheduler, DEFAULT_LIMITS as D } from '../../src/renderer/src/lib/writeScheduler'
import { SWITCH_WRITE_SCHEDULER, SWITCH_OUTPUT_CHUNKS } from '../../src/renderer/src/lib/paneSwitches'
import { makeManualClock } from './helpers/schedulerHarness'

// The one call a pane makes to get its output writer (1.54.5): the write scheduler by default, the output
// throttle behind the kill switches. What is asserted: which path each switch gives, that the pane's own
// hooks (the echo trace's tap, visible, active) are honoured, and what a pane gets back either way.

/** A fake xterm that acks as it is told to. */
function fakeTerm() {
  const writes: Array<{ data: string; ack?: () => void }> = []
  let refuse = false
  return {
    writes,
    setRefuse: (v: boolean) => { refuse = v },
    write: (data: string, ack?: () => void) => {
      if (refuse) throw new Error('write data discarded, use flow control to avoid losing data')
      writes.push({ data, ack })
    },
    joined: () => writes.map((w) => w.data).join(''),
  }
}

let visible = true
let active = false

function make(id: string, opts: { chunked?: boolean; term?: ReturnType<typeof fakeTerm>; tap?: (fn: (d: string) => void) => (d: string) => void; scheduler?: ReturnType<typeof createWriteScheduler> } = {}) {
  const term = opts.term ?? fakeTerm()
  const out = createPaneOutput({
    id, term, tap: opts.tap, chunked: opts.chunked ?? true,
    isVisible: () => visible, isActive: () => active, scheduler: opts.scheduler,
  })
  return { out, term }
}

beforeEach(() => {
  visible = true
  active = false
  window.localStorage.clear()
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16))
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  window.localStorage.clear()
  resetWriteScheduler()
  delete (window as unknown as { __termpolis_write_scheduler?: unknown }).__termpolis_write_scheduler
})

describe('classifyPane', () => {
  it.each([
    [false, false, 'hidden'],
    [false, true, 'hidden'], // active but not on screen: nobody is looking
    [true, false, 'visible'],
    [true, true, 'focused'],
  ] as const)('visible=%s active=%s is %s', (v, a, want) => {
    expect(classifyPane(v, a)).toBe(want)
  })
})

describe('the write scheduler path (the default)', () => {
  it('writes through the scheduler, with an ack callback, and tells it the pane is on screen or not as it changes', () => {
    const clock = makeManualClock()
    const scheduler = createWriteScheduler({ clock })
    visible = false
    const { out, term } = make('p', { scheduler })
    expect(out.scheduled).toBe(true)
    out('x'.repeat(300_000))
    clock.frame()
    expect(term.writes.map((w) => w.data.length)).toEqual([D.slice.hidden, D.slice.hidden]) // hidden: 32 KB slices, two in flight
    expect(typeof term.writes[0].ack).toBe('function')
    term.writes.forEach((w) => w.ack!())
    visible = true // shown: the next pass serves it as a visible pane, no notification needed
    clock.frame()
    expect(term.writes[2].data).toHaveLength(D.slice.visible)
    active = true
    term.writes[2].ack!()
    clock.frame()
    expect(out.inflight()).toBeGreaterThan(0)
    scheduler.dispose()
  })

  it('the active terminal is the focused one: it is served before another pane, whatever order they registered in', () => {
    const clock = makeManualClock()
    const scheduler = createWriteScheduler({ clock })
    const order: string[] = []
    const mk = (id: string, isActive: boolean) => {
      const t = { write: (d: string, cb?: () => void) => { order.push(id); void d; void cb } }
      return createPaneOutput({ id, term: t, chunked: true, isVisible: () => true, isActive: () => isActive, scheduler })
    }
    const other = mk('other', false)
    const focused = mk('focused', true)
    other('y'.repeat(20_000))
    focused('y'.repeat(20_000))
    clock.frame()
    expect(order).toEqual(['focused', 'other'])
    scheduler.dispose()
  })

  it('counts every chunk handed to xterm through the echo trace tap, once, and not the ones still queued', () => {
    const clock = makeManualClock()
    const scheduler = createWriteScheduler({ clock })
    const counted: number[] = []
    const tap = (fn: (d: string) => void) => (d: string) => { counted.push(d.length); fn(d) }
    const { out, term } = make('p', { scheduler, tap })
    out('a'.repeat(300_000))
    expect(counted).toEqual([])
    clock.frame()
    expect(counted).toEqual(term.writes.map((w) => w.data.length))
    expect(counted.reduce((a, b) => a + b, 0)).toBe(D.inflight.visible)
    scheduler.dispose()
  })

  it('exposes pending(), whenDrained() and typed()/detach(), which the echo trace, the resize barrier and the pane call', () => {
    const clock = makeManualClock()
    const scheduler = createWriteScheduler({ clock })
    const { out, term } = make('p', { scheduler })
    out('b'.repeat(200_000))
    expect(out.pending()).toBe(200_000)
    const drained = vi.fn()
    out.whenDrained(drained, 60_000)
    expect(drained).not.toHaveBeenCalled()
    for (let i = 0; i < 40 && out.pending() > 0; i++) {
      clock.frame()
      term.writes.forEach((w) => w.ack?.())
    }
    expect(out.pending()).toBe(0)
    expect(drained).toHaveBeenCalledTimes(1)
    out.typed('k')
    expect(scheduler.stats().keys).toBe(1)
    out.typed('\x1b[I') // a focus report is not typing
    expect(scheduler.stats().keys).toBe(1)
    out.detach()
    expect(scheduler.stats().panes).toBe(0)
    scheduler.dispose()
  })

  it('uses the renderer-wide scheduler unless one is passed, and shows its counters to the e2e specs', () => {
    const { out } = make('p')
    expect(out.scheduled).toBe(true)
    expect(getWriteScheduler().stats().panes).toBe(1)
    const counters = (window as unknown as { __termpolis_write_scheduler: () => { panes: number } }).__termpolis_write_scheduler
    expect(counters().panes).toBe(1)
    out.detach()
    expect(counters().panes).toBe(0)
  })

  it('a second pane under the same id (a remount) takes over from the first', () => {
    const a = make('same')
    const b = make('same')
    expect(getWriteScheduler().stats().panes).toBe(1)
    a.out('old') // the replaced writer has no place in the scheduler any more: it goes quiet
    b.out('new')
    expect(a.term.joined()).toBe('')
    expect(b.term.joined()).toBe('new')
  })

  it('a refused chunk is kept and offered again (the pane never loses output to xterm\'s refusal)', () => {
    vi.useFakeTimers()
    const clock = makeManualClock()
    const scheduler = createWriteScheduler({ clock })
    const term = fakeTerm()
    term.setRefuse(true)
    const { out } = make('p', { scheduler, term })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    out('keep me')
    expect(term.writes).toEqual([])
    expect(out.pending()).toBe(7)
    term.setRefuse(false)
    clock.frame()
    expect(term.joined()).toBe('keep me')
    errors.mockRestore()
    scheduler.dispose()
  })
})

describe('the kill switches give every pane its own output throttle again', () => {
  it("localStorage 'termpolis.writeScheduler' = '0': the chunk-list throttle of 1.54.5, write(data) with one argument, hooks are no-ops", () => {
    vi.useFakeTimers()
    window.localStorage.setItem(SWITCH_WRITE_SCHEDULER, '0')
    const counted: number[] = []
    const tap = (fn: (d: string) => void) => (d: string) => { counted.push(d.length); fn(d) }
    const { out, term } = make('p', { tap })
    expect(out.scheduled).toBe(false)
    out('hello')
    expect(term.writes).toEqual([{ data: 'hello', ack: undefined }]) // the throttle's call shape, no callback
    expect(counted).toEqual([5])
    out.typed('k')
    out.detach()
    expect(out.discard()).toBe(0) // a Clear drops nothing on the throttle path (1.54.4)
    expect(out.pending()).toBe(0)
    expect(getWriteScheduler().stats().panes).toBe(0) // the scheduler never heard of it
  })

  it('the throttle path still keeps a refused chunk (retryRefused) while only the scheduler switch is off', () => {
    vi.useFakeTimers()
    window.localStorage.setItem(SWITCH_WRITE_SCHEDULER, '0')
    const term = fakeTerm()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { out } = make('p', { term })
    term.setRefuse(true)
    out('keep me')
    expect(out.pending()).toBe(7)
    term.setRefuse(false)
    vi.advanceTimersByTime(300)
    expect(term.joined()).toBe('keep me')
    errors.mockRestore()
  })

  it("localStorage 'termpolis.outputChunks' = '0': the whole 1.54.4 output path is back, the scheduler is not part of it", () => {
    vi.useFakeTimers()
    const term = fakeTerm()
    const { out } = make('p', { chunked: false, term })
    expect(out.scheduled).toBe(false)
    out('hello')
    expect(term.writes).toEqual([{ data: 'hello', ack: undefined }])
    term.setRefuse(true)
    expect(() => out('x')).toThrow(/discarded/) // 1.54.4: a refusal reaches the caller and nothing is kept
    expect(getWriteScheduler().stats().panes).toBe(0)
  })

  it('NEGATIVE CONTROL: without either switch the pane is on the scheduler', () => {
    const { out } = make('p')
    expect(out.scheduled).toBe(true)
    expect(SWITCH_OUTPUT_CHUNKS).toBe('termpolis.outputChunks') // the names the docs and the switches test use
    expect(SWITCH_WRITE_SCHEDULER).toBe('termpolis.writeScheduler')
  })

  it('storage that cannot be read leaves the scheduler ON: a switch is for turning the fix off on purpose', () => {
    const real = window.localStorage
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('blocked site data') } })
    try {
      const { out } = make('p')
      expect(out.scheduled).toBe(true)
    } finally {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: real })
    }
  })

  it('any value but 0 leaves it on', () => {
    window.localStorage.setItem(SWITCH_WRITE_SCHEDULER, '1')
    expect(make('p').out.scheduled).toBe(true)
    window.localStorage.setItem(SWITCH_WRITE_SCHEDULER, 'false')
    expect(make('q').out.scheduled).toBe(true)
  })
})
