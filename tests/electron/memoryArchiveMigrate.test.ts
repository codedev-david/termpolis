// An archive written before v1.53 holds plaintext lines even under an encrypted store. Deep recall
// (searchArchive) re-encodes it under the key in force, once (swarmMemory.migratePlaintextArchive).
//
// Load-bearing:
//   * every readable line ends up encrypted, and every memory is still found;
//   * a line's text is encrypted as it stands: integers past 2^53 survive byte for byte;
//   * a line under a key this session doesn't hold is copied through untouched;
//   * a locked store (key-mismatch, key problem) or one with no key is left exactly as it is;
//   * a temp file that doesn't read back, or a swap that fails, leaves the original untouched,
//     removes the temp and records the failure;
//   * it happens once: the next search neither re-reads nor re-encodes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const tele = vi.hoisted(() => ({ recordSwarmError: vi.fn() }))
vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: tele.recordSwarmError }))

const failIO = vi.hoisted(() => ({
  renameSync: null as null | ((from: string, to: string) => boolean),
  rmSync: null as null | ((p: string) => boolean),
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const api = {
    ...actual,
    renameSync: (...args: unknown[]): void => {
      if (typeof args[0] === 'string' && typeof args[1] === 'string' && failIO.renameSync?.(args[0], args[1])) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      ;(actual.renameSync as (...a: unknown[]) => void)(...args)
    },
    rmSync: (...args: unknown[]): void => {
      if (typeof args[0] === 'string' && failIO.rmSync?.(args[0])) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      ;(actual.rmSync as (...a: unknown[]) => void)(...args)
    },
  }
  return { ...api, default: api }
})

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
  initSwarmMemory, searchArchive, getSyncStatus, _resetForTests, _setEmbeddingsAvailable, _archiveMigrationsForTests,
} from '../../src/main/swarmMemory'
import { encryptLine, decryptLine } from '../../src/main/memoryCrypto'

const K1 = Buffer.alloc(32, 0x11)
const K2 = Buffer.alloc(32, 0x22)

