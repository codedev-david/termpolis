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

  it('buffers data until rAF fires', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    throttled('hello ')
    throttled('world')
    expect(writeFn).not.toHaveBeenCalled()
    // Simulate rAF
    rafCallbacks.forEach(cb => cb())
    expect(writeFn).toHaveBeenCalledTimes(1)
    expect(writeFn).toHaveBeenCalledWith('hello world')
  })

  it('resets after flush and can buffer again', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    throttled('first')
    rafCallbacks.forEach(cb => cb())
    rafCallbacks = []
    throttled('second')
    rafCallbacks.forEach(cb => cb())
    expect(writeFn).toHaveBeenCalledTimes(2)
    expect(writeFn).toHaveBeenLastCalledWith('second')
  })

  it('splits large output into 64KB chunks across frames', () => {
    const writeFn = vi.fn()
    const throttled = createOutputThrottle(writeFn)
    // Write 150KB of data
    const bigData = 'x'.repeat(150 * 1024)
    throttled(bigData)

    // Drain rAF callbacks round by round (each flush may schedule another)
    function drainOne() {
      const cbs = [...rafCallbacks]
      rafCallbacks = []
      cbs.forEach(cb => cb())
    }

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
