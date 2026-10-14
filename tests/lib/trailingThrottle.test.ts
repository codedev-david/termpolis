import { describe, it, expect, vi, afterEach } from 'vitest'
import { createTrailingThrottle } from '../../src/renderer/src/lib/trailingThrottle'

/** A clock that only moves when a test says so: `advance` runs every timer that comes due, in
 *  order, with `now` set to each one's due time — so the window is asserted exactly. */
function fakeClock(start = 10_000) {
  let now = start
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: (): number => now,
    setTimer: (fn: () => void, ms: number): unknown => {
      const handle = next++
      timers.set(handle, { at: now + ms, fn })
      return handle
    },
    clearTimer: (handle: unknown): void => {
      timers.delete(handle as number)
    },
    advance(ms: number): void {
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = until
    },
    armed: (): number => timers.size,
  }
}

const harness = (intervalMs = 500) => {
  const clock = fakeClock()
  const runs: number[] = []
  const t = createTrailingThrottle(() => runs.push(clock.now()), intervalMs, clock)
  return { clock, runs, t }
}

describe('createTrailingThrottle', () => {
  it('runs the first request synchronously — a lone prompt is parsed with no delay', () => {
    const { clock, runs, t } = harness()
    t.request()
    expect(runs).toEqual([clock.now()])
    expect(clock.armed()).toBe(0)
  })

  it('a request inside the window is deferred to the window end, not dropped', () => {
    // The bug, in miniature: Enter's echo spends the window, the prompt lands 30 ms later, and
    // nothing else ever arrives. Leading-edge-only lost that prompt for good.
    const { clock, runs, t } = harness()
    t.request() // the echo
    const echoAt = clock.now()
    clock.advance(30)
    t.request() // the prompt
    expect(runs).toEqual([echoAt])
    clock.advance(469)
    expect(runs).toHaveLength(1)
    clock.advance(1)
    expect(runs).toEqual([echoAt, echoAt + 500])
  })

  it('N requests inside one window produce exactly one trailing run', () => {
    const { clock, runs, t } = harness()
    t.request()
    for (let i = 0; i < 10; i++) {
      clock.advance(20)
      t.request()
    }
    expect(clock.armed()).toBe(1)
    clock.advance(1_000)
    expect(runs).toHaveLength(2)
  })

  it('a request inside the window that FOLLOWS a trailing run is scheduled, not run', () => {
    // The trailing run starts a window of its own, so the budget stays one run per interval.
    const { clock, runs, t } = harness()
    t.request()
    clock.advance(100)
    t.request()
    clock.advance(400) // trailing run at +500
    expect(runs).toHaveLength(2)
    clock.advance(100)
    t.request()
    expect(runs).toHaveLength(2)
    clock.advance(400)
    expect(runs).toHaveLength(3)
    expect(runs[2] - runs[1]).toBe(500)
  })

  it('a request after an idle interval runs immediately again', () => {
    const { clock, runs, t } = harness()
    t.request()
    clock.advance(500)
    t.request()
    expect(runs).toHaveLength(2)
    expect(clock.armed()).toBe(0)
  })

  it('cancel drops the scheduled run; with nothing scheduled it is a no-op', () => {
    const { clock, runs, t } = harness()
    t.cancel() // nothing scheduled
    t.request()
    clock.advance(50)
    t.request()
    t.cancel()
    expect(clock.armed()).toBe(0)
    clock.advance(1_000)
    expect(runs).toHaveLength(1)
    // ...and the throttle still works afterwards.
    t.request()
    expect(runs).toHaveLength(2)
  })

  it('a throwing fn does not wedge the throttle', () => {
    const clock = fakeClock()
    let calls = 0
    const t = createTrailingThrottle(() => {
      calls++
      throw new Error('parse blew up')
    }, 500, clock)
    expect(() => t.request()).toThrow('parse blew up')
    clock.advance(10)
    t.request()
    expect(() => clock.advance(500)).toThrow('parse blew up')
    clock.advance(500)
    expect(() => t.request()).toThrow('parse blew up')
    expect(calls).toBe(3)
  })

  describe('default clock', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('runs on fake timers installed AFTER the module was imported', () => {
      // TerminalPane's tests fake timers per test, long after this module loaded. A default clock
      // that captured setTimeout/Date.now at import time would escape them and fire for real.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const fn = vi.fn()
      const t = createTrailingThrottle(fn, 500)
      t.request()
      vi.advanceTimersByTime(100)
      t.request()
      expect(fn).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(399)
      expect(fn).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      expect(fn).toHaveBeenCalledTimes(2)

      vi.advanceTimersByTime(100)
      t.request()
      t.cancel()
      vi.advanceTimersByTime(1_000)
      expect(fn).toHaveBeenCalledTimes(2)
    })
  })
})
