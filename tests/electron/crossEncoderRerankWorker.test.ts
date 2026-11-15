// The re-ranker's worker backend as crossEncoderRerank orchestrates it: the load through the worker (the
// contract check doubles as the load), the leashes on the load and on each search, and every way a worker
// turns reranking off for the session. The worker itself (rerankWorker.ts) is integration code; here a fake
// RerankWorkerTransport stands in for it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getRerankBatchScorer,
  getRerankBatchScorerWithin,
  setRerankWorkerSpawner,
  rerankThreadsFor,
  prewarmRerank,
  _setRerankModelPresentForTests,
  _resetRerankForTests,
  type RerankWorkerTransport,
} from '../../src/main/crossEncoderRerank'

type Answer = number[] | null | 'hang' | 'reject'

/** A transport that answers the queued answers in order (the first one is the contract check). Past the
 *  queue it scores every doc 1. */
function fakeTransport(answers: Answer[] = []) {
  const calls: Array<{ query: string; docs: string[] }> = []
  let disposed = 0
  const t: RerankWorkerTransport = {
    score: (query, docs) => {
      calls.push({ query, docs })
      const a = answers.length ? answers.shift()! : docs.map(() => 1)
      if (a === 'hang') return new Promise(() => {})
      if (a === 'reject') return Promise.reject(new Error('worker gone'))
      return Promise.resolve(a)
    },
    dispose: () => { disposed++ },
  }
  return { t, calls, disposed: () => disposed }
}

beforeEach(() => _resetRerankForTests())
afterEach(() => {
  vi.useRealTimers()
  _resetRerankForTests()
})

describe('rerank worker: load', () => {
  it('loads through the worker: one spawn, a contract check, then each search goes to the worker', async () => {
    const f = fakeTransport([[0.5]])
    const spawn = vi.fn(() => f.t)
    setRerankWorkerSpawner(spawn)
    const [a, b] = await Promise.all([getRerankBatchScorer(), getRerankBatchScorer()])
    expect(a).not.toBeNull()
    expect(b).toBe(a) // concurrent callers share one load
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(f.calls[0]).toEqual({ query: 'contract check', docs: ['contract check passage'] })
    expect(await a!('q', ['x', 'y'])).toEqual([1, 1])
    expect(f.calls[1]).toEqual({ query: 'q', docs: ['x', 'y'] })
    expect(await getRerankBatchScorer()).toBe(a)
  })

  it('a spawner that gives nothing, or throws, turns reranking off without trying again', async () => {
    const none = vi.fn(() => null)
    setRerankWorkerSpawner(none)
    expect(await getRerankBatchScorer()).toBeNull()
    expect(await getRerankBatchScorer()).toBeNull()
    expect(none).toHaveBeenCalledTimes(1)

    const boom = vi.fn((): RerankWorkerTransport => { throw new Error('no worker_threads here') })
    setRerankWorkerSpawner(boom)
    expect(await getRerankBatchScorer()).toBeNull()
    expect(await getRerankBatchScorer()).toBeNull()
    expect(boom).toHaveBeenCalledTimes(1)
  })

  it.each<[string, Answer]>([
    ['no model in the worker', null],
    ['a worker that dies during the load', 'reject'],
    ['two scores for one pair', [1, 2]],
    ['a score that is not a number', [Number.NaN]],
  ])('a failed contract check (%s) drops the worker and turns reranking off', async (_label, probe) => {
    const f = fakeTransport([probe])
    setRerankWorkerSpawner(() => f.t)
    expect(await getRerankBatchScorer()).toBeNull()
    expect(f.disposed()).toBe(1)
    expect(await getRerankBatchScorer()).toBeNull()
    expect(f.calls).toHaveLength(1)
  })

  it('a load that never answers gives up after the load leash and drops the worker', async () => {
    vi.useFakeTimers()
    const f = fakeTransport(['hang'])
    setRerankWorkerSpawner(() => f.t)
    const p = getRerankBatchScorer()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(f.disposed()).toBe(0)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await p).toBeNull()
    expect(f.disposed()).toBe(1)
  })

  it('prewarmRerank starts the load once, and the first search finds it done', async () => {
    const f = fakeTransport([[0.1]])
    const spawn = vi.fn(() => f.t)
    setRerankWorkerSpawner(spawn)
    prewarmRerank()
    prewarmRerank()
    const s = await getRerankBatchScorer()
    expect(s).not.toBeNull()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(f.calls).toHaveLength(1) // only the contract check so far
  })

  it('setting a new spawner drops the old worker; null goes back to the in-thread model', async () => {
    const first = fakeTransport([[0.2]])
    setRerankWorkerSpawner(() => first.t)
    expect(await getRerankBatchScorer()).not.toBeNull()
    const second = fakeTransport([[0.3]])
    setRerankWorkerSpawner(() => second.t)
    expect(first.disposed()).toBe(1)
    expect(await getRerankBatchScorer()).not.toBeNull()
    expect(second.calls).toHaveLength(1)
    setRerankWorkerSpawner(null)
    expect(second.disposed()).toBe(1)
    _setRerankModelPresentForTests(false)
    expect(await getRerankBatchScorer()).toBeNull() // in-thread, and the model is absent here
  })
})

