// Degradation tests for the BM25 lexical index's DESYNC GUARDS.
//
// `lexicalIndex.ts` keeps ~8.4M postings in a dozen parallel typed arrays and plain arrays
// (postings / postingTf / pLen, docIdOf / docTerms / dLen, plus two free lists) that are held in
// step BY HAND at every mutation site. The happy-path suites (lexicalIndex.test.ts,
// lexicalIndexPacked.test.ts) prove those arrays stay in step; this file covers the other half of
// the contract — what the code does WHEN THEY DON'T.
//
// That matters here more than it usually would, because this index is rebuilt in a background
// utilityProcess in chunks, interleaved with live writes and deletes (see
// lexicalBackgroundBuild.test.ts). Every guard below is what stands between one slipped array and
// a hard failure of memory recall: a TypeError thrown out of `remove` (which would abort the
// caller mid-mutation and leave the index worse), a RangeError, or — quietest and worst — a NaN
// leaking into `totalLen` or a score, where it silently rescales or unranks the entire corpus.
//
// So the assertions are all of the same shape: induce exactly one array desync, then show the
// index still answers, still finitely, and still without inventing a document. Where the desync
// genuinely costs data (it usually does) the test says so rather than pretending otherwise — the
// guard's job is to make the damage bounded and deterministic, not to undo it.
//
// Reaching these states needs the private representation, so this file borrows the `Packed` /
// `peek` idiom from lexicalIndexPacked.test.ts verbatim.

import { describe, it, expect } from 'vitest'
import { LexicalIndex } from '../../src/main/lexicalIndex'

const K1 = 1.2
const B = 0.75

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

// `pLen`/`dLen` are `number[]`, so there is no legal way to spell "this slot is gone". A cast is
// the only way to stage the hole that a truncated or partially-rebuilt array would leave behind.
const GONE = undefined as unknown as number

describe('postingRemove tolerates a term whose run has come apart', () => {
  // Each case kills ONE of the three things postingRemove reads before it binary-searches, with a
  // second document alive throughout so `search` still runs its scoring loop (a one-doc index
  // short-circuits on N === 0 and would never reach the guards under test).

  it('a null postings run: remove() still retires the doc, and the term matches nothing', () => {
    const idx = new LexicalIndex()
    idx.add('d1', 'alpha bravo')
    idx.add('d2', 'charlie')
    const p = peek(idx)
    const tAlpha = p.termId.get('alpha')!
    p.postings[tAlpha] = null

    // Without the guard this is `null[mid]` inside the binary search — a TypeError thrown out of
    // `remove`, halfway through unwinding d1, leaving it in docNum with half its postings gone.
    expect(() => idx.remove('d1')).not.toThrow()
    expect(idx.size).toBe(1)
    // postingRemove bailed before it could free the slot, so 'alpha' is still interned. It must
    // still be a dead letter: a runless term answers nothing rather than throwing or hitting.
    expect(idx.search('alpha', 10)).toEqual([])
    // ...and the rest of the index is untouched by the neighbouring damage.
    expect(idx.search('charlie', 10).map((h) => h.id)).toEqual(['d2'])
  })

  it('a null tf run: the postings survive, but the term is unscoreable so it is skipped', () => {
    const idx = new LexicalIndex()
    idx.add('d1', 'alpha bravo')
    idx.add('d2', 'charlie')
    const p = peek(idx)
    const tAlpha = p.termId.get('alpha')!
    p.postingTf[tAlpha] = null

    expect(() => idx.remove('d1')).not.toThrow()
    expect(idx.size).toBe(1)
    // The docNums are still there and d1's is still among them, but with no term frequencies
    // there is no BM25 numerator — scoring off a null tf run would be a TypeError, and skipping
    // is the only answer that cannot invent a number.
    expect(p.postings[tAlpha]).not.toBeNull()
    expect(idx.search('alpha', 10)).toEqual([])
    expect(idx.search('charlie', 10).map((h) => h.id)).toEqual(['d2'])
  })

  it('a zeroed length counter: the run is treated as empty by both remove() and search()', () => {
    const idx = new LexicalIndex()
    idx.add('d1', 'shared alpha')
    idx.add('d2', 'shared bravo')
    const p = peek(idx)
    const tShared = p.termId.get('shared')!
    // The run still physically holds both docNums; only the counter that says how far into it to
    // look has been lost. `len` — not the array's capacity — is the authority everywhere.
    p.pLen[tShared] = 0

    idx.remove('d1')
    expect(idx.size).toBe(1)
    // d2's posting is still sitting in the array, and must NOT be readable behind the counter:
    // scanning to `arr.length` instead of `len` is exactly how a stale cell becomes a ghost hit.
    expect(idx.search('shared', 10)).toEqual([])
    expect(idx.search('bravo', 10).map((h) => h.id)).toEqual(['d2'])
  })

  it('a run that does not actually contain the doc is left alone, not spliced blindly', () => {
    const idx = new LexicalIndex()
    idx.add('d1', 'shared alpha')
    idx.add('d2', 'shared bravo')
    const p = peek(idx)
    const tShared = p.termId.get('shared')!
    // Overwrite d1's cell with a docNum that is not d1's. The binary search still terminates —
    // it always does — and lands on a cell holding somebody else. Without the identity re-check
    // the removal would copyWithin over an INNOCENT posting and silently un-index d2 from
    // 'shared', a corruption that only surfaces as a missing search result much later.
    p.postings[tShared]![0] = 7

    idx.remove('d1')
    expect(idx.size).toBe(1)
    expect(p.pLen[tShared]).toBe(2) // nothing was spliced out
    // The bogus docNum 7 names no document, so the scan skips it instead of reporting a hit with
    // an undefined id; d2's real posting still answers.
    expect(idx.search('shared', 10).map((h) => h.id)).toEqual(['d2'])
  })

  it('retires a term slot whose name entry was lost instead of deleting a bogus key', () => {
    const idx = new LexicalIndex()
    idx.add('d1', 'lonely')
    idx.add('d2', 'other')
    const p = peek(idx)
    const tLonely = p.termId.get('lonely')!
    p.termOf[tLonely] = null

    idx.remove('d1')
    // The slot is still recycled — the free list is what keeps `termOf`/`postings` from growing
    // without bound as the hot window churns, so losing a name must not cost a slot too.
    expect(idx.size).toBe(1)
    expect(p.freeTerms).toContain(tLonely)
    // The name is unrecoverable, so `termId` keeps a dangling key pointing at the freed slot.
    // Nulling the run is what keeps that key harmless: it resolves to nothing, not to whatever
    // term inherits the slot's arrays.
    expect(idx.search('lonely', 10)).toEqual([])
    expect(idx.search('other', 10).map((h) => h.id)).toEqual(['d2'])
  })
})

