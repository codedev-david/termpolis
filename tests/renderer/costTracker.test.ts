import { describe, it, expect, vi } from 'vitest'
import { parseCostFromOutput, formatTokens } from '../../src/renderer/src/lib/costTracker'

describe('costTracker', () => {
  describe('parseCostFromOutput', () => {
    it('parses cost from "Total cost: $2.40" pattern', () => {
      const result = parseCostFromOutput('Total cost: $2.40')
      expect(result).not.toBeNull()
      expect(result!.estimatedCost).toBe(2.4)
    })

    it('parses token count from "45,234 tokens" pattern', () => {
      const result = parseCostFromOutput('Used 45,234 tokens in this session')
      expect(result).not.toBeNull()
      expect(result!.tokensIn).toBe(45234)
    })

    it('returns null when no cost or token info found', () => {
      expect(parseCostFromOutput('just some regular output')).toBeNull()
    })

    it('returns partial info when only cost is present', () => {
      const result = parseCostFromOutput('Cost: $1.50 for this run')
      expect(result).not.toBeNull()
      expect(result!.estimatedCost).toBe(1.5)
      expect(result!.tokensIn).toBeUndefined()
    })

    it('includes a lastUpdated timestamp', () => {
      const before = Date.now()
      const result = parseCostFromOutput('total: $0.23')
      const after = Date.now()
      expect(result).not.toBeNull()
      expect(result!.lastUpdated).toBeGreaterThanOrEqual(before)
      expect(result!.lastUpdated).toBeLessThanOrEqual(after)
    })

    it('parses both cost and tokens when both are present', () => {
      const result = parseCostFromOutput('Cost: $3.00 — 12,000 tokens used')
      expect(result).not.toBeNull()
      expect(result!.estimatedCost).toBe(3)
      expect(result!.tokensIn).toBe(12000)
    })
  })

  describe('formatTokens', () => {
    it('formats millions as "X.XM"', () => {
      expect(formatTokens(1_500_000)).toBe('1.5M')
    })

    it('formats thousands as "XK"', () => {
      expect(formatTokens(45000)).toBe('45K')
    })

    it('returns raw number string for values under 1000', () => {
      expect(formatTokens(500)).toBe('500')
    })
  })
})