describe('rerank worker: each search', () => {
  it('a search that times out throws (that search keeps the first-stage order); three in a row turn reranking off', async () => {
    vi.useFakeTimers()
    const f = fakeTransport([[0.5], 'hang', 'hang', [7], 'hang', 'hang', 'hang'])
    setRerankWorkerSpawner(() => f.t)
    const s = (await getRerankBatchScorer())!
    const timedOut = async (): Promise<void> => {
      const p = s('q', ['d']).then(() => 'ok', (e: Error) => e.message)
      await vi.advanceTimersByTimeAsync(3_100)
      expect(await p).toBe('rerank worker timed out')
    }
    await timedOut()
    await timedOut()
    expect(await s('q', ['d'])).toEqual([7]) // an answer resets the count
    await timedOut()
    await timedOut()
    expect(await getRerankBatchScorer()).toBe(s)
    expect(f.disposed()).toBe(0)
    await timedOut()
    expect(f.disposed()).toBe(1)
    expect(await getRerankBatchScorer()).toBeNull()
  })

  it.each<[string, Answer]>([
    ['answers null', null],
    ['rejects', 'reject'],
  ])('a worker that %s mid-session turns reranking off at once', async (_label, answer) => {
    const f = fakeTransport([[0.5], answer])
    setRerankWorkerSpawner(() => f.t)
    const s = (await getRerankBatchScorer())!
    await expect(s('q', ['d'])).rejects.toThrow('rerank worker could not score')
    expect(f.disposed()).toBe(1)
    expect(await getRerankBatchScorer()).toBeNull()
  })

  it('a stale scorer failing after the worker was replaced leaves the new worker alone', async () => {
    let release: (v: number[] | null) => void = () => {}
    const old: RerankWorkerTransport = {
      score: vi.fn()
        .mockResolvedValueOnce([0.5])
        .mockImplementationOnce(() => new Promise<number[] | null>((r) => { release = r })),
      dispose: vi.fn(),
    }
    setRerankWorkerSpawner(() => old)
    const stale = (await getRerankBatchScorer())!
    const inFlight = stale('q', ['d'])
    const next = fakeTransport([[0.9]])
    setRerankWorkerSpawner(() => next.t)
    const fresh = await getRerankBatchScorer()
    expect(fresh).not.toBeNull()
    release(null)
    await expect(inFlight).rejects.toThrow('rerank worker could not score')
    expect(next.disposed()).toBe(0)
    expect(await getRerankBatchScorer()).toBe(fresh)
  })
})

describe('rerank worker: threads', () => {
  it('rerankThreadsFor takes half the cores, at most 8 and at least 1', () => {
    expect(rerankThreadsFor(64)).toBe(8)
    expect(rerankThreadsFor(22)).toBe(8)
    expect(rerankThreadsFor(16)).toBe(8)
    expect(rerankThreadsFor(12)).toBe(6)
    expect(rerankThreadsFor(8)).toBe(4)
    expect(rerankThreadsFor(6)).toBe(3)
    expect(rerankThreadsFor(4)).toBe(2)
    expect(rerankThreadsFor(2)).toBe(1)
    expect(rerankThreadsFor(1)).toBe(1)
    expect(rerankThreadsFor(0)).toBe(1)
    expect(rerankThreadsFor(Number.NaN)).toBe(1)
  })

})

describe('rerank worker: a search never waits out the load', () => {
  it('a search during a slow load keeps the first stage; the load still lands for the next one', async () => {
    let check: (v: number[]) => void = () => {}
    const t: RerankWorkerTransport = {
      score: (_q, docs) => (docs[0] === 'contract check passage' ? new Promise((r) => { check = r }) : Promise.resolve(docs.map(() => 1))),
      dispose: () => {},
    }
    setRerankWorkerSpawner(() => t)
    expect(await getRerankBatchScorerWithin(10)).toBeNull() // still loading: this search does not wait
    check([0.5])
    const s = await getRerankBatchScorerWithin(10)
    expect(s).not.toBeNull()
    expect(await getRerankBatchScorerWithin(10)).toBe(s) // loaded: answered at once
  })

  it('a quick load is waited for, and a failed one answers null', async () => {
    setRerankWorkerSpawner(() => fakeTransport([[0.5]]).t)
    expect(await getRerankBatchScorerWithin()).not.toBeNull()
    _resetRerankForTests()
    setRerankWorkerSpawner(() => null)
    expect(await getRerankBatchScorerWithin()).toBeNull()
  })
})
