import type { ArmCounts, ArmState } from './armLedger'

/**
 * Late against the holdout: did leaving results whole cost less, and did it need fewer retrieval
 * turns? The research modelled a saving of about 10% from one history. This is how the same
 * question is asked of the user's own work, with the uncertainty stated and a verdict that says
 * "not enough data yet" until there is some.
 *
 * Four decisions carry it:
 *
 *  - THE UNIT OF WORK IS A WORKING REQUEST, one that was not a turn spent only on fetching elided
 *    text. A retrieval turn costs about two thirds of an average request (it re-reads the cached
 *    prefix and writes a short call), so late, which has far fewer of them, would look dearer per
 *    REQUEST even while it lowered the bill: it removed the cheaper requests. Cost per working
 *    request counts the retrieval turns as cost and not as work, which is the comparison that means
 *    something. Cost per request is still shown, with that said.
 *
 *  - THE UNCERTAINTY IS MEASURED BETWEEN GROUPS OF CONVERSATIONS, NOT BETWEEN REQUESTS. A
 *    conversation is dozens of requests that cost alike, so treating each request as an independent
 *    sample would make the margin look an order of magnitude tighter than it is. Each arm is cut into
 *    groups by the same hash that chose the arm (elisionPolicy.ts armOf).
 *
 *  - THE COST INTERVAL IS BUILT ON THE LOG SCALE FROM A LEAVE-ONE-GROUP-OUT JACKKNIFE. The cost of a
 *    group of conversations is right-skewed, and an interval on the relative difference (late over
 *    holdout, minus one) with a delta-method error then says "late is cheaper" far more often than its
 *    stated level allows and almost never errs the other way: at a group spread of 1.0, 9 times in 100
 *    when the two arms were identical, against 2.5 intended (simulated on this very code before it was
 *    replaced). On the log scale, with the spread taken from dropping each group in turn, the same
 *    simulation gives 3 in 100, in both directions.
 *
 *  - IT SAYS NOTHING EARLY, AND NOTHING LOUD ON A GLANCE. Fewer than 500 requests in either arm, or
 *    requests from fewer than five groups, is "not enough data yet". A verdict is only given outside a
 *    99% interval, not a 95% one, because the card is read again and again and each look is a chance to
 *    be fooled: a 95% rule read weekly for two months falsely announced a difference about one time in
 *    four (simulated), and a 99% rule cuts that by two thirds. The margin that gives the 99% is read from
 *    the t table at 99.9% (see T999): at 99% it did not hold on the holdout's skewed costs.
 *
 * A cost difference needs a lot of conversations to read: a true saving of a tenth shows up, at the
 * volume of a heavy user, after months, not days. What is read in days is the mechanism, the share of
 * requests and of billed units that were retrieval turns, so the comparison gives both, and for a gap
 * it cannot yet settle it says how much more data would.
 *
 * Pure: no I/O, no clock.
 */

/** Fewer requests than this in either arm and no verdict is given. */
export const MIN_ARM_REQUESTS = 500
/** Fewer groups of conversations than this in either arm and the margin cannot be measured. */
export const MIN_ARM_GROUPS = 5

/**
 * Two-sided 99.9% quantiles of the t distribution (the 0.9995 quantile) for 1 to 30 degrees of freedom.
 *
 * Why 99.9% to state a 99% margin. A t interval assumes the estimate is roughly symmetric, and the
 * holdout's is not: it is about a tenth of the conversations, so its cost per unit of work is the mean of
 * a few dozen right-skewed numbers, and the spread read off its groups understates how far it can stray.
 * Simulated on identical arms (conversation costs lognormal, spread 1.0 and 1.5, 20 groups an arm, a tenth
 * in the holdout) the textbook 99% quantile named "Late is costing more" in about 1 to 3 reads in 100
 * (1.1 to 3.4 over three replications of the simulation, the figure the card, the guide and the README
 * quote), two to seven times the half a percent that side of a 99% rule allows, and "cheaper" almost never.
 * The 99.9% quantile brings that to under 1 read in 100 at the largest spread, and the share of retrieval
 * turns, which had the same lean, to a quarter of a percent. The test that holds this (the verdicts are
 * calibrated) fails with the 99% quantile in place. "Under 1 in 100" is a rate for each verdict on its own:
 * summed over both directions of the retrieval-turn line it can pass 1 in 100 on a workload whose request
 * counts per conversation are very uneven, which is why the user-facing text says "in each direction".
 */
