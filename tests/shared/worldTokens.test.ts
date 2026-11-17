import { describe, expect, it } from 'vitest'
import { estimateTokens, formatTokens } from '../../src/shared/world/tokens'

describe('estimateTokens', () => {
  it('is a quarter of the length, rounded up', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('x'.repeat(400))).toBe(100)
  })
})

describe('formatTokens', () => {
  it('says "about" and rounds to a readable figure', () => {
    expect(formatTokens(0)).toBe('no tokens')
    expect(formatTokens(840)).toBe('about 840 tokens')
    expect(formatTokens(839.6)).toBe('about 840 tokens')
    expect(formatTokens(1000)).toBe('about 1.0k tokens')
    expect(formatTokens(3150)).toBe('about 3.2k tokens')
    expect(formatTokens(1_250_000)).toBe('about 1.3M tokens')
  })
  it('moves up a unit when rounding would reach it', () => {
    expect(formatTokens(999)).toBe('about 999 tokens')
    expect(formatTokens(999.6)).toBe('about 1.0k tokens')
    expect(formatTokens(999_949)).toBe('about 999.9k tokens')
    expect(formatTokens(999_950)).toBe('about 1.0M tokens')
  })
  it('gives "no tokens" for negative or non-finite input', () => {
    for (const n of [-5, NaN, Infinity, -Infinity]) expect(formatTokens(n)).toBe('no tokens')
  })
})
