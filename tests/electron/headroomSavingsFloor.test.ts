import { describe, it, expect } from 'vitest'
import { resolveWireMode, FLOOR_MIN_REQUESTS, FLOOR_MISS_TOLERANCE } from '../../src/main/headroom/savingsFloor'
import { FLOOR_PCT } from '../../src/main/headroomProxy/proxyLedger'
import { thresholdsFor } from '../../src/main/headroom/config'

const ev = (savedPct: number, below: number, eligible: number) =>
  ({ savedPct, belowFloorRequests: below, floorEligibleRequests: eligible })

const HEALTHY = FLOOR_MIN_REQUESTS * 4

describe('savings-floor controller', () => {
  it('leaves the configured mode alone until there is enough measured history', () => {
    // Acting on four requests would let one unlucky session re-tier the whole app.
    expect(resolveWireMode('balanced', ev(10, 4, FLOOR_MIN_REQUESTS - 1))).toBe('balanced')
  })

  it('stands pat when the floor is genuinely being held', () => {
    expect(resolveWireMode('aggressive', ev(FLOOR_PCT + 8, 2, HEALTHY))).toBe('aggressive')
  })

  it('escalates one notch when the floor slips marginally', () => {
    // Just under on the average, tail still mostly fine → nudge, do not overreact.
    expect(resolveWireMode('balanced', ev(FLOOR_PCT - 3, 0, HEALTHY))).toBe('aggressive')
  })

  it('goes straight to max when the shortfall is systemic', () => {
    expect(resolveWireMode('conservative', ev(20, HEALTHY, HEALTHY))).toBe('max')
  })

  it('escalates on a bad TAIL even when the average looks healthy', () => {
    // A lifetime average of 62% is entirely compatible with a third of requests under 50%. The
    // promise is a floor, so the tail is what decides it — this is the case an average hides.
    const below = Math.round(HEALTHY * 0.35)
    expect(below / HEALTHY).toBeGreaterThan(FLOOR_MISS_TOLERANCE)
    expect(resolveWireMode('balanced', ev(FLOOR_PCT + 12, below, HEALTHY))).toBe('aggressive')
  })

  it('escalates on a bad AVERAGE even when the tail looks healthy', () => {
    // The mirror case: few requests miss, but the ones carrying the bulk are barely compressing.
    expect(resolveWireMode('balanced', ev(FLOOR_PCT - 2, 0, HEALTHY))).toBe('aggressive')
  })

  it('NEVER weakens compression below what the user chose', () => {
    // The configured mode is a lower bound. A controller bug must not be able to silently give
    // back savings the user explicitly asked for.
    for (const pct of [0, 25, 50, 75, 100]) {
      for (const below of [0, HEALTHY / 2, HEALTHY]) {
        const out = resolveWireMode('aggressive', ev(pct, below, HEALTHY))
        expect(['aggressive', 'max']).toContain(out)
      }
    }
  })

  it('cannot climb past the top of the ladder', () => {
    expect(resolveWireMode('max', ev(0, HEALTHY, HEALTHY))).toBe('max')
    expect(resolveWireMode('max', ev(99, 0, HEALTHY))).toBe('max')
  })

  it('returns an unknown mode untouched rather than guessing', () => {
    expect(resolveWireMode('sideways' as never, ev(0, HEALTHY, HEALTHY))).toBe('sideways')
  })

  it('ignores garbled evidence instead of re-tiering on NaN', () => {
    for (const bad of [{ savedPct: NaN, belowFloorRequests: 1, floorEligibleRequests: HEALTHY },
      { savedPct: 10, belowFloorRequests: NaN, floorEligibleRequests: HEALTHY },
      { savedPct: 10, belowFloorRequests: 1, floorEligibleRequests: Infinity }]) {
      expect(resolveWireMode('balanced', bad)).toBe('balanced')
    }
  })
})

describe('the max tier it escalates into', () => {
  it('compresses strictly harder than aggressive on every knob', () => {
    // If any threshold went the wrong way, escalating would REDUCE savings — the controller would
    // be actively counterproductive and nothing else here would notice.
    const a = thresholdsFor('aggressive')
    const m = thresholdsFor('max')
    expect(m.floorTokens).toBeLessThan(a.floorTokens)
    expect(m.topK).toBeLessThan(a.topK)
    expect(m.maxFieldChars).toBeLessThan(a.maxFieldChars)
    expect(m.headLines).toBeLessThan(a.headLines)
    expect(m.tailLines).toBeLessThan(a.tailLines)
  })

  it('keeps enough head and tail to stay useful', () => {
    const m = thresholdsFor('max')
    expect(m.headLines).toBeGreaterThanOrEqual(5)
    expect(m.tailLines).toBeGreaterThanOrEqual(3)
  })
})
