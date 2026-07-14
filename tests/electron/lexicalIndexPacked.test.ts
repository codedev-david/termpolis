// Adversarial tests for the PACKED internals of the BM25 lexical index (v1.25.17).
//
// `lexicalIndex.ts` moved its payload from `Map<docId, Map<term, tf>>` + `Map<term, Set<docId>>`
// into flat Int32Array/Uint32Array runs (4.8x less heap on the real 94,430-doc store). The public
// API did not change, so the EXISTING suite (lexicalIndex.test.ts) still passes — and would still
// pass against most ways of getting the packing wrong. That is the danger: every bug in this layout
// is SILENT. It does not throw, it does not crash, it does not fail a type check. It quietly returns
// the wrong documents.
//
// The seams, and what each one corrupts if it slips:
//
//   ascending postings  a run is binary-searched by insert/remove. Break the order and `remove`
//                       silently fails to find its posting -> a stale docNum lingers -> the next doc
//                       to RECYCLE that slot inherits it -> a document answers a query for a word it
//                       has never contained. Note `search` scans linearly, so the corrupt state is
//                       INVISIBLE at the moment it is created; it only surfaces one edit later.
//   parallel tf array   `postings[t]` and `postingTf[t]` are two arrays that must be memmoved
//                       together. Shift one and not the other and every doc after the splice point
//                       inherits its neighbour's term frequency -> wrong ranking, right doc set.
//   free lists          a term whose df hits 0 is deleted and its id recycled; so is a removed doc's
//                       slot. Recycle an id without retiring what pointed at it and term A aliases
//                       term B (or doc A answers to doc B's postings).
//   addMany fast path   appends to the end of each run. Sorted only because a FRESH index hands out
//                       strictly ascending docNums. After any removal that is false, and the guard
//                       that falls back to per-doc sorted insert is the only thing standing between
//                       this index and the corruption above.
//   df == pLen          `search` reads df straight off the run length. A leaked posting inflates df,
//                       which can drive the BM25+ idf NEGATIVE.
//
// So the tests below do not merely poke the public API. Each one runs `checkInvariants`, which
// rebuilds the entire expected inverted index from the corpus and compares it against the packed
// arrays cell by cell, and `RefIndex`, an independent v1-layout BM25 that the packed scores are
// compared against BIT-FOR-BIT (`toBe`, not `toBeCloseTo` — a representation change must not move a
// single ulp, and `toBeCloseTo` would hide exactly the tf/length drift these tests exist to find).

import { describe, it, expect } from 'vitest'
import { LexicalIndex, tokenizeLexical } from '../../src/main/lexicalIndex'

const K1 = 1.2
const B = 0.75

type Doc = { id: string; content: string }
type Hit = { id: string; score: number }

// ---------------------------------------------------------------------------------------------
// Independent oracle: the v1 storage layout (nested Maps of STRINGS — no interning, no typed
// arrays, no free lists, no binary search), scoring with the same BM25 arithmetic in the same
// association order. Anything the packed layout gets structurally wrong shows up as a divergence
// here. Deliberately dumb: it recomputes df by scanning every document on every query.
// ---------------------------------------------------------------------------------------------
class RefIndex {
  private docs = new Map<string, Map<string, number>>()
  private docLen = new Map<string, number>()
  private totalLen = 0

  get size(): number {
    return this.docs.size
  }

  add(docId: string, text: string): void {
    if (this.docs.has(docId)) this.remove(docId)
    const tokens = tokenizeLexical(text)
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    this.docs.set(docId, tf)
    this.docLen.set(docId, tokens.length)
    this.totalLen += tokens.length
  }

  remove(docId: string): void {
    if (!this.docs.has(docId)) return
    this.totalLen -= this.docLen.get(docId) ?? 0
    this.docLen.delete(docId)
    this.docs.delete(docId)
  }

