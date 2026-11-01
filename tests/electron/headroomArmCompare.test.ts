import { describe, it, expect } from 'vitest'
import { compareArms, tCritical, MIN_ARM_REQUESTS, MIN_ARM_GROUPS } from '../../src/main/headroom/armCompare'
import { ARM_CLUSTERS } from '../../src/main/headroom/elisionPolicy'
import type { ArmCounts, ArmState } from '../../src/main/headroom/armLedger'

/**
 * The comparison of the two first-sight arms. The numbers in the cases below are worked out by hand
 * from the estimator written in armCompare.ts, so a change to the maths cannot pass by agreeing
 * with itself:
 *
 *   cost per unit of work   R = (sum of units) / (sum of working requests), over the groups
 *   its standard error      se(R) = sqrt( n/(n-1) x sum_g (u_g - R w_g)^2 ) / (sum of w)
 *   late against holdout    rel = R_late / R_holdout - 1
 *                           se(rel)^2 = (se_late / R_h)^2 + (R_late x se_h / R_h^2)^2
 *   a clear difference      |rel| > t(df) x se(rel), with df = min(groups of the two arms) - 1
 */

const zero = (): ArmCounts => ({ requests: 0, work: 0, units: 0, turns: 0, turnUnits: 0 })
const state = (late: Array<Partial<ArmCounts>>, holdout: Array<Partial<ArmCounts>>, legacy: Partial<ArmCounts> = {}): ArmState => {
  const pad = (g: Array<Partial<ArmCounts>>): ArmCounts[] => Array.from({ length: ARM_CLUSTERS }, (_, i) => ({ ...zero(), ...(g[i] ?? {}) }))
  return { late: pad(late), holdout: pad(holdout), legacy: { ...zero(), ...legacy } }
}
/** `n` groups of 100 requests, all working, costing `mean` units each, alternating by +/- `dev`. */
const groups = (n: number, mean: number, dev: number, extra: Partial<ArmCounts> = {}): Array<Partial<ArmCounts>> =>
  Array.from({ length: n }, (_, i) => ({ requests: 100, work: 100, units: 100 * mean + (i % 2 === 0 ? 1 : -1) * 100 * dev, ...extra }))

