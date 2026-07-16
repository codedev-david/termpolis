// swarmMemory — the defensive/edge surface the behavioural suites don't reach.
//
// This file deliberately targets the store's ERROR paths, early returns, fallback arms and
// boolean permutations: a broken sync folder, an unwritable store, a corrupt deletes-floor,
// an undecryptable peer line, a shard that cannot be listed, a vector the packed store
// REFUSES, a dedup twin, a mid-build graph mutation. Those are exactly the places a memory
// brain silently loses data, so every test below asserts on OBSERVABLE behaviour (what is
// recalled, what reaches disk, what the API reports) rather than merely executing the line.
//
// The embedder is always MOCKED (module mock + the embedOverride seam), so nothing here
// depends on the bge model being present — which is how CI runs coverage.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'

const tele = vi.hoisted(() => ({ recordSwarmError: vi.fn() }))
vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: tele.recordSwarmError }))

// `fs` is a PASSTHROUGH mock — every call hits the real filesystem unless a test arms one of
// these hooks. (An ESM namespace export cannot be vi.spyOn'd, and a full auto-mock would strand
// the ~60 tests here that need genuine disk behaviour.) This is how we simulate the failures a
// memory store must survive: an unwritable volume, a full disk, an unmounted sync drive.
const failIO = vi.hoisted(() => ({
  writeFileSync: null as null | ((p: unknown) => boolean),
  appendFileSync: false,
  readdirSync: false,
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const call = (fn: unknown, args: unknown[]): unknown => (fn as (...a: unknown[]) => unknown)(...args)
  const api = {
    ...actual,
    writeFileSync: (...args: unknown[]): unknown => {
      if (failIO.writeFileSync?.(args[0])) throw new Error('EACCES: read-only volume')
      return call(actual.writeFileSync, args)
    },
    appendFileSync: (...args: unknown[]): unknown => {
      if (failIO.appendFileSync) throw new Error('ENOSPC: no space left on device')
      return call(actual.appendFileSync, args)
    },
    readdirSync: (...args: unknown[]): unknown => {
      if (failIO.readdirSync) throw new Error('EIO: network drive vanished')
      return call(actual.readdirSync, args)
    },
  }
  return { ...api, default: api }
})

// The embedder module itself is mocked so the "is the model dead?" latch (F8) is drivable
// without the real bge model. `embedOverride` (_setEmbedFnForTests) short-circuits ahead of
// this for every other test, so the mock only matters where we explicitly opt into it.
const model = vi.hoisted(() => ({
  ready: true,
  impl: null as null | ((t: string) => Promise<number[] | null>),
}))
vi.mock('../../src/main/localEmbedder', () => ({
  EMBED_DIM: 384,
  isEmbedderReady: (): boolean => model.ready,
  embedText: async (t: string): Promise<number[] | null> => (model.impl ? model.impl(t) : null),
}))

import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryList,
  memoryCount,
  memoryDelete,
  memoryClear,
  memoryArchive,
  searchArchive,
  memoryForget,
  memoryFeedback,
  memoryRelated,
  memoryGraphQuery,
  memoryLink,
  memoryPatchProjects,
  memoryPruneCodePath,
  memoryHasHash,
  memoryDashboardStats,
  memoryRecentActivity,
  memoryGraphSample,
  memoryBackfillVectors,
  consolidationCandidates,
  consolidationSimOf,
  symbolHistory,
  backfillCodeRefs,
  weaveCandidates,
  weaveNeighbours,
  compactSelfShard,
  exportMemorySnapshot,
  importMemorySnapshot,
  setSyncDir,
  reloadMemoryFromSync,
  getSyncStatus,
  enableLocalEncryption,
  disableEncryption,
  embeddingsReady,
  embeddingsStatus,
  persistMemoryIndex,
  normalizeProjectSlug,
  projectKeyOf,
  contentHash,
  canonicalEntityName,
  entityDedupHash,
  rocchioExpand,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _setMaxEntriesForTests,
  _setAdaptForTests,
  _setHnswThresholdForTests,
  _setHnswYieldMsForTests,
  _whenHnswSettledForTests,
  _isHnswReadyForTests,
  _vectorStoreSizeForTests,
  _archiveReadCountForTests,
} from '../../src/main/swarmMemory'
import { setSafeStorage } from '../../src/main/secureKeyStore'
import { encryptLine } from '../../src/main/memoryCrypto'
import { initAnomalyLog, anomalyCount, _resetAnomalyLogForTests } from '../../src/main/memoryAnomalyLog'
import type { ConsolEntry } from '../../src/main/mnemeConsolidate'

const DIM = 384
/** A 384-dim one-hot unit vector — orthogonal to every other index. */
const unit = (i: number): number[] => { const v = new Array(DIM).fill(0); v[i % DIM] = 1; return v }
/** A 384-dim unit vector at exactly `c` cosine from unit(0). */
const atCos = (c: number): number[] => {
  const v = new Array(DIM).fill(0)
  v[0] = c
  v[1] = Math.sqrt(Math.max(0, 1 - c * c))
  return v
}
/** A 384-dim ZERO vector — correct length, but un-normalizable (VectorStore refuses it). */
const zeroVec = (): number[] => new Array(DIM).fill(0)
/** Deterministic per-text vector: same text ⇒ same direction. */
const byLength = async (t: string): Promise<number[]> => unit(t.length)

const fakeKeychain = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (s: string): Buffer => Buffer.from('SAFE:' + s, 'utf8'),
  decryptString: (b: Buffer): string => b.toString('utf8').slice(5),
}

let userDir: string
let syncDir: string
const storeFile = (): string => path.join(userDir, 'swarm-memory.jsonl')
const storeText = (): string => fs.readFileSync(storeFile(), 'utf8')
const contents = (): string[] => memoryList().map((e) => e.content)
/** Simulate a relaunch against the same data dir. */
const relaunch = (opts: { syncDir?: string | null } = {}): void => {
  _resetForTests()
  _setEmbedFnForTests(async () => null)
  initSwarmMemory(userDir, opts)
}
/** Keyword-only mode: no vectors at all. */
const keywordOnly = (): void => {
  _setEmbedFnForTests(null)
  _setEmbeddingsAvailable(false)
}

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cov-u-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cov-s-'))
  tele.recordSwarmError.mockClear()
  model.ready = true
  model.impl = null
  failIO.writeFileSync = null
  failIO.appendFileSync = false
  failIO.readdirSync = false
  setSafeStorage(null)          // no OS keychain by default → default-on encryption stays off
  _resetForTests()
  _resetAnomalyLogForTests()
  _setEmbedFnForTests(async () => null) // default: writes succeed, no vectors
})

