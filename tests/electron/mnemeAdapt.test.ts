import { describe, it, expect } from 'vitest'
import { cosineSim, interestCentroid, tasteBoost } from '../../src/main/mnemeAdapt'

describe('mnemeAdapt — training-free embedding adaptation (taste vector)', () => {
  describe('cosineSim', () => {
    it('is 1 for identical, 0 for orthogonal, -1 for opposite', () => {
      expect(cosineSim([1, 0], [1, 0])).toBeCloseTo(1)
      expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0)
      expect(cosineSim([1, 0], [-1, 0])).toBeCloseTo(-1)
    })
    it('is 0 when either vector is zero', () => {
      expect(cosineSim([0, 0], [1, 1])).toBe(0)
    })
  })

  describe('interestCentroid', () => {
    it('returns null with no vectors', () => {
      expect(interestCentroid([])).toBeNull()
    })
    it('returns the L2-normalized mean of the reinforced vectors', () => {
      const c = interestCentroid([[2, 0], [0, 0]]) // mean [1,0] → normalized [1,0]
      expect(c).not.toBeNull()
      expect(cosineSim(c as number[], [1, 0])).toBeCloseTo(1)
      // unit length
      const len = Math.sqrt((c as number[]).reduce((a, x) => a + x * x, 0))
      expect(len).toBeCloseTo(1)
    })
    it('ignores empty rows and returns null if everything cancels to zero', () => {
      expect(interestCentroid([[1, 0], [-1, 0]])).toBeNull()
    })
  })

  describe('tasteBoost', () => {
    it('does not boost for non-positive cosine (off-taste hits are untouched)', () => {
      expect(tasteBoost(0.8, 0)).toBeCloseTo(0.8)
      expect(tasteBoost(0.8, -0.5)).toBeCloseTo(0.8)
    })
    it('applies a small capped positive boost for on-taste hits', () => {
      const boosted = tasteBoost(0.8, 1, { weight: 0.15, cap: 0.1 })
      expect(boosted).toBeGreaterThan(0.8)
      expect(boosted).toBeLessThanOrEqual(0.8 * 1.1 + 1e-9) // capped at +10%
    })
    it('keeps a zero-relevance hit at zero (honors the relevance gate)', () => {
      expect(tasteBoost(0, 1)).toBe(0)
    })
    it('is monotonic in cosine up to the cap', () => {
      expect(tasteBoost(1, 0.2)).toBeLessThan(tasteBoost(1, 0.5))
    })
  })
})
