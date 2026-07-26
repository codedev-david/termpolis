// swarmMemory — the arms that only open when the DISK misbehaves *mid-operation*, plus the two
// ordering fallbacks only a LEGACY (ts-less) record can reach.
//
// Four situations dominate this file:
//
//   * A SHARD THAT WILL NOT READ. Every JSONL loader streams through forEachShardLine, which is
//     one `fs.readFileSync`. When that throws (locked file, offline sync folder, EIO) the callers
//     each have a bare `catch` whose whole job is "don't take the app down, and don't destroy the
//     file you failed to read". Those catches are invisible to every happy-path suite, and the
//     thing they protect is the user's entire brain — so what is asserted below is always the
//     state of the FILE afterwards, not just that the call returned.
//   * A RENAME THAT WILL NOT LAND. The atomic whole-file write is temp+fsync+rename; on Windows
//     the rename can be refused over a live target, so there is an unlink-then-rename fallback,
//     and a second failure has to clean up its own temp file rather than litter one beside the
//     shard forever.
//   * LEGACY (ts-less) records. A line written before `ts` existed loads with ts === undefined, so
//     `(x.ts || 0)` has a live falsy arm in both order-by-recency comparators that a freshly
//     written entry can never reach. Getting it wrong scrambles the page rather than crashing.
//   * THE COMPACTION GATE SAYING "MAYBE". The cheap gate deliberately over-states dead weight, so
//     the real pass must be free to look at the true numbers and decide NOT to rewrite after all.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const tele = vi.hoisted(() => ({ recordSwarmError: vi.fn() }))
vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: tele.recordSwarmError }))

// `fs` is a PASSTHROUGH mock (same shape as swarmMemoryBranchesC.test.ts): every call hits the real
// filesystem unless a test arms a hook, and each hook takes the target path so a test can break
// exactly ONE file. Arming them globally would take out the tmp-dir teardown, the memory-graph
// store and the audit log too, and the whole point is to prove ONE broken file is survivable.
const failIO = vi.hoisted(() => ({
  readFileSync: null as null | ((p: string) => boolean),
  renameSync: null as null | ((from: string, to: string) => boolean),
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const call = (fn: unknown, args: unknown[]): unknown => (fn as (...a: unknown[]) => unknown)(...args)
  const api = {
    ...actual,
    readFileSync: (...args: unknown[]): unknown => {
      if (typeof args[0] === 'string' && failIO.readFileSync?.(args[0])) {
        throw new Error('EIO: i/o error, read')
      }
      return call(actual.readFileSync, args)
    },
    renameSync: (...args: unknown[]): unknown => {
      if (typeof args[0] === 'string' && typeof args[1] === 'string' && failIO.renameSync?.(args[0], args[1])) {
        throw new Error('EPERM: operation not permitted, rename')
      }
      return call(actual.renameSync, args)
    },
  }
  return { ...api, default: api }
})

// The embedder is always MOCKED so nothing here depends on the bge model being present.
const model = vi.hoisted(() => ({ ready: true }))
vi.mock('../../src/main/localEmbedder', () => ({
  EMBED_DIM: 384,
  isEmbedderReady: (): boolean => model.ready,
  embedText: async (): Promise<number[] | null> => null,
}))

import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryList,
  memoryCount,
  memoryClear,
  searchArchive,
  memoryPruneCodePath,
  compactSelfShard,
  setSyncPassphrase,
  getSyncStatus,
  SALT_FILE,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _vectorStoreSizeForTests,
  _compactionMayBeWorthwhileForTests,
  _ownShardStateForTests,
} from '../../src/main/swarmMemory'
import { setSafeStorage } from '../../src/main/secureKeyStore'

const DIM = 384
/** A 384-dim one-hot unit vector — orthogonal to every other index. */
const unit = (i: number): number[] => { const v = new Array<number>(DIM).fill(0); v[i % DIM] = 1; return v }