afterEach(() => {
  vi.restoreAllMocks()
  setSafeStorage(null)
  _resetForTests()
  _resetAnomalyLogForTests()
  for (const d of [userDir, syncDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// ---------------------------------------------------------------------------
describe('pure helpers — degenerate inputs', () => {
  it('normalizeProjectSlug returns "" for a non-string and basenames a real path', () => {
    expect(normalizeProjectSlug(undefined as unknown as string)).toBe('')
    expect(normalizeProjectSlug(42 as unknown as string)).toBe('')
    expect(normalizeProjectSlug('C:\\repos\\Termpolis\\')).toBe('termpolis')
  })

  it('canonicalEntityName tolerates empty input and folds articles + a code extension', () => {
    expect(canonicalEntityName(undefined as unknown as string)).toBe('')
    expect(canonicalEntityName('')).toBe('')
    expect(canonicalEntityName('The Parser.ts')).toBe('parser')
    expect(canonicalEntityName('src/main/x.py')).toBe('src/main/x')
    // an internal space means it is a phrase, not a filename — the extension must survive
    expect(canonicalEntityName('a parse tree.ts')).toBe('parse tree.ts')
    // deliberately NOT folded (would collapse genuinely distinct entities)
    expect(canonicalEntityName('parsers')).not.toBe(canonicalEntityName('parser'))
  })

  it('entityDedupHash scopes by projectKey so a same-named entity in two repos stays distinct (WP-D)', () => {
    const global = entityDedupHash('parser')
    expect(global).toBe(contentHash('parser'))        // unscoped ⇒ byte-for-byte a plain content hash
    expect(entityDedupHash('The parser.ts')).toBe(global) // canonical aliases collapse onto one node
    const inA = entityDedupHash('parser', 'aaaaaaaaaaaaaaaa')
    const inB = entityDedupHash('parser', 'bbbbbbbbbbbbbbbb')
    expect(inA).not.toBe(global)
    expect(inA).not.toBe(inB)                          // no false cross-repo connection
  })

  it('rocchioExpand tolerates a short expansion vector and never divides by zero', () => {
    // the topVec is SHORTER than the query — the missing components must read as 0, not NaN
    const out = rocchioExpand([1, 0, 0], [[0, 1]], 1)
    expect(out.every(Number.isFinite)).toBe(true)
    expect(Math.hypot(...out)).toBeCloseTo(1, 6)       // returns a unit vector
    // a zero query with nothing to expand around: norm 0 ⇒ the `|| 1` guard, no NaN
    expect(rocchioExpand([0, 0, 0], [])).toEqual([0, 0, 0])
  })
})

// ---------------------------------------------------------------------------
describe('memoryWrite — validation, dedup metadata, races, eviction', () => {
  it('rejects missing, blank and non-string content', async () => {
    initSwarmMemory(userDir)
    await expect(memoryWrite(undefined as never)).rejects.toThrow('content required')
    await expect(memoryWrite({ agentId: 'a', kind: 'fact', content: '   \n\t ' })).rejects.toThrow('content required')
    await expect(memoryWrite({ agentId: 'a', kind: 'fact', content: 42 as unknown as string })).rejects.toThrow('content required')
    expect(memoryCount()).toBe(0)
  })

  it('a dedup hit backfills the new call’s project/tags/taskId instead of discarding them (F15)', async () => {
    initSwarmMemory(userDir)
    const first = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'shared fact about the parser', tags: ['x'] })
    expect(first.project).toBeUndefined()

    const second = await memoryWrite({
      agentId: 'b', kind: 'fact', content: 'shared fact about the parser',
      project: 'C:/repos/acme', tags: ['y'], taskId: 't-9',
    })
    expect(second.id).toBe(first.id)          // deduped — still ONE entry
    expect(memoryCount()).toBe(1)
    expect(second.project).toBe('acme')       // scope backfilled
    expect(second.projectKey).toBeUndefined() // (a dedup hit backfills the slug; the key rides the original write)
    expect(second.tags).toEqual(['x', 'y'])   // tags MERGED, not replaced
    expect(second.taskId).toBe('t-9')

    // a third identical write that adds nothing new must not "change" anything
    const third = await memoryWrite({ agentId: 'b', kind: 'fact', content: 'shared fact about the parser', tags: ['y'] })
    expect(third.id).toBe(first.id)
    expect(third.tags).toEqual(['x', 'y'])
    expect(third.project).toBe('acme')
    expect(memoryCount()).toBe(1)
  })

  it('two concurrent writes of identical content collapse to ONE entry (F17 post-embed re-check)', async () => {
    initSwarmMemory(userDir)
    _setEmbedFnForTests(async () => { await new Promise((r) => setTimeout(r, 5)); return unit(1) })
    const [a, b] = await Promise.all([
      memoryWrite({ agentId: 'a', kind: 'fact', content: 'racy identical content' }),
      memoryWrite({ agentId: 'b', kind: 'fact', content: 'racy identical content' }),
    ])
    expect(a.id).toBe(b.id)
    expect(memoryCount()).toBe(1)
    expect(storeText().split('\n').filter((l) => l.includes('racy identical content')).length).toBe(1) // one line on disk too
  })

  it('defaults a kind-less write to a note', async () => {
    initSwarmMemory(userDir)
    const e = await memoryWrite({ agentId: 'a', content: 'a write that named no kind' } as never)
    expect(e.kind).toBe('note')
    expect(memoryList()[0].kind).toBe('note')
  })

  it('a write past the hot-window cap evicts the oldest and remembers its hash so re-ingest skips it', async () => {
    initSwarmMemory(userDir)
    _setMaxEntriesForTests(2)
    const oldest = await memoryWrite({ agentId: 'a', kind: 'note', content: 'oldest chunk alpha' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'middle chunk bravo' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'newest chunk charlie' })

    expect(memoryCount()).toBe(2)
    expect(contents()).not.toContain('oldest chunk alpha')          // evicted from the hot window
    expect(memoryHasHash(oldest.hash as string)).toBe(true)         // ...but the forgot-set blocks re-ingest
    expect(storeText()).toContain('oldest chunk alpha')             // and the durable log still has it
  })
})

// ---------------------------------------------------------------------------
describe('packed-vector edge cases', () => {
  it('a zero embedding is REFUSED by the packed store, and the entry stays keyword-recallable', async () => {
    initSwarmMemory(userDir)
    _setEmbedFnForTests(async () => zeroVec())            // right length, but un-normalizable
    const e = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'zero vector content here' })
    expect(e.embedding).toBeDefined()                      // the embedder DID hand back a vector...
    expect(_vectorStoreSizeForTests()).toBe(0)             // ...and the store refused it (no phantom row)

    const hits = await memorySearch({ query: 'zero vector content here' })
    expect(hits.map((h) => h.id)).toContain(e.id)          // still reachable via the lexical safety net
  })

  it('a dedup-hit re-write of a vector-refused entry does not duplicate it or fake a row (F18)', async () => {
    initSwarmMemory(userDir)
    _setEmbedFnForTests(async () => zeroVec())
    const a = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'refused vector content' })
    const b = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'refused vector content' }) // dedup → backfill path
    expect(b.id).toBe(a.id)
    expect(memoryCount()).toBe(1)
    expect(_vectorStoreSizeForTests()).toBe(0)
  })

  it('a legacy non-384-dim vector is left on the entry and never forced into the packed store', async () => {
    initSwarmMemory(userDir)
    _setEmbedFnForTests(async () => [1, 0, 0])             // 3-dim legacy vector
    const a = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'legacy dim content' })
    expect(a.embedding).toEqual([1, 0, 0])
    expect(_vectorStoreSizeForTests()).toBe(0)

    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'legacy dim content' }) // dedup → backfill leaves it alone
    expect(_vectorStoreSizeForTests()).toBe(0)
    expect(await memoryBackfillVectors(10)).toBe(0)        // the bulk pass skips it too (it already has a vector)

    // and the legacy per-object cosine path still recalls it
    const hits = await memorySearch({ query: 'legacy dim content' })
    expect(hits.map((h) => h.id)).toContain(a.id)
  })

  it('memoryBackfillVectors honours max, skips packed entries, and reports 0 on a wrong-dim embedder', async () => {
    initSwarmMemory(userDir)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'outage entry one' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'outage entry two' })
    expect(_vectorStoreSizeForTests()).toBe(0)

    // the embedder is "back" but returns the wrong dimension → nothing is packed, honestly reported
    _setEmbeddingsAvailable(null)
    _setEmbedFnForTests(async () => [1, 2, 3])
    expect(await memoryBackfillVectors(50)).toBe(0)
    expect(_vectorStoreSizeForTests()).toBe(0)

    // a healthy embedder: the `max` budget is respected...
    _setEmbedFnForTests(async () => unit(2))
    expect(await memoryBackfillVectors(1)).toBe(1)
    expect(_vectorStoreSizeForTests()).toBe(1)
    // ...and the second pass skips the entry that is already packed
    expect(await memoryBackfillVectors(50)).toBe(1)
    expect(_vectorStoreSizeForTests()).toBe(2)
    expect(await memoryBackfillVectors(50)).toBe(0)       // nothing left to do
  })
})

