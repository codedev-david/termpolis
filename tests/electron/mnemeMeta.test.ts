import { describe, it, expect } from 'vitest'
import {
  confidenceScore,
  updateCompetence,
  assessDomain,
  summarizeCompetence,
  type CompetenceRecord,
} from '../../src/main/mnemeMeta'

// Build a CompetenceRecord with an explicitly-set confidence — the verdict/summary
// functions read the stored `confidence` field and are agnostic to how it was
// derived, so setting it directly keeps those tests independent of the Wilson math.
const rec = (
  domain: string,
  confidence: number,
  attempts: number,
  successes = Math.round(confidence * attempts),
): CompetenceRecord => ({ domain, confidence, attempts, successes, lastTs: 0 })

describe('mnemeMeta — metacognition / self-competence', () => {
  describe('confidenceScore — Wilson lower bound (~95%, z=1.96)', () => {
    it('is 0 when there are no attempts (and guards div-by-zero)', () => {
      expect(confidenceScore(0, 0)).toBe(0)
      expect(confidenceScore(5, 0)).toBe(0) // nonsensical input still short-circuits to 0
      expect(confidenceScore(1, -2)).toBe(0) // defensive: non-positive attempts → 0
    })

    it('is 0 for all failures (phat = 0), for any attempt count', () => {
      expect(confidenceScore(0, 4)).toBeCloseTo(0, 12)
      expect(confidenceScore(0, 25)).toBeCloseTo(0, 12)
    })

    it('is >0 but strictly <1 for all successes — never claims certainty', () => {
      const c1 = confidenceScore(1, 1)
      const c3 = confidenceScore(3, 3)
      const c10 = confidenceScore(10, 10)
      expect(c1).toBeGreaterThan(0)
      expect(c1).toBeLessThan(1)
      expect(c1).toBeCloseTo(1 / (1 + 1.96 * 1.96), 6) // 1/1 → ~0.2065
      expect(c3).toBeGreaterThan(c1) // more clean evidence → higher bound
      expect(c10).toBeGreaterThan(c3)
      expect(c10).toBeLessThan(1)
    })

    it('matches the hand-computed Wilson lower bound for a mixed record (1/4)', () => {
      expect(confidenceScore(1, 4)).toBeCloseTo(0.0456, 3)
    })

    it('is monotonic in successes at a fixed attempt count', () => {
      expect(confidenceScore(2, 4)).toBeGreaterThan(confidenceScore(1, 4))
      expect(confidenceScore(3, 4)).toBeGreaterThan(confidenceScore(2, 4))
      expect(confidenceScore(4, 4)).toBeGreaterThan(confidenceScore(3, 4))
    })

    it('rewards more evidence at the same success rate (a tighter lower bound)', () => {
      // identical 50% rate, growing evidence → strictly rising lower bound
      expect(confidenceScore(5, 10)).toBeGreaterThan(confidenceScore(1, 2))
      expect(confidenceScore(50, 100)).toBeGreaterThan(confidenceScore(5, 10))
    })

    it('stays within [0,1] and is bit-for-bit deterministic', () => {
      const cases: Array<[number, number]> = [[0, 1], [1, 3], [7, 9], [10, 10], [3, 8], [1, 4]]
      for (const [s, a] of cases) {
        const c = confidenceScore(s, a)
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(1)
        expect(confidenceScore(s, a)).toBe(c) // same inputs → identical result
      }
    })
  })

  describe('updateCompetence — fold one outcome (immutable)', () => {
    it('creates a fresh record from undefined on a first SUCCESS', () => {
      expect(updateCompetence(undefined, 'rust', true, 10)).toEqual({
        domain: 'rust',
        attempts: 1,
        successes: 1,
        lastTs: 10,
        confidence: confidenceScore(1, 1),
      })
    })

    it('creates a fresh record from undefined on a first FAILURE', () => {
      expect(updateCompetence(undefined, 'rust', false, 10)).toEqual({
        domain: 'rust',
        attempts: 1,
        successes: 0,
        lastTs: 10,
        confidence: confidenceScore(0, 1), // 0
      })
    })

    it('folds a SUCCESS onto an existing record and recomputes confidence', () => {
      const prev = rec('ts', confidenceScore(1, 2), 2, 1)
      const next = updateCompetence(prev, 'ts', true, 200)
      expect(next.attempts).toBe(3)
      expect(next.successes).toBe(2)
      expect(next.lastTs).toBe(200)
      expect(next.confidence).toBeCloseTo(confidenceScore(2, 3), 12)
    })

    it('folds a FAILURE onto an existing record (successes unchanged)', () => {
      const prev = updateCompetence(undefined, 'go', true, 1) // 1/1
      const next = updateCompetence(prev, 'go', false, 2) // → 1/2
      expect(next.attempts).toBe(2)
      expect(next.successes).toBe(1)
      expect(next.lastTs).toBe(2)
      expect(next.confidence).toBeCloseTo(confidenceScore(1, 2), 12)
    })

    it('does not mutate the previous record (append-only discipline)', () => {
      const prev = updateCompetence(undefined, 'py', true, 1)
      const snapshot = { ...prev }
      updateCompetence(prev, 'py', false, 2)
      expect(prev).toEqual(snapshot)
    })

    it('uses the injected `now` as lastTs (never a wall clock)', () => {
      expect(updateCompetence(undefined, 'x', true, 123456789).lastTs).toBe(123456789)
    })
  })

  describe('assessDomain — verdict on how well-founded a domain is', () => {
    it('returns unknown/zero for a domain with no record', () => {
      expect(assessDomain([], 'rust')).toEqual({
        known: false,
        confidence: 0,
        attempts: 0,
        verdict: 'unproven',
      })
      // present-but-different domain still misses
      expect(assessDomain([rec('go', 0.9, 10)], 'rust')).toEqual({
        known: false,
        confidence: 0,
        attempts: 0,
        verdict: 'unproven',
      })
    })

    it('is CONFIDENT with a high bound and enough attempts', () => {
      expect(assessDomain([rec('ts', 0.8, 5)], 'ts')).toEqual({
        known: true,
        confidence: 0.8,
        attempts: 5,
        verdict: 'confident',
      })
    })

    it('is CONFIDENT exactly at the boundary (confidence 0.7, attempts 3 — both inclusive)', () => {
      expect(assessDomain([rec('ts', 0.7, 3)], 'ts').verdict).toBe('confident')
    })

    it('is CAUTION with enough attempts but a low bound (<0.5)', () => {
      expect(assessDomain([rec('rust', 0.2, 5)], 'rust')).toMatchObject({
        known: true,
        verdict: 'caution',
      })
    })

    it('is UNPROVEN with too few attempts, even at high confidence', () => {
      // confidence≥0.7 is true but attempts<3 fails the first clause; attempts<3
      // also fails the caution clause → unproven.
      expect(assessDomain([rec('go', 0.9, 2)], 'go').verdict).toBe('unproven')
    })

    it('is UNPROVEN in the middling band (0.5 ≤ confidence < 0.7) with enough attempts', () => {
      expect(assessDomain([rec('sql', 0.6, 5)], 'sql').verdict).toBe('unproven')
      // 0.5 is NOT caution (strict <0.5) and NOT confident (<0.7) → unproven boundary
      expect(assessDomain([rec('sql', 0.5, 5)], 'sql').verdict).toBe('unproven')
    })

    it('finds the right record when several domains are present', () => {
      const records = [rec('a', 0.1, 4), rec('b', 0.85, 9), rec('c', 0.6, 5)]
      expect(assessDomain(records, 'b').verdict).toBe('confident')
      expect(assessDomain(records, 'a').verdict).toBe('caution')
      expect(assessDomain(records, 'c').verdict).toBe('unproven')
    })
  })

  describe('summarizeCompetence — weakest-first primer digest', () => {
    it('returns "" for empty input', () => {
      expect(summarizeCompetence([])).toBe('')
    })

    it('returns "" when every domain is already competent (nothing to warn about)', () => {
      expect(summarizeCompetence([rec('ts', 0.85, 22, 20), rec('go', 0.72, 12, 11)])).toBe('')
    })

    it('formats one warning line per weak domain', () => {
      expect(summarizeCompetence([rec('rust', 0.05, 4, 1)])).toBe(
        '⚠ low competence in rust (1/4 succeeded)',
      )
    })

    it('orders weakest first: confidence ascending, then attempts descending on a tie', () => {
      const out = summarizeCompetence([
        rec('sql', 0.3, 4, 1), // same confidence as docker, fewer attempts → later
        rec('rust', 0.1, 2, 0), // lowest confidence → first
        rec('docker', 0.3, 8, 2), // tie on confidence, more attempts → before sql
      ])
      expect(out.split('\n')).toEqual([
        '⚠ low competence in rust (0/2 succeeded)',
        '⚠ low competence in docker (2/8 succeeded)',
        '⚠ low competence in sql (1/4 succeeded)',
      ])
    })

    it('excludes competent domains (confidence ≥ 0.5) from the list', () => {
      const out = summarizeCompetence([
        rec('typescript', 0.9, 22, 20), // strong → excluded
        rec('rust', 0.1, 4, 0), // weak → kept
      ])
      expect(out).toBe('⚠ low competence in rust (0/4 succeeded)')
    })

    it('respects a custom limit, keeping the WEAKEST domains', () => {
      const out = summarizeCompetence(
        [rec('a', 0.1, 3, 0), rec('b', 0.2, 3, 1), rec('c', 0.3, 3, 1), rec('d', 0.4, 3, 1)],
        2,
      )
      expect(out.split('\n')).toEqual([
        '⚠ low competence in a (0/3 succeeded)',
        '⚠ low competence in b (1/3 succeeded)',
      ])
    })

    it('defaults the limit to 3', () => {
      const out = summarizeCompetence([
        rec('a', 0.1, 3, 0),
        rec('b', 0.2, 3, 1),
        rec('c', 0.3, 3, 1),
        rec('d', 0.4, 3, 1),
      ])
      expect(out.split('\n')).toHaveLength(3)
      expect(out).not.toContain('in d')
    })

    it('coerces a non-positive limit to an empty digest', () => {
      expect(summarizeCompetence([rec('a', 0.1, 3, 0)], 0)).toBe('')
      expect(summarizeCompetence([rec('a', 0.1, 3, 0)], -5)).toBe('')
    })

    it('does not mutate the input array', () => {
      const records = [rec('b', 0.4, 3, 1), rec('a', 0.1, 3, 0)]
      const order = records.map((r) => r.domain)
      summarizeCompetence(records)
      expect(records.map((r) => r.domain)).toEqual(order)
    })
  })

  describe('integration — folds compose into assessments', () => {
    it('a success streak folds up to a CONFIDENT assessment', () => {
      let r: CompetenceRecord | undefined
      for (let i = 0; i < 12; i++) r = updateCompetence(r, 'ts', true, i)
      expect(r!.attempts).toBe(12)
      expect(r!.successes).toBe(12)
      expect(r!.confidence).toBeGreaterThanOrEqual(0.7)
      expect(assessDomain([r!], 'ts').verdict).toBe('confident')
    })

    it('a failure streak folds down to a CAUTION assessment and surfaces in the digest', () => {
      let r: CompetenceRecord | undefined
      for (let i = 0; i < 5; i++) r = updateCompetence(r, 'rust', false, i)
      expect(r!.confidence).toBe(0)
      expect(assessDomain([r!], 'rust').verdict).toBe('caution')
      expect(summarizeCompetence([r!])).toBe('⚠ low competence in rust (0/5 succeeded)')
    })
  })
})