let userDir: string
let syncDir: string
const shardFile = (): string => path.join(userDir, 'swarm-memory.jsonl')
const archiveFile = (): string => path.join(userDir, 'swarm-memory.archive.jsonl')
const saltFile = (): string => path.join(syncDir, SALT_FILE)

/** Shard lines exactly as an older build would have left them — `ts` deliberately optional. */
type RawLine = Record<string, unknown>
/** Lay down this device's shard BEFORE init, so the loader has to parse it as a legacy file. */
const dropShard = (lines: Array<RawLine | string>): void => {
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
  fs.writeFileSync(shardFile(), text)
}
const shardLines = (): string[] => fs.readFileSync(shardFile(), 'utf8').split('\n').filter((l) => l.trim())

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-brD-u-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-brD-s-'))
  tele.recordSwarmError.mockClear()
  model.ready = true
  failIO.readFileSync = null
  failIO.renameSync = null
  setSafeStorage(null)          // no OS keychain → default-on encryption stays off
  _resetForTests()
  _setEmbedFnForTests(async () => null) // default: writes succeed, no vectors
})

afterEach(() => {
  // Disarm BEFORE the cleanup below — the tmp-dir teardown goes through the same mocked fs.
  failIO.readFileSync = null
  failIO.renameSync = null
  vi.restoreAllMocks()
  setSafeStorage(null)
  _resetForTests()
  for (const d of [userDir, syncDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// ---------------------------------------------------------------------------
describe('ordering a legacy record that has no timestamp', () => {
  it('sorts ts-less shard lines to the BOTTOM of the list instead of scrambling the page', () => {
    // `(b.ts || 0) - (a.ts || 0)`: with ts === undefined the subtraction would be NaN, and a NaN
    // comparator returns an arbitrary order for the WHOLE page, not just the offending row. TWO
    // ts-less lines, so the comparator meets one on each side of the subtraction — and their
    // relative order also pins the documented tie-break (newest-INSERTED first among equal ts).
    const now = Date.now()
    dropShard([
      { id: 'legacy-early', agentId: 'a', kind: 'note', content: 'the first note written before ts existed' },
      { id: 'legacy-late', agentId: 'a', kind: 'note', content: 'the second note written before ts existed' },
      { id: 'stamped-old', ts: now - 5_000, agentId: 'a', kind: 'note', content: 'a note from earlier today' },
      { id: 'stamped-new', ts: now - 1_000, agentId: 'a', kind: 'note', content: 'the freshest note of the four' },
    ])
    initSwarmMemory(userDir)

    expect(memoryCount()).toBe(4) // the ts-less lines are kept, not dropped
    expect(memoryList().map((e) => e.id)).toEqual(['stamped-new', 'stamped-old', 'legacy-late', 'legacy-early'])
  })

  it('breaks an archive score tie by recency, treating ts-less records as the oldest', () => {
    // searchArchive's comparator is `b.score - a.score || (b.e.ts || 0) - (a.e.ts || 0)` — the
    // recency arm only runs on a TIE, and only a legacy record reaches the `|| 0` fallback. Two
    // legacy records so the fallback is exercised on BOTH sides of the subtraction; without it the
    // NaN would shuffle equally-relevant archive hits at random.
    initSwarmMemory(userDir)
    fs.writeFileSync(archiveFile(), [
      JSON.stringify({ id: 'arc-legacy-early', agentId: 'a', kind: 'note', content: 'alpha rollout note, no timestamp' }),
      JSON.stringify({ id: 'arc-legacy-late', agentId: 'a', kind: 'note', content: 'alpha rollback note, no timestamp' }),
      JSON.stringify({ id: 'arc-recent', ts: Date.now(), agentId: 'a', kind: 'note', content: 'alpha rollout note, timestamped' }),
      JSON.stringify({ id: 'arc-best', ts: 1, agentId: 'a', kind: 'note', content: 'alpha and beta rollout notes' }),
    ].join('\n') + '\n')

    // arc-best matches both terms, so relevance still beats recency even though it is the oldest;
    // the two ts-less records tie outright and keep their archive order.
    expect(searchArchive('alpha beta').map((e) => e.id)).toEqual([
      'arc-best', 'arc-recent', 'arc-legacy-early', 'arc-legacy-late',
    ])
  })
})

// ---------------------------------------------------------------------------
describe('pruning a re-indexed source file', () => {
  it('unmaps the pruned chunk\'s packed row so a vector search cannot resurrect it', async () => {
    // memoryPruneCodePath drops stale chunks for an EDITED file. The chunk's vector row stays in
    // the packed store (rows are never renumbered on a delete) — only the row→entry mapping is
    // removed. Miss that and the next semantic search hands back the chunk it just pruned, with
    // wrong line numbers pointing at code that no longer exists.
    _setEmbeddingsAvailable(true)
    _setEmbedFnForTests(async (t: string) => (t.includes('widget.ts') ? unit(1) : unit(2)))
    initSwarmMemory(userDir)

    const chunk = await memoryWrite({
      agentId: 'indexer', kind: 'note', source: 'code',
      content: 'src/widget.ts:1-10\nexport const widget = () => 1',
    })
    const note = await memoryWrite({ agentId: 'a', kind: 'note', content: 'a plain note about the release checklist' })
    expect(_vectorStoreSizeForTests()).toBe(2)
    expect((await memorySearch({ query: 'widget.ts chunk' })).map((e) => e.id)).toContain(chunk.id)

    expect(memoryPruneCodePath('src/widget.ts')).toBe(1)

    expect(memoryList().map((e) => e.id)).toEqual([note.id]) // gone from the hot window
    // ...and gone from the VECTOR path: its row is still in the packed store, so an unmapped row
    // is the only thing standing between the query and the stale chunk.
    expect((await memorySearch({ query: 'widget.ts chunk' })).map((e) => e.id)).not.toContain(chunk.id)
  })
})

// ---------------------------------------------------------------------------
describe('a shard that will not read', () => {
  it('abandons compaction rather than rewriting a shard it could not stream', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'the first durable memory of the run' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'the second durable memory of the run' })
    const before = fs.readFileSync(shardFile(), 'utf8')

    failIO.readFileSync = (p) => p === shardFile()
    // force skips the cheap gate, so this is the real pass failing on its own first read.
    expect(compactSelfShard({ force: true })).toEqual({ compacted: false, before: 0, after: 0 })
    failIO.readFileSync = null

    // The shard is untouched — a compaction that cannot read must never write.
    expect(fs.readFileSync(shardFile(), 'utf8')).toBe(before)
    expect(memoryCount()).toBe(2)
  })

  it('still enables encryption when neither the passphrase probe nor the rewrite can read the shard', () => {
    // setSyncPassphrase reads the shard TWICE: once to find a ciphertext sample to validate the
    // passphrase against, once to re-encrypt this device's lines. Both are best-effort; the one
    // thing that must never happen is the rewrite writing back the empty result of a failed read.
    initSwarmMemory(userDir, { syncDir })
    const memPath = fs.readdirSync(syncDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(syncDir, f))[0]
    fs.writeFileSync(memPath, JSON.stringify({ id: 'plain-1', ts: Date.now(), agentId: 'a', kind: 'note', content: 'a plaintext line nobody could read back' }) + '\n')
    const before = fs.readFileSync(memPath, 'utf8')

    failIO.readFileSync = (p) => p.endsWith('.jsonl') && p.startsWith(syncDir)
    const status = setSyncPassphrase('correct horse battery staple')
    failIO.readFileSync = null

    expect(status.encrypted).toBe(true)          // the key was still adopted
    expect(fs.readFileSync(memPath, 'utf8')).toBe(before) // ...but the shard was left verbatim
    expect(tele.recordSwarmError).not.toHaveBeenCalled()
  })

  it('refuses to mint a replacement salt when the existing one cannot be read', () => {
    // F4: an existing salt is authoritative. Minting a new one on a transient read hiccup would
    // derive a DIFFERENT key and permanently orphan every peer's ciphertext — so this surfaces.
    initSwarmMemory(userDir, { syncDir })
    fs.writeFileSync(saltFile(), Buffer.alloc(16, 7).toString('base64'))
    const before = fs.readFileSync(saltFile(), 'utf8')

    failIO.readFileSync = (p) => p === saltFile()
    expect(() => setSyncPassphrase('correct horse battery staple')).toThrow(/salt unavailable/)
    failIO.readFileSync = null

    expect(fs.readFileSync(saltFile(), 'utf8')).toBe(before) // not overwritten
    expect(getSyncStatus().encrypted).toBe(false)            // and no half-applied key
  })
})

// ---------------------------------------------------------------------------
describe('an atomic truncate whose rename is refused', () => {
  it('falls back to unlink-then-rename so the clear still lands', () => {
    // Windows rejects a rename over an existing/locked target. Without the fallback the clear
    // silently leaves every "erased" memory on disk, to be reloaded on the next launch.
    initSwarmMemory(userDir)
    dropShard([
      { id: 'old-1', ts: Date.now(), agentId: 'a', kind: 'note', content: 'a memory the user asked us to erase' },
    ])
    initSwarmMemory(userDir)
    expect(memoryCount()).toBe(1)

    let attempts = 0
    failIO.renameSync = (from) => from === shardFile() + '.tmp' && ++attempts === 1 // only the first is refused
    memoryClear()
    failIO.renameSync = null

    expect(attempts).toBe(2)                                 // refused once, then retried after the unlink
    expect(fs.readFileSync(shardFile(), 'utf8')).toBe('')    // the fallback landed the truncate
    expect(fs.existsSync(shardFile() + '.tmp')).toBe(false)  // no temp file left beside the shard
    expect(memoryCount()).toBe(0)
  })

  it('cleans up its own temp file when the fallback rename is refused too', () => {
    initSwarmMemory(userDir)
    dropShard([
      { id: 'old-1', ts: Date.now(), agentId: 'a', kind: 'note', content: 'a memory the user asked us to erase' },
    ])
    initSwarmMemory(userDir)

    let renames = 0
    failIO.renameSync = (_from, to) => { if (to === shardFile()) { renames++; return true } return false }
    expect(() => memoryClear()).not.toThrow() // the caller treats the truncate as best-effort
    failIO.renameSync = null

    expect(renames).toBe(2) // both the direct rename and the unlink-then-rename fallback
    // A shard we could not replace must not be left with a stray `.tmp` sibling — the next
    // launch would otherwise accumulate one per failed clear, forever.
    expect(fs.existsSync(shardFile() + '.tmp')).toBe(false)
    expect(memoryCount()).toBe(0) // the in-memory clear still happened
  })
})

// ---------------------------------------------------------------------------
describe('the compaction gate over-stating dead weight', () => {
  it('looks properly, finds nothing dead, and leaves the shard byte-for-byte alone', () => {
    // The cheap gate knows only "how many lines our shard has" and "which of our entries are
    // live". A shard of pure project-backfill patches tells it nothing (no add ids at all), so it
    // says "go and look properly" — and the real pass, which keeps every patch line verbatim,
    // must then decline. A 250-line rewrite that changes nothing is pure freeze for no gain.
    dropShard(Array.from({ length: 250 }, (_, i) => ({ patch: { hash: `h${i}`, project: 'termpolis' } })))
    initSwarmMemory(userDir)
    const before = fs.readFileSync(shardFile(), 'utf8')

    expect(_ownShardStateForTests()).toEqual({ lines: 250, addIds: 0 })
    expect(_compactionMayBeWorthwhileForTests()).toBe(true) // the estimate says "maybe"

    expect(compactSelfShard()).toEqual({ compacted: false, before: 250, after: 250 })
    expect(fs.readFileSync(shardFile(), 'utf8')).toBe(before)
    expect(shardLines()).toHaveLength(250)
  })
})
