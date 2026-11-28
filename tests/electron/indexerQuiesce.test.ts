import { describe, it, expect, vi, afterEach } from 'vitest'
import * as indexer from '../../src/main/memoryIndexer'
import { quiesceIndexer } from './_indexerQuiesce'

// mainThreadHotPaths measures indexer passes it starts itself with tick(), so it must first bring the app's timed passes to
// rest. These pin down what "at rest" takes (Codex, MARKERASYNC R1: a drain armed after the stop ran in the window).

type Run = { written: number; more?: boolean }

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

afterEach(() => {
  indexer._resetIndexerForTests()
  vi.useRealTimers()
})

function underWay() {
  const first = deferred<Run>()
  const drainRun = vi.fn(async (): Promise<Run> => ({ written: 0, more: false }))
  indexer.startIndexer({ run: () => first.promise, drainRun, initialDelayMs: 1, drainDelayMs: 50, intervalMs: 3_600_000 })
  return { first, drainRun }
}

describe('bringing the memory indexer to rest before a measured window', () => {
  it('stopping alone is not enough: a pass under way arms its follow-up as it finishes (Codex R1 probe)', async () => {
    vi.useFakeTimers()
    const { first, drainRun } = underWay()
    await vi.advanceTimersByTimeAsync(1)
    expect(indexer.isIndexing()).toBe(true)
    indexer.stopIndexer()
    first.resolve({ written: 0, more: true })
    for (let i = 0; i < 10 && indexer.isIndexing(); i++) await vi.advanceTimersByTimeAsync(25)
    expect(indexer.isIndexing()).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(drainRun).toHaveBeenCalledTimes(1) // this would have been inside the window
  })

  it('quiesceIndexer waits for the pass under way and cancels the follow-up it armed', async () => {
    vi.useFakeTimers()
    const { first, drainRun } = underWay()
    await vi.advanceTimersByTimeAsync(1)
    expect(indexer.isIndexing()).toBe(true)
    const resting = quiesceIndexer(indexer, (ms) => vi.advanceTimersByTimeAsync(ms))
    first.resolve({ written: 0, more: true })
    await resting
    expect(indexer.isIndexing()).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(drainRun).not.toHaveBeenCalled()
    // tick() still runs the configured pass afterwards, with nothing else running beside it.
    await expect(indexer.tick()).resolves.toMatchObject({ written: 0, more: true })
  })

  it('an indexer already at rest is left at rest, and its timed passes do not come back', async () => {
    vi.useFakeTimers()
    const { drainRun } = underWay()
    const run = vi.fn()
    await quiesceIndexer(indexer, async (ms) => { run(ms) })
    expect(run).not.toHaveBeenCalled() // nothing was under way: no wait
    await vi.advanceTimersByTimeAsync(7_200_000)
    expect(indexer.isIndexing()).toBe(false)
    expect(drainRun).not.toHaveBeenCalled()
  })

  it('says so when a pass never ends, rather than measure beside it', async () => {
    let busy = true
    const sleeps: number[] = []
    await expect(quiesceIndexer({ stopIndexer: () => {}, isIndexing: () => busy }, async (ms) => { sleeps.push(ms) })).rejects.toThrow('still running a pass after 60 s')
    expect(sleeps).toHaveLength(2400)
    busy = false
  })

  it('waits on real timers by default', async () => {
    let polls = 0
    const stops = vi.fn()
    await quiesceIndexer({ stopIndexer: stops, isIndexing: () => ++polls < 3 })
    expect(polls).toBe(4) // three looks in the wait, one more to confirm it ended
    expect(stops).toHaveBeenCalledTimes(2)
  })
})