  search(query: string, k: number, allow?: (docId: string) => boolean): Hit[] {
    const qTokens = [...new Set(tokenizeLexical(query))]
    const N = this.docs.size
    if (qTokens.length === 0 || N === 0 || k <= 0) return []
    const avgdl = this.totalLen / N || 1
    const scores = new Map<string, number>()
    for (const term of qTokens) {
      let df = 0
      for (const tf of this.docs.values()) if (tf.has(term)) df++
      if (df === 0) continue
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      for (const [docId, tfm] of this.docs) {
        const tf = tfm.get(term)
        if (tf === undefined) continue
        if (allow && !allow(docId)) continue
        const dl = this.docLen.get(docId) ?? 0
        const denom = tf + K1 * (1 - B + B * (dl / avgdl))
        scores.set(docId, (scores.get(docId) ?? 0) + (idf * (tf * (K1 + 1))) / (denom || 1))
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, k)
  }
}

// ---------------------------------------------------------------------------------------------
// White-box view of the packed arrays. Reaching into privates is the point of this file: the
// invariants under test ARE the private representation, and a black-box test cannot see a corrupt
// run until an unrelated edit later turns it into a wrong search result.
// ---------------------------------------------------------------------------------------------
interface Packed {
  termId: Map<string, number>
  termOf: (string | null)[]
  freeTerms: number[]
  postings: (Int32Array | null)[]
  postingTf: (Uint32Array | null)[]
  pLen: number[]
  docNum: Map<string, number>
  docIdOf: (string | null)[]
  freeDocs: number[]
  docTerms: (Int32Array | null)[]
  dLen: number[]
  nDocs: number
  totalLen: number
}
const peek = (idx: LexicalIndex): Packed => idx as unknown as Packed

/**
 * Rebuild the whole expected inverted index from the corpus and compare it to the packed arrays,
 * CELL BY CELL. Every check below is a real assertion; they are accumulated into `errs` and asserted
 * once rather than through ~700k individual `expect()` calls, because this runs after every
 * operation in the fuzz and chai's overhead — not the checking — dominated the runtime. Failure
 * output is strictly better this way: you get every violation at once, not just the first.
 */
function checkInvariants(idx: LexicalIndex, corpus: Map<string, string>, label: string): void {
  const P = peek(idx)
  const errs: string[] = []
  const bad = (msg: string) => {
    if (errs.length < 12) errs.push(msg) // cap the noise; 12 is plenty to diagnose
  }

  // --- doc interning is a bijection with the live corpus ---
  if (idx.size !== corpus.size) bad(`size ${idx.size} != ${corpus.size}`)
  if (P.nDocs !== corpus.size) bad(`nDocs ${P.nDocs} != ${corpus.size}`)
  if (P.docNum.size !== corpus.size) bad(`docNum.size ${P.docNum.size} != ${corpus.size}`)
  const liveDocNums = new Set<number>()
  for (const [id, d] of P.docNum) {
    if (!corpus.has(id)) bad(`index holds unknown doc "${id}"`)
    if (P.docIdOf[d] !== id) bad(`docIdOf[${d}] is "${P.docIdOf[d]}", must round-trip "${id}"`)
    if (liveDocNums.has(d)) bad(`docNum ${d} is assigned to two live docs`)
    liveDocNums.add(d)
  }
  // A recycled slot must be fully retired, or the next doc to claim it inherits a ghost.
  for (const d of P.freeDocs) {
    if (liveDocNums.has(d)) bad(`freeDocs holds LIVE docNum ${d}`)
    if (P.docIdOf[d] !== null) bad(`freed docNum ${d} still names doc "${P.docIdOf[d]}"`)
    if (P.docTerms[d] !== null) bad(`freed docNum ${d} still holds a term list`)
  }

  // --- totalLen drives avgdl, so a leak here silently reweights EVERY score ---
  let expectedTotal = 0
  for (const content of corpus.values()) expectedTotal += tokenizeLexical(content).length
  if (P.totalLen !== expectedTotal) bad(`totalLen ${P.totalLen} != ${expectedTotal}`)

  // --- term interning: no aliasing. This is the free list's sharpest edge: recycle an id while a
  //     stale string still maps to it and a query for term A returns the docs of term B. ---
  for (const [term, t] of P.termId) {
    if (P.termOf[t] !== term) bad(`termId["${term}"]=${t} but termOf[${t}] is "${P.termOf[t]}" — ALIASED`)
    if (P.freeTerms.includes(t)) bad(`live term "${term}" (id ${t}) is on the free list`)
  }
  for (const t of P.freeTerms) {
    if (P.termOf[t] !== null) bad(`freed termId ${t} still names term "${P.termOf[t]}"`)
    if ((P.postings[t] ?? null) !== null) bad(`freed termId ${t} still holds postings`)
    if ((P.postingTf[t] ?? null) !== null) bad(`freed termId ${t} still holds tfs`)
    if ((P.pLen[t] ?? 0) !== 0) bad(`freed termId ${t} has pLen ${P.pLen[t]}`)
  }

  // --- the expected inverted index, rebuilt from scratch ---
  const want = new Map<string, Map<string, number>>() // term -> docId -> tf
  for (const [id, content] of corpus) {
    for (const tok of tokenizeLexical(content)) {
      let m = want.get(tok)
      if (!m) {
        m = new Map()
        want.set(tok, m)
      }
      m.set(id, (m.get(id) ?? 0) + 1)
    }
  }

  const seen = new Set<string>()
  for (let t = 0; t < P.termOf.length; t++) {
    const term = P.termOf[t]
    if (term === null || term === undefined) {
      if ((P.postings[t] ?? null) !== null) bad(`dead term slot ${t} still holds postings`)
      continue
    }
    seen.add(term)
    const arr = P.postings[t]
    const tfs = P.postingTf[t]
    const len = P.pLen[t] ?? 0
    if (!(arr instanceof Int32Array)) {
      bad(`live term "${term}" has no postings run`)
      continue
    }
    if (!(tfs instanceof Uint32Array)) {
      bad(`live term "${term}" has no tf run`)
      continue
    }
    // capacity >= length, and the two runs must be grown in lockstep
    if (len > arr.length) bad(`pLen["${term}"]=${len} exceeds capacity ${arr.length}`)
    if (tfs.length !== arr.length) bad(`postings/postingTf capacity diverged for "${term}": ${arr.length} vs ${tfs.length}`)
    if (len === 0) bad(`term "${term}" is live with an EMPTY run (it should have been recycled)`)

    const wantTerm = want.get(term)
    if (!wantTerm) {
      bad(`term "${term}" is live but occurs in NO document`)
      continue
    }
    // `search` reads df straight off the run length — a leaked posting here flips idf negative.
    if (len !== wantTerm.size) bad(`df (== pLen) for "${term}" is ${len}, expected ${wantTerm.size}`)

    let prev = -1
    const got = new Map<string, number>()
    for (let i = 0; i < Math.min(len, arr.length); i++) {
      const d = arr[i]
      if (d <= prev) {
        bad(`postings["${term}"] is NOT strictly ascending at ${i}: [${Array.from(arr.subarray(0, len))}]`)
        break
      }
      prev = d
      const docId = P.docIdOf[d]
      if (docId === null || docId === undefined) {
        bad(`postings["${term}"] points at DEAD docNum ${d}`)
        continue
      }
      got.set(docId, tfs[i])
    }
    // exact (doc -> tf) pairs: catches a postings/postingTf memmove that only moved one of them
    for (const [docId, tf] of wantTerm) {
      if (!got.has(docId)) bad(`postings["${term}"] is MISSING doc "${docId}"`)
      else if (got.get(docId) !== tf) bad(`tf for "${term}" in "${docId}" is ${got.get(docId)}, expected ${tf}`)
    }
    for (const docId of got.keys()) {
      if (!wantTerm.has(docId)) bad(`postings["${term}"] holds doc "${docId}", which does NOT contain that term`)
    }
  }
  for (const term of want.keys()) {
    if (!seen.has(term)) bad(`corpus term "${term}" is MISSING from the index`)
    if (P.termId.get(term) === undefined) bad(`corpus term "${term}" is missing from termId`)
  }

  // --- per-doc term lists (used only by remove; if these drift, removal leaks postings) ---
  for (const [id, d] of P.docNum) {
    const tokens = tokenizeLexical(corpus.get(id) ?? '')
    if ((P.dLen[d] ?? 0) !== tokens.length) bad(`dLen for "${id}" is ${P.dLen[d]}, expected ${tokens.length}`)
    const terms = P.docTerms[d]
    if (!(terms instanceof Int32Array)) {
      bad(`docTerms for live doc "${id}" is not a run`)
      continue
    }
    const gotTerms = new Set<string>()
    for (let i = 0; i < terms.length; i++) {
      const term = P.termOf[terms[i]]
      if (term === null || term === undefined) bad(`docTerms["${id}"] points at dead termId ${terms[i]}`)
      else gotTerms.add(term)
    }
    const wantTerms = new Set(tokens)
    if (gotTerms.size !== wantTerms.size) {
      bad(`docTerms for "${id}": ${gotTerms.size} terms, expected ${wantTerms.size}`)
    }
    for (const term of wantTerms) {
      if (!gotTerms.has(term)) bad(`docTerms for "${id}" is missing "${term}"`)
    }
  }

  expect(errs, `${label}: PACKED-INDEX INVARIANTS VIOLATED`).toEqual([])
}

/** Same ids in the same order, and the same scores to the last bit. */
function expectSameRanking(actual: Hit[], expected: Hit[], label: string): void {
  expect(
    actual.map((h) => h.id),
    `${label}: ranked ids`,
  ).toEqual(expected.map((h) => h.id))
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i].score, `${label}: score[${i}] for "${expected[i].id}"`).toBe(expected[i].score)
  }
}

const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

const corpusOf = (docs: Doc[]): Map<string, string> => new Map(docs.map((d) => [d.id, d.content]))

const fromAddLoop = (docs: Doc[]): LexicalIndex => {
  const idx = new LexicalIndex()
  for (const d of docs) idx.add(d.id, d.content)
  return idx
}

const refOf = (docs: Doc[]): RefIndex => {
  const r = new RefIndex()
  for (const d of docs) r.add(d.id, d.content)
  return r
}

// A corpus with everything the tokenizer and the scorer can trip over: repeated terms (tf > 1),
// rare terms (idf spikes), shared terms (long postings runs), duplicate content (score ties),
// documents that tokenize to NOTHING, sub-3-char noise, and non-ASCII.
const VOCAB = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
]
function mixedCorpus(): Doc[] {
  const docs: Doc[] = []
  for (let i = 0; i < 60; i++) {
    const words: string[] = []
    const len = 1 + ((i * 7) % 17)
    for (let j = 0; j < len; j++) words.push(VOCAB[(i * 3 + j * 5) % VOCAB.length]) // repeats -> tf > 1
    if (i % 11 === 0) words.push(`uniq${i}`) // df == 1 -> maximal idf
    if (i % 13 === 0) words.push('xy', 'a', 'is') // dropped by the tokenizer, must not reach the index
    docs.push({ id: `doc${String(i).padStart(3, '0')}`, content: words.join(' ') })
  }
  docs.push({ id: 'doc_empty', content: '' })
  docs.push({ id: 'doc_tiny', content: 'a an is it xy' }) // tokenizes to []
  docs.push({ id: 'doc_uni', content: 'café naïve 日本語 résumé' })
  docs.push({ id: 'doc_dup1', content: 'needle in the haystack' }) // identical content ->
  docs.push({ id: 'doc_dup2', content: 'needle in the haystack' }) // ... an exact score tie
  docs.push({ id: 'doc_tf', content: 'alpha alpha alpha alpha alpha alpha' }) // tf == 6
  return docs
}