// ---------------------------------------------------------------------------
describe('embedder health latch (F8) — a transient failure must not downgrade the session', () => {
  const useRealEmbedPath = (): void => {
    _setEmbedFnForTests(null)      // drop the override → go through embed() → the mocked localEmbedder
    _setEmbeddingsAvailable(null)  // unprobed
  }

  it('does NOT latch embeddings off when the model is loaded but one embed returns null', async () => {
    initSwarmMemory(userDir)
    useRealEmbedPath()
    model.ready = true
    model.impl = async () => null
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'transient null embed' })
    expect(embeddingsStatus()).toBe('unprobed')  // NOT 'unavailable'
    expect(embeddingsReady()).toBe(true)
    expect(tele.recordSwarmError).not.toHaveBeenCalledWith('swarmMemory.embed.unavailable', expect.anything(), expect.anything())
  })

  it('does NOT latch off when embedText THROWS but the model is still loaded', async () => {
    initSwarmMemory(userDir)
    useRealEmbedPath()
    model.ready = true
    model.impl = async () => { throw new Error('transient worker hiccup') }
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'transient throwing embed' })
    expect(embeddingsStatus()).toBe('unprobed')
    expect(embeddingsReady()).toBe(true)
  })

  it('latches embeddings OFF when the embedder reports itself dead (null result)', async () => {
    initSwarmMemory(userDir)
    useRealEmbedPath()
    model.ready = false
    model.impl = async () => null
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'dead model embed' })
    expect(embeddingsStatus()).toBe('unavailable')
    expect(embeddingsReady()).toBe(false)
    expect(tele.recordSwarmError).toHaveBeenCalledWith('swarmMemory.embed.unavailable', expect.anything(), expect.anything())
  })

  it('latches embeddings OFF when embedText throws AND the model is dead', async () => {
    initSwarmMemory(userDir)
    useRealEmbedPath()
    model.ready = false
    model.impl = async () => { throw new Error('model load failed') }
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'dead model throwing embed' })
    expect(embeddingsStatus()).toBe('unavailable')
    expect(tele.recordSwarmError).toHaveBeenCalledWith('swarmMemory.embed.unavailable', expect.anything(), expect.anything())
  })

  it('a wrong-dimension model does not reach the packed store even when it "works"', async () => {
    initSwarmMemory(userDir)
    useRealEmbedPath()
    model.ready = true
    model.impl = async () => new Array(768).fill(0.1)   // F29: a 768-dim model must be rejected outright
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'wrong dimension model' })
    expect(w.embedding).toBeUndefined()
    expect(_vectorStoreSizeForTests()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
describe('init failure — degrade honestly, never silently discard', () => {
  it('a broken sync folder degrades to the local store, reloads it, and keeps persisting writes (F5)', async () => {
    fs.writeFileSync(storeFile(), JSON.stringify({
      id: 'pre-1', ts: Date.now(), agentId: 'a', kind: 'fact', content: 'pre-existing local memory', hash: 'h-pre',
    }) + '\n')
    initAnomalyLog(userDir)
    const brokenSync = path.join(userDir, 'not-a-directory')
    fs.writeFileSync(brokenSync, 'I am a file — mkdir will fail on me')

    initSwarmMemory(userDir, { syncDir: brokenSync })

    expect(getSyncStatus().degraded).toBe(true)
    expect(anomalyCount('degraded-init')).toBe(1)
    expect(tele.recordSwarmError).toHaveBeenCalledWith('swarmMemory.init.failed', expect.anything(), expect.anything())
    expect(contents()).toContain('pre-existing local memory')   // the fallback RELOADED the local store

    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'written while degraded' })
    expect(w.durable).toBeUndefined()                            // durable — not a lie
    expect(storeText()).toContain('written while degraded')      // and it really reached disk
  })

  it('degrades cleanly when there is no local store to fall back to yet', async () => {
    const brokenSync = path.join(userDir, 'blocker')
    fs.writeFileSync(brokenSync, 'x')
    initSwarmMemory(userDir, { syncDir: brokenSync })

    expect(getSyncStatus().degraded).toBe(true)
    expect(fs.existsSync(storeFile())).toBe(true)               // a fresh local store was created
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'fresh degraded write' })
    expect(w.durable).toBeUndefined()
    expect(memoryCount()).toBe(1)
    expect(storeText()).toContain('fresh degraded write')
  })

  it('a totally unwritable store reports writes as NON-durable rather than pretending (F5/F6)', async () => {
    setSafeStorage(fakeKeychain)   // the OS keychain IS available...
    failIO.writeFileSync = (p) => typeof p === 'string' && p.endsWith('swarm-memory.jsonl')

    initSwarmMemory(userDir)   // local-only; the store file cannot even be created
    expect(tele.recordSwarmError).toHaveBeenCalledWith('swarmMemory.init.failed', expect.anything(), expect.anything())
    expect(tele.recordSwarmError).toHaveBeenCalledWith('swarmMemory.init.localFallback.failed', expect.anything(), expect.anything())
    expect(getSyncStatus().degraded).toBe(true)
    // ...but with no store to protect, auto-encryption must NOT mint a key
    expect(getSyncStatus().encrypted).toBe(false)
    expect(fs.existsSync(path.join(userDir, 'memory-sync.key'))).toBe(false)

    failIO.writeFileSync = null
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'nowhere to persist this' })
    expect(w.durable).toBe(false)     // F6: the API does NOT claim a write it never made
    expect(memoryCount()).toBe(1)     // still usable in RAM this session
    expect(() => disableEncryption()).not.toThrow() // a reload with no shard at all must not throw
  })
})