describe('remove() tolerates a document whose bookkeeping has come apart', () => {
  it('a lost per-doc term list still retires the doc, and its postings go dark', () => {
    const idx = new LexicalIndex()
    idx.add('d1', 'alpha shared')
    idx.add('d2', 'bravo shared')
    const p = peek(idx)
    const d1 = p.docNum.get('d1')!
    // `docTerms` is the ONLY record of which runs a doc appears in; search never reads it. With
    // it gone there is nothing to unwind, so the removal cannot clean the runs — it must still
    // complete the parts it can, because a half-removed doc that stays in docNum can never be
    // removed again (remove() is keyed on docNum) and would leak forever.
    p.docTerms[d1] = null

    idx.remove('d1')
    expect(idx.size).toBe(1)
    expect(p.docNum.has('d1')).toBe(false)
    expect(p.freeDocs).toContain(d1)
    // Both runs still hold d1's docNum. Freeing its slot name is the backstop that keeps those
    // orphaned postings from resurrecting a deleted memory: the scan skips any docNum that no
    // longer names a document.
    expect(idx.search('shared', 10).map((h) => h.id)).toEqual(['d2'])
    expect(idx.search('alpha', 10)).toEqual([])
  })

  it('a removal with no length on file subtracts nothing instead of NaN-ing totalLen', () => {
    const idx = new LexicalIndex()
    idx.add('keep', 'alpha bravo')
    idx.add('drop', 'charlie')
    const p = peek(idx)
    expect(p.totalLen).toBe(3)
    p.dLen[p.docNum.get('drop')!] = GONE

    idx.remove('drop')
    // `totalLen` is corpus-wide and permanent: it divides into avgdl on EVERY later query. One
    // `- undefined` would pin it at NaN forever, and `totalLen / N || 1` would then quietly
    // rescale the whole index to avgdl 1 — every score wrong, nothing thrown, nothing logged.
    // Subtracting 0 leaves avgdl merely stale, which the next full rebuild corrects.
    expect(Number.isNaN(p.totalLen)).toBe(false)
    expect(p.totalLen).toBe(3)

    const hits = idx.search('alpha', 10)
    expect(hits.map((h) => h.id)).toEqual(['keep'])
    expect(Number.isFinite(hits[0].score)).toBe(true)
  })
})

