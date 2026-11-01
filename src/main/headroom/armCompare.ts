import type { ArmCounts, ArmState } from './armLedger'

/**
 * Late against the holdout: did leaving results whole cost less, and did it need fewer retrieval
 * turns? The research modelled a saving of about 11.7% from one history. This is how the same
 * question is asked of the user's own work, with the uncertainty stated and a verdict that says
 * "not enough data yet" until there is some.
 *
 * Three decisions carry it:
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
 *    groups by the same hash that chose the arm (elisionPolicy.ts armOf), and the standard error is
 *    the spread of the groups: a ratio estimator linearised around the pooled ratio, with a
 *    t quantile for the number of groups.
 *
 *  - IT SAYS NOTHING EARLY. Fewer than 500 requests in either arm, or requests from fewer than five
 *    groups, is "not enough data yet", not a verdict with a wide margin.
 *
 * Pure: no I/O, no clock.
 */

/** Fewer requests than this in either arm and no verdict is given. */
export const MIN_ARM_REQUESTS = 500
/** Fewer groups of conversations than this in either arm and the margin cannot be measured. */
export const MIN_ARM_GROUPS = 5

/** Two-sided 95% quantiles of the t distribution for 1 to 30 degrees of freedom. */
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131,
  2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
]
/** With no degrees of freedom there is no margin to speak of, so nothing can clear it. */
export function tCritical(df: number): number {
  if (!(df >= 1)) return Number.POSITIVE_INFINITY
  return df <= T95.length ? T95[Math.floor(df) - 1] : 1.96
}

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
  /** Half the width of the 95% interval round that, in points. */
  costMarginPct: number | null
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
 * says nothing about the margin, or when the denominator is nothing (an arm that did no work).
 */
function ratio(groups: ArmCounts[], numer: (g: ArmCounts) => number, denom: (g: ArmCounts) => number): Estimate | null {
  const used = groups.filter((g) => num(g?.requests) > 0)
  if (used.length < MIN_ARM_GROUPS) return null
  let n = 0, d = 0
  for (const g of used) { n += numer(g); d += denom(g) }
  if (!(d > 0)) return null
  const value = n / d
  let ss = 0
  for (const g of used) { const e = numer(g) - value * denom(g); ss += e * e }
  return { value, se: Math.sqrt((used.length / (used.length - 1)) * ss) / d }
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
    verdict: 'not-enough-data', costDeltaPct: null, costMarginPct: null,
    turnVerdict: null, shareDeltaPts: null, shareMarginPts: null,
  }
  if (late.requests < MIN_ARM_REQUESTS || holdout.requests < MIN_ARM_REQUESTS) return out

  // Degrees of freedom of the thinner arm. Only used where both estimates exist, and they exist
  // only with MIN_ARM_GROUPS groups on each side.
  const t = tCritical(Math.min(late.groups, holdout.groups) - 1)

  // Cost per working request, late against the holdout.
  const cost = (g: ArmCounts): number => num(g?.units)
  const work = (g: ArmCounts): number => num(g?.work)
  const cl = ratio(s.late, cost, work)
  const ch = ratio(s.holdout, cost, work)
  if (cl && ch && ch.value > 0) {
    const rel = cl.value / ch.value - 1
    const se = Math.sqrt((cl.se / ch.value) ** 2 + ((cl.value * ch.se) / (ch.value * ch.value)) ** 2)
    const margin = t * se
    out.costDeltaPct = round1(rel * 100)
    out.costMarginPct = round1(margin * 100)
    out.verdict = rel < -margin ? 'late-cheaper' : rel > margin ? 'late-costlier' : 'no-clear-difference'
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
