// Cross-machine sync: device-sharded store, conflict-free union, tombstone
// deletes + clear epoch, legacy migration, persisted config, peer reload.
//
// The store is a grow-only set keyed by id + content hash, so merging devices is
// a deterministic union — these tests simulate peers by dropping shard files
// into the sync folder and asserting they merge/dedup/tombstone correctly.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  memoryCount,
  memoryClear,
  memoryDelete,
  getSyncStatus,
  setSyncDir,
  reloadMemoryFromSync,
  setSyncPassphrase,
  disableSyncEncryption,
  _resetForTests,
  _setEmbedFnForTests,
  _setMaxEntriesForTests,
} from '../../src/main/swarmMemory'

let userDir: string
let syncDir: string

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-user-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-sync-'))
  _resetForTests()
  // Force keyword mode (no model load) — persists across init() calls because
  // init resets embeddingsAvailable but not the injected embed fn.
  _setEmbedFnForTests(async () => null)
})
afterEach(() => {
  _resetForTests()
  for (const d of [userDir, syncDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

const shards = (): string[] => fs.readdirSync(syncDir).filter((f) => f.endsWith('.jsonl'))
const dropShard = (name: string, lines: object[]): void =>
  fs.writeFileSync(path.join(syncDir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

describe('cross-machine sync — device sharding', () => {
  it('writes to a per-device shard inside the sync folder', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'claude', kind: 'fact', content: 'shard me' })
    const files = shards()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[0-9a-f]{16}\.jsonl$/) // <deviceId>.jsonl
    expect(fs.readFileSync(path.join(syncDir, files[0]), 'utf8')).toContain('shard me')
  })

  it('reads a peer shard: a fact written by another device shows up here', () => {
    initSwarmMemory(userDir, { syncDir })
    dropShard('peer.jsonl', [{ id: 'p1', ts: 1000, agentId: 'codex', kind: 'fact', content: 'peer wrote this', hash: 'hp' }])
    reloadMemoryFromSync()
    expect(memoryList().some((e) => e.content === 'peer wrote this')).toBe(true)
  })

  it('dedups identical content across shards by hash', () => {
    initSwarmMemory(userDir, { syncDir })
    dropShard('d1.jsonl', [{ id: 'a', ts: 1, agentId: 'x', kind: 'fact', content: 'same', hash: 'dup' }])
    dropShard('d2.jsonl', [{ id: 'b', ts: 2, agentId: 'y', kind: 'fact', content: 'same', hash: 'dup' }])
    reloadMemoryFromSync()
    expect(memoryList().filter((e) => e.content === 'same')).toHaveLength(1)
  })

  it('does not double-count the same id appearing in two files', () => {
    initSwarmMemory(userDir, { syncDir })
    const e = { id: 'dup-id', ts: 1, agentId: 'x', kind: 'fact', content: 'once' }
    dropShard('d1.jsonl', [e])
    dropShard('d2.jsonl', [e])
    reloadMemoryFromSync()
    expect(memoryCount()).toBe(1)
  })

  it('migrates the legacy local store into this device shard on first enable', async () => {
    initSwarmMemory(userDir) // local-only
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'legacy fact' })
    expect(memoryCount()).toBe(1)
    initSwarmMemory(userDir, { syncDir }) // enable → migrate
    expect(memoryList().some((e) => e.content === 'legacy fact')).toBe(true)
    expect(shards()).toHaveLength(1)
  })

  it('local-only mode keeps the original single-file store (no folder)', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'local only' })
    expect(fs.existsSync(path.join(userDir, 'swarm-memory.jsonl'))).toBe(true)
    expect(getSyncStatus().syncing).toBe(false)
  })
})

describe('cross-machine sync — deletions propagate (tombstones)', () => {
  it('memoryDelete removes an entry and the tombstone survives reload', async () => {
    initSwarmMemory(userDir, { syncDir })
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'delete me' })
    expect(memoryCount()).toBe(1)
    memoryDelete(w.id)
    expect(memoryCount()).toBe(0)
    reloadMemoryFromSync() // tombstone is on disk → stays deleted
    expect(memoryCount()).toBe(0)
  })

  it('a peer tombstone deletes an entry written on another device', () => {
    initSwarmMemory(userDir, { syncDir })
    dropShard('peerA.jsonl', [{ id: 'victim', ts: 1, agentId: 'x', kind: 'fact', content: 'doomed' }])
    dropShard('peerB.jsonl', [{ deleted: 'victim' }])
    reloadMemoryFromSync()
    expect(memoryList().some((x) => x.id === 'victim')).toBe(false)
  })

  it('memoryClear (sync) epoch-drops prior entries but keeps newer writes', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'old' })
    memoryClear() // epoch tombstone @ now
    await new Promise((r) => setTimeout(r, 5)) // ensure a strictly-later ts
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'new' })
    reloadMemoryFromSync()
    const contents = memoryList().map((e) => e.content)
    expect(contents).toContain('new')
    expect(contents).not.toContain('old')
  })
})

