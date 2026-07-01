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
export function assessDomain(records: CompetenceRecord[], domain: string): DomainAssessment {
  const rec = records.find((r) => r.domain === domain)
  if (!rec) return { known: false, confidence: 0, attempts: 0, verdict: 'unproven' }
  const verdict: CompetenceVerdict =
    rec.confidence >= CONFIDENT_AT && rec.attempts >= MIN_EVIDENCE
      ? 'confident'
      : rec.attempts >= MIN_EVIDENCE && rec.confidence < LOW_COMPETENCE
        ? 'caution'
        : 'unproven'
  return { known: true, confidence: rec.confidence, attempts: rec.attempts, verdict }
}

/**
 * One-line-per-domain digest of the WEAKEST domains, for injection into the memory
 * primer so the agent starts a session already knowing where it hasn't earned trust.
 * Surfaces only genuinely low-competence domains (Wilson bound < 0.5 — a mastered
 * domain has no business in a "low competence" warning), weakest first: confidence
 * ascending, then attempts descending (more evidence of weakness ranks higher on a
 * tie). Capped at `limit` (default 3, negatives coerced to 0). Empty or all-competent
 * input → '' (nothing to warn about). Pure and deterministic.
 */
export function summarizeCompetence(
  records: CompetenceRecord[],
  limit: number = DEFAULT_SUMMARY_LIMIT,
): string {
  return records
    .filter((r) => r.confidence < LOW_COMPETENCE)
    .sort((a, b) => a.confidence - b.confidence || b.attempts - a.attempts)
    .slice(0, Math.max(0, limit))
    .map((r) => `⚠ low competence in ${r.domain} (${r.successes}/${r.attempts} succeeded)`)
    .join('\n')
}
