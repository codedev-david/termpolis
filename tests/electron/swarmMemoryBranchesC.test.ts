// swarmMemory — the defensive arms of the DELETE / ARCHIVE / FORGET / COMPACT / ENCRYPT tail
// (everything from memoryList down), which the behavioural suites walk straight past.
//
// Three situations dominate this file, and each one flips a whole family of guards:
//
//   * LEGACY shard lines. Entries written before `hash` (content-addressing) and `ts` existed still
//     load — the loader never back-fills either field. So every `if (e.hash)` and every `(e.ts || 0)`
//     downstream has a live falsy arm that a freshly-written entry can never reach, and getting one
//     wrong either loses a memory or resurrects a deleted one.
//   * KEYWORD-ONLY mode (no bge model — which is how CI runs coverage). Nothing gets a packed vector
//     row, so `entryRow.get(entry)` is undefined everywhere and every row-cleanup arm inverts.
//   * BEST-EFFORT I/O. The key-cache / opt-out file operations are each wrapped in a bare `catch {}`.
//     A swallowed throw is not the interesting part — the honest consequence on THIS call and on the
//     NEXT launch is, so that is what every test below asserts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const tele = vi.hoisted(() => ({ recordSwarmError: vi.fn() }))
vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: tele.recordSwarmError }))

// `fs` is a PASSTHROUGH mock (same shape as swarmMemoryCoverage.test.ts): every call hits the real
// filesystem unless a test arms a hook. The write/remove hooks take the target path so a test can
// break exactly ONE file — arming them globally would take out the atomic shard rewrite too, which
// is the operation whose survival we're trying to prove.
const failIO = vi.hoisted(() => ({
  writeFileSync: null as null | ((p: unknown) => boolean),
  appendFileSync: false,
  rmSync: null as null | ((p: unknown) => boolean),
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
    rmSync: (...args: unknown[]): unknown => {
      if (failIO.rmSync?.(args[0])) throw new Error('EPERM: the file is locked by another process')
      return call(actual.rmSync, args)
    },
  }
  return { ...api, default: api }
})

// The embedder is always MOCKED so nothing here depends on the bge model being present.
const model = vi.hoisted(() => ({ ready: true, impl: null as null | ((t: string) => Promise<number[] | null>) }))
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
  memoryArchive,
  searchArchive,
  memoryForget,
  memoryPruneCodePath,
  memoryHasHash,
  compactSelfShard,
  importMemorySnapshot,
  getSyncStatus,
  enableLocalEncryption,
  disableEncryption,
  adoptEncryptionKey,
  setSyncPassphrase,
  disableSyncEncryption,
  KEY_CACHE_FILE,
  ENCRYPTION_OPTOUT_FILE,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _setHnswThresholdForTests,
  _setHnswYieldMsForTests,
  _whenHnswSettledForTests,
  _vectorStoreSizeForTests,
  _compactionMayBeWorthwhileForTests,
  _ownShardStateForTests,
} from '../../src/main/swarmMemory'
import { setSafeStorage } from '../../src/main/secureKeyStore'
import { encryptLine } from '../../src/main/memoryCrypto'

const DIM = 384
/** A 384-dim one-hot unit vector — orthogonal to every other index. */
const unit = (i: number): number[] => { const v = new Array<number>(DIM).fill(0); v[i % DIM] = 1; return v }

/** A fake OS keychain that round-trips through a marker prefix (how secureKeyStore stores the blob). */
const fakeSafe = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (s: string): Buffer => Buffer.from('SAFE:' + s, 'utf8'),
  decryptString: (b: Buffer): string => b.toString('utf8').slice(5),
}

/** A keychain that is present but REFUSES to encrypt (locked / policy-blocked). */
const refusingSafe = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (): Buffer => { throw new Error('the OS keychain is locked') },
  decryptString: (): string => '',
}

let userDir: string
let syncDir: string
const shardFile = (): string => path.join(userDir, 'swarm-memory.jsonl')
const shardText = (): string => fs.readFileSync(shardFile(), 'utf8')
const archiveFile = (): string => path.join(userDir, 'swarm-memory.archive.jsonl')
const contents = (): string[] => memoryList().map((e) => e.content)

