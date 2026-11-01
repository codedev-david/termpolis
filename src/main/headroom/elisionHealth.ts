import { elisionState, recentByClass, ELISION_WINDOW, type ClassCounts, type ElisionState } from './elisionLedger'
import { parseClassKey, type ElisionKind, type SizeBand, type ToolClass } from './elisionMeta'
import type { FirstSightPolicy } from './elisionPolicy'
import { armState, type ArmState } from './armLedger'
import { compareArms, type ArmComparison } from './armCompare'
import { summarizeProxySavings, stubKindsOf } from '../headroomProxy/proxyLedger'
import { getProxyFirstSight } from '../headroomProxy/proxySupervisor'

/**
 * The "Elision health" view: for each class of result the proxy elides, how often the model asked
 * for the text back, and whether eliding it at first sight pays at that rate.
 *
 * Eliding a result of S tokens at first sight saves B = (1 - rho) x S x W billed units when the
 * model never needs it (rho is the share left in the view, W what a token costs the session while
 * it stays in the prefix). When the model asks for it back it costs a whole extra turn, E (the
 * cached prefix read again, measured by the ledger), plus V, the view that stays resident. So at a
 * redemption rate r the net per result is (1 - r) x B - r x (E + V), and eliding pays while r stays
 * under the break-even B / (B + E + V). The research measured r at 13% until late August and 66%
 * since; below roughly 40,000 characters almost no class of Read, Bash or Grep result cleared
 * break-even at 66% (Grep and PowerShell between 10,000 and 40,000 characters came close, and a
 * retrieval cheaper than the average one would have tipped them).
 *
 * The verdict is about the policy in force. Under `late` the proxy shortens a result at first sight only
 * from 40,000 characters, so nearly all of the compactions in the ledger are the conversations held
 * out on the old behaviour, which shorten everything over the tier floor. Judging them together would
 * tell a user running Late that Late costs what the holdout costs. So the compactions of each policy are
 * judged on their own: the one in force is the verdict, and the other is reported beside it.
 *
 * Everything here is an ESTIMATE built on two stated constants; the counts and the rates are
 * measured. Pure, and clock-free like everything under src/main/headroom.
 */

/** Fewer elisions than this in a class and its rate is noise: no verdict is given. */
export const MIN_SAMPLES = 30
/** Billed units one token costs a session while it stays in the cached prefix: its cache write plus
 *  a tenth of a unit for each response that re-reads it. Measured 9.8 (Grep) to 12.7 (Read) units
 *  per token in the research (section 5.6); the midpoint is used for every tool. */
export const UNITS_PER_KEPT_TOKEN = 11
/** What one extra retrieval turn costs when the ledger has not seen enough of them to measure it:
 *  16.8k billed units, the research's measurement over 71,958 turns (section 5.1). */
export const ASSUMED_TURN_UNITS = 16_800
/** Pure retrieval turns the ledger needs before its own cost per turn replaces the assumption. */
export const MIN_TURNS_MEASURED = 20
/** The app's convention everywhere (wire layer, ledger): four characters to a token. */
export const CHARS_PER_TOKEN = 4
/** Percentage points the recent rate must sit from the all-time one to be called a change of regime. */
export const REGIME_GAP_POINTS = 10

export type HealthVerdict = 'pays' | 'costs' | 'unknown'

export interface ElisionClassView {
  key: string
  kind: ElisionKind
  tool: ToolClass
  band: SizeBand
  /** The first-sight policy this class was made under: `late`, or `legacy` for the old behaviour (which
   *  is also what a class that is not a compaction reports, because it is made the same either way). */
  policy: FirstSightPolicy
  /** Lifetime counts. `ratePct` is null with nothing elided in the class. */
  elided: number
  redeemed: number
  ratePct: number | null
  /** The same over the last ELISION_WINDOW elisions of this run. */
  recentElided: number
  recentRedeemed: number
  recentRatePct: number | null
  /** The redemption rate above which eliding this class at first sight loses, in percent. Only for
   *  first-sight compaction, the choice a policy can change; null for the other kinds. */
  breakEvenPct: number | null
  /** Net billed units per 1,000 results at the observed rate; positive pays. Null with no verdict. */
  netUnitsPer1000: number | null
  verdict: HealthVerdict
  /** Which counts the verdict used: the recent window when it has MIN_SAMPLES, else all time. */
  basis: 'recent' | 'all-time' | null
}

