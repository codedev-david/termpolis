import { describe, it, expect } from 'vitest'
import { recallAtK, precisionAtK, reciprocalRank, mrr, meanRecallAtK } from '../../src/main/recallMetrics'

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
})
