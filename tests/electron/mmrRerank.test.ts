import { describe, it, expect } from 'vitest'
import { mmrRerank } from '../../src/main/mmrRerank'

const item = (id: string, score: number) => ({ id, score })

describe('mmrRerank (BB2)', () => {
  it('lambda=1 returns pure relevance order (input order preserved)', () => {
    const items = [item('a', 0.9), item('b', 0.8), item('c', 0.7)]
    expect(mmrRerank(items, () => 1, { lambda: 1, k: 3 }).map(x => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('drops a near-duplicate of the top item in favor of a distinct one', () => {
    // b is a near-dup of a (sim 1); c is distinct (sim 0). Diversity tips c above b.
    const sim = (x: { id: string }, y: { id: string }) =>
      (x.id === 'a' && y.id === 'b') || (x.id === 'b' && y.id === 'a') ? 1 : 0
    const items = [item('a', 0.9), item('b', 0.85), item('c', 0.8)]
    expect(mmrRerank(items, sim, { lambda: 0.5, k: 2 }).map(x => x.id)).toEqual(['a', 'c'])
  })

  it('respects k', () => {
    const items = [item('a', 0.9), item('b', 0.8), item('c', 0.7)]
    expect(mmrRerank(items, () => 0, { k: 2 })).toHaveLength(2)
  })

  it('returns [] for empty input or k <= 0', () => {
    expect(mmrRerank([], () => 0, {})).toEqual([])
    expect(mmrRerank([item('a', 1)], () => 0, { k: 0 })).toEqual([])
  })

  it('keeps the higher-relevance item on a tie (stable)', () => {
    expect(mmrRerank([item('a', 0.9), item('b', 0.9)], () => 0, { lambda: 0.7, k: 1 })[0].id).toBe('a')
  })
})
