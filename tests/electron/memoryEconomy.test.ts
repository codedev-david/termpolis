import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  gateByScore,
  dedupeHits,
  truncateContent,
  TtlLruCache,
  summarizePrimerCost,
} from '../../src/main/memoryEconomy'

describe('memoryEconomy', () => {
  describe('estimateTokens (~4 chars/token heuristic)', () => {
    it('is 0 for empty and rounds up otherwise', () => {
      expect(estimateTokens('')).toBe(0)
      expect(estimateTokens('abcd')).toBe(1)
      expect(estimateTokens('abcde')).toBe(2) // ceil(5/4)
      expect(estimateTokens('a'.repeat(400))).toBe(100)
    })
  })

  describe('gateByScore — relevance gate WITH a floor so recall never starves', () => {
    const mk = (...scores: number[]) => scores.map((score, i) => ({ score, id: String(i) }))

    it('keeps only hits at/above minScore when there are plenty', () => {
      expect(gateByScore(mk(0.9, 0.8, 0.2, 0.1), { minScore: 0.5, floor: 1, cap: 10 }).map(h => h.score))
        .toEqual([0.9, 0.8])
    })
    it('keeps at least `floor` top hits even when ALL are below minScore (never starve)', () => {
      expect(gateByScore(mk(0.2, 0.1), { minScore: 0.5, floor: 2, cap: 10 }).map(h => h.score))
        .toEqual([0.2, 0.1])
    })
    it('caps the total even when many clear the bar', () => {
      expect(gateByScore(mk(0.9, 0.8, 0.7, 0.6, 0.5, 0.4), { minScore: 0.5, floor: 1, cap: 3 }).map(h => h.score))
        .toEqual([0.9, 0.8, 0.7])
    })
    it('a floor larger than the input keeps everything', () => {
      expect(gateByScore(mk(0.9), { minScore: 0.5, floor: 3, cap: 10 }).map(h => h.score)).toEqual([0.9])
    })
    it('always returns hits sorted by score desc regardless of input order', () => {
      expect(gateByScore(mk(0.2, 0.9, 0.5), { minScore: 0, floor: 0, cap: 10 }).map(h => h.score))
        .toEqual([0.9, 0.5, 0.2])
    })
  })

  describe('dedupeHits — drop exact duplicate content, keep the first (highest score)', () => {
    it('drops case/whitespace-insensitive duplicates', () => {
      const hits = [
        { content: 'Fix the auth bug', score: 0.9 },
        { content: '  fix the   AUTH bug ', score: 0.8 },
        { content: 'Unrelated note', score: 0.7 },
      ]
      expect(dedupeHits(hits).map(h => h.content)).toEqual(['Fix the auth bug', 'Unrelated note'])
    })
    it('keeps genuinely distinct content untouched', () => {
      const hits = [{ content: 'alpha', score: 1 }, { content: 'beta', score: 0.9 }]
      expect(dedupeHits(hits)).toHaveLength(2)
    })
  })

  describe('truncateContent', () => {
    it('returns short content unchanged', () => {
      expect(truncateContent('hello', 10)).toBe('hello')
    })
    it('truncates long content and marks it with an ellipsis', () => {
      const out = truncateContent('a'.repeat(50), 10)
      expect(out.length).toBeLessThanOrEqual(11)
      expect(out.endsWith('…')).toBe(true)
    })
  })

  describe('summarizePrimerCost — the measurable injection cost', () => {
    it('reports chars/tokens/lines, zero for null', () => {
      expect(summarizePrimerCost(null)).toEqual({ chars: 0, tokens: 0, lines: 0 })
      const c = summarizePrimerCost('ab\ncd')
      expect(c.chars).toBe(5)
      expect(c.lines).toBe(2)
      expect(c.tokens).toBe(estimateTokens('ab\ncd'))
    })
  })

  describe('TtlLruCache — result cache so repeated searches are instant', () => {
    it('returns a cached value before the TTL expires', () => {
      let now = 1000
      const c = new TtlLruCache<number[]>(10, 60_000, () => now)
      c.set('q', [1, 2, 3])
      expect(c.get('q')).toEqual([1, 2, 3])
      now = 1000 + 59_000
      expect(c.get('q')).toEqual([1, 2, 3])
    })
    it('misses after the TTL expires', () => {
      let now = 0
      const c = new TtlLruCache<string>(10, 1_000, () => now)
      c.set('q', 'v')
      now = 1_001
      expect(c.get('q')).toBeUndefined()
    })
    it('evicts the least-recently-used entry past capacity', () => {
      const now = 0
      const c = new TtlLruCache<number>(2, 60_000, () => now)
      c.set('a', 1)
      c.set('b', 2)
      c.get('a') // 'a' is now most-recently used
      c.set('c', 3) // evicts LRU = 'b'
      expect(c.get('b')).toBeUndefined()
      expect(c.get('a')).toBe(1)
      expect(c.get('c')).toBe(3)
    })
  })
})
