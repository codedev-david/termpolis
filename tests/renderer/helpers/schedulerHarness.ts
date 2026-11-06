// Test doubles for the write scheduler (1.54.5). No wall clock anywhere: every time here is virtual, so a
// test that passes passes on a loaded laptop too, and what it asserts are counters (chars in flight, writes
// made, passes run), never how long something took.

import type { SchedulerClock } from '../../../src/renderer/src/lib/writeScheduler'

// ---------------------------------------------------------------------------------------------------------
// A seeded PRNG (mulberry32), so a failing schedule can be replayed from its seed.
// ---------------------------------------------------------------------------------------------------------
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------------------------------------
// A clock the test turns by hand.
// ---------------------------------------------------------------------------------------------------------
export interface ManualClock extends SchedulerClock {
  /** Run the timers due within `ms` of virtual time, in order; `now()` ends `ms` later. */
  advance(ms: number): void
  /** A frame: `ms` pass (timers due in them run), then the animation-frame callbacks still pending run. */
  frame(ms?: number): void
  pendingFrames(): number
  pendingTimers(): number
}

export function makeManualClock(start = 1_000_000): ManualClock {
  let now = start
  let nextId = 1
  let order = 0
  const timers = new Map<number, { due: number; order: number; cb: () => void }>()
  const frames = new Map<number, () => void>()
  const clock: ManualClock = {
    now: () => now,
    requestFrame: (cb) => {
      const id = nextId++
      frames.set(id, cb)
      return id
    },
    cancelFrame: (h) => {
      frames.delete(h as number)
    },
    setTimer: (cb, ms) => {
      const id = nextId++
      timers.set(id, { due: now + Math.max(0, ms), order: order++, cb })
      return id
    },
    clearTimer: (h) => {
      timers.delete(h as number)
    },
    advance: (ms) => {
      const target = now + ms
      for (;;) {
        let best: number | null = null
        for (const [id, t] of timers) {
          if (t.due > target) continue
          if (best === null || t.due < timers.get(best)!.due || (t.due === timers.get(best)!.due && t.order < timers.get(best)!.order)) best = id
        }
        if (best === null) break
        const t = timers.get(best)!
        timers.delete(best)
        now = Math.max(now, t.due)
        t.cb()
      }
      now = target
    },
    frame: (ms = 16) => {
      clock.advance(ms)
      for (const [id, cb] of Array.from(frames)) {
        if (!frames.has(id)) continue // an earlier callback of this frame cancelled it
        frames.delete(id)
        cb()
      }
    },
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.size,
  }
  return clock
}

// ---------------------------------------------------------------------------------------------------------
// A terminal that records what it is written, and acks the way xterm does: oldest first, when told to.
// ---------------------------------------------------------------------------------------------------------
export interface WriteEvent {
  id: string
  data: string
}

export interface FakeTerm {
  readonly id: string
  /** The scheduler's `PaneDeps.write`. */
  write(data: string, ack: () => void): void
  /** Everything written to it, in order. */
  readonly writes: string[]
  /** Chars written so far (a running total: no need to join the writes to count them). */
  writtenChars: number
  /** Written, not acked yet, oldest first. */
  readonly unacked: Array<{ data: string; ack: () => void }>
  unackedChars(): number
  /** Ack the `n` oldest unacked writes (all by default), the way xterm's write callbacks arrive. */
  ack(n?: number): void
  joined(): string
  /** 'sync': ack inside write(), as xterm does for a user-input write to an idle queue. */
  mode: 'manual' | 'sync'
  /** Throw from write() when this says so (`attempt` counts the refusals of this term so far). */
  refuse: ((data: string, attempt: number) => boolean) | null
}

export function makeFakeTerm(id: string, shared?: WriteEvent[]): FakeTerm {
  const writes: string[] = []
  const unacked: Array<{ data: string; ack: () => void }> = []
  let refusals = 0
  const t: FakeTerm = {
    id,
    writes,
    writtenChars: 0,
    unacked,
    mode: 'manual',
    refuse: null,
    write(data, ack) {
      if (t.refuse?.(data, refusals)) {
        refusals++
        throw new Error('write data discarded, use flow control to avoid losing data')
      }
      writes.push(data)
      t.writtenChars += data.length
      shared?.push({ id, data })
      if (t.mode === 'sync') {
        ack()
        return
      }
      unacked.push({ data, ack })
    },
    unackedChars: () => unacked.reduce((n, u) => n + u.data.length, 0),
    ack(n) {
      const k = n === undefined ? unacked.length : Math.min(n, unacked.length)
      for (let i = 0; i < k; i++) unacked.shift()!.ack()
    },
    joined: () => writes.join(''),
  }
  return t
}

