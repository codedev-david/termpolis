import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildElisionHealth, summarizeElisionHealth, MIN_SAMPLES, MIN_TURNS_MEASURED, ASSUMED_TURN_UNITS, UNITS_PER_KEPT_TOKEN,
  REGIME_GAP_POINTS, type ElisionHealthInput,
} from '../../src/main/headroom/elisionHealth'
import { recordElision, recordRedemption, resetElisionLedger, ELISION_WINDOW } from '../../src/main/headroom/elisionLedger'
import { recordArmRequest, resetArmLedger, type ArmCounts, type ArmState } from '../../src/main/headroom/armLedger'
import { compareArms } from '../../src/main/headroom/armCompare'
import { ARM_CLUSTERS } from '../../src/main/headroom/elisionPolicy'
import { resetProxyLedger, recordProxyResult } from '../../src/main/headroomProxy/proxyLedger'
import { resetCcr } from '../../src/main/headroom/ccrStore'
import { resetDepthCurveAll } from '../../src/main/headroom/sessionDepth'
import type { ClassCounts } from '../../src/main/headroom/elisionLedger'
import type { ProxyResultMsg } from '../../src/main/headroomProxy/proxySupervisor'

/**
 * R1 criterion 5, the main-process half: the view behind the Elision health card. Redemption by
 * class, the break-even for each, and the verdict. The arithmetic is worked out by hand below, so a
 * change to the model has to be made on purpose.
 *
 * The class used throughout: Read results of 4-10k characters, averaging 6,000 characters, left as
 * 1,100-character views.
 *   kept tokens   = (6,000 - 1,100) / 4 = 1,225        view tokens = 1,100 / 4 = 275
 *   B (saved)     = 1,225 x 11 = 13,475 units          V (resident) = 275 x 11 = 3,025 units
 * With a retrieval turn costing E = 17,000 units:
 *   break-even    = B / (B + E + V) = 13,475 / 33,500 = 40.2%
 *   net per result at rate r = (1 - r) x 13,475 - r x 20,025
 */

const KEY = 'compact|Read|4-10k'
const cls = (elided: number, redeemed: number, meanChars = 6000, meanView = 1100): ClassCounts =>
  ({ elided, redeemed, chars: elided * meanChars, view: elided * meanView })
interface Over { classes?: Record<string, ClassCounts>; recent?: Record<string, ClassCounts>; turns?: ElisionHealthInput['turns'] }
/** By default a ledger that has seen 100 retrieval turns at 17,000 units each: E is measured. */
const input = (over: Over = {}): ElisionHealthInput => ({
  state: { classes: over.classes ?? {}, legacyRedeemed: 0 },
  recent: new Map(Object.entries(over.recent ?? {})),
  turns: over.turns ?? { retrievalTurns: 100, retrievalTurnUnits: 1_700_000, turnRequests: 400 },
})