// ---------------------------------------------------------------------------
describe('reload — malformed and legacy shard records', () => {
  it('loads records that lack ts / agentId / hash, sorting the ts-less ones last', () => {
    fs.writeFileSync(storeFile(), [
      JSON.stringify({ id: 'no-ts', agentId: '', kind: 'note', content: 'a record with no ts and no agent' }),
      JSON.stringify({ id: 'has-ts', ts: Date.now(), agentId: 'a', kind: 'fact', content: 'a modern record', hash: 'h1', source: 'claude' }),
    ].join('\n') + '\n')
    initSwarmMemory(userDir)

    expect(memoryList().map((e) => e.id)).toEqual(['has-ts', 'no-ts'])  // a ts-less record cannot masquerade as newest
    const stats = memoryDashboardStats()
    expect(stats.total).toBe(2)
    expect(stats.bySource.claude).toBe(1)
    expect(stats.bySource.unknown).toBe(1)   // neither source NOR agentId → honestly bucketed
    expect(memoryRecentActivity(10).length).toBe(2)
  })

  it('a reload past the hot-window cap evicts the oldest, even when it carries no hash', () => {
    fs.writeFileSync(storeFile(), [
      JSON.stringify({ id: 'old', ts: 1000, agentId: 'a', kind: 'note', content: 'oldest, hashless' }), // NO hash
      JSON.stringify({ id: 'mid', ts: 2000, agentId: 'a', kind: 'note', content: 'middle one', hash: 'h-mid' }),
      JSON.stringify({ id: 'new', ts: 3000, agentId: 'a', kind: 'note', content: 'newest one', hash: 'h-new' }),
    ].join('\n') + '\n')
    _setMaxEntriesForTests(2)
    initSwarmMemory(userDir)

    expect(memoryList().map((e) => e.id)).toEqual(['new', 'mid'])
    expect(memoryHasHash('h-mid')).toBe(true)

    // Tier-2: with on-disk overflow outside the hot window, a LOCAL compaction must REFUSE
    // (it would otherwise drop the evicted entries that are still on disk).
    expect(compactSelfShard({ force: true })).toEqual({ compacted: false, before: 0, after: 0 })
    expect(storeText()).toContain('oldest, hashless')   // the bytes survive
  })

  it('honours a clearedIds control line already sitting in this device’s own shard', () => {
    fs.writeFileSync(storeFile(), [
      JSON.stringify({ id: 'c1', ts: 1000, agentId: 'a', kind: 'fact', content: 'identity-cleared entry', hash: 'hc1' }),
      JSON.stringify({ id: 'c2', ts: 1001, agentId: 'a', kind: 'fact', content: 'surviving entry', hash: 'hc2' }),
      JSON.stringify({ clearedIds: ['c1', 42, null] }),   // non-string ids are filtered out, not fatal
    ].join('\n') + '\n')
    initSwarmMemory(userDir)
    expect(memoryList().map((e) => e.id)).toEqual(['c2'])
  })

  it('replays reinforce deltas on reload but skips deleted, cleared and unknown ids (BB13)', async () => {
    initSwarmMemory(userDir)
    const keep = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'reinforced survivor' })
    const doomed = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'doomed memory' })
    expect(memoryFeedback({ id: keep.id, helpful: true }).used).toBe(1)
    expect(memoryFeedback({ id: doomed.id, helpful: true }).used).toBe(1)
    memoryDelete(doomed.id)

    // hand-written deltas: an unknown id, and malformed rows that must not crash the replay
    fs.appendFileSync(storeFile(), JSON.stringify({
      reinforce: [{ id: 'ghost-id', used: 5, ts: Date.now() }, { id: 'no-ts-delta', used: 2 }, { id: 42, used: 1 }, { used: 1 }, null],
    }) + '\n')

    relaunch()

    expect(memoryCount()).toBe(1)
    expect(memoryFeedback({ id: keep.id, helpful: true }).used).toBe(2)     // its +1 WAS replayed
    expect(memoryFeedback({ id: 'ghost-id', helpful: true }).used).toBe(1)  // the ghost's +5 was NOT
    expect(memoryFeedback({ id: doomed.id, helpful: true }).used).toBe(1)   // the deleted one's +1 was NOT
  })

  it('applies a codeRefs backfill line but never clobbers anchors an entry already has', () => {
    fs.writeFileSync(storeFile(), [
      JSON.stringify({ id: 'e1', ts: 1000, agentId: 'a', kind: 'fact', content: 'already anchored', hash: 'h1', codeRefs: [{ symbol: 'first', file: 'a.ts' }] }),
      JSON.stringify({ id: 'e2', ts: 1001, agentId: 'a', kind: 'fact', content: 'not yet anchored', hash: 'h2' }),
      JSON.stringify({ codeRefsPatch: { id: 'e1', codeRefs: [{ symbol: 'clobber', file: 'b.ts' }] } }), // must NOT overwrite
      JSON.stringify({ codeRefsPatch: { id: 'e2', codeRefs: [{ symbol: 'applied', file: 'c.ts' }] } }), // applied
      JSON.stringify({ codeRefsPatch: { id: 'e2' } }),          // no codeRefs array → skipped
      JSON.stringify({ codeRefsPatch: { codeRefs: [] } }),      // no id → skipped
      JSON.stringify({ codeRefsPatch: 'not-an-object' }),       // not an object → skipped
    ].join('\n') + '\n')
    initSwarmMemory(userDir)

    const byId = Object.fromEntries(memoryList().map((e) => [e.id, e]))
    expect(byId['e1'].codeRefs?.[0].symbol).toBe('first')    // existing anchors win
    expect(byId['e2'].codeRefs?.[0].symbol).toBe('applied')  // the gap was backfilled
  })

  it('refuses an absurd future clear epoch from a corrupt deletes-floor instead of wiping the brain (F1)', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'must survive a poisoned floor' })

    // a mis-clocked / corrupt floor: a clear epoch years in the future, and junk in every field
    fs.writeFileSync(path.join(userDir, 'memory-deletes.json'), JSON.stringify({
      clearEpoch: Date.now() + 365 * 86_400_000,   // way past MAX_CLOCK_SKEW_MS
      tombstones: 'not-an-array',
      tombstonedHashes: { nope: true },
    }))
    relaunch()
    expect(contents()).toContain('must survive a poisoned floor')  // the epoch was clamped to 0

    // a NEGATIVE epoch and non-string members are equally refused
    fs.writeFileSync(path.join(userDir, 'memory-deletes.json'), JSON.stringify({
      clearEpoch: -1, tombstones: [42, null], tombstonedHashes: [7],
    }))
    relaunch()
    expect(contents()).toContain('must survive a poisoned floor')
  })
})

// ---------------------------------------------------------------------------
describe('device identity + sync config', () => {
  it('mints a fresh device id when the stored one has no usable id', () => {
    fs.writeFileSync(path.join(userDir, 'device-id'), JSON.stringify({ fp: 'stale-fingerprint-only' }))
    initSwarmMemory(userDir, { syncDir })

    const id = getSyncStatus().deviceId
    expect(id).toMatch(/^[0-9a-f]{16}$/)                                                   // freshly minted
    expect(JSON.parse(fs.readFileSync(path.join(userDir, 'device-id'), 'utf8')).id).toBe(id) // and persisted
    expect(fs.existsSync(path.join(syncDir, `${id}.jsonl`))).toBe(true)                    // it names this device's shard
  })

  it('ignores a malformed memory-sync.json and stays local-only', async () => {
    fs.writeFileSync(path.join(userDir, 'memory-sync.json'), JSON.stringify({ dir: 42 })) // not a string
    initSwarmMemory(userDir)   // no explicit opt → falls back to the persisted (bad) config

    expect(getSyncStatus().syncing).toBe(false)
    expect(getSyncStatus().dir).toBeNull()
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'local after a bad sync config' })
    expect(storeText()).toContain('local after a bad sync config')
  })

  it('falls back to this device’s own shard when the sync folder cannot be listed', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'survives an unlistable sync folder' })

    failIO.readdirSync = true   // e.g. the synced network drive unmounts under us
    reloadMemoryFromSync()

    expect(contents()).toContain('survives an unlistable sync folder') // own shard still read
    expect(getSyncStatus().devices).toBe(0)                            // and the device count degrades honestly
  })

  it('turning sync OFF with an empty brain writes an empty local store rather than crashing', () => {
    initSwarmMemory(userDir, { syncDir })
    expect(getSyncStatus().syncing).toBe(true)

    const st = setSyncDir(null)
    expect(st.syncing).toBe(false)
    expect(storeText()).toBe('')
    expect(memoryCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
describe('at-rest encryption — honest failure, never lossy', () => {
  it('ignores a corrupt (wrong-length) cached device key and stays honestly plaintext', async () => {
    fs.writeFileSync(path.join(userDir, 'memory-sync.key'), Buffer.from('too-short').toString('base64'))
    initSwarmMemory(userDir)   // no keychain in beforeEach → auto-encrypt is off

    expect(getSyncStatus().encrypted).toBe(false)  // the bad key was rejected, not adopted
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'PLAINAFTERBADKEY' })
    expect(storeText()).toContain('PLAINAFTERBADKEY')
  })

  it('enableLocalEncryption / disableEncryption throw when memory is not initialised', () => {
    _resetForTests()
    expect(() => enableLocalEncryption()).toThrow('not initialised')
    expect(() => disableEncryption()).toThrow('not initialised')
  })

  it('reports plaintext honestly when the keychain blows up mid-enable', async () => {
    setSafeStorage({
      isEncryptionAvailable: () => true,
      encryptString: () => { throw new Error('keychain exploded') },
      decryptString: (b: Buffer) => b.toString('utf8'),
    })
    initSwarmMemory(userDir)

    expect(getSyncStatus().encrypted).toBe(false)   // never claims protection it does not have
    expect(tele.recordSwarmError).toHaveBeenCalledWith('swarmMemory.autoEncrypt.failed', expect.anything(), expect.anything())
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'HONESTPLAINTEXT' })
    expect(storeText()).toContain('HONESTPLAINTEXT')
    expect(fs.existsSync(path.join(userDir, 'memory-sync.key'))).toBe(false) // and no key was left behind
  })

  it('enabling encryption keeps an undecryptable foreign line VERBATIM instead of dropping it', async () => {
    const foreignKey = crypto.randomBytes(32)
    const foreignLine = encryptLine(foreignKey, JSON.stringify({
      id: 'peer-1', ts: 1000, agentId: 'p', kind: 'fact', content: 'a peer memory we cannot read', hash: 'hp',
    }))
    fs.writeFileSync(storeFile(), foreignLine + '\n')

    setSafeStorage(fakeKeychain)
    initSwarmMemory(userDir)   // default-on encryption rewrites our shard around the foreign line

    expect(getSyncStatus().encrypted).toBe(true)
    expect(storeText()).toContain(foreignLine)   // never dropped — the bytes are recoverable
    expect(getSyncStatus().locked).toBe(true)    // and honestly reported as unreadable
  })

  it('compactSelfShard REFUSES to rewrite a shard holding a line it cannot decrypt', () => {
    const foreignKey = crypto.randomBytes(32)
    const foreignLine = encryptLine(foreignKey, JSON.stringify({ id: 'x', ts: 1, agentId: 'a', kind: 'fact', content: 'peer secret' }))
    fs.writeFileSync(storeFile(), foreignLine + '\n')
    initSwarmMemory(userDir)

    expect(getSyncStatus().locked).toBe(true)
    expect(compactSelfShard({ force: true }).compacted).toBe(false) // never rewrite over data we cannot account for
    expect(storeText()).toContain(foreignLine)
  })

  it('compactSelfShard REFUSES to rewrite a shard holding a corrupt line', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a good line' })
    fs.appendFileSync(storeFile(), 'this is not json at all\n')

    expect(compactSelfShard({ force: true }).compacted).toBe(false)
    expect(storeText()).toContain('this is not json at all') // the raw bytes survive for recovery
    expect(storeText()).toContain('a good line')
  })

  it('compactSelfShard re-encrypts the rewritten shard when the store is encrypted', async () => {
    setSafeStorage(fakeKeychain)
    initSwarmMemory(userDir)
    expect(getSyncStatus().encrypted).toBe(true)

    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'ENCCOMPACTMARKER stays secret' })
    const dead = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a dead line to compact away' })
    memoryDelete(dead.id)

    expect(compactSelfShard({ force: true }).compacted).toBe(true)
    expect(storeText()).not.toContain('ENCCOMPACTMARKER')            // still ciphertext after the rewrite
    expect(contents()).toContain('ENCCOMPACTMARKER stays secret')    // and still readable in RAM
  })
})