// ---------------------------------------------------------------------------------------------------------
// A virtual event loop: ONE thread, timers in due order, and a task that is `busy` advances the clock for
// everybody (which is what makes terminals share a thread).
// ---------------------------------------------------------------------------------------------------------
export class VirtualLoop {
  now = 0
  /** The shortest a setTimeout(fn, 0) waits. Chromium clamps nested timers to 4 ms; 1 is the kind case. */
  minTimerMs: number
  private nextId = 1
  private order = 0
  private timers: Array<{ id: number; due: number; order: number; fn: () => void }> = []

  constructor(minTimerMs = 1) {
    this.minTimerMs = minTimerMs
  }

  setTimeout = (fn: () => void, ms = 0): number => {
    const id = this.nextId++
    this.timers.push({ id, due: this.now + Math.max(ms, this.minTimerMs), order: this.order++, fn })
    return id
  }

  /**
   * A task due at an absolute time, which may already be past: it then runs as soon as the thread is free, in
   * front of everything that became due later. This is how an IPC message from main, or the CPU another process
   * takes, behaves: it does not wait behind the renderer's own queue because the renderer is busy.
   */
  setTimeoutAt = (fn: () => void, due: number): number => {
    const id = this.nextId++
    this.timers.push({ id, due, order: this.order++, fn })
    return id
  }

  clearTimeout = (id: unknown): void => {
    const i = this.timers.findIndex((t) => t.id === id)
    if (i >= 0) this.timers.splice(i, 1)
  }

  /** The next 16 ms frame boundary after now (60 Hz). */
  requestAnimationFrame = (fn: () => void): number => {
    const id = this.nextId++
    this.timers.push({ id, due: (Math.floor(this.now / 16) + 1) * 16, order: this.order++, fn })
    return id
  }

  cancelAnimationFrame = (id: unknown): void => this.clearTimeout(id)

  /** The running task takes `ms` of the thread. */
  busy(ms: number): void {
    this.now += ms
  }

  /** Run every timer due by `end`. A task that ran long makes later timers late, never skips them. */
  runUntil(end: number): void {
    for (;;) {
      let best = -1
      for (let i = 0; i < this.timers.length; i++) {
        const t = this.timers[i]
        if (best < 0 || t.due < this.timers[best].due || (t.due === this.timers[best].due && t.order < this.timers[best].order)) best = i
      }
      if (best < 0 || this.timers[best].due > end) break
      const t = this.timers.splice(best, 1)[0]
      if (t.due > this.now) this.now = t.due
      t.fn()
    }
    if (this.now < end) this.now = end
  }

  /** The scheduler's clock on this loop. */
  clock(): SchedulerClock {
    return {
      now: () => this.now,
      requestFrame: (cb) => this.requestAnimationFrame(cb),
      cancelFrame: (h) => this.cancelAnimationFrame(h),
      setTimer: (cb, ms) => this.setTimeout(cb, ms),
      clearTimer: (h) => this.clearTimeout(h),
    }
  }
}

/**
 * xterm's write buffer, in virtual time (WriteBuffer.ts of @xterm/xterm 5.5.0, step for step): a FIFO of
 * chunks; the first write to an empty queue schedules a slice with setTimeout(0); a slice parses chunks until
 * 12 ms have passed (checked between chunks only), calling each chunk's callback BEFORE it moves past it; a
 * write right after user input to an idle queue is parsed at once. Parsing costs `chars / charsPerMs` of the
 * thread, so terminals that are all busy take turns.
 */
export class ModelXterm {
  pending = 0
  parsedChars = 0
  private chunks: Array<{ len: number; cb?: () => void }> = []
  private offset = 0
  private didUserInput = false

  constructor(private readonly loop: VirtualLoop, private readonly charsPerMs: number, private readonly sliceMs = 12) {}

  /** xterm's handleUserInput(): the next write to an idle queue is parsed synchronously. */
  handleUserInput(): void {
    this.didUserInput = true
  }

  write(data: string, cb?: () => void): void {
    if (this.pending > 50_000_000) throw new Error('write data discarded, use flow control to avoid losing data')
    if (this.chunks.length === 0) {
      this.offset = 0
      if (this.didUserInput) {
        this.didUserInput = false
        this.pending += data.length
        this.chunks.push({ len: data.length, cb })
        this.inner()
        return
      }
      this.loop.setTimeout(() => this.inner(), 0)
    }
    this.pending += data.length
    this.chunks.push({ len: data.length, cb })
  }

  private inner(): void {
    const start = this.loop.now
    while (this.chunks.length > this.offset) {
      const c = this.chunks[this.offset]
      this.loop.busy(c.len / this.charsPerMs)
      this.parsedChars += c.len
      c.cb?.()
      this.offset++
      this.pending -= c.len
      if (this.loop.now - start >= this.sliceMs) break
    }
    if (this.chunks.length > this.offset) {
      this.loop.setTimeout(() => this.inner(), 0)
    } else {
      this.chunks.length = 0
      this.offset = 0
      this.pending = 0
    }
  }
}