const QUERIES = [
  'alpha',
  'alpha bravo charlie',
  'needle haystack',
  'uniq011',
  'caf',
  'zzz_no_such_term',
  'alpha alpha alpha', // duplicate query terms
  'mike november oscar papa',
  'delta echo uniq022 zzz_no_such_term',
]

// ==============================================================================================
// 1. THE ASCENDING-POSTINGS INVARIANT — the one that silently corrupts recall.
// ==============================================================================================
describe('packed postings stay ascending across churn', () => {
  // The exact sequence that the addMany fast path would destroy. Every step is chosen so that the
  // damage is INVISIBLE until the step after it — which is precisely why this bug class survives
  // black-box testing.
  it('addMany after removals must not append a recycled (lower) docNum to the end of a run', () => {
    const idx = new LexicalIndex()
    const corpus = new Map<string, string>()
    const put = (id: string, content: string) => {
      idx.add(id, content)
      corpus.set(id, content)
    }
    const drop = (id: string) => {
      idx.remove(id)
      corpus.delete(id)
    }

    // Fresh index -> docNums 0..5 handed out in order. postings["shared"] = [0,1,2,3,4,5].
    const base: Doc[] = [0, 1, 2, 3, 4, 5].map((i) => ({ id: `d${i}`, content: `shared tag${i}` }))
    idx.addMany(base)
    for (const d of base) corpus.set(d.id, d.content)
    expect(peek(idx).freeDocs.length, 'a fresh index must have no recycled slots (fast path is legal)').toBe(0)
    checkInvariants(idx, corpus, 'after fresh addMany')

    // Free the two LOWEST docNums. Now any new doc gets a docNum BELOW those already in the runs.
    drop('d0')
    drop('d1')
    expect(peek(idx).freeDocs.length, 'removals must arm the doc free list').toBeGreaterThan(0)
    checkInvariants(idx, corpus, 'after removing the two lowest docNums')

    // THE TRAP. freeDocs is non-empty, so addMany MUST fall back to sorted per-doc insert. If it
    // took the append fast path, "shared" would become [2,3,4,5,1,0] — and search would still
    // return all six docs, so nothing would look wrong yet.
    const more: Doc[] = [
      { id: 'e0', content: 'shared tage' },
      { id: 'e1', content: 'shared tagf' },
    ]
    idx.addMany(more)
    for (const d of more) corpus.set(d.id, d.content)
    checkInvariants(idx, corpus, 'after addMany onto recycled slots') // <- catches it HERE

    // The damage surfaces one edit later: remove() binary-searches the run. On [2,3,4,5,1,0] the
    // search for e0's docNum (1) lands on index 0, sees 2, and gives up — leaving a live posting
    // pointing at a doc that no longer exists, and df one too high.
    drop('e0')
    checkInvariants(idx, corpus, 'after removing a doc added onto a recycled slot')

    // ...and then the coup de grace: f0 recycles e0's slot and INHERITS the leaked posting, so a
    // document that has never contained the word "shared" answers a search for it.
    put('f0', 'ghost unrelated content')
    checkInvariants(idx, corpus, 'after recycling the leaked slot')

    const hits = idx.search('shared', 10)
    expect(hits.map((h) => h.id), 'a doc that never contained "shared" must never be recalled for it')
      .not.toContain('f0')
    // d2..d5 and e1 all have identical shape (tf 1, dl 2) -> an exact 5-way tie -> id order.
    expect(hits.map((h) => h.id)).toEqual(['d2', 'd3', 'd4', 'd5', 'e1'])
    for (const h of hits) expect(h.score, 'identical docs must score identically').toBe(hits[0].score)

    // The dropped docs and their now-recycled terms must be unreachable.
    expect(idx.search('tag0', 10), 'a term whose df fell to 0 must be gone, not aliased').toEqual([])
    expect(idx.search('tage', 10), 'removed doc e0 must not be recalled by its own term').toEqual([])
    expect(idx.search('tagf', 10).map((h) => h.id)).toEqual(['e1'])
    expect(idx.search('ghost', 10).map((h) => h.id)).toEqual(['f0'])

    expectSameRanking(idx.search('shared tagf ghost', 10), refOf([...corpus].map(([id, content]) => ({ id, content })))
      .search('shared tagf ghost', 10), 'churned index vs oracle')
  })

  it('survives heavy interleaved add / remove / re-add / addMany churn', () => {
    const idx = new LexicalIndex()
    const ref = new RefIndex()
    const corpus = new Map<string, string>()
    const put = (id: string, content: string) => {
      idx.add(id, content)
      ref.add(id, content)
      corpus.set(id, content)
    }
    const drop = (id: string) => {
      idx.remove(id)
      ref.remove(id)
      corpus.delete(id)
    }
    const putMany = (docs: Doc[]) => {
      idx.addMany(docs)
      for (const d of docs) {
        ref.add(d.id, d.content)
        corpus.set(d.id, d.content)
      }
    }

    putMany(Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, content: `common word${i % 5} tok${i}` })))
    checkInvariants(idx, corpus, 'phase 1')

    for (let i = 0; i < 30; i += 2) drop(`a${i}`) // free 15 slots, scattered
    checkInvariants(idx, corpus, 'phase 2')

    // slow path (freeDocs non-empty): every one of these sorted-inserts INTO the middle of runs
    putMany(Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, content: `common word${i % 3} tok${i}` })))
    checkInvariants(idx, corpus, 'phase 3')

    for (let i = 1; i < 30; i += 4) drop(`a${i}`)
    for (let i = 0; i < 10; i += 3) put(`b${i}`, `common rewritten${i} tok${i}`) // re-add == replace
    checkInvariants(idx, corpus, 'phase 4')

    putMany(Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, content: `common word${i % 7} tok${i}` })))
    for (let i = 0; i < 12; i += 5) drop(`c${i}`)
    put('a1', 'common resurrected tok1') // an id that was removed earlier comes back
    checkInvariants(idx, corpus, 'phase 5')

    for (const q of ['common', 'word0 word1 word2', 'rewritten0', 'resurrected', 'tok7 tok11', 'nothing_here']) {
      expectSameRanking(idx.search(q, 50), ref.search(q, 50), `churn q="${q}"`)
    }
  })
})