describe('the model', () => {
  it('uses the research constants and says so', () => {
    expect(UNITS_PER_KEPT_TOKEN).toBe(11)
    expect(ASSUMED_TURN_UNITS).toBe(16_800)
    expect(MIN_SAMPLES).toBe(30)
    expect(MIN_TURNS_MEASURED).toBe(20)
  })

  it('says eliding loses at the rate the model has asked since September, and wins at the old one', () => {
    // 66% asked back, E measured at 17,000 units a turn: 0.34 x 13,475 - 0.66 x 20,025 = -8,635 per result.
    const costs = buildElisionHealth(input({ classes: { [KEY]: cls(100, 66) } }))
    const c = costs.classes[0]
    expect(c.breakEvenPct).toBe(40.2)
    expect(c.netUnitsPer1000).toBe(-8_635_000)
    expect(c.verdict).toBe('costs')
    expect(c.basis).toBe('all-time')
    // 13% asked back, the rate until late August: 0.87 x 13,475 - 0.13 x 20,025 = +9,120 per result.
    const pays = buildElisionHealth(input({ classes: { [KEY]: cls(100, 13) } })).classes[0]
    expect(pays.netUnitsPer1000).toBe(9_120_000)
    expect(pays.verdict).toBe('pays')
  })

  it('flips from pays to costs at the break-even rate', () => {
    // r* = 13,475 / 33,500 = 0.402238...; a class of 100,000 results can sit either side of it.
    const at = buildElisionHealth(input({ classes: { [KEY]: cls(100_000, 40_224) } })).classes[0]
    expect(at.breakEvenPct).toBe(40.2)
    expect(at.verdict).toBe('costs') // 40.224% is just over 40.2238%
    const under = buildElisionHealth(input({ classes: { [KEY]: cls(100_000, 40_223) } })).classes[0]
    expect(under.verdict).toBe('pays')
  })

  it('charges the research\'s turn cost until the ledger has seen enough turns to measure its own', () => {
    // E assumed at 16,800: break-even = 13,475 / (13,475 + 16,800 + 3,025) = 40.5%.
    const thin = buildElisionHealth(input({ classes: { [KEY]: cls(100, 50) }, turns: { retrievalTurns: MIN_TURNS_MEASURED - 1, retrievalTurnUnits: 999_999, turnRequests: 80 } }))
    expect(thin.turns.costBasis).toBe('assumed')
    expect(thin.turns.unitsPerTurn).toBe(ASSUMED_TURN_UNITS)
    expect(thin.classes[0].breakEvenPct).toBe(40.5)
    const measured = buildElisionHealth(input({ classes: { [KEY]: cls(100, 50) }, turns: { retrievalTurns: MIN_TURNS_MEASURED, retrievalTurnUnits: 20 * 17_000, turnRequests: 80 } }))
    expect(measured.turns.costBasis).toBe('measured')
    expect(measured.turns.unitsPerTurn).toBe(17_000)
    expect(measured.classes[0].breakEvenPct).toBe(40.2)
  })

  it('a bigger result is worth eliding at a higher rate: break-even rises with size', () => {
    const small = buildElisionHealth(input({ classes: { [KEY]: cls(100, 50, 2000, 1100) } })).classes[0].breakEvenPct as number
    const big = buildElisionHealth(input({ classes: { 'compact|Read|40k+': cls(100, 50, 60_000, 1100) } })).classes[0].breakEvenPct as number
    expect(small).toBeLessThan(25)
    expect(big).toBeGreaterThan(85)
  })

  it('has no break-even to compute when there is nothing to save and nothing to pay', () => {
    // Zero-length results and a ledger whose retrieval turns cost nothing: B, E and V are all 0.
    const c = buildElisionHealth(input({
      classes: { [KEY]: cls(100, 10, 0, 0) },
      turns: { retrievalTurns: MIN_TURNS_MEASURED, retrievalTurnUnits: 0, turnRequests: 50 },
    })).classes[0]
    expect(c.breakEvenPct).toBe(0)
    expect(c.netUnitsPer1000).toBe(0)
    expect(c.verdict).toBe('costs')
  })

  it('never lets a view larger than the original earn a saving', () => {
    const c = buildElisionHealth(input({ classes: { [KEY]: cls(100, 0, 6000, 7000) } })).classes[0]
    expect(c.breakEvenPct).toBe(0)
    expect(c.verdict).toBe('costs')
  })
})