describe('cross-machine sync — control + status', () => {
  it('getSyncStatus reflects on/off, folder, and device count', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'x' })
    const s = getSyncStatus()
    expect(s.syncing).toBe(true)
    expect(s.dir).toBe(syncDir)
    expect(s.devices).toBeGreaterThanOrEqual(1)
    expect(s.deviceId).toMatch(/^[0-9a-f]{16}$/)
  })

  it('setSyncDir turns sync on, then off snapshots back to the local store', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'pre' })
    let st = setSyncDir(syncDir)
    expect(st.syncing).toBe(true)
    expect(memoryList().some((e) => e.content === 'pre')).toBe(true)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'during-sync' })
    st = setSyncDir(null)
    expect(st.syncing).toBe(false)
    expect(memoryList().some((e) => e.content === 'during-sync')).toBe(true)
  })

  it('persisted sync config is honored on a fresh init with no opts', async () => {
    initSwarmMemory(userDir)
    setSyncDir(syncDir) // persists { dir: syncDir }
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'persisted-sync' })
    _resetForTests()
    _setEmbedFnForTests(async () => null)
    initSwarmMemory(userDir) // no opts → reads persisted config → sync mode
    expect(getSyncStatus().syncing).toBe(true)
    expect(memoryList().some((e) => e.content === 'persisted-sync')).toBe(true)
  })

  it('reloadMemoryFromSync is a no-op in local-only mode', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'local' })
    reloadMemoryFromSync()
    expect(memoryCount()).toBe(1)
  })

  it('setSyncDir throws if memory was never initialised', () => {
    _resetForTests()
    expect(() => setSyncDir(syncDir)).toThrow(/not initialised/)
  })

  it('getSyncStatus reports off + zero devices in local mode', () => {
    initSwarmMemory(userDir)
    const s = getSyncStatus()
    expect(s.syncing).toBe(false)
    expect(s.devices).toBe(0)
  })

  it('setSyncDir(null) on an already-local store is a safe no-op', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'stay' })
    const st = setSyncDir(null)
    expect(st.syncing).toBe(false)
    expect(memoryList().some((e) => e.content === 'stay')).toBe(true)
  })
})

describe('cross-machine sync — edge cases', () => {
  it('memoryDelete ignores an empty id and a non-existent id', async () => {
    initSwarmMemory(userDir, { syncDir })
    memoryDelete('') // early return — no throw
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'keep' })
    memoryDelete('does-not-exist') // idx === -1 path; tombstone still written
    expect(memoryList().some((e) => e.id === w.id)).toBe(true) // untouched
  })

  it('skips non-object and bare-value lines when merging shards', () => {
    initSwarmMemory(userDir, { syncDir })
    fs.writeFileSync(path.join(syncDir, 'weird.jsonl'), '5\n"a string"\n[1,2]\n{"clearedBefore":0}\n')
    dropShard('ok.jsonl', [{ id: 'k', ts: 9, agentId: 'x', kind: 'fact', content: 'survivor' }])
    reloadMemoryFromSync()
    expect(memoryCount()).toBe(1)
    expect(memoryList()[0].content).toBe('survivor')
  })

  it('trims the hot window to the newest maxEntries across shards', () => {
    _setMaxEntriesForTests(2)
    initSwarmMemory(userDir, { syncDir })
    dropShard('peer.jsonl', [
      { id: 'e1', ts: 1, agentId: 'x', kind: 'fact', content: 'oldest' },
      { id: 'e2', ts: 2, agentId: 'x', kind: 'fact', content: 'mid' },
      { id: 'e3', ts: 3, agentId: 'x', kind: 'fact', content: 'newest' },
    ])
    reloadMemoryFromSync()
    expect(memoryCount()).toBe(2)
    const contents = memoryList().map((e) => e.content)
    expect(contents).toContain('newest')
    expect(contents).not.toContain('oldest') // trimmed as oldest
  })
})