// ---------------------------------------------------------------------------
describe('compactSelfShard — gates and CRDT preservation', () => {
  it('is a no-op with no store at all', () => {
    _resetForTests()
    expect(compactSelfShard({ force: true })).toEqual({ compacted: false, before: 0, after: 0 })
  })

  it('declines a small, mostly-live shard unless forced', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'alpha live' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'bravo live' })

    const res = compactSelfShard()   // no force → below COMPACT_MIN_LINES
    expect(res.compacted).toBe(false)
    expect(res.before).toBe(2)
    expect(res.after).toBe(2)        // reported as unchanged, not as "compacted to 2"
    expect(storeText().split('\n').filter((l) => l.trim()).length).toBe(2)
  })

  it('drops blank and non-record lines, and can compact a shard down to genuinely empty', () => {
    fs.writeFileSync(storeFile(), [
      '',                                   // blank
      JSON.stringify({ hello: 'world' }),   // valid JSON, but not a memory record
      '   ',                                // whitespace only
    ].join('\n') + '\n')
    initSwarmMemory(userDir)
    expect(memoryCount()).toBe(0)

    const res = compactSelfShard({ force: true })
    expect(res.compacted).toBe(true)
    expect(res.after).toBe(0)
    expect(storeText()).toBe('')   // the shard's real CRDT contribution was nothing at all
  })

  it('carries project patches, tombstones and deleted-hashes through a forced compaction', async () => {
    initSwarmMemory(userDir)
    const legacy = await memoryWrite({ agentId: 'a', kind: 'note', content: 'legacy chunk needing a project tag' })
    expect(memoryPatchProjects([{ hash: legacy.hash as string, project: 'C:/repos/acme' }])).toBe(1)
    const doomed = await memoryWrite({ agentId: 'a', kind: 'note', content: 'doomed chunk' })
    memoryDelete(doomed.id)

    expect(compactSelfShard({ force: true }).compacted).toBe(true)

    relaunch()   // converge from the compacted shard alone
    expect(contents()).toEqual(['legacy chunk needing a project tag'])
    expect(memoryList()[0].project).toBe('acme')                  // the {patch} line survived
    expect(memoryHasHash(doomed.hash as string)).toBe(true)       // the {deletedHash} tombstone survived
  })
})

// ---------------------------------------------------------------------------
describe('memoryPatchProjects — guards', () => {
  it('ignores empty/malformed patches and never overwrites an existing project scope', async () => {
    initSwarmMemory(userDir)
    expect(memoryPatchProjects([])).toBe(0)
    expect(memoryPatchProjects(null as never)).toBe(0)

    const scoped = await memoryWrite({ agentId: 'a', kind: 'note', content: 'already scoped chunk', project: 'C:/repos/original' })
    const bare = await memoryWrite({ agentId: 'a', kind: 'note', content: 'unscoped chunk' })

    const n = memoryPatchProjects([
      { hash: scoped.hash as string, project: 'C:/repos/hijack' }, // already scoped → refused
      { hash: bare.hash as string, project: '' },                  // empty project → no slug → skipped
      { hash: 'unknown-hash', project: 'C:/repos/x' },             // no such entry
      { project: 'C:/repos/y' } as never,                          // no hash
      { hash: bare.hash as string, project: 'C:/repos/acme' },     // the one real patch
    ])

    expect(n).toBe(1)
    expect(memoryList().find((e) => e.id === scoped.id)?.project).toBe('original') // untouched
    const patched = memoryList().find((e) => e.id === bare.id)
    expect(patched?.project).toBe('acme')
    expect(patched?.projectKey).toBe(projectKeyOf('C:/repos/acme'))
  })

  it('a bare-name patch sets the display slug but no full-path key', async () => {
    initSwarmMemory(userDir)
    const bare = await memoryWrite({ agentId: 'a', kind: 'note', content: 'another unscoped chunk' })
    expect(memoryPatchProjects([{ hash: bare.hash as string, project: 'barename' }])).toBe(1)

    const e = memoryList().find((x) => x.id === bare.id)
    expect(e?.project).toBe('barename')
    expect(e?.projectKey).toBeUndefined()   // a bare name has no path to disambiguate on
  })
})

