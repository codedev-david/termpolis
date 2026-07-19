import { describe, it, expect, beforeEach } from 'vitest'
const { ccrStash, ccrRetrieve, resetCcr, CCR_MAX_ENTRIES } =
  await import('../../src/main/headroom/ccrStore')

describe('ccr store', () => {
  beforeEach(() => resetCcr())

  it('round-trips a value byte-identically', () => {
    const original = { hits: [{ name: 'foo', file: 'a.ts' }], n: 100 }
    const token = ccrStash(original)
    expect(typeof token).toBe('string')
    expect(ccrRetrieve(token)).toEqual(original)
  })

  it('returns undefined for an unknown token', () => {
    expect(ccrRetrieve('hr_nope')).toBeUndefined()
  })

  it('issues distinct tokens', () => {
    expect(ccrStash(1)).not.toBe(ccrStash(2))
  })

  it('evicts the oldest entry past the cap (LRU)', () => {
    const first = ccrStash('first')
    for (let i = 0; i < CCR_MAX_ENTRIES; i++) ccrStash(`fill-${i}`)
    expect(ccrRetrieve(first)).toBeUndefined() // evicted
  })
})
