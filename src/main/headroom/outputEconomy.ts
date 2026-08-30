// headroom/outputEconomy.ts
//
// The other half of the bill.
//
// WHAT THE LEDGER ACTUALLY SAYS. Weighting the measured lifetime counters by
// Anthropic's published multipliers (cache read 0.1x, cache write 1.25x, output 5x
// input) splits the spend roughly:
//
//     cache reads   ~51%      <- what compression works on
//     output        ~30%      <- untouched
//     cache writes  ~18%
//     fresh input    ~1%
//
// Every Headroom release so far has worked the input side, and the last one found the
// remaining input ideas were dead ends: floor tuning, cache-write placement and prefix
// coverage all measured negative or negligible (v1.36/v1.37). That is not a failure of
// imagination — it is the input side approaching its floor after a 51% reduction. The
// unexamined 30% is output, and output is the EXPENSIVE token: one output token costs
// what fifty cached input tokens cost.
//
// WHY THIS MODULE IS MOSTLY STATISTICS. Output cannot be compressed — the model emits
// it. It can only be *steered*, and the app already steers: `outputSteering` asks for
// terser answers. The problem is that its measured effect is unknowable as recorded.
// The ledger holds steered and unsteered request counts, but assignment was never
// randomised — steering applies to a particular KIND of request — so the two averages
// describe two different populations. On the observed counters the steered average is
// slightly HIGHER (~557 vs ~516 tokens/request), which under confounding is equally
// consistent with steering helping, doing nothing, or hurting. There is no way to tell,
// and shipping more steering on top of a number that cannot distinguish those is how a
// placebo becomes permanent.
//
// So: a real experiment. Deterministic randomised holdout, variance tracked, a verdict
// that refuses to speak before it has the samples, and an explicit 'hurting' outcome
// that turns the feature OFF. This is built to be able to say the feature is worthless.

/** Effective-unit weight of one output token, relative to an uncached input token.
 *  Constant across the Claude line ($3/$15 Sonnet, $15/$75 Opus). */
export const OUTPUT_WEIGHT = 5.0

/** Share of requests held out unsteered. 10% is the smallest split that reaches
 *  significance in reasonable time while costing almost nothing: the holdout is only
 *  "expensive" if steering works, and if it works the experiment ends and the holdout
 *  shrinks to zero. */
export const HOLDOUT_RATE = 0.1

/** Minimum samples per arm before any verdict. Output length is heavy-tailed — one
 *  long refactor answer swamps fifty short ones — so an early verdict is noise with a
 *  decimal point on it. */
export const MIN_SAMPLES_PER_ARM = 200

export type Arm = 'steered' | 'holdout'

/** Deterministic arm assignment from a stable request key.
 *
 *  MUST be deterministic, never RNG-based: a retried or resumed request has to land
 *  in the same arm, or its output is counted in one arm having been generated under the
 *  other — which biases exactly the comparison the holdout exists to make. FNV-1a over
 *  the key gives a stable, well-distributed bucket with no state to persist. */
export function assignArm(key: string, rate = HOLDOUT_RATE): Arm {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0xffffffff < rate ? 'holdout' : 'steered'
}

export interface ArmStats {
  n: number
  sum: number
  /** Sum of squares, for variance. Kept incrementally so no sample history is retained. */
  sumSq: number
}

export interface OutputExperiment {
  steered: ArmStats
  holdout: ArmStats
}

export function emptyExperiment(): OutputExperiment {
  return { steered: { n: 0, sum: 0, sumSq: 0 }, holdout: { n: 0, sum: 0, sumSq: 0 } }
}

export function recordOutput(experiment: OutputExperiment, arm: Arm, outputTokens: number): void {
  // Guard non-finite and negative: a malformed usage block would otherwise poison the
  // running variance permanently, and there is no way to remove a bad sample later.
  if (!Number.isFinite(outputTokens) || outputTokens < 0) return
  const stats = experiment[arm]
  stats.n++
  stats.sum += outputTokens
  stats.sumSq += outputTokens * outputTokens
}

export function mean(stats: ArmStats): number {
  return stats.n > 0 ? stats.sum / stats.n : 0
}

/** Sample variance (Bessel-corrected). Clamped at zero: catastrophic cancellation in
 *  the sum-of-squares form can produce a tiny negative for near-constant samples. */
