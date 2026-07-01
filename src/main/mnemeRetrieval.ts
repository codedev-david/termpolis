// mnemeRetrieval.ts
//
// Mneme — Phase 4: learned + proactive retrieval (see docs/learning-architecture.md
// §P4). Two jobs:
//
//   1. LEARN-TO-RETRIEVE — re-rank raw recall hits by a *learned utility* that folds
//      in how salient a memory was at write (`importance`) and how often it has
//      since proven useful (`useCount`). This is the read-time consumer of the
//      `{learn}` reinforcement deltas.
//   2. PROACTIVE PRE-SURFACE — mine the current task text for the signals a past
//      solution would be indexed under (errors, file/function tokens, identifiers,
//      SCREAMING codes) and build a compact recall query, so a relevant lesson is
//      surfaced BEFORE the agent re-derives it.
//
// PURE + injectable, exactly like memoryEconomy.ts / mnemeReflect.ts: no electron,
// no fs, no store, no LLM, and the clock is injected (`now`) — NEVER Date.now() —
// so every branch is deterministic and unit-testable.
//
// CRITICAL invariant (mirrors fuseImportance / rankScore, memoryEconomy.ts:72-123):
// the learned adjustments are CAPPED and MULTIPLICATIVE around `relevance`. Because
// every factor is `(1 + non-negative nudge) ≥ 1` and the base is `relevance`, a
// zero-relevance hit stays exactly 0 — reinforcement can lift a memory's rank but
// can NEVER resurrect one below the relevance gate (memorySearch MIN_RELEVANCE).

export interface Scored {
  id: string
  relevance: number // base 0..1 similarity / keyword score (the gate operates on this)
  importance?: number // 0..1 salience recorded at write time (reflection sets lessons high)
  useCount?: number // times this memory has been reinforced as useful (from {learn} deltas)
  ts?: number // entry timestamp (ms) — carried metadata for downstream consumers
}

export interface LearnedUtilityOpts {
  usageWeight?: number // magnitude of the log-usage nudge
  usageCap?: number // hard ceiling on the usage nudge (so it can't override relevance)
  importanceWeight?: number // magnitude of the importance nudge
  importanceCap?: number // hard ceiling on the importance nudge
}

// Defaults mirror fuseImportance (weight 0.05 / cap 0.2 for the log-usage term). The
// importance term is a gentle +0..+15% lift for a salience-1 memory; both ceilings
// are small on purpose — combined they top out at ~+38%, never enough to lift a
// weak-but-nonzero hit past a strong one, and never anything times a zero base.
export const LEARNED_UTILITY_DEFAULTS = {
  usageWeight: 0.05,
  usageCap: 0.2,
  importanceWeight: 0.15,
  importanceCap: 0.15,
} as const

/**
 * Learned retrieval utility for one hit:
 *
 *   relevance × (1 + importanceNudge) × (1 + usageNudge)
 *
 * where
 *   importanceNudge = min(importanceCap, importanceWeight × max(0, importance))
 *   usageNudge      = min(usageCap,      usageWeight × ln(1 + max(0, useCount)))
 *
 * Both nudges are ≥ 0 and capped, so the result is monotonic in relevance and — the
 * whole point — is EXACTLY 0 when relevance is 0 (the relevance-gate contract). Pure
 * and deterministic. `now` is the injected-clock seam (threaded by rerankByUtility
 * and kept for API-parity with rankScore); the learned terms are time-invariant.
 */
export function learnedUtility(s: Scored, now: number, opts: LearnedUtilityOpts = {}): number {
  const usageWeight = opts.usageWeight ?? LEARNED_UTILITY_DEFAULTS.usageWeight
  const usageCap = opts.usageCap ?? LEARNED_UTILITY_DEFAULTS.usageCap
  const importanceWeight = opts.importanceWeight ?? LEARNED_UTILITY_DEFAULTS.importanceWeight
  const importanceCap = opts.importanceCap ?? LEARNED_UTILITY_DEFAULTS.importanceCap

  const importance = Math.max(0, s.importance ?? 0)
  const useCount = Math.max(0, s.useCount ?? 0)

  const importanceNudge = Math.min(importanceCap, importanceWeight * importance)
  const usageNudge = Math.min(usageCap, usageWeight * Math.log(1 + useCount))

  // Multiplicative around relevance: relevance 0 ⇒ utility 0, no matter the nudges.
  return s.relevance * (1 + importanceNudge) * (1 + usageNudge)
}

