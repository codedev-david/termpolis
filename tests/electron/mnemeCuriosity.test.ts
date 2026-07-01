import { describe, it, expect } from 'vitest'
import { findGaps, curiosityPrompts, type Gap } from '../../src/main/mnemeCuriosity'
import type { CompetenceRecord } from '../../src/main/mnemeMeta'

// Build a CompetenceRecord with an explicit confidence — findGaps reads the stored
// `confidence`/`attempts` fields directly and is agnostic to how they were derived,
// so setting them keeps these tests independent of the Wilson math.
const rec = (
  domain: string,
  confidence: number,
  attempts: number,
  successes = Math.round(confidence * attempts),
): CompetenceRecord => ({ domain, confidence, attempts, successes, lastTs: 0 })

// Build a Gap directly for the prompt tests.
const gap = (domain: string, confidence: number, attempts: number): Gap => ({
  domain,
  confidence,
  attempts,
  priority: attempts * (1 - confidence),
})

describe('mnemeCuriosity — curiosity / knowledge-gap agenda', () => {
  describe('findGaps — rank frequent-and-weak domains', () => {
    it('returns [] for empty input', () => {
      expect(findGaps([])).toEqual([])
    })

    it('keeps only domains at or below the max confidence (default 0.5)', () => {
      const out = findGaps([
        rec('weak', 0.2, 4),
        rec('strong', 0.9, 4), // competent → excluded
      ])
      expect(out.map((g) => g.domain)).toEqual(['weak'])
    })

    it('includes the confidence boundary (≤ 0.5 is a gap, > 0.5 is not)', () => {
      const out = findGaps([
        rec('edge', 0.5, 3), // exactly at the ceiling → kept
        rec('over', 0.500001, 3), // just above → dropped
      ])
      expect(out.map((g) => g.domain)).toEqual(['edge'])
    })

    it('drops domains with too little evidence (default minAttempts 2)', () => {
      const out = findGaps([
        rec('thin', 0.1, 1), // one attempt → excluded
        rec('seen', 0.1, 2), // exactly at the floor → kept
      ])
      expect(out.map((g) => g.domain)).toEqual(['seen'])
    })

    it('honours custom minAttempts / maxConfidence options', () => {
      const records = [rec('a', 0.4, 3), rec('b', 0.65, 6), rec('c', 0.3, 1)]
      // raise the confidence ceiling to 0.7 and require ≥2 attempts
      const out = findGaps(records, { minAttempts: 2, maxConfidence: 0.7 })
      // a (0.4/3) and b (0.65/6) qualify; c has only 1 attempt → dropped
      expect(out.map((g) => g.domain).sort()).toEqual(['a', 'b'])
    })

    it('computes priority = attempts × (1 - confidence)', () => {
      const [g] = findGaps([rec('deploy', 0.25, 8)])
      expect(g.priority).toBeCloseTo(8 * 0.75, 12)
      expect(g).toMatchObject({ domain: 'deploy', confidence: 0.25, attempts: 8 })
    })

    it('sorts by priority descending — frequent + weak first', () => {
      const out = findGaps([
        rec('rare', 0, 2), // priority 2*(1) = 2
        rec('common', 0.1, 5), // priority 5*0.9 = 4.5
        rec('mid', 0.4, 4), // priority 4*0.6 = 2.4
      ])
      expect(out.map((g) => g.domain)).toEqual(['common', 'mid', 'rare'])
    })

    it('breaks priority ties by attempts descending', () => {
      // both priority 2: x = 4*(1-0.5)=2, y = 2*(1-0)=2 → more attempts (x) first
      const out = findGaps([rec('y', 0, 2), rec('x', 0.5, 4)])
      expect(out.map((g) => g.domain)).toEqual(['x', 'y'])
    })

    it('does not mutate the input array', () => {
      const records = [rec('b', 0.1, 5), rec('a', 0.4, 2)]
      const order = records.map((r) => r.domain)
      findGaps(records)
      expect(records.map((r) => r.domain)).toEqual(order)
    })
  })

  describe('curiosityPrompts — primer-ready exploration prompts', () => {
    it('returns [] for no gaps', () => {
      expect(curiosityPrompts([])).toEqual([])
    })

    it('formats one prompt per gap with the domain and 2-decimal confidence', () => {
      // 0.128 renders to "0.13" — proves confidence is rounded to two decimals
      expect(curiosityPrompts([gap('deploy', 0.128, 8)])).toEqual([
        'Investigate the recurring failures in "deploy" (confidence 0.13)',
      ])
    })

    it('renders a zero-confidence gap cleanly', () => {
      expect(curiosityPrompts([gap('rust', 0, 5)])).toEqual([
        'Investigate the recurring failures in "rust" (confidence 0.00)',
      ])
    })

    it('preserves the order it is given (already priority-ranked by findGaps)', () => {
      const out = curiosityPrompts([gap('a', 0.1, 5), gap('b', 0.2, 3)])
      expect(out[0]).toContain('"a"')
      expect(out[1]).toContain('"b"')
    })

    it('caps at the limit (default 3)', () => {
      const gaps = [gap('a', 0.1, 5), gap('b', 0.1, 4), gap('c', 0.1, 3), gap('d', 0.1, 2)]
      expect(curiosityPrompts(gaps)).toHaveLength(3)
      expect(curiosityPrompts(gaps).join('\n')).not.toContain('"d"')
    })

    it('respects a custom limit', () => {
      const gaps = [gap('a', 0.1, 5), gap('b', 0.1, 4), gap('c', 0.1, 3)]
      expect(curiosityPrompts(gaps, 1)).toEqual([
        'Investigate the recurring failures in "a" (confidence 0.10)',
      ])
    })

    it('coerces a non-positive limit to no prompts', () => {
      expect(curiosityPrompts([gap('a', 0.1, 5)], 0)).toEqual([])
      expect(curiosityPrompts([gap('a', 0.1, 5)], -3)).toEqual([])
    })
  })

  describe('integration — gaps flow into prompts', () => {
    it('ranks then narrates the weakest domains', () => {
      const prompts = curiosityPrompts(
        findGaps([rec('flaky', 0.05, 6), rec('solid', 0.95, 6), rec('slow', 0.3, 3)]),
      )
      // solid is competent (excluded); flaky (priority 5.7) outranks slow (2.1)
      expect(prompts).toEqual([
        'Investigate the recurring failures in "flaky" (confidence 0.05)',
        'Investigate the recurring failures in "slow" (confidence 0.30)',
      ])
    })
  })
})