describe('which counts a verdict rests on', () => {
  it('gives no verdict below the sample floor, from either source', () => {
    const c = buildElisionHealth(input({ classes: { [KEY]: cls(MIN_SAMPLES - 1, 20) }, recent: { [KEY]: cls(MIN_SAMPLES - 1, 20) } })).classes[0]
    expect(c.verdict).toBe('unknown')
    expect(c.basis).toBeNull()
    expect(c.breakEvenPct).toBeNull()
    expect(c.netUnitsPer1000).toBeNull()
    expect(c.ratePct).toBe(69) // the rates are still shown: 20 of 29
  })

  it('prefers the recent window once it has enough results, and falls back to all time before that', () => {
    const lifetime = cls(1000, 130) // 13% for life
    const recentThin = cls(MIN_SAMPLES - 1, MIN_SAMPLES - 1)
    expect(buildElisionHealth(input({ classes: { [KEY]: lifetime }, recent: { [KEY]: recentThin } })).classes[0]).toMatchObject({ basis: 'all-time', verdict: 'pays' })
    const recentFull = cls(100, 66) // 66% lately
    expect(buildElisionHealth(input({ classes: { [KEY]: lifetime }, recent: { [KEY]: recentFull } })).classes[0]).toMatchObject({ basis: 'recent', verdict: 'costs' })
  })

  it('judges only first-sight compaction: the other kinds show rates and no verdict', () => {
    const v = buildElisionHealth(input({ classes: {
      [KEY]: cls(100, 66),
      'dedup|Read|4-10k': cls(500, 100),
      'diff|Bash|1.6-4k': cls(200, 10),
      'decay|Grep|<1.6k': cls(900, 300),
    } }))
    for (const c of v.classes.filter((x) => x.kind !== 'compact')) {
      expect(c.verdict).toBe('unknown')
      expect(c.breakEvenPct).toBeNull()
      expect(c.ratePct).not.toBeNull()
    }
    expect(v.firstSight.elided).toBe(100) // only the compact class counts toward it
  })

  it('rolls the compact classes into one first-sight verdict, weighted by results', () => {
    const v = buildElisionHealth(input({ classes: {
      [KEY]: cls(100, 66), //                    -8,635 x 100 results
      'compact|Bash|1.6-4k': cls(300, 30, 2500, 1100), // 10% asked back
    } }))
    const a = v.classes.find((c) => c.key === KEY) as { netUnitsPer1000: number }
    const b = v.classes.find((c) => c.key === 'compact|Bash|1.6-4k') as { netUnitsPer1000: number }
    expect(v.firstSight.elided).toBe(400)
    expect(v.firstSight.ratePct).toBe(24) // 96 of 400
    expect(v.firstSight.netUnits).toBe(Math.round((a.netUnitsPer1000 * 100 + b.netUnitsPer1000 * 300) / 1000))
    expect(v.firstSight.verdict).toBe(v.firstSight.netUnits > 0 ? 'pays' : 'costs')
    expect(v.firstSight.basis).toBe('all-time')
  })

  it('reports no first-sight verdict when no compact class has enough results', () => {
    const v = buildElisionHealth(input({ classes: { [KEY]: cls(5, 5), 'dedup|Read|4-10k': cls(900, 100) } }))
    expect(v.firstSight).toEqual({ verdict: 'unknown', basis: null, elided: 0, ratePct: null, breakEvenPct: null, netUnits: 0 })
  })

  it('names the basis of the overall verdict by where most of its results came from', () => {
    const v = buildElisionHealth(input({
      classes: { [KEY]: cls(1000, 130), 'compact|Bash|1.6-4k': cls(40, 30, 2500, 1100) },
      recent: { 'compact|Bash|1.6-4k': cls(35, 28, 2500, 1100) },
    }))
    expect(v.firstSight.basis).toBe('all-time') // 1,000 results from life against 35 from the window
    const lately = buildElisionHealth(input({
      classes: { [KEY]: cls(1000, 130), 'compact|Bash|1.6-4k': cls(40, 30, 2500, 1100) },
      recent: { [KEY]: cls(600, 400), 'compact|Bash|1.6-4k': cls(35, 28, 2500, 1100) },
    }))
    expect(lately.firstSight.basis).toBe('recent')
  })
})

describe('regime', () => {
  const life = (rate: number) => ({ [KEY]: cls(1000, rate * 10) })
  const lately = (rate: number, n = 200) => ({ [KEY]: cls(n, Math.round((n * rate) / 100)) })

  it('flags a rise from the all-time rate, the way the move from 13% to 66% should have shown', () => {
    expect(buildElisionHealth(input({ classes: life(21), recent: lately(66) })).regime).toBe('rising')
  })

  it('flags a fall, and calls a small gap steady', () => {
    expect(buildElisionHealth(input({ classes: life(66), recent: lately(13) })).regime).toBe('falling')
    expect(buildElisionHealth(input({ classes: life(40), recent: lately(40 + REGIME_GAP_POINTS - 1) })).regime).toBe('steady')
    expect(buildElisionHealth(input({ classes: life(40), recent: lately(40 + REGIME_GAP_POINTS) })).regime).toBe('rising')
  })

  it('does not call a regime off a thin window or a thin history', () => {
    expect(buildElisionHealth(input({ classes: life(21), recent: lately(66, MIN_SAMPLES - 1) })).regime).toBe('unknown')
    expect(buildElisionHealth(input({ classes: { [KEY]: cls(MIN_SAMPLES - 1, 3) }, recent: lately(66) })).regime).toBe('unknown')
    expect(buildElisionHealth(input({ classes: life(21) })).regime).toBe('unknown')
  })
})

