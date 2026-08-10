import { describe, it, expect } from 'vitest'
const { adaptSteeringMode, ADAPTIVE_MIN_REQUESTS, ADAPTIVE_HIGH, ADAPTIVE_LOW } =
  await import('../../src/main/headroom/outputSteering')

/** avg = outputTokens / requests, so build the pair the caller actually passes. */
const at = (avg: number, requests = ADAPTIVE_MIN_REQUESTS): [number, number] => [avg * requests, requests]

/**
 * The directive rides in the launch system prompt, which is re-sent every turn — so the mode is
 * chosen ONCE, at launch, from the lifetime average. Re-deciding per turn would rewrite the
 * system prompt and invalidate the cached prefix, costing far more than the steering saves.
 */
describe('adaptSteeringMode', () => {
  it('steps UP a rung when output runs heavy', () => {
    expect(adaptSteeringMode('conservative', ...at(ADAPTIVE_HIGH))).toBe('balanced')
    expect(adaptSteeringMode('balanced', ...at(ADAPTIVE_HIGH + 500))).toBe('aggressive')
  })

  it('steps DOWN a rung when output is already lean — steering has a cost too', () => {
    expect(adaptSteeringMode('aggressive', ...at(ADAPTIVE_LOW))).toBe('balanced')
    expect(adaptSteeringMode('balanced', ...at(ADAPTIVE_LOW - 200))).toBe('conservative')
  })

  it('holds inside the band', () => {
    const mid = (ADAPTIVE_HIGH + ADAPTIVE_LOW) / 2
    expect(adaptSteeringMode('balanced', ...at(mid))).toBe('balanced')
    expect(adaptSteeringMode('aggressive', ...at(mid))).toBe('aggressive')
    expect(adaptSteeringMode('conservative', ...at(mid))).toBe('conservative')
  })

  it('never runs off the ends of the ladder', () => {
    // 'max' is the top rung as of v1.34 — 'aggressive' is no longer the ceiling.
    expect(adaptSteeringMode('max', ...at(ADAPTIVE_HIGH + 5000))).toBe('max')
    expect(adaptSteeringMode('conservative', ...at(0))).toBe('conservative')
  })

  it('will not override an explicit setting on too little history', () => {
    expect(adaptSteeringMode('balanced', ...at(ADAPTIVE_HIGH, ADAPTIVE_MIN_REQUESTS - 1))).toBe('balanced')
    expect(adaptSteeringMode('balanced', 0, 0)).toBe('balanced') // first launch, no ledger at all
  })

  it('holds on a garbled ledger rather than guessing', () => {
    expect(adaptSteeringMode('balanced', NaN, 100)).toBe('balanced')
    expect(adaptSteeringMode('balanced', 1_000_000, Infinity)).toBe('balanced')
    expect(adaptSteeringMode('nonsense' as never, ...at(ADAPTIVE_HIGH))).toBe('nonsense')
  })

  it('is a no-op for a heavy-tool-use profile already on aggressive (measured: ~1,241 avg)', () => {
    // Worth stating plainly: at David's real numbers this feature changes nothing. It matters for
    // users left on balanced/conservative whose output actually runs hot.
    expect(adaptSteeringMode('aggressive', 77_852_303, 62_716)).toBe('aggressive')
  })
})

describe('adaptive steering knows about the max tier', () => {
  it('can tighten INTO max instead of treating it as an unknown mode', () => {
    // indexOf('max') used to be -1, so a max-tier session skipped adaptation entirely.
    expect(adaptSteeringMode('aggressive', 3000 * 100, 100)).toBe('max')
  })

  it('has nowhere further to climb from max, and relaxes back down normally', () => {
    expect(adaptSteeringMode('max', 3000 * 100, 100)).toBe('max')
    expect(adaptSteeringMode('max', 100 * 100, 100)).toBe('aggressive')
  })
})
