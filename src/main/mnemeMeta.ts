// mnemeMeta.ts
//
// Mneme — metacognition / self-competence layer (Phase 1c of the learning
// architecture; see docs/learning-architecture.md). Folds task outcomes into
// per-domain CompetenceRecords, scores how well-FOUNDED that competence is with a
// Wilson lower bound (conservative — it under-claims until there is real evidence),
// and renders a one-line "areas I'm weak in" digest for the memory primer so the
// agent walks into a domain already knowing whether it has actually earned
// confidence there or is running on a lucky streak.
//
// PURE and injectable, exactly like memoryEconomy.ts / mnemeReflect.ts: no electron,
// no fs, no store, no LLM, and NEVER Date.now() — the clock is passed in as `now`
// so every fold is deterministic and unit-testable (the memoryEconomy/memoryGraph
// convention, see docs constraint #6). Mutable competence state is persisted
// downstream via the `{learn … competence}` delta control-line; this module only
// COMPUTES — it never writes.

/**
 * Per-domain track record. `domain` = project | entity | task-type. `confidence`
 * is the Wilson lower bound of the success rate (see {@link confidenceScore}), NOT
 * the raw ratio — it is deliberately smoothed so a thin record can't over-claim.
 */
export interface CompetenceRecord {
  domain: string
  attempts: number
  successes: number
  lastTs: number
  confidence: number
}

export type CompetenceVerdict = 'confident' | 'caution' | 'unproven'

export interface DomainAssessment {
  known: boolean
  confidence: number
  attempts: number
  verdict: CompetenceVerdict
}

// z for a ~95% two-sided normal interval. Squared once up front — in the Wilson
// formula it only ever appears as z².
const Z = 1.96
const Z2 = Z * Z

// A domain reads "confident" only above this Wilson bound AND with real evidence;
// "caution" is reserved for records that have proven weak. The gap between the two
// (0.5..0.7) is the honest "unproven / still learning" band — neither trusted nor
// condemned.
const CONFIDENT_AT = 0.7
const LOW_COMPETENCE = 0.5
const MIN_EVIDENCE = 3 // fewer attempts than this is too thin to call either way
const DEFAULT_SUMMARY_LIMIT = 3
const EPS = 1e-9 // 28/40 must read as 0.7, not as 0.7 minus a float hair

/** Branchless clamp into [0,1]. */
function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/**
 * Wilson score-interval LOWER bound of a Bernoulli success proportion at ~95%
 * (z = 1.96). Deliberately conservative: with little evidence it sits well below
 * the raw success rate (1/1 → ~0.21, not 1.0) and only climbs toward the true rate
 * as attempts accumulate — precisely the "don't trust a lucky streak" behaviour we
 * want from self-competence. Two records with the same rate but more attempts score
 * higher (a tighter bound). Returns 0 for no attempts (also guards div-by-zero) and
 * is clamped to [0,1] (a defensive no-op for valid 0 ≤ successes ≤ attempts).
 * Pure and deterministic.
 */
export function confidenceScore(successes: number, attempts: number): number {
  if (attempts <= 0) return 0 // no evidence → no earned confidence
  const n = attempts
  const phat = successes / n
  const centre = phat + Z2 / (2 * n)
  const margin = Z * Math.sqrt((phat * (1 - phat)) / n + Z2 / (4 * n * n))
  const lower = (centre - margin) / (1 + Z2 / n)
  return clamp01(lower)
}

/**
 * Fold a single outcome into a domain's record. Immutable — returns a NEW record
 * and never mutates `prev` (mirrors the store's append-only discipline). Starts a
 * fresh record when `prev` is undefined. attempts +1, successes +1 on success,
 * `lastTs` = the injected `now`, and confidence recomputed from the new totals.
 */
export function updateCompetence(
  prev: CompetenceRecord | undefined,
  domain: string,
  success: boolean,
  now: number,
): CompetenceRecord {
  const attempts = (prev?.attempts ?? 0) + 1
  const successes = (prev?.successes ?? 0) + (success ? 1 : 0)
  return { domain, attempts, successes, lastTs: now, confidence: confidenceScore(successes, attempts) }
}

/**
 * Assess how well-founded competence is in one domain. `confident` requires BOTH a
 * high Wilson bound (≥ 0.7) AND enough evidence (≥ 3 attempts); `caution` flags
 * domains with enough evidence but a low bound (< 0.5); everything else — too few
 * attempts, or the middling 0.5..0.7 band — is `unproven`. An unknown domain reads
 * as unproven with zero confidence/attempts (`known:false`). Pure.
 */