// ==============================================================================================
// 2 + 3. addMany MUST equal an add() loop — single shot AND chunked (the production path).
// ==============================================================================================
describe('addMany is indistinguishable from an add() loop', () => {
  const docs = mixedCorpus()
  const corpus = corpusOf(docs)

  // Chunk 200 is LEXICAL_CHUNK, the size swarmMemory's background rebuild actually uses; chunk 1
  // maximises the number of capacity-doubling regrows; 2 and 7 land splits at awkward offsets.
  for (const size of [1, 2, 7, 200]) {
    it(`chunks of ${size} produce byte-identical rankings to add() in a loop`, () => {
      const loop = fromAddLoop(docs)
      const bulk = new LexicalIndex()
      const batches = chunk(docs, size)
      for (const batch of batches) bulk.addMany(batch)

      expect(bulk.size, 'size').toBe(loop.size)
      expect(bulk.size).toBe(docs.length)
      checkInvariants(bulk, corpus, `addMany chunk=${size}`)
      checkInvariants(loop, corpus, 'add() loop')

      const ref = refOf(docs)
      for (const q of QUERIES) {
        const a = bulk.search(q, 100)
        expectSameRanking(a, loop.search(q, 100), `chunk=${size} vs add-loop q="${q}"`)
        expectSameRanking(a, ref.search(q, 100), `chunk=${size} vs oracle q="${q}"`) // both could be wrong the same way
        expectSameRanking(bulk.search(q, 3), ref.search(q, 3), `chunk=${size} k=3 q="${q}"`)
      }
      // the allow() gate must not perturb N/df/avgdl — it filters, it does not re-normalise
      const allow = (id: string) => id.endsWith('1') || id.startsWith('doc_')
      expectSameRanking(bulk.search('alpha bravo', 100, allow), ref.search('alpha bravo', 100, allow), `chunk=${size} allow()`)
    })
  }

  it('a single-shot addMany equals the chunked builds exactly', () => {
    const single = new LexicalIndex()
    single.addMany(docs)
    checkInvariants(single, corpus, 'single-shot addMany')
    const seven = new LexicalIndex()
    for (const batch of chunk(docs, 7)) seven.addMany(batch)
    for (const q of QUERIES) expectSameRanking(single.search(q, 100), seven.search(q, 100), `single vs chunk=7 q="${q}"`)
  })

  it('addMany REPLACES a document already in the index, exactly as add() does', () => {
    // Found by mutation-testing this suite, and fixed rather than pinned. The bulk path appends a
    // freshly-allocated docNum per doc, so without an explicit check a repeat id got a SECOND slot
    // instead of replacing the first: size counted it twice, the SUPERSEDED content stayed
    // searchable forever, and both sets of postings accumulated into the same score key so BM25
    // double-counted the term. Not reachable from swarmMemory today (it always clear()s first and
    // passes distinct ids) — which is exactly what makes it a landmine rather than a fire, and why
    // the docstring promising "same result as calling add in a loop" had to become true.
    const dup = new LexicalIndex()
    dup.add('a', 'alpha shared')
    dup.addMany([{ id: 'a', content: 'beta shared' }])

    expect(dup.size).toBe(1)                                  // replaced, not duplicated
    expect(dup.search('alpha', 10)).toEqual([])               // superseded content is GONE
    expect(dup.search('beta', 10).map((h) => h.id)).toEqual(['a'])

    // ...and the score is not double-counted: it must equal a clean single-document index.
    expectSameRanking(dup.search('shared', 10), refOf([{ id: 'a', content: 'beta shared' }]).search('shared', 10), 'addMany replace')
    checkInvariants(dup, corpusOf([{ id: 'a', content: 'beta shared' }]), 'addMany over an existing id')

    // A duplicate id WITHIN one batch is the same failure, self-inflicted: last write wins.
    const within = new LexicalIndex()
    within.addMany([{ id: 'x', content: 'first version' }, { id: 'x', content: 'second version' }])
    expect(within.size).toBe(1)
    expect(within.search('first', 10)).toEqual([])
    expect(within.search('second', 10).map((h) => h.id)).toEqual(['x'])
    checkInvariants(within, corpusOf([{ id: 'x', content: 'second version' }]), 'duplicate id within one batch')
  })
})

// ==============================================================================================
// 4. TERM free-list recycling — a query for term A must never return the docs of term B.
// ==============================================================================================
describe('term free list', () => {
  it('recycles the id of a term whose df fell to 0 without aliasing the old term to it', () => {
    const idx = new LexicalIndex()
    const corpus = new Map<string, string>()
    // Ballast: keeps N > 0, so an empty-index short circuit can never make these assertions vacuous.
    idx.add('keep', 'ballast content words')
    corpus.set('keep', 'ballast content words')

    idx.add('doc_a', 'zzzunique alphaonly')
    corpus.set('doc_a', 'zzzunique alphaonly')
    const idOfZzz = peek(idx).termId.get('zzzunique')
    expect(idOfZzz, 'zzzunique must be interned').toBeDefined()

    idx.remove('doc_a')
    corpus.delete('doc_a')
    // df('zzzunique') -> 0, so the term is dropped and its dense id goes on the free list.
    expect(peek(idx).termId.has('zzzunique'), 'a term with df 0 must be dropped from termId').toBe(false)
    expect(peek(idx).freeTerms, 'its id must be recycled').toContain(idOfZzz)
    checkInvariants(idx, corpus, 'after the sole doc holding two unique terms was removed')

    // A DIFFERENT doc with DIFFERENT unique terms now claims those recycled ids.
    idx.add('doc_b', 'yyydifferent betaonly')
    corpus.set('doc_b', 'yyydifferent betaonly')
    const reclaimed = [peek(idx).termId.get('yyydifferent'), peek(idx).termId.get('betaonly')]
    expect(reclaimed, 'the new terms must actually REUSE the recycled ids (else this test proves nothing)')
      .toContain(idOfZzz)
    checkInvariants(idx, corpus, 'after recycling term ids')

    // If postingRemove recycled the id but forgot `termId.delete(term)`, "zzzunique" would still map
    // to that id — which now belongs to "betaonly" — and this would return doc_b.
    expect(idx.search('zzzunique', 10), 'a dropped term must not alias the term that reused its id').toEqual([])
    expect(idx.search('alphaonly', 10)).toEqual([])
    expect(idx.search('yyydifferent', 10).map((h) => h.id)).toEqual(['doc_b'])
    expect(idx.search('betaonly', 10).map((h) => h.id)).toEqual(['doc_b'])
    expect(idx.search('ballast', 10).map((h) => h.id)).toEqual(['keep'])

    const ref = refOf([...corpus].map(([id, content]) => ({ id, content })))
    expectSameRanking(idx.search('yyydifferent betaonly ballast zzzunique', 10), ref.search('yyydifferent betaonly ballast zzzunique', 10), 'term recycling vs oracle')
  })

  it('keeps a shared term alive while ANY doc still holds it, and drops it exactly when none do', () => {
    const idx = new LexicalIndex()
    idx.add('p', 'shared onlyp')
    idx.add('q', 'shared onlyq')
    idx.remove('p')
    expect(peek(idx).termId.has('shared'), 'df 1 > 0 — must NOT be dropped').toBe(true)
    expect(peek(idx).termId.has('onlyp'), 'df 0 — must be dropped').toBe(false)
    expect(idx.search('shared', 10).map((h) => h.id)).toEqual(['q'])
    idx.remove('q')
    expect(peek(idx).termId.has('shared'), 'df 0 — now it must go').toBe(false)
    expect(peek(idx).termId.size, 'the vocabulary must not grow without bound as the window churns').toBe(0)
    expect(idx.size).toBe(0)
  })
})

