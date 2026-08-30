import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOutputThrottle } from '../../src/renderer/src/lib/outputThrottle'

describe('createOutputThrottle', () => {
  let rafCallbacks: (() => void)[] = []

  beforeEach(() => {
    rafCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  function drainOne() {
    const cbs = [...rafCallbacks]
    rafCallbacks = []
    cbs.forEach(cb => cb())
  }

  // A small write while the throttle is idle is the keystroke-echo case: the
  // PTY echoes the typed character straight back, and it must appear instantly.
  // Frame-deferring it (the old behavior) added ~1 animation frame of latency
  // to every keystroke.
  it('flushes a small idle write synchronously without scheduling a frame', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    throttled('a')
    expect(writeFn).toHaveBeenCalledTimes(1)
    expect(writeFn).toHaveBeenCalledWith('a')
    // No frame scheduled — the echo did not wait for rAF.
    expect(rafCallbacks.length).toBe(0)
  })

  it('flushes several small idle writes immediately and in order', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    throttled('h')
    throttled('i')
    expect(writeFn).toHaveBeenCalledTimes(2)
    expect(writeFn).toHaveBeenNthCalledWith(1, 'h')
    expect(writeFn).toHaveBeenNthCalledWith(2, 'i')
    expect(rafCallbacks.length).toBe(0)
  })

  // A keystroke echo isn't always one byte: PowerShell PSReadLine repaints the
  // whole input line (+ a prediction suggestion) on every keypress — a few KB.
  // That must still take the instant path, or the first keystroke in a new
  // terminal lags while the line repaint waits on a starved frame.
  it('flushes a multi-KB idle write (a PSReadLine line repaint) synchronously', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    const repaint = 'x'.repeat(4096)
    throttled(repaint)
    expect(writeFn).toHaveBeenCalledTimes(1)
    expect(writeFn).toHaveBeenCalledWith(repaint)
    expect(rafCallbacks.length).toBe(0)
  })

  // Boundary: at the limit it's still instant; one byte over coalesces.
  it('flushes exactly at the bypass limit but coalesces just above it', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    throttled('x'.repeat(8192)) // at the limit → instant
    expect(writeFn).toHaveBeenCalledTimes(1)
    expect(rafCallbacks.length).toBe(0)

    const writeFn2 = vi.fn()
    const throttled2 = createOutputThrottle(writeFn2)
    throttled2('x'.repeat(8193)) // one over → deferred to a frame
    expect(writeFn2).not.toHaveBeenCalled()
    expect(rafCallbacks.length).toBe(1)
  })

  // Bulk output (large chunks) is still coalesced through a single rAF so a
  // flood can't spike memory or thrash the renderer.
  it('batches a large write through requestAnimationFrame', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    const big = 'x'.repeat(16384)
    throttled(big)
    expect(writeFn).not.toHaveBeenCalled()
    drainOne()
    expect(writeFn).toHaveBeenCalledTimes(1)
    expect(writeFn).toHaveBeenCalledWith(big)
  })

  // Ordering safety: once a burst is in flight (a frame is scheduled),
  // subsequent small writes must NOT jump ahead via the fast path — they append
  // to the buffer and flush in their original order.
  it('keeps small writes ordered behind an in-flight burst', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    const big = 'x'.repeat(16384)
    throttled(big) // schedules a frame
    throttled('!') // must queue behind the burst, not write immediately
    expect(writeFn).not.toHaveBeenCalled()
    drainOne()
    expect(writeFn).toHaveBeenCalledTimes(1)
    expect(writeFn).toHaveBeenCalledWith(big + '!')
  })

  it('returns to the instant fast path after a burst flushes', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    throttled('x'.repeat(16384))
    drainOne()
    expect(writeFn).toHaveBeenCalledTimes(1)
    // Idle again — a small write should be synchronous once more.
    throttled('y')
    expect(writeFn).toHaveBeenCalledTimes(2)
    expect(writeFn).toHaveBeenLastCalledWith('y')
    expect(rafCallbacks.length).toBe(0)
  })

  it('splits large output into 64KB chunks across frames', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    // Write 150KB of data
    const bigData = 'x'.repeat(150 * 1024)
    throttled(bigData)

    // First frame: flushes 64KB
    drainOne()
    expect(writeFn).toHaveBeenCalledTimes(1)
    expect(writeFn.mock.calls[0][0].length).toBe(65536)
    // Second frame: flushes another 64KB
    drainOne()
    expect(writeFn).toHaveBeenCalledTimes(2)
    expect(writeFn.mock.calls[1][0].length).toBe(65536)
    // Third frame: flushes remaining ~19KB
    drainOne()
    expect(writeFn).toHaveBeenCalledTimes(3)
    expect(writeFn.mock.calls[2][0].length).toBe(150 * 1024 - 65536 * 2)
  })
})