let userDir: string
const archiveFile = (): string => path.join(userDir, 'swarm-memory.archive.jsonl')
const logFile = (): string => path.join(userDir, 'swarm-memory.jsonl')
const linesOf = (f: string): string[] => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
const lay = (file: string, lines: string[]): void => fs.writeFileSync(file, lines.join('\n') + '\n')
let n = 0
const entry = (content: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: `arch-${++n}`, ts: Date.now() - 100_000 + n, agentId: 'a', kind: 'fact', content, hash: `h-${n}`, ...extra })
const relaunch = (opts: Parameters<typeof initSwarmMemory>[1] = {}): void => {
  _resetForTests()
  _setEmbeddingsAvailable(false)
  initSwarmMemory(userDir, opts)
}
const failures = (): unknown[] => tele.recordSwarmError.mock.calls.filter((c) => c[0] === 'swarmMemory.archive.migrateFailed')

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-archmig-'))
  _resetForTests()
  _setEmbeddingsAvailable(false)
  failIO.renameSync = null
  failIO.rmSync = null
  readBack.shortRead = null
  tele.recordSwarmError.mockClear()
})
afterEach(() => {
  _resetForTests()
  try { fs.rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('deep recall re-encodes a plaintext archive under the key in force', () => {
  it('every line ends up encrypted, every memory is still found, and a big integer survives byte for byte', () => {
    const big = '{"id":"arch-big","ts":1,"agentId":"a","kind":"fact","content":"zebra ledger","hash":"h-big","n":12345678901234567890123}'
    const plain = entry('zebra plaintext one')
    lay(archiveFile(), [plain, big, encryptLine(K1, entry('zebra already sealed'))])
    relaunch({ encKey: K1 })

    expect(searchArchive('zebra', 10).map((e) => e.content).sort()).toEqual(['zebra already sealed', 'zebra ledger', 'zebra plaintext one'])
    expect(_archiveMigrationsForTests()).toBe(1)
    const after = linesOf(archiveFile())
    expect(after).toHaveLength(3)
    expect(after.every((l) => l.startsWith('enc:v1:'))).toBe(true)
    const opened = after.map((l) => decryptLine(K1, l))
    expect(opened[0]).toBe(plain)
    expect(opened[1]).toBe(big) // never parsed and re-serialised: the 23-digit integer is intact
    expect(fs.existsSync(archiveFile() + '.rekey.tmp')).toBe(false)
    expect(failures()).toHaveLength(0)
  })

  it('a line under a key this session does not hold is copied through untouched', () => {
    const foreign = encryptLine(K2, entry('zebra under another key'))
    lay(archiveFile(), [entry('zebra plain'), foreign])
    relaunch({ encKey: K1 })

    expect(searchArchive('zebra', 10).map((e) => e.content)).toEqual(['zebra plain'])
    const after = linesOf(archiveFile())
    expect(after[1]).toBe(foreign)
    expect(decryptLine(K1, after[0])).not.toBeNull()
  })

  it('happens once: the next search neither re-reads nor re-encodes', () => {
    lay(archiveFile(), [entry('zebra once')])
    relaunch({ encKey: K1 })
    expect(searchArchive('zebra')).toHaveLength(1)
    const sealed = fs.readFileSync(archiveFile())
    expect(searchArchive('zebra')).toHaveLength(1)
    expect(_archiveMigrationsForTests()).toBe(1)
    expect(fs.readFileSync(archiveFile()).equals(sealed)).toBe(true)
  })

  it('an all-encrypted archive is never rewritten', () => {
    lay(archiveFile(), [encryptLine(K1, entry('zebra sealed'))])
    const before = fs.readFileSync(archiveFile())
    relaunch({ encKey: K1 })
    expect(searchArchive('zebra')).toHaveLength(1)
    expect(_archiveMigrationsForTests()).toBe(0)
    expect(fs.readFileSync(archiveFile()).equals(before)).toBe(true)
  })
})

describe('what is never touched', () => {
  it('a store with no key (encryption off) keeps its plaintext archive', () => {
    lay(archiveFile(), [entry('zebra open')])
    const before = fs.readFileSync(archiveFile())
    relaunch({ encKey: null })
    expect(searchArchive('zebra')).toHaveLength(1)
    expect(_archiveMigrationsForTests()).toBe(0)
    expect(fs.readFileSync(archiveFile()).equals(before)).toBe(true)
  })

  it('a store locked by a key-file problem is left exactly as it is', () => {
    lay(archiveFile(), [entry('zebra locked')])
    const before = fs.readFileSync(archiveFile())
    relaunch({ encKey: null, keyProblem: 'key-unreadable' })
    expect(searchArchive('zebra')).toHaveLength(1)
    expect(fs.readFileSync(archiveFile()).equals(before)).toBe(true)
    expect(_archiveMigrationsForTests()).toBe(0)
  })

  it('a store locked by a key mismatch is left exactly as it is, even with a key in force', () => {
    // The own log's newest encrypted lines are under K2 while the session holds K1: key-mismatch.
    lay(logFile(), [encryptLine(K2, entry('own under K2'))])
    lay(archiveFile(), [entry('zebra mismatch')])
    const before = fs.readFileSync(archiveFile())
    relaunch({ encKey: K1 })
    expect(getSyncStatus()).toMatchObject({ ownLocked: true, lockReason: 'key-mismatch' })
    expect(searchArchive('zebra')).toHaveLength(1)
    expect(fs.readFileSync(archiveFile()).equals(before)).toBe(true)
    expect(_archiveMigrationsForTests()).toBe(0)
  })
})

describe('a failed re-encode loses nothing', () => {
  it('a temp file that does not read back as written: original untouched, temp removed, failure recorded', () => {
    lay(archiveFile(), [entry('zebra a'), entry('zebra b')])
    const before = fs.readFileSync(archiveFile())
    relaunch({ encKey: K1 })
    readBack.shortRead = (f) => f.endsWith('.rekey.tmp')
    expect(searchArchive('zebra')).toHaveLength(2)
    expect(fs.readFileSync(archiveFile()).equals(before)).toBe(true)
    expect(fs.existsSync(archiveFile() + '.rekey.tmp')).toBe(false)
    expect(failures()).toHaveLength(1)
    expect(_archiveMigrationsForTests()).toBe(0)
  })

  it('a swap that cannot complete: original untouched, temp removed, failure recorded', () => {
    lay(archiveFile(), [entry('zebra held')])
    const before = fs.readFileSync(archiveFile())
    relaunch({ encKey: K1 })
    failIO.renameSync = (from) => from.endsWith('.rekey.tmp')
    expect(searchArchive('zebra')).toHaveLength(1)
    expect(fs.readFileSync(archiveFile()).equals(before)).toBe(true)
    expect(fs.existsSync(archiveFile() + '.rekey.tmp')).toBe(false)
    expect(fs.existsSync(archiveFile() + '.replaced')).toBe(false)
    expect(failures()).toHaveLength(1)
  })

  it('a temp that cannot even be removed still records the failure', () => {
    lay(archiveFile(), [entry('zebra stuck')])
    relaunch({ encKey: K1 })
    readBack.shortRead = (f) => f.endsWith('.rekey.tmp')
    failIO.rmSync = (f) => f.endsWith('.rekey.tmp')
    expect(searchArchive('zebra')).toHaveLength(1)
    expect(failures()).toHaveLength(1)
    failIO.rmSync = null
  })
})