const T999 = [
  636.619, 31.599, 12.924, 8.61, 6.869, 5.959, 5.408, 5.041, 4.781, 4.587, 4.437, 4.318, 4.221, 4.14, 4.073,
  4.015, 3.965, 3.922, 3.883, 3.85, 3.819, 3.792, 3.768, 3.745, 3.725, 3.707, 3.69, 3.674, 3.659, 3.646,
]
/** With no degrees of freedom there is no margin to speak of, so nothing can clear it. */
export function tCritical(df: number): number {
  if (!(df >= 1)) return Number.POSITIVE_INFINITY
  return df <= T999.length ? T999[Math.floor(df) - 1] : 3.291
}

/** A gap needing more than this many times the data so far is not worth a number: it is "far more". */
export const MORE_DATA_CAP = 100

export type ArmVerdict = 'not-enough-data' | 'late-cheaper' | 'late-costlier' | 'no-clear-difference'
export type TurnVerdict = 'fewer' | 'more' | 'no-clear-difference'

export interface ArmSummary {
  requests: number
  /** Requests that were not a turn spent only on fetching elided text. */
  working: number
  turns: number
  /** Groups of conversations the requests come from. */
  groups: number
  /** Retrieval turns as a share of requests, percent. */
  sharePct: number | null
  /** The share of billed units that went on retrieval turns, percent: the mechanism, in money. */
  turnUnitSharePct: number | null
  /** Billed units per request: the misleading one, shown with the note that says why. */
  unitsPerRequest: number | null
  /** Billed units per working request, the retrieval turns counted as cost. */
  unitsPerWorking: number | null
  /** The part of that which the retrieval turns cost. */
  turnUnitsPerWorking: number | null
}

export interface ArmComparison {
  minRequests: number
  late: ArmSummary
  holdout: ArmSummary
  /** Requests of a run on the Settings kill switch: not randomised, so shown and never compared. */
  legacy: ArmSummary
  verdict: ArmVerdict
  /** Late's cost per working request against the holdout's, percent: negative is cheaper. */
  costDeltaPct: number | null
  /** Half the width of the 99% interval round that, in points. */
  costMarginPct: number | null
  /** For a gap the data cannot yet settle: how many times as much data as so far would make the margin
   *  half the gap seen. Null when the verdict is already clear, when there is no gap to settle, and
   *  above MORE_DATA_CAP, where it is no number worth quoting. */
  moreDataFactor: number | null
  turnVerdict: TurnVerdict | null
  /** Late's retrieval-turn share minus the holdout's, in percentage points, and its margin. */
  shareDeltaPts: number | null
  shareMarginPts: number | null
}

const round = (n: number): number => Math.round(n)
/** One decimal, and never negative zero. */
const round1 = (n: number): number => { const v = Math.round(n * 10) / 10; return v === 0 ? 0 : v }
const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

function sums(groups: ArmCounts[]): { requests: number; work: number; units: number; turns: number; turnUnits: number; groups: number } {
  const s = { requests: 0, work: 0, units: 0, turns: 0, turnUnits: 0, groups: 0 }
  for (const g of groups) {
    const requests = num(g?.requests)
    s.requests += requests
    s.work += num(g?.work)
    s.units += num(g?.units)
    s.turns += num(g?.turns)
    s.turnUnits += num(g?.turnUnits)
    if (requests > 0) s.groups += 1
  }
  return s
}

function summarize(groups: ArmCounts[]): ArmSummary {
  const s = sums(groups)
  return {
    requests: s.requests,
    working: s.work,
    turns: s.turns,
    groups: s.groups,
    sharePct: s.requests > 0 ? round1((s.turns / s.requests) * 100) : null,
    turnUnitSharePct: s.units > 0 ? round1((s.turnUnits / s.units) * 100) : null,
    unitsPerRequest: s.requests > 0 ? round(s.units / s.requests) : null,
    unitsPerWorking: s.work > 0 ? round(s.units / s.work) : null,
    turnUnitsPerWorking: s.work > 0 ? round(s.turnUnits / s.work) : null,
  }
}

interface Estimate { value: number; se: number }

/**
 * A ratio of two sums over groups, its standard error from the spread of the groups: with
 * R = sum(num) / sum(den) and e_g = num_g - R den_g, var(R) = n / (n - 1) x sum(e_g^2) / sum(den)^2.
 * Every group that has requests is a group, a group with no working request included: its cost is
 * part of the arm's cost and its whole numerator is its excess.
 *
 * Null when the arm has fewer than MIN_ARM_GROUPS groups, because the spread of one or two groups
 * says nothing about the margin. Used for the share of requests that were retrieval turns, whose
 * denominator is the request count of the groups that have requests, so it cannot be nothing: the cost
 * per working request, which can, has its own estimator (logRatio).
 */
