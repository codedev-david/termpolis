import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  startIndexer,
  stopIndexer,
  tick,
  isIndexing,
  _resetIndexerForTests,
} from '../../src/main/memoryIndexer'

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
})
