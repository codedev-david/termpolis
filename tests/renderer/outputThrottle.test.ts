import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOutputThrottle, MAX_WRITE_RETRIES } from '../../src/renderer/src/lib/outputThrottle'
import { createChunkQueue, createStringQueue } from '../../src/renderer/src/lib/chunkQueue'

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

// The echo trace (src/renderer/src/lib/echoTrace.ts) reads how many chars sit in the throttle, ahead of
// the next write, through pending(). It must say exactly what is buffered and must never change what
// the throttle does.
describe('createOutputThrottle: pending()', () => {
  let frames: Array<() => void> = []
  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('is 0 when idle, equals the buffered chars during a burst, and is 0 again once flushed', () => {
    const out: string[] = []
    const t = createOutputThrottle((d) => out.push(d))
    expect(t.pending()).toBe(0)
    t.pending() // reading it twice changes nothing
    t('x'.repeat(10_000)) // bigger than the small-write bypass: it queues
    expect(t.pending()).toBe(10_000)
    t('abc') // a write behind a burst in flight queues too
    expect(t.pending()).toBe(10_003)
    expect(out).toEqual([]) // nothing was written yet: pending() did not flush it
    frames.shift()!() // the frame arrives
    expect(t.pending()).toBe(0)
    expect(out.join('')).toBe('x'.repeat(10_000) + 'abc')
  })

  it('NEGATIVE CONTROL: a small idle write takes the instant path, so nothing is ever pending', () => {
    const out: string[] = []
    const t = createOutputThrottle((d) => out.push(d))
    t('a')
    expect(out).toEqual(['a'])
    expect(t.pending()).toBe(0)
  })

  it('counts a backlog past the 64 KB frame cap as still pending', () => {
    const t = createOutputThrottle(() => undefined)
    t('y'.repeat(70_000))
    expect(t.pending()).toBe(70_000)
    frames.shift()!() // one frame writes 64 KB and re-arms for the rest
    expect(t.pending()).toBe(70_000 - 65_536)
  })
})

// =============================================================================================
// 1.54.5, plan package P2: the throttle's backlog is a chunk list, and its flush cannot lose a chunk
// =============================================================================================
//
// Every test below that proves a NEW property is paired, in this file, with a negative control: the
// same measurement on the 1.54.4 algorithm (kept below as `createLegacyThrottle`, an oracle), so a
// bound that the old code also met would show itself as a test that proves nothing.

/** The 1.54.4 throttle, behaviour for behaviour (b1's version, with pending()). The oracle. */
function createLegacyThrottle(writeFn: (data: string) => void): ((data: string) => void) & { pending: () => number } {
  let buffer = ''
  let scheduled = false
  let rafId: number | null = null
  let timerId: ReturnType<typeof setTimeout> | undefined
  function schedule() {
    scheduled = true
    rafId = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(onTick) : null
    timerId = setTimeout(onTick, 100)
  }
  function disarm() {
    if (rafId !== null) cancelAnimationFrame(rafId)
    clearTimeout(timerId)
    rafId = null
    timerId = undefined
    scheduled = false
  }
  function onTick() {
    disarm()
    flush()
  }
  function flush() {
    if (buffer.length <= 65536) {
      const out = buffer
      buffer = ''
      writeFn(out)
    } else {
      writeFn(buffer.slice(0, 65536))
      buffer = buffer.slice(65536)
      schedule()
    }
  }
  const write = (data: string): void => {
    if (!scheduled && buffer.length === 0 && data.length <= 8192) {
      writeFn(data)
      return
    }
    buffer += data
    if (!scheduled) schedule()
  }
  return Object.assign(write, { pending: (): number => buffer.length })
}

/** requestAnimationFrame / cancelAnimationFrame as a hand-driven queue (cancel really cancels). */
function frameEnv() {
  let next = 1
  const live = new Map<number, () => void>()
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    const id = next++
    live.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { live.delete(id) })
  return {
    count: (): number => live.size,
    /** Run the oldest pending frame. */
    frame: (): void => {
      const [id, cb] = live.entries().next().value as [number, () => void]
      live.delete(id)
      cb()
    },
  }
}

/** mulberry32 */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Step = { op: 'write'; data: string } | { op: 'frame' } | { op: 'timer' }