function ratio(groups: ArmCounts[], numer: (g: ArmCounts) => number, denom: (g: ArmCounts) => number): Estimate | null {
  const used = groups.filter((g) => num(g?.requests) > 0)
  if (used.length < MIN_ARM_GROUPS) return null
  let n = 0, d = 0
  for (const g of used) { n += numer(g); d += denom(g) }
  const value = n / d
  let ss = 0
  for (const g of used) { const e = numer(g) - value * denom(g); ss += e * e }
  return { value, se: Math.sqrt((used.length / (used.length - 1)) * ss) / d }
}

/**
 * ln of the same ratio, and its jackknife variance: the ratio is recomputed with each group left out
 * in turn, and the variance is (G - 1) / G times the squared spread of those G values. Null on the same
 * conditions as `ratio`, and wherever the logarithm does not exist: a ratio that is nothing, or that
 * leaving one group out makes nothing or unmeasurable (the other groups did no work, or cost nothing).
 */
function logRatio(groups: ArmCounts[], numer: (g: ArmCounts) => number, denom: (g: ArmCounts) => number): { ln: number; variance: number } | null {
  const used = groups.filter((g) => num(g?.requests) > 0)
  if (used.length < MIN_ARM_GROUPS) return null
  let n = 0, d = 0
  for (const g of used) { n += numer(g); d += denom(g) }
  if (!(d > 0) || !(n > 0)) return null
  const left: number[] = []
  for (const g of used) {
    const ln = n - numer(g), ld = d - denom(g)
    if (!(ld > 0) || !(ln > 0)) return null
    left.push(Math.log(ln / ld))
  }
  const mean = left.reduce((s, x) => s + x, 0) / left.length
  let ss = 0
  for (const x of left) ss += (x - mean) ** 2
  return { ln: Math.log(n / d), variance: ((used.length - 1) / used.length) * ss }
}

function emptyState(): ArmState {
  return { late: [], holdout: [], legacy: { requests: 0, work: 0, units: 0, turns: 0, turnUnits: 0 } }
}

/** Compare the arms. Anything that is not a ledger state reads as an empty one. */
export function compareArms(raw: ArmState | undefined): ArmComparison {
  const s = raw && Array.isArray(raw.late) && Array.isArray(raw.holdout) && raw.legacy && typeof raw.legacy === 'object' ? raw : emptyState()
  const late = summarize(s.late)
  const holdout = summarize(s.holdout)
  const legacy = summarize([s.legacy])
  const out: ArmComparison = {
    minRequests: MIN_ARM_REQUESTS, late, holdout, legacy,
    verdict: 'not-enough-data', costDeltaPct: null, costMarginPct: null, moreDataFactor: null,
    turnVerdict: null, shareDeltaPts: null, shareMarginPts: null,
  }
  if (late.requests < MIN_ARM_REQUESTS || holdout.requests < MIN_ARM_REQUESTS) return out

  // Degrees of freedom of the thinner arm. Only used where both estimates exist, and they exist
  // only with MIN_ARM_GROUPS groups on each side.
  const t = tCritical(Math.min(late.groups, holdout.groups) - 1)

  // Cost per working request, late against the holdout, on the log scale.
  const cost = (g: ArmCounts): number => num(g?.units)
  const work = (g: ArmCounts): number => num(g?.work)
  const cl = logRatio(s.late, cost, work)
  const ch = logRatio(s.holdout, cost, work)
  if (cl && ch) {
    const d = cl.ln - ch.ln
    const margin = t * Math.sqrt(cl.variance + ch.variance)
    out.costDeltaPct = round1((Math.exp(d) - 1) * 100)
    out.costMarginPct = round1(((Math.exp(d + margin) - Math.exp(d - margin)) / 2) * 100)
    out.verdict = d < -margin ? 'late-cheaper' : d > margin ? 'late-costlier' : 'no-clear-difference'
    if (out.verdict === 'no-clear-difference' && d !== 0) {
      // The margin shrinks with the square root of the data, so halving it relative to the gap takes
      // (2 x margin / gap) squared times as much.
      const factor = (2 * margin / Math.abs(d)) ** 2
      out.moreDataFactor = Number.isFinite(factor) && factor <= MORE_DATA_CAP ? Math.ceil(factor) : null
    }
  }

  // The share of requests that were retrieval turns: the round trips late was meant to take away.
  const turns = (g: ArmCounts): number => num(g?.turns)
  const requests = (g: ArmCounts): number => num(g?.requests)
  const sl = ratio(s.late, turns, requests)
  const sh = ratio(s.holdout, turns, requests)
  if (sl && sh) {
    const diff = sl.value - sh.value
    const margin = t * Math.sqrt(sl.se ** 2 + sh.se ** 2)
    out.shareDeltaPts = round1(diff * 100)
    out.shareMarginPts = round1(margin * 100)
    out.turnVerdict = diff < -margin ? 'fewer' : diff > margin ? 'more' : 'no-clear-difference'
  }
  return out
}
