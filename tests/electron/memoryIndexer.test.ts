import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  startIndexer,
  stopIndexer,
  tick,
  isIndexing,
  nudgeIndexer,
  _resetIndexerForTests,
  DEFAULT_MAX_DRAIN_PASSES,
} from '../../src/main/memoryIndexer'
import { resetPasses, snapshotPasses } from '../../src/main/passCounters'

beforeEach(() => {
  _resetIndexerForTests()
  vi.useFakeTimers()
})
afterEach(() => {
  _resetIndexerForTests()
  vi.useRealTimers()
})

describe('memoryIndexer', () => {
  it('runs once after the initial delay, then on the interval', async () => {
    const run = vi.fn().mockResolvedValue({ written: 3 })
    startIndexer({ run, initialDelayMs: 100, intervalMs: 1000 })
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('tick reports "not started" before startIndexer', async () => {
    const r = await tick()
    expect(r.error).toBe('not started')
    expect(r.written).toBe(0)
  })

  it('prevents overlapping runs', async () => {
    let release!: (v: { written: number }) => void
    const run = vi.fn().mockImplementation(() => new Promise<{ written: number }>((res) => { release = res }))
    startIndexer({ run, initialDelayMs: 1e9, intervalMs: 1e9 }) // don't auto-fire
    const p1 = tick() // starts; stays running until released
    expect(isIndexing()).toBe(true)
    const r2 = await tick() // overlapping → refused
    expect(r2.error).toBe('busy')
    release({ written: 1 })
    await p1
    expect(isIndexing()).toBe(false)
  })

  it('captures run errors without throwing', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'))
    startIndexer({ run, initialDelayMs: 1e9, intervalMs: 1e9 })
    const r = await tick()
    expect(r.error).toBe('boom')
    expect(r.written).toBe(0)
    expect(isIndexing()).toBe(false)
  })

  it('logs the chunk count on success', async () => {
    const log = vi.fn()
    startIndexer({ run: async () => ({ written: 5 }), initialDelayMs: 0, intervalMs: 1e9, log })
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('+5'))
  })

  it('stopIndexer cancels scheduled runs', async () => {
    const run = vi.fn().mockResolvedValue({ written: 0 })
    startIndexer({ run, initialDelayMs: 100, intervalMs: 1000 })
    stopIndexer()
    await vi.advanceTimersByTimeAsync(5000)
    expect(run).not.toHaveBeenCalled()
  })

  it('tick surfaces the more flag and hints at the backlog in the log', async () => {
    const log = vi.fn()
    // Huge interval/delay so nothing auto-fires — we drive tick() manually.
    startIndexer({ run: async () => ({ written: 4, more: true }), initialDelayMs: 1e9, intervalMs: 1e9, log })
    const r = await tick()
    expect(r.written).toBe(4)
    expect(r.more).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('(more queued)'))
  })

  it('fast-drains a capped backlog with quick follow-ups, then settles', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ written: 5, more: true }) // first pass hit its cap
      .mockResolvedValueOnce({ written: 5, more: true }) // still draining
      .mockResolvedValueOnce({ written: 2 }) // caught up — no more
    startIndexer({ run, initialDelayMs: 0, intervalMs: 1e9, drainDelayMs: 1000 })

    await vi.advanceTimersByTimeAsync(0) // initial pass
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000) // drain #1 (more was true)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000) // drain #2 (more still true) → returns caught-up
    expect(run).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(10_000) // caught up → no further drains
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('stopIndexer cancels a pending drain follow-up', async () => {
    const run = vi.fn().mockResolvedValue({ written: 5, more: true })
    startIndexer({ run, initialDelayMs: 0, intervalMs: 1e9, drainDelayMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1) // a drain is now scheduled in 1000ms
    stopIndexer()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(1) // drain was cancelled
  })

  describe('fast tier (#2 live-session lag)', () => {
    it('runs fastRun on the fast interval, independently of the full run', async () => {
      const run = vi.fn().mockResolvedValue({ written: 0 })
      const fastRun = vi.fn().mockResolvedValue({ written: 2 })
      startIndexer({ run, fastRun, initialDelayMs: 1e9, intervalMs: 1e9, fastIntervalMs: 90 })
      expect(fastRun).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(90)
      expect(fastRun).toHaveBeenCalledTimes(1)
      expect(run).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(90)
      expect(fastRun).toHaveBeenCalledTimes(2)
    })

    it('tick(true) uses fastRun; tick() uses the full run', async () => {
      const run = vi.fn().mockResolvedValue({ written: 1 })
      const fastRun = vi.fn().mockResolvedValue({ written: 9 })
      startIndexer({ run, fastRun, initialDelayMs: 1e9, intervalMs: 1e9 })
      expect((await tick(true)).written).toBe(9)
      expect((await tick()).written).toBe(1)
      expect(fastRun).toHaveBeenCalledTimes(1)
      expect(run).toHaveBeenCalledTimes(1)
    })

    it('schedules no fast tier when fastRun is omitted, and a fast tick reports no runner', async () => {
      const run = vi.fn().mockResolvedValue({ written: 0 })
      startIndexer({ run, initialDelayMs: 1e9, intervalMs: 1e9 }) // no fastRun
      await vi.advanceTimersByTimeAsync(1_000_000)
      expect(run).not.toHaveBeenCalled()
      expect((await tick(true)).error).toBe('no runner')
    })

    it('stopIndexer cancels the fast interval', async () => {
      const fastRun = vi.fn().mockResolvedValue({ written: 0 })
      startIndexer({ run: vi.fn().mockResolvedValue({ written: 0 }), fastRun, initialDelayMs: 1e9, intervalMs: 1e9, fastIntervalMs: 50 })
      await vi.advanceTimersByTimeAsync(50)
      expect(fastRun).toHaveBeenCalledTimes(1)
      stopIndexer()
      await vi.advanceTimersByTimeAsync(500)
      expect(fastRun).toHaveBeenCalledTimes(1)
    })
  })
})

