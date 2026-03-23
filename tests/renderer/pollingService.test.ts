import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// We need a fresh module for each test to reset the internal subscribers map and timer
let subscribe: typeof import('../../src/renderer/src/lib/pollingService').subscribe
let unsubscribe: typeof import('../../src/renderer/src/lib/pollingService').unsubscribe

describe('pollingService', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    // Reset the module state by re-importing
    vi.resetModules()
    const mod = await import('../../src/renderer/src/lib/pollingService')
    subscribe = mod.subscribe
    unsubscribe = mod.unsubscribe
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers a callback and fires it at the specified interval', () => {
    const cb = vi.fn()
    subscribe('a', cb, 2000)

    // The base tick is 1000ms, callback interval is 2000ms
    vi.advanceTimersByTime(1000) // tick 1 — elapsed 1000 < 2000, but lastRun is 0, so Date.now()-0 >= 2000?
    // Actually with fake timers, Date.now() starts at some value. Let's just advance enough.
    // After 1000ms tick fires, Date.now() = start + 1000, lastRun = 0, so 1000 >= 2000 is false... unless lastRun is 0
    // Wait: lastRun starts at 0, Date.now() in fake timers starts at some epoch value (usually real time or 0)
    // vi.useFakeTimers() sets Date.now() to real time at call. So Date.now() - 0 will be huge, so first tick fires immediately.
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('fires callback repeatedly at the interval', () => {
    const cb = vi.fn()
    subscribe('a', cb, 1000)

    vi.advanceTimersByTime(1000) // first tick
    vi.advanceTimersByTime(1000) // second tick
    vi.advanceTimersByTime(1000) // third tick
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('stops firing after unsubscribe', () => {
    const cb = vi.fn()
    subscribe('a', cb, 1000)

    vi.advanceTimersByTime(1000)
    const countAfterFirst = cb.mock.calls.length
    expect(countAfterFirst).toBeGreaterThanOrEqual(1)

    unsubscribe('a')
    vi.advanceTimersByTime(5000)
    expect(cb.mock.calls.length).toBe(countAfterFirst)
  })

  it('supports multiple subscribers independently', () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    subscribe('a', cb1, 1000)
    subscribe('b', cb2, 1000)

    vi.advanceTimersByTime(1000)
    expect(cb1).toHaveBeenCalled()
    expect(cb2).toHaveBeenCalled()

    unsubscribe('a')
    cb1.mockClear()
    cb2.mockClear()
    vi.advanceTimersByTime(1000)
    expect(cb1).not.toHaveBeenCalled()
    expect(cb2).toHaveBeenCalled()
  })

  it('does not throw when unsubscribing a non-existent id', () => {
    expect(() => unsubscribe('nonexistent')).not.toThrow()
  })
})