/** First-sight compaction as a whole, for the compactions of one policy. */
export interface FirstSightSummary {
  verdict: HealthVerdict
  basis: 'recent' | 'all-time' | null
  /** Results the verdict rests on, their redemption rate, and the elided-weighted break-even. */
  elided: number
  ratePct: number | null
  breakEvenPct: number | null
  /** Estimated billed units gained (positive) or lost over those results. */
  netUnits: number
}

export interface ElisionHealthView {
  windowSize: number
  classes: ElisionClassView[]
  elided: number
  redeemed: number
  /** Redemptions of results elided before the ledger existed, or in an earlier launch of the app,
   *  which no class can claim. */
  legacyRedeemed: number
  recentElided: number
  recentRedeemed: number
  /** First-sight compaction under the policy in force: the one decision R2 changes. */
  firstSight: FirstSightSummary & { policy: FirstSightPolicy }
  /** The same for the old behaviour when the policy in force is `late`: the conversations held out on
   *  it. Null under the Legacy setting, where the old behaviour is the policy in force. */
  oldBehaviour: FirstSightSummary | null
  /** Whether the recent redemption rate of the policy in force has moved away from its all-time one. */
  regime: 'rising' | 'falling' | 'steady' | 'unknown'
  turns: {
    /** Asks for elided text back, and what they cost in billed units. An ask is the turn that called
     *  retrieve_full; when the tool had to be loaded through ToolSearch first, that turn's cost is
     *  in `units` too and the ask still counts once. */
    count: number
    units: number
    /** Billed units per ask: the ledger's own once it has MIN_TURNS_MEASURED, else the research's. */
    unitsPerTurn: number
    costBasis: 'measured' | 'assumed'
    /** Of the asks, how many were two turns because the tool had to be loaded first. */
    hops: number
    /** Responses whose shape was read. */
    observed: number
    /** Of the responses to a request that completed: those on which the model could ask for text back
     *  (retrieve_full listed, or loadable through ToolSearch), and those on which it could not. */
    askable: number
    unaskable: number
    /** What `sharePct` is a share of: the requests that could ask, or, for a ledger that has not
     *  counted those, every response whose shape was read. */
    shareBasis: 'could-ask' | 'responses'
    sharePct: number | null
  }
  /**
   * The late policy against the conversations held out on the old behaviour: did leaving results
   * whole cost less, and did it need fewer retrieval turns? See armCompare.ts. This is the check
   * that the saving the research modelled is real on this person's own work and did not cost the
   * model anything: a plain verdict, "not enough data yet" until there is some.
   */
  arms: ArmComparison
  /** Aged-out stubs found in conversations too short for the decay pass to have made them (research
   *  section 9): requests that carried at least one, and how many stubs. Zero is the expected answer. */
  agedEarly: { requests: number; stubs: number }
}

export interface ElisionHealthInput {
  state: ElisionState
  recent: Map<string, ClassCounts>
  turns: {
    retrievalTurns?: number; retrievalTurnUnits?: number; retrievalHops?: number; turnRequests?: number
    offerDirect?: number; offerDeferred?: number; offerAbsent?: number
  }
  /** The first-sight policy this run uses. Absent reads as `legacy`, what a process runs until told otherwise. */
  policy?: FirstSightPolicy
  /** The arm ledger; absent reads as empty. */
  arms?: ArmState
  /** The stub-kind tally's early aged-out counters; absent reads as zero. */
  agedEarly?: { requests?: number; stubs?: number }
}

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)
const pct1 = (part: number, whole: number): number | null => (whole > 0 ? Math.round(Math.min(1, part / whole) * 1000) / 10 : null)