// ---------------------------------------------------------------------------------------------------------
// P4: the drain is the incremental tier, a pass is counted and logged, the pause switch and the typing gate
// ---------------------------------------------------------------------------------------------------------
describe('drain follow-ups (P4)', () => {
  beforeEach(() => { resetPasses() })

  it('a pass that reports more schedules the incremental drain tier, never the full corpus run again', async () => {
    const run = vi.fn().mockResolvedValueOnce({ written: 5, more: true })
    const drainRun = vi.fn().mockResolvedValueOnce({ written: 5, more: true }).mockResolvedValueOnce({ written: 1 })
    startIndexer({ run, drainRun, initialDelayMs: 0, intervalMs: 1e9, drainDelayMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(drainRun).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(drainRun).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(drainRun).toHaveBeenCalledTimes(2) // caught up: no more follow-ups
    expect(run).toHaveBeenCalledTimes(1) // the corpus walk and the planners ran once, not once per follow-up
  })

  // MEM-F1 backstop: a drain that keeps asking for more stops after maxDrainPasses; the next full pass takes over.
  it('a drain that never catches up stops after maxDrainPasses in a row, and says so in the log', async () => {
    const run = vi.fn().mockResolvedValue({ written: 1, more: true })
    const drainRun = vi.fn().mockResolvedValue({ written: 1, more: true, note: 'files 1' })
    const log: string[] = []
    startIndexer({ run, drainRun, initialDelayMs: 0, intervalMs: 1e9, drainDelayMs: 1000, maxDrainPasses: 3, log: (m) => log.push(m) })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(drainRun).toHaveBeenCalledTimes(3)
    expect(log[log.length - 1]).toMatch(/drain capped at 3 passes/)
  })

  it('the cap defaults to DEFAULT_MAX_DRAIN_PASSES, and Infinity (the kill switch) lifts it', async () => {
    expect(DEFAULT_MAX_DRAIN_PASSES).toBe(400)
    const run = vi.fn().mockResolvedValueOnce({ written: 1, more: true }).mockResolvedValue({ written: 0 })
    let n = 0
    const drainRun = vi.fn(async () => ({ written: 1, more: ++n < 450 }))
    startIndexer({ run, drainRun, initialDelayMs: 0, intervalMs: 1e9, drainDelayMs: 1, maxDrainPasses: Number.POSITIVE_INFINITY })
    await vi.advanceTimersByTimeAsync(2000)
    expect(drainRun).toHaveBeenCalledTimes(450)
    _resetIndexerForTests()
    n = 0
    const drain2 = vi.fn(async () => ({ written: 1, more: true }))
    startIndexer({ run: vi.fn().mockResolvedValueOnce({ written: 1, more: true }), drainRun: drain2, initialDelayMs: 0, intervalMs: 1e9, drainDelayMs: 1 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(drain2).toHaveBeenCalledTimes(DEFAULT_MAX_DRAIN_PASSES)
  })

  // NEGATIVE CONTROL: without a drain tier the follow-ups are the full run again, exactly as before.
  it('control: with no drain tier given, follow-ups still go through the full run', async () => {
    const run = vi.fn().mockResolvedValueOnce({ written: 5, more: true }).mockResolvedValueOnce({ written: 5, more: true }).mockResolvedValue({ written: 0 })
    startIndexer({ run, initialDelayMs: 0, intervalMs: 1e9, drainDelayMs: 1000 })
    await vi.advanceTimersByTimeAsync(2500)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('a FAST pass that reports more drains through the drain tier too, and the drain count restarts after a caught-up pass', async () => {
    const run = vi.fn().mockResolvedValue({ written: 0 })
    const fastRun = vi.fn().mockResolvedValueOnce({ written: 5, more: true }).mockResolvedValueOnce({ written: 5, more: true }).mockResolvedValue({ written: 0 })
    const drainRun = vi.fn().mockResolvedValueOnce({ written: 5, more: true }).mockResolvedValueOnce({ written: 1 }).mockResolvedValue({ written: 0 })
    startIndexer({ run, fastRun, drainRun, initialDelayMs: 1e9, intervalMs: 1e9, fastIntervalMs: 100_000, drainDelayMs: 1000 })
    await vi.advanceTimersByTimeAsync(100_000) // fast pass #1: more
    await vi.advanceTimersByTimeAsync(2000) // two drain passes
    expect(drainRun.mock.calls.map((c) => c[0])).toEqual([{ drainPass: 1 }, { drainPass: 2 }])
    await vi.advanceTimersByTimeAsync(100_000) // fast pass #2: more again, a NEW drain
    await vi.advanceTimersByTimeAsync(1000)
    expect(drainRun.mock.calls[2][0]).toEqual({ drainPass: 1 })
    expect(run).not.toHaveBeenCalled()
  })

  it('logs drainPasses for each drain pass, and leaves idle passes out of the log', async () => {
    const log = vi.fn()
    const run = vi.fn().mockResolvedValueOnce({ written: 5, more: true })
    const drainRun = vi.fn().mockResolvedValueOnce({ written: 5, more: true, note: 'files 9 skipped 40' }).mockResolvedValueOnce({ written: 1 })
    startIndexer({ run, drainRun, log, initialDelayMs: 0, intervalMs: 1e9, drainDelayMs: 100 })
    await vi.advanceTimersByTimeAsync(300)
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => /drainPasses=1/.test(l) && /files 9 skipped 40/.test(l) && /more queued/.test(l))).toBe(true)
    expect(lines.some((l) => /drainPasses=2/.test(l))).toBe(true) // the pass that caught up still says which drain pass it was
    const idle = vi.fn()
    _resetIndexerForTests()
    startIndexer({ run: async () => ({ written: 0 }), log: idle, initialDelayMs: 0, intervalMs: 1e9 })
    await vi.advanceTimersByTimeAsync(10)
    expect(idle).not.toHaveBeenCalled() // a pass that did nothing says nothing: one line every 90 s forever would only be noise
  })

  it('every pass is counted: tier, written, more, drainPasses', async () => {
    const run = vi.fn().mockResolvedValueOnce({ written: 5, more: true })
    const fastRun = vi.fn().mockResolvedValue({ written: 0 })
    const drainRun = vi.fn().mockResolvedValue({ written: 2 })
    startIndexer({ run, fastRun, drainRun, initialDelayMs: 0, intervalMs: 1e9, fastIntervalMs: 5_000, drainDelayMs: 1000 })
    await vi.advanceTimersByTimeAsync(5_000)
    const snap = snapshotPasses()
    expect(snap.kinds.indexer.n).toBe(3)
    const recent = snap.recent.filter((r) => r.kind === 'indexer').map((r) => r.f)
    expect(recent[0]).toMatchObject({ tier: 0, written: 5, more: 1, drainPasses: 0 })
    expect(recent[1]).toMatchObject({ tier: 2, written: 2, more: 0, drainPasses: 1 })
    expect(recent[2]).toMatchObject({ tier: 1, written: 0, more: 0 })
  })

  it('a failing drain pass is an error line, not a loop: it does not re-arm itself', async () => {
    const log = vi.fn()
    const run = vi.fn().mockResolvedValueOnce({ written: 5, more: true })
    const drainRun = vi.fn().mockRejectedValue(new Error('store down'))
    startIndexer({ run, drainRun, log, initialDelayMs: 0, intervalMs: 1e9, drainDelayMs: 100 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(drainRun).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('store down'))
  })
})

describe('the pause switch at the scheduler (P4)', () => {
  beforeEach(() => { resetPasses() })

  it('while paused no timer starts any pass and no drain is armed; when it is lifted the next interval runs', async () => {
    const flag = { paused: true }
    const run = vi.fn().mockResolvedValue({ written: 1, more: true })
    const fastRun = vi.fn().mockResolvedValue({ written: 1, more: true })
    const drainRun = vi.fn().mockResolvedValue({ written: 1 })
    startIndexer({ run, fastRun, drainRun, paused: () => flag.paused, initialDelayMs: 100, intervalMs: 1_000, fastIntervalMs: 500, drainDelayMs: 50 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).not.toHaveBeenCalled()
    expect(fastRun).not.toHaveBeenCalled()
    expect(drainRun).not.toHaveBeenCalled()
    flag.paused = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fastRun).toHaveBeenCalled()
    expect(run).toHaveBeenCalled()
  })

  // NEGATIVE CONTROL
  it('control: with the switch on (or no switch given) the same timers run the passes', async () => {
    for (const paused of [undefined, () => false]) {
      _resetIndexerForTests()
      const run = vi.fn().mockResolvedValue({ written: 0 })
      startIndexer({ run, paused, initialDelayMs: 100, intervalMs: 1e9 })
      await vi.advanceTimersByTimeAsync(100)
      expect(run).toHaveBeenCalledTimes(1)
    }
  })

  it('a manual tick says it was paused and runs nothing', async () => {
    const run = vi.fn().mockResolvedValue({ written: 1 })
    startIndexer({ run, paused: () => true, initialDelayMs: 1e9, intervalMs: 1e9 })
    expect(await tick()).toMatchObject({ written: 0, skipped: 'paused' })
    expect(run).not.toHaveBeenCalled()
    expect(isIndexing()).toBe(false)
  })

  it('a pass in flight that reports more does not arm a drain once the switch has gone off', async () => {
    const flag = { paused: false }
    const drainRun = vi.fn().mockResolvedValue({ written: 0 })
    const run = vi.fn(async () => { flag.paused = true; return { written: 3, more: true } })
    startIndexer({ run, drainRun, paused: () => flag.paused, initialDelayMs: 0, intervalMs: 1e9, drainDelayMs: 100 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(drainRun).not.toHaveBeenCalled()
  })

  it('a pass in flight that reports more arms no drain timer at all once the switch has gone off (the timer count, not just the missing run)', async () => {
    const flag = { paused: false }
    const run = vi.fn(async () => { flag.paused = true; return { written: 3, more: true } })
    startIndexer({ run, paused: () => flag.paused, initialDelayMs: 0, intervalMs: 1e9, drainDelayMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1) // only the 30-minute interval is left
  })

  // NEGATIVE CONTROL: with the switch on, the same "more" arms the drain timer.
  it('control: with the switch on the same pass arms one drain timer', async () => {
    const run = vi.fn(async () => ({ written: 3, more: true }))
    startIndexer({ run, initialDelayMs: 0, intervalMs: 1e9, drainDelayMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(2) // the interval and the armed drain
  })

  it('a drain already waiting on its timer when the switch goes off does nothing when it fires', async () => {
    const flag = { paused: false }
    const run = vi.fn().mockResolvedValue({ written: 3, more: true })
    const drainRun = vi.fn().mockResolvedValue({ written: 0 })
    startIndexer({ run, drainRun, paused: () => flag.paused, initialDelayMs: 0, intervalMs: 1e9, drainDelayMs: 1_000 })
    await vi.advanceTimersByTimeAsync(10)
    flag.paused = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(drainRun).not.toHaveBeenCalled()
  })

  it('a switch that cannot be read counts as "not paused" (fail open: indexing is what it always was)', async () => {
    const run = vi.fn().mockResolvedValue({ written: 0 })
    startIndexer({ run, paused: () => { throw new Error('settings unreadable') }, initialDelayMs: 10, intervalMs: 1e9 })
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('nudgeIndexer starts a pass soon after the switch goes back on; repeated nudges are one pass; none when paused or not started', async () => {
    nudgeIndexer(100) // not started: nothing happens
    const flag = { paused: false }
    const run = vi.fn().mockResolvedValue({ written: 0 })
    startIndexer({ run, paused: () => flag.paused, initialDelayMs: 1e9, intervalMs: 1e9 })
    nudgeIndexer(5_000)
    nudgeIndexer(5_000)
    nudgeIndexer(5_000)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    flag.paused = true
    nudgeIndexer(10)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('the typing gate at the scheduler (P4)', () => {
  beforeEach(() => { resetPasses() })

  it('a pass that was waiting for the gate when the switch went off is skipped, and says so', async () => {
    const flag = { paused: false }
    const run = vi.fn().mockResolvedValue({ written: 0 })
    startIndexer({ run, paused: () => flag.paused, quiet: async () => { flag.paused = true }, initialDelayMs: 1e9, intervalMs: 1e9 })
    expect(await tick()).toMatchObject({ written: 0, skipped: 'paused' })
    expect(run).not.toHaveBeenCalled()
    expect(isIndexing()).toBe(false)
  })

  it('stopIndexer cancels a pending nudge', async () => {
    const run = vi.fn().mockResolvedValue({ written: 0 })
    startIndexer({ run, initialDelayMs: 1e9, intervalMs: 1e9 })
    nudgeIndexer(1_000)
    stopIndexer()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).not.toHaveBeenCalled()
  })

  it('a pass that rejects with something that is not an Error is reported by its text', async () => {
    const log = vi.fn()
    startIndexer({ run: () => Promise.reject('plain text'), log, initialDelayMs: 1e9, intervalMs: 1e9 })
    expect((await tick()).error).toBe('plain text')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('plain text'))
  })

  it('with no delays given the first pass is 10 s after start, then one every 30 minutes, and a follow-up comes 3 s after a pass that reports more', async () => {
    const run = vi.fn().mockResolvedValue({ written: 0 })
    startIndexer({ run })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(run).toHaveBeenCalledTimes(2)
    _resetIndexerForTests()
    const more = vi.fn().mockResolvedValueOnce({ written: 1, more: true }).mockResolvedValue({ written: 0 })
    startIndexer({ run: more, initialDelayMs: 0, intervalMs: 1e9 })
    await vi.advanceTimersByTimeAsync(2_999)
    expect(more).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(more).toHaveBeenCalledTimes(2)
  })

  it('a pass does not start while the gate is held, and does start when it is released; a second tick meanwhile is busy', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = vi.fn().mockResolvedValue({ written: 0 })
    startIndexer({ run, quiet: () => gate, initialDelayMs: 1e9, intervalMs: 1e9 })
    const first = tick()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).not.toHaveBeenCalled()
    expect(isIndexing()).toBe(true)
    expect((await tick()).error).toBe('busy')
    release()
    await first
    expect(run).toHaveBeenCalledTimes(1)
    expect(isIndexing()).toBe(false)
  })

  it('a pass whose indexer was stopped while it waited never starts', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = vi.fn().mockResolvedValue({ written: 0 })
    startIndexer({ run, quiet: () => gate, initialDelayMs: 1e9, intervalMs: 1e9 })
    const first = tick()
    _resetIndexerForTests()
    release()
    await first
    expect(run).not.toHaveBeenCalled()
  })

  it('a gate that throws or rejects does not stop the pass (fail open)', async () => {
    const run = vi.fn().mockResolvedValue({ written: 0 })
    startIndexer({ run, quiet: () => Promise.reject(new Error('clock gone')), initialDelayMs: 1e9, intervalMs: 1e9 })
    await tick()
    expect(run).toHaveBeenCalledTimes(1)
  })
})
