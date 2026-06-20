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