describe('search() degrades to fewer results, never to a wrong or NaN score', () => {
  it('a term with no length counter contributes exactly zero to a mixed query', () => {
    const idx = new LexicalIndex()
    idx.add('d1', 'alpha bravo')
    const p = peek(idx)
    p.pLen[p.termId.get('alpha')!] = GONE

    // `len` is both the loop bound and the document frequency. Undefined would make `i < len`
    // false anyway, but it would ALSO become df — and `Math.log(1 + (N - undefined + 0.5) / ...)`
    // is NaN, which is why the fallback has to happen before df is read, not after.
    expect(idx.search('alpha', 10)).toEqual([])

    const bravoOnly = idx.search('bravo', 10)
    expect(bravoOnly.map((h) => h.id)).toEqual(['d1'])
    // The dead term drops out of the query entirely rather than dragging the surviving term's
    // score with it: querying both terms is indistinguishable from querying the live one.
    expect(idx.search('alpha bravo', 10)).toEqual(bravoOnly)
  })

  it('a document with no length on file is scored as zero-length, not as NaN-length', () => {
    const idx = new LexicalIndex()
    idx.add('d1', 'alpha bravo charlie')
    const p = peek(idx)
    p.dLen[p.docNum.get('d1')!] = GONE

    const [hit] = idx.search('alpha', 10)
    expect(hit.id).toBe('d1')
    // avgdl still comes from totalLen (3), so only THIS document's length normalization moves:
    // dl 0 is the maximum-boost end of the BM25 curve. It over-ranks the doc, which is a bounded
    // and self-correcting error; a NaN here would instead make the doc uncomparable to every
    // other hit and unrankable against the dense half of the hybrid retrieval.
    const idf = Math.log(1 + (1 - 1 + 0.5) / (1 + 0.5))
    expect(hit.score).toBeCloseTo((idf * (1 * (K1 + 1))) / (1 + K1 * (1 - B)), 12)
  })

  it('a NaN length on file still cannot produce a NaN score', () => {
    const idx = new LexicalIndex()
    idx.add('d1', 'alpha bravo charlie')
    const p = peek(idx)
    // NaN is not nullish, so the fallback above does not catch it — it flows straight into the
    // length-normalization term and poisons the denominator. The denominator's own guard is the
    // last line of defence, and it matters because NaN scores do not merely look wrong: the
    // tie-break comparator treats NaN vs NaN as "different scores" and returns NaN, so a single
    // one makes the ORDER of the whole result list implementation-defined.
    p.dLen[p.docNum.get('d1')!] = Number.NaN

    const [hit] = idx.search('alpha', 10)
    expect(hit.id).toBe('d1')
    expect(Number.isNaN(hit.score)).toBe(false)
    const idf = Math.log(1 + (1 - 1 + 0.5) / (1 + 0.5))
    expect(hit.score).toBeCloseTo(idf * (1 * (K1 + 1)), 12) // denominator fell back to 1
  })
})

describe('addMany tolerates a run whose length counter was lost', () => {
  it('restarts the run from zero rather than writing past an undefined offset', () => {
    const idx = new LexicalIndex()
    idx.add('d1', 'shared alpha')
    const p = peek(idx)
    const tShared = p.termId.get('shared')!
    p.pLen[tShared] = GONE

    // The bulk path reads `pLen` twice — once to size the run, once as the append offset — and
    // this is the path the background rebuild takes, chunk after chunk, against an index that
    // live writes are mutating underneath it.
    idx.addMany([{ id: 'd2', content: 'shared bravo' }])

    expect(idx.size).toBe(2)
    // Both reads fall back to 0, so d2 is appended at the head of the run and d1's posting for
    // 'shared' is overwritten. That data loss is the cost of the desync and is not recoverable
    // here — what the fallback buys is that `pLen` comes back a NUMBER. Unguarded,
    // `postings[t][undefined] = d` is a silent no-op on a typed array and `undefined + 1` leaves
    // the counter NaN, so `i < len` never runs and the term vanishes for EVERY document, d2
    // included. Bounded loss beats a silently empty term.
    expect(p.pLen[tShared]).toBe(1)
    expect(idx.search('shared', 10).map((h) => h.id)).toEqual(['d2'])
    // Terms that were not desynced are unaffected in both directions.
    expect(idx.search('alpha', 10).map((h) => h.id)).toEqual(['d1'])
    expect(idx.search('bravo', 10).map((h) => h.id)).toEqual(['d2'])
  })
})