/**
 * Decorate each hit with its {@link learnedUtility} and return them sorted by that
 * utility descending. Decorate-once-then-sort (never compute inside the comparator);
 * Array.prototype.sort is stable, so ties preserve input order. Non-mutating —
 * operates on a fresh mapped array, leaving `hits` untouched.
 */
export function rerankByUtility(
  hits: Scored[],
  now: number,
  opts: LearnedUtilityOpts = {},
): Array<Scored & { utility: number }> {
  return hits
    .map((h) => ({ ...h, utility: learnedUtility(h, now, opts) }))
    .sort((a, b) => b.utility - a.utility)
}

// --- proactive pre-surface -----------------------------------------------------

// Below this many characters there isn't enough of a task to recall against —
// return '' rather than fire proactive recall on a stray fragment. Matches the
// 8-char sentence floor mnemeReflect uses.
const MIN_TASK_CHARS = 8
const MAX_SIGNALS = 12

// Named error/exception classes (TypeError, ReferenceError, RuntimeException…).
// Case-sensitive so it targets real class names, not the bare word "error".
const ERROR_TOKEN_RE = /\b\w*(?:Error|Exception)\b/g
// Common prose error phrases a past fix would be indexed under.
const ERROR_PHRASE_RE =
  /\b(?:cannot find module|module not found|no such file|not found|is not defined|is not a function|permission denied|unexpected token|out of memory|connection refused|failed to \w+)\b/gi
// `backticked identifiers`
const BACKTICK_RE = /`([^`\n]{1,60})`/g
// file-ish tokens: foo.ts, src/config.py, a\b.json
const FILE_RE = /\b[\w./\\-]+\.[A-Za-z]{2,5}\b/g
// SCREAMING_CODES / errno constants (ENOENT, MAX_RETRIES).
const SCREAMING_RE = /\b[A-Z][A-Z0-9_]{2,}\b/g

// Structural words that carry no recall signal — dropped from the prose fallback.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you',
  'are', 'was', 'were', 'has', 'have', 'will', 'would', 'should', 'could', 'can',
  'not', 'but', 'out', 'when', 'then', 'than', 'over', 'under', 'more', 'less',
  'some', 'any', 'all', 'its', 'their', 'them', 'there', 'here', 'what', 'which',
  'who', 'how', 'why', 'also', 'just', 'like', 'get', 'got', 'make', 'made',
  'need', 'want', 'please', 'help', 'let', 'use', 'using', 'used', 'about', 'into',
])

/**
 * Mine the current task text for the salient signals a past solution would be
 * indexed under and join them into a compact, deduped recall query. Priority order:
 * error class names, error phrases, backticked identifiers, file tokens, SCREAMING
 * codes — then, only if none of those matched, a keyword fallback (meaningful words)
 * so prose tasks still recall. Deterministic; empty / too-short input → ''.
 */
export function proactiveQuery(taskText: string): string {
  const text = (taskText || '').trim()
  if (text.length < MIN_TASK_CHARS) return ''

  const signals: string[] = []
  const seen = new Set<string>()
  const add = (raw: string): void => {
    const v = raw.trim()
    if (!v) return
    const key = v.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    signals.push(v)
  }

  for (const m of text.matchAll(ERROR_TOKEN_RE)) add(m[0])
  for (const m of text.matchAll(ERROR_PHRASE_RE)) add(m[0])
  for (const m of text.matchAll(BACKTICK_RE)) add(m[1])
  for (const m of text.matchAll(FILE_RE)) add(m[0])
  for (const m of text.matchAll(SCREAMING_RE)) add(m[0])

  // No structured signal → distil salient keywords so recall still fires on prose.
  if (signals.length === 0) {
    const words = text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    for (const w of words) add(w)
  }

  return signals.slice(0, MAX_SIGNALS).join(' ')
}

/**
 * Gate for proactive pre-surfacing: only inject a past memory ahead of the agent's
 * work when its similarity to the current task clears `threshold` (default 0.75 —
 * high, because a wrong pre-surfaced memory anchors the agent worse than none).
 */
export function shouldPreSurface(sim: number, opts: { threshold?: number } = {}): boolean {
  const threshold = opts.threshold ?? 0.75
  return sim >= threshold
}