describe('the comparison of the arms', () => {
  it('has nothing to say about an empty ledger, and does not divide by zero saying it', () => {
    const c = compareArms(state([], []))
    expect(c.verdict).toBe('not-enough-data')
    expect(c.late).toMatchObject({ requests: 0, working: 0, turns: 0, groups: 0, sharePct: null, unitsPerRequest: null, unitsPerWorking: null })
    expect(c.costDeltaPct).toBeNull()
    expect(c.costMarginPct).toBeNull()
    expect(c.turnVerdict).toBeNull()
    expect(c.minRequests).toBe(MIN_ARM_REQUESTS)
    expect(MIN_ARM_REQUESTS).toBe(500)
  })

  it('reads a ledger it was not given, or a damaged one, as empty', () => {
    for (const bad of [undefined, null, 5, 'x', {}, { late: 5, holdout: [], legacy: null }]) {
      expect(() => compareArms(bad as never)).not.toThrow()
      expect(compareArms(bad as never).verdict).toBe('not-enough-data')
    }
  })

  it('summarises an arm: requests, working requests, retrieval turns and what they cost', () => {
    const c = compareArms(state(
      [{ requests: 100, work: 80, units: 1_000_000, turns: 20, turnUnits: 300_000 }, { requests: 50, work: 50, units: 400_000 }],
      [{ requests: 40, work: 30, units: 300_000, turns: 10, turnUnits: 120_000 }],
      { requests: 7, work: 7, units: 70_000 },
    ))
    expect(c.late).toEqual({ requests: 150, working: 130, turns: 20, groups: 2, sharePct: 13.3, unitsPerRequest: 9_333, unitsPerWorking: 10_769, turnUnitsPerWorking: 2_308 })
    expect(c.holdout).toEqual({ requests: 40, working: 30, turns: 10, groups: 1, sharePct: 25, unitsPerRequest: 7_500, unitsPerWorking: 10_000, turnUnitsPerWorking: 4_000 })
    expect(c.legacy).toEqual({ requests: 7, working: 7, turns: 0, groups: 1, sharePct: 0, unitsPerRequest: 10_000, unitsPerWorking: 10_000, turnUnitsPerWorking: 0 })
  })

  describe('not enough data yet', () => {
    const enough = (): ArmState => state(groups(10, 10_000, 1_000), groups(10, 11_000, 1_100))

    it('is settled the other way once both arms have 500 requests in 5 groups', () => {
      expect(MIN_ARM_GROUPS).toBe(5)
      expect(compareArms(enough()).verdict).not.toBe('not-enough-data')
      expect(compareArms(state(groups(5, 10_000, 1_000), groups(5, 11_000, 1_100))).verdict).not.toBe('not-enough-data')
    })

    it('holds below 500 requests in either arm, to the request, with plenty of groups', () => {
      /** Ten groups holding exactly `total` requests between them, so the group count is no obstacle. */
      const spread = (total: number, mean: number, dev: number): Array<Partial<ArmCounts>> =>
        Array.from({ length: 10 }, (_, i) => {
          const n = Math.floor(total / 10) + (i < total % 10 ? 1 : 0)
          return { requests: n, work: n, units: n * mean + (i % 2 === 0 ? 1 : -1) * n * dev }
        })
      expect(compareArms(state(spread(499, 10_000, 1_000), spread(500, 11_000, 1_100))).verdict).toBe('not-enough-data') // late: 499
      expect(compareArms(state(spread(500, 10_000, 1_000), spread(499, 11_000, 1_100))).verdict).toBe('not-enough-data') // holdout: 499
      expect(compareArms(state(spread(500, 10_000, 1_000), spread(500, 11_000, 1_100))).verdict).not.toBe('not-enough-data') // 500 each
      expect(compareArms(state(groups(5, 10_000, 1_000), groups(10, 11_000, 1_100))).verdict).not.toBe('not-enough-data') // 500 in five groups
    })

    it('holds when the requests come from too few groups of conversations to tell groups apart', () => {
      // 600 requests, all in one group: the margin cannot be measured, so nothing is claimed.
      const one = (mean: number): Array<Partial<ArmCounts>> => [{ requests: 600, work: 600, units: 600 * mean }]
      expect(compareArms(state(one(1_000), one(5_000))).verdict).toBe('not-enough-data')
      const four = (mean: number): Array<Partial<ArmCounts>> => groups(4, mean, 0).map((g) => ({ ...g, requests: 150, work: 150, units: 150 * mean }))
      expect(compareArms(state(four(1_000), four(5_000))).verdict).toBe('not-enough-data')
    })

    it('holds when one arm has no working request at all, on either side', () => {
      const onlyTurns = Array.from({ length: 10 }, () => ({ requests: 60, work: 0, units: 600_000, turns: 60, turnUnits: 600_000 }))
      expect(compareArms(state(onlyTurns, groups(10, 11_000, 1_100))).verdict).toBe('not-enough-data')
      expect(compareArms(state(groups(10, 11_000, 1_100), onlyTurns)).verdict).toBe('not-enough-data')
    })

    it('holds when the holdout arm cost nothing, which would make a relative difference meaningless', () => {
      const free = Array.from({ length: 10 }, () => ({ requests: 60, work: 60, units: 0 }))
      const c = compareArms(state(groups(10, 11_000, 1_100), free))
      expect(c.verdict).toBe('not-enough-data')
      expect(c.costDeltaPct).toBeNull()
    })

    it('still says what it can of the retrieval turns when there is no cost to compare', () => {
      const onlyTurns = Array.from({ length: 10 }, () => ({ requests: 60, work: 0, units: 600_000, turns: 60, turnUnits: 600_000 }))
      const c = compareArms(state(groups(10, 11_000, 1_100), onlyTurns))
      expect(c.verdict).toBe('not-enough-data')
      // Late had no retrieval turns (0%); every request of the holdout was one (100%).
      expect(c.turnVerdict).toBe('fewer')
      expect(c.shareDeltaPts).toBeCloseTo(-100, 5)
    })

    it('never counts the kill switch towards either arm', () => {
      expect(compareArms(state([], [], { requests: 10_000, work: 10_000, units: 1e9 })).verdict).toBe('not-enough-data')
    })
  })

  describe('cost per unit of work', () => {
    it('finds no clear difference when the gap is inside the margin: 9.1% cheaper, give or take 9.7', () => {
      // late R = 10,000, se 333.33; holdout R = 11,000, se 366.67 (alternating groups, +/-10%).
      // rel = 10000/11000 - 1 = -0.090909; var = (333.33/11000)^2 + (10000 x 366.67/121e6)^2 = 0.0018365
      // se = 0.042855; t(9) = 2.262; margin = 0.09694.
      const c = compareArms(state(groups(10, 10_000, 1_000), groups(10, 11_000, 1_100)))
      expect(c.verdict).toBe('no-clear-difference')
      expect(c.costDeltaPct).toBeCloseTo(-9.1, 1)
      expect(c.costMarginPct).toBeCloseTo(9.7, 1)
    })

    it('calls late cheaper when the gap clears the margin: 18.2% cheaper, give or take 8.7', () => {
      // late R = 9,000, se 300; holdout R = 11,000, se 366.67.
      // rel = -0.181818; var = (300/11000)^2 + (9000 x 366.67/121e6)^2 = 0.0014876; se = 0.03857; margin = 2.262 x 0.03857
      const c = compareArms(state(groups(10, 9_000, 900), groups(10, 11_000, 1_100)))
      expect(c.verdict).toBe('late-cheaper')
      expect(c.costDeltaPct).toBeCloseTo(-18.2, 1)
      expect(c.costMarginPct).toBeCloseTo(8.7, 1)
    })

    it('calls late dearer when it is dearer by more than the margin: 18.2% dearer, give or take 12.6', () => {
      // late R = 13,000, se 433.33; holdout R = 11,000, se 366.67.
      // rel = 0.181818; var = (433.33/11000)^2 + (13000 x 366.67/121e6)^2 = 0.0031037; se = 0.055711; margin = 0.12602
      const c = compareArms(state(groups(10, 13_000, 1_300), groups(10, 11_000, 1_100)))
      expect(c.verdict).toBe('late-costlier')
      expect(c.costDeltaPct).toBeCloseTo(18.2, 1)
      expect(c.costMarginPct).toBeCloseTo(12.6, 1)
    })

    it('is sure of any difference when every group says the same, as nothing then varies', () => {
      const c = compareArms(state(groups(10, 10_000, 0), groups(10, 10_001, 0)))
      expect(c.costMarginPct).toBe(0)
      expect(c.verdict).toBe('late-cheaper')
      const same = compareArms(state(groups(10, 10_000, 0), groups(10, 10_000, 0)))
      expect(same.verdict).toBe('no-clear-difference')
      expect(same.costDeltaPct).toBe(0)
    })

    it('counts the retrieval turns as cost and not as work: the comparison that makes late look as cheap as it is', () => {
      // Late: 100 requests, 100 working, 10,000 units each, no turns. Holdout: the same work, but 30
      // of its 130 requests were turns that only fetched elided text, at 6,000 units each. Per
      // REQUEST the holdout looks cheaper (8,846 against 10,000); per unit of WORK it is dearer.
      const late = groups(10, 10_000, 0)
      const holdout = Array.from({ length: 10 }, () => ({ requests: 130, work: 100, units: 100 * 10_000 + 30 * 6_000, turns: 30, turnUnits: 180_000 }))
      const c = compareArms(state(late, holdout))
      expect(c.late.unitsPerRequest).toBe(10_000)
      expect(c.holdout.unitsPerRequest).toBe(9_077)
      expect(c.late.unitsPerRequest!).toBeGreaterThan(c.holdout.unitsPerRequest!) // the misleading reading
      expect(c.holdout.unitsPerWorking).toBe(11_800)
      expect(c.verdict).toBe('late-cheaper') // the right one: 10,000 against 11,800 per unit of work
      expect(c.costDeltaPct).toBeCloseTo(-15.3, 1)
    })

    it('leaves a group whose requests were all retrieval turns out of the cost, and keeps it in the share', () => {
      const late = [...groups(9, 10_000, 0), { requests: 100, work: 0, units: 500_000, turns: 100, turnUnits: 500_000 }]
      const c = compareArms(state(late, groups(10, 10_000, 0)))
      expect(c.late.groups).toBe(10)
      expect(c.late.unitsPerWorking).toBe(10_000 + Math.round((500_000 / 900)))
      expect(c.late.turns).toBe(100)
    })
  })

  describe('retrieval turns', () => {
    const withTurns = (turnsFor: (i: number) => number, units = 10_000): Array<Partial<ArmCounts>> =>
      Array.from({ length: 10 }, (_, i) => ({ requests: 100, work: 100 - turnsFor(i), units: 100 * units, turns: turnsFor(i), turnUnits: turnsFor(i) * 6_000 }))

    it('says late needed fewer when every group agrees: 5% of requests against 23%', () => {
      const c = compareArms(state(withTurns(() => 5), withTurns(() => 23)))
      expect(c.late.sharePct).toBe(5)
      expect(c.holdout.sharePct).toBe(23)
      expect(c.shareDeltaPts).toBeCloseTo(-18, 5)
      expect(c.shareMarginPts).toBe(0)
      expect(c.turnVerdict).toBe('fewer')
    })

    it('says so through noise that is smaller than the gap: groups 0 and 10 against 18 and 28, margin 5.3', () => {
      // late S = 0.05, se 0.016667; holdout S = 0.23, se 0.016667; se(diff) = 0.02357; margin = 2.262 x 0.02357
      const c = compareArms(state(withTurns((i) => (i % 2 ? 10 : 0)), withTurns((i) => (i % 2 ? 28 : 18))))
      expect(c.shareDeltaPts).toBeCloseTo(-18, 5)
      expect(c.shareMarginPts).toBeCloseTo(5.3, 1)
      expect(c.turnVerdict).toBe('fewer')
    })

    it('finds no clear difference when the gap is inside that noise: 20% against 23%', () => {
      const c = compareArms(state(withTurns((i) => (i % 2 ? 30 : 10)), withTurns((i) => (i % 2 ? 28 : 18))))
      expect(c.shareDeltaPts).toBeCloseTo(-3, 5)
      expect(c.turnVerdict).toBe('no-clear-difference')
    })

    it('says late needed MORE when it did, which is the case the card must not hide', () => {
      const c = compareArms(state(withTurns(() => 30), withTurns(() => 10)))
      expect(c.turnVerdict).toBe('more')
    })

    it('has no verdict before there is enough data to have one', () => {
      expect(compareArms(state(groups(2, 10_000, 0, { turns: 10 }), groups(2, 10_000, 0, { turns: 20 }))).turnVerdict).toBeNull()
    })
  })

  describe('tCritical', () => {
    it('is the two-sided 95% quantile of the t distribution', () => {
      expect(tCritical(1)).toBeCloseTo(12.706, 3)
      expect(tCritical(4)).toBeCloseTo(2.776, 3)
      expect(tCritical(9)).toBeCloseTo(2.262, 3)
      expect(tCritical(19)).toBeCloseTo(2.093, 3)
      expect(tCritical(30)).toBeCloseTo(2.042, 3)
    })
    it('falls back to the normal quantile for many degrees of freedom, and refuses none', () => {
      expect(tCritical(31)).toBe(1.96)
      expect(tCritical(10_000)).toBe(1.96)
      for (const bad of [0, -1, Number.NaN]) expect(tCritical(bad)).toBe(Number.POSITIVE_INFINITY)
    })
  })
})
