// swarmMemory — the defensive arms the behavioural suites never reach (part A: the store's
// first ~900 lines).
//
// Everything here is a path the brain only walks when the environment misbehaves: an OS that
// reports no home directory, a delete issued before init, a sync folder AND a local fallback
// that are both unwritable, a shard record with no `ts` / no `hash` / an EMPTY hash, a control
// line written by another device. Those are precisely the places a memory store loses data
// quietly, so every test asserts what is recalled / what reaches disk — never just that a line ran.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

// `os` is a PASSTHROUGH mock — only `homedir` is divertible, and only while a test arms the
// hook. (An ESM namespace export cannot be vi.spyOn'd, and the store calls os.hostname() for
// the device fingerprint, so a full auto-mock would strand init.)
const osHome = vi.hoisted(() => ({ fn: null as null | (() => string) }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const api = { ...actual, homedir: (): string => (osHome.fn ? osHome.fn() : actual.homedir()) }
  return { ...api, default: api }
})

// `fs` is a PASSTHROUGH mock too: real disk everywhere unless a test arms the hook. Used here
// to make the ONE file we care about (the legacy store) unwritable while the device-id file,
// the graph and the audit log keep working — otherwise init would throw before reaching the
// fallback arm we are testing.
const failIO = vi.hoisted(() => ({ writeFileSync: null as null | ((p: unknown) => boolean) }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const api = {
    ...actual,
    writeFileSync: (...args: unknown[]): unknown => {
      if (failIO.writeFileSync?.(args[0])) throw new Error('EACCES: read-only volume')
      return (actual.writeFileSync as (...a: unknown[]) => unknown)(...args)
    },
  }
  return { ...api, default: api }
})

import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  memoryCount,
  memoryClear,
  memoryDelete,
  memoryHasHash,
  memoryPatchProjects,
  getSyncStatus,
  reloadMemoryFromSync,
  normalizeProjectSlug,
  _resetForTests,
  _setEmbedFnForTests,
  _setMaxEntriesForTests,
} from '../../src/main/swarmMemory'
import { setSafeStorage } from '../../src/main/secureKeyStore'

// Captured at import time, while the homedir hook is still disarmed.
const REAL_HOME = os.homedir()
const HOME_SLUG = path.basename(REAL_HOME).toLowerCase()

