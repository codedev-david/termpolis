// The cross-encoder reranker as recall uses it: blendRerank's contract, the global gate, the injection
// seams, and memorySearch re-reading only the hits that pass the relevance gate (each result keeps a
// first-stage score from that pool, so a weak hit never inherits a strong hit's score). The model load
// path (fake ORT + the real model where fetched) is crossEncoderRerankModel.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  blendRerank,
  setRerankScorer,
  setRerankBatchScorer,
  getRerankBatchScorer,
  setRerankEnabled,
  rerankEnabled,
  _resetRerankForTests,
  _setRerankModelPresentForTests,
  RERANK_POOL,
  type RerankBatchScorer,
} from '../../src/main/crossEncoderRerank'
import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

// All docs cluster near the all-ones direction → every mutual cosine is high and positive, so every doc
// lands in the rerank pool with a distinct first-stage score.
const embed = async (text: string): Promise<number[]> => {
  let s = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) s = (Math.imul(s ^ text.charCodeAt(i), 16777619)) >>> 0
  const v = new Array(384)
  for (let i = 0; i < 384; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; v[i] = 1 + (s / 0xffffffff - 0.5) * 0.05 }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1
  return v.map((x) => x / norm)
}

const cand = (id: string, score: number) => ({ id, content: id, score })
const byContent = (m: Record<string, number>): RerankBatchScorer => async (_q, docs) => docs.map((d) => m[d] ?? 0)