/** Shard lines exactly as an older build would have left them — `hash`/`ts` deliberately optional. */
type RawLine = Record<string, unknown>
/** Lay down this device's shard BEFORE init, so the loader has to parse it as a peer/legacy file. */
const dropShard = (lines: Array<RawLine | string>): void => {
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
  fs.writeFileSync(shardFile(), text)
}
/** Simulate a relaunch against the same data dir. */
const relaunch = (opts: { syncDir?: string | null } = {}): void => {
  _resetForTests()
  _setEmbedFnForTests(async () => null)
  initSwarmMemory(userDir, opts)
}
/** Keyword-only mode: no vectors at all, so nothing ever gets a packed row. */
const keywordOnly = (): void => {
  _setEmbedFnForTests(null)
  _setEmbeddingsAvailable(false)
}

const DAY = 86_400_000

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-brC-u-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-brC-s-'))
  tele.recordSwarmError.mockClear()
  model.ready = true
  model.impl = null
  failIO.writeFileSync = null
  failIO.appendFileSync = false
  failIO.rmSync = null
  setSafeStorage(null)          // no OS keychain by default → default-on encryption stays off
  _resetForTests()
  _setEmbedFnForTests(async () => null) // default: writes succeed, no vectors
})

afterEach(() => {
  // Disarm BEFORE the cleanup below — the tmp-dir teardown goes through the same mocked fs.
  failIO.writeFileSync = null
  failIO.appendFileSync = false
  failIO.rmSync = null
  vi.restoreAllMocks()
  setSafeStorage(null)
  _resetForTests()
  for (const d of [userDir, syncDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// ---------------------------------------------------------------------------
describe('legacy shard lines — entries with no ts and no content hash', () => {
  it('memoryList keeps a ts-less legacy entry and still ranks the timestamped one first', () => {
    // A line written before `ts` existed loads with ts === undefined. The list sort has to treat
    // that as "oldest", not NaN — a NaN comparator would scramble the whole page, and dropping the
    // entry would silently lose it.
    dropShard([
      { id: 'legacy-no-ts', agentId: 'a', kind: 'note', content: 'a legacy line written before ts existed' },
      { id: 'modern', ts: Date.now() - 1000, agentId: 'a', kind: 'note', content: 'a modern line with a real timestamp' },
    ])
    initSwarmMemory(userDir)

    expect(memoryCount()).toBe(2) // the ts-less line survives the clear-epoch check
    expect(contents()).toEqual([
      'a modern line with a real timestamp',
      'a legacy line written before ts existed',
    ])
  })

  it('deleting a hash-less legacy entry tombstones the id only — never a phantom content hash', () => {
    dropShard([{ id: 'legacy-1', ts: Date.now() - 1000, agentId: 'a', kind: 'fact', content: 'legacy fact with no content hash' }])
    initSwarmMemory(userDir)
    expect(memoryCount()).toBe(1)

    memoryDelete('legacy-1')

    expect(memoryCount()).toBe(0)
    expect(shardText()).toContain('{"deleted":"legacy-1"}')
    // No hash to tombstone: emitting a `deletedHash` for `undefined` would blacklist every other
    // hash-less entry on the next merge.
    expect(shardText()).not.toContain('deletedHash')
    relaunch()
    expect(memoryCount()).toBe(0) // and the id tombstone survives the reload
  })
})

// ---------------------------------------------------------------------------
describe('delete/prune with no vector rows (keyword-only, the CI configuration)', () => {
  it('deleting one copy of de-duplicated content still kills its twin without a vector store', async () => {
    // Same F22 scenario as the vector-backed suite, but with the embedder off: the twin has NO
    // packed row, so the row-cleanup arm inverts. The twin must still die — a memory brain that
    // only honours deletes when the bge model is loaded is worse than one that never dedups.
    initSwarmMemory(userDir)
    keywordOnly()

    failIO.appendFileSync = true // a failed append leaves the dedup guard un-armed
    const a = await memoryWrite({ agentId: 'a', kind: 'note', content: 'twinned content body' })
    const b = await memoryWrite({ agentId: 'b', kind: 'note', content: 'twinned content body' })
    failIO.appendFileSync = false

    expect(a.id).not.toBe(b.id)
    expect(a.hash).toBe(b.hash)
    expect(memoryCount()).toBe(2)
    expect(_vectorStoreSizeForTests()).toBe(0) // no rows at all — the point of this variant

    memoryDelete(a.id)

    expect(memoryCount()).toBe(0)
    expect(memoryHasHash(a.hash as string)).toBe(true) // the content-hash tombstone still blocks re-ingest
  })

  it('pruning a code path drops hashed AND hash-less chunks, and frees the hash for re-indexing', () => {
    // A re-index of an edited file must REPLACE its chunks. The hash is removed from the dedup set
    // but deliberately NOT tombstoned: an unchanged region re-emitted on the next pass reuses the
    // same hash and has to be storable again.
    const ts = Date.now() - 1000
    dropShard([
      { id: 'code-1', ts, agentId: 'indexer', kind: 'note', source: 'code', content: 'src/foo.ts:1-10\nexport function a() {}', hash: 'chunk-hash-one' },
      { id: 'code-2', ts, agentId: 'indexer', kind: 'note', source: 'code', content: 'src/foo.ts:11-20\nexport function b() {}' },
      { id: 'note-1', ts, agentId: 'human', kind: 'note', content: 'src/foo.ts:99 is where the bug lives', hash: 'note-hash-one' },
    ])
    initSwarmMemory(userDir)
    keywordOnly()
    expect(memoryHasHash('chunk-hash-one')).toBe(true)

    expect(memoryPruneCodePath('src/foo.ts')).toBe(2)

    expect(contents()).toEqual(['src/foo.ts:99 is where the bug lives']) // the human note is not a code chunk
    expect(memoryHasHash('chunk-hash-one')).toBe(false) // freed, not tombstoned
    relaunch()
    expect(contents()).toEqual(['src/foo.ts:99 is where the bug lives']) // both chunks stay pruned across a reload
  })

  it('forgetting cold chunks records only the hashes there are — a hash-less chunk adds nothing', () => {
    // BB15's anti-thrash guard is content-addressed. A legacy chunk with no hash still gets
    // forgotten, but there is nothing to write into the forgot-set; writing `undefined` there would
    // poison memoryHasHash for every other hash-less chunk.
    const now = Date.now()
    dropShard([
      { id: 'cold-hashed', ts: now - 30 * DAY, agentId: 'a', kind: 'message', content: 'cold chatter one', hash: 'cold-hash-one' },
      { id: 'cold-nohash', ts: now - 30 * DAY, agentId: 'a', kind: 'message', content: 'cold chatter two' },
    ])
    initSwarmMemory(userDir)
    keywordOnly()

    expect(memoryForget({ now, max: 10 })).toBe(2)

    expect(memoryCount()).toBe(0)
    expect(memoryHasHash('cold-hash-one')).toBe(true)
    const forgot = JSON.parse(fs.readFileSync(path.join(userDir, 'memory-forgot.json'), 'utf8')) as string[]
    expect(forgot).toEqual(['cold-hash-one'])
  })

  it('a forget landing mid index-build leaves the packed vector rows alone', async () => {
    // compactVectorStore renumbers rows; the HNSW build in flight indexes BY row. Reclaiming the
    // orphans now would shift the store under the running build and silently mis-rank recall, so
    // the batch skips compaction and the rows stay until the build settles.
    initSwarmMemory(userDir)
    _setHnswThresholdForTests(20)
    _setHnswYieldMsForTests(0) // yield after every row → the build is guaranteed to still be running
    let seq = 0
    _setEmbedFnForTests(async () => unit(seq++))

    const now = Date.now()
    for (let i = 0; i < 120; i++) {
      await memoryWrite({ agentId: 'a', kind: 'message', content: `cold transcript chunk ${i}`, ts: now - 30 * DAY })
    }
    expect(_vectorStoreSizeForTests()).toBe(120)

    await memorySearch({ query: 'cold transcript', limit: 3 }) // kicks the background build
    const forgotten = memoryForget({ now, max: 5 })            // …and lands on top of it

    expect(forgotten).toBe(5)
    expect(memoryCount()).toBe(115)
    expect(_vectorStoreSizeForTests()).toBe(120) // rows NOT reclaimed — the build still owns them

    await _whenHnswSettledForTests()
  })
})

// ---------------------------------------------------------------------------
describe('archive — the recoverable cold tier', () => {
  it('archiving frees the content hash and copes with an entry that never had one', () => {
    // Archive PRESERVES content (unlike delete), so it must not tombstone the hash — the same
    // information may legitimately come back. A hash-less legacy entry simply has nothing to free.
    const ts = Date.now() - 1000
    dropShard([
      { id: 'ar-hashed', ts, agentId: 'a', kind: 'note', content: 'the widget subsystem overheats', hash: 'archive-hash-one' },
      { id: 'ar-legacy', ts, agentId: 'a', kind: 'note', content: 'the widget subsystem is quiet' },
    ])
    initSwarmMemory(userDir)
    keywordOnly()

    memoryArchive('ar-hashed')
    memoryArchive('ar-legacy')

    expect(memoryCount()).toBe(0)                        // both left the hot window
    expect(memoryHasHash('archive-hash-one')).toBe(false) // freed for a legitimate return
    expect(searchArchive('widget subsystem').map((e) => e.id).sort()).toEqual(['ar-hashed', 'ar-legacy'])
  })

  it('an archive whose disk copy fails still frees the hash, so the information can simply return', async () => {
    // The archive copy is best-effort and must never propagate its error to the caller. When it does
    // fail, deep recall genuinely cannot find the entry — so the OTHER half of the guarantee is what
    // has to hold: archive never blacklists the CONTENT, only the id, and the same information is
    // therefore storable again rather than permanently rejected by the dedup guard.
    initSwarmMemory(userDir)
    keywordOnly()
    const e = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'cold but precious' })
    const hash = e.hash as string
    expect(memoryHasHash(hash)).toBe(true)

    failIO.appendFileSync = true
    memoryArchive(e.id) // must not throw even though neither the copy nor the tombstone can be written
    failIO.appendFileSync = false

    expect(memoryCount()).toBe(0)
    expect(fs.existsSync(archiveFile())).toBe(false) // the archive copy never landed
    expect(searchArchive('cold precious')).toEqual([])
    expect(memoryHasHash(hash)).toBe(false)          // …but the hash was freed, not tombstoned

    const again = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'cold but precious' })
    expect(again.id).not.toBe(e.id) // a fresh entry, not the dedup guard handing back the old one
    expect(again.hash).toBe(hash)
    expect(contents()).toEqual(['cold but precious'])
  })

  it('deep recall skips blank archive lines and breaks score ties on recency', () => {
    // The archive is an append-only JSONL that other writers (and a torn tail) leave blank lines in.
    // Equal keyword scores fall through to ts, where a legacy ts-less row must sort last, not NaN.
    fs.writeFileSync(archiveFile(), [
      JSON.stringify({ id: 'ar-new', ts: 5000, agentId: 'a', kind: 'note', content: 'the widget subsystem overheats' }),
      '',
      '   ',
      JSON.stringify({ id: 'ar-old', agentId: 'a', kind: 'note', content: 'the widget subsystem is quiet' }),
      '',
    ].join('\n'))
    initSwarmMemory(userDir)

    const hits = searchArchive('widget subsystem')

    expect(hits.map((e) => e.id)).toEqual(['ar-new', 'ar-old']) // blank lines produced no phantom rows
  })
})