// ---------------------------------------------------------------------------
describe('search — scoping, keyword and MMR fallbacks', () => {
  it('returns [] for a project scope that normalizes to nothing', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'scoped memory content' })
    expect(await memorySearch({ query: 'scoped memory', project: '///' })).toEqual([])
    expect(await memorySearch({ query: 'scoped memory', project: '   /  ' })).toEqual([])
    // sanity: the same query without the degenerate scope DOES hit
    expect((await memorySearch({ query: 'scoped memory' })).length).toBeGreaterThan(0)
  })

  it('a query with no scorable tokens yields no hit (rather than everything)', async () => {
    initSwarmMemory(userDir)
    keywordOnly()
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'alpha bravo charlie delta' })
    expect(await memorySearch({ query: 'a b c' })).toEqual([])   // every token <= 2 chars
  })

  it('MMR diversification falls back to token-Jaccard when there are no packed vectors', async () => {
    initSwarmMemory(userDir)
    keywordOnly()
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'deployment rollback procedure for the api gateway' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'deployment rollback procedure for the api gateway, revised copy' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'deployment budget approval workflow' })
    expect(_vectorStoreSizeForTests()).toBe(0)   // nothing packed → the vector simFn cannot be used

    const res = await memorySearch({ query: 'deployment', limit: 2, diversify: true })
    expect(res.length).toBe(2)
    // the near-duplicate pair must not take BOTH slots — MMR swaps in the distinct memory
    expect(res.some((r) => r.content.includes('budget approval'))).toBe(true)
  })

  it('token-Jaccard treats an all-short-token memory as dissimilar rather than crashing', async () => {
    initSwarmMemory(userDir)
    keywordOnly()
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'xy ab' })      // no token longer than 2 chars
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'xy ab cd' })

    const res = await memorySearch({ query: 'xy ab', limit: 2, diversify: true })
    expect(res.length).toBe(2)   // both survive; neither is treated as a duplicate of the other
  })

  it('the taste boost lifts memories near the centroid of what the fleet reinforced (frontier, default-off)', async () => {
    initSwarmMemory(userDir)
    // The query shares NO tokens with any content, so BM25 stays silent and relevance is
    // purely the cosine we control here.
    const Q = 'zzqqxx taste probe'
    const vA = [...atCos(0.5)]                                        // direction A
    const vB = new Array(DIM).fill(0); vB[0] = 0.5; vB[2] = Math.sqrt(0.75) // direction B — same cosine to Q, different direction
    const vecs: Record<string, number[]> = {
      [Q]: unit(0),
      'alpha memory concerning cache invalidation': vA,
      'bravo memory concerning cache invalidation': vB,
      'exemplar memory concerning cache invalidation': vA,           // the reinforced exemplar sits ON A
    }
    _setEmbedFnForTests(async (t: string) => vecs[t] ?? unit(300))

    const now = Date.now()
    const a = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'alpha memory concerning cache invalidation', ts: now - 60_000 })
    const b = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'bravo memory concerning cache invalidation', ts: now })
    const ex = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'exemplar memory concerning cache invalidation', ts: now - 60_000 })
    memoryFeedback({ id: ex.id, helpful: true })   // the ONLY reinforced memory → it defines the interest centroid

    const rankOf = (res: Array<{ id: string }>, id: string): number => res.findIndex((r) => r.id === id)

    const off = await memorySearch({ query: Q, limit: 5 })
    expect(rankOf(off, b.id)).toBeGreaterThanOrEqual(0)
    expect(rankOf(off, b.id)).toBeLessThan(rankOf(off, a.id))   // equal relevance → the NEWER one wins

    _setAdaptForTests(true)
    try {
      const on = await memorySearch({ query: Q, limit: 5 })
      expect(rankOf(on, a.id)).toBeLessThan(rankOf(on, b.id))   // A, in the reinforced neighbourhood, now overtakes B
    } finally {
      _setAdaptForTests(false)
    }
  })

  it('the taste boost cleanly no-ops when nothing reinforced has a vector to build a centroid from', async () => {
    initSwarmMemory(userDir)
    keywordOnly()   // NO packed vectors anywhere
    const a = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'alpha caching memory' })
    const b = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'bravo caching memory' })
    memoryFeedback({ id: a.id, helpful: true })        // reinforced, but it has no vector
    memoryFeedback({ id: 'ghost-id', helpful: true })  // reinforced id that is not even an entry

    _setAdaptForTests(true)
    try {
      const res = await memorySearch({ query: 'caching memory', limit: 5 })
      expect(res.map((r) => r.id).sort()).toEqual([a.id, b.id].sort())  // both still recalled — no centroid, no crash
    } finally {
      _setAdaptForTests(false)
    }
  })

  it('a strongly-downvoted memory cannot sneak back into recall through graph fusion (WP-C)', async () => {
    initSwarmMemory(userDir)
    keywordOnly()
    const good = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'the caching decision we kept' })
    const bad = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'a wrong answer nobody wants' })
    memoryLink({ from: good.id, to: bad.id, relation: 'relates-to', weight: 0.9 })

    // the neighbour does not match the query at all — it only ever arrives via graph fusion
    const before = await memorySearch({ query: 'caching decision', limit: 5, fuseGraph: true })
    expect(before.map((r) => r.id)).toContain(bad.id)

    for (let i = 0; i < 4; i++) memoryFeedback({ id: bad.id, helpful: false })  // net -4, past SUPPRESS_THRESHOLD

    const after = await memorySearch({ query: 'caching decision', limit: 5, fuseGraph: true })
    expect(after.map((r) => r.id)).toContain(good.id)
    expect(after.map((r) => r.id)).not.toContain(bad.id)   // suppressed — and fusion does NOT smuggle it back
  })
})

// ---------------------------------------------------------------------------
describe('graph-facing recall — dangling edges never leak', () => {
  const twoLinked = async (): Promise<{ a: string; b: string }> => {
    initSwarmMemory(userDir)
    keywordOnly()
    const a = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'root decision about caching' })
    const b = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'linked decision about caching' })
    memoryLink({ from: a.id, to: b.id, relation: 'solves', weight: 0.9 })
    return { a: a.id, b: b.id }
  }

  it('memoryRelated returns [] for a blank query, no selector, and an unknown id', async () => {
    initSwarmMemory(userDir)
    expect(await memoryRelated({ query: '   ' })).toEqual([])
    expect(await memoryRelated({})).toEqual([])
    expect(await memoryRelated({ id: 'no-such-id' })).toEqual([])
  })

  it('memoryRelated follows a real edge but skips one pointing outside the hot window', async () => {
    const { a, b } = await twoLinked()
    memoryLink({ from: a, to: 'evicted-id', relation: 'solves', weight: 0.9 })

    const rel = await memoryRelated({ id: a, limit: 5 })
    expect(rel.map((r) => r.id)).toContain(b)
    expect(rel.map((r) => r.id)).not.toContain('evicted-id')  // unresolvable → dropped, not surfaced as a ghost
    expect(rel.find((r) => r.id === b)?.relation).toBe('solves')
  })

  it('memoryGraphQuery returns [] when there is no seed to start from', async () => {
    initSwarmMemory(userDir)
    keywordOnly()
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'alpha bravo charlie' })
    expect(await memoryGraphQuery({ query: 'zzz nonexistent tokens' })).toEqual([])
    expect(await memoryGraphQuery({})).toEqual([])
  })

  it('memoryGraphQuery drops a traversed node that is no longer in the hot window', async () => {
    const { a, b } = await twoLinked()
    memoryLink({ from: b, to: 'phantom', relation: 'solves', weight: 0.9 })

    const hits = await memoryGraphQuery({ id: a, depth: 3, limit: 10 })
    expect(hits.map((h) => h.id)).toContain(b)
    expect(hits.map((h) => h.id)).not.toContain('phantom')
  })

  it('memoryGraphSample skips edges whose endpoints are gone and honours the default limit', async () => {
    const { a, b } = await twoLinked()
    memoryLink({ from: a, to: 'ghost-node', relation: 'relates-to', weight: 0.5 })

    const sample = memoryGraphSample({ limit: 10 })
    expect(sample.nodes.map((n) => n.id)).toContain(a)
    expect(sample.nodes.map((n) => n.id)).toContain(b)
    expect(sample.nodes.map((n) => n.id)).not.toContain('ghost-node')  // unresolvable → not drawn
    expect(memoryGraphSample().nodes.length).toBeGreaterThan(0)        // default limit path
  })
})