describe('totals and shape', () => {
  it('sums the classes, keeps the legacy redemptions apart, and orders by volume', () => {
    const v = buildElisionHealth(input({
      classes: { [KEY]: cls(100, 66), 'dedup|Bash|<1.6k': cls(500, 5), 'decay|Grep|10-40k': cls(500, 50) },
      recent: { [KEY]: cls(40, 30) },
    }))
    expect(v.elided).toBe(1100)
    expect(v.redeemed).toBe(121)
    expect(v.recentElided).toBe(40)
    expect(v.recentRedeemed).toBe(30)
    expect(v.windowSize).toBe(ELISION_WINDOW)
    expect(v.classes.map((c) => c.key)).toEqual(['decay|Grep|10-40k', 'dedup|Bash|<1.6k', KEY]) // 500, 500 (key order), 100
  })

  it('breaks a tie in volume by class key, whatever order the ledger holds them in', () => {
    const keys = ['diff|Read|4-10k', 'compact|Read|4-10k', 'decay|Read|4-10k', 'dedup|Read|4-10k']
    const forward = buildElisionHealth(input({ classes: Object.fromEntries(keys.map((k) => [k, cls(50, 5)])) }))
    const backward = buildElisionHealth(input({ classes: Object.fromEntries([...keys].reverse().map((k) => [k, cls(50, 5)])) }))
    const sorted = [...keys].sort()
    expect(forward.classes.map((c) => c.key)).toEqual(sorted)
    expect(backward.classes.map((c) => c.key)).toEqual(sorted)
  })

  it('passes the legacy redemption count through', () => {
    const v = buildElisionHealth({ state: { classes: {}, legacyRedeemed: 7 }, recent: new Map(), turns: {} })
    expect(v.legacyRedeemed).toBe(7)
  })

  it('splits a class key back into kind, tool and size, and drops one it did not build', () => {
    const v = buildElisionHealth(input({ classes: { [KEY]: cls(5, 1), 'bogus|Read|4-10k': cls(9, 9), 'compact|Nope|4-10k': cls(9, 9) } }))
    expect(v.classes).toHaveLength(1)
    expect(v.classes[0]).toMatchObject({ kind: 'compact', tool: 'Read', band: '4-10k', elided: 5, redeemed: 1, ratePct: 20 })
  })

  it('keeps a class that was only ever redeemed, with a rate of nothing', () => {
    const v = buildElisionHealth(input({ classes: { [KEY]: { elided: 0, redeemed: 3, chars: 0, view: 0 } } }))
    expect(v.classes[0]).toMatchObject({ elided: 0, redeemed: 3, ratePct: null, verdict: 'unknown' })
  })

  it('caps a rate at 100% when more were asked than the ledger saw elided', () => {
    expect(buildElisionHealth(input({ classes: { [KEY]: cls(10, 15) } })).classes[0].ratePct).toBe(100)
  })

  it('is empty, not broken, before anything is recorded', () => {
    const v = buildElisionHealth({ state: { classes: {}, legacyRedeemed: 0 }, recent: new Map(), turns: {} })
    expect(v.classes).toEqual([])
    expect(v.elided).toBe(0)
    expect(v.firstSight.verdict).toBe('unknown')
    expect(v.regime).toBe('unknown')
    expect(v.turns).toEqual({ count: 0, units: 0, unitsPerTurn: ASSUMED_TURN_UNITS, costBasis: 'assumed', observed: 0, sharePct: null })
  })
})

describe('retrieval turns', () => {
  it('reports the count, the units, the cost per turn and the share of responses', () => {
    const v = buildElisionHealth(input({ turns: { retrievalTurns: 230, retrievalTurnUnits: 3_910_000, turnRequests: 1000 } }))
    expect(v.turns).toEqual({ count: 230, units: 3_910_000, unitsPerTurn: 17_000, costBasis: 'measured', observed: 1000, sharePct: 23 })
  })

  it('has no share until responses have been observed', () => {
    const v = buildElisionHealth(input({ turns: { retrievalTurns: 5, retrievalTurnUnits: 1000, turnRequests: 0 } }))
    expect(v.turns.sharePct).toBeNull()
  })

  it('reads damaged counters as zero', () => {
    const v = buildElisionHealth(input({ turns: { retrievalTurns: Number.NaN, retrievalTurnUnits: -5, turnRequests: '9' as unknown as number } }))
    expect(v.turns).toMatchObject({ count: 0, units: 0, observed: 0, sharePct: null })
  })
})