/** A reproducible burst: writes of every size class (typed echo, the 8 KB bypass edge, bursts, floods), frames and watchdog ticks. */
function makeSteps(seed: number): Step[] {
  const rand = prng(seed)
  const steps: Step[] = []
  for (let i = 0; i < 160; i++) {
    const r = rand()
    if (r < 0.55) {
      const roll = rand()
      const len = roll < 0.3 ? 1 + Math.floor(rand() * 20)
        : roll < 0.5 ? (rand() < 0.5 ? 8192 : 8193)
          : roll < 0.8 ? 1 + Math.floor(rand() * 30_000)
            : 60_000 + Math.floor(rand() * 120_000)
      steps.push({ op: 'write', data: `[${i}:` + String.fromCharCode(97 + (i % 26)).repeat(len) + ']' })
    } else if (r < 0.9) steps.push({ op: 'frame' })
    else steps.push({ op: 'timer' })
  }
  return steps
}

/** Run a throttle through `steps`, then tick until it is idle; return every payload it handed to the writer. */
function runSteps(make: (w: (d: string) => void) => (d: string) => void, steps: Step[]): string[] {
  vi.useFakeTimers()
  const env = frameEnv()
  try {
    const out: string[] = []
    const t = make((d) => { out.push(d) })
    for (const step of steps) {
      if (step.op === 'write') t(step.data)
      else if (step.op === 'frame') { if (env.count() > 0) env.frame() }
      else vi.advanceTimersByTime(100)
    }
    for (let i = 0; i < 100_000 && (env.count() > 0 || vi.getTimerCount() > 0); i++) {
      if (env.count() > 0) env.frame()
      else vi.advanceTimersByTime(100)
    }
    return out
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
}

describe('createOutputThrottle: the chunk list hands the writer exactly what the 1.54.4 string buffer did', () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
    it(`seed ${seed}: the same payloads, in the same order, split at the same places`, () => {
      const steps = makeSteps(seed)
      const oracle = runSteps(createLegacyThrottle, steps)
      const chunked = runSteps((w) => createOutputThrottle(w), steps)
      const stringQueue = runSteps((w) => createOutputThrottle(w, { queue: createStringQueue() }), steps)
      expect(oracle.length).toBeGreaterThan(5) // a real burst, not an empty comparison
      expect(chunked).toEqual(oracle)
      expect(stringQueue).toEqual(oracle) // the kill-switch representation is the old behaviour too
      // and nothing was lost: what went in is what came out
      const sent = steps.filter((s): s is { op: 'write'; data: string } => s.op === 'write').map((s) => s.data).join('')
      expect(chunked.join('')).toBe(sent)
    })
  }

  it('keeps every payload at or under 64 KB however the backlog was split on the way in', () => {
    const payloads = runSteps((w) => createOutputThrottle(w), makeSteps(77))
    expect(Math.max(...payloads.map((p) => p.length))).toBeLessThanOrEqual(65_536)
  })
})

describe('createOutputThrottle: the work of one flush does not grow with the backlog', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  /** A backlog of `total` chars of 9,000-char chunks (shared string, so 50 M chars cost pointers), then `ticks` flushes. */
  function flushWork(total: number, queue: ReturnType<typeof createChunkQueue>, ticks: number) {
    const env = frameEnv()
    const t = createOutputThrottle(() => undefined, { queue })
    const chunk = 'x'.repeat(9000)
    for (let pushed = 0; pushed < total; pushed += chunk.length) t(chunk)
    let worstReads = 0
    let worstWork = 0
    for (let i = 0; i < ticks; i++) {
      t(chunk) // a flood never stops: one more chunk lands between two flushes
      const r0 = queue.reads
      const w0 = queue.work
      env.frame()
      worstReads = Math.max(worstReads, queue.reads - r0)
      worstWork = Math.max(worstWork, queue.work - w0)
    }
    return { worstReads, worstWork, pending: t.pending() }
  }

  for (const total of [1_000_000, 4_000_000, 16_000_000, 50_000_000]) {
    it(`reads at most ceil(64 KB / smallest chunk) + 2 chunks per flush at a ${total.toLocaleString('en-US')} char backlog`, () => {
      const q = createChunkQueue()
      const { worstReads, worstWork, pending } = flushWork(total, q, 10)
      expect(worstReads).toBeGreaterThan(0) // the throttle really queues through the queue it was given
      expect(worstReads).toBeLessThanOrEqual(Math.ceil(65_536 / 9000) + 2)
      expect(worstWork).toBeLessThanOrEqual(65_536 + 9000)
      expect(pending).toBeGreaterThan(total - 11 * 65_536 - 9000) // it only flushed what the ticks asked for
    })
  }

  it('NEGATIVE CONTROL: with the 1.54.4 string representation the same flush reads the whole backlog', () => {
    const q = createStringQueue()
    const { worstWork } = flushWork(4_000_000, q, 4)
    expect(worstWork).toBeGreaterThan(65_536 + 9000) // the bound above does not hold for it
    expect(worstWork).toBeGreaterThan(3_000_000) // in fact it read about the whole backlog
  })
})

