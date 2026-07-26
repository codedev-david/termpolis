// swarmMemory — the defensive arms of the store's MIDDLE band (the packed-vector codec, the
// hot-window trim, the in-memory compactor, the HNSW persistence file and the search-time
// fusion/rerank arms), which the behavioural suites walk straight past.
//
// The recurring shapes here are:
//
//   * The on-disk vector is a base64 f32 blob, so every decode has to survive a blob of the
//     WRONG length. Guessing instead of returning null is how a store silently starts scoring
//     against garbage (a truncated blob reinterpreted as f32 is still a perfectly valid vector).
//   * LEGACY records — written before `hash`, or carrying a non-EMBED_DIM `embedding` — never
//     get a packed row. So `entryRow.get(e)` is undefined for them and every row-keyed arm in
//     search (MMR similarity, the taste centroid) inverts to its fallback.
//   * BEST-EFFORT I/O around the HNSW graph file. Compaction deletes it, the indexer rewrites
//     it, and BOTH are wrapped in a bare catch: a read-only volume must not cost us the
//     compaction or the search, only the on-disk graph.
//
// Every test asserts what is recalled / what reaches disk / what is NOT read, never merely that
// a line ran. The embedder is mocked (module mock + the `_setEmbedFnForTests` seam) so nothing
// here depends on the bge model — which is how CI runs coverage.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

// `fs` is a PASSTHROUGH mock — every call hits the real filesystem unless a test arms one of
// these hooks. (An ESM namespace export cannot be vi.spyOn'd, and a full auto-mock would strand
// init.) `readPaths` is a plain tap: it is how we prove the max-string SIZE GUARD short-circuits
// BEFORE the utf8 read, which is the entire point of that guard.
const io = vi.hoisted(() => ({
  failWrite: null as null | ((p: unknown) => boolean),
  failRm: null as null | ((p: unknown) => boolean),
  hugeStat: null as null | ((p: unknown) => boolean),
  readPaths: [] as string[],
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const call = (fn: unknown, args: unknown[]): unknown => (fn as (...a: unknown[]) => unknown)(...args)
  const api = {
    ...actual,
    writeFileSync: (...args: unknown[]): unknown => {
      if (io.failWrite?.(args[0])) throw new Error('EACCES: read-only volume')
      return call(actual.writeFileSync, args)
    },
    rmSync: (...args: unknown[]): unknown => {
      if (io.failRm?.(args[0])) throw new Error('EPERM: operation not permitted')
      return call(actual.rmSync, args)
    },
    statSync: (...args: unknown[]): unknown => {
      const real = call(actual.statSync, args) as { size: number }
      // Only `size` is read off this, so a shallow clone is enough to fake the V8 cliff.
      return io.hugeStat?.(args[0]) ? { ...real, size: Number.MAX_SAFE_INTEGER } : real
    },
    readFileSync: (...args: unknown[]): unknown => {
      io.readPaths.push(String(args[0]))
      return call(actual.readFileSync, args)
    },
  }
  return { ...api, default: api }
})

// The embedder module is mocked so nothing pulls in the real bge model; `_setEmbedFnForTests`
// short-circuits ahead of it for every test here, so only EMBED_DIM actually matters.
vi.mock('../../src/main/localEmbedder', () => ({
  EMBED_DIM: 384,
  isEmbedderReady: (): boolean => true,
  embedText: async (): Promise<number[] | null> => null,
}))

import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryList,
  memoryCount,
  memoryClear,
  memoryDelete,
  memoryHasHash,
  memoryFeedback,
  encodeEmbedding,
  decodeEmbedding,
  _resetForTests,
  _setEmbedFnForTests,
  _setMaxEntriesForTests,
  _setLexicalYieldMsForTests,
  _lexicalSizeForTests,
  _whenLexicalSettledForTests,
  _setHnswThresholdForTests,
  _whenHnswSettledForTests,
  _isHnswReadyForTests,
  _vectorStoreSizeForTests,
  _setPrfForTests,
  _setAdaptForTests,
} from '../../src/main/swarmMemory'
import { setSafeStorage } from '../../src/main/secureKeyStore'

