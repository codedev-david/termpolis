// Decisions 1-4 at the store: the key ring, LOCKED, the key-mismatch window, re-inits that keep their
// key, and the encryption rewrite that covers the WHOLE own set and the archive. (The same rules through
// the real RPC seam — main's provisioning, a child with no keychain, a respawn — are in
// memoryHost.test.ts.)
//
// Everything here is about one promise: a brain is never lost, overwritten, re-keyed or blanked on its
// way to a new build, and nothing is ever appended to it in plaintext or under the wrong key.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const tele = vi.hoisted(() => ({ recordSwarmError: vi.fn() }))
vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: tele.recordSwarmError }))

// `fs` is a PASSTHROUGH: every call hits the real filesystem unless a test arms a hook to break exactly
// one operation (an ESM namespace can't be spied, so this is how a single failure is injected).
const failIO = vi.hoisted(() => ({
  openSync: null as null | ((p: string, flags: unknown) => boolean),
  renameSync: null as null | ((from: string, to: string) => boolean),
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const api = {
    ...actual,
    openSync: (...args: unknown[]): number => {
      if (typeof args[0] === 'string' && failIO.openSync?.(args[0], args[1])) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      return (actual.openSync as (...a: unknown[]) => number)(...args)
    },
    renameSync: (...args: unknown[]): void => {
      if (typeof args[0] === 'string' && typeof args[1] === 'string' && failIO.renameSync?.(args[0], args[1])) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      ;(actual.renameSync as (...a: unknown[]) => void)(...args)
    },
  }
  return { ...api, default: api }
})

// The rewrite reads every staged file BACK before it swaps anything in. This hook makes that read-back
// come up one line short — what a disk that lost a write would look like.
const readBack = vi.hoisted(() => ({ shortRead: null as null | ((file: string) => boolean) }))
vi.mock('../../src/main/fileLines', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/fileLines')>()
  return {
    ...actual,
    forEachShardLine: (file: string, onLine: (line: string) => void | boolean): void => {
      if (!readBack.shortRead?.(file)) return actual.forEachShardLine(file, onLine)
      let skipped = false
      actual.forEachShardLine(file, (line) => { if (!skipped) { skipped = true; return } return onLine(line) })
    },
  }
})

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory, memoryWrite, memoryList, memoryCount, memoryDelete, memoryArchive, searchArchive, memoryClear,
  memoryFeedback, memoryPatchProjects, memoryPruneCodePath, backfillCodeRefs, importMemorySnapshot, compactSelfShard,
  memorySearch, persistMemoryIndex, getSyncStatus, enableLocalEncryption, disableEncryption, adoptEncryptionKey,
  startNewMemoryKey, setVectorQuantization, setSyncDir, setSyncPassphrase, disableSyncEncryption, reloadMemoryFromSync,
  inspectMemoryKey, encodeEmbedding, KEY_CACHE_FILE, ENCRYPTION_OPTOUT_FILE,
  _resetForTests, _setEmbeddingsAvailable, _setEmbedFnForTests, _setMaxShardBytesForTests, _setHnswThresholdForTests,
  _isVectorStoreQuantizedForTests, _vectorStoreSizeForTests,
} from '../../src/main/swarmMemory'
import { setSafeStorage } from '../../src/main/secureKeyStore'
import { encryptLine, decryptLine } from '../../src/main/memoryCrypto'
import { EMBED_DIM } from '../../src/main/localEmbedder'
import type { CodeRef } from '../../src/main/codeGraph'

/** A fake OS keychain (the marker prefix stands in for DPAPI / Keychain / libsecret). */
const fakeSafe = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (s: string): Buffer => Buffer.from('SAFE:' + s, 'utf8'),
  decryptString: (b: Buffer): string => b.toString('utf8').slice(5),
}
const wrap = (k: Buffer): string => 'osk:v1:' + fakeSafe.encryptString(k.toString('base64')).toString('base64')
const unit = (i: number): number[] => { const v = new Array<number>(EMBED_DIM).fill(0); v[i % EMBED_DIM] = 1; return v }

const K1 = Buffer.alloc(32, 0x11)
const K2 = Buffer.alloc(32, 0x22)
const K3 = Buffer.alloc(32, 0x33)

