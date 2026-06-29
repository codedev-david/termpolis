// Pure context-economy helpers for the memory system: estimate injected tokens,
// gate recall by relevance WITH a floor (trim noise but never starve the agent of
// context), drop exact-duplicate hits, truncate snippets, and an LRU+TTL result
// cache so repeated searches are instant. No IO — fully unit-testable. These are
// the knobs behind "store generously, inject sparingly, recall fast" without
// shooting ourselves in the foot (the floor is the safety valve).

/** Rough prompt-token count for a string (~4 chars/token). 0 for empty. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export interface Scored {
  score: number
}

/**
 * Relevance gate. Keep hits whose score ≥ minScore, but ALWAYS keep at least
 * `floor` of the top-scoring hits even when they fall below the bar (so a thin or
 * low-confidence recall never starves the agent of context), and never return
 * more than `cap`. Input order doesn't matter — output is sorted by score desc.
 */
export function gateByScore<T extends Scored>(
  hits: T[],
  opts: { minScore: number; floor: number; cap: number },
): T[] {
  const sorted = [...hits].sort((a, b) => b.score - a.score)
  const above = sorted.filter((h) => h.score >= opts.minScore).length
  // Keep the larger of {above-the-bar, the floor} so we never drop below floor.
  const keepCount = Math.max(above, Math.min(opts.floor, sorted.length))
  return sorted.slice(0, Math.min(keepCount, opts.cap))
}

/**
 * Adaptive relevance gate: like {@link gateByScore} but the cutoff scales to THIS
 * query's result quality instead of a single fixed bar. Keep hits scoring at least
 * `max(absoluteFloor, max(0, topScore) * relFrac)` — so a query that returns one
 * great hit and a long mediocre tail injects just the strong cluster, while a query
 * whose best hit is weak falls back to the absolute noise floor. The keep-at-least-
 * `floor` valve and the `cap` are retained so recall never starves and never floods.
 * `topScore` is clamped ≥ 0 so a negative-cosine top hit can't push the threshold
 * negative and filter out the very best result. Output sorted by score desc.
 */
export function adaptiveGate<T extends Scored>(
  hits: T[],
  opts: { floor: number; cap: number; relFrac: number; absoluteFloor: number },
): T[] {
  const sorted = [...hits].sort((a, b) => b.score - a.score)
  const topScore = sorted.length ? sorted[0].score : 0
  const threshold = Math.max(opts.absoluteFloor, Math.max(0, topScore) * opts.relFrac)
  const above = sorted.filter((h) => h.score >= threshold).length
  const keepCount = Math.max(above, Math.min(opts.floor, sorted.length))
  return sorted.slice(0, Math.min(keepCount, opts.cap))
}

export interface RankInput {
  relevance: number          // base 0..1 similarity / keyword score
  ts: number                 // entry timestamp (ms)
  kind?: string              // MemoryEntry kind ('decision' | 'fact' | 'message' | …)
  now: number                // injected clock — deterministic in tests, Date.now() in prod
}

export interface RankWeights {
  alpha?: number             // recency-boost magnitude (cap on the nudge)
  halfLifeMs?: number        // recency half-life
  kindPriors?: Record<string, number>
}

/**
 * Default rank weights. A 30-day half-life means a month-old hit keeps half its
 * recency nudge; `alpha` caps that nudge at +25%. Only decision/fact carry a kind
 * prior (1.15) — message/result/note stay neutral (1.0) so the primer's
 * message-led project bucket is never starved (spread deliberately held ≤ 1.15).
 */
export const RANK_DEFAULTS = {
  alpha: 0.25,
  halfLifeMs: 30 * 86_400_000,
  kindPriors: { decision: 1.15, fact: 1.15 } as Record<string, number>,
}

/**
 * Fuse a base relevance score with recency and per-kind importance into one
 * sortable rank: `relevance * (1 + alpha*recency) * kindPrior`, where
 * `recency = 2^(-max(0, now-ts)/halfLife)` (a clean 30-day half-life by default).
 *
 * Pure and side-effect-free: compute it ONCE per candidate (decorate) and sort by
 * the stored value — never call this inside a comparator over a large pool. `deltaT`
 * is clamped ≥ 0 so a future-dated synced-peer clock can't manufacture a boost
 * beyond the full `1 + alpha`. Relevance 0 ⇒ rank 0 (all multipliers are positive,
 * so `rank > 0 ⇔ relevance > 0` — the score>0 gate downstream is preserved).
 */
export function rankScore(input: RankInput, weights: RankWeights = {}): number {
  const alpha = weights.alpha ?? RANK_DEFAULTS.alpha
  const halfLife = weights.halfLifeMs ?? RANK_DEFAULTS.halfLifeMs
  const priors = weights.kindPriors ?? RANK_DEFAULTS.kindPriors
  const deltaT = Math.max(0, input.now - input.ts)
  const recency = halfLife > 0 ? Math.pow(2, -deltaT / halfLife) : 0
  const kindPrior = (input.kind && priors[input.kind]) || 1
  return input.relevance * (1 + alpha * recency) * kindPrior
}

export interface RelatedScore {
  id: string
  score: number
  relation?: string
}

/** Saturate a raw (unbounded) edge weight into 0..1 via w/(w+1), so a default
 *  weight=1 link (→ 0.5) can't trivially outrank a strong vector hit. Pure. */
const saturateEdge = (w: number): number => { const x = Math.max(0, w); return x / (x + 1) }