// ---------------------------------------------------------------------------
describe('compaction gate — a shard we know nothing about', () => {
  it('a shard of pure control lines is compacted down to its real CRDT contribution', () => {
    // 210 repetitions of one tombstone: nothing this device wrote is an `add`, so the in-memory gate
    // has no live-entry estimate to reason from and must send us to look properly. Once it does, the
    // shard collapses to the single line it actually contributes.
    dropShard(new Array<RawLine>(210).fill({ deleted: 'ghost-1' }))
    initSwarmMemory(userDir)

    expect(_ownShardStateForTests()).toEqual({ lines: 210, addIds: 0 })
    expect(_compactionMayBeWorthwhileForTests()).toBe(true)

    const res = compactSelfShard() // unforced — the dead-weight ratio has to carry it
    expect(res).toEqual({ compacted: true, before: 210, after: 1 })
    expect(shardText().trim()).toBe('{"deleted":"ghost-1"}')

    relaunch()
    expect(_ownShardStateForTests().lines).toBe(1) // and the tombstone still propagates
  })
})

// ---------------------------------------------------------------------------
describe('brain import — additive only', () => {
  it('skips blank lines and refuses to apply a deletion smuggled into the snapshot', async () => {
    initSwarmMemory(userDir)
    const keeper = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'the local brain already knew this' })

    const res = importMemorySnapshot([
      '',
      '   ',
      JSON.stringify({ id: 'imported-1', ts: Date.now() - 1000, agentId: 'peer', kind: 'fact', content: 'a fact from another brain', hash: 'import-hash-one' }),
      'not json at all',
      JSON.stringify({ deleted: keeper.id }), // a grow-only union must never DELETE on import
    ])

    expect(res.imported).toBe(1)
    expect(contents()).toContain('a fact from another brain')
    expect(contents()).toContain('the local brain already knew this')
  })
})