let userDir: string
let syncDir: string
const logFile = (): string => path.join(userDir, 'swarm-memory.jsonl')
const genFile = (n: number): string => path.join(userDir, `swarm-memory.${n}.jsonl`)
const archiveFile = (): string => path.join(userDir, 'swarm-memory.archive.jsonl')
const keyFile = (): string => path.join(userDir, KEY_CACHE_FILE)
const contents = (): string[] => memoryList({ limit: 500 }).map((e) => e.content).sort()
const retired = (): string[] => fs.readdirSync(userDir).filter((f) => f.startsWith(`${KEY_CACHE_FILE}.retired-`))
/** The own log: the active shard and every rotated generation. */
const ownFiles = (): string[] => fs.readdirSync(userDir).filter((f) => /^swarm-memory(\.\d+)?\.jsonl$/.test(f)).map((f) => path.join(userDir, f))
const linesOf = (f: string): string[] => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
const snapshot = (files: string[]): Map<string, Buffer> => new Map(files.map((f) => [f, fs.readFileSync(f)]))
const unchanged = (before: Map<string, Buffer>): boolean => [...before].every(([f, b]) => fs.readFileSync(f).equals(b))

let n = 0
const entry = (content: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: `seed-${++n}`, ts: Date.now() - 100_000 + n, agentId: 'a', kind: 'fact', content, hash: `h-${n}`, ...extra })
/** Lines encrypted under `key`, each a distinct memory. */
const under = (key: Buffer, count: number, label: string): string[] =>
  Array.from({ length: count }, (_, i) => encryptLine(key, entry(`${label} ${i}`)))
const lay = (file: string, lines: string[]): void => fs.writeFileSync(file, lines.join('\n') + '\n')