export function variance(stats: ArmStats): number {
  if (stats.n < 2) return 0
  const m = mean(stats)
  return Math.max(0, (stats.sumSq - stats.n * m * m) / (stats.n - 1))
}

export type SteeringVerdict = 'insufficient' | 'helping' | 'neutral' | 'hurting'

export interface SteeringAssessment {
  verdict: SteeringVerdict
  /** Mean output tokens saved per request by steering. Negative means it costs. */
  deltaPerRequest: number
  /** Welch's t statistic; |t| > 1.96 is significant at ~95% for these sample sizes. */
  t: number
  steeredMean: number
  holdoutMean: number
  n: { steered: number; holdout: number }
  summary: string
}

/** 95% two-sided threshold, normal approximation. Valid because MIN_SAMPLES_PER_ARM is
 *  200 per arm, far past where the t-distribution and the normal agree to three decimals. */
export const T_CRITICAL = 1.96

export function assessSteering(experiment: OutputExperiment): SteeringAssessment {
  const { steered, holdout } = experiment
  const steeredMean = mean(steered)
  const holdoutMean = mean(holdout)
  const delta = holdoutMean - steeredMean // positive = steering saves output
  const n = { steered: steered.n, holdout: holdout.n }

  if (steered.n < MIN_SAMPLES_PER_ARM || holdout.n < MIN_SAMPLES_PER_ARM) {
    return {
      verdict: 'insufficient',
      deltaPerRequest: delta,
      t: 0,
      steeredMean,
      holdoutMean,
      n,
      summary: `need ${MIN_SAMPLES_PER_ARM} per arm; have ${steered.n} steered / ${holdout.n} holdout`,
    }
  }

  // Welch's t — unequal variances, which is the realistic assumption: steering changes
  // the spread of answer lengths, not only the centre.
  const se = Math.sqrt(variance(steered) / steered.n + variance(holdout) / holdout.n)
  const t = se > 0 ? delta / se : 0

  let verdict: SteeringVerdict = 'neutral'
  if (t > T_CRITICAL) verdict = 'helping'
  else if (t < -T_CRITICAL) verdict = 'hurting'

  const pctChange = holdoutMean > 0 ? (delta / holdoutMean) * 100 : 0
  const summary =
    verdict === 'helping'
      ? `steering saves ${delta.toFixed(0)} output tokens/request (${pctChange.toFixed(1)}%), t=${t.toFixed(2)}`
      : verdict === 'hurting'
        ? `steering COSTS ${(-delta).toFixed(0)} output tokens/request, t=${t.toFixed(2)} — recommend disabling`
        : `no measurable effect (delta ${delta.toFixed(0)} tokens/request, t=${t.toFixed(2)})`

  return { verdict, deltaPerRequest: delta, t, steeredMean, holdoutMean, n, summary }
}

/** Effective units saved per 1,000 requests if the measured effect is real.
 *  Reported in the same units as the rest of the receipt so output-side and input-side
 *  wins are directly comparable rather than each impressive on its own scale. */
export function projectedOutputSaving(assessment: SteeringAssessment, requests = 1000): number {
  if (assessment.verdict !== 'helping') return 0
  return assessment.deltaPerRequest * requests * OUTPUT_WEIGHT
}

// ---------------------------------------------------------------------------
// Thinking budget
// ---------------------------------------------------------------------------

/** Extended thinking is billed as OUTPUT — at 5x — and the app ships with the cap at 0,
 *  meaning uncapped. That is the single largest untouched line item in the ledger.
 *
 *  It is also the one where a naive cap is actively harmful: thinking is not waste, and
 *  cutting it can cost more than it saves when the model then needs extra TURNS to
 *  reach the same answer, each turn re-reading the whole cached prefix. So the decision
 *  is never "is thinking expensive" (it is) but "does spending it here avoid more spend
 *  later", and that has to be measured per band rather than assumed. */