/**
 * REGRESSION (2026-08-25, field report): "the termpolis window is not in focus or something, it
 * stops working."
 *
 * Chromium stops firing requestAnimationFrame entirely when a page is hidden or OCCLUDED — and on
 * Windows a Termpolis window with anything covering it is occluded, not merely unfocused. The
 * throttle scheduled every non-trivial write through rAF alone, so once frames stopped:
 *   - the pending flush never ran,
 *   - `scheduled` stayed true forever, which also routes the small-write bypass into the buffer,
 *     so even keystroke echo went dark,
 *   - and the buffer grew without bound until the window came back, then dumped at 64KB/frame.
 * The terminal was dead for as long as something sat on top of the window.
 *
 * rAF stays the fast path — it is the right clock while frames are being produced. A timer
 * watchdog runs beside it so the buffer always drains, whether or not the compositor is awake.
 */
describe('createOutputThrottle — drains when the window is hidden/occluded (no frames)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // A window Chromium considers hidden: rAF is registered and NEVER invoked.
    vi.stubGlobal('requestAnimationFrame', () => 1)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('writes a buffered burst even though no frame ever fires', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    const big = 'x'.repeat(20000) // over the small-write bypass → buffered
    throttled(big)
    expect(writeFn).not.toHaveBeenCalled() // nothing yet: no frame has run
    vi.advanceTimersByTime(200)
    expect(writeFn).toHaveBeenCalledWith(big) // the watchdog drained it
  })

  it('does not wedge the small-write bypass — typing still echoes with no frames', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    throttled('y'.repeat(20000)) // arms the buffer
    vi.advanceTimersByTime(200)
    writeFn.mockClear()
    throttled('a') // a keystroke echo AFTER the burst drained
    expect(writeFn).toHaveBeenCalledWith('a') // instant, not queued behind a dead frame
  })

  it('keeps ordering: buffered burst first, then later writes', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    throttled('A'.repeat(20000))
    throttled('B') // small, but a burst is in flight → must queue behind it
    vi.advanceTimersByTime(200)
    expect(writeFn.mock.calls.map((c) => c[0]).join('')).toBe('A'.repeat(20000) + 'B')
  })
})

describe('createOutputThrottle — environments with no animation frames at all', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Not "frames have stopped" but "this environment has no rAF" — a renderer teardown, a non-DOM
    // host. The watchdog is then the ONLY clock, and it still has to deliver the output.
    vi.stubGlobal('requestAnimationFrame', undefined)
    vi.stubGlobal('cancelAnimationFrame', undefined)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('still delivers a buffered burst with no rAF to schedule against', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    const big = 'z'.repeat(20000)
    throttled(big)
    vi.advanceTimersByTime(200)
    expect(writeFn).toHaveBeenCalledWith(big)
  })

  it('does not try to cancel a frame it never scheduled', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    throttled('q'.repeat(20000))
    expect(() => vi.advanceTimersByTime(200)).not.toThrow()
    throttled('a') // and the throttle is left in a usable state afterwards
    expect(writeFn).toHaveBeenLastCalledWith('a')
  })
})
