import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  gateByScore,
  dedupeHits,
  truncateContent,
  TtlLruCache,
  summarizePrimerCost,
  rankScore,
  RANK_DEFAULTS,
  adaptiveGate,
  mergeRelated,
} from '../../src/main/memoryEconomy'

const DAY = 86_400_000

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

  describe('rankScore — fuse relevance with recency + per-kind importance', () => {
    it('applies the full recency boost to a brand-new hit (deltaT = 0)', () => {
      // final = relevance * (1 + alpha*1) * kindPrior(message=1) = 1 * 1.25 * 1
      expect(rankScore({ relevance: 1, ts: 1000, kind: 'message', now: 1000 })).toBeCloseTo(1.25, 10)
    })

    it('decays the recency boost toward zero for ancient hits', () => {
      // ~10 years old → recency ≈ 0 → final ≈ relevance * 1 * prior
      const r = rankScore({ relevance: 0.8, ts: 0, kind: 'message', now: 3650 * DAY })
      expect(r).toBeCloseTo(0.8, 5)          // recency boost has fully decayed to the un-boosted score
      expect(r).toBeLessThan(0.8 * 1.25)     // strictly below a brand-new hit's fully-boosted rank
    })

    it('halves the recency boost at exactly one half-life (30 days)', () => {
      // deltaT = halfLife → recency = 0.5 → factor (1 + 0.25*0.5) = 1.125
      expect(rankScore({ relevance: 1, ts: 0, kind: 'message', now: 30 * DAY })).toBeCloseTo(1.125, 10)
    })

    it('CLAMPS future-dated timestamps (peer clock skew) to no MORE than the full boost', () => {
      const future = rankScore({ relevance: 1, ts: 5000, kind: 'message', now: 1000 }) // ts > now
      expect(future).toBeCloseTo(1.25, 10)  // same as deltaT=0, never exceeds the full boost
    })

    it('gives decision/fact a higher prior than message/result/note (spread ≤ 1.15)', () => {
      const base = { relevance: 1, ts: 1000, now: 1000 }
      const decision = rankScore({ ...base, kind: 'decision' })
      const fact = rankScore({ ...base, kind: 'fact' })
      const message = rankScore({ ...base, kind: 'message' })
      const note = rankScore({ ...base, kind: 'note' })
      const result = rankScore({ ...base, kind: 'result' })
      expect(decision).toBeGreaterThan(message)
      expect(fact).toBeGreaterThan(message)
      expect(note).toBeCloseTo(message, 10)   // only decision/fact are boosted
      expect(result).toBeCloseTo(message, 10)
      expect(decision / message).toBeLessThanOrEqual(1.15 + 1e-9) // never starves the message bucket
    })

    it('is monotonic in relevance (higher relevance always ranks higher, same ts/kind)', () => {
      const lo = rankScore({ relevance: 0.4, ts: 1000, kind: 'fact', now: 1000 })
      const hi = rankScore({ relevance: 0.6, ts: 1000, kind: 'fact', now: 1000 })
      expect(hi).toBeGreaterThan(lo)
    })

    it('returns 0 when relevance is 0 regardless of recency/kind', () => {
      expect(rankScore({ relevance: 0, ts: 1000, kind: 'decision', now: 1000 })).toBe(0)
    })

    it('treats unknown/missing kind as the neutral prior 1.0', () => {
      const known = rankScore({ relevance: 1, ts: 1000, kind: 'message', now: 1000 })
      expect(rankScore({ relevance: 1, ts: 1000, now: 1000 })).toBeCloseTo(known, 10)
      expect(rankScore({ relevance: 1, ts: 1000, kind: 'mystery', now: 1000 })).toBeCloseTo(known, 10)
    })

    it('honors injected weights (alpha, halfLifeMs, kindPriors)', () => {
      // alpha 0 → no recency boost at all → final = relevance * prior
      expect(rankScore({ relevance: 1, ts: 0, kind: 'message', now: 99 * DAY }, { alpha: 0 })).toBeCloseTo(1, 10)
      // custom kind prior
      expect(rankScore({ relevance: 1, ts: 1000, kind: 'message', now: 1000 }, { alpha: 0, kindPriors: { message: 2 } }))
        .toBeCloseTo(2, 10)
    })

    it('exposes its defaults (alpha 0.25, 30-day half-life, decision/fact 1.15)', () => {
      expect(RANK_DEFAULTS.alpha).toBe(0.25)
      expect(RANK_DEFAULTS.halfLifeMs).toBe(30 * DAY)
      expect(RANK_DEFAULTS.kindPriors.decision).toBe(1.15)
      expect(RANK_DEFAULTS.kindPriors.fact).toBe(1.15)
    })
  })

  describe('adaptiveGate — per-query dynamic relevance cut (keep the cluster near the top)', () => {
    const mk = (...scores: number[]) => scores.map((score, i) => ({ score, id: String(i) }))

    it('trims to the cluster above the relative cliff (relFrac * topScore)', () => {
      // top 0.9 → threshold max(0.25, 0.54) = 0.54 → keeps 0.9, 0.85, 0.6 only
      expect(adaptiveGate(mk(0.9, 0.85, 0.6, 0.5, 0.45, 0.4), { floor: 1, cap: 10, relFrac: 0.6, absoluteFloor: 0.25 }).map(h => h.score))
        .toEqual([0.9, 0.85, 0.6])
    })
    it('falls back to the absolute floor when the top score is weak', () => {
      // top 0.3 → 0.6*0.3 = 0.18 < 0.25 → threshold 0.25 → keeps 0.3, 0.28
      expect(adaptiveGate(mk(0.3, 0.28, 0.2, 0.1), { floor: 1, cap: 10, relFrac: 0.6, absoluteFloor: 0.25 }).map(h => h.score))
        .toEqual([0.3, 0.28])
    })
    it('never starves — keeps at least `floor` even past a steep cliff', () => {
      // top 0.9 → threshold 0.54 → only 0.9 qualifies, but floor 3 keeps the top 3
      expect(adaptiveGate(mk(0.9, 0.1, 0.08, 0.05), { floor: 3, cap: 10, relFrac: 0.6, absoluteFloor: 0.25 }).map(h => h.score))
        .toEqual([0.9, 0.1, 0.08])
    })
    it('caps the result even when many clear the dynamic threshold', () => {
      expect(adaptiveGate(mk(0.9, 0.88, 0.86, 0.84, 0.82), { floor: 1, cap: 2, relFrac: 0.6, absoluteFloor: 0.25 }).map(h => h.score))
        .toEqual([0.9, 0.88])
    })
    it('clamps a negative top score so the floor still surfaces the best hit (never a negative threshold)', () => {
      const out = adaptiveGate(mk(-0.1, -0.3, -0.5), { floor: 1, cap: 10, relFrac: 0.6, absoluteFloor: 0 })
      expect(out.map(h => h.score)).toEqual([-0.1])
    })
    it('sorts by score desc and returns [] for empty input', () => {
      expect(adaptiveGate(mk(0.2, 0.9, 0.5), { floor: 0, cap: 10, relFrac: 0, absoluteFloor: 0 }).map(h => h.score)).toEqual([0.9, 0.5, 0.2])
      expect(adaptiveGate([], { floor: 3, cap: 10, relFrac: 0.6, absoluteFloor: 0.25 })).toEqual([])
    })
  })

  describe('mergeRelated — fuse vector neighbours with typed-edge neighbours (QW6)', () => {
    it('dedups by id and soft-OR-combines vector sim with the saturated edge weight', () => {
      const out = mergeRelated({ vectorHits: [{ id: 'x', score: 0.6 }], edges: [{ id: 'x', relation: 'solves', weight: 1 }] })
      expect(out).toHaveLength(1)
      expect(out[0].id).toBe('x')
      expect(out[0].relation).toBe('solves')
      expect(out[0].score).toBeCloseTo(1 - (1 - 0.6) * (1 - 0.5), 10) // 0.8 (edge w=1 → 0.5)
    })
    it('saturates raw edge weight so a default link (w=1 → 0.5) cannot outrank a strong vector hit', () => {
      const out = mergeRelated({ vectorHits: [{ id: 'strong', score: 0.9 }], edges: [{ id: 'link', relation: 'relates-to', weight: 1 }] })
      expect(out.map(o => o.id)).toEqual(['strong', 'link'])
      expect(out[1].score).toBeCloseTo(0.5, 10)
    })
    it('surfaces edge-only neighbours (no vector hit) and keeps the relation', () => {
      const out = mergeRelated({ vectorHits: [], edges: [{ id: 'e', relation: 'follows', weight: 3 }] })
      expect(out[0]).toMatchObject({ id: 'e', relation: 'follows' })
      expect(out[0].score).toBeCloseTo(3 / 4, 10) // saturate(3) = 0.75
    })
    it('clamps negative/over-unit vector sims, drops score<=0, returns sorted desc', () => {
      const out = mergeRelated({ vectorHits: [{ id: 'neg', score: -0.5 }, { id: 'a', score: 0.3 }, { id: 'b', score: 0.7 }], edges: [] })
      expect(out.map(o => o.id)).toEqual(['b', 'a']) // 'neg' clamps to 0 → score 0 → dropped
    })
    it('keeps the strongest edge weight + its relation when an id has multiple edges (order-independent)', () => {
      const out = mergeRelated({ vectorHits: [], edges: [{ id: 'x', relation: 'weak', weight: 0.2 }, { id: 'x', relation: 'strong', weight: 5 }] })
      expect(out).toHaveLength(1)
      expect(out[0].relation).toBe('strong')
      expect(out[0].score).toBeCloseTo(5 / 6, 10)
    })
  })
})