/** Net units for ONE result of this class at redemption rate `r`, and the break-even rate. */
function economics(c: ClassCounts, r: number, turnUnits: number): { net: number; breakEven: number } {
  const meanChars = c.chars / c.elided
  const meanView = Math.min(c.view / c.elided, meanChars)
  const kept = (meanChars - meanView) / CHARS_PER_TOKEN
  const viewTokens = meanView / CHARS_PER_TOKEN
  const saved = kept * UNITS_PER_KEPT_TOKEN // B
  const resident = viewTokens * UNITS_PER_KEPT_TOKEN // V
  const cost = turnUnits + resident // E + V
  const denom = saved + cost
  return { net: (1 - r) * saved - r * cost, breakEven: denom > 0 ? saved / denom : 0 }
}

/** What the verdict of one policy is made from, summed over its compaction classes. */
interface Agg { elided: number; redeemed: number; net: number; breakEvenWeighted: number; fromRecent: number; fromAll: number }
const newAgg = (): Agg => ({ elided: 0, redeemed: 0, net: 0, breakEvenWeighted: 0, fromRecent: 0, fromAll: 0 })

function summarize(a: Agg): FirstSightSummary {
  return {
    verdict: a.elided === 0 ? 'unknown' : a.net > 0 ? 'pays' : 'costs',
    // The overall verdict rests on whichever counts most of its results came from.
    basis: a.elided === 0 ? null : a.fromRecent >= a.fromAll ? 'recent' : 'all-time',
    elided: a.elided,
    ratePct: pct1(a.redeemed, a.elided),
    breakEvenPct: a.elided > 0 ? Math.round((a.breakEvenWeighted / a.elided) * 1000) / 10 : null,
    netUnits: Math.round(a.net),
  }
}