export interface ThinkingBand {
  /** Requests observed with a thinking budget in this band. */
  requests: number
  /** Mean OUTPUT tokens produced at this budget.
   *
   *  Output, not thinking-in-isolation: the API bills thinking inside `output_tokens` and
   *  never reports it separately, so isolating it would mean estimating it. Total output is
   *  both exactly measurable and the quantity that actually carries the 5x weight, and the
   *  comparison across bands stays valid because every band is counted the same way. */
  meanOutputTokens: number
  /** Mean conversation depth at those requests. A budget that resolves things in one pass
   *  shows up here as a shallower mean; one that leaves the model to ask again shows up as
   *  a deeper one. This is the term that stops a cap from looking free. */
  meanTurns: number
  /** Mean cached-prefix size at those requests — what one more turn costs to re-read. */
  meanPrefixTokens: number
}

export interface ThinkingVerdict {
  /** Effective units one request in this band costs in output. */
  outputCost: number
  /** Effective units the conversation depth it implies costs in cached re-reads. */
  turnCost: number
  totalCost: number
}

/** Cost a band in effective units. A turn costs its cached prefix re-read at 0.1x, which
 *  is what makes "one more turn" so much cheaper than intuition suggests and why
 *  aggressive thinking caps usually lose. */
export function costThinkingBand(band: ThinkingBand): ThinkingVerdict {
  const outputCost = band.meanOutputTokens * OUTPUT_WEIGHT
  const turnCost = band.meanTurns * band.meanPrefixTokens * 0.1
  return { outputCost, turnCost, totalCost: outputCost + turnCost }
}

export interface ThinkingRecommendation {
  /** Recommended cap in tokens, or null to leave uncapped. */
  cap: number | null
  reason: string
  /** Effective units saved per request versus the most expensive band observed. */
  savingPerRequest: number
}

/** Anthropic's floor. A budget below this is an invalid request, so it can never be
 *  recommended however good the arithmetic looks. */
export const THINKING_MIN_BUDGET = 1024

/** Pick the cheapest band by TOTAL cost, thinking plus the follow-up turns it implies.
 *
 *  Bands are keyed by their budget. A recommendation is emitted only when the cheapest
 *  band is meaningfully cheaper than the status quo, because re-capping for a 1% model
 *  difference is churn, not a saving. */
export const MIN_BAND_REQUESTS = 50
export const MIN_RELATIVE_GAIN = 0.05

export function recommendThinkingCap(
  bands: Map<number, ThinkingBand>,
  currentCap: number | null,
): ThinkingRecommendation {
  const usable = [...bands.entries()].filter(([budget, band]) => band.requests >= MIN_BAND_REQUESTS && budget >= THINKING_MIN_BUDGET)
  if (usable.length < 2) {
    return { cap: currentCap, reason: `need ${MIN_BAND_REQUESTS}+ requests in 2+ budget bands; have ${usable.length}`, savingPerRequest: 0 }
  }

  const costed = usable
    .map(([budget, band]) => ({ budget, band, cost: costThinkingBand(band).totalCost }))
    .sort((a, b) => a.cost - b.cost || a.budget - b.budget)

  const best = costed[0]
  const worst = costed[costed.length - 1]
  const saving = worst.cost - best.cost
  const relative = worst.cost > 0 ? saving / worst.cost : 0

  if (relative < MIN_RELATIVE_GAIN) {
    return { cap: currentCap, reason: `no band is >${Math.round(MIN_RELATIVE_GAIN * 100)}% cheaper; thinking budget is not the lever here`, savingPerRequest: 0 }
  }
  if (currentCap !== null && best.budget >= currentCap) {
    return { cap: currentCap, reason: `current cap ${currentCap} is already at or below the cheapest band`, savingPerRequest: 0 }
  }
  return {
    cap: best.budget,
    reason: `budget ${best.budget} costs ${best.cost.toFixed(0)} effective units/request vs ${worst.cost.toFixed(0)} at ${worst.budget} — ${Math.round(relative * 100)}% cheaper once follow-up turns are counted`,
    savingPerRequest: saving,
  }
}

export function formatOutputEconomy(assessment: SteeringAssessment, thinking: ThinkingRecommendation): string {
  return [
    'Output economy — the ~30% of the bill compression cannot reach',
    `  steering: ${assessment.summary}`,
    `  arms:     ${assessment.n.steered} steered (mean ${assessment.steeredMean.toFixed(0)}) / ${assessment.n.holdout} holdout (mean ${assessment.holdoutMean.toFixed(0)})`,
    `  thinking: ${thinking.cap === null ? 'uncapped' : `cap ${thinking.cap}`} — ${thinking.reason}`,
  ].join('\n')
}
