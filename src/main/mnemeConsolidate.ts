// mnemeConsolidate.ts
//
// Mneme — consolidation / "sleep" pass (Phase 2 of the learning architecture; see
// docs/learning-architecture.md §P2). While the agent is idle this pass PLANS how to
// compress the brain: which stale episodic memories to forget, which near-duplicates
// to merge, and which dense clusters deserve a rollup summary. It is a PLANNER only —
// it decides, it never touches the store. The store integration reads these plans and
// performs archival (never destructive) writes/edges.
//
// This module is PURE and injectable, matching memoryEconomy.ts / mnemeGraphLogic.ts:
// no electron, no fs, no memory store, no module state, and the clock is ALWAYS the
// injected `now` param — NEVER Date.now(). That makes every decay/age branch
// deterministic under test (the repo convention). Similarity is likewise injected
// (`simOf`) so the caller supplies cosine-over-vectors while the planner stays
// model-free and unit-testable.
//
// Design stance mirrors reflection: conservative. Forgetting and merging destroy
// recall if wrong, so the "forgettable" gate is deliberately narrow (only untagged,
// edge-free, aged episodic/message chatter) and decay fuses MULTIPLICATIVELY (mirror
// fuseImportance) so a zero-importance memory can never be resurrected by usage alone.

/** A store memory as far as consolidation cares — a structural subset of MemoryEntry
 *  plus the mutable learning state (importance/useCount) and a cheap `hasEdges` flag
 *  the caller can precompute from the graph. Unknown fields are ignored. */
export interface ConsolEntry {
  id: string
  content: string
  ts: number
  kind?: string
  memoryType?: string
  importance?: number
  useCount?: number
  tags?: string[]
  hasEdges?: boolean
}

const DAY_MS = 86_400_000

const DEFAULT_HALF_LIFE_MS = 30 * DAY_MS // a month-old memory keeps half its recency
const DEFAULT_IMPORTANCE = 0.5 // neutral salience when a memory carries no explicit score
const USAGE_NUDGE_WEIGHT = 0.05 // mirrors memoryEconomy.fuseImportance …
const USAGE_NUDGE_CAP = 0.2 //     … capped so proven-useful can lift but never dominate

const DEFAULT_KEEP_ABOVE = 0.15 // decay below this is fair game to forget
const DEFAULT_FORGET_CAP = 200 // never propose forgetting more than this per pass
const FORGET_AGE_FLOOR_MS = 14 * DAY_MS // nothing younger than two weeks is forgettable

const DEFAULT_MERGE_THRESHOLD = 0.92 // similarity at/above which two memories are near-dups
const DEFAULT_SUMMARY_MIN_SIZE = 4 // a cluster this large is worth compressing into a summary

/** Branchless clamp into [0,1]. Inputs here are finite, so NaN never arises. */
function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/**
 * Keep-score in [0,1] — how strongly this memory earns its place in the brain, used
 * to decide what "sleep" may forget. Fuses three MULTIPLICATIVE factors so any one of
 * them collapsing to ~0 collapses the score (a zero-importance or ancient memory can
 * never be propped up by usage alone):
 *
 *   importance × recency × (1 + capped-log-usage nudge)
 *
 * where `recency = 2^(-Δt / halfLife)` (a clean 30-day half-life by default; Δt is
 * clamped ≥ 0 so a future-dated peer clock can't manufacture a boost) and the usage
 * nudge saturates via `log(1 + useCount)` and is capped at +20% (mirrors
 * memoryEconomy.fuseImportance) so heavy reuse breaks ties without overriding salience.
 * Pure and deterministic; result clamped to [0,1].
 */
export function decayScore(e: ConsolEntry, now: number, opts: { halfLifeMs?: number } = {}): number {
  const halfLife = opts.halfLifeMs ?? DEFAULT_HALF_LIFE_MS
  const importance = e.importance ?? DEFAULT_IMPORTANCE
  const deltaT = Math.max(0, now - e.ts)
  const recency = halfLife > 0 ? Math.pow(2, -deltaT / halfLife) : 0
  const usage = Math.max(0, e.useCount ?? 0)
  const nudge = Math.min(USAGE_NUDGE_CAP, USAGE_NUDGE_WEIGHT * Math.log(1 + usage))
  return clamp01(importance * recency * (1 + nudge))
}

/**
 * A memory is "forgettable" only if it is low-value CHATTER: an episodic memory (or a
 * raw terminal `message`), with NO tags (tags = a human/curation signal), NO graph
 * edges (edges mean something references it), AND older than the age floor (recent
 * memories are never touched — the agent might still be using them). Everything else —
 * semantic lessons, decisions, entities, summaries, anything tagged or linked — is
 * retained regardless of decay. Deliberately narrow: a wrong forget destroys recall.
 */