// ==============================================================================================
// 5. DOC free-list recycling — a new doc must not inherit the postings of the slot it reuses.
// ==============================================================================================
describe('doc free list', () => {
  it('a doc that reuses a removed docNum must not answer to the old doc, its terms, or its length', () => {
    const idx = new LexicalIndex()
    const corpus = new Map<string, string>()
    idx.add('keep', 'shared ballast')
    corpus.set('keep', 'shared ballast')

    idx.add('old_doc', 'shared oldterm oldterm oldterm padding padding') // dl 6, tf(oldterm) 3
    corpus.set('old_doc', 'shared oldterm oldterm oldterm padding padding')
    const oldNum = peek(idx).docNum.get('old_doc')
    expect(oldNum).toBeDefined()

    idx.remove('old_doc')
    corpus.delete('old_doc')
    expect(peek(idx).freeDocs, 'the removed slot must be recycled').toContain(oldNum)
    expect(peek(idx).docIdOf[oldNum!], 'a freed slot must not still name its doc').toBe(null)
    checkInvariants(idx, corpus, 'after removing old_doc')

    idx.add('new_doc', 'shared newterm') // dl 2 — claims old_doc's slot
    corpus.set('new_doc', 'shared newterm')
    expect(peek(idx).docNum.get('new_doc'), 'new_doc must actually REUSE the recycled slot').toBe(oldNum)
    checkInvariants(idx, corpus, 'after new_doc recycled the slot')

    // If remove() had skipped postingRemove (or left docTerms/docIdOf set), new_doc would inherit
    // old_doc's postings and this would return ['new_doc'].
    expect(idx.search('oldterm', 10), 'a recycled slot must not inherit the old doc postings').toEqual([])
    expect(idx.search('padding', 10)).toEqual([])
    expect(idx.search('newterm', 10).map((h) => h.id)).toEqual(['new_doc'])
    expect(idx.search('shared', 10).map((h) => h.id).sort()).toEqual(['keep', 'new_doc'])

    // ...and the recycled slot must carry NEW_doc's length (2), not old_doc's (6). A stale dLen
    // shifts the length-normalisation term and nothing else — right docs, wrong ranking.
    const ref = refOf([...corpus].map(([id, content]) => ({ id, content })))
    expectSameRanking(idx.search('shared', 10), ref.search('shared', 10), 'recycled dLen')
    expectSameRanking(idx.search('shared newterm', 10), ref.search('shared newterm', 10), 'recycled slot vs oracle')
  })
})

// ==============================================================================================
// 6. Capacity doubling — the runs grow 4 -> 8 -> 16 -> 32 -> 64 under the doc that shares a term.
// ==============================================================================================
describe('capacity-doubling growth', () => {
  it('every growth boundary keeps the run intact (incremental add path)', () => {
    const idx = new LexicalIndex()
    const corpus = new Map<string, string>()
    const ref = new RefIndex()
    // 40 docs on one term forces the `len === arr.length` regrow at 4, 8, 16, 32.
    for (let i = 0; i < 40; i++) {
      const content = `common only${i}`
      idx.add(`g${String(i).padStart(2, '0')}`, content)
      ref.add(`g${String(i).padStart(2, '0')}`, content)
      corpus.set(`g${String(i).padStart(2, '0')}`, content)
      // check the run at EVERY step — a regrow that fails to copy the old contents would leave
      // zeroes behind, which read as docNum 0 and would be invisible in a spot check at the end.
      expect(idx.search('common', 100).length, `after ${i + 1} adds`).toBe(i + 1)
    }
    checkInvariants(idx, corpus, 'after 40 adds on one term')
    const t = peek(idx).termId.get('common')!
    expect(peek(idx).pLen[t]).toBe(40)
    expect(peek(idx).postings[t]!.length, 'capacity must have doubled past 40').toBeGreaterThanOrEqual(40)

    // Punch holes in the MIDDLE, then refill. Freed low docNums come back as sorted inserts at
    // index 0, so every one of these memmoves the entire run.
    for (let i = 5; i < 35; i += 3) {
      idx.remove(`g${String(i).padStart(2, '0')}`)
      ref.remove(`g${String(i).padStart(2, '0')}`)
      corpus.delete(`g${String(i).padStart(2, '0')}`)
    }
    checkInvariants(idx, corpus, 'after punching holes')

    for (let i = 0; i < 20; i++) {
      const content = `common refill${i} only${i}` // reuses only0..only19 -> terms that still exist
      idx.add(`h${String(i).padStart(2, '0')}`, content)
      ref.add(`h${String(i).padStart(2, '0')}`, content)
      corpus.set(`h${String(i).padStart(2, '0')}`, content)
    }
    checkInvariants(idx, corpus, 'after refilling onto recycled slots')

    const live = [...corpus.keys()].sort()
    expect(idx.search('common', 200).map((h) => h.id).sort()).toEqual(live)
    expectSameRanking(idx.search('common', 200), ref.search('common', 200), 'grown+churned run vs oracle')
    for (let i = 0; i < 20; i++) {
      expect(idx.search(`refill${i}`, 10).map((h) => h.id)).toEqual([`h${String(i).padStart(2, '0')}`])
    }
  })

  it('bulk growth across many chunks never truncates a run', () => {
    // addMany's pass-2 sizes each run to max(len + n, cap * 2, 4). Get `need` wrong (e.g. `n`
    // instead of `len + n`) and the pass-3 writes fall off the end of the typed array — where they
    // are SILENTLY DISCARDED, no throw — while pLen keeps counting. Docs simply vanish.
    const docs: Doc[] = Array.from({ length: 300 }, (_, i) => ({ id: `z${String(i).padStart(3, '0')}`, content: `common tok${i % 9} u${i}` }))
    for (const size of [1, 3, 200]) {
      const idx = new LexicalIndex()
      for (const batch of chunk(docs, size)) idx.addMany(batch)
      checkInvariants(idx, corpusOf(docs), `bulk growth chunk=${size}`)
      expect(idx.search('common', 400).length, `chunk=${size}: every doc must survive the regrows`).toBe(300)
      expectSameRanking(idx.search('common tok3 u77', 10), refOf(docs).search('common tok3 u77', 10), `bulk growth chunk=${size}`)
    }
  })
})

// ==============================================================================================
// 7. Deterministic tie-break — equal scores must not depend on insertion history.
// ==============================================================================================
describe('deterministic tie-break', () => {
  const TIE = 0.1823215567939546 // ln(1 + 0.5/2.5) * 2.2 / (1 + 1.2*(0.25 + 0.75*1)) with N=2, dl=avgdl=3

  it('identical documents rank by id, whatever order they were inserted in', () => {
    const forward = fromAddLoop([
      { id: 'zzz_doc', content: 'needle in the haystack' },
      { id: 'aaa_doc', content: 'needle in the haystack' },
    ])
    const backward = fromAddLoop([
      { id: 'aaa_doc', content: 'needle in the haystack' },
      { id: 'zzz_doc', content: 'needle in the haystack' },
    ])
    const bulk = new LexicalIndex()
    bulk.addMany([
      { id: 'zzz_doc', content: 'needle in the haystack' },
      { id: 'aaa_doc', content: 'needle in the haystack' },
    ])

    for (const [name, idx] of [['add fwd', forward], ['add rev', backward], ['addMany', bulk]] as const) {
      const r = idx.search('needle', 10)
      expect(r.map((h) => h.id), `${name}: ties must break on id, not on Map insertion order`).toEqual(['aaa_doc', 'zzz_doc'])
      expect(r[0].score, `${name}: score`).toBe(TIE)
      expect(r[1].score, `${name}: identical docs must score bit-identically`).toBe(TIE)
    }
  })

  it('a k-way tie is stable across insertion orders and across k', () => {
    const ids = ['m', 'e', 'q', 'b', 'x']
    const content = 'tied tied content here'
    const a = fromAddLoop(ids.map((id) => ({ id, content })))
    const b = fromAddLoop([...ids].reverse().map((id) => ({ id, content })))
    const c = new LexicalIndex()
    for (const batch of chunk([...ids].sort().map((id) => ({ id, content })), 2)) c.addMany(batch)

    const want = ['b', 'e', 'm', 'q', 'x']
    for (const [name, idx] of [['fwd', a], ['rev', b], ['chunked', c]] as const) {
      expect(idx.search('tied', 10).map((h) => h.id), `${name}`).toEqual(want)
      // top-k must be a PREFIX of the full ranking — otherwise the tie-break isn't total and a doc
      // can cross the k boundary for no observable reason (the v1 bug this replaced).
      expect(idx.search('tied', 2).map((h) => h.id), `${name} k=2`).toEqual(want.slice(0, 2))
      expect(idx.search('tied', 4).map((h) => h.id), `${name} k=4`).toEqual(want.slice(0, 4))
    }
  })
})

