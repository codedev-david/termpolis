// mnemeSociety.ts
//
// Mneme — the society-of-mind layer (Phase 5 of the learning architecture; see
// docs/learning-architecture.md §P5 "Society"). Several agents (Claude Code /
// Codex / Gemini CLI / Qwen Code) reflect over the SAME shared brain, so they
// independently distil overlapping — and occasionally contradictory — lessons.
// This module POOLS those lessons: the same insight learned by different agents
// is fused into one representative whose importance is boosted by cross-agent
// corroboration (a CAPPED boost, so wide-but-shallow agreement can never lift a
// lesson over a genuinely more relevant one), and lessons that CONTRADICT across
// agents are surfaced as conflicts for downstream resolution.
//
// PURE and injectable, exactly like mnemeCuriosity.ts / mnemeReflect.ts /
// memoryEconomy.ts: no electron, no fs, no store, no LLM. The contradiction check
// is an injected predicate so the semantic/NLI judgement lives OUTSIDE and this
// module stays deterministic and unit-testable. There is deliberately NO Date.now()
// here — society logic is not time dependent; if that ever changes, inject the
// `now` clock like the sibling modules do rather than reaching for the wall clock.

export interface AgentLesson {
  /** Which agent learned it (e.g. 'claude', 'codex', 'gemini', 'qwen'). */
  source: string
  content: string
  memoryType?: string
  /** 0..1 base salience; missing is treated as the neutral 0.5. */
  importance?: number
}

export interface PooledLesson {
  content: string
  sources: string[]
  corroboration: number
  importance: number
}

export interface LessonConflict {
  a: AgentLesson
  b: AgentLesson
}

const DEFAULT_IMPORTANCE = 0.5
const PER_SOURCE_BOOST = 0.1 // each corroborating agent adds +10% …
const MAX_CORROBORATION_BOOST = 0.3 // … but the total boost is capped at +30%.

/** Trailing sentence punctuation (plus any whitespace it trails) — trimmed so
 *  "Rebuild the cache." and "rebuild the cache" pool as the same lesson. */
const TRAILING_PUNCT_RE = /[\s.,;:!?…]+$/

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Canonical matching key for "the same lesson" phrased with minor drift by
 * different agents: lowercased, internal whitespace collapsed to single spaces,
 * ends trimmed, and trailing sentence punctuation removed. Leading text and
 * INTERNAL punctuation are preserved — they carry meaning (`a.b.c`, `Fix:`).
 */
export function normalizeKey(content: string): string {
  return content
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILING_PUNCT_RE, '')
}

interface PoolAccumulator {
  representative: string
  sources: string[]
  seen: Set<string>
  maxImportance: number
}

/**
 * Pool lessons contributed by multiple agents. Lessons whose `normalizeKey`
 * matches are fused into one PooledLesson:
 *   - `sources`       distinct sources, in first-appearance order
 *   - `corroboration` distinct-source count (NOT raw occurrence count — one agent
 *                     repeating itself is not corroboration)
 *   - `importance`    max member importance (missing → 0.5), boosted multiplicatively
 *                     by ×(1 + min(0.3, 0.1·(corroboration−1))) and clamped to [0,1];
 *                     the cap keeps popular-but-shallow agreement from dominating
 *   - `content`       the best-worded (longest) member phrasing, kept verbatim
 * Deterministic order: corroboration descending, then importance descending.
 */
export function poolLessons(lessons: AgentLesson[]): PooledLesson[] {
  const groups = new Map<string, PoolAccumulator>()

  for (const lesson of lessons) {
    const key = normalizeKey(lesson.content)
    let group = groups.get(key)
    if (!group) {
      group = { representative: lesson.content, sources: [], seen: new Set(), maxImportance: -Infinity }
      groups.set(key, group)
    }
    // Best-worded representative = the longest phrasing (ties keep the earlier one).
    if (lesson.content.length > group.representative.length) {
      group.representative = lesson.content
    }
    // Distinct sources, first-appearance order.
    if (!group.seen.has(lesson.source)) {
      group.seen.add(lesson.source)
      group.sources.push(lesson.source)
    }
    const importance = lesson.importance ?? DEFAULT_IMPORTANCE
    if (importance > group.maxImportance) {
      group.maxImportance = importance
    }
  }

  const pooled: PooledLesson[] = []
  for (const group of groups.values()) {
    const corroboration = group.sources.length
    const boost = 1 + Math.min(MAX_CORROBORATION_BOOST, PER_SOURCE_BOOST * (corroboration - 1))
    pooled.push({
      content: group.representative,
      sources: group.sources,
      corroboration,
      importance: round3(clamp01(group.maxImportance * boost)),
    })
  }

  pooled.sort((a, b) => b.corroboration - a.corroboration || b.importance - a.importance)
  return pooled
}

/**
 * Surface cross-agent contradictions. Every unordered pair of lessons from
 * DIFFERENT sources is offered to the injected `contradicts` predicate exactly
 * once (indices i < j), and the conflicting pairs are returned in that stable
 * order. Same-source pairs are never considered (an agent disagreeing with
 * itself is churn, not a society conflict). Keeping `contradicts` injected leaves
 * this module pure — the real semantic check lives outside and can be as cheap or
 * as smart as the caller wants.
 */
export function detectConflicts(
  lessons: AgentLesson[],
  contradicts: (a: AgentLesson, b: AgentLesson) => boolean,
): LessonConflict[] {
  const conflicts: LessonConflict[] = []
  for (let i = 0; i < lessons.length; i++) {
    for (let j = i + 1; j < lessons.length; j++) {
      const a = lessons[i]
      const b = lessons[j]
      if (a.source === b.source) continue
      if (contradicts(a, b)) conflicts.push({ a, b })
    }
  }
  return conflicts
}