/** The observed success rate — what a reader takes "confidence" to mean. */
function rateOf(rec: { successes: number; attempts: number }): number {
  return rec.attempts > 0 ? rec.successes / rec.attempts : 0
}

/**
 * Verdict from the INTERVAL, not from one edge of it.
 *
 * The Wilson lower bound is the right tool for ranking under uncertainty and the wrong number to
 * threshold as competence. Through v1.46 the verdict compared that single edge to 0.7/0.5, so a
 * spotless 3/3 scored 0.438 and reported as "⚠ low competence (3/3 succeeded)" — a flawless record
 * rendered as a weakness. 4/5 and 7/10 read the same way, and you needed TEN consecutive wins to
 * clear "confident". An agent that distrusts the areas it is actually good at is worse calibrated
 * than one with no self-model at all.
 *
 * A wide interval means we do not know YET — that is `unproven`. So:
 *   caution    you succeed less than half the time here, over a real sample.
 *   confident  even the PESSIMISTIC edge of the interval clears half, and the observed rate
 *              clears the bar — a track record, not a lucky streak.
 *   unproven   everything else: too thin to call, or genuinely middling.
 *
 * `caution` is deliberately the SAME rule summarizeCompetence warns on, so the verdict for a domain
 * and the warnings digest can never disagree about it.
 */
export function assessDomain(records: CompetenceRecord[], domain: string): DomainAssessment {
  const rec = records.find((r) => r.domain === domain)
  if (!rec) return { known: false, confidence: 0, attempts: 0, verdict: 'unproven' }
  const rate = rateOf(rec)
  const lower = confidenceScore(rec.successes, rec.attempts)
  const enough = rec.attempts >= MIN_EVIDENCE
  const verdict: CompetenceVerdict =
    !enough
      ? 'unproven'
      : rate < LOW_COMPETENCE
        ? 'caution'
        : lower >= LOW_COMPETENCE && rate >= CONFIDENT_AT - EPS
          ? 'confident'
          : 'unproven'
  return { known: true, confidence: rate, attempts: rec.attempts, verdict }
}

/**
 * One-line-per-domain digest of the WEAKEST domains, for injection into the memory
 * primer so the agent starts a session already knowing where it hasn't earned trust.
 * Surfaces only genuinely low-competence domains (Wilson bound < 0.5 — a mastered
 * domain has no business in a "low competence" warning) that ALSO clear MIN_EVIDENCE,
 * the very gate {@link assessDomain} applies before it will say 'caution'. Without the
 * evidence half the conservatism of the bound backfires: a domain tried once and
 * succeeded scores ~0.21, so the primer opened with "⚠ low competence in termpolis
 * (1/1 succeeded)" — condemning a domain that had never once failed. Weakest first:
 * confidence ascending, then attempts descending (more evidence of weakness ranks
 * higher on a tie). Capped at `limit` (default 3, negatives coerced to 0). Empty,
 * all-competent or all-too-thin input → '' (nothing to warn about). Pure and
 * deterministic.
 */
/**
 * A one-line answer about the domain that was ASKED about.
 *
 * memory_selfcheck's summary used to be the fleet-wide warnings digest, so asking about
 * `termpolis` could come back "⚠ low competence in mesh (3/3 succeeded)" — a warning about a
 * different domain, and (before the calibration fix above) a false one. An answer about something
 * you did not ask about teaches the reader to skip the answer.
 */
export function describeCompetence(records: CompetenceRecord[], domain: string): string {
  const a = assessDomain(records, domain)
  if (!a.known) return `no track record in ${domain} yet — treat as unproven and verify`
  const rec = records.find((r) => r.domain === domain)!
  const ev = `${rec.successes}/${rec.attempts} succeeded`
  if (a.verdict === 'caution') return `⚠ low competence in ${domain} (${ev})`
  if (a.verdict === 'confident') return `proven in ${domain} (${ev})`
  return `unproven in ${domain} (${ev}) — too little evidence to call either way`
}

export function summarizeCompetence(
  records: CompetenceRecord[],
  limit: number = DEFAULT_SUMMARY_LIMIT,
): string {
  // Weak means "you succeed less than half the time here, over a real sample" — an OBSERVED rate,
  // not an interval edge. Filtering on the stored Wilson lower bound put spotless records in the
  // warnings list, which is the fastest way to teach an agent to ignore the warnings list.
  return records
    .filter((r) => r.attempts >= MIN_EVIDENCE && rateOf(r) < LOW_COMPETENCE)
    .sort((a, b) => rateOf(a) - rateOf(b) || b.attempts - a.attempts)
    .slice(0, Math.max(0, limit))
    .map((r) => `⚠ low competence in ${r.domain} (${r.successes}/${r.attempts} succeeded)`)
    .join('\n')
}