// ==============================================================================================
// 8. size / clear / idempotent re-add.
// ==============================================================================================
describe('size, clear, and idempotent re-add', () => {
  it('re-adding an id REPLACES it — size, stale terms, and totalLen all', () => {
    const idx = new LexicalIndex()
    const corpus = new Map<string, string>()
    idx.add('ballast', 'gamma gamma')
    corpus.set('ballast', 'gamma gamma')

    const long = 'alpha '.repeat(20).trim() // dl 20
    idx.add('d', long)
    corpus.set('d', long)
    expect(peek(idx).totalLen).toBe(22)

    idx.add('d', 'betaword') // dl 1
    corpus.set('d', 'betaword')
    expect(idx.size, 're-add must not grow the corpus').toBe(2)
    // If re-add leaked the old length, avgdl would be (22+1)/2 instead of 3/2 and EVERY score would
    // shift — right docs, wrong ranking, no error anywhere.
    expect(peek(idx).totalLen, 'the replaced doc length must be reclaimed').toBe(3)
    expect(peek(idx).docNum.size, 're-add must not leak a doc slot').toBe(2)
    checkInvariants(idx, corpus, 'after re-add')

    expect(idx.search('alpha', 10), 'the superseded content must be unreachable').toEqual([])
    expect(idx.search('betaword', 10).map((h) => h.id)).toEqual(['d'])
    const ref = refOf([{ id: 'ballast', content: 'gamma gamma' }, { id: 'd', content: 'betaword' }])
    expectSameRanking(idx.search('betaword gamma', 10), ref.search('betaword gamma', 10), 're-add vs oracle')
  })

  it('re-adding identical content is a true no-op on the scores', () => {
    const docs = mixedCorpus().slice(0, 20)
    const a = fromAddLoop(docs)
    const b = fromAddLoop(docs)
    for (const d of docs) b.add(d.id, d.content) // every doc re-added with the same content
    expect(b.size).toBe(a.size)
    checkInvariants(b, corpusOf(docs), 'after re-adding every doc')
    for (const q of QUERIES) expectSameRanking(b.search(q, 100), a.search(q, 100), `re-add idempotence q="${q}"`)
  })

  it('clear() leaves an index indistinguishable from a brand-new one', () => {
    const docs = mixedCorpus()
    const dirty = fromAddLoop(docs)
    dirty.remove('doc001') // arm both free lists before clearing
    dirty.remove('doc002')
    dirty.clear()

    expect(dirty.size).toBe(0)
    const P = peek(dirty)
    expect(P.nDocs).toBe(0)
    expect(P.totalLen).toBe(0)
    expect(P.termId.size, 'clear must not leave a stale term -> id map (it would alias fresh ids)').toBe(0)
    expect(P.docNum.size).toBe(0)
    expect(P.termOf.length).toBe(0)
    expect(P.postings.length).toBe(0)
    expect(P.postingTf.length).toBe(0)
    expect(P.pLen.length).toBe(0)
    expect(P.docIdOf.length).toBe(0)
    expect(P.docTerms.length).toBe(0)
    expect(P.dLen.length).toBe(0)
    expect(P.freeTerms.length).toBe(0)
    // If clear() forgot freeDocs, addMany would take the SLOW path forever — correct but 190
    // chunks of quadratic insert. If it forgot docIdOf/postings but reset termOf, fresh term ids
    // would collide with stale runs and resurrect deleted docs.
    expect(P.freeDocs.length, 'clear must re-arm the addMany fast path').toBe(0)
    expect(dirty.search('alpha', 10), 'nothing may survive clear()').toEqual([])

    // Rebuild in it and it must match a virgin index exactly.
    for (const batch of chunk(docs, 7)) dirty.addMany(batch)
    const virgin = new LexicalIndex()
    for (const batch of chunk(docs, 7)) virgin.addMany(batch)
    checkInvariants(dirty, corpusOf(docs), 'rebuilt after clear')
    for (const q of QUERIES) expectSameRanking(dirty.search(q, 100), virgin.search(q, 100), `post-clear rebuild q="${q}"`)
  })
})