describe('the arms in the view', () => {
  const zeroArm = (): ArmCounts => ({ requests: 0, work: 0, units: 0, turns: 0, turnUnits: 0 })
  const armsWith = (late: ArmCounts, holdout: ArmCounts): ArmState => ({
    late: Array.from({ length: ARM_CLUSTERS }, (_, i) => (i < 10 ? late : zeroArm())),
    holdout: Array.from({ length: ARM_CLUSTERS }, (_, i) => (i < 10 ? holdout : zeroArm())),
    legacy: zeroArm(),
  })

  it('carry the comparison of the two arms, whatever else the view holds', () => {
    const arms = armsWith({ requests: 100, work: 100, units: 900_000, turns: 5, turnUnits: 30_000 }, { requests: 100, work: 90, units: 1_000_000, turns: 20, turnUnits: 120_000 })
    const v = buildElisionHealth({ ...input(), arms })
    expect(v.arms).toEqual(compareArms(arms))
    expect(v.arms.late.requests).toBe(1000)
    expect(v.arms.holdout.requests).toBe(1000)
    expect(v.arms.verdict).not.toBe('not-enough-data')
  })

  it('say there is not enough data when the ledger holds none, or was not given', () => {
    expect(buildElisionHealth(input()).arms.verdict).toBe('not-enough-data')
    expect(buildElisionHealth({ ...input(), arms: undefined }).arms).toEqual(compareArms(undefined))
    expect(buildElisionHealth(input()).arms.minRequests).toBe(500)
  })
})

describe('the live view', () => {
  beforeEach(() => { resetProxyLedger(); resetElisionLedger(); resetCcr(); resetDepthCurveAll(); resetArmLedger() })

  it('reads the arm ledger the proxy fills', () => {
    recordArmRequest('late', 4, { units: 900, pureTurn: false, turnUnits: 0 })
    recordArmRequest('holdout', 4, { units: 700, pureTurn: true, turnUnits: 400 })
    const v = summarizeElisionHealth()
    expect(v.arms.late).toMatchObject({ requests: 1, working: 1, groups: 1, unitsPerWorking: 900 })
    expect(v.arms.holdout).toMatchObject({ requests: 1, working: 0, turns: 1, sharePct: 100 })
    expect(v.arms.verdict).toBe('not-enough-data')
  })

  const meta = { kind: 'compact' as const, tool: 'Read', chars: 6000, view: 1100 }
  const tok = (n: number): string => 'hr_' + n.toString(16).padStart(16, '0')
  const turnMsg = (pure: boolean, read = 170_000, out = 137): ProxyResultMsg => ({
    kind: 'result', changed: false, status: 200, stashes: [],
    stats: { trBlocks: 0, trOrigChars: 0, trCompChars: 0, images: 0, imgOrigBytes: 0, imgCompBytes: 0 },
    usage: { input_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: 0, output_tokens: out },
    turn: { toolCalls: 1, retrieveCalls: pure ? 1 : 0, pure },
  }) as unknown as ProxyResultMsg

  it('reads the elision ledger and the proxy ledger as they stand', () => {
    for (let i = 0; i < 40; i++) recordElision(tok(i), meta)
    for (let i = 0; i < 30; i++) recordRedemption(tok(i), meta)
    for (let i = 0; i < 3; i++) recordProxyResult(turnMsg(true))
    recordProxyResult(turnMsg(false))
    const v = summarizeElisionHealth()
    expect(v.elided).toBe(40)
    expect(v.redeemed).toBe(30)
    expect(v.classes[0]).toMatchObject({ key: KEY, elided: 40, redeemed: 30, recentElided: 40, recentRedeemed: 30, basis: 'recent' })
    expect(v.turns).toMatchObject({ count: 3, observed: 4, sharePct: 75, costBasis: 'assumed' })
    expect(v.turns.units).toBeCloseTo(3 * (0.1 * 170_000 + 5 * 137), 6)
  })
})
