// mnemeSociety.ts
//
// Mneme — the society-of-mind layer (Phase 5 of the learning architecture; see
// docs/learning-architecture.md §P5 "Society"). Several agents (Claude Code /
// Codex / Gemini CLI) reflect over the SAME shared brain, so they
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
  /** Which agent learned it (e.g. 'claude', 'codex', 'gemini'). */
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

/** Words too common to carry a lesson's subject. Deliberately small: over-stripping makes two
 *  unrelated lessons look alike, which is the expensive failure here — a false merge silently
 *  destroys one of the two lessons. */
const LESSON_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at', 'by', 'for',
  'with', 'from', 'as', 'it', 'its', 'you', 'your', 'we', 'our', 'they', 'their', 'not', 'no',
  'do', 'does', 'did', 'done', 'have', 'has', 'had', 'can', 'will', 'would', 'should', 'must',
  'when', 'where', 'while', 'after', 'before', 'because', 'so', 'into', 'over', 'up', 'out',
  'about', 'always', 'never', 'use', 'using', 'used', 'one', 'any', 'all', 'each', 'via',
])

/** Crude suffix folding so `upgrading`/`upgraded`/`upgrade` and `modules`/`module` are one
 *  token. Not a real stemmer — a real one needs a dictionary, and this module is pure and
 *  dependency-free by contract. Over-folding is bounded by the 4-char floor below. */
function fold(w: string): string {
  return w
    .replace(/(?:ing|edly|ed|ly|es|s)$/, '')
    .replace(/(.)$/, '$1')
}

/** Content words of a lesson, folded and stopworded. Exported so the injected scorer in the
 *  main process can reuse exactly the tokenisation the default uses. */
/**
 * Strip the session a lesson was learned in, keep the lesson.
 *
 * Cross-agent corroboration only fires when the same lesson, learned twice, LOOKS the same. A
 * lesson written during real work carries the session with it: a commit SHA, an absolute path with
 * someone's username in it, a run id, a timestamp, a port. None of that is the lesson, and all of
 * it is distinct tokens — every one enlarges the union in the Jaccard denominator, so two agents
 * who learned exactly the same thing on different machines score below the bar and get filed as
 * two unrelated lessons.
 *
 * Volatile spans are REMOVED, not replaced with a shared placeholder. A placeholder would make two
 * unrelated lessons that both happen to cite a SHA agree a little — inventing corroboration, which
 * is worse than the problem being fixed.
 *
 * This runs on the comparison path only. The stored text keeps its SHA and its path, because a
 * person reading their own memories needs them.
 */
export function abstractLesson(content: string): string {
  if (typeof content !== 'string' || !content) return ''
  return content
    // A path: keep the leaf, drop the machine. `C:/Users/dave/repos/x/src/a.ts` is the same lesson
    // as `/home/ci/work/x/src/a.ts`, and the directories are pure noise between them.
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@ -]+){2,}/g, (m) => ' ' + (m.split(/[\\/]/).pop() || ''))
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ' ')
    // A SHA has to contain a digit: `facade` and `deadbeef` are hex, and are also just words.
    .replace(/(?=[0-9a-f]*\d)[0-9a-f]{7,40}/gi, ' ')
    // Four or more digits in a row is a timestamp, a port or a byte count. Three or fewer leaves
    // `v1.27.4` intact, which IS part of the lesson.
    .replace(/\d{4,}/g, ' ')
    .replace(/  +/g, ' ')
    .trim()
}

export function lessonTokens(content: string): Set<string> {
  const out = new Set<string>()
  for (const m of abstractLesson(content).toLowerCase().matchAll(/[a-z0-9][a-z0-9_./-]*/g)) {
    const raw = m[0].replace(/[._/-]+$/, '')
    if (!raw || LESSON_STOPWORDS.has(raw)) continue
    const w = raw.length > 4 ? fold(raw) : raw
    if (w.length >= 3 && !LESSON_STOPWORDS.has(w)) out.add(w)
  }
  return out
}

/** Symmetric overlap of two lessons' content words (Jaccard). 0 when either side is empty —
 *  an empty token set agrees with nothing, rather than with everything. */
export function lessonSimilarity(a: string, b: string): number {
  const ta = lessonTokens(a)
  const tb = lessonTokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return shared / (ta.size + tb.size - shared)
}

/** How much two lessons must overlap to count as the same insight. Tuned high on purpose:
 *  a FALSE merge silently destroys one of two real lessons and inflates the corroboration
 *  the importance boost keys off, while a missed merge only leaves the store as it was
 *  through v1.46. When in doubt, don't merge. */
export const SAME_LESSON_THRESHOLD = 0.6

export interface PoolOptions {
  /** Injected 0..1 sameness scorer — an embedding cosine, typically. The pure lexical default
   *  cannot see two agents describing one insight with disjoint vocabulary; a real embedder
   *  can. Kept injected for the same reason `contradicts` is: this module stays deterministic
   *  and store-free. */
  similar?: (a: string, b: string) => number
  /** Override SAME_LESSON_THRESHOLD (mainly for tuning and tests). */
  threshold?: number
}