const relaunch = (opts: Parameters<typeof initSwarmMemory>[1] = {}): void => {
  _resetForTests()
  _setEmbeddingsAvailable(false)
  initSwarmMemory(userDir, opts)
}

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-keylock-u-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-keylock-s-'))
  _resetForTests()
  _setEmbeddingsAvailable(false)
  setSafeStorage(null)
  failIO.openSync = null
  failIO.renameSync = null
  readBack.shortRead = null
  tele.recordSwarmError.mockClear()
})
afterEach(() => {
  _resetForTests()
  setSafeStorage(null)
  for (const d of [userDir, syncDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

describe('inspectMemoryKey — the four states of a key file', () => {
  it('absent, usable, wrong-length, and wrapped-but-unopenable are all told apart', () => {
    expect(inspectMemoryKey(keyFile())).toEqual({ key: null, absent: true, problem: null })

    setSafeStorage(fakeSafe)
    fs.writeFileSync(keyFile(), wrap(K1))
    expect(inspectMemoryKey(keyFile())).toEqual({ key: K1, absent: false, problem: null })

    fs.writeFileSync(keyFile(), wrap(Buffer.alloc(16)))
    expect(inspectMemoryKey(keyFile())).toEqual({ key: null, absent: false, problem: 'key-invalid' })

    fs.writeFileSync(keyFile(), wrap(K1))
    setSafeStorage(null)
    expect(inspectMemoryKey(keyFile())).toEqual({ key: null, absent: false, problem: 'keychain-unavailable' })

    setSafeStorage({ ...fakeSafe, decryptString: () => { throw new Error('refused') } })
    expect(inspectMemoryKey(keyFile())).toEqual({ key: null, absent: false, problem: 'key-unreadable' })
  })

  it('a legacy PLAINTEXT key file (written before the keychain existed) still works', () => {
    fs.writeFileSync(keyFile(), K1.toString('base64'))
    expect(inspectMemoryKey(keyFile()).key?.equals(K1)).toBe(true)
  })
})

describe('LOCKED — every writer refuses, and not one byte moves (Decision 2)', () => {
  /** A brain from a previous launch: encrypted log, an archived memory, and a plaintext tail line
   *  with a vector (so the hot window has something even while locked). */
  function seedBrain(): void {
    lay(logFile(), [
      ...under(K1, 3, 'old memory'),
      entry('a plaintext memory with a vector', { emb: encodeEmbedding(unit(1)) }),
    ])
    fs.writeFileSync(archiveFile(), encryptLine(K1, entry('archived memory')) + '\n')
  }

  it('a key-file problem main reports locks the store with that reason', async () => {
    seedBrain()
    relaunch({ encKey: null, keyProblem: 'key-unreadable' })
    expect(getSyncStatus()).toMatchObject({ ownLocked: true, lockReason: 'key-unreadable', encrypted: false })
    const before = snapshot([logFile(), archiveFile()])
    const ref = { file: 'src/a.ts' } as CodeRef

    await expect(memoryWrite({ agentId: 'a', kind: 'fact', content: 'refused' })).rejects.toThrow(/Memory is locked \(key-unreadable\): this computer couldn't unwrap its memory key/)
    expect(() => memoryDelete('seed-1')).toThrow(/Memory is locked/)
    expect(() => memoryArchive('seed-1')).toThrow(/Memory is locked/)
    expect(() => memoryClear()).toThrow(/Memory is locked/)
    expect(() => memoryFeedback({ id: 'seed-1', helpful: true })).toThrow(/Memory is locked/)
    expect(() => memoryPatchProjects([{ hash: 'h-1', project: '/repo' }])).toThrow(/Memory is locked/)
    expect(() => memoryPruneCodePath('src/a.ts')).toThrow(/Memory is locked/)
    expect(() => backfillCodeRefs('seed-1', [ref])).toThrow(/Memory is locked/)
    expect(() => importMemorySnapshot([entry('imported')])).toThrow(/Memory is locked/)
    expect(() => enableLocalEncryption()).toThrow(/Memory is locked/)
    expect(() => disableEncryption()).toThrow(/Memory is locked/)
    expect(() => adoptEncryptionKey(K2)).toThrow(/Memory is locked/)
    expect(compactSelfShard({ force: true }).compacted).toBe(false)

    expect(unchanged(before)).toBe(true)
    expect(fs.existsSync(keyFile())).toBe(false)
    expect(retired()).toEqual([])
  })

  it('a locked store reads what it can, but never persists a search graph built over that partial view', async () => {
    seedBrain()
    relaunch({ encKey: null, keyProblem: 'keychain-unavailable' })
    _setHnswThresholdForTests(1)
    _setEmbedFnForTests(async () => unit(1))
    expect(contents()).toEqual(['a plaintext memory with a vector'])
    await memorySearch({ query: 'anything' }) // builds the HNSW graph over the one readable vector
    persistMemoryIndex()
    expect(fs.existsSync(path.join(userDir, 'memory-hnsw.json'))).toBe(false)
  })

  it('a reload while locked replicates no tombstones into the own shard (the append backstop)', async () => {
    // v1 sync: our shard is encrypted under a passphrase key this launch doesn't have. A peer's delete
    // would normally be replicated into our shard on reload — through the one append path no public
    // writer guards, which is exactly why appendShardLine refuses on its own.
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'mine' })
    setSyncPassphrase('a passphrase')
    relaunch({ syncDir })
    expect(getSyncStatus()).toMatchObject({ ownLocked: true, lockReason: 'key-mismatch' })
    const own = path.join(syncDir, fs.readdirSync(syncDir).find((f) => /^[0-9a-f]{16}\.jsonl$/.test(f)) as string)
    const before = fs.readFileSync(own)
    fs.writeFileSync(path.join(syncDir, 'peer.jsonl'), JSON.stringify({ deleted: 'some-id' }) + '\n')
    reloadMemoryFromSync()
    expect(fs.readFileSync(own).equals(before)).toBe(true)
  })

  it('a store whose key comes back unlocks on the next launch by itself — nothing to click', () => {
    seedBrain()
    relaunch({ encKey: null, keyProblem: 'keychain-unavailable' })
    expect(getSyncStatus().ownLocked).toBe(true)
    relaunch({ encKey: K1 })
    expect(getSyncStatus()).toMatchObject({ ownLocked: false, encrypted: true })
    expect(contents()).toEqual(['a plaintext memory with a vector', 'old memory 0', 'old memory 1', 'old memory 2'])
  })
})

describe('key-mismatch — the newest encrypted lines decide (Decision 2)', () => {
  it('a log no key opens is LOCKED; the right key in the ring opens all of it', () => {
    lay(logFile(), under(K1, 40, 'k1'))
    relaunch({ encKey: K2 })
    expect(getSyncStatus()).toMatchObject({ ownLocked: true, lockReason: 'key-mismatch' })
    relaunch({ encKey: K2, readKeys: [K1] })
    expect(getSyncStatus().ownLocked).toBe(false)
    expect(memoryCount()).toBe(40)
  })

  it('older lines under a lost key do not lock a log whose newest lines open', () => {
    lay(logFile(), [...under(K2, 5, 'lost'), ...under(K1, 40, 'current')])
    relaunch({ encKey: K1 })
    expect(getSyncStatus()).toMatchObject({ ownLocked: false, locked: true }) // the 5 are dark, and say so
    expect(memoryCount()).toBe(40)
    relaunch({ encKey: K2 })
    expect(getSyncStatus().ownLocked).toBe(true) // ...but the key that only opens OLD lines is not the key in force
  })

  it('one line that opens among the newest 32 is enough — and 32 that do not are not', () => {
    lay(logFile(), [...under(K1, 33, 'k1'), ...under(K2, 31, 'k2')])
    relaunch({ encKey: K1 })
    expect(getSyncStatus().ownLocked).toBe(false) // the 32nd-newest line is a K1 line
    lay(logFile(), [...under(K1, 33, 'k1'), ...under(K2, 32, 'k2')])
    relaunch({ encKey: K1 })
    expect(getSyncStatus().ownLocked).toBe(true) // all 32 newest are K2
  })

  it('the active shard is the NEWEST part of a rotated log, whatever order the files are listed in', () => {
    lay(genFile(1), under(K1, 40, 'gen'))
    lay(logFile(), under(K2, 2, 'active'))
    relaunch({ encKey: K1 })
    expect(getSyncStatus().ownLocked).toBe(false) // 2 K2 + 30 K1 in the newest 32
    lay(logFile(), under(K2, 40, 'active'))
    relaunch({ encKey: K1 })
    expect(getSyncStatus().ownLocked).toBe(true) // the newest 32 are all in the active shard, all K2
  })

  it('a plaintext log has nothing to mismatch', () => {
    lay(logFile(), [entry('plain one'), entry('plain two')])
    relaunch()
    expect(getSyncStatus()).toMatchObject({ ownLocked: false, encrypted: false })
  })

  it('a user who turned encryption OFF is not locked by ciphertext the old build left behind', () => {
    // Before this release, disabling encryption decrypted only the active file and deleted the key:
    // rotated generations stayed ciphertext under a key that no longer exists. They are lost either
    // way; locking would only stop the plaintext store the user chose from saving anything.
    lay(genFile(1), under(K1, 5, 'orphaned'))
    lay(logFile(), [entry('chosen plaintext')])
    fs.writeFileSync(path.join(userDir, ENCRYPTION_OPTOUT_FILE), '1')
    relaunch()
    expect(getSyncStatus()).toMatchObject({ ownLocked: false, locked: true })
  })

  it('a generation the OS will not hand over says nothing about the key', () => {
    lay(genFile(1), under(K1, 5, 'unreadable'))
    lay(logFile(), under(K2, 3, 'readable'))
    failIO.openSync = (p) => p === genFile(1)
    relaunch({ encKey: K2 })
    failIO.openSync = null
    expect(getSyncStatus()).toMatchObject({ ownLocked: false, unreadableShards: 1 })
  })
})

describe('the read ring', () => {
  it('lines under a retired key read; new lines are written under the key in force, never a ring key', async () => {
    lay(logFile(), under(K1, 2, 'under k1'))
    relaunch({ encKey: K2, readKeys: [K1, K1, Buffer.alloc(8)] }) // duplicates and junk are dropped
    expect(contents()).toEqual(['under k1 0', 'under k1 1'])
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'new line' })
    const last = linesOf(logFile()).pop() as string
    expect(decryptLine(K2, last)).toContain('new line')
    expect(decryptLine(K1, last)).toBeNull()
  })

  it('in-process, retired key files on disk join the ring by themselves', () => {
    setSafeStorage(fakeSafe)
    fs.writeFileSync(keyFile(), wrap(K2))
    fs.writeFileSync(`${keyFile()}.retired-100`, wrap(K1))
    lay(logFile(), [...under(K1, 2, 'old'), ...under(K2, 2, 'new')])
    relaunch()
    expect(getSyncStatus()).toMatchObject({ ownLocked: false, encrypted: true, locked: false })
    expect(memoryCount()).toBe(4)
  })

  it('the archive reads through the ring, and skips what no key opens', () => {
    fs.writeFileSync(archiveFile(), [
      encryptLine(K1, entry('archived under the old key')),
      encryptLine(K3, entry('archived under a key nobody has')),
      entry('archived in plaintext'),
    ].join('\n') + '\n')
    lay(logFile(), [])
    relaunch({ encKey: K2, readKeys: [K1] })
    expect(searchArchive('archived', 10).map((e) => e.content).sort()).toEqual(['archived in plaintext', 'archived under the old key'])
  })
})

describe('re-inits keep the session key (Decision 3)', () => {
  it('a re-init with no key reuses the injected one; a different data dir does not inherit it', async () => {
    relaunch({ encKey: K1 })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'secret' })
    initSwarmMemory(userDir) // what setVectorQuantization / setSyncDir used to do — key-less
    expect(getSyncStatus()).toMatchObject({ encrypted: true, ownLocked: false })
    expect(contents()).toEqual(['secret'])

    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-keylock-other-'))
    try {
      initSwarmMemory(other)
      expect(getSyncStatus().encrypted).toBe(false)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('int8 ON re-packs in place: no reload, same rows, same results, the log untouched', async () => {
    relaunch({ encKey: K1 })
    _setEmbedFnForTests(async (t: string) => unit(t.includes('cat') ? 3 : 7))
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'the cat sat' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'dogs bark' })
    const first = memoryList()[0]
    const bytes = fs.readFileSync(logFile())
    setVectorQuantization(true)
    expect(_isVectorStoreQuantizedForTests()).toBe(true)
    expect(_vectorStoreSizeForTests()).toBe(2)
    expect(memoryList()[0]).toBe(first) // the very same objects: nothing was reloaded
    expect(fs.readFileSync(logFile()).equals(bytes)).toBe(true)
    expect((await memorySearch({ query: 'a cat', limit: 1 }))[0].content).toBe('the cat sat')
  })

  it('int8 OFF reloads the exact floats WITH the key; an unchanged mode does nothing at all', async () => {
    relaunch({ encKey: K1 })
    _setEmbedFnForTests(async () => unit(5))
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'exact again' })
    setVectorQuantization(true)
    const first = memoryList()[0]
    setVectorQuantization(true) // no change → no work
    expect(memoryList()[0]).toBe(first)
    setVectorQuantization(false)
    expect(_isVectorStoreQuantizedForTests()).toBe(false)
    expect(memoryList()[0]).not.toBe(first) // reloaded from disk...
    expect(getSyncStatus()).toMatchObject({ encrypted: true, ownLocked: false, count: 1 }) // ...with the key
    expect(_vectorStoreSizeForTests()).toBe(1)
  })

  it('before the store exists, the toggle is only a flag the first init honours', () => {
    setVectorQuantization(true)
    relaunch()
    // relaunch() resets every flag, so set it again the way the host does: before init.
    _resetForTests()
    setVectorQuantization(true)
    initSwarmMemory(userDir)
    expect(_isVectorStoreQuantizedForTests()).toBe(true)
  })

  it('setSyncDir(null) while sync is off does not reload, rewrite, or even write the config', () => {
    relaunch({ encKey: K1 })
    lay(logFile(), under(K1, 1, 'still here'))
    const first = memoryList()[0]
    expect(setSyncDir(null)).toMatchObject({ syncing: false })
    expect(memoryList()[0]).toBe(first)
    expect(fs.existsSync(path.join(userDir, 'memory-sync.json'))).toBe(false)
  })
})

