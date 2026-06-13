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

const norm = (s: string): string => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()

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