export function buildElisionHealth(input: ElisionHealthInput): ElisionHealthView {
  const turnCount = num(input.turns.retrievalTurns)
  const turnUnits = num(input.turns.retrievalTurnUnits)
  const measured = turnCount >= MIN_TURNS_MEASURED
  const unitsPerTurn = measured ? turnUnits / turnCount : ASSUMED_TURN_UNITS
  const observed = num(input.turns.turnRequests)
  // A rate of asking is taken over the requests that could ask: a request with no way to call
  // retrieve_full says nothing about whether the model would have. A ledger that has not counted
  // them yet (all three zero) falls back to every response read.
  const askable = num(input.turns.offerDirect) + num(input.turns.offerDeferred)
  const unaskable = num(input.turns.offerAbsent)
  const couldAsk = askable > 0
  const inForce: FirstSightPolicy = input.policy === 'late' ? 'late' : 'legacy'

  const classes: ElisionClassView[] = []
  // The compactions of each policy, judged on their own.
  const aggs: Record<FirstSightPolicy, Agg> = { late: newAgg(), legacy: newAgg() }
  let lifeElided = 0, lifeRedeemed = 0, recentElided = 0, recentRedeemed = 0
  // The regime is read from the policy in force only: a pool of both moves whenever the setting does.
  let compactLifeElided = 0, compactLifeRedeemed = 0, compactRecentElided = 0, compactRecentRedeemed = 0

  for (const [key, life] of Object.entries(input.state.classes)) {
    const parsed = parseClassKey(key)
    if (!parsed) continue
    const rec = input.recent.get(key)
    const re = rec?.elided ?? 0
    const rr = rec?.redeemed ?? 0
    lifeElided += life.elided
    lifeRedeemed += life.redeemed
    recentElided += re
    recentRedeemed += rr
    let verdict: HealthVerdict = 'unknown'
    let basis: ElisionClassView['basis'] = null
    let breakEvenPct: number | null = null
    let netUnitsPer1000: number | null = null
    if (parsed.kind === 'compact') {
      if (parsed.policy === inForce) {
        compactLifeElided += life.elided
        compactLifeRedeemed += life.redeemed
        compactRecentElided += re
        compactRecentRedeemed += rr
      }
      const use = rec && re >= MIN_SAMPLES ? { c: rec, why: 'recent' as const } : life.elided >= MIN_SAMPLES ? { c: life, why: 'all-time' as const } : null
      if (use) {
        const r = Math.min(1, use.c.redeemed / use.c.elided)
        const e = economics(use.c, r, unitsPerTurn)
        basis = use.why
        breakEvenPct = Math.round(e.breakEven * 1000) / 10
        netUnitsPer1000 = Math.round(e.net * 1000)
        verdict = e.net > 0 ? 'pays' : 'costs'
        const a = aggs[parsed.policy]
        a.elided += use.c.elided
        a.redeemed += use.c.redeemed
        a.net += e.net * use.c.elided
        a.breakEvenWeighted += e.breakEven * use.c.elided
        if (use.why === 'recent') a.fromRecent += use.c.elided
        else a.fromAll += use.c.elided
      }
    }
    classes.push({
      key, kind: parsed.kind, tool: parsed.tool, band: parsed.band, policy: parsed.policy,
      elided: life.elided, redeemed: life.redeemed, ratePct: pct1(life.redeemed, life.elided),
      recentElided: re, recentRedeemed: rr, recentRatePct: pct1(rr, re),
      breakEvenPct, netUnitsPer1000, verdict, basis,
    })
  }
  classes.sort((a, b) => b.elided - a.elided || (a.key < b.key ? -1 : 1))

  let regime: ElisionHealthView['regime'] = 'unknown'
  if (compactRecentElided >= MIN_SAMPLES && compactLifeElided >= MIN_SAMPLES) {
    const recentRate = (compactRecentRedeemed / compactRecentElided) * 100
    const lifeRate = (compactLifeRedeemed / compactLifeElided) * 100
    regime = recentRate - lifeRate >= REGIME_GAP_POINTS ? 'rising' : lifeRate - recentRate >= REGIME_GAP_POINTS ? 'falling' : 'steady'
  }

  return {
    windowSize: ELISION_WINDOW,
    classes,
    elided: lifeElided,
    redeemed: lifeRedeemed,
    legacyRedeemed: input.state.legacyRedeemed,
    recentElided,
    recentRedeemed,
    firstSight: { policy: inForce, ...summarize(aggs[inForce]) },
    oldBehaviour: inForce === 'late' ? summarize(aggs.legacy) : null,
    regime,
    turns: {
      count: turnCount,
      units: turnUnits,
      unitsPerTurn: Math.round(unitsPerTurn),
      costBasis: measured ? 'measured' : 'assumed',
      hops: num(input.turns.retrievalHops),
      observed,
      askable,
      unaskable,
      shareBasis: couldAsk ? 'could-ask' : 'responses',
      sharePct: pct1(turnCount, couldAsk ? askable : observed),
    },
    arms: compareArms(input.arms),
    agedEarly: { requests: num(input.agedEarly?.requests), stubs: num(input.agedEarly?.stubs) },
  }
}

/** The live view: the elision ledger's counts and window, with the proxy ledger's retrieval turns and
 *  the policy this run really uses (which Settings may have since been changed away from). */
export function summarizeElisionHealth(): ElisionHealthView {
  const c = summarizeProxySavings().cumulative
  const kinds = stubKindsOf(c)
  return buildElisionHealth({
    state: elisionState(), recent: recentByClass(), turns: c, arms: armState(), policy: getProxyFirstSight(),
    agedEarly: { requests: kinds.agedEarlyRequests, stubs: kinds.agedEarly },
  })
}
