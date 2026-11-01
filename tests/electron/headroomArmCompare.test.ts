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
 *   its spread              the ten (or n) values of ln R with each group left out in turn;
 *                           var(ln R) = (n-1)/n x sum (x_i - mean x)^2   (the jackknife)
 *   late against holdout    d = ln R_late - ln R_holdout, var(d) = var(ln R_late) + var(ln R_holdout)
 *   a clear difference      |d| > t(df) x se(d), t the two-sided 99% quantile, df = min(groups) - 1
 *   shown as                (exp(d) - 1) in percent, and half the width of exp(d +/- t x se) in percent
 */

/** A small seeded generator, so the random ledgers are the same on every run and every machine. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

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
    expect(c.late).toEqual({ requests: 150, working: 130, turns: 20, groups: 2, sharePct: 13.3, turnUnitSharePct: 21.4, unitsPerRequest: 9_333, unitsPerWorking: 10_769, turnUnitsPerWorking: 2_308 })
    expect(c.holdout).toEqual({ requests: 40, working: 30, turns: 10, groups: 1, sharePct: 25, turnUnitSharePct: 40, unitsPerRequest: 7_500, unitsPerWorking: 10_000, turnUnitsPerWorking: 4_000 })
    expect(c.legacy).toEqual({ requests: 7, working: 7, turns: 0, groups: 1, sharePct: 0, turnUnitSharePct: 0, unitsPerRequest: 10_000, unitsPerWorking: 10_000, turnUnitsPerWorking: 0 })
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
    // Every fixture below alternates its groups +/-10% about the arm's mean, so for each arm the ten
    // leave-one-out values of ln R are ln(R x 0.8889 / 0.9) and ln(R x 0.9111 / 0.9) alternating:
    // half the spread of ln(10111.11 / 9888.89) = 0.022223, i.e. 0.0111115, squared and summed over ten
    // groups, times 9/10: variance 1.1112e-3 per arm, whatever the mean. The difference of two arms
    // has variance 2.2224e-3, se 0.047141; with 9 degrees of freedom at 99% t = 3.250, margin 0.15321.
    it('finds no clear difference when the gap is inside the margin: 9.1% cheaper, give or take 14.0', () => {
      // d = ln(10000 / 11000) = -0.095310, inside +/-0.15321.
      // percent margin = (exp(d + m) - exp(d - m)) / 2 = (1.059612 - 0.779945) / 2 = 13.98
      const c = compareArms(state(groups(10, 10_000, 1_000), groups(10, 11_000, 1_100)))
      expect(c.verdict).toBe('no-clear-difference')
      expect(c.costDeltaPct).toBeCloseTo(-9.1, 1)
      expect(c.costMarginPct).toBeCloseTo(14.0, 1)
    })

    it('says how much more data would settle a gap it cannot yet: a gap this size, about 11 times as much', () => {
      // factor = (2 x 0.15321 / 0.095310) ^ 2 = 10.34, rounded up
      const c = compareArms(state(groups(10, 10_000, 1_000), groups(10, 11_000, 1_100)))
      expect(c.moreDataFactor).toBe(11)
    })

    it('does not quote a factor for a gap so small that it is no number, nor for a gap that is already clear', () => {
      // 0.1% apart: the factor would be in the thousands.
      const tiny = compareArms(state(groups(10, 10_000, 1_000), groups(10, 10_010, 1_001)))
      expect(tiny.verdict).toBe('no-clear-difference')
      expect(tiny.moreDataFactor).toBeNull()
      expect(compareArms(state(groups(10, 9_000, 900), groups(10, 11_000, 1_100))).moreDataFactor).toBeNull()
      // And not for no gap at all.
      expect(compareArms(state(groups(10, 10_000, 0), groups(10, 10_000, 0))).moreDataFactor).toBeNull()
    })

    it('calls late cheaper when the gap clears the margin: 18.2% cheaper, give or take 12.6', () => {
      // d = ln(9000 / 11000) = -0.200671, beyond -0.15321.
      // percent margin = (exp(d + m) - exp(d - m)) / 2 = (0.953644 - 0.701842) / 2 = 12.59
      const c = compareArms(state(groups(10, 9_000, 900), groups(10, 11_000, 1_100)))
      expect(c.verdict).toBe('late-cheaper')
      expect(c.costDeltaPct).toBeCloseTo(-18.2, 1)
      expect(c.costMarginPct).toBeCloseTo(12.6, 1)
      expect(c.moreDataFactor).toBeNull()
    })

    it('calls late dearer when it is dearer by more than the margin: 18.2% dearer, give or take 18.2', () => {
      // d = ln(13000 / 11000) = 0.167054, beyond +0.15321.
      // percent margin = (exp(0.320264) - exp(0.013844)) / 2 = (1.377513 - 1.013940) / 2 = 18.18
      const c = compareArms(state(groups(10, 13_000, 1_300), groups(10, 11_000, 1_100)))
      expect(c.verdict).toBe('late-costlier')
      expect(c.costDeltaPct).toBeCloseTo(18.2, 1)
      expect(c.costMarginPct).toBeCloseTo(18.2, 1)
    })

    it('agrees with a plain re-derivation of the jackknife on 200 random ledgers', () => {
      const next = seeded(0xa77c0)
      const t99 = (df: number): number => tCritical(df)
      for (let n = 0; n < 200; n++) {
        const gl = 5 + Math.floor(next() * 16), gh = 5 + Math.floor(next() * 16)
        const mk = (k: number): Array<Partial<ArmCounts>> => Array.from({ length: k }, () => {
          const work = 100 + Math.floor(next() * 200) // five groups always clear the 500 requests an arm needs
          const turns = Math.floor(next() * 30)
          return { requests: work + turns, work, units: work * (2_000 + next() * 20_000) + turns * 6_000, turns, turnUnits: turns * 6_000 }
        })
        const L = mk(gl), H = mk(gh)
        const c = compareArms(state(L, H))
        // The reference: ln R over all groups, and over each leave-one-out, from first principles.
        const jack = (g: Array<Partial<ArmCounts>>): { ln: number; v: number } => {
          const R = (xs: Array<Partial<ArmCounts>>): number => xs.reduce((a, x) => a + (x.units ?? 0), 0) / xs.reduce((a, x) => a + (x.work ?? 0), 0)
          const loo = g.map((_, i) => Math.log(R(g.filter((_, j) => j !== i))))
          const mean = loo.reduce((a, x) => a + x, 0) / loo.length
          return { ln: Math.log(R(g)), v: ((g.length - 1) / g.length) * loo.reduce((a, x) => a + (x - mean) ** 2, 0) }
        }
        const a = jack(L), b = jack(H)
        const d = a.ln - b.ln
        const m = t99(Math.min(gl, gh) - 1) * Math.sqrt(a.v + b.v)
        expect(c.costDeltaPct).toBeCloseTo(Math.round((Math.exp(d) - 1) * 1000) / 10, 5)
        expect(c.costMarginPct).toBeCloseTo(Math.round(((Math.exp(d + m) - Math.exp(d - m)) / 2) * 1000) / 10, 5)
        expect(c.verdict).toBe(d < -m ? 'late-cheaper' : d > m ? 'late-costlier' : 'no-clear-difference')
      }
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

    it('says so through noise that is smaller than the gap: groups 0 and 10 against 18 and 28, margin 7.7', () => {
      // late S = 0.05, se 0.016667; holdout S = 0.23, se 0.016667; se(diff) = 0.02357; margin = 3.250 x 0.02357
      const c = compareArms(state(withTurns((i) => (i % 2 ? 10 : 0)), withTurns((i) => (i % 2 ? 28 : 18))))
      expect(c.shareDeltaPts).toBeCloseTo(-18, 5)
      expect(c.shareMarginPts).toBeCloseTo(7.7, 1)
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
    it('is the two-sided 99% quantile of the t distribution', () => {
      expect(tCritical(1)).toBeCloseTo(63.657, 3)
      expect(tCritical(4)).toBeCloseTo(4.604, 3)
      expect(tCritical(9)).toBeCloseTo(3.25, 3)
      expect(tCritical(19)).toBeCloseTo(2.861, 3)
      expect(tCritical(30)).toBeCloseTo(2.75, 3)
    })
    it('falls back to the normal quantile for many degrees of freedom, and refuses none', () => {
      expect(tCritical(31)).toBe(2.576)
      expect(tCritical(10_000)).toBe(2.576)
      for (const bad of [0, -1, Number.NaN]) expect(tCritical(bad)).toBe(Number.POSITIVE_INFINITY)
    })
  })
})

describe('the verdicts are calibrated, not only computed', () => {
  // When the two arms cost exactly the same, a verdict that names one cheaper is a false alarm. The
  // cost of a group of conversations is right-skewed, and the interval this replaced (the relative
  // difference with a delta-method error) cried "cheaper" 9 times in 100 at a spread of 1.0 against 2.5
  // intended, and almost never "costlier": measured on this very file's predecessor. The jackknife on
  // the log scale holds both directions near their level. Seeded, so the count is the same every run.
  const trial = (next: () => number, sigma: number): ReturnType<typeof compareArms> => {
    const normal = (): number => { let a = 0; for (let i = 0; i < 12; i++) a += next(); return a - 6 }
    const arm = (): Array<Partial<ArmCounts>> => Array.from({ length: 20 }, () => {
      const work = 100 + Math.floor(next() * 300)
      return { requests: work, work, units: work * 1000 * Math.exp(sigma * normal() - (sigma * sigma) / 2) }
    })
    return compareArms(state(arm(), arm()))
  }

  it.each([0.3, 1.0, 1.4])('identical arms at a group spread of %s: a false verdict either way in at most 2.5 trials in 100', (sigma) => {
    const next = seeded(0xca11b + Math.round(sigma * 10))
    const TRIALS = 2_000
    let cheaper = 0, costlier = 0
    for (let i = 0; i < TRIALS; i++) {
      const v = trial(next, sigma).verdict
      if (v === 'late-cheaper') cheaper++
      if (v === 'late-costlier') costlier++
    }
    // At the 99% level the intended rate is 0.5 in 100 a side; measured 0.5 to 0.9. Allow 2.5, which
    // the old estimator broke at a spread of 1.0 and above, and which a repeated look cannot reach.
    expect(cheaper / TRIALS).toBeLessThanOrEqual(0.025)
    expect(costlier / TRIALS).toBeLessThanOrEqual(0.025)
  })

  it('still finds a real difference: a true 25% saving is called cheaper in most trials', () => {
    const next = seeded(0xbeef)
    let cheaper = 0
    const TRIALS = 200
    for (let i = 0; i < TRIALS; i++) {
      const normal = (): number => { let a = 0; for (let k = 0; k < 12; k++) a += next(); return a - 6 }
      const arm = (mean: number): Array<Partial<ArmCounts>> => Array.from({ length: 20 }, () => {
        const work = 100 + Math.floor(next() * 300)
        return { requests: work, work, units: work * mean * Math.exp(0.2 * normal() - 0.02) }
      })
      if (compareArms(state(arm(750), arm(1000))).verdict === 'late-cheaper') cheaper++
    }
    expect(cheaper / TRIALS).toBeGreaterThan(0.9)
  })
})

describe('what the retrieval turns cost, in money', () => {
  const withTurns = (n: number, turnUnits: number, units: number): Array<Partial<ArmCounts>> =>
    Array.from({ length: 10 }, () => ({ requests: 100, work: 100 - n, units, turns: n, turnUnits }))

  it('gives each arm’s share of billed units that went on retrieval turns', () => {
    const c = compareArms(state(withTurns(5, 30_000, 1_000_000), withTurns(23, 138_000, 1_000_000)))
    expect(c.late.turnUnitSharePct).toBe(3)
    expect(c.holdout.turnUnitSharePct).toBe(13.8)
  })

  it('has no share of a cost that is nothing, or of an arm with no requests', () => {
    expect(compareArms(state([], [])).late.turnUnitSharePct).toBeNull()
    expect(compareArms(state(withTurns(5, 0, 0), withTurns(5, 0, 0))).late.turnUnitSharePct).toBeNull()
  })

  it('reads damaged counts as nothing rather than as a share of NaN', () => {
    const bad = [{ requests: 100, work: 90, units: Number.NaN, turns: 10, turnUnits: -5 }] as unknown as ArmState['late']
    const c = compareArms({ late: bad, holdout: [], legacy: zero() })
    expect(c.late.turnUnitSharePct).toBeNull()
  })
})

describe('a comparison that cannot be taken', () => {
  it('names nothing when leaving one group out would leave an arm with no work or no cost', () => {
    // Ten groups, but only one of them did any work: dropping it leaves nothing to take a ratio of.
    const oneWorker = [{ requests: 600, work: 600, units: 6_000_000 }, ...Array.from({ length: 9 }, () => ({ requests: 10, work: 0, units: 0, turns: 10, turnUnits: 50_000 }))]
    const c = compareArms(state(oneWorker, groups(10, 10_000, 1_000)))
    expect(c.verdict).toBe('not-enough-data')
    expect(c.costDeltaPct).toBeNull()
    expect(c.costMarginPct).toBeNull()
    // And the other way round.
    expect(compareArms(state(groups(10, 10_000, 1_000), oneWorker)).verdict).toBe('not-enough-data')
  })

  it('names nothing when one group is all of the cost', () => {
    // All of the units sit in one group: leave it out and the remaining cost is nothing.
    const oneCost = [{ requests: 100, work: 100, units: 1_000_000 }, ...Array.from({ length: 9 }, () => ({ requests: 100, work: 100, units: 0 }))]
    expect(compareArms(state(oneCost, groups(10, 10_000, 1_000))).verdict).toBe('not-enough-data')
  })
})