/**
 * Fuse vector neighbours with typed-edge neighbours for memory_related. Dedup by
 * id; combine each id's best vector similarity (clamped to 0..1) with its best
 * saturated edge weight via a soft-OR `1 - (1-vsim)(1-edge)` — so an id related
 * BOTH ways outranks one related a single way, while a lone default link stays at
 * 0.5 (below a strong vector hit). Surfaces the strongest edge's relation, drops
 * score ≤ 0, returns sorted by score desc. Pure.
 */
export function mergeRelated(input: {
  vectorHits: Array<{ id: string; score: number }>
  edges: Array<{ id: string; relation: string; weight: number }>
}): RelatedScore[] {
  const byId = new Map<string, { vsim: number; edge: number; relation?: string }>()
  for (const h of input.vectorHits) {
    const v = Math.max(0, Math.min(1, h.score))
    const cur = byId.get(h.id) || { vsim: 0, edge: 0 }
    cur.vsim = Math.max(cur.vsim, v)
    byId.set(h.id, cur)
  }
  for (const e of input.edges) {
    const s = saturateEdge(e.weight)
    const cur = byId.get(e.id) || { vsim: 0, edge: 0 }
    if (s >= cur.edge) { cur.edge = s; cur.relation = e.relation } // strongest edge wins; keep its relation
    byId.set(e.id, cur)
  }
  const out: RelatedScore[] = []
  for (const [id, { vsim, edge, relation }] of byId) {
    const score = 1 - (1 - vsim) * (1 - edge)
    if (score > 0) out.push(relation !== undefined ? { id, score, relation } : { id, score })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

const norm = (s: string): string => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()

/** Lowercased word-token set (len > 2) for cheap Jaccard similarity. */
function tokenSet(s: string): Set<string> {
  return new Set((s || '').toLowerCase().split(/\W+/).filter((t) => t.length > 2))
}
// Below this many meaningful tokens there isn't enough textual signal to call two
// snippets near-duplicates — protects short/templated content (ids, codes) from
// being collapsed just because they share their one common word.
const MIN_DIVERSITY_TOKENS = 3
// Callers gate on MIN_DIVERSITY_TOKENS, so both sets are non-empty here (no div-by-zero).
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

/**
 * Greedy MMR-lite diversity pass: walk hits in their existing (score-desc) order
 * and keep one only if its similarity to EVERY already-kept hit is ≤ threshold —
 * so a near-duplicate paraphrase stops occupying several inject slots. A strict
 * superset of {@link dedupeHits} (exact dupes have similarity 1). Similarity is
 * the injected `simFn` (cosine over attached vectors) when supplied, else
 * token-Jaccard on `content`. Pure; survivors keep their input order. No-ops with
 * no embeddings beyond the token-Jaccard near-dup trim (the non-destructive home
 * for the rejected write-time semantic dedup).
 */
export function diversifyHits<T extends { content: string }>(
  hits: T[],
  opts: { threshold: number; simFn?: (a: T, b: T) => number },
): T[] {
  const threshold = opts.threshold
  const kept: T[] = []
  const keptTokens: Set<string>[] = []
  for (const h of hits) {
    const ht = opts.simFn ? null : tokenSet(h.content)
    let dup = false
    for (let i = 0; i < kept.length; i++) {
      let sim: number
      if (opts.simFn) sim = opts.simFn(h, kept[i])
      else {
        const a = ht as Set<string>, b = keptTokens[i]
        // Too little signal to judge → treat as distinct (never collapse).
        sim = a.size < MIN_DIVERSITY_TOKENS || b.size < MIN_DIVERSITY_TOKENS ? 0 : jaccard(a, b)
      }
      if (sim > threshold) { dup = true; break }
    }
    if (!dup) { kept.push(h); if (ht) keptTokens.push(ht) }
  }
  return kept
}

/** Drop later hits whose content exactly duplicates an earlier (higher-score) one. */
export function dedupeHits<T extends { content: string }>(hits: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const h of hits) {
    const k = norm(h.content)
    if (k && seen.has(k)) continue
    if (k) seen.add(k)
    out.push(h)
  }
  return out
}

/** Cap a string to maxChars, marking truncation with a single ellipsis char. */
export function truncateContent(s: string, maxChars: number): string {
  if (!s || s.length <= maxChars) return s
  return s.slice(0, Math.max(0, maxChars)).trimEnd() + '…'
}

/**
 * Tiny LRU + TTL cache for search results. `now` is injected so expiry is
 * deterministic in tests (pass Date.now in production). Reading a fresh entry
 * marks it most-recently-used; capacity overflow evicts the least-recent key.
 */
export class TtlLruCache<V> {
  private map = new Map<string, { v: V; t: number }>()
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (this.now() - e.t > this.ttlMs) {
      this.map.delete(key)
      return undefined
    }
    this.map.delete(key) // re-insert to bump recency (Map preserves insertion order)
    this.map.set(key, e)
    return e.v
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { v: value, t: this.now() })
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  clear(): void {
    this.map.clear()
  }
}

export interface PrimerCost {
  chars: number
  tokens: number
  lines: number
}

/** The measurable cost of an injected primer — what accounting / the UI reports. Pure. */
export function summarizePrimerCost(primer: string | null): PrimerCost {
  if (!primer) return { chars: 0, tokens: 0, lines: 0 }
  return { chars: primer.length, tokens: estimateTokens(primer), lines: primer.split('\n').length }
}
