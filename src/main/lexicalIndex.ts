// Pure BM25 lexical index over the memory hot window — the exact-token half of the
// calibrated hybrid retrieval (BB1). Dense bge-small embeddings blur exact tokens
// (file paths, symbols, error codes, CLI flags); BM25 recalls them, and is also the
// graceful-degrade signal when the embedder is unavailable. No IO, no native deps —
// an in-memory inverted index maintained beside the vector store.
//
// STORAGE (v1.25.17): the payload lives in TYPED ARRAYS, not nested Map/Set.
//
// The v1 layout was `Map<docId, Map<term, tf>>` + `Map<term, Set<docId>>`. That is two
// JS collection entries per (doc, term) pair, each costing ~26-50 B of V8 bookkeeping to
// hold 4 bytes of information. MEASURED on the real 94,430-entry store: 8,472,470 postings
// -> 445 MB of heap, and 6.5 SECONDS to build — synchronously, on the thread that echoes
// PTY keystrokes.
//
// Here the same postings live in flat Int32Array/Uint32Array runs, one pair per term and
// one per doc. The census that drove this layout (real store, real Electron main, real GC):
//
//     N docs        94,430        P postings  8,472,470
//     T terms      167,014        max tf            196
//
// T is small enough that term STRINGS are kept exactly — no hashing, so no collisions and
// no silent score drift. The scores this produces are identical to v1's, which is the whole
// point: recall is CI-gated and this change is a representation change, not a ranking one.
//
// Sizes are exact on bulk build (`addMany` counts first, allocates once, fills once) and
// capacity-doubled on incremental add.

const K1 = 1.2 // term-frequency saturation
const B = 0.75 // length-normalization strength

// v1 tokenizer: NFC-normalize, lowercase, split on non-word runs, drop tokens of
// length <= 2. Deliberately NO stemming/suffix-stripping — it mangles identifiers
// (e.g. `useState` -> `usestate`, but `paths`/`path` must stay distinct tokens).
//
// UNCHANGED, on purpose. A hand-rolled charCode scanner with an ASCII fast path was written,
// verified token-for-token identical across all 94,430 real documents — and MEASURED at 0.94x,
// i.e. 6% SLOWER than this line. V8's native regex split is simply better than a JS character
// loop. It bought nothing, so it does not ship: an optimization that does not measure faster
// is pure risk. (The build cost is not here anyway — see addMany.)
export function tokenizeLexical(text: string): string[] {
  return (text || '')
    .normalize('NFC')
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2)
}

