import { describe, it, expect } from 'vitest'
import {
  billBreakdown, dominantBucket,
  W_CACHE_READ, W_CACHE_WRITE, W_INPUT, W_OUTPUT,
} from '../../src/main/headroom/effectiveUnits'

/** The prefix-token counts published in the compression spec, section 1.3. Every derived constant
 *  in that section is reproduced below, so if the arithmetic here ever drifts from the document
 *  the test says so instead of the document quietly becoming fiction. */
const SPEC_CACHE_READ_TOKENS = 8_674_996_827
const SPEC_CACHE_CREATE_TOKENS = 263_359_832
const SPEC_SAVED_TOKENS = 1_241_456_203

describe('effective-unit accounting', () => {
  it('prices each bucket at its published multiplier', () => {
    const b = billBreakdown(
      { cacheReadTokens: 1000, cacheCreationTokens: 1000, inputTokens: 1000, outputTokens: 1000 },
      0,
    )
    expect(b.cacheRead).toBe(1000 * W_CACHE_READ)
    expect(b.cacheCreation).toBe(1000 * W_CACHE_WRITE)
    expect(b.input).toBe(1000 * W_INPUT)
    expect(b.output).toBe(1000 * W_OUTPUT)
    expect(b.total).toBe(100 + 1250 + 1000 + 5000)
  })

  it('reports shares that sum to the whole', () => {
    const b = billBreakdown(
      { cacheReadTokens: 8_674_996_827, cacheCreationTokens: 263_359_832, inputTokens: 9_970_180, outputTokens: 120_203_432 },
      0,
    )
    const sum = b.cacheReadPct + b.cacheCreationPct + b.inputPct + b.outputPct
    expect(sum).toBeGreaterThan(99.5)
    expect(sum).toBeLessThan(100.5)
  })

  it('reproduces the blended prefix-token weight from spec section 1.3', () => {
    const b = billBreakdown(
      { cacheReadTokens: SPEC_CACHE_READ_TOKENS, cacheCreationTokens: SPEC_CACHE_CREATE_TOKENS, inputTokens: 0, outputTokens: 0 },
      0,
    )
    // The spec first published 0.133891; recomputing exactly gives 0.1338836. The doc has been
    // corrected to match — the difference moves `avoided` by ~9k units out of 166M, but a
    // constant the whole savings story is built on should be the value, not a value near it.
    expect(b.prefixTokenWeight).toBeCloseTo(0.1338836, 7)
  })

  it('reproduces the avoided-units figure from spec section 1.5', () => {
    const b = billBreakdown(
      { cacheReadTokens: SPEC_CACHE_READ_TOKENS, cacheCreationTokens: SPEC_CACHE_CREATE_TOKENS, inputTokens: 0, outputTokens: 0 },
      SPEC_SAVED_TOKENS,
    )
    // 1,241,456,203 x 0.133891 = 166,219,812, to within rounding of the published weight.
    expect(b.avoided).toBeGreaterThan(166_100_000)
    expect(b.avoided).toBeLessThan(166_350_000)
  })

  it('measures savings against the counterfactual bill, not against the compressible slice', () => {
    // 100k output tokens (500k units) with a modest prefix. Saving 10k prefix tokens is a large
    // share of the text touched and a small share of the invoice — that gap is the whole point.
    const b = billBreakdown(
      { cacheReadTokens: 100_000, cacheCreationTokens: 0, inputTokens: 0, outputTokens: 100_000 },
      10_000,
    )
    expect(b.total).toBe(10_000 + 500_000)
    expect(b.avoided).toBe(1_000) // 10k tokens x 0.1 — they were all cache reads
    expect(b.totalBillSavedPct).toBeCloseTo(0.2, 1)
  })

  it('falls back to fresh-input pricing when no cache activity has been observed', () => {
    const b = billBreakdown(
      { cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 5_000, outputTokens: 0 },
      1_000,
    )
    expect(b.prefixTokenWeight).toBe(W_INPUT)
    expect(b.avoided).toBe(1_000)
  })

  it('reports a negative saving rather than clamping when giveback outruns compression', () => {
    const b = billBreakdown(
      { cacheReadTokens: 1_000_000, cacheCreationTokens: 0, inputTokens: 0, outputTokens: 0 },
      -50_000,
    )
    expect(b.avoided).toBeLessThan(0)
    expect(b.totalBillSavedPct).toBeLessThan(0)
  })

  it('is all zeros, never NaN, on an untouched ledger', () => {
    const b = billBreakdown({ cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0, outputTokens: 0 }, 0)
    for (const v of Object.values(b)) expect(Number.isNaN(v)).toBe(false)
    expect(b.total).toBe(0)
    expect(b.totalBillSavedPct).toBe(0)
    expect(b.cacheReadPct).toBe(0)
  })

  it('names the bucket that actually dominates', () => {
    const heavyOutput = billBreakdown({ cacheReadTokens: 1000, cacheCreationTokens: 0, inputTokens: 0, outputTokens: 1000 }, 0)
    expect(dominantBucket(heavyOutput)).toBe('output')
    // The real Termpolis mix: cache reads win despite the 0.1x multiplier, purely on volume.
    const real = billBreakdown(
      { cacheReadTokens: 8_674_996_827, cacheCreationTokens: 263_359_832, inputTokens: 9_970_180, outputTokens: 120_203_432 },
      0,
    )
    expect(dominantBucket(real)).toBe('cacheRead')
    const heavyCreate = billBreakdown({ cacheReadTokens: 0, cacheCreationTokens: 1000, inputTokens: 100, outputTokens: 0 }, 0)
    expect(dominantBucket(heavyCreate)).toBe('cacheCreation')
    const heavyInput = billBreakdown({ cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 100, outputTokens: 0 }, 0)
    expect(dominantBucket(heavyInput)).toBe('input')
  })
})
