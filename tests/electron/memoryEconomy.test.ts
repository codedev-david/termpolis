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
  diversifyHits,
  fuseImportance,
  normText,
  isStrictPrefix,
  dropPrefixDuplicates,
  dropOverlapping,
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
      // a non-positive half-life disables the recency term entirely (guard branch)
      expect(rankScore({ relevance: 1, ts: 0, kind: 'message', now: 1000 }, { halfLifeMs: 0 })).toBeCloseTo(1, 10)
    })

    it('exposes its defaults (alpha 0.25, 30-day half-life, decision/fact 1.15)', () => {
      expect(RANK_DEFAULTS.alpha).toBe(0.25)
      expect(RANK_DEFAULTS.halfLifeMs).toBe(30 * DAY)
      expect(RANK_DEFAULTS.kindPriors.decision).toBe(1.15)
      expect(RANK_DEFAULTS.kindPriors.fact).toBe(1.15)
    })
  })

  describe('fuseImportance — usage-reinforcement nudge (BB13)', () => {
    it('returns the score unchanged for zero usage', () => {
      expect(fuseImportance(0.8, 0)).toBe(0.8)
    })
    it('lifts the score for repeated usage, monotonically', () => {
      const u1 = fuseImportance(0.8, 1), u5 = fuseImportance(0.8, 5), u20 = fuseImportance(0.8, 20)
      expect(u1).toBeGreaterThan(0.8)
      expect(u5).toBeGreaterThan(u1)
      expect(u20).toBeGreaterThan(u5)
    })
    it('caps the nudge so it never overrides relevance (+20% max)', () => {
      expect(fuseImportance(0.8, 1_000_000)).toBeLessThanOrEqual(0.8 * 1.2 + 1e-9)
    })
    it('honors custom weight/cap', () => {
      expect(fuseImportance(1, 100, { weight: 0, cap: 0.5 })).toBe(1)                  // weight 0 → no nudge
      expect(fuseImportance(1, 1_000_000, { weight: 1, cap: 0.1 })).toBeCloseTo(1.1, 10) // cap 0.1
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
    it('the floor never resurrects hits below the absolute noise bar (#5)', () => {
      // 0.9 qualifies; 0.1/0.08/0.05 are below absoluteFloor 0.25 — the floor must
      // NOT pull noise back in just to hit the count, so only 0.9 survives.
      expect(adaptiveGate(mk(0.9, 0.1, 0.08, 0.05), { floor: 3, cap: 10, relFrac: 0.6, absoluteFloor: 0.25 }).map(h => h.score))
        .toEqual([0.9])
    })
    it('keeps the floor among hits that DO clear the bar (genuine-but-thin recall)', () => {
      // 0.9/0.4/0.3 all clear 0.25, so the floor surfaces the thin tail; 0.05 is noise.
      expect(adaptiveGate(mk(0.9, 0.4, 0.3, 0.05), { floor: 3, cap: 10, relFrac: 0.6, absoluteFloor: 0.25 }).map(h => h.score))
        .toEqual([0.9, 0.4, 0.3])
    })
    it('injects NOTHING when even the best hit is noise (#5)', () => {
      expect(adaptiveGate(mk(0.2, 0.1, 0.05), { floor: 3, cap: 10, relFrac: 0.6, absoluteFloor: 0.25 })).toEqual([])
    })
    it('caps the result even when many clear the dynamic threshold', () => {
      expect(adaptiveGate(mk(0.9, 0.88, 0.86, 0.84, 0.82), { floor: 1, cap: 2, relFrac: 0.6, absoluteFloor: 0.25 }).map(h => h.score))
        .toEqual([0.9, 0.88])
    })
    it('clamps a negative top score to a non-negative threshold; all-negative scores are noise → [] (#5)', () => {
      // max(0, topScore) keeps the threshold from going negative (which would
      // accept everything); anti-correlated (negative) hits clear nothing above
      // absoluteFloor 0, so nothing is injected rather than negative filler.
      expect(adaptiveGate(mk(-0.1, -0.3, -0.5), { floor: 1, cap: 10, relFrac: 0.6, absoluteFloor: 0 })).toEqual([])
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

  describe('diversifyHits — read-time near-duplicate/diversity pass (QW4)', () => {
    const mk = (content: string, score = 1) => ({ content, score })
    it('drops a near-duplicate paraphrase (token-Jaccard) but keeps distinct hits', () => {
      const out = diversifyHits([
        mk('we use HNSW for vector search in the brain'),
        mk('we use HNSW for the vector lookup in the brain'), // ~0.75 Jaccard with #1
        mk('rate limiting uses a token bucket'),
      ], { threshold: 0.7 })
      expect(out.map(h => h.content)).toEqual([
        'we use HNSW for vector search in the brain',
        'rate limiting uses a token bucket',
      ])
    })
    it('is a strict superset of dedupeHits — also removes exact duplicates', () => {
      expect(diversifyHits([mk('alpha beta gamma'), mk('alpha beta gamma')], { threshold: 0.7 })).toHaveLength(1)
    })
    it('keeps the FIRST (highest-scored) of a near-dup cluster, preserving order', () => {
      const out = diversifyHits([mk('keep me one two three'), mk('keep me one two four'), mk('totally different stuff')], { threshold: 0.5 })
      expect(out.map(h => h.content)).toEqual(['keep me one two three', 'totally different stuff'])
    })
    it('uses an injected simFn (cosine) instead of token-Jaccard when provided', () => {
      const items = [{ content: 'x', vec: 1 }, { content: 'y', vec: 1 }, { content: 'z', vec: 0 }]
      const simFn = (p: { vec: number }, q: { vec: number }) => (p.vec === q.vec ? 1 : 0)
      const out = diversifyHits(items, { threshold: 0.9, simFn })
      expect(out.map(h => h.content)).toEqual(['x', 'z']) // y dropped (sim 1 to x), z kept (sim 0)
    })
    it('does not collapse token-sparse snippets that share their one common word', () => {
      // Each has only one >2-char token ("content") → too little signal to judge.
      const out = diversifyHits([mk('content p1'), mk('content p2'), mk('content g1')], { threshold: 0.7 })
      expect(out).toHaveLength(3)
    })
    it('no-ops on empty / single-element input', () => {
      expect(diversifyHits([], { threshold: 0.7 })).toEqual([])
      expect(diversifyHits([mk('solo')], { threshold: 0.7 })).toHaveLength(1)
    })
  })

  // The ingest pass stores the trailing partial chunk of an active session, and a later pass stores the fuller
  // chunk that begins with the same turns: both come back from one search, saying the same thing twice.
  describe('normText and isStrictPrefix — the head of another hit, at a word boundary', () => {
    it('folds case and every run of whitespace, and trims', () => {
      expect(normText('  Fix  the\n\nBUILD \t now ')).toBe('fix the build now')
      expect(normText('')).toBe('')
      expect(normText(undefined as unknown as string)).toBe('')
    })

    it('is true when the longer text begins with the shorter and carries on after a space', () => {
      expect(isStrictPrefix('user: fix the build', 'user: fix the build\n\nassistant: done')).toBe(true)
    })

    it('ignores case and whitespace differences between the two', () => {
      expect(isStrictPrefix('Fix  The BUILD', 'fix the build now')).toBe(true)
    })

    it('is false for equal text, for a text that is not a head, and for an empty one', () => {
      expect(isStrictPrefix('fix the build', 'fix the  BUILD')).toBe(false) // equal once folded: dedupeHits owns that
      expect(isStrictPrefix('fix the build', 'then fix the build')).toBe(false)
      expect(isStrictPrefix('fix the build now', 'fix the build')).toBe(false) // the longer one is not a head of the shorter
      expect(isStrictPrefix('', 'anything at all')).toBe(false)
      expect(isStrictPrefix('   ', 'anything at all')).toBe(false)
      expect(isStrictPrefix(undefined as unknown as string, 'anything')).toBe(false)
    })

    it('is false for equal text that ends on punctuation, and for an empty text before text that starts with punctuation', () => {
      // The word-boundary rule alone would call these heads (a non-word character on either side of the cut is a boundary):
      // only the length and emptiness guards say they are not.
      expect(isStrictPrefix('it works.', 'IT  works.')).toBe(false)
      expect(isStrictPrefix('(done)', '(done)')).toBe(false)
      expect(isStrictPrefix('', '- a list item')).toBe(false)
      expect(isStrictPrefix('  ', '"quoted" start')).toBe(false)
      expect(isStrictPrefix('', '[x] todo')).toBe(false)
    })

    it('does not cut a word in two: "content 1" is not the head of "content 10"', () => {
      expect(isStrictPrefix('content 1', 'content 10')).toBe(false)
      expect(isStrictPrefix('see v1', 'see v10 for the fix')).toBe(false)
      expect(isStrictPrefix('see the café', 'see the cafés nearby')).toBe(false) // letters beyond ASCII are letters
      expect(isStrictPrefix('snake_case', 'snake_cased value')).toBe(false) // an underscore is part of a word
      expect(isStrictPrefix('call memory', 'call memory_search first')).toBe(false) // and joins what follows it too
      expect(isStrictPrefix('call memory_', 'call memory_search first')).toBe(false) // and what comes before it
    })

    it('does when the shorter ends on punctuation, or the longer goes on with punctuation or a new line', () => {
      expect(isStrictPrefix('it works.', 'it works.then it broke')).toBe(true)
      expect(isStrictPrefix('it works', 'it works, then it broke')).toBe(true)
      expect(isStrictPrefix('it works', 'it works\n(see below)')).toBe(true)
    })
  })

  describe('dropPrefixDuplicates — keep the fuller chunk, lose the head of it', () => {
    const FIRST = 'user: how do I cut a release?\n\nassistant: bump the version and push a tag'
    const FULL = `${FIRST}\n\nuser: done, thanks\n\nassistant: glad it worked`
    const mk = (id: string, content: string, score?: number) => (score === undefined ? { id, content } : { id, content, score })

    it('returns the very same array when there is nothing to drop (no copy, nothing for a quiet digest to pay)', () => {
      const none = [mk('a', 'alpha beta gamma', 0.9), mk('b', 'delta epsilon zeta', 0.8)]
      expect(dropPrefixDuplicates(none)).toBe(none)
      const one = [mk('a', FIRST, 0.9)]
      expect(dropPrefixDuplicates(one)).toBe(one)
      const empty: Array<{ id: string; content: string }> = []
      expect(dropPrefixDuplicates(empty)).toBe(empty)
    })

    it('drops the head and keeps the fuller chunk, whichever came first', () => {
      expect(dropPrefixDuplicates([mk('head', FIRST, 0.5), mk('full', FULL, 0.9)]).map((h) => h.id)).toEqual(['full'])
      expect(dropPrefixDuplicates([mk('full', FULL, 0.9), mk('head', FIRST, 0.5)]).map((h) => h.id)).toEqual(['full'])
    })

    it('keeps everything else in its order', () => {
      const out = dropPrefixDuplicates([mk('x', 'one unrelated thing', 0.9), mk('head', FIRST, 0.8), mk('y', 'another unrelated thing', 0.7), mk('full', FULL, 0.6)])
      expect(out.map((h) => h.id)).toEqual(['x', 'y', 'full'])
    })

    describe('atFirst: for a ranking that is not sorted again', () => {
      const MIDDLE = `${FIRST}\n\nuser: done, thanks`
      const ids = (hits: Array<{ id: string }>) => hits.map((h) => h.id)

      it('puts the fuller chunk where the head it replaces was ranked', () => {
        const out = dropPrefixDuplicates([mk('head', FIRST, 0.9), mk('x', 'one unrelated thing', 0.8), mk('y', 'another unrelated thing', 0.7), mk('full', FULL, 0.6)], true)
        expect(ids(out)).toEqual(['full', 'x', 'y'])
        expect(out[0].score).toBe(0.9) // and it still takes the head's better score
      })

      it('takes the earliest place of several heads, whichever order they come in', () => {
        const list = [mk('x', 'one unrelated thing', 0.9), mk('mid', MIDDLE, 0.8), mk('y', 'another unrelated thing', 0.7), mk('head', FIRST, 0.6), mk('full', FULL, 0.5)]
        expect(ids(dropPrefixDuplicates(list, true))).toEqual(['x', 'full', 'y'])
        expect(ids(dropPrefixDuplicates([list[0], list[3], list[2], list[1], list[4]], true))).toEqual(['x', 'full', 'y'])
      })

      it('leaves a fuller chunk that is already ranked first where it is, and an untouched list alone', () => {
        expect(ids(dropPrefixDuplicates([mk('full', FULL, 0.9), mk('x', 'one unrelated thing', 0.8), mk('head', FIRST, 0.7)], true))).toEqual(['full', 'x'])
        const clean = [mk('a', 'alpha beta gamma', 0.9), mk('b', 'delta epsilon zeta', 0.8)]
        expect(dropPrefixDuplicates(clean, true)).toBe(clean)
      })

      it('is the same as the default mode when no head is ranked ahead of the fuller chunk', () => {
        const list = [mk('x', 'one unrelated thing', 0.9), mk('full', FULL, 0.8), mk('head', FIRST, 0.7)]
        expect(dropPrefixDuplicates(list, true)).toEqual(dropPrefixDuplicates(list))
      })
    })

    it('lets the fuller chunk take the better score, so the passage is not lost to the relevance cut', () => {
      const head = mk('head', FIRST, 0.9)
      const full = mk('full', FULL, 0.4)
      const [kept] = dropPrefixDuplicates([head, full])
      expect(kept.id).toBe('full')
      expect(kept.score).toBe(0.9)
      expect(full.score).toBe(0.4) // the caller's object is not changed
    })

    it('keeps the fuller chunk\'s own score, and the very object, when it already scores higher', () => {
      const full = mk('full', FULL, 0.9)
      const [kept] = dropPrefixDuplicates([mk('head', FIRST, 0.4), full])
      expect(kept).toBe(full)
    })

    it('follows a chain to its end: a head of a head of the fuller chunk, which takes the best score of the three', () => {
      const MID = `${FIRST}\n\nuser: done, thanks`
      const out = dropPrefixDuplicates([mk('head', FIRST, 0.95), mk('mid', MID, 0.5), mk('full', FULL, 0.3)])
      expect(out.map((h) => h.id)).toEqual(['full'])
      expect(out[0].score).toBe(0.95)
    })

    it('drops one head that begins two different fuller chunks, and keeps both of them', () => {
      const A = `${FIRST}\n\nuser: and the changelog?`
      const B = `${FIRST}\n\nuser: and the notes?\n\nassistant: written`
      const out = dropPrefixDuplicates([mk('head', FIRST, 0.9), mk('a', A, 0.5), mk('b', B, 0.6)])
      expect(out.map((h) => h.id)).toEqual(['a', 'b'])
      expect(out.find((h) => h.id === 'b')?.score).toBe(0.9) // the longer of the two took it
      expect(out.find((h) => h.id === 'a')?.score).toBe(0.5)
    })

    it('hands the score to the first of two equally long fuller chunks', () => {
      const A = `${FIRST}\n\nuser: aaaa`
      const B = `${FIRST}\n\nuser: bbbb`
      const out = dropPrefixDuplicates([mk('head', FIRST, 0.9), mk('a', A, 0.2), mk('b', B, 0.2)])
      expect(out.find((h) => h.id === 'a')?.score).toBe(0.9)
      expect(out.find((h) => h.id === 'b')?.score).toBe(0.2)
    })

    it('works on hits that carry no score at all', () => {
      const out = dropPrefixDuplicates([mk('head', FIRST), mk('full', FULL)])
      expect(out).toEqual([{ id: 'full', content: FULL }])
      expect('score' in out[0]).toBe(false)
    })

    it('hands a score to a fuller chunk that had none', () => {
      const out = dropPrefixDuplicates([mk('head', FIRST, 0.7), mk('full', FULL)])
      expect(out).toEqual([{ id: 'full', content: FULL, score: 0.7 }])
    })

    it('leaves a head that stops in the middle of a word, and numbered contents, alone', () => {
      const numbered = Array.from({ length: 12 }, (_, i) => mk(`n${i}`, `content ${i + 1}`, 0.9 - i * 0.01))
      expect(dropPrefixDuplicates(numbered)).toBe(numbered)
      const cut = [mk('cut', 'we decided to keep the retry queue in mem', 0.9), mk('full', 'we decided to keep the retry queue in memory', 0.5)]
      expect(dropPrefixDuplicates(cut)).toBe(cut)
    })

    it('never drops or hosts a hit with no text', () => {
      const blanks = [mk('a', '', 0.9), mk('b', '   ', 0.8), mk('c', 'some text here', 0.7)]
      expect(dropPrefixDuplicates(blanks)).toBe(blanks)
    })

    it('leaves exact duplicates to dedupeHits', () => {
      const same = [mk('a', FIRST, 0.9), mk('b', FIRST, 0.8)]
      expect(dropPrefixDuplicates(same)).toBe(same)
    })

    it('leaves equal text that ends on punctuation, and an empty text beside one that starts with punctuation, alone', () => {
      // Two sessions can hold the same line (the store keys a chunk on its session too), and the freshness lane has no
      // dedupe of its own: neither may be taken for the head of the other, nor an empty one for the head of a list item.
      const same = [mk('a', 'It works.', 0.9), mk('b', 'it  works.', 0.8)]
      expect(dropPrefixDuplicates(same)).toBe(same)
      const blank = [mk('a', '', 0.9), mk('b', '- a list item', 0.8)]
      expect(dropPrefixDuplicates(blank)).toBe(blank)
    })
  })

  describe('dropOverlapping — rows that restate a passage already kept', () => {
    const FIRST = 'user: how do I cut a release?\n\nassistant: bump the version and push a tag'
    const FULLER = `${FIRST}\n\nuser: and the changelog?\n\nassistant: the release workflow writes it`
    const row = (id: string, content: string) => ({ id, content })

    it('drops the head of a kept passage and the fuller form of one, and keeps the rest in order', () => {
      const kept = [row('kept', FIRST)]
      const head = row('head', 'user: how do I cut a release?')
      const fuller = row('fuller', FULLER)
      const other = row('other', 'we keep the retry queue in memory')
      const another = row('another', 'the build farm restarts every night')
      expect(dropOverlapping(kept, [head, other, fuller, another])).toEqual([other, another])
    })

    it('keeps the rows themselves (same objects), and gives back the same array when nothing overlaps', () => {
      const kept = [row('kept', FIRST)]
      const rows = [row('a', 'something else entirely'), row('b', 'and another thing')]
      const out = dropOverlapping(kept, rows)
      expect(out).toBe(rows)
      const mixed = [rows[0], row('head', 'user: how do I cut a release?'), rows[1]]
      const cut = dropOverlapping(kept, mixed)
      expect(cut).not.toBe(mixed)
      expect(cut[0]).toBe(rows[0])
      expect(cut[1]).toBe(rows[1])
    })

    it('folds whitespace and case before it compares, as isStrictPrefix does', () => {
      const kept = [row('kept', 'The   Release script\ntags it')]
      expect(dropOverlapping(kept, [row('fuller', 'the release SCRIPT tags it and pushes the tag')])).toEqual([])
      expect(dropOverlapping(kept, [row('head', 'THE RELEASE   script')])).toEqual([])
    })

    it('compares each row with every kept passage', () => {
      const kept = [row('one', 'first passage about the cache'), row('two', FIRST)]
      expect(dropOverlapping(kept, [row('head', 'user: how do I cut a release?')])).toEqual([])
      expect(dropOverlapping(kept, [row('fuller', 'first passage about the cache and its eviction')])).toEqual([])
    })

    it('does not take a text for the head of one that merely shares its letters, nor equal text for a head', () => {
      const kept = [row('kept', 'content 10')]
      const rows = [row('a', 'content 1'), row('b', 'content 10'), row('c', ''), row('d', 'content 100')]
      expect(dropOverlapping(kept, rows)).toBe(rows)
    })

    it('has nothing to compare against an empty kept list, and nothing to drop from an empty row list', () => {
      const rows = [row('a', FIRST)]
      expect(dropOverlapping([], rows)).toBe(rows)
      const none: Array<{ id: string; content: string }> = []
      expect(dropOverlapping([row('k', FIRST)], none)).toBe(none)
    })
  })
})