// Rank by descending BM25, ties broken by id. The tie-break is EXPLICIT because the
// alternative is not "no tie-break" — it is "whatever order the docs happened to land in the
// Map", which in v1 depended on insertion history. That made the ranking of equal-scoring
// documents a function of the store's edit history: the same corpus could rank differently
// after a compaction, and a doc could cross the top-k boundary for no reason a user could
// ever observe. Deterministic beats incidental.
function byScoreThenId(a: { id: string; score: number }, b: { id: string; score: number }): number {
  if (b.score !== a.score) return b.score - a.score
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Inverted index with Okapi BM25 scoring. `add`/`remove` keep it in sync with the
 * hot window at every mutation site; `search` scans ONLY the postings of the query
 * terms (so cost scales with matches, not corpus size). Pure and unit-testable.
 */
export class LexicalIndex {
  // --- term interning (T-sized bookkeeping; the payload is elsewhere) ---
  private termId = new Map<string, number>()
  private termOf: (string | null)[] = []
  private freeTerms: number[] = []

  // --- postings, indexed by termId. postings[t] holds ASCENDING docNums over [0, pLen[t]);
  //     postingTf[t] is parallel, so search reads tf with a straight array load and never
  //     has to go looking for it. (P-sized: the two big arrays.) ---
  private postings: (Int32Array | null)[] = []
  private postingTf: (Uint32Array | null)[] = []
  private pLen: number[] = []

  // --- doc interning ---
  private docNum = new Map<string, number>()
  private docIdOf: (string | null)[] = []
  private freeDocs: number[] = []

  // --- per-doc term list, for removal only (search never reads it). (P-sized.) ---
  private docTerms: (Int32Array | null)[] = []
  private dLen: number[] = []

  private nDocs = 0
  private totalLen = 0

  get size(): number {
    return this.nDocs
  }

  private internTerm(term: string): number {
    const existing = this.termId.get(term)
    if (existing !== undefined) return existing
    const t = this.freeTerms.pop() ?? this.termOf.length
    this.termId.set(term, t)
    this.termOf[t] = term
    this.postings[t] = null
    this.postingTf[t] = null
    this.pLen[t] = 0
    return t
  }

  private allocDoc(docId: string): number {
    const d = this.freeDocs.pop() ?? this.docIdOf.length
    this.docNum.set(docId, d)
    this.docIdOf[d] = docId
    return d
  }

  /** Insert docNum into term t's postings, keeping them ascending (binary search + memmove). */
  private postingInsert(t: number, doc: number, tf: number): void {
    let arr = this.postings[t]
    let tfs = this.postingTf[t]
    const len = this.pLen[t]
    if (!arr || !tfs || len === arr.length) {
      const cap = Math.max(4, (arr ? arr.length : 0) * 2)
      const nextArr = new Int32Array(cap)
      const nextTf = new Uint32Array(cap)
      if (arr && tfs) { nextArr.set(arr.subarray(0, len)); nextTf.set(tfs.subarray(0, len)) }
      this.postings[t] = nextArr
      this.postingTf[t] = nextTf
      arr = nextArr
      tfs = nextTf
    }
    let lo = 0
    let hi = len
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (arr[mid] < doc) lo = mid + 1
      else hi = mid
    }
    if (lo < len) { arr.copyWithin(lo + 1, lo, len); tfs.copyWithin(lo + 1, lo, len) }
    arr[lo] = doc
    tfs[lo] = tf
    this.pLen[t] = len + 1
  }

  private postingRemove(t: number, doc: number): void {
    const arr = this.postings[t]
    const tfs = this.postingTf[t]
    const len = this.pLen[t]
    if (!arr || !tfs || len === 0) return
    let lo = 0
    let hi = len
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (arr[mid] < doc) lo = mid + 1
      else hi = mid
    }
    if (lo >= len || arr[lo] !== doc) return
    arr.copyWithin(lo, lo + 1, len)
    tfs.copyWithin(lo, lo + 1, len)
    this.pLen[t] = len - 1
    // A term nobody references is dropped entirely — v1 did this too (`postings.delete(t)`
    // when its Set emptied), and it keeps the vocabulary from growing without bound as the
    // hot window churns.
    if (this.pLen[t] === 0) {
      const term = this.termOf[t]
      if (term !== null && term !== undefined) this.termId.delete(term)
      this.termOf[t] = null
      this.postings[t] = null
      this.postingTf[t] = null
      this.freeTerms.push(t)
    }
  }

  /** Index (or re-index) a document's text under `docId`. Idempotent re-add. */
  add(docId: string, text: string): void {
    if (this.docNum.has(docId)) this.remove(docId)
    const tokens = tokenizeLexical(text)
    const tf = new Map<number, number>()
    for (const tk of tokens) {
      const t = this.internTerm(tk)
      tf.set(t, (tf.get(t) ?? 0) + 1)
    }
    const d = this.allocDoc(docId)
    const m = tf.size
    const terms = new Int32Array(m)
    let i = 0
    for (const [t, n] of tf) { terms[i++] = t }
    this.docTerms[d] = terms
    this.dLen[d] = tokens.length
    this.totalLen += tokens.length
    this.nDocs++
    for (const [t, n] of tf) this.postingInsert(t, d, n)
  }

  /**
   * Bulk-load many documents. Same result as calling `add` in a loop, but it tallies each
   * term's document frequency FIRST, grows every postings run ONCE, then fills — so a term
   * appearing in 90,000 documents does not re-grow and re-copy its array on every insert.
   *
   * This is the path the background rebuild takes, and it is called in CHUNKS (~190 times for
   * the real store), which is exactly why the growth below must CAPACITY-DOUBLE rather than
   * size exactly. Sizing each run to `len + n` per chunk would re-copy every posting on every
   * chunk — O(chunks x P), about 3 GB of memcpy on the real corpus. Doubling makes the total
   * copying amortized O(P). The exact-size version measured beautifully in a single-shot bench
   * and would have been quietly quadratic in production; that asymmetry is precisely how
   * v1.25.16 shipped.
   *
   * FAST-PATH PRECONDITION: each doc is APPENDED at the end of every postings run it touches,
   * and gets a freshly-allocated docNum. That is only correct when the docNums strictly ascend
   * AND every doc is genuinely new. Three things break it, and each falls back to per-doc `add`
   * (which sorted-inserts, and replaces an existing doc):
   *
   *   1. A recycled doc slot — `freeDocs` non-empty means allocDoc can hand back a docNum BELOW
   *      ones already sitting in the runs, and appending it would destroy the ascending order
   *      that both `search` and `remove` binary-search against.
   *   2. A docId ALREADY in the index — without this check it would be given a SECOND slot
   *      instead of replacing the first: `size` counts it twice, its superseded content stays
   *      searchable forever, and both sets of postings accumulate into the same score key, so
   *      BM25 double-counts it. `add` replaces; `addMany` must too, or the docstring above is
   *      a lie.
   *   3. A docId repeated WITHIN one batch — same failure, self-inflicted.
   */
  addMany(docs: Array<{ id: string; content: string }>): void {
    let slow = this.freeDocs.length > 0
    if (!slow) {
      const seen = new Set<string>()
      for (const d of docs) {
        if (this.docNum.has(d.id) || seen.has(d.id)) { slow = true; break }
        seen.add(d.id)
      }
    }
    if (slow) {
      for (const d of docs) this.add(d.id, d.content)
      return
    }

    // Pass 1: tokenize once, intern, record each doc's (termId -> tf), tally df.
    const perDoc: Array<Map<number, number>> = new Array(docs.length)
    const df = new Map<number, number>()
    for (let i = 0; i < docs.length; i++) {
      const tokens = tokenizeLexical(docs[i].content)
      const tf = new Map<number, number>()
      for (const tk of tokens) {
        const t = this.internTerm(tk)
        tf.set(t, (tf.get(t) ?? 0) + 1)
      }
      perDoc[i] = tf
      const d = this.allocDoc(docs[i].id)
      const terms = new Int32Array(tf.size)
      let k = 0
      for (const t of tf.keys()) {
        terms[k++] = t
        df.set(t, (df.get(t) ?? 0) + 1)
      }
      this.docTerms[d] = terms
      this.dLen[d] = tokens.length
      this.totalLen += tokens.length
      this.nDocs++
    }

    // Pass 2: grow each touched run ONCE, capacity-doubling.
    for (const [t, n] of df) {
      const len = this.pLen[t] ?? 0
      const cur = this.postings[t]
      const cap = cur ? cur.length : 0
      const need = len + n
      if (need <= cap) continue
      const newCap = Math.max(need, cap * 2, 4)
      const arr = new Int32Array(newCap)
      const tfs = new Uint32Array(newCap)
      if (cur && len > 0) {
        arr.set(cur.subarray(0, len))
        tfs.set(this.postingTf[t]!.subarray(0, len))
      }
      this.postings[t] = arr
      this.postingTf[t] = tfs
    }

    // Pass 3: fill. Ascending docNums appended to each run keep it sorted for free.
    for (let i = 0; i < docs.length; i++) {
      const d = this.docNum.get(docs[i].id)!
      for (const [t, n] of perDoc[i]) {
        const at = this.pLen[t] ?? 0
        this.postings[t]![at] = d
        this.postingTf[t]![at] = n
        this.pLen[t] = at + 1
      }
    }
  }

  /** Remove a document from the index (no-op if absent). */
  remove(docId: string): void {
    const d = this.docNum.get(docId)
    if (d === undefined) return
    const terms = this.docTerms[d]
    if (terms) for (let i = 0; i < terms.length; i++) this.postingRemove(terms[i], d)
    this.totalLen -= this.dLen[d] ?? 0
    this.dLen[d] = 0
    this.docTerms[d] = null
    this.docIdOf[d] = null
    this.docNum.delete(docId)
    this.freeDocs.push(d)
    this.nDocs--
  }

  clear(): void {
    this.termId.clear()
    this.termOf = []
    this.freeTerms = []
    this.postings = []
    this.postingTf = []
    this.pLen = []
    this.docNum.clear()
    this.docIdOf = []
    this.freeDocs = []
    this.docTerms = []
    this.dLen = []
    this.nDocs = 0
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
    const N = this.nDocs
    if (qTokens.length === 0 || N === 0 || k <= 0) return []
    const avgdl = this.totalLen / N || 1
    const scores = new Map<string, number>()
    for (const term of qTokens) {
      const t = this.termId.get(term)
      if (t === undefined) continue
      const arr = this.postings[t]
      const tfs = this.postingTf[t]
      const len = this.pLen[t] ?? 0
      if (!arr || !tfs || len === 0) continue
      const df = len
      // BM25+ idf form — always positive, so a term in (almost) every doc never
      // contributes a negative score.
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      for (let i = 0; i < len; i++) {
        const d = arr[i]
        const docId = this.docIdOf[d]
        if (docId === null || docId === undefined) continue
        if (allow && !allow(docId)) continue
        const tf = tfs[i]
        const dl = this.dLen[d] ?? 0
        const denom = tf + K1 * (1 - B + B * (dl / avgdl))
        scores.set(docId, (scores.get(docId) ?? 0) + idf * (tf * (K1 + 1)) / (denom || 1))
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort(byScoreThenId)
      .slice(0, k)
  }
}