describe('createOutputThrottle: heap allocated by one flush (no injected queue: the default representation)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  /** Worst heap growth across four flushes of a flood: a chunk lands between ticks, as it does while an agent prints. */
  function worstFlushHeap(make: (w: (d: string) => void) => (d: string) => void, backlogChars: number): number {
    const env = frameEnv()
    let before = 0
    const growth: number[] = []
    const t = make(() => { growth.push(process.memoryUsage().heapUsed - before) })
    // Non-Latin1 text, so a char costs two bytes, as in the lens harness (key s9).
    const chunk = '│ analysing workflow sub-agent transcript ✓ '.repeat(205).slice(0, 9000)
    for (let i = 0; i < Math.floor(backlogChars / chunk.length); i++) t(chunk)
    for (let tick = 0; tick < 4; tick++) {
      t(chunk)
      before = process.memoryUsage().heapUsed
      env.frame()
    }
    expect(growth.length).toBe(4)
    return Math.max(...growth)
  }

  it('allocates a small, backlog-independent amount per flush at a 2 M char backlog', () => {
    // Base (1.54.4): every flush flattens the whole 2 M char (4 MB) rope. Chunk list: one 64 KB join.
    expect(worstFlushHeap((w) => createOutputThrottle(w), 2_000_000)).toBeLessThan(1_000_000)
  })

  it('NEGATIVE CONTROL: the 1.54.4 algorithm allocates about the whole backlog per flush, so the probe can see it', () => {
    expect(worstFlushHeap(createLegacyThrottle, 2_000_000)).toBeGreaterThan(3_000_000)
  })
})