// ---------------------------------------------------------------------------
describe('adoptEncryptionKey — the write half of key injection', () => {
  it('refuses to run before the store is initialised', () => {
    expect(() => adoptEncryptionKey(Buffer.alloc(32, 1))).toThrow(/not initialised/)
  })

  it('rejects a missing or wrong-sized key rather than half-encrypting the shard', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'must stay readable' })

    expect(() => adoptEncryptionKey(null as unknown as Buffer)).toThrow(/key required/)
    expect(() => adoptEncryptionKey(Buffer.alloc(16, 1))).toThrow(/32-byte/)

    expect(getSyncStatus().encrypted).toBe(false)
    expect(shardText()).toContain('must stay readable') // nothing was touched
  })

  it('is idempotent for the key already in force but refuses a DIFFERENT key', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'adopted content' })
    const keyA = Buffer.alloc(32, 1)

    adoptEncryptionKey(keyA)
    expect(getSyncStatus().encrypted).toBe(true)
    expect(shardText()).not.toContain('adopted content') // ciphertext on disk
    expect(contents()).toEqual(['adopted content'])      // plaintext in the hot window

    adoptEncryptionKey(keyA) // legal: re-adopting the live key just re-encrypts any plaintext tail
    expect(contents()).toEqual(['adopted content'])

    // Re-keying would render every existing ciphertext line permanently unreadable.
    expect(() => adoptEncryptionKey(Buffer.alloc(32, 2))).toThrow(/refusing to re-key/)
    expect(contents()).toEqual(['adopted content'])
  })

  it('adopts a key even when the stale opt-out marker cannot be removed', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'encrypt me anyway' })
    const optout = path.join(userDir, ENCRYPTION_OPTOUT_FILE)
    fs.writeFileSync(optout, '1')
    failIO.rmSync = (p) => String(p) === optout

    adoptEncryptionKey(Buffer.alloc(32, 5))

    expect(fs.existsSync(optout)).toBe(true)        // the marker survived the failed removal…
    expect(getSyncStatus().encrypted).toBe(true)    // …and an explicitly injected key still wins
    expect(shardText()).toContain('enc:v1:')
    expect(contents()).toEqual(['encrypt me anyway'])
  })

  it('does not throw when the store failed to open and has no shard to rewrite', () => {
    // Degraded init: the shard could not be created, so memPath is null while userDataDir is set.
    // Adopting a key then has nothing to rewrite — it must degrade quietly, not crash the brain.
    failIO.writeFileSync = (p) => String(p).endsWith('swarm-memory.jsonl')
    initSwarmMemory(userDir)
    failIO.writeFileSync = null

    expect(tele.recordSwarmError.mock.calls.map((c) => c[0])).toContain('swarmMemory.init.localFallback.failed')

    const st = adoptEncryptionKey(Buffer.alloc(32, 7))

    expect(st.degraded).toBe(true)
    expect(st.encrypted).toBe(true)
    expect(st.count).toBe(0)
    expect(fs.existsSync(shardFile())).toBe(false)
  })
})

