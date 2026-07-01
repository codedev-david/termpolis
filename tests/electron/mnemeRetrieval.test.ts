import { describe, it, expect } from 'vitest'
import {
  learnedUtility,
  rerankByUtility,
  proactiveQuery,
  shouldPreSurface,
  LEARNED_UTILITY_DEFAULTS,
  type Scored,
} from '../../src/main/mnemeRetrieval'

describe('mnemeRetrieval', () => {
  describe('learnedUtility — capped multiplicative learned re-rank (relevance-gate safe)', () => {
    it('exposes its defaults (usage 0.05/0.2, importance 0.15/0.15)', () => {
      expect(LEARNED_UTILITY_DEFAULTS.usageWeight).toBe(0.05)
      expect(LEARNED_UTILITY_DEFAULTS.usageCap).toBe(0.2)
      expect(LEARNED_UTILITY_DEFAULTS.importanceWeight).toBe(0.15)
      expect(LEARNED_UTILITY_DEFAULTS.importanceCap).toBe(0.15)
    })

    it('CRITICAL: returns exactly 0 when relevance is 0, even with huge importance + usage', () => {
      expect(learnedUtility({ id: 'a', relevance: 0, importance: 1, useCount: 1_000_000 }, 0)).toBe(0)
      // The gate contract: a zero-relevance hit can never be lifted above 0.
      expect(learnedUtility({ id: 'a', relevance: 0 }, 0)).toBe(0)
    })

    it('leaves the score untouched with no optional fields (no importance, no usage)', () => {
      expect(learnedUtility({ id: 'a', relevance: 0.8 }, 0)).toBeCloseTo(0.8, 10)
    })

    it('lifts the score for importance, capped (+15% max at default weight)', () => {
      // importance 0.2 → nudge 0.15*0.2 = 0.03 (uncapped); importance 1 → nudge 0.15 (== cap)
      expect(learnedUtility({ id: 'a', relevance: 1, importance: 0.2 }, 0)).toBeCloseTo(1.03, 10)
      expect(learnedUtility({ id: 'a', relevance: 1, importance: 1 }, 0)).toBeCloseTo(1.15, 10)
    })

    it('caps the importance nudge so an over-unit importance cannot exceed the ceiling', () => {
      const atCap = learnedUtility({ id: 'a', relevance: 1, importance: 1 }, 0)
      const overCap = learnedUtility({ id: 'a', relevance: 1, importance: 5 }, 0)
      expect(overCap).toBeCloseTo(atCap, 10) // both pinned at +15%
      expect(overCap).toBeCloseTo(1.15, 10)
    })

    it('lifts the score for repeated usage, monotonically and saturating at the cap', () => {
      const u1 = learnedUtility({ id: 'a', relevance: 1, useCount: 1 }, 0)
      const u5 = learnedUtility({ id: 'a', relevance: 1, useCount: 5 }, 0)
      const u20 = learnedUtility({ id: 'a', relevance: 1, useCount: 20 }, 0)
      expect(u1).toBeGreaterThan(1)
      expect(u5).toBeGreaterThan(u1)
      expect(u20).toBeGreaterThan(u5)
      // Saturates at +20% (usageCap 0.2) no matter how large useCount grows.
      expect(learnedUtility({ id: 'a', relevance: 1, useCount: 1_000_000 }, 0)).toBeCloseTo(1.2, 10)
    })

    it('honors all four custom opts and binds both caps (importance × usage)', () => {
      // impNudge = min(0.1, 1*1) = 0.1 ; useNudge = min(0.1, 1*ln(101)) = 0.1
      const u = learnedUtility(
        { id: 'a', relevance: 1, importance: 1, useCount: 100 },
        0,
        { usageWeight: 1, usageCap: 0.1, importanceWeight: 1, importanceCap: 0.1 },
      )
      expect(u).toBeCloseTo(1 * 1.1 * 1.1, 10) // 1.21
    })

    it('is monotonic in relevance (same importance/usage)', () => {
      const lo = learnedUtility({ id: 'a', relevance: 0.4, importance: 0.5, useCount: 3 }, 0)
      const hi = learnedUtility({ id: 'a', relevance: 0.6, importance: 0.5, useCount: 3 }, 0)
      expect(hi).toBeGreaterThan(lo)
    })

    it('is time-invariant — the injected clock does not change the learned terms', () => {
      const s: Scored = { id: 'a', relevance: 0.7, importance: 0.4, useCount: 9, ts: 123 }
      expect(learnedUtility(s, 0)).toBeCloseTo(learnedUtility(s, 9_000_000_000), 12)
    })

    it('clamps negative importance/usage to zero (never demotes below relevance)', () => {
      expect(learnedUtility({ id: 'a', relevance: 0.8, importance: -5, useCount: -9 }, 0)).toBeCloseTo(0.8, 10)
    })
  })

  describe('rerankByUtility — decorate-then-sort by learned utility', () => {
    it('sorts by utility desc and attaches a numeric utility field', () => {
      const hits: Scored[] = [
        { id: 'lo', relevance: 0.5 },
        { id: 'hi', relevance: 0.9 },
        { id: 'mid', relevance: 0.7, importance: 1 }, // 0.7 * 1.15 = 0.805
      ]
      const out = rerankByUtility(hits, 0)
      expect(out.map((h) => h.id)).toEqual(['hi', 'mid', 'lo'])
      expect(out.every((h) => typeof h.utility === 'number')).toBe(true)
      expect(out[0]).toMatchObject({ id: 'hi', relevance: 0.9 })
      expect(out[0].utility).toBeCloseTo(0.9, 10)
      expect(out[1].utility).toBeCloseTo(0.805, 10)
    })

    it('is stable on ties (equal utility preserves input order)', () => {
      const hits: Scored[] = [
        { id: 'a', relevance: 0.5 },
        { id: 'b', relevance: 0.5 },
        { id: 'c', relevance: 0.9 },
      ]
      expect(rerankByUtility(hits, 0).map((h) => h.id)).toEqual(['c', 'a', 'b'])
    })

    it('does not mutate the input hits', () => {
      const input: Scored[] = [{ id: 'x', relevance: 0.5 }]
      const out = rerankByUtility(input, 0)
      expect(input).toHaveLength(1)
      expect(input[0]).not.toHaveProperty('utility')
      expect(out[0]).toHaveProperty('utility')
    })

    it('threads opts through to learnedUtility (a strong importance boost flips the order)', () => {
      const hits: Scored[] = [
        { id: 'a', relevance: 0.6 },
        { id: 'b', relevance: 0.5, importance: 1 },
      ]
      // Default: a (0.6) > b (0.5*1.15=0.575).
      expect(rerankByUtility(hits, 0).map((h) => h.id)).toEqual(['a', 'b'])
      // Amplified importance: b (0.5*1.5=0.75) > a (0.6).
      expect(
        rerankByUtility(hits, 0, { importanceWeight: 1, importanceCap: 0.5 }).map((h) => h.id),
      ).toEqual(['b', 'a'])
    })

    it('returns [] for empty input', () => {
      expect(rerankByUtility([], 0)).toEqual([])
    })
  })

  describe('proactiveQuery — mine the task for salient recall signals', () => {
    it('extracts error names, backticked identifiers, file tokens and SCREAMING codes', () => {
      const q = proactiveQuery('Getting a TypeError from `parseConfig` in src/config.ts (ENOENT) again')
      expect(q).toContain('TypeError')
      expect(q).toContain('parseConfig')
      expect(q).toContain('config.ts') // substring of the captured src/config.ts token
      expect(q).toContain('ENOENT')
    })

    it('extracts multi-word error phrases', () => {
      const q = proactiveQuery('Build failed: cannot find module `react-dom` after upgrade')
      expect(q).toContain('cannot find module')
      expect(q).toContain('react-dom')
    })

    it('dedups repeated tokens and skips blank backtick spans', () => {
      // `config.ts` (backtick) + bare config.ts (file) → one token; `​ ` blank span skipped;
      // MAX_LEN appears twice → one token.
      const q = proactiveQuery('update config.ts then `config.ts` fails with ` ` and MAX_LEN plus MAX_LEN')
      expect(q).toContain('config.ts')
      expect(q).toContain('MAX_LEN')
      expect(q.split(/\s+/).filter((t) => t === 'MAX_LEN')).toHaveLength(1) // deduped
      expect(q.split(/\s+/).filter((t) => t === 'config.ts')).toHaveLength(1)
    })

    it('falls back to salient keywords when there are no structured signals', () => {
      const q = proactiveQuery('refactor the authentication login flow to be cleaner')
      expect(q).toContain('refactor')
      expect(q).toContain('authentication')
      expect(q).toContain('login')
      // stopwords ("the") and short words ("to", "be") are dropped.
      const tokens = q.split(/\s+/)
      expect(tokens).not.toContain('the')
      expect(tokens).not.toContain('to')
      expect(tokens).not.toContain('be')
    })

    it('caps the query at a compact number of signals', () => {
      const q = proactiveQuery(
        'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar',
      )
      expect(q.split(/\s+/)).toHaveLength(12) // MAX_SIGNALS
      expect(q).toContain('alpha')
      expect(q).toContain('lima') // 12th kept
      expect(q).not.toContain('mike') // 13th dropped
    })

    it('returns "" for empty, whitespace-only and too-short input', () => {
      expect(proactiveQuery('')).toBe('')
      expect(proactiveQuery('   ')).toBe('')
      expect(proactiveQuery('hi')).toBe('') // below the min-length floor
    })
  })

  describe('shouldPreSurface — high-confidence gate before pre-injecting a memory', () => {
    it('is true at/above the default 0.75 threshold and false below', () => {
      expect(shouldPreSurface(0.8)).toBe(true)
      expect(shouldPreSurface(0.75)).toBe(true) // boundary is inclusive
      expect(shouldPreSurface(0.74)).toBe(false)
      expect(shouldPreSurface(0.1)).toBe(false)
    })

    it('honors a custom threshold on both sides', () => {
      expect(shouldPreSurface(0.6, { threshold: 0.5 })).toBe(true)
      expect(shouldPreSurface(0.4, { threshold: 0.5 })).toBe(false)
    })
  })
})
