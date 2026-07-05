import { describe, it, expect } from 'vitest'
import { recallAtK, precisionAtK, reciprocalRank, mrr, meanRecallAtK, dcgAtK, ndcgAtK, meanNdcgAtK, evaluate, evaluateSlices } from '../../src/main/recallMetrics'

describe('recallMetrics — IR metrics over (rankedIds, relevantSet)', () => {
  it('recallAtK = fraction of the relevant set found in the top k', () => {
    const ranked = ['a', 'b', 'c', 'd']
    expect(recallAtK(ranked, new Set(['a', 'c']), 2)).toBeCloseTo(0.5) // only 'a' in top-2
    expect(recallAtK(ranked, new Set(['a', 'c']), 3)).toBeCloseTo(1) // 'a' and 'c' in top-3
    expect(recallAtK(ranked, new Set(['z']), 4)).toBe(0)
  })

  it('recallAtK is 0 for an empty relevant set (no divide-by-zero)', () => {
    expect(recallAtK(['a'], new Set(), 3)).toBe(0)
  })

  it('precisionAtK = fraction of the top k that is relevant', () => {
    expect(precisionAtK(['a', 'b', 'c'], new Set(['a']), 2)).toBeCloseTo(0.5)
    expect(precisionAtK(['a', 'b'], new Set(['a', 'b']), 2)).toBeCloseTo(1)
    expect(precisionAtK(['a'], new Set(['a']), 0)).toBe(0)
  })

  it('reciprocalRank = 1 / rank of the first relevant hit (0 if none)', () => {
    expect(reciprocalRank(['b', 'a', 'c'], new Set(['a']))).toBeCloseTo(0.5)
    expect(reciprocalRank(['a', 'b'], new Set(['a']))).toBeCloseTo(1)
    expect(reciprocalRank(['x', 'y'], new Set(['a']))).toBe(0)
  })

  it('mrr / meanRecallAtK average across queries (empty → 0)', () => {
    const qs = [
      { rankedIds: ['a', 'b'], relevant: new Set(['a']) }, // RR 1.0, recall@2 1.0
      { rankedIds: ['x', 'y'], relevant: new Set(['y']) }, // RR 0.5, recall@2 1.0
    ]
    expect(mrr(qs)).toBeCloseTo(0.75)
    expect(meanRecallAtK(qs, 2)).toBeCloseTo(1)
    expect(mrr([])).toBe(0)
    expect(meanRecallAtK([], 5)).toBe(0)
  })

  describe('nDCG — order-sensitive quality', () => {
    it('dcgAtK rewards higher-ranked relevant hits more', () => {
      expect(dcgAtK(['a', 'x', 'y'], new Set(['a']), 3)).toBeCloseTo(1) // rank 1 → 1/log2(2) = 1
      expect(dcgAtK(['x', 'a', 'y'], new Set(['a']), 3)).toBeCloseTo(1 / Math.log2(3)) // rank 2
    })
    it('ndcgAtK is 1 when the relevant items are ranked first, less otherwise', () => {
      expect(ndcgAtK(['a', 'b', 'x'], new Set(['a', 'b']), 3)).toBeCloseTo(1) // ideal ordering
      expect(ndcgAtK(['x', 'a', 'b'], new Set(['a', 'b']), 3)).toBeLessThan(1) // relevant demoted
      expect(ndcgAtK(['x', 'y'], new Set<string>(), 2)).toBe(0) // nothing relevant
    })
    it('meanNdcgAtK averages across queries (0 for none)', () => {
      const qs = [
        { rankedIds: ['a', 'b'], relevant: new Set(['a']) },
        { rankedIds: ['b', 'a'], relevant: new Set(['a']) },
      ]
      expect(meanNdcgAtK(qs, 2)).toBeGreaterThan(0)
      expect(meanNdcgAtK([], 2)).toBe(0)
    })
  })

  describe('evaluate + slices', () => {
    it('evaluate returns mrr + recall@k + ndcg@k for the given cutoffs', () => {
      const qs = [{ rankedIds: ['a', 'b', 'c'], relevant: new Set(['a', 'c']) }]
      const s = evaluate(qs, [1, 3])
      expect(s.n).toBe(1)
      expect(s.mrr).toBeCloseTo(1) // first hit at rank 1
      expect(s.recallAtK[3]).toBeCloseTo(1)
      expect(s.ndcgAtK[1]).toBeCloseTo(1) // relevant 'a' at rank 1; ideal@1 is also one hit → 1.0
      expect(s.ndcgAtK[3]).toBeGreaterThan(0.9) // 'a'@1 + 'c'@3 — near-ideal but 'c' one slot low
    })
    it('evaluateSlices summarizes each tagged scenario independently', () => {
      const qs = [
        { scenario: 'cross-project', rankedIds: ['a'], relevant: new Set(['a']) },
        { scenario: 'superseded', rankedIds: ['x', 'y'], relevant: new Set(['y']) },
      ]
      const slices = evaluateSlices(qs, [1])
      expect(Object.keys(slices).sort()).toEqual(['cross-project', 'superseded'])
      expect(slices['cross-project'].recallAtK[1]).toBeCloseTo(1)
      expect(slices['superseded'].recallAtK[1]).toBeCloseTo(0) // relevant not in top-1
    })
  })
})