// ---------------------------------------------------------------------------
describe('the memory<->code bridge + weave seams', () => {
  const REFS = [{ symbolId: 'sym-1', symbol: 'parse', file: 'src/main/parser.ts', projectKey: 'k1' }]

  it('symbolHistory returns EVERY memory anchored to a symbol, newest first, repo-scoped', async () => {
    initSwarmMemory(userDir)
    keywordOnly()
    const older = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'older note about parse', ts: 1_000_000, codeRefs: REFS })
    const newer = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'newer note about parse', ts: 2_000_000, codeRefs: REFS })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a note with no code anchor at all' })

    expect(symbolHistory('parse').map((e) => e.id)).toEqual([newer.id, older.id])       // by symbol name, newest first
    expect(symbolHistory('sym-1').map((e) => e.id)).toEqual([newer.id, older.id])       // by symbol id
    expect(symbolHistory('src/main/parser.ts').map((e) => e.id)).toEqual([newer.id, older.id]) // by full path
    expect(symbolHistory('parser.ts').map((e) => e.id)).toEqual([newer.id, older.id])   // by bare filename
    expect(symbolHistory('parse', 'k1').length).toBe(2)
    expect(symbolHistory('parse', 'other-repo-key')).toEqual([])                        // scoped out
    expect(symbolHistory('   ')).toEqual([])
    expect(symbolHistory(undefined as never)).toEqual([])
    expect(symbolHistory('src/main/')).toEqual([])   // a trailing separator leaves no basename to match on
  })

  it('backfillCodeRefs ignores degenerate input and never overwrites existing anchors', async () => {
    initSwarmMemory(userDir)
    keywordOnly()
    const anchored = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'has anchors', codeRefs: [{ symbol: 'keep', file: 'k.ts' }] })
    const bare = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'has no anchors' })

    backfillCodeRefs('', [{ symbol: 'x', file: 'x.ts' }])                  // no id
    backfillCodeRefs(bare.id, [])                                          // empty refs
    backfillCodeRefs(bare.id, null as never)                               // not an array
    backfillCodeRefs('ghost', [{ symbol: 'x', file: 'x.ts' }])             // unknown id
    backfillCodeRefs(anchored.id, [{ symbol: 'clobber', file: 'c.ts' }])   // already anchored

    expect(memoryList().find((e) => e.id === anchored.id)?.codeRefs?.[0].symbol).toBe('keep')
    expect(memoryList().find((e) => e.id === bare.id)?.codeRefs).toBeUndefined()

    backfillCodeRefs(bare.id, [{ symbol: 'added', file: 'a.ts' }])         // the real backfill
    expect(memoryList().find((e) => e.id === bare.id)?.codeRefs?.[0].symbol).toBe('added')
    expect(symbolHistory('added').map((e) => e.id)).toEqual([bare.id])     // and it is now reachable from code
  })

  it('weaveCandidates recovers the code-side file anchor from a code chunk’s header', async () => {
    initSwarmMemory(userDir)
    keywordOnly()
    await memoryWrite({ agentId: 'code-index', kind: 'note', source: 'code', content: 'src/main/parser.ts:10-40\nexport function parse() {}' })
    await memoryWrite({ agentId: 'code-index', kind: 'note', source: 'code', content: 'a code chunk with no line header' })  // no `path:a-b` prefix
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'src/main/other.ts:1-2\nlooks like code but is not source:code' })
    await memoryWrite({ agentId: 'a', kind: 'message', content: 'raw transcript chatter' })                                   // excluded
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'ParserEntity', memoryType: 'entity' })

    const cands = weaveCandidates(10)
    expect(cands.some((c) => c.kind === 'message')).toBe(false)                       // raw chatter excluded
    expect(cands.filter((c) => c.filePath).length).toBe(1)                            // ONLY the real code chunk anchors
    expect(cands.find((c) => c.filePath)?.filePath).toBe('src/main/parser.ts')
    expect(cands.find((c) => c.memoryType === 'entity')?.entities).toEqual(['ParserEntity'])
  })

  it('weaveNeighbours returns cross-store neighbours tagged with their repo key', async () => {
    initSwarmMemory(userDir)
    _setEmbedFnForTests(async (t: string) => (t.includes('near') ? atCos(0.95) : t.includes('far') ? atCos(0.1) : unit(0)))
    const self = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'self anchor memory', project: 'C:/repos/acme' })
    const near = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'near neighbour memory', project: 'C:/repos/globex' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'far neighbour memory', project: 'C:/repos/acme' })

    const ns = weaveNeighbours(self.id, 2)
    expect(ns[0].id).toBe(near.id)                                          // nearest first
    expect(ns[0].score).toBeGreaterThan(0.9)
    expect(ns[0].projectKey).toBe(projectKeyOf('C:/repos/globex'))          // the miner can gate on CROSS-repo
    expect(ns.every((n) => n.id !== self.id)).toBe(true)                    // never itself
    expect(weaveNeighbours('no-such-id')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
describe('deletion, forgetting and archiving', () => {
  it('deleting one copy of de-duplicated content also kills its twin (F22)', async () => {
    initSwarmMemory(userDir)
    _setEmbedFnForTests(async () => unit(5))

    // A failed append leaves the dedup guard un-armed, so a SECOND entry with the SAME
    // content hash lands in the hot window — exactly the sync-merge twin F22 exists for.
    failIO.appendFileSync = true
    const a = await memoryWrite({ agentId: 'a', kind: 'note', content: 'twinned content body' })
    const b = await memoryWrite({ agentId: 'b', kind: 'note', content: 'twinned content body' })
    failIO.appendFileSync = false

    expect(a.id).not.toBe(b.id)
    expect(a.hash).toBe(b.hash)
    expect(memoryCount()).toBe(2)          // two ids, ONE content hash

    memoryDelete(a.id)
    expect(memoryCount()).toBe(0)                            // the twin went with it — it cannot resurface
    expect(memoryHasHash(a.hash as string)).toBe(true)       // and the content-hash tombstone blocks re-ingest
  })

  it('memoryClear on an uninitialised store is a safe no-op', () => {
    _resetForTests()
    expect(() => memoryClear()).not.toThrow()
    expect(memoryCount()).toBe(0)
  })

  it('memoryForget honours max=0, caps the batch, and protects curated knowledge', async () => {
    initSwarmMemory(userDir)
    // distinct orthogonal vectors → no auto/densify edges, so nothing is edge-protected
    _setEmbedFnForTests(async (t: string) => unit(t.length))
    const old = Date.now() - 30 * 86_400_000
    const m1 = await memoryWrite({ agentId: 'a', kind: 'message', content: 'cold chatter one', ts: old })
    const m2 = await memoryWrite({ agentId: 'a', kind: 'message', content: 'cold chatter twoo', ts: old })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a curated fact worth keeping', ts: old })

    expect(memoryForget({ max: 0 })).toBe(0)      // explicit no-op
    expect(memoryCount()).toBe(3)

    expect(memoryForget({ max: 1 })).toBe(1)      // batch cap honoured
    expect(memoryCount()).toBe(2)
    expect(memoryForget({ max: 200 })).toBe(1)    // the second cold message
    expect(memoryCount()).toBe(1)

    expect(memoryList()[0].kind).toBe('fact')                 // curated knowledge is never forgotten
    expect(memoryHasHash(m1.hash as string)).toBe(true)       // the forgot-set blocks re-ingest of both
    expect(memoryHasHash(m2.hash as string)).toBe(true)
    expect(memoryForget({ max: 200 })).toBe(0)                // nothing left that is forgettable
  })

  it('a cleared memory’s hash survives a relaunch, so the auto-indexer cannot re-ingest it (Wave2)', async () => {
    initSwarmMemory(userDir)
    keywordOnly()
    const a = await memoryWrite({ agentId: 'a', kind: 'message', content: 'a transcript chunk that got cleared' })
    memoryClear()
    expect(memoryCount()).toBe(0)
    expect(memoryHasHash(a.hash as string)).toBe(true)   // in-session guard

    relaunch()   // the device-local forgot-set is re-read from disk
    expect(memoryCount()).toBe(0)
    expect(memoryHasHash(a.hash as string)).toBe(true)   // STILL blocked — a re-ingest cannot undo the clear
  })

  it('memoryPruneCodePath replaces an edited file’s stale chunks even with no vectors', async () => {
    initSwarmMemory(userDir)
    keywordOnly()   // nothing is packed → the prune must not assume a vector row exists
    await memoryWrite({ agentId: 'code-index', kind: 'note', source: 'code', content: 'src/app.ts:1-10\nold body' })
    await memoryWrite({ agentId: 'code-index', kind: 'note', source: 'code', content: 'src/app.ts:11-20\nmore old body' })
    await memoryWrite({ agentId: 'code-index', kind: 'note', source: 'code', content: 'src/other.ts:1-5\nkeep me' })

    expect(memoryPruneCodePath('src/app.ts')).toBe(2)
    expect(contents()).toEqual(['src/other.ts:1-5\nkeep me'])

    relaunch()
    expect(contents()).toEqual(['src/other.ts:1-5\nkeep me'])  // the tombstones survive the reload
  })

  it('searchArchive is a no-op before the store is initialised', () => {
    _resetForTests()
    expect(searchArchive('anything at all')).toEqual([])
  })

  it('deep archive recall ranks by term hits then recency, tolerating malformed rows, and caches the parse', async () => {
    initSwarmMemory(userDir)
    keywordOnly()
    const older = await memoryWrite({ agentId: 'a', kind: 'note', content: 'archive rollback gateway notes', ts: 1000 })
    const newer = await memoryWrite({ agentId: 'a', kind: 'note', content: 'archive rollback gateway notes, revised', ts: 2000 })
    const weak = await memoryWrite({ agentId: 'a', kind: 'note', content: 'archive rollback only', ts: 3000 })
    memoryArchive(older.id)
    memoryArchive(newer.id)
    memoryArchive(weak.id)
    expect(memoryCount()).toBe(0)   // all out of the hot window...

    // hand-written archive rows: one with NO content, one with NO ts, plus a corrupt line —
    // none of them may break the scan.
    fs.appendFileSync(path.join(userDir, 'swarm-memory.archive.jsonl'), [
      JSON.stringify({ id: 'no-content', agentId: 'x', kind: 'note' }),
      JSON.stringify({ id: 'no-ts', agentId: 'x', kind: 'note', content: 'archive rollback with no timestamp' }),
      'this line is not json',
    ].join('\n') + '\n')

    const hits = searchArchive('rollback gateway', 10)
    // 2 term hits (newer, then older by recency) > 1 term hit (weak, then the ts-less row);
    // the content-less row scores 0 and never appears.
    expect(hits.map((h) => h.id)).toEqual([newer.id, older.id, weak.id, 'no-ts'])

    const reads = _archiveReadCountForTests()
    searchArchive('rollback', 5)
    searchArchive('gateway', 5)
    expect(_archiveReadCountForTests()).toBe(reads)   // parsed once, reused (Tier-2 archive cache)
  })
})

// ---------------------------------------------------------------------------
describe('consolidation seams', () => {
  it('consolidationSimOf scores near-duplicates ~1, orthogonal pairs 0, and unknown ids 0', async () => {
    initSwarmMemory(userDir)
    _setEmbedFnForTests(async (t: string) => (t.includes('twin') ? unit(3) : unit(7)))
    const a = await memoryWrite({ agentId: 'a', kind: 'note', content: 'twin note one' })
    const b = await memoryWrite({ agentId: 'a', kind: 'note', content: 'twin note two' })
    const c = await memoryWrite({ agentId: 'a', kind: 'note', content: 'unrelated note' })

    const byId = Object.fromEntries(consolidationCandidates(10).map((x) => [x.id, x])) as Record<string, ConsolEntry>
    const sim = consolidationSimOf()

    expect(sim(byId[a.id], byId[b.id])).toBeCloseTo(1, 5)   // same direction → a near-duplicate cluster
    expect(sim(byId[a.id], byId[c.id])).toBeCloseTo(0, 5)   // orthogonal
    const ghost: ConsolEntry = { id: 'ghost', content: '', ts: 0 }
    expect(sim(byId[a.id], ghost)).toBe(0)                  // no vector → 0, never NaN
  })

  it('consolidationSimOf cleanly returns 0 for every pair when the embedder is off', async () => {
    initSwarmMemory(userDir)
    keywordOnly()
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'no vector one' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'no vector two' })

    const cands = consolidationCandidates(10)
    const sim = consolidationSimOf()
    expect(sim(cands[0], cands[1])).toBe(0)   // summarization no-ops without the model instead of guessing
  })
})