const DIM = 384
/** A 384-dim one-hot unit vector — orthogonal to every other index. */
const unit = (i: number): number[] => { const v = new Array(DIM).fill(0); v[i % DIM] = 1; return v }
/** A 384-dim unit vector at exactly cosine `c` from unit(0), tilted along `axis`. */
const atCos = (c: number, axis = 1): number[] => {
  const v = new Array(DIM).fill(0)
  v[0] = c
  v[axis] = Math.sqrt(Math.max(0, 1 - c * c))
  return v
}

let userDir: string
const storeFile = (): string => path.join(userDir, 'swarm-memory.jsonl')
const hnswFile = (): string => path.join(userDir, 'memory-hnsw.json')
const contents = (): string[] => memoryList().map((e) => e.content)
/** Seed the durable store directly — the only way to get records the write API refuses
 *  (no `hash`, empty `content`, a non-EMBED_DIM `embedding`). */
const seedStore = (lines: object[]): void =>
  fs.writeFileSync(storeFile(), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
/** Simulate a relaunch against the same data dir. */
const relaunch = (): void => {
  _resetForTests()
  initSwarmMemory(userDir)
}

const disarm = (): void => {
  io.failWrite = null
  io.failRm = null
  io.hugeStat = null
  io.readPaths.length = 0
}

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-brB-u-'))
  disarm()
  setSafeStorage(null)                  // no OS keychain → default-on encryption stays off
  _resetForTests()
  _setEmbedFnForTests(async () => null) // keyword-only unless a test opts into vectors
})

