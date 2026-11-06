// A clock a test moves by hand, for what the bridge does after a terminal has been quiet
// (src/main/remoteBridge/phoneResync.ts).
//
// Not vi.useFakeTimers: the bridge's emulator finishes every write off a real setTimeout, so a faked one leaves
// a feed waiting for ever, and a suite that is slow on a busy machine would let a real interval fire between two
// of a test's own steps. This clock only ever moves when the test says so, and it counts what is armed, which
// is the counter that proves an idle bridge pays nothing.
import type { Clock } from '../../../src/main/remoteBridge/phoneResync'

export interface ManualClock extends Clock {
  /** Move time on by `ms`, running every interval that falls due on the way, in order. */
  advance(ms: number): void
  /** Intervals set and not yet cleared. */
  armed(): number
  /** Callbacks run since the start. */
  ticks(): number
}

export function manualClock(): ManualClock {
  let at = 0
  let ticks = 0
  let nextId = 1
  const intervals = new Map<number, { fn: () => void; every: number; due: number }>()
  return {
    now: () => at,
    setInterval(fn, ms) {
      const id = nextId++
      intervals.set(id, { fn, every: ms, due: at + ms })
      return id
    },
    clearInterval(handle) {
      intervals.delete(handle as number)
    },
    advance(ms) {
      const to = at + ms
      for (;;) {
        // The earliest interval that is due by `to`, if any: time never jumps past one.
        let next: { id: number; due: number } | null = null
        for (const [id, i] of intervals) if (i.due <= to && (next === null || i.due < next.due)) next = { id, due: i.due }
        if (next === null) break
        at = next.due
        const i = intervals.get(next.id)!
        i.due += i.every
        ticks += 1
        i.fn()
      }
      at = to
    },
    armed: () => intervals.size,
    ticks: () => ticks,
  }
}