interface PoolAccumulator {
  key: string
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
export function poolLessons(lessons: AgentLesson[], opts?: PoolOptions): PooledLesson[] {
  // `groups` is an INDEX, not the group list: an aliased key points at a group that is
  // already in it under its own key. Emitting from the map's values would therefore emit
  // that group once per alias. `order` holds each group exactly once, in arrival order.
  const groups = new Map<string, PoolAccumulator>()
  const order: PoolAccumulator[] = []
  const similar = opts?.similar ?? lessonSimilarity
  const threshold = opts?.threshold ?? SAME_LESSON_THRESHOLD

  for (const lesson of lessons) {
    const key = normalizeKey(lesson.content)
    let group = groups.get(key)
    // Exact key is the fast path. Failing that, fall back to the best-scoring existing group
    // above the threshold — greedy, single pass, comparing against each group's representative
    // so the result never depends on which member of a group happened to arrive first.
    if (!group) {
      let best = -1
      for (const g of groups.values()) {
        const score = similar(lesson.content, g.representative)
        // `>` not `>=`: on a tie the earlier group wins, which is what keeps this deterministic.
        if (score >= threshold && score > best) { best = score; group = g }
      }
      if (group) groups.set(key, group) // remember the alias so a third copy short-circuits
    }
    if (!group) {
      group = { key, representative: lesson.content, sources: [], seen: new Set(), maxImportance: -Infinity }
      groups.set(key, group)
      order.push(group)
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
  for (const group of order) {
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

// ---- Conservative default contradiction predicate ---------------------------
// A DELIBERATELY high-precision heuristic: it would rather MISS a real conflict than
// FLAG a false one — the society layer's job is to "surface conflicts for resolution",
// and a false conflict is worse than silence (it wastes attention and pollutes any UI).
// Two lessons contradict only when they are near-identical ABOUT THE SAME SUBJECT except
// that exactly ONE of them negates it (e.g. "always run migrations before seeding" vs
// "never run migrations before seeding"). Different subjects, or both-negated-about-
// different-objects, are intentionally NOT flagged. Pure + deterministic (no clock, no fs).
const NEG_RE = /\b(not|never|no|avoid|avoids|avoided|don'?t|doesn'?t|cannot|can'?t|without|deprecated|disabled?|removed?|dropped?|stop|stopped|instead of|rather than|no longer)\b/i
// Stopwords + polarity/directive words excluded from the topical "core" — so "always X"
// and "never X" reduce to the same core and are compared on X alone.
const CORE_STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'for', 'and', 'or',
  'but', 'with', 'that', 'this', 'it', 'its', 'as', 'by', 'at', 'we', 'you', 'our', 'your', 'their', 'they', 'from',
  'into', 'over', 'under', 'then', 'than', 'so', 'if', 'when', 'while', 'do', 'does', 'did', 'done', 'not', 'no',
  'never', 'always', 'avoid', 'dont', 'doesnt', 'cant', 'cannot', 'use', 'using', 'used', 'prefer', 'prefers', 'adopt',
  'enable', 'enabled', 'disable', 'remove', 'removed', 'add', 'keep', 'must', 'should', 'shall', 'instead', 'rather',
  'without', 'stop', 'stopped', 'drop', 'dropped', 'deprecated', 'longer', 'can', 'will',
])
function coreTokens(content: string): Set<string> {
  const out = new Set<string>()
  for (const t of (content || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !CORE_STOP.has(t)) out.add(t)
  }
  return out
}

/** The default injected `contradicts` predicate for detectConflicts — a conservative,
 *  precision-favouring cross-agent contradiction check. Exported + pure so it's unit-tested
 *  and the production wiring stays a one-liner. */
export function heuristicContradicts(a: AgentLesson, b: AgentLesson): boolean {
  if (!sameSubject(a, b, 0.7)) return false // tight same-subject (minus polarity words)
  return NEG_RE.test(a.content) !== NEG_RE.test(b.content) // …and exactly one negates it
}

/** Are two lessons ABOUT THE SAME SUBJECT? Core-token (non-polarity) Jaccard ≥ minJaccard.
 *  Broader than heuristicContradicts (no negation requirement) — used as the cheap PRE-FILTER
 *  for the expensive NLI pass, so a real model only judges plausibly-related pairs instead of
 *  every O(n²) combination (and it catches contradictions with no explicit negation word, like
 *  "use Postgres" vs "use MySQL", which the heuristic alone can't). */
export function sameSubject(a: AgentLesson, b: AgentLesson, minJaccard = 0.5): boolean {
  const ca = coreTokens(a.content)
  const cb = coreTokens(b.content)
  if (ca.size < 2 || cb.size < 2) return false
  let inter = 0
  for (const t of ca) if (cb.has(t)) inter++
  const union = ca.size + cb.size - inter
  return union > 0 && inter / union >= minJaccard
}

/** Async twin of detectConflicts for a model-backed (NLI) predicate — same cross-source,
 *  each-pair-once contract, awaiting the predicate. */
export async function detectConflictsAsync(
  lessons: AgentLesson[],
  contradicts: (a: AgentLesson, b: AgentLesson) => Promise<boolean>,
): Promise<LessonConflict[]> {
  const conflicts: LessonConflict[] = []
  for (let i = 0; i < lessons.length; i++) {
    for (let j = i + 1; j < lessons.length; j++) {
      const a = lessons[i]
      const b = lessons[j]
      if (a.source === b.source) continue
      if (await contradicts(a, b)) conflicts.push({ a, b })
    }
  }
  return conflicts
}

/** Map a stored memory row to an AgentLesson for pooling / conflict detection — the
 *  source is the authoring agent, falling back to the raw agentId then 'unknown'. Shared
 *  by the memory_pool and memory_conflicts wiring so the projection lives in one tested place. */
export function toAgentLesson(m: { source?: string; agentId?: string; content: string; memoryType?: string; importance?: number }): AgentLesson {
  return { source: m.source || m.agentId || 'unknown', content: m.content, memoryType: m.memoryType, importance: m.importance }
}