afterEach(() => {
  disarm()                              // BEFORE the cleanup below — it goes through the fs mock
  vi.restoreAllMocks()
  setSafeStorage(null)
  _setPrfForTests(false)
  _setAdaptForTests(false)
  _resetForTests()
  try { fs.rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ---------------------------------------------------------------------------
// The packed codec is the ONLY thing standing between a corrupt/short base64 blob and a
// perfectly plausible-looking wrong vector: reinterpreting N bytes as f32 always "succeeds",
// so a length check is the only way the store can tell a truncated write from a real one.
describe('packed embedding codec', () => {
  it('encodes a number[] and a Float32Array to identical bytes, and both round-trip', () => {
    const src = Array.from({ length: DIM }, (_, i) => (i % 7) / 7 - 0.5)

    const fromArray = encodeEmbedding(src)                       // needs the Float32Array.from() copy
    const fromTyped = encodeEmbedding(Float32Array.from(src))    // already typed — used as-is

    expect(fromTyped).toBe(fromArray)                            // the on-disk form is the same either way
    const back = decodeEmbedding({ emb: fromArray })
    expect(back).not.toBeNull()
    expect(back!.length).toBe(DIM)
    // f32 round-trip, so compare at f32 precision rather than expecting the f64 source back.
    expect(Array.from(back as Float32Array)).toEqual(Array.from(Float32Array.from(src)))
  })

  it('refuses a packed blob of the wrong byte length instead of guessing a vector from it', () => {
    const full = encodeEmbedding(unit(3))
    // A truncated blob still decodes to a valid Float32Array (383 floats) — which is exactly
    // why the length check has to exist: silently accepting it would score against garbage.
    const truncated = Buffer.from(full, 'base64').subarray(0, DIM * 4 - 4).toString('base64')

    expect(decodeEmbedding({ emb: truncated })).toBeNull()
    expect(decodeEmbedding({ emb: encodeEmbedding([1, 2, 3]) })).toBeNull() // far too short
    expect(decodeEmbedding({ emb: full })).not.toBeNull()                   // control
  })

  it('falls through to the legacy `embedding` array when `emb` is absent, empty or not a string', () => {
    const legacy = unit(9)
    // '' and a non-string are both "no packed vector" — a record mid-migration must still be
    // readable through its legacy field rather than being dropped as vector-less.
    expect(decodeEmbedding({ emb: '', embedding: legacy })).toBe(legacy)
    expect(decodeEmbedding({ emb: 42, embedding: legacy })).toBe(legacy)
    expect(decodeEmbedding({ embedding: legacy })).toBe(legacy)
  })

  it('returns null for a legacy array of the wrong dimension and for a record with no vector at all', () => {
    expect(decodeEmbedding({ embedding: [0.1, 0.2, 0.3] })).toBeNull() // e.g. a test-injected 3-dim vector
    expect(decodeEmbedding({ embedding: 'not-an-array' })).toBeNull()
    expect(decodeEmbedding({})).toBeNull()
  })
})

// ---------------------------------------------------------------------------
describe('hot-window trim', () => {
  it('evicts a hash-less legacy record without poisoning the ingest guard, but remembers a hashed one', async () => {
    // Records written before content-addressing existed have no `hash`; the loader never
    // back-fills one. Evicting such a record must skip the ingest-guard bookkeeping entirely
    // rather than delete/remember an `undefined` key.
    seedStore([
      { id: 'legacy-1', agentId: 'old', kind: 'note', content: 'legacy one', ts: 1 },
      { id: 'legacy-2', agentId: 'old', kind: 'note', content: 'legacy two', ts: 2 },
      { id: 'legacy-3', agentId: 'old', kind: 'note', content: 'legacy three', ts: 3 },
    ])
    initSwarmMemory(userDir)
    expect(memoryCount()).toBe(3)
    _setMaxEntriesForTests(3)

    const w1 = await memoryWrite({ agentId: 'a', kind: 'note', content: 'alpha entry' }) // evicts legacy-1
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'beta entry' })             // evicts legacy-2
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'gamma entry' })            // evicts legacy-3

    expect(memoryCount()).toBe(3)
    expect(contents()).toEqual(['gamma entry', 'beta entry', 'alpha entry']) // memoryList is newest-first
    expect(memoryHasHash(w1.hash!)).toBe(true) // still live in the window → guard holds

    await memoryWrite({ agentId: 'a', kind: 'note', content: 'delta entry' }) // now evicts w1 — which HAS a hash
    expect(contents()).toEqual(['delta entry', 'gamma entry', 'beta entry'])
    // The hashed eviction is the one that registers: its content is remembered as forgotten so
    // a re-ingest can't resurrect it. The three hash-less evictions contributed nothing.
    expect(memoryHasHash(w1.hash!)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Deleting entries leaves their packed rows behind as orphans. Past ~45% of the store those get
// compacted out IN MEMORY (no disk re-read) and every row↔entry mapping is renumbered — which
// also invalidates the on-disk HNSW graph, since it indexes the OLD row numbers.
describe('packed-store compaction', () => {
  const seedDocs = async (n: number): Promise<Array<{ id: string }>> => {
    _setEmbedFnForTests(async (t: string) => unit(Number(t.slice(-2))))
    const out: Array<{ id: string }> = []
    for (let i = 0; i < n; i++) {
      out.push(await memoryWrite({ agentId: 'a', kind: 'note', content: `doc-${String(i).padStart(2, '0')}` }))
    }
    return out
  }

  it('compacts orphaned rows out of the packed store and keeps recall exact', async () => {
    initSwarmMemory(userDir)
    const docs = await seedDocs(10)
    expect(_vectorStoreSizeForTests()).toBe(10)

    for (let i = 0; i < 5; i++) memoryDelete(docs[i].id)
    expect(_vectorStoreSizeForTests()).toBe(10) // rows are orphaned, not reclaimed, until compaction

    // The 11th vector pushes orphans past the 45% threshold → compaction runs inside this write.
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'doc-10' })
    expect(_vectorStoreSizeForTests()).toBe(6)  // 5 live survivors + the new one

    // Renumbering is the risk here: a row remapped to the wrong entry mis-scores silently.
    const hit = await memorySearch({ query: 'doc-07', limit: 3 })
    expect(hit[0].content).toBe('doc-07')
    expect(hit[0].score).toBeCloseTo(1, 5)
    const fresh = await memorySearch({ query: 'doc-10', limit: 3 })
    expect(fresh[0].content).toBe('doc-10')
    expect(fresh[0].score).toBeCloseTo(1, 5)
  })

  it('still compacts when the stale graph file cannot be deleted (read-only volume)', async () => {
    initSwarmMemory(userDir)
    const docs = await seedDocs(10)
    for (let i = 0; i < 5; i++) memoryDelete(docs[i].id)

    io.failRm = (p) => String(p).endsWith('memory-hnsw.json')

    await expect(memoryWrite({ agentId: 'a', kind: 'note', content: 'doc-10' })).resolves.toBeTruthy()
    expect(_vectorStoreSizeForTests()).toBe(6) // the compaction itself is NOT best-effort
    const hit = await memorySearch({ query: 'doc-07', limit: 3 })
    expect(hit[0].content).toBe('doc-07')
  })
})

// ---------------------------------------------------------------------------
describe('persisted HNSW graph', () => {
  const buildGraph = async (): Promise<void> => {
    _setEmbedFnForTests(async (t: string) => unit(Number(t.slice(-2))))
    _setHnswThresholdForTests(3)
    for (let i = 0; i < 5; i++) {
      await memoryWrite({ agentId: 'a', kind: 'note', content: `graph-${String(i).padStart(2, '0')}` })
    }
    await memorySearch({ query: 'graph-01', limit: 3 })
    await _whenHnswSettledForTests()
  }

  it('ignores an over-large graph file WITHOUT reading it, and rebuilds instead', async () => {
    initSwarmMemory(userDir)
    await buildGraph()
    expect(fs.existsSync(hnswFile())).toBe(true)

    // Control: a normally-sized graph IS read back off disk on the next launch.
    relaunch()
    _setEmbedFnForTests(async (t: string) => unit(Number(t.slice(-2))))
    _setHnswThresholdForTests(3)
    io.readPaths.length = 0
    await memorySearch({ query: 'graph-01', limit: 3 })
    await _whenHnswSettledForTests()
    expect(io.readPaths.some((p) => p.endsWith('memory-hnsw.json'))).toBe(true)

    // Now the same file reports a size past V8's max string length. Reading it as utf8 would
    // FATAL uncatchably (no try/catch saves you), so the guard has to fire on the stat alone.
    relaunch()
    _setEmbedFnForTests(async (t: string) => unit(Number(t.slice(-2))))
    _setHnswThresholdForTests(3)
    io.readPaths.length = 0
    io.hugeStat = (p) => String(p).endsWith('memory-hnsw.json')

    const hits = await memorySearch({ query: 'graph-01', limit: 3 })
    await _whenHnswSettledForTests()

    expect(io.readPaths.some((p) => p.endsWith('memory-hnsw.json'))).toBe(false) // never opened
    expect(_isHnswReadyForTests()).toBe(true)                                    // degraded to a rebuild
    expect(hits[0].content).toBe('graph-01')                                     // and recall is exact
  })

  it('keeps the in-memory graph usable when the graph file cannot be written', async () => {
    initSwarmMemory(userDir)
    io.failWrite = (p) => String(p).endsWith('memory-hnsw.json')

    await buildGraph()

    expect(_isHnswReadyForTests()).toBe(true)        // the build succeeded; only the save failed
    expect(fs.existsSync(hnswFile())).toBe(false)    // nothing on disk → the next launch rebuilds
    const hits = await memorySearch({ query: 'graph-03', limit: 3 })
    expect(hits[0].content).toBe('graph-03')
  })
})

// ---------------------------------------------------------------------------
// The BM25 index builds in the BACKGROUND, 200 documents per chunk, yielding between chunks.
// Anything that happens during a yield has to be honoured on resume, and the ONLY observable
// that it was is the index's document count: a phantom document cannot be searched for (search
// filters lexical hits against `entries`), so "search for it, it's absent" passes against a
// completely broken retraction. Assert the size — it must equal memoryCount(), or idf and avgdl
// are being computed from a document count that includes memories that don't exist.
describe('background BM25 build, interrupted mid-flight', () => {
  /** Let the parked build resume past its next yield. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r))
  }
  const legacyDocs = (n: number, from = 0): object[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `doc-${i + from}`, agentId: 'a', kind: 'note', content: `document number ${i + from} body`, ts: 1000 + i + from,
    }))

  it('never indexes a document deleted before its chunk was reached', async () => {
    _setLexicalYieldMsForTests(0) // yield after EVERY chunk, so the build really does span ticks
    seedStore(legacyDocs(250))    // 200 + 50: two chunks
    initSwarmMemory(userDir)      // the loader kicks the build; it parks after chunk 1

    expect(_lexicalSizeForTests()).toBe(200)
    expect(memoryCount()).toBe(250)

    // Delete every document chunk 2 was about to index, while it is parked.
    for (let i = 200; i < 250; i++) memoryDelete(`doc-${i}`)
    await _whenLexicalSettledForTests()

    expect(memoryCount()).toBe(200)
    expect(_lexicalSizeForTests()).toBe(200) // chunk 2 indexed nothing — no phantom documents
  })

  it('a build superseded by a clear does not re-index the erased memories', async () => {
    _setLexicalYieldMsForTests(0)
    seedStore(legacyDocs(5))  // one chunk, so the build parks on its FINAL yield
    initSwarmMemory(userDir)

    expect(_lexicalSizeForTests()).toBe(5)

    memoryClear()             // retires the in-flight build mid-yield
    expect(_lexicalSizeForTests()).toBe(0)
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'written after the clear' })
    await flush()

    // The retired build resumes, sees it has been superseded, and drops its work rather than
    // faithfully re-indexing every memory the user just asked us to erase.
    expect(memoryCount()).toBe(1)
    expect(_lexicalSizeForTests()).toBe(1) // == memoryCount(): no resurrected documents skewing idf
    expect(await memorySearch({ query: 'document number 3 body', limit: 5 })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// BB3 pseudo-relevance feedback runs a SECOND vector pass with the query pulled toward the
// centroid of the first pass's top hits, then unions the two by MAX cosine. The union direction
// matters: a document the expansion moves AWAY from must keep its original score, or turning PRF
// on would silently DEMOTE hits it was only supposed to add to.
describe('pseudo-relevance feedback union', () => {
  // Three near docs in the e0/e1 plane (the expansion target) plus one off in e2 that the
  // expansion tilts away from.
  const NEAR = ['prf near one', 'prf near two', 'prf near three']
  const FAR = 'prf far outlier'
  const cosOf: Record<string, number[]> = {
    [NEAR[0]]: atCos(0.65, 1),
    [NEAR[1]]: atCos(0.6, 1),
    [NEAR[2]]: atCos(0.55, 1),
    [FAR]: atCos(0.35, 2),
  }

  const seed = async (): Promise<void> => {
    // The query text shares no tokens with any content, so BM25 contributes nothing and the
    // scores below are pure cosine.
    _setEmbedFnForTests(async (t: string) => cosOf[t] ?? unit(0))
    for (const c of [...NEAR, FAR]) await memoryWrite({ agentId: 'a', kind: 'fact', content: c })
  }

  it('never lowers a first-pass hit the expanded query moves away from', async () => {
    initSwarmMemory(userDir)
    await seed()

    const off = await memorySearch({ query: 'zzqqxx', limit: 10 })
    const offFar = off.find((r) => r.content === FAR)!
    const offTop = off.find((r) => r.content === NEAR[0])!
    expect(offFar.score).toBeCloseTo(0.35, 4)

    _setPrfForTests(true)
    const on = await memorySearch({ query: 'zzqqxx', limit: 10 })
    const onFar = on.find((r) => r.content === FAR)!
    const onTop = on.find((r) => r.content === NEAR[0])!

    // The expansion pulls toward the three e0/e1 docs, so the top hit gains…
    expect(onTop.score).toBeGreaterThan(offTop.score)
    // …while the e2 outlier's second-pass cosine is LOWER than its first — union-by-max keeps
    // the original. (A union that overwrote would report ~0.343 here.)
    expect(onFar.score).toBeCloseTo(offFar.score, 6)
    expect(on).toHaveLength(4) // and PRF adds candidates, never drops them
  })
})

// ---------------------------------------------------------------------------
// A record whose embedding is not EMBED_DIM never earns a packed row, so the MMR similarity
// function has no vectors to compare and has to fall back to token overlap. That fallback is
// also the only code that ever sees an EMPTY content string (the write API rejects one; the
// loader accepts it), so it must treat a content-less record as trivially dissimilar.
describe('diversified search without packed vectors', () => {
  it('falls back to token overlap for MMR and treats a content-less legacy record as diverse', async () => {
    // A 4-dim embedding is below EMBED_DIM → decodeEmbedding refuses it → no packed row at all.
    const SHORT = [1, 0, 0, 0]
    seedStore([
      { id: 'legacy-empty', agentId: 'old', kind: 'note', content: '', ts: 10, embedding: SHORT },
      { id: 'legacy-a', agentId: 'old', kind: 'note', content: 'react hooks tutorial guide', ts: 11, embedding: SHORT },
      { id: 'legacy-b', agentId: 'old', kind: 'note', content: 'react hooks tutorial manual', ts: 12, embedding: SHORT },
      { id: 'legacy-c', agentId: 'old', kind: 'note', content: 'kubernetes cluster networking', ts: 13, embedding: SHORT },
    ])
    initSwarmMemory(userDir)
    _setEmbedFnForTests(async () => SHORT) // query embeds to the same 4-dim space → all cosine 1
    expect(_vectorStoreSizeForTests()).toBe(0)

    const res = await memorySearch({ query: 'react hooks tutorial', limit: 3, diversify: true })

    expect(res).toHaveLength(3)
    // Every candidate scores identically, so MMR's ONLY signal is the token-overlap fallback:
    // the two near-duplicate react notes must not both take a slot.
    expect(res.filter((r) => r.content.startsWith('react hooks tutorial'))).toHaveLength(1)
    expect(res.map((r) => r.id)).toContain('legacy-c')
    // The content-less record has no tokens → similarity 0 against everything → maximally
    // diverse, so it survives rather than being dropped or crashing the comparison.
    expect(res.map((r) => r.id)).toContain('legacy-empty')
  })
})

// ---------------------------------------------------------------------------
// mnemeAdapt's taste boost nudges ranking toward the centroid of what the fleet reinforced. It
// is best-effort by design: it must skip anything it can't find a packed vector for — a memory
// that was reinforced and then DELETED, and a candidate that only ever reached the result set
// through BM25 — rather than dropping those candidates from recall.
describe('taste boost with vector-less candidates', () => {
  const LEXICAL_ONLY = 'zebra quokka lexical only record'

  it('skips candidates and reinforcements it has no vector for, without losing them from recall', async () => {
    initSwarmMemory(userDir)
    // Only LEXICAL_ONLY gets a sub-EMBED_DIM vector, so it is the one candidate with no packed
    // row; it can still reach the result set through the BM25 half of hybrid retrieval.
    _setEmbedFnForTests(async (t: string) => (t === LEXICAL_ONLY ? [1, 0, 0, 0] : unit(0)))

    const keep = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'kubernetes ingress controller notes' })
    const other = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'kubernetes ingress controller draft' })
    const lexical = await memoryWrite({ agentId: 'a', kind: 'fact', content: LEXICAL_ONLY })
    const doomed = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'kubernetes ingress controller obsolete' })

    memoryFeedback({ id: keep.id, helpful: true })
    memoryFeedback({ id: doomed.id, helpful: true })
    memoryDelete(doomed.id) // its reinforcement outlives it in the usage map

    _setAdaptForTests(true)
    const res = await memorySearch({ query: 'kubernetes zebra quokka', limit: 10 })
    const ids = res.map((r) => r.id)

    expect(ids).not.toContain(doomed.id)   // a deleted memory can't steer the centroid or re-enter recall
    expect(ids).toContain(lexical.id)      // the vector-less candidate is skipped by the boost, NOT dropped
    expect(ids.indexOf(keep.id)).toBeLessThan(ids.indexOf(other.id)) // reinforced ranks first
  })
})