// ==============================================================================================
// 9. Empty / edge cases.
// ==============================================================================================
describe('edge cases', () => {
  it('a doc that tokenizes to NOTHING still counts toward size and toward N', () => {
    const idx = new LexicalIndex()
    idx.add('d1', 'needle')
    idx.add('d2', 'haystack straw')
    // N=2, totalLen=3, avgdl=1.5, df=1 -> ln(2) * 2.2 / (1 + 1.2*(0.25 + 0.75*(1/1.5)))
    expect(idx.search('needle', 10)[0].score).toBe(0.8025914722273051)

    idx.add('d3', '') // no tokens at all
    idx.add('d4', 'a an is it xy') // every token <= 2 chars -> also no tokens
    expect(idx.size, 'an untokenizable doc is still a document').toBe(4)
    expect(peek(idx).totalLen, 'but it contributes no length').toBe(3)
    expect(peek(idx).docTerms[peek(idx).docNum.get('d3')!]!.length).toBe(0)

    // N is now 4, so idf and avgdl BOTH move. A doc the tokenizer emptied is not a doc the scorer
    // may ignore: it changes what "rare" means for every other term in the corpus.
    const after = idx.search('needle', 10)[0].score
    expect(after, 'empty docs must move N (and therefore idf)').not.toBe(0.8025914722273051)
    expectSameRanking(
      idx.search('needle haystack', 10),
      refOf([
        { id: 'd1', content: 'needle' },
        { id: 'd2', content: 'haystack straw' },
        { id: 'd3', content: '' },
        { id: 'd4', content: 'a an is it xy' },
      ]).search('needle haystack', 10),
      'empty docs vs oracle',
    )
    checkInvariants(idx, corpusOf([
      { id: 'd1', content: 'needle' },
      { id: 'd2', content: 'haystack straw' },
      { id: 'd3', content: '' },
      { id: 'd4', content: 'a an is it xy' },
    ]), 'with untokenizable docs')

    // and it must remove cleanly (docTerms is a zero-length Int32Array, not null)
    idx.remove('d3')
    expect(idx.size).toBe(3)
    expect(idx.search('needle', 10)[0].score).not.toBe(after)
  })

  it('addMany handles a batch that is entirely untokenizable, and an empty batch', () => {
    const idx = new LexicalIndex()
    idx.addMany([]) // must not throw, must not allocate a doc
    expect(idx.size).toBe(0)
    idx.addMany([{ id: 'e1', content: '' }, { id: 'e2', content: 'a is it' }])
    expect(idx.size).toBe(2)
    expect(idx.search('anything', 10)).toEqual([])
    idx.addMany([{ id: 'e3', content: 'real content here' }])
    expect(idx.search('content', 10).map((h) => h.id)).toEqual(['e3'])
    checkInvariants(idx, corpusOf([
      { id: 'e1', content: '' },
      { id: 'e2', content: 'a is it' },
      { id: 'e3', content: 'real content here' },
    ]), 'addMany with untokenizable docs')
  })

  it('empty query, k <= 0, and absent terms all return []', () => {
    const idx = fromAddLoop([{ id: 'd', content: 'some content here' }])
    expect(idx.search('', 10)).toEqual([])
    expect(idx.search('   ', 10)).toEqual([])
    expect(idx.search('xy a is', 10), 'a query of sub-3-char tokens tokenizes to nothing').toEqual([])
    expect(idx.search('content', 0)).toEqual([])
    expect(idx.search('content', -5)).toEqual([])
    expect(idx.search('nosuchterm', 10)).toEqual([])
    expect(idx.search('content nosuchterm', 10).map((h) => h.id), 'an absent term must not veto a present one').toEqual(['d'])
    expect(idx.search('content', 999).length, 'k larger than the result set is fine').toBe(1)
    expect(new LexicalIndex().search('anything', 10), 'empty corpus').toEqual([])
    expect(() => idx.remove('never_added')).not.toThrow()
  })

  it('duplicate query terms are counted once', () => {
    const idx = fromAddLoop([
      { id: 'a', content: 'needle needle haystack' },
      { id: 'b', content: 'needle haystack haystack' },
    ])
    const once = idx.search('needle', 10)
    const thrice = idx.search('needle needle needle', 10)
    expect(thrice.map((h) => h.id)).toEqual(once.map((h) => h.id))
    for (let i = 0; i < once.length; i++) {
      expect(thrice[i].score, 'a repeated query term must not multiply the score').toBe(once[i].score)
    }
  })

  it('non-ASCII content is indexed exactly as the tokenizer leaves it', () => {
    // \W is ASCII-only (no /u flag), so accented and CJK characters SPLIT tokens. Pinned because a
    // well-meaning `/\W+/u` would silently change what is recallable across the whole store.
    expect(tokenizeLexical('café naïve 日本語 résumé')).toEqual(['caf', 'sum'])
    expect(tokenizeLexical('ÜBER straße')).toEqual(['ber', 'stra'])
    expect(tokenizeLexical('日本語 テスト')).toEqual([])

    const docs: Doc[] = [
      { id: 'u1', content: 'café naïve 日本語 résumé' },
      { id: 'u2', content: 'emoji 🚀 rocket' },
      { id: 'u3', content: 'plain ascii content' },
    ]
    const idx = new LexicalIndex()
    idx.addMany(docs)
    checkInvariants(idx, corpusOf(docs), 'non-ASCII')
    expect(idx.search('caf', 10).map((h) => h.id)).toEqual(['u1'])
    expect(idx.search('café', 10).map((h) => h.id), 'the query tokenizes the same way').toEqual(['u1'])
    expect(idx.search('rocket', 10).map((h) => h.id)).toEqual(['u2'])
    expect(idx.search('日本語', 10), 'CJK tokenizes to nothing — not an error, just no hits').toEqual([])
    expectSameRanking(idx.search('caf sum rocket', 10), refOf(docs).search('caf sum rocket', 10), 'non-ASCII vs oracle')
  })

  it('allow() filters results without re-normalising idf, N, or avgdl', () => {
    const docs: Doc[] = [
      { id: 'a', content: 'needle alpha' },
      { id: 'b', content: 'needle beta gamma' },
      { id: 'c', content: 'needle delta epsilon zeta' },
    ]
    const idx = new LexicalIndex()
    idx.addMany(docs)
    const unfiltered = idx.search('needle', 10)
    const filtered = idx.search('needle', 10, (id) => id === 'b')
    expect(filtered.map((h) => h.id)).toEqual(['b'])
    // A "clever" optimisation that recomputed df/N over the allowed set would move this score.
    expect(filtered[0].score, 'allow() gates, it does not rescore').toBe(unfiltered.find((h) => h.id === 'b')!.score)
    expect(idx.search('needle', 10, () => false), 'a gate that admits nothing').toEqual([])
  })
})

// ==============================================================================================
// 10. tf correctness — postings and postingTf must be memmoved in LOCKSTEP.
// ==============================================================================================
describe('term frequency', () => {
  it('a mid-run removal must not slide the tf array out of step with the postings array', () => {
    // All five docs are exactly 12 tokens long, so length normalisation is identical and the
    // ranking is a pure function of tf. tf by insertion order (== docNum order == postings order):
    //
    //        docNum   0    1    2    3    4
    //        doc     bm0  bm1  bm2  bm3  bm4
    //        tf        1    2    1    9    3
    //
    // Remove bm2 (docNum 2, the MIDDLE). postings memmoves to [0,1,3,4]. If postingTf is not
    // memmoved with it, it still reads [1,2,1,9] — so bm3 inherits bm2's tf of 1 and is dumped to
    // the bottom, while bm4 inherits bm3's 9 and is promoted to the TOP. Right doc set. Wrong
    // answer. That is what a silently-desynchronised parallel array looks like from the outside.
    const pad = (alpha: number) => ('alpha '.repeat(alpha) + 'pad '.repeat(12 - alpha)).trim()
    const docs: Doc[] = [
      { id: 'bm0', content: pad(1) },
      { id: 'bm1', content: pad(2) },
      { id: 'bm2', content: pad(1) },
      { id: 'bm3', content: pad(9) },
      { id: 'bm4', content: pad(3) },
    ]
    const idx = fromAddLoop(docs)
    for (const d of docs) expect(tokenizeLexical(d.content).length, `${d.id} must be 12 tokens`).toBe(12)
    checkInvariants(idx, corpusOf(docs), 'before the mid-run removal')

    idx.remove('bm2')
    const corpus = corpusOf(docs.filter((d) => d.id !== 'bm2'))
    checkInvariants(idx, corpus, 'after the mid-run removal') // exact (doc -> tf) pairs

    const r = idx.search('alpha', 10)
    expect(r.map((h) => h.id), 'tf must survive the memmove: 9 > 3 > 2 > 1').toEqual(['bm3', 'bm4', 'bm1', 'bm0'])
    expectSameRanking(r, refOf(docs.filter((d) => d.id !== 'bm2')).search('alpha', 10), 'tf lockstep vs oracle')

    // and again with a removal at the FRONT and at the BACK of the same run
    idx.remove('bm0')
    idx.remove('bm4')
    const corpus2 = corpusOf(docs.filter((d) => ['bm1', 'bm3'].includes(d.id)))
    checkInvariants(idx, corpus2, 'after front and back removals')
    expect(idx.search('alpha', 10).map((h) => h.id)).toEqual(['bm3', 'bm1'])
  })

  it('a mid-run INSERT keeps tf in step (the recycled-slot path memmoves right, not left)', () => {
    const idx = new LexicalIndex()
    const corpus = new Map<string, string>()
    const pad = (alpha: number) => ('alpha '.repeat(alpha) + 'pad '.repeat(12 - alpha)).trim()
    for (let i = 0; i < 6; i++) {
      idx.add(`i${i}`, pad(i + 1))
      corpus.set(`i${i}`, pad(i + 1))
    }
    idx.remove('i2') // frees docNum 2, in the middle of the run
    idx.remove('i4')
    corpus.delete('i2')
    corpus.delete('i4')
    // These reclaim docNums 4 and 2 -> sorted-INSERT into the middle -> copyWithin(lo+1, lo, len)
    // on BOTH arrays. Skip it on postingTf and the docs after the splice point read a neighbour's tf.
    idx.add('j0', pad(11))
    idx.add('j1', pad(7))
    corpus.set('j0', pad(11))
    corpus.set('j1', pad(7))
    checkInvariants(idx, corpus, 'after mid-run inserts onto recycled slots')

    const ref = new RefIndex()
    for (const [id, content] of corpus) ref.add(id, content)
    expectSameRanking(idx.search('alpha', 10), ref.search('alpha', 10), 'mid-run insert vs oracle')
    // tf 11 > 7 > 6 > 4 > 2 > 1  (i5=6, i3=4, i1=2, i0=1)
    expect(idx.search('alpha', 10).map((h) => h.id)).toEqual(['j0', 'j1', 'i5', 'i3', 'i1', 'i0'])
  })

  it('a term repeated many times outscores one occurrence, and the stored tf is exact', () => {
    const idx = fromAddLoop([
      { id: 'one', content: 'term one' },
      { id: 'many', content: `${'term '.repeat(50).trim()} one` },
    ])
    const t = peek(idx).termId.get('term')!
    const d = peek(idx).docNum.get('many')!
    const arr = peek(idx).postings[t]!
    const tfs = peek(idx).postingTf[t]!
    const at = Array.from(arr.subarray(0, peek(idx).pLen[t])).indexOf(d)
    expect(tfs[at], 'the packed tf must be the exact count, not a saturated or clamped one').toBe(50)
    expect(idx.search('term', 10)[0].id).toBe('many')

    // Uint32Array must hold a large tf without wrapping (real max on the store is 196).
    const big = new LexicalIndex()
    big.add('huge', 'zzz '.repeat(70000).trim())
    big.add('other', 'zzz once')
    const bt = peek(big).termId.get('zzz')!
    const bd = peek(big).docNum.get('huge')!
    const barr = peek(big).postings[bt]!
    const bAt = Array.from(barr.subarray(0, peek(big).pLen[bt])).indexOf(bd)
    expect(peek(big).postingTf[bt]![bAt], 'tf must not wrap in the Uint32Array').toBe(70000)
  })
})