describe('cross-machine sync — at-rest encryption', () => {
  const selfShardRaw = (): string => fs.readFileSync(path.join(syncDir, shards()[0]), 'utf8')

  it('encrypts this device shard at rest, yet Termpolis still reads it', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'TOPSECRET-rocket-fuel-formula' })
    const st = setSyncPassphrase('correct horse battery staple')
    expect(st.encrypted).toBe(true)
    expect(st.locked).toBe(false)
    const raw = selfShardRaw()
    expect(raw).toContain('enc:v1:')             // on-disk is ciphertext
    expect(raw).not.toContain('TOPSECRET')       // plaintext does NOT leak to the synced file
    expect(memoryList().some((e) => e.content.includes('TOPSECRET'))).toBe(true) // …but the store reads it
  })

  it('new writes after encryption are persisted as ciphertext', async () => {
    initSwarmMemory(userDir, { syncDir })
    setSyncPassphrase('k')
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'written-after-encrypt' })
    expect(selfShardRaw()).not.toContain('written-after-encrypt')
    expect(memoryList().some((e) => e.content === 'written-after-encrypt')).toBe(true)
  })

  it('a second device with the SAME passphrase reads the encrypted memory', async () => {
    // Device A encrypts a fact.
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'shared-encrypted-fact' })
    setSyncPassphrase('p@ss')
    // Device B: fresh userData, same sync folder, no cached key → locked until unlocked.
    const userDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-userB-'))
    try {
      _resetForTests()
      _setEmbedFnForTests(async () => null)
      initSwarmMemory(userDirB, { syncDir })
      expect(getSyncStatus().locked).toBe(true)
      expect(memoryList().some((e) => e.content === 'shared-encrypted-fact')).toBe(false)
      const st = setSyncPassphrase('p@ss') // same passphrase
      expect(st.locked).toBe(false)
      expect(memoryList().some((e) => e.content === 'shared-encrypted-fact')).toBe(true)
    } finally {
      fs.rmSync(userDirB, { recursive: true, force: true })
    }
  })

  it('rejects a WRONG passphrase on a device with existing ciphertext', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'x' })
    setSyncPassphrase('right-one')
    const userDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-userB2-'))
    try {
      _resetForTests()
      _setEmbedFnForTests(async () => null)
      initSwarmMemory(userDirB, { syncDir })
      expect(() => setSyncPassphrase('WRONG')).toThrow(/Incorrect passphrase/)
    } finally {
      fs.rmSync(userDirB, { recursive: true, force: true })
    }
  })

  it('auto-unlocks on re-init via the locally-cached key (no re-prompt)', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'persist-encrypted' })
    setSyncPassphrase('remember-me')
    _resetForTests()
    _setEmbedFnForTests(async () => null)
    initSwarmMemory(userDir, { syncDir }) // same device → key cached in userDir
    const st = getSyncStatus()
    expect(st.encrypted).toBe(true)
    expect(st.locked).toBe(false)
    expect(memoryList().some((e) => e.content === 'persist-encrypted')).toBe(true)
  })

  it('disabling encryption rewrites the shard back to plaintext', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'plain-again' })
    setSyncPassphrase('temp')
    expect(selfShardRaw()).toContain('enc:v1:')
    const st = disableSyncEncryption()
    expect(st.encrypted).toBe(false)
    expect(selfShardRaw()).toContain('plain-again')
    expect(selfShardRaw()).not.toContain('enc:v1:')
    expect(memoryList().some((e) => e.content === 'plain-again')).toBe(true)
  })

  it('encryption helpers require sync to be enabled + a non-empty passphrase', () => {
    initSwarmMemory(userDir) // local-only
    expect(() => setSyncPassphrase('x')).toThrow(/not enabled/)
    expect(() => disableSyncEncryption()).toThrow(/not enabled/)
    initSwarmMemory(userDir, { syncDir })
    expect(() => setSyncPassphrase('   ')).toThrow(/passphrase required/)
  })
})

describe('cross-machine sync — packed-vector reconstruction on snapshot', () => {
  it('turning sync off reconstructs packed EMBED_DIM vectors into the local store', async () => {
    initSwarmMemory(userDir, { syncDir })
    const vec = new Array(384).fill(0)
    vec[42] = 1
    _setEmbedFnForTests(async () => vec) // 384-dim → gets packed (number[] dropped from the stored entry)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'packed-and-synced' })
    setSyncDir(null) // snapshots the unioned set back to the local file
    const legacy = fs.readFileSync(path.join(userDir, 'swarm-memory.jsonl'), 'utf8')
    expect(legacy).toContain('packed-and-synced')
    expect(legacy).toContain('"embedding"') // the vector was reconstructed from the store, not lost
  })
})