describe('the encryption rewrite covers the WHOLE own set and the archive (Decision 4)', () => {
  /** An auto-encrypted local store big enough to have rotated, with two memories archived. */
  async function rotatedEncryptedStore(): Promise<string[]> {
    setSafeStorage(fakeSafe)
    relaunch()
    expect(getSyncStatus().encrypted).toBe(true)
    _setMaxShardBytesForTests(900)
    const ids: string[] = []
    for (let i = 0; i < 14; i++) ids.push((await memoryWrite({ agentId: 'a', kind: 'fact', content: `rotated memory ${i}` })).id)
    memoryArchive(ids[0])
    memoryArchive(ids[1])
    expect(ownFiles().length).toBeGreaterThan(2)
    for (const f of [...ownFiles(), archiveFile()]) expect(linesOf(f).every((l) => l.startsWith('enc:v1:'))).toBe(true)
    return ids
  }

  it('disable decrypts every generation AND the archive, then retires the key byte-for-byte — never deletes it', async () => {
    await rotatedEncryptedStore()
    const keyBytes = fs.readFileSync(keyFile())
    const st = disableEncryption()
    expect(st).toMatchObject({ encrypted: false, ownLocked: false, count: 12 })
    for (const f of [...ownFiles(), archiveFile()]) expect(linesOf(f).some((l) => l.startsWith('enc:v1:'))).toBe(false)
    expect(fs.existsSync(keyFile())).toBe(false)
    expect(retired()).toHaveLength(1)
    expect(fs.readFileSync(path.join(userDir, retired()[0])).equals(keyBytes)).toBe(true)
    expect(fs.existsSync(path.join(userDir, ENCRYPTION_OPTOUT_FILE))).toBe(true)
    expect(searchArchive('rotated memory', 10)).toHaveLength(2)

    // A new launch needs no key at all for any of it.
    setSafeStorage(null)
    relaunch()
    expect(getSyncStatus()).toMatchObject({ encrypted: false, ownLocked: false, locked: false, count: 12 })
  })

  it('enable encrypts every generation AND the archive, and everything still reads', async () => {
    setSafeStorage(null)
    relaunch()
    _setMaxShardBytesForTests(700)
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push((await memoryWrite({ agentId: 'a', kind: 'fact', content: `plain memory ${i}` })).id)
    memoryArchive(ids[0])
    expect(ownFiles().length).toBeGreaterThan(2)

    setSafeStorage(fakeSafe)
    expect(enableLocalEncryption()).toMatchObject({ encrypted: true, ownLocked: false, count: 11 })
    for (const f of [...ownFiles(), archiveFile()]) expect(linesOf(f).every((l) => l.startsWith('enc:v1:'))).toBe(true)
    expect(searchArchive('plain memory', 5).map((e) => e.content)).toEqual(['plain memory 0'])
    relaunch()
    expect(getSyncStatus()).toMatchObject({ encrypted: true, ownLocked: false, count: 11 })
  })

  it('a file that cannot be staged aborts the whole rewrite: every byte, the key, and the status are as they were', async () => {
    await rotatedEncryptedStore()
    const files = [...ownFiles(), archiveFile()]
    const before = snapshot([...files, keyFile()])
    fs.mkdirSync(genFile(2) + '.rekey.tmp') // the temp for one generation can't be created
    expect(() => disableEncryption()).toThrow()
    fs.rmSync(genFile(2) + '.rekey.tmp', { recursive: true, force: true })
    expect(unchanged(before)).toBe(true)
    expect(retired()).toEqual([])
    expect(fs.readdirSync(userDir).filter((f) => f.endsWith('.rekey.tmp'))).toEqual([])
    expect(getSyncStatus()).toMatchObject({ encrypted: true, count: 12 })
    expect(fs.existsSync(path.join(userDir, ENCRYPTION_OPTOUT_FILE))).toBe(false)
  })

  it('a staged file that does not read back as written aborts too — before anything is swapped', async () => {
    await rotatedEncryptedStore()
    const before = snapshot([...ownFiles(), archiveFile(), keyFile()])
    readBack.shortRead = (f) => f.endsWith('.rekey.tmp')
    expect(() => disableEncryption()).toThrow(/did not read back as written/)
    readBack.shortRead = null
    expect(unchanged(before)).toBe(true)
    expect(retired()).toEqual([])
    expect(fs.readdirSync(userDir).filter((f) => f.endsWith('.rekey.tmp'))).toEqual([])
  })

  it('a swap Windows refuses once goes through the move-aside path and completes', async () => {
    await rotatedEncryptedStore()
    const refusedOnce = new Set<string>()
    failIO.renameSync = (from) => {
      if (!from.endsWith('.rekey.tmp') || refusedOnce.has(from)) return false
      refusedOnce.add(from)
      return true
    }
    expect(disableEncryption().encrypted).toBe(false)
    failIO.renameSync = null
    expect(refusedOnce.size).toBeGreaterThan(2)
    expect(fs.readdirSync(userDir).filter((f) => f.endsWith('.replaced') || f.endsWith('.rekey.tmp'))).toEqual([])
    for (const f of [...ownFiles(), archiveFile()]) expect(linesOf(f).some((l) => l.startsWith('enc:v1:'))).toBe(false)
  })

  it('a swap that cannot complete puts the original back, leaves no temp behind, and keeps the key', async () => {
    await rotatedEncryptedStore()
    const victim = genFile(2)
    failIO.renameSync = (from, to) => from === victim + '.rekey.tmp' && to === victim
    expect(() => disableEncryption()).toThrow(/EBUSY/)
    failIO.renameSync = null
    expect(fs.existsSync(victim)).toBe(true)
    expect(fs.readdirSync(userDir).filter((f) => f.endsWith('.replaced') || f.endsWith('.rekey.tmp'))).toEqual([])
    expect(fs.existsSync(keyFile())).toBe(true) // never retired: the rewrite did not finish
    expect(retired()).toEqual([])
    // Some files are plaintext now and some still ciphertext — and the key in force reads both.
    relaunch()
    expect(getSyncStatus()).toMatchObject({ encrypted: true, ownLocked: false, count: 12 })
  })

  it('a torn line and a line under a key nobody holds are copied through byte for byte, both ways', () => {
    const foreign = encryptLine(K3, entry('nobody can read this'))
    lay(logFile(), [entry('readable plaintext'), '{"torn":', foreign, encryptLine(K1, entry('under the key'))])
    relaunch({ encKey: K1 })
    adoptEncryptionKey(K1) // the one-time "ciphertext-ify" a freshly minted key does
    let raw = linesOf(logFile())
    expect(raw).toContain('{"torn":')
    expect(raw).toContain(foreign)
    expect(raw.filter((l) => l.startsWith('enc:v1:'))).toHaveLength(3) // two re-encoded, the foreign one as it was
    disableEncryption()
    raw = linesOf(logFile())
    expect(raw).toContain('{"torn":')
    expect(raw).toContain(foreign)
    expect(raw.filter((l) => l.startsWith('enc:v1:'))).toEqual([foreign])
    expect(contents()).toEqual(['readable plaintext', 'under the key'])
  })

  it('a passphrase whose rewrite fails changes nothing, and the passphrase key never becomes the key in force', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'synced plaintext' })
    const own = path.join(syncDir, fs.readdirSync(syncDir).find((f) => f.endsWith('.jsonl')) as string)
    const before = fs.readFileSync(own)
    fs.mkdirSync(own + '.rekey.tmp')
    expect(() => setSyncPassphrase('pw')).toThrow()
    fs.rmSync(own + '.rekey.tmp', { recursive: true, force: true })
    expect(fs.readFileSync(own).equals(before)).toBe(true)
    expect(getSyncStatus().encrypted).toBe(false)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'still plaintext' })
    expect(fs.readFileSync(own, 'utf8')).toContain('still plaintext')
  })

  it('adopting a key whose rewrite fails reports it and throws — with the new key in force, nothing lost', () => {
    // adopt runs after main has already written the key file, so the key stays in force either way:
    // new lines are ciphertext, and the plaintext the rewrite didn't reach is still plaintext.
    const plain = entry('plain before adopt')
    lay(logFile(), [plain])
    relaunch()
    fs.mkdirSync(logFile() + '.rekey.tmp')
    expect(() => adoptEncryptionKey(K1)).toThrow()
    fs.rmSync(logFile() + '.rekey.tmp', { recursive: true, force: true })
    expect(tele.recordSwarmError).toHaveBeenCalledWith('swarmMemory.adoptKey.rewriteFailed', expect.anything(), expect.anything())
    expect(getSyncStatus().encrypted).toBe(true)
    expect(linesOf(logFile())).toEqual([plain]) // untouched, and still readable
    expect(contents()).toEqual(['plain before adopt'])
  })

  it('a multi-megabyte log is streamed through in chunks and still reads back exactly', () => {
    const big = 'x'.repeat(4096)
    lay(logFile(), Array.from({ length: 1100 }, (_, i) => entry(`bulk ${i} ${big}`)))
    expect(fs.statSync(logFile()).size).toBeGreaterThan(4 * 1024 * 1024)
    setSafeStorage(fakeSafe)
    relaunch() // auto-encrypt mints and rewrites the whole thing
    expect(getSyncStatus()).toMatchObject({ encrypted: true, count: 1100 })
    expect(linesOf(logFile()).every((l) => l.startsWith('enc:v1:'))).toBe(true)
  })

  it('disableSyncEncryption with nothing encrypted does nothing to any file', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'never encrypted' })
    const own = path.join(syncDir, fs.readdirSync(syncDir).find((f) => f.endsWith('.jsonl')) as string)
    const before = fs.readFileSync(own)
    expect(disableSyncEncryption().encrypted).toBe(false)
    expect(fs.readFileSync(own).equals(before)).toBe(true)
  })
})