// ==============================================================================================
// THE CHECKER'S OWN TEST. `checkInvariants` reaches into privates, so it has a failure mode no
// other test here has: if a field is ever renamed, `peek()` starts reading `undefined`, every loop
// degrades to a no-op, and the checker goes BLIND while staying GREEN — the worst possible outcome
// for the file whose entire job is catching silent corruption. So corrupt each class of internal
// state by hand and prove the checker screams. (This is also what keeps the checker honest after a
// refactor: an assertion you cannot see fail is not an assertion.)
// ==============================================================================================
describe('the invariant checker detects every class of corruption', () => {
  const build = (): { idx: LexicalIndex; corpus: Map<string, string> } => {
    const docs: Doc[] = [
      { id: 'c0', content: 'shared alpha alpha' },
      { id: 'c1', content: 'shared beta' },
      { id: 'c2', content: 'shared gamma delta' },
      { id: 'c3', content: 'shared epsilon' },
    ]
    const idx = fromAddLoop(docs)
    idx.remove('c1') // arm both free lists, so the freed-slot checks are live too
    return { idx, corpus: corpusOf(docs.filter((d) => d.id !== 'c1')) }
  }
  const expectCaught = (mutate: (P: Packed, idx: LexicalIndex) => void) => {
    const { idx, corpus } = build()
    checkInvariants(idx, corpus, 'sanity') // the un-corrupted index must PASS
    mutate(peek(idx), idx)
    expect(() => checkInvariants(idx, corpus, 'corrupted')).toThrow()
  }
  const sharedTerm = (P: Packed) => P.termId.get('shared')!

  it('catches a postings run that is no longer ascending', () =>
    expectCaught((P) => {
      const arr = P.postings[sharedTerm(P)]!
      const t = arr[0]
      arr[0] = arr[1]
      arr[1] = t
    }))

  it('catches postingTf drifting out of step with postings', () =>
    expectCaught((P) => {
      P.postingTf[sharedTerm(P)]![1] += 7
    }))

  it('catches a leaked posting inflating df (== pLen)', () =>
    expectCaught((P) => {
      P.pLen[sharedTerm(P)] += 1
    }))

  it('catches a term string aliased onto another term id', () =>
    expectCaught((P) => {
      P.termId.set('zzz_ghost_term', sharedTerm(P))
    }))

  it('catches a freed doc slot that still names its document', () =>
    expectCaught((P) => {
      P.docIdOf[P.freeDocs[0]] = 'c1'
    }))

  it('catches totalLen drift (which would silently reweight every score)', () =>
    expectCaught((P) => {
      P.totalLen += 1
    }))

  it('catches a stale per-doc length', () =>
    expectCaught((P) => {
      P.dLen[P.docNum.get('c0')!] = 99
    }))

  it('catches a doc missing from a term it contains', () =>
    expectCaught((P) => {
      P.pLen[sharedTerm(P)] -= 1
    }))
})

// ==============================================================================================
// FUZZ — a seeded random walk over every mutation, checked against the oracle and the invariants
// after every single operation. This is the net that catches the case nobody thought of.
// ==============================================================================================
describe('randomised differential fuzz', () => {
  const mulberry32 = (seed: number) => () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  it('1200 random ops keep the packed arrays identical to a v1-layout oracle', () => {
    const rnd = mulberry32(0xc0ffee)
    const vocab = Array.from({ length: 24 }, (_, i) => `w${i}`)
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]
    const body = () => {
      const n = Math.floor(rnd() * 14)
      const words: string[] = []
      for (let i = 0; i < n; i++) words.push(pick(vocab)) // repeats -> tf > 1
      if (rnd() < 0.15) words.push('a', 'is') // dropped tokens
      if (rnd() < 0.1) return '' // untokenizable doc
      return words.join(' ')
    }

    const idx = new LexicalIndex()
    const ref = new RefIndex()
    const corpus = new Map<string, string>()
    let nextId = 0

    for (let step = 0; step < 1200; step++) {
      const live = [...corpus.keys()]
      const roll = rnd()

      if (roll < 0.35 || live.length === 0) {
        // add: sometimes a brand-new id, sometimes a REPLACE of an existing one
        const id = live.length > 0 && rnd() < 0.3 ? pick(live) : `f${nextId++}`
        const content = body()
        idx.add(id, content)
        ref.add(id, content)
        corpus.set(id, content)
      } else if (roll < 0.6) {
        const id = pick(live)
        idx.remove(id)
        ref.remove(id)
        corpus.delete(id)
      } else if (roll < 0.85) {
        // addMany with ids NOT already present (the supported contract — see the dup-id test)
        const batch: Doc[] = []
        const size = 1 + Math.floor(rnd() * 8)
        for (let i = 0; i < size; i++) batch.push({ id: `f${nextId++}`, content: body() })
        idx.addMany(batch)
        for (const d of batch) {
          ref.add(d.id, d.content)
          corpus.set(d.id, d.content)
        }
      } else {
        const q = [pick(vocab), pick(vocab), pick(vocab)].join(' ')
        expectSameRanking(idx.search(q, 25), ref.search(q, 25), `fuzz step ${step} q="${q}"`)
      }

      // Structural check every step: catch the corruption where it HAPPENS, not three edits later.
      if (step % 25 === 0 || step > 1150) checkInvariants(idx, corpus, `fuzz step ${step}`)
    }

    checkInvariants(idx, corpus, 'fuzz final')
    for (const w of vocab) expectSameRanking(idx.search(w, 50), ref.search(w, 50), `fuzz final q="${w}"`)
    expectSameRanking(idx.search(vocab.join(' '), 100), ref.search(vocab.join(' '), 100), 'fuzz final: every term at once')
  }, 60_000)
})