describe('createOutputThrottle: a writer that throws cannot lose a chunk', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  /** Tick until the throttle is idle or `until()` holds; frames first, then watchdog and retry timers. */
  function tickUntil(env: ReturnType<typeof frameEnv>, until: () => boolean, limit = 400): void {
    for (let i = 0; i < limit && !until(); i++) {
      if (env.count() > 0) env.frame()
      else vi.advanceTimersByTime(100)
    }
  }

  it('throws three times, then recovers: every char is delivered once, in order (key s4: 40,000 of 40,000 were lost)', () => {
    const env = frameEnv()
    const delivered: string[] = []
    let calls = 0
    const onError = vi.fn()
    const t = createOutputThrottle((d) => {
      calls++
      if (calls <= 3) throw new Error('write data discarded, use flow control to avoid losing data')
      delivered.push(d)
    }, { onError })
    const a = 'A'.repeat(20_000)
    const b = 'B'.repeat(20_000)
    t(a)
    t(b)
    tickUntil(env, () => delivered.join('').length >= 40_000)
    expect(delivered.join('')).toBe(a + b)
    expect(calls).toBe(3 + delivered.length) // three refusals, then the writes that went through
    expect(t.pending()).toBe(0)
    expect(onError).toHaveBeenCalledTimes(1) // the first refusal of the episode is reported, not every retry
    expect(onError.mock.calls[0][1]).toMatchObject({ attempt: 1, dropped: false, chars: 40_000 })
  })

  it('keeps the chunk in front of output that arrived while it was being retried', () => {
    const env = frameEnv()
    const delivered: string[] = []
    let calls = 0
    const t = createOutputThrottle((d) => {
      calls++
      if (calls === 1) throw new Error('busy')
      delivered.push(d)
    }, { onError: () => undefined })
    t('first'.padEnd(20_000, '1'))
    env.frame() // refused
    t('second'.padEnd(20_000, '2')) // lands behind the kept chunk, not in front of it
    tickUntil(env, () => delivered.join('').length >= 40_000)
    expect(delivered.join('')).toBe('first'.padEnd(20_000, '1') + 'second'.padEnd(20_000, '2'))
  })

  it('also keeps a small idle write (the typed-echo path) that the writer refused', () => {
    const env = frameEnv()
    const delivered: string[] = []
    let calls = 0
    const t = createOutputThrottle((d) => {
      calls++
      if (calls === 1) throw new Error('busy')
      delivered.push(d)
    }, { onError: () => undefined })
    expect(() => t('echo')).not.toThrow() // the caller is not handed the writer's failure
    expect(t.pending()).toBe(4)
    tickUntil(env, () => delivered.length > 0)
    expect(delivered).toEqual(['echo'])
  })

  it('retries on the next tick first, then backs off: 100, 100, 200, 400, 800, 1600, then 2 s apart', () => {
    frameEnv() // frames never arrive: a hidden window, only the timers run
    vi.stubGlobal('requestAnimationFrame', () => 1)
    const attempts: number[] = []
    const t = createOutputThrottle(() => {
      attempts.push(Date.now())
      throw new Error('still busy')
    }, { onError: () => undefined })
    const start = Date.now()
    t('z'.repeat(20_000))
    vi.advanceTimersByTime(20_000)
    expect(attempts.map((a) => a - start)).toEqual([100, 200, 400, 800, 1600, 3200, 5200, 7200, 9200, 11_200, 13_200])
    expect(attempts.length).toBe(MAX_WRITE_RETRIES + 1)
  })

  it('gives up on a chunk only after MAX_WRITE_RETRIES refusals, says so, and carries on with what came next', () => {
    const env = frameEnv()
    const delivered: string[] = []
    let calls = 0
    const onError = vi.fn()
    const t = createOutputThrottle((d) => {
      calls++
      if (calls <= MAX_WRITE_RETRIES + 1) throw new Error('dead renderer')
      delivered.push(d)
    }, { onError })
    t('lost'.padEnd(20_000, 'L'))
    tickUntil(env, () => calls >= MAX_WRITE_RETRIES + 1, 2000)
    expect(calls).toBe(MAX_WRITE_RETRIES + 1)
    expect(onError).toHaveBeenCalledTimes(2) // the first refusal, and the drop
    expect(onError.mock.calls[1][1]).toMatchObject({ attempt: MAX_WRITE_RETRIES + 1, dropped: true, chars: 20_000 })
    expect(t.pending()).toBe(0) // the chunk is gone, not retried for ever
    t('kept'.padEnd(20_000, 'K')) // and the throttle still works
    tickUntil(env, () => delivered.length > 0)
    expect(delivered).toEqual(['kept'.padEnd(20_000, 'K')])
  })

  it('a refusal followed by success resets the episode: the next refusal is reported again', () => {
    const env = frameEnv()
    let mode: 'ok' | 'fail' = 'fail'
    const delivered: string[] = []
    const onError = vi.fn()
    const t = createOutputThrottle((d) => {
      if (mode === 'fail') throw new Error('busy')
      delivered.push(d)
    }, { onError })
    t('1'.repeat(20_000))
    env.frame()
    expect(onError).toHaveBeenCalledTimes(1)
    mode = 'ok'
    tickUntil(env, () => delivered.length === 1)
    mode = 'fail'
    t('2'.repeat(20_000))
    tickUntil(env, () => onError.mock.calls.length === 2, 50)
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('NEGATIVE CONTROL: a writer that never throws gets each char exactly once and is never reported', () => {
    const env = frameEnv()
    const delivered: string[] = []
    const onError = vi.fn()
    const t = createOutputThrottle((d) => { delivered.push(d) }, { onError })
    const a = 'A'.repeat(20_000)
    const b = 'B'.repeat(100_000)
    t(a)
    t(b)
    tickUntil(env, () => t.pending() === 0)
    expect(delivered.join('')).toBe(a + b)
    expect(onError).not.toHaveBeenCalled()
  })

  it('NEGATIVE CONTROL: the 1.54.4 throttle loses the chunk (this is the failure the test above rules out)', () => {
    const env = frameEnv()
    const delivered: string[] = []
    let calls = 0
    const t = createLegacyThrottle((d) => {
      calls++
      if (calls === 1) throw new Error('busy')
      delivered.push(d)
    })
    t('A'.repeat(20_000))
    expect(() => env.frame()).toThrow('busy') // the failure surfaces in the timer callback
    tickUntil(env, () => false, 5)
    expect(delivered.join('')).toBe('') // and the 20,000 chars never arrive
  })

  it('reports through reportError (or the console) when no onError is given, and still never throws', () => {
    const env = frameEnv()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const prior = (globalThis as { reportError?: unknown }).reportError
    ;(globalThis as { reportError?: unknown }).reportError = undefined
    try {
      let refuse = true
      const delivered: string[] = []
      const t = createOutputThrottle((d) => {
        if (refuse) throw new Error('busy')
        delivered.push(d)
      })
      t('q'.repeat(20_000))
      expect(() => env.frame()).not.toThrow()
      expect(spy).toHaveBeenCalledTimes(1)
      refuse = false // the retry goes through, which ends the episode
      while (env.count() > 0 || delivered.length === 0) {
        if (env.count() > 0) env.frame()
        else vi.advanceTimersByTime(100)
      }
      const reported = vi.fn()
      ;(globalThis as { reportError?: unknown }).reportError = reported
      refuse = true
      t('r'.repeat(20_000))
      env.frame()
      expect(reported).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledTimes(1) // reportError took over from the console
    } finally {
      ;(globalThis as { reportError?: unknown }).reportError = prior
      spy.mockRestore()
    }
  })
})

describe('createOutputThrottle: whenDrained (the hook a resize waits on)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('runs at once when nothing is queued', () => {
    frameEnv()
    const t = createOutputThrottle(() => undefined)
    const cb = vi.fn()
    const cancel = t.whenDrained(cb, 1000)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(() => cancel()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs at once after a small idle write too: the typed-echo path is never "queued"', () => {
    frameEnv()
    const t = createOutputThrottle(() => undefined)
    t('a')
    const cb = vi.fn()
    t.whenDrained(cb, 1000)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('waits for the output queued before it, once, and not for what arrives after it', () => {
    const env = frameEnv()
    const t = createOutputThrottle(() => undefined)
    t('x'.repeat(150 * 1024)) // 64 KB, 64 KB, 22 KB: three flushes
    const cb = vi.fn()
    t.whenDrained(cb, 60_000)
    t('y'.repeat(300_000)) // arrives later: it must not hold the callback back
    env.frame()
    expect(cb).not.toHaveBeenCalled()
    env.frame()
    expect(cb).not.toHaveBeenCalled()
    env.frame() // the third flush carries the last of the x chars
    expect(cb).toHaveBeenCalledTimes(1)
    expect(t.pending()).toBeGreaterThan(200_000) // most of y is still queued
    while (env.count() > 0) env.frame()
    expect(cb).toHaveBeenCalledTimes(1) // never twice
  })

  it('goes ahead after the bounded wait when the backlog does not drain (a writer that keeps refusing)', () => {
    frameEnv()
    vi.stubGlobal('requestAnimationFrame', () => 1)
    const t = createOutputThrottle(() => { throw new Error('busy') }, { onError: () => undefined })
    t('x'.repeat(100_000))
    const cb = vi.fn()
    t.whenDrained(cb, 1500)
    vi.advanceTimersByTime(1499)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(cb).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30_000)
    expect(cb).toHaveBeenCalledTimes(1) // and exactly once
  })

  it('does not run after the drain when the bound already ran it', () => {
    const env = frameEnv()
    const t = createOutputThrottle(() => undefined)
    t('x'.repeat(100_000))
    const cb = vi.fn()
    t.whenDrained(cb, 0)
    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledTimes(1)
    while (env.count() > 0) env.frame()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('can be cancelled, which also drops its timer', () => {
    const env = frameEnv()
    const t = createOutputThrottle(() => undefined)
    t('x'.repeat(100_000))
    const timersBefore = vi.getTimerCount()
    const cb = vi.fn()
    const cancel = t.whenDrained(cb, 5000)
    expect(vi.getTimerCount()).toBe(timersBefore + 1)
    cancel()
    expect(vi.getTimerCount()).toBe(timersBefore)
    while (env.count() > 0) env.frame()
    vi.advanceTimersByTime(10_000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('serves several waiters, each when its own target is reached', () => {
    const env = frameEnv()
    const t = createOutputThrottle(() => undefined)
    t('a'.repeat(100_000))
    const first = vi.fn()
    t.whenDrained(first, 60_000)
    t('b'.repeat(100_000))
    const second = vi.fn()
    t.whenDrained(second, 60_000)
    env.frame() // 64 KB of the first 100 KB
    expect(first).not.toHaveBeenCalled()
    env.frame() // 36 KB of a + 28 KB of b: the first target is met
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    while (env.count() > 0) env.frame()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('a callback may register another wait without disturbing the others', () => {
    const env = frameEnv()
    const t = createOutputThrottle(() => undefined)
    t('a'.repeat(100_000))
    const order: string[] = []
    t.whenDrained(() => {
      order.push('one')
      t.whenDrained(() => order.push('nested'), 1000)
    }, 60_000)
    t.whenDrained(() => order.push('two'), 60_000)
    while (env.count() > 0) env.frame()
    expect(order).toEqual(['one', 'nested', 'two'])
  })

  it('a wait that was already served can be cancelled later without harm', () => {
    const env = frameEnv()
    const t = createOutputThrottle(() => undefined)
    t('a'.repeat(100_000))
    const cb = vi.fn()
    const cancel = t.whenDrained(cb, 60_000)
    while (env.count() > 0) env.frame()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(() => cancel()).not.toThrow()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('a callback that cancels a later wait stops it from running, and the wait after that still runs', () => {
    const env = frameEnv()
    const t = createOutputThrottle(() => undefined)
    t('a'.repeat(100_000))
    const order: string[] = []
    let cancelSecond: () => void = () => undefined
    t.whenDrained(() => { order.push('first'); cancelSecond() }, 60_000)
    cancelSecond = t.whenDrained(() => order.push('second'), 60_000)
    t.whenDrained(() => order.push('third'), 60_000)
    while (env.count() > 0) env.frame()
    expect(order).toEqual(['first', 'third'])
  })

  it('a callback that throws is reported, and neither the flush nor the other waits are affected', () => {
    const env = frameEnv()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const prior = (globalThis as { reportError?: unknown }).reportError
    ;(globalThis as { reportError?: unknown }).reportError = undefined
    try {
      const written: string[] = []
      const t = createOutputThrottle((d) => { written.push(d) })
      t('a'.repeat(100_000))
      const after = vi.fn()
      t.whenDrained(() => { throw new Error('the callback is broken') }, 60_000)
      t.whenDrained(after, 60_000)
      expect(() => { while (env.count() > 0) env.frame() }).not.toThrow()
      expect(after).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(written.join('')).toBe('a'.repeat(100_000)) // the output itself went through
    } finally {
      ;(globalThis as { reportError?: unknown }).reportError = prior
      spy.mockRestore()
    }
  })

  it('an onError that throws, or a reportError that throws, cannot take the flush down', () => {
    const env = frameEnv()
    const delivered: string[] = []
    let refuse = true
    const writer = (d: string): void => {
      if (refuse) throw new Error('busy')
      delivered.push(d)
    }
    const t = createOutputThrottle(writer, { onError: () => { throw new Error('the reporter is broken') } })
    t('p'.repeat(20_000))
    expect(() => env.frame()).not.toThrow()
    refuse = false
    for (let i = 0; i < 100 && delivered.length === 0; i++) {
      if (env.count() > 0) env.frame()
      else vi.advanceTimersByTime(100)
    }
    expect(delivered).toEqual(['p'.repeat(20_000)])

    const prior = (globalThis as { reportError?: unknown }).reportError
    ;(globalThis as { reportError?: unknown }).reportError = () => { throw new Error('reportError is broken') }
    try {
      refuse = true
      const u = createOutputThrottle(writer) // the default reporter
      u('q'.repeat(20_000))
      expect(() => env.frame()).not.toThrow()
    } finally {
      ;(globalThis as { reportError?: unknown }).reportError = prior
    }
  })

  it('treats a missing or negative bound as "do not wait"', () => {
    const env = frameEnv()
    const t = createOutputThrottle(() => undefined)
    t('a'.repeat(100_000))
    const none = vi.fn()
    const negative = vi.fn()
    t.whenDrained(none, Number.NaN)
    t.whenDrained(negative, -5)
    vi.advanceTimersByTime(1)
    expect(none).toHaveBeenCalledTimes(1)
    expect(negative).toHaveBeenCalledTimes(1)
    while (env.count() > 0) env.frame()
  })

  it('counts chars the writer dropped as handed, so a wait on them is released', () => {
    const env = frameEnv()
    const t = createOutputThrottle(() => { throw new Error('dead') }, { onError: () => undefined })
    t('x'.repeat(20_000))
    const cb = vi.fn()
    t.whenDrained(cb, 10 * 60_000)
    for (let i = 0; i < 2000 && cb.mock.calls.length === 0; i++) {
      if (env.count() > 0) env.frame()
      else vi.advanceTimersByTime(100)
    }
    expect(cb).toHaveBeenCalledTimes(1)
    expect(t.pending()).toBe(0)
  })
})