describe('startNewMemoryKey — the store side of the way out (Decision 1)', () => {
  it('needs an initialised store and a real 32-byte key', () => {
    expect(() => startNewMemoryKey(K1)).toThrow(/not initialised/)
    relaunch()
    expect(() => startNewMemoryKey(Buffer.alloc(8))).toThrow(/32-byte/)
    expect(() => startNewMemoryKey(null as unknown as Buffer)).toThrow(/key required/)
  })

  it('unlocks, keeps every old key readable, and appends ONE encrypted key-epoch marker', async () => {
    lay(logFile(), under(K1, 3, 'before'))
    fs.writeFileSync(path.join(userDir, ENCRYPTION_OPTOUT_FILE), '1')
    relaunch({ encKey: K2, readKeys: [K3] }) // key-mismatch: neither opens the log
    expect(getSyncStatus().ownLocked).toBe(true)
    const before = fs.readFileSync(logFile())

    const st = startNewMemoryKey(K3, [K1, K2]) // K1 now opens again; K2 (the key in force) is kept too
    expect(st).toMatchObject({ ownLocked: false, lockReason: null, encrypted: true, count: 0 })
    const now = fs.readFileSync(logFile())
    expect(now.subarray(0, before.length).equals(before)).toBe(true)
    const marker = now.toString('utf8').slice(before.length).trim()
    expect(JSON.parse(decryptLine(K3, marker) as string)).toEqual({ keyEpoch: expect.any(Number) })
    expect(fs.existsSync(path.join(userDir, ENCRYPTION_OPTOUT_FILE))).toBe(false)

    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'after' })
    reloadFromDiskSameSession()
    expect(contents()).toEqual(['after', 'before 0', 'before 1', 'before 2'])
    expect(getSyncStatus().ownLocked).toBe(false)
  })

  it('a log that cannot take the marker refuses the new key and stays exactly as it was', () => {
    lay(logFile(), under(K1, 3, 'before'))
    relaunch({ encKey: K2 })
    const before = fs.readFileSync(logFile())
    failIO.openSync = (p, flags) => p === logFile() && flags === 'a'
    expect(() => startNewMemoryKey(K3)).toThrow(/new key was not started/)
    failIO.openSync = null
    expect(getSyncStatus()).toMatchObject({ ownLocked: true, lockReason: 'key-mismatch' })
    expect(fs.readFileSync(logFile()).equals(before)).toBe(true)
  })
})

/** Reload from disk inside the same session (what a sync reload or compaction does), keeping its keys. */
function reloadFromDiskSameSession(): void {
  initSwarmMemory(userDir)
}