function isForgettable(e: ConsolEntry, now: number): boolean {
  const typeOk = e.memoryType === 'episodic' || e.kind === 'message'
  if (!typeOk) return false
  if (e.tags && e.tags.length > 0) return false
  if (e.hasEdges) return false
  return now - e.ts > FORGET_AGE_FLOOR_MS
}

/**
 * Plan which memory ids "sleep" should forget: the forgettable chatter whose
 * {@link decayScore} has fallen below `keepAbove` (default 0.15), lowest score first
 * (weakest memories go first), capped at `cap` (default 200) so a single pass can
 * never propose a mass deletion. Ties break by id for a deterministic plan. Pure — it
 * returns ids; the caller performs the archival forget.
 */
export function planForget(
  entries: ConsolEntry[],
  now: number,
  opts: { keepAbove?: number; cap?: number } = {},
): string[] {
  const keepAbove = opts.keepAbove ?? DEFAULT_KEEP_ABOVE
  const cap = opts.cap ?? DEFAULT_FORGET_CAP
  const scored = entries
    .filter((e) => isForgettable(e, now))
    .map((e) => ({ id: e.id, score: decayScore(e, now) }))
    .filter((s) => s.score < keepAbove)
  // Lowest keep-score first; id tiebreak keeps the plan deterministic across runs.
  scored.sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : 1))
  return scored.slice(0, Math.max(0, cap)).map((s) => s.id)
}

/** Pick the group member to KEEP: highest importance, then longest content (more
 *  context), then earliest ts (the original). Everything else in the group is dropped. */
function mergeKeepCmp(a: ConsolEntry, b: ConsolEntry): number {
  return (
    (b.importance ?? DEFAULT_IMPORTANCE) - (a.importance ?? DEFAULT_IMPORTANCE) ||
    b.content.length - a.content.length ||
    a.ts - b.ts
  )
}

/**
 * Plan near-duplicate merges via greedy single-linkage-from-seed grouping: walk the
 * entries in order, and for each not-yet-grouped entry gather every later ungrouped
 * entry whose injected `simOf` similarity to the seed is ≥ `threshold` (default 0.92)
 * into one group. Within a group the {@link mergeKeepCmp} winner is kept and the rest
 * are dropped; singletons produce no plan entry (nothing to merge). Pure and
 * deterministic; the caller folds each group's dropped ids into the kept memory.
 */
export function planMerges(
  entries: ConsolEntry[],
  simOf: (a: ConsolEntry, b: ConsolEntry) => number,
  opts: { threshold?: number } = {},
): { keep: string; drop: string[] }[] {
  const threshold = opts.threshold ?? DEFAULT_MERGE_THRESHOLD
  const assigned = new Array<boolean>(entries.length).fill(false)
  const out: { keep: string; drop: string[] }[] = []
  for (let i = 0; i < entries.length; i++) {
    if (assigned[i]) continue
    assigned[i] = true
    const group: ConsolEntry[] = [entries[i]]
    for (let j = i + 1; j < entries.length; j++) {
      if (assigned[j]) continue
      if (simOf(entries[i], entries[j]) >= threshold) {
        assigned[j] = true
        group.push(entries[j])
      }
    }
    if (group.length < 2) continue // a lone memory is not a duplicate of anything
    const sorted = [...group].sort(mergeKeepCmp)
    out.push({ keep: sorted[0].id, drop: sorted.slice(1).map((e) => e.id) })
  }
  return out
}

/**
 * Plan cluster→summary rollups: for each incoming cluster with at least `minSize`
 * (default 4) members, emit ONE summary spec — its key, the member ids, and the source
 * count. Small clusters are left alone (not worth the compression). The caller creates
 * a `memoryType:'summary'` memory per spec and links it to each member via `part-of`.
 * Pure; smaller clusters simply produce no spec.
 */
export function planSummaries(
  groups: { key: string; members: ConsolEntry[] }[],
  opts: { minSize?: number } = {},
): { key: string; memberIds: string[]; sourceCount: number }[] {
  const minSize = opts.minSize ?? DEFAULT_SUMMARY_MIN_SIZE
  return groups
    .filter((g) => g.members.length >= minSize)
    .map((g) => ({
      key: g.key,
      memberIds: g.members.map((m) => m.id),
      sourceCount: g.members.length,
    }))
}