// ---------------------------------------------------------------------------
describe('brain export / import — additive, never destructive', () => {
  it('round-trips memories AND reinforcement deltas, and refuses to import deletions', async () => {
    initSwarmMemory(userDir)
    keywordOnly()
    expect(exportMemorySnapshot()).toEqual([])   // an empty brain exports nothing (array, not one joined string)

    const a = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'portable lesson one' })
    memoryFeedback({ id: a.id, helpful: true })
    memoryFeedback({ id: a.id, helpful: true })

    const snap = exportMemorySnapshot()
    expect(snap.join('\n')).toContain('portable lesson one')
    expect(snap.join('\n')).toContain('"reinforce"')     // F3: the learning layer survives the round-trip

    // import into a SECOND, empty brain
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cov-o-'))
    try {
      _resetForTests()
      keywordOnly()
      initSwarmMemory(other)

      expect(importMemorySnapshot([])).toEqual({ imported: 0 })
      expect(importMemorySnapshot(snap).imported).toBe(1)    // the reinforce line is not counted as a memory
      expect(memoryList().map((e) => e.content)).toEqual(['portable lesson one'])
      expect(memoryFeedback({ id: a.id, helpful: true }).used).toBe(3)  // 2 imported + 1 now

      // an import must NEVER delete anything in the receiving brain
      const res = importMemorySnapshot([
        JSON.stringify({ deleted: a.id }),
        JSON.stringify({ clearedBefore: Date.now() }),
        JSON.stringify({ deletedHash: a.hash }),
        JSON.stringify({ id: 'imp-2', ts: Date.now(), agentId: 'z', kind: 'fact', content: 'second imported lesson', hash: 'h-imp2' }),
      ])
      expect(res.imported).toBe(1)
      expect(memoryList().map((e) => e.content).sort()).toEqual(['portable lesson one', 'second imported lesson'])
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('importMemorySnapshot is a no-op with no store', () => {
    _resetForTests()
    expect(importMemorySnapshot(['{"id":"x","ts":1,"agentId":"a","kind":"fact","content":"c"}'])).toEqual({ imported: 0 })
  })
})

// ---------------------------------------------------------------------------
describe('HNSW lifecycle', () => {
  it('persistMemoryIndex is a safe no-op when there is no graph to persist', async () => {
    initSwarmMemory(userDir)
    _setEmbedFnForTests(async () => unit(1))
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a single small entry' })

    expect(() => persistMemoryIndex()).not.toThrow()
    expect(fs.existsSync(path.join(userDir, 'memory-hnsw.json'))).toBe(false) // below the threshold → no graph at all
  })

  it('a write and a delete landing mid-build abort it rather than publishing a mismatched graph (F34)', async () => {
    initSwarmMemory(userDir)
    _setEmbedFnForTests(byLength)      // deterministic: same text ⇒ same vector
    _setHnswThresholdForTests(3)
    _setHnswYieldMsForTests(0)         // yield after every insert → the build really does span ticks

    const written = []
    for (let i = 0; i < 6; i++) {
      written.push(await memoryWrite({ agentId: 'a', kind: 'note', content: `graph chunk ${i}` }))
    }
    expect(_vectorStoreSizeForTests()).toBe(6)

    void memorySearch({ query: 'graph chunk' })                                     // kicks the background build
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'a write that lands mid-build' }) // → buildGen bump
    memoryDelete(written[0].id)                                                      // → and a delete mid-build too
    await _whenHnswSettledForTests()

    expect(_isHnswReadyForTests()).toBe(false)                                       // the stale graph was NOT published
    expect(fs.existsSync(path.join(userDir, 'memory-hnsw.json'))).toBe(false)        // nor persisted

    // and recall is still exact — the search simply falls back to the brute-force scan
    const hits = await memorySearch({ query: 'graph chunk 2', limit: 10 })
    expect(hits.map((h) => h.id)).toContain(written[2].id)
    expect(hits.map((h) => h.id)).not.toContain(written[0].id)                       // the deleted one is gone
  })
})
