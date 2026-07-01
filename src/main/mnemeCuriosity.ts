// mnemeCuriosity.ts
//
// Mneme — the limbic / drive layer (Phase 5 of the learning architecture; see
// docs/learning-architecture.md §P5). Metacognition (`mnemeMeta`) tells the agent
// where it is WEAK; curiosity turns that into an agenda: the domains it fails at
// *often* are exactly the ones worth deliberately exploring. This module reads the
// per-domain CompetenceRecords and surfaces the highest-value knowledge GAPS —
// frequent-and-weak first — plus short exploration prompts for the memory primer.
//
// PURE and injectable, exactly like mnemeMeta.ts / memoryEconomy.ts: no electron,
// no fs, no store, no LLM, and NEVER Date.now() (the `now` clock, when needed, is
// passed in) — so every ranking is deterministic and unit-testable. This module only
// COMPUTES an agenda; acting on it (writing memories, launching exploration) is wiring.

import type { CompetenceRecord } from './mnemeMeta'

/**
 * A knowledge gap worth exploring. `priority` fuses frequency and weakness —
 * `attempts × (1 - confidence)` — so a domain the agent keeps bumping into AND keeps
 * failing at outranks a rarely-touched one. `confidence` is the record's stored
 * (Wilson-smoothed) competence, `attempts` its evidence count.
 */
export interface Gap {
  domain: string
  confidence: number
  attempts: number
  priority: number
}

interface FindGapsOptions {
  /** Minimum evidence before a domain is worth exploring (default 2). */
  minAttempts?: number
  /** Only domains at or below this competence count as a gap (default 0.5). */
  maxConfidence?: number
}

const DEFAULT_MIN_ATTEMPTS = 2
const DEFAULT_MAX_CONFIDENCE = 0.5
const DEFAULT_PROMPT_LIMIT = 3

/**
 * Rank the domains worth deliberately exploring. A domain qualifies when it has
 * enough evidence (`attempts ≥ minAttempts`, default 2) AND is not yet competent
 * (`confidence ≤ maxConfidence`, default 0.5) — thin records and already-mastered
 * domains are both filtered out. Each surviving domain gets a `priority` of
 * `attempts × (1 - confidence)` so *frequent + weak* (the costliest blind spots)
 * sort first; ties on priority break by `attempts` descending (more lived evidence
 * of the gap ranks higher). Returns a fresh array (never mutates `records`), sorted
 * by priority descending. Pure and deterministic.
 */
export function findGaps(records: CompetenceRecord[], opts: FindGapsOptions = {}): Gap[] {
  const minAttempts = opts.minAttempts ?? DEFAULT_MIN_ATTEMPTS
  const maxConfidence = opts.maxConfidence ?? DEFAULT_MAX_CONFIDENCE
  return records
    .filter((r) => r.attempts >= minAttempts && r.confidence <= maxConfidence)
    .map((r) => ({
      domain: r.domain,
      confidence: r.confidence,
      attempts: r.attempts,
      priority: r.attempts * (1 - r.confidence),
    }))
    .sort((a, b) => b.priority - a.priority || b.attempts - a.attempts)
}

/**
 * Turn ranked gaps into short, primer-ready exploration prompts — one per gap,
 * highest priority first — e.g. `Investigate the recurring failures in "deploy"
 * (confidence 0.12)`. Capped at `limit` (default 3; non-positive → none). Empty
 * gaps → []. Pure and deterministic (confidence is rendered to two decimals so the
 * text is stable regardless of the underlying float).
 */
export function curiosityPrompts(gaps: Gap[], limit: number = DEFAULT_PROMPT_LIMIT): string[] {
  return gaps
    .slice(0, Math.max(0, limit))
    .map((g) => `Investigate the recurring failures in "${g.domain}" (confidence ${g.confidence.toFixed(2)})`)
}