// ---------------------------------------------------------------------------
describe('local at-rest encryption — best-effort file operations and their consequences', () => {
  it('reports encryption OFF when the opt-out marker cannot be cleared', async () => {
    // enableLocalEncryption clears the opt-out first because maybeAutoEncrypt honours it. If the
    // removal fails the opt-out still wins, and the status has to say so rather than claim success.
    setSafeStorage(fakeSafe)
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'plaintext please' })
    disableEncryption() // lays down the opt-out marker
    const optout = path.join(userDir, ENCRYPTION_OPTOUT_FILE)
    expect(fs.existsSync(optout)).toBe(true)

    failIO.rmSync = (p) => String(p) === optout
    const st = enableLocalEncryption()

    expect(st.encrypted).toBe(false)                    // honest, not aspirational
    expect(shardText()).toContain('plaintext please')   // and the shard really is still plaintext
  })

  it('disabling encryption survives an unremovable key file, but the disable does not survive a relaunch', async () => {
    // The opt-out marker is what makes "off" stick across launches, and the key cache is what makes
    // default-on find a key. If neither can be written/removed, this session is decrypted but the
    // next launch legitimately picks the key back up — the user must not be told otherwise.
    setSafeStorage(fakeSafe)
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'round trip content' })
    expect(getSyncStatus().encrypted).toBe(true) // default-ON auto-encrypted at init
    const keyCache = path.join(userDir, KEY_CACHE_FILE)
    const optout = path.join(userDir, ENCRYPTION_OPTOUT_FILE)

    failIO.rmSync = (p) => String(p) === keyCache
    failIO.writeFileSync = (p) => String(p) === optout
    const st = disableEncryption()
    failIO.rmSync = null
    failIO.writeFileSync = null

    expect(st.encrypted).toBe(false)
    expect(shardText()).toContain('round trip content') // decrypted for real
    expect(shardText()).not.toContain('enc:v1:')
    expect(fs.existsSync(keyCache)).toBe(true)   // the key we could not delete
    expect(fs.existsSync(optout)).toBe(false)    // the choice we could not record

    relaunch()
    expect(getSyncStatus().encrypted).toBe(true) // …so the next launch re-adopts it
    expect(contents()).toEqual(['round trip content'])
  })

  it('rewriting the shard drops blank lines and keeps a line it cannot decrypt verbatim', async () => {
    // A shard picked up from a peer/backup can contain a line encrypted under a key we do not hold.
    // Enabling encryption rewrites every line it CAN read and must copy the rest through untouched —
    // re-encrypting an opaque line, or dropping it, destroys data we merely cannot read yet.
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'keeper content' })
    const foreign = encryptLine(Buffer.alloc(32, 9), JSON.stringify({
      id: 'foreign-1', ts: Date.now() - 1000, agentId: 'peer', kind: 'note', content: 'peer only content',
    }))
    fs.appendFileSync(shardFile(), '\n   \n' + foreign + '\n')

    setSafeStorage(fakeSafe)
    const st = enableLocalEncryption()

    expect(st.encrypted).toBe(true)
    const raw = shardText()
    expect(raw).toContain(foreign)                                   // copied through byte for byte
    expect(raw.split('\n').filter((l) => l.trim() === '').length).toBe(1) // only the trailing newline
    expect(contents()).toEqual(['keeper content'])
    expect(st.locked).toBe(true) // and the store honestly reports the line it cannot read
  })
})

