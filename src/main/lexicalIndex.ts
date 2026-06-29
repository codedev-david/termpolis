// Pure BM25 lexical index over the memory hot window — the exact-token half of the
// calibrated hybrid retrieval (BB1). Dense bge-small embeddings blur exact tokens
// (file paths, symbols, error codes, CLI flags); BM25 recalls them, and is also the
// graceful-degrade signal when the embedder is unavailable. No IO, no native deps —
// an in-memory inverted index maintained beside the vector store.

// v1 tokenizer: NFC-normalize, lowercase, split on non-word runs, drop tokens of
// length <= 2. Deliberately NO stemming/suffix-stripping — it mangles identifiers
// (e.g. `useState` -> `usestate`, but `paths`/`path` must stay distinct tokens).
export function tokenizeLexical(text: string): string[] {
  return (text || '')
    .normalize('NFC')
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2)
}

const K1 = 1.2 // term-frequency saturation
const B = 0.75 // length-normalization strength

/**
 * Inverted index with Okapi BM25 scoring. `add`/`remove` keep it in sync with the
 * hot window at every mutation site; `search` scans ONLY the postings of the query
 * terms (so cost scales with matches, not corpus size). Pure and unit-testable.
 */
export class LexicalIndex {
  private docs = new Map<string, Map<string, number>>() // docId -> term -> term frequency
  private postings = new Map<string, Set<string>>()      // term -> docIds containing it
  private docLen = new Map<string, number>()             // docId -> token count
  private totalLen = 0

  get size(): number {
    return this.docs.size
  }

  /** Index (or re-index) a document's text under `docId`. Idempotent re-add. */
  add(docId: string, text: string): void {
    if (this.docs.has(docId)) this.remove(docId)
    const tokens = tokenizeLexical(text)
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    this.docs.set(docId, tf)
    this.docLen.set(docId, tokens.length)
    this.totalLen += tokens.length
    for (const t of tf.keys()) {
      let p = this.postings.get(t)
      if (!p) { p = new Set(); this.postings.set(t, p) }
      p.add(docId)
    }
  }

  /** Remove a document from the index (no-op if absent). */
  remove(docId: string): void {
    const tf = this.docs.get(docId)
    if (!tf) return
    for (const t of tf.keys()) {
      const p = this.postings.get(t)
      if (p) { p.delete(docId); if (p.size === 0) this.postings.delete(t) }
    }
    this.totalLen -= this.docLen.get(docId) ?? 0
    this.docLen.delete(docId)
    this.docs.delete(docId)
  }

  clear(): void {
    this.docs.clear()
    this.postings.clear()
    this.docLen.clear()
    this.totalLen = 0
  }

  /**
   * BM25 top-`k` for `query`. `allow(docId)` (optional) gates eligible docs. Returns
   * `{id, score}` sorted by descending BM25 (scores are unbounded — the caller
   * calibrates them into 0..1 before fusing). Only the postings of the query terms
   * are scanned.
   */
  search(query: string, k: number, allow?: (docId: string) => boolean): Array<{ id: string; score: number }> {
    const qTokens = [...new Set(tokenizeLexical(query))]
    const N = this.docs.size
    if (qTokens.length === 0 || N === 0 || k <= 0) return []
    const avgdl = this.totalLen / N || 1
    const scores = new Map<string, number>()
    for (const t of qTokens) {
      const p = this.postings.get(t)
      if (!p) continue
      const df = p.size
      // BM25+ idf form — always positive, so a term in (almost) every doc never
      // contributes a negative score.
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      for (const docId of p) {
        if (allow && !allow(docId)) continue
        const tf = this.docs.get(docId)!.get(t) ?? 0
        const dl = this.docLen.get(docId) ?? 0
        const denom = tf + K1 * (1 - B + B * (dl / avgdl))
        scores.set(docId, (scores.get(docId) ?? 0) + idf * (tf * (K1 + 1)) / (denom || 1))
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
  }
}