describe('blendRerank', () => {
  it('alpha 1 orders by the cross-encoder alone, alpha 0 keeps the first stage', async () => {
    const cands = [cand('a', 0.9), cand('b', 0.8), cand('c', 0.7)]
    const ce = byContent({ a: -3, b: 5, c: 1 })
    expect((await blendRerank('q', cands, ce, 1)).map((c) => c.id)).toEqual(['b', 'c', 'a'])
    expect((await blendRerank('q', cands, ce, 0)).map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('min-max normalises both signals before mixing, and reports the raw logit and the blend', async () => {
    const out = await blendRerank('q', [cand('a', 0.9), cand('b', 0.5)], byContent({ a: 0, b: 10 }), 0.5)
    // a: 0.5·0 + 0.5·1 = 0.5;  b: 0.5·1 + 0.5·0 = 0.5 → a tie, and ties keep the first-stage order.
    expect(out.map((c) => [c.id, c.rerankScore, c.blended])).toEqual([['a', 0, 0.5], ['b', 10, 0.5]])
    const tilt = await blendRerank('q', [cand('a', 0.9), cand('b', 0.5)], byContent({ a: 0, b: 10 }), 0.6)
    expect(tilt.map((c) => c.id)).toEqual(['b', 'a'])
    expect(tilt[0].score).toBe(0.5) // the candidate's own score is untouched
  })

  it('a signal with no spread contributes 0.5 to everyone, so the other one decides', async () => {
    const flatCe = await blendRerank('q', [cand('a', 0.9), cand('b', 0.5)], byContent({ a: 2, b: 2 }), 0.9)
    expect(flatCe.map((c) => c.id)).toEqual(['a', 'b'])
    const flatFs = await blendRerank('q', [cand('a', 0.7), cand('b', 0.7)], byContent({ a: 0, b: 1 }), 0.1)
    expect(flatFs.map((c) => c.id)).toEqual(['b', 'a'])
  })

  it('0 or 1 candidates never call the scorer', async () => {
    const scorer = vi.fn(async (_q: string, d: string[]) => d.map(() => 1))
    expect(await blendRerank('q', [], scorer, 0.5)).toEqual([])
    expect(await blendRerank('q', [cand('a', 0.4)], scorer, 0.5)).toEqual([{ ...cand('a', 0.4), rerankScore: 0, blended: 0.4 }])
    expect(scorer).not.toHaveBeenCalled()
  })

  it.each([
    ['throws', async () => { throw new Error('boom') }],
    ['answers the wrong length', async () => [1]],
    ['answers a NaN', async () => [1, Number.NaN, 0]],
    ['answers an Infinity', async () => [1, Number.POSITIVE_INFINITY, 0]],
  ] as Array<[string, RerankBatchScorer]>)('a scorer that %s leaves the first-stage order untouched', async (_n, scorer) => {
    const cands = [cand('a', 0.9), cand('b', 0.8), cand('c', 0.7)]
    const out = await blendRerank('q', cands, scorer, 1)
    expect(out.map((c) => [c.id, c.rerankScore, c.blended])).toEqual([['a', 0, 0.9], ['b', 0, 0.8], ['c', 0, 0.7]])
  })

  it('equal blends keep the first-stage order (the sort is stable)', async () => {
    const cands = ['a', 'b', 'c', 'd'].map((id) => cand(id, 0.5))
    expect((await blendRerank('q', cands, byContent({}), 0.5)).map((c) => c.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('reranker seams and gate', () => {
  beforeEach(() => _resetRerankForTests())
  afterEach(() => _resetRerankForTests())

  it('setRerankEnabled flips the gate, and the reset seam puts it back OFF', () => {
    // OFF by default: a cross-encoder adds a forward pass per candidate, so a gate that defaulted ON
    // would silently add model latency to every recall in every suite.
    expect(rerankEnabled()).toBe(false)
    setRerankEnabled(true)
    expect(rerankEnabled()).toBe(true)
    setRerankEnabled(false)
    expect(rerankEnabled()).toBe(false)
    setRerankEnabled(true)
    _resetRerankForTests()
    expect(rerankEnabled()).toBe(false)
  })

  it('a per-pair scorer is batched, and a pair that rejects scores 0 instead of sinking the batch', async () => {
    setRerankScorer(async (_q, doc) => {
      if (doc === 'poison') throw new Error('tokenizer blew up on this pair')
      return doc === 'high' ? 0.9 : 0.4
    })
    const s = await getRerankBatchScorer()
    expect(await s!('q', ['poison', 'low', 'high'])).toEqual([0, 0.4, 0.9])
  })

  it('clearing an injected scorer falls back to the model, which is absent here', async () => {
    setRerankBatchScorer(async (_q, d) => d.map(() => 1))
    expect(await getRerankBatchScorer()).not.toBeNull()
    setRerankScorer(null)
    _setRerankModelPresentForTests(false)
    expect(await getRerankBatchScorer()).toBeNull()
  })
})

describe('memorySearch with the reranker', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rerank-'))
    _resetForTests()
    _resetRerankForTests()
    _setEmbeddingsAvailable(true)
    _setEmbedFnForTests(embed)
    initSwarmMemory(tmp)
  })
  afterEach(() => {
    _resetRerankForTests()
    _setEmbedFnForTests(null)
    _resetForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const seed = async (): Promise<void> => {
    for (const c of ['note about caching layers', 'note about the parser', 'note about the deploy pipeline', 'note about telemetry', 'note about the scheduler']) {
      await memoryWrite({ agentId: 'a', kind: 'fact', content: c })
    }
  }

  it('moves the cross-encoder pick to the top and hands the pool its own scores back in the new order', async () => {
    await seed()
    const off = await memorySearch({ query: 'anything relevant here', limit: 5, rerank: false })
    expect(off).toHaveLength(5)
    // Not the last one: with min-max normalisation a candidate at the very bottom of the first stage
    // only ties the leader at alpha 0.5, so take the fourth.
    const target = off[3]
    setRerankBatchScorer(async (_q, docs) => docs.map((d) => (d === target.content ? 1 : 0)))
    const on = await memorySearch({ query: 'anything relevant here', limit: 5, rerank: true })
    expect(on[0].id).toBe(target.id)
    expect(on.map((r) => r.score)).toEqual(off.map((r) => r.score))
    expect(on.map((r) => r.id).sort()).toEqual(off.map((r) => r.id).sort())
  })

  it('follows the global gate when a search does not say, and a search can opt out', async () => {
    await seed()
    const scorer = vi.fn(async (_q: string, docs: string[]) => docs.map(() => 0))
    setRerankBatchScorer(scorer)
    await memorySearch({ query: 'gate check one', limit: 5 })
    expect(scorer).not.toHaveBeenCalled()
    setRerankEnabled(true)
    await memorySearch({ query: 'gate check two', limit: 5 })
    expect(scorer).toHaveBeenCalledTimes(1)
    await memorySearch({ query: 'gate check three', limit: 5, rerank: false })
    expect(scorer).toHaveBeenCalledTimes(1)
  })

  it('is byte-identical to the first stage when no model or scorer is available', async () => {
    await seed()
    _setRerankModelPresentForTests(false)
    const off = await memorySearch({ query: 'note about the parser', limit: 4 })
    const on = await memorySearch({ query: 'note about the parser', limit: 4, rerank: true })
    expect(on).toEqual(off)
  })
})

describe('memorySearch rerank pool', () => {
  // The query lies along one axis and each memory's cosine to it is set by hand, so the first-stage scores are known.
  const cosines = new Map<string, number>()
  const unit = (cos: number): number[] => {
    const v = new Array(384).fill(0)
    v[0] = cos
    v[1] = Math.sqrt(1 - cos * cos)
    return v
  }
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rerank-pool-'))
    cosines.clear()
    cosines.set('zz query', 1)
    _resetForTests()
    _resetRerankForTests()
    _setEmbeddingsAvailable(true)
    _setEmbedFnForTests(async (t) => unit(cosines.get(t) ?? 0))
    initSwarmMemory(tmp)
  })
  afterEach(() => {
    _resetRerankForTests()
    _setEmbedFnForTests(null)
    _resetForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })
  const seed = async (docs: Record<string, number>): Promise<void> => {
    for (const [content, cos] of Object.entries(docs)) {
      cosines.set(content, cos)
      await memoryWrite({ agentId: 'a', kind: 'fact', content })
    }
  }

  it('re-reads only hits that pass the 0.25 gate, so a weak hit can never borrow the score of a strong one', async () => {
    await seed({ 'alpha strong': 0.9, 'bravo strong': 0.8, 'charlie weak': 0.2, 'delta weak': 0.15 })
    const off = await memorySearch({ query: 'zz query', limit: 5, rerank: false })
    const weak = off.find((r) => r.content === 'charlie weak')!
    expect(weak.score).toBeLessThan(0.25) // the floor of three lets it in, below the gate
    // A cross-encoder that loves the weak hit: before 1.63 it went first and inherited 0.9.
    const scorer = vi.fn(async (_q: string, docs: string[]) => docs.map((d) => (d.includes('weak') ? 10 : d === 'bravo strong' ? 5 : 0)))
    setRerankBatchScorer(scorer)
    const on = await memorySearch({ query: 'zz query', limit: 5, rerank: true })
    expect(scorer).toHaveBeenCalledTimes(1)
    expect(scorer.mock.calls[0][1].sort()).toEqual(['alpha strong', 'bravo strong'])
    expect(on.map((r) => r.content)).toEqual(['bravo strong', 'alpha strong', 'charlie weak'])
    expect(on.map((r) => r.score)).toEqual(off.map((r) => r.score))
    expect(on.find((r) => r.content === 'charlie weak')!.score).toBe(weak.score)
  })

  it('skips the cross-encoder when fewer than two hits pass the gate', async () => {
    await seed({ 'alpha strong': 0.9, 'charlie weak': 0.2, 'delta weak': 0.15 })
    const scorer = vi.fn(async (_q: string, docs: string[]) => docs.map(() => 1))
    setRerankBatchScorer(scorer)
    const off = await memorySearch({ query: 'zz query', limit: 5, rerank: false })
    const on = await memorySearch({ query: 'zz query', limit: 5, rerank: true })
    expect(scorer).not.toHaveBeenCalled()
    expect(on).toEqual(off)
  })

  it('re-reads at most RERANK_POOL hits however many a search asks for; the rest keep the first-stage order behind them', async () => {
    const docs: Record<string, number> = {}
    for (let i = 0; i < RERANK_POOL + 3; i++) docs[`memory number ${String.fromCharCode(97 + i)}`] = 0.9 - i * 0.02
    await seed(docs)
    const off = await memorySearch({ query: 'zz query', limit: RERANK_POOL + 3, rerank: false })
    expect(off).toHaveLength(RERANK_POOL + 3)
    const reversed = vi.fn(async (_q: string, ds: string[]) => ds.map((_d, i) => i)) // the weakest of the pool first
    setRerankBatchScorer(reversed)
    const on = await memorySearch({ query: 'zz query', limit: RERANK_POOL + 3, rerank: true })
    expect(reversed.mock.calls[0][1]).toHaveLength(RERANK_POOL)
    expect(on[0].id).toBe(off[RERANK_POOL - 1].id)
    expect(on.slice(RERANK_POOL).map((r) => r.id)).toEqual(off.slice(RERANK_POOL).map((r) => r.id))
    expect(on.map((r) => r.score)).toEqual(off.map((r) => r.score))
  })
})