// ---------------------------------------------------------------------------
describe('cross-machine sync encryption — passphrase model', () => {
  it('keeps the store encrypted when the keychain refuses to cache the key, and locks on relaunch', async () => {
    // The key cache is what auto-unlocks the next launch. A keychain that refuses the write is
    // best-effort — but the honest consequence is a locked store on relaunch, not lost data.
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'synced secret content' })
    setSafeStorage(refusingSafe)

    const st = setSyncPassphrase('correct horse battery')

    expect(st.encrypted).toBe(true)
    expect(fs.existsSync(path.join(userDir, KEY_CACHE_FILE))).toBe(false) // nothing was cached

    relaunch({ syncDir })
    const after = getSyncStatus()
    expect(after.encrypted).toBe(false) // no key → locked, and it says so
    expect(after.locked).toBe(true)
    expect(memoryCount()).toBe(0)
  })

  it('disabling sync encryption on a never-encrypted store leaves the shard untouched', async () => {
    // No key means nothing to decrypt: rewriting the shard here would be a pointless full read +
    // re-write of (in the field) a multi-hundred-MB file.
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'never encrypted content' })
    const selfShard = path.join(syncDir, fs.readdirSync(syncDir).find((f) => f.endsWith('.jsonl')) as string)
    const before = fs.readFileSync(selfShard, 'utf8')

    const st = disableSyncEncryption()

    expect(st.encrypted).toBe(false)
    expect(fs.readFileSync(selfShard, 'utf8')).toBe(before) // byte-identical — no rewrite happened
    expect(contents()).toEqual(['never encrypted content'])
  })

  it('decrypts the shard even when the cached key file cannot be removed', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'decrypt me back' })
    setSyncPassphrase('temporary passphrase')
    const selfShard = path.join(syncDir, fs.readdirSync(syncDir).find((f) => f.endsWith('.jsonl')) as string)
    expect(fs.readFileSync(selfShard, 'utf8')).toContain('enc:v1:')
    const keyCache = path.join(userDir, KEY_CACHE_FILE)

    failIO.rmSync = (p) => String(p) === keyCache
    const st = disableSyncEncryption()
    failIO.rmSync = null

    expect(st.encrypted).toBe(false)
    expect(fs.readFileSync(selfShard, 'utf8')).toContain('decrypt me back') // the rewrite still ran
    expect(fs.existsSync(keyCache)).toBe(true) // the stale key we could not remove
    expect(contents()).toEqual(['decrypt me back'])
  })
})