let userDir: string
let syncDir: string
const storeFile = (): string => path.join(userDir, 'swarm-memory.jsonl')
const storeText = (): string => fs.readFileSync(storeFile(), 'utf8')
const ids = (): string[] => memoryList().map((e) => e.id)
const writeStore = (lines: object[]): void =>
  fs.writeFileSync(storeFile(), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
const dropShard = (name: string, lines: object[]): void =>
  fs.writeFileSync(path.join(syncDir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-brA-u-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-brA-s-'))
  osHome.fn = null
  failIO.writeFileSync = null
  setSafeStorage(null)                  // no OS keychain → default-on encryption stays off
  _resetForTests()
  _setEmbedFnForTests(async () => null) // keyword-only mode: never loads the bge model
})

afterEach(() => {
  vi.restoreAllMocks()
  osHome.fn = null
  failIO.writeFileSync = null
  setSafeStorage(null)
  _resetForTests()
  for (const d of [userDir, syncDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// ---------------------------------------------------------------------------
// The home directory is the one basename that must never become a project slug (it is the
// user's ACCOUNT NAME). The lookup is cached in module state and resolved exactly once, so
// these two cases need a fresh module instance rather than a reset helper.
describe('home-directory guard — when the OS will not tell us where home is', () => {
  it('treats the home path as a normal project when homedir() comes back empty', async () => {
    expect(normalizeProjectSlug(REAL_HOME)).toBe('') // baseline: a resolvable home IS blanked

    osHome.fn = () => ''                             // some containers/services report no HOME
    vi.resetModules()
    const fresh = await import('../../src/main/swarmMemory')

    // With nothing to compare against, the guard must fail OPEN — blanking every slug would
    // strip the scope off every memory written on this machine.
    expect(fresh.normalizeProjectSlug(REAL_HOME)).toBe(HOME_SLUG)
    expect(fresh.normalizeProjectSlug('/srv/work/api')).toBe('api')
  })

  it('survives a homedir() that throws instead of answering', async () => {
    osHome.fn = () => { throw new Error('EPERM: no passwd entry for uid') }
    vi.resetModules()
    const fresh = await import('../../src/main/swarmMemory')

    // The throw is swallowed into "home unknown" — resolution must not be retried per call
    // either, so a second call gives the same answer without re-raising.
    expect(fresh.normalizeProjectSlug(REAL_HOME)).toBe(HOME_SLUG)
    expect(fresh.normalizeProjectSlug(REAL_HOME)).toBe(HOME_SLUG)
  })
})

// ---------------------------------------------------------------------------
describe('uninitialised store — the API must be inert, not durable', () => {
  it('memoryDelete before init writes no deletes-floor and leaves the id recallable later', () => {
    // userDataDir is null, so there is nowhere to persist a tombstone floor. The danger is the
    // opposite of a crash: a delete that "sticks" here would suppress the id on the next launch.
    expect(() => memoryDelete('ghost')).not.toThrow()
    expect(fs.existsSync(path.join(userDir, 'memory-deletes.json'))).toBe(false)

    writeStore([{ id: 'ghost', ts: 1000, agentId: 'a', kind: 'fact', content: 'still here', hash: 'hg' }])
    initSwarmMemory(userDir)
    expect(ids()).toEqual(['ghost'])
    expect(memoryCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
describe('init failure — no shard at all', () => {
  it('a reload with the sync folder AND the local fallback both dead yields an empty window', async () => {
    const brokenSync = path.join(userDir, 'blocker')
    fs.writeFileSync(brokenSync, 'x')                  // a FILE where a folder is expected
    failIO.writeFileSync = (p) => typeof p === 'string' && p.endsWith('swarm-memory.jsonl')

    initSwarmMemory(userDir, { syncDir: brokenSync })  // sync mkdir fails, then so does the fallback
    failIO.writeFileSync = null

    const s = getSyncStatus()
    expect(s.degraded).toBe(true)
    expect(s.syncing).toBe(true)                       // sync stays ON — it may mount later
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'ram only, nowhere to land' })
    expect(w.durable).toBe(false)
    expect(memoryCount()).toBe(1)                      // usable in RAM this session…

    // …but listing the shards throws (ENOTDIR) and there is no local shard to fall back on,
    // so the reload honestly rebuilds from nothing rather than resurrecting a stale window.
    expect(() => reloadMemoryFromSync()).not.toThrow()
    expect(memoryCount()).toBe(0)
  })

  it('keeps an already-resolved encryption key through a fully degraded init', () => {
    // The key is resolved BEFORE the store write blows up, so the fallback arm must not
    // re-resolve (or drop) it — losing it would make every local ciphertext line unreadable
    // and the store would come back looking empty rather than locked.
    failIO.writeFileSync = (p) => typeof p === 'string' && p.endsWith('swarm-memory.jsonl')
    initSwarmMemory(userDir, { encKey: Buffer.alloc(32, 7) })
    failIO.writeFileSync = null

    const s = getSyncStatus()
    expect(s.degraded).toBe(true)
    expect(s.encrypted).toBe(true)
    expect(s.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
describe('reload — records the merge model must tolerate', () => {
  it('sorts a ts-less record oldest no matter which end of the shard it sits at', () => {
    // The union is documented as order-independent. A ts-less record read AFTER a dated one
    // lands on the other side of the sort comparator than the reverse layout does — same file,
    // same answer, or a peer's shard order could decide what the newest memory is.
    writeStore([
      { id: 'has-ts', ts: 5000, agentId: 'a', kind: 'fact', content: 'dated record', hash: 'h-dated' },
      { id: 'no-ts', agentId: 'a', kind: 'note', content: 'undated record', hash: 'h-undated' },
    ])
    initSwarmMemory(userDir)

    expect(ids()).toEqual(['has-ts', 'no-ts'])
  })

  it('remembers the content hash of an entry evicted by the hot-window cap', () => {
    // Driven through a SYNC reload rather than init: init reloads and then reloads the
    // device-local forgot-set from disk, which would wipe what the eviction just recorded.
    initSwarmMemory(userDir, { syncDir })
    dropShard('peer.jsonl', [
      { id: 'old', ts: 1000, agentId: 'a', kind: 'note', content: 'pushed out of the window', hash: 'h-old' },
      { id: 'new', ts: 2000, agentId: 'a', kind: 'note', content: 'still in the window', hash: 'h-new' },
    ])
    _setMaxEntriesForTests(1)
    reloadMemoryFromSync()

    expect(ids()).toEqual(['new'])
    // The bytes are still in the peer's shard but outside RAM: without the forgot-set the
    // auto-indexer would see "not stored" and re-ingest the very chunk we just evicted, forever.
    expect(memoryHasHash('h-old')).toBe(true)
    expect(memoryHasHash('h-new')).toBe(true)
  })

  it('replays a persisted project patch past a hash-less entry', () => {
    // A patch is content-addressed, so the replay index can only hold entries that HAVE a hash.
    // A legacy hash-less record sharing the window must be stepped over, not indexed under
    // `undefined` (which would let one patch tag every hash-less memory in the store).
    writeStore([
      { id: 'no-hash', ts: 1000, agentId: 'a', kind: 'note', content: 'legacy chunk, no hash' },
      { id: 'hashed', ts: 1001, agentId: 'a', kind: 'note', content: 'legacy chunk, hashed', hash: 'h-x' },
      { patch: { hash: 'h-x', project: 'termpolis', projectKey: 'key-1' } },
    ])
    initSwarmMemory(userDir)

    const byId = new Map(memoryList().map((e) => [e.id, e]))
    expect(byId.get('hashed')?.project).toBe('termpolis')
    expect(byId.get('hashed')?.projectKey).toBe('key-1')
    expect(byId.get('no-hash')?.project).toBeUndefined()
  })

  it('honours a clearedIds control line written by ANOTHER device', () => {
    // An identity clear from a peer must tombstone here as well; only the bookkeeping that
    // stops us re-emitting our OWN tombstones is skipped for a foreign shard.
    initSwarmMemory(userDir, { syncDir })
    dropShard('peer.jsonl', [
      { id: 'p1', ts: 1000, agentId: 'codex', kind: 'fact', content: 'peer entry, cleared' },
      { id: 'p2', ts: 1001, agentId: 'codex', kind: 'fact', content: 'peer entry, kept' },
      { clearedIds: ['p1'] },
    ])
    reloadMemoryFromSync()

    expect(memoryList().map((e) => e.content)).toEqual(['peer entry, kept'])
    // Because the clear arrived on a FOREIGN shard it is not recorded as one of ours, so the
    // replication pass re-emits it into our own shard — that is what keeps the deletion alive
    // if the peer's shard is later lost. (Our own clearedIds lines are skipped here instead.)
    const ownShard = fs.readFileSync(path.join(syncDir, `${getSyncStatus().deviceId}.jsonl`), 'utf8')
    expect(ownShard).toContain('{"clearedIds":["p1"]}')
  })
})

// ---------------------------------------------------------------------------
describe('forgot-set and project backfill — the empty-input arms', () => {
  it('never records an EMPTY content hash as forgotten when the store is cleared', () => {
    writeStore([
      { id: 'blank', ts: 1000, agentId: 'a', kind: 'note', content: 'record with an empty hash', hash: '' },
      { id: 'real', ts: 1001, agentId: 'a', kind: 'note', content: 'record with a real hash', hash: 'h-real' },
    ])
    initSwarmMemory(userDir)
    expect(memoryCount()).toBe(2)

    memoryClear()

    expect(memoryCount()).toBe(0)
    expect(memoryHasHash('h-real')).toBe(true)  // cleared content must not be re-ingested…
    expect(memoryHasHash('')).toBe(false)       // …but '' as "already seen" would swallow every
                                                // hash-less chunk the indexer ever offers us.
  })

  it('a project backfill that matches nothing patches nothing and leaves the shard byte-identical', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'an unscoped memory' })
    const before = storeText()

    expect(memoryPatchProjects([{ hash: 'no-such-hash', project: 'termpolis' }])).toBe(0)

    // A no-op backfill runs on every re-ingest pass; appending a `{patch}` control line (or
    // invalidating the search cache) for zero patches would grow the shard without end.
    expect(storeText()).toBe(before)
    expect(memoryList()[0]?.project).toBeUndefined()
  })
})
