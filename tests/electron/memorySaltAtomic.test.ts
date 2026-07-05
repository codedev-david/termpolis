// F4 / F11 / F7 / F33 — encryption-salt integrity + atomic whole-shard rewrites.
//  F4  loadOrCreateSalt must NEVER overwrite an existing salt on a transient read/parse
//      failure — doing so re-derives a different key and locks out all encrypted memory.
//  F11 the salt is authoritative + write-once: a device adopts an existing (peer) salt
//      instead of minting its own (same passphrase must yield the same key everywhere).
//  F7/F33 rewriteSelfShard (encryption toggle) + local clear must be ATOMIC (temp+rename)
//      so an interrupted/failed rewrite can never truncate or half-write the shard.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  setSyncPassphrase,
  _resetForTests,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'

let userDir: string
let syncDir: string
const SALT = '.termpolis-salt'
const selfShard = (): string => path.join(syncDir, fs.readdirSync(syncDir).find((f) => /^[0-9a-f]{16}\.jsonl$/.test(f))!)

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-salt-user-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-salt-sync-'))
  _resetForTests()
  _setEmbedFnForTests(async () => null)
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  for (const d of [userDir, syncDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

describe('F4: an existing salt is never overwritten on a read/parse failure', () => {
  it('surfaces an error instead of minting a replacement salt', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'x' })
    setSyncPassphrase('pw') // creates a valid salt
    const saltFile = path.join(syncDir, SALT)
    const corrupt = Buffer.from('short').toString('base64') // decodes to 5 bytes (!= 16)
    fs.writeFileSync(saltFile, corrupt)
    expect(() => setSyncPassphrase('pw')).toThrow()
    // The corrupt salt file is untouched — NOT re-minted over (which would orphan all ciphertext).
    expect(fs.readFileSync(saltFile, 'utf8')).toBe(corrupt)
  })
})

describe('F11: the salt is authoritative and write-once', () => {
  it('adopts an existing (peer-created) salt rather than overwriting it', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'x' })
    const peerSalt = Buffer.alloc(16, 7).toString('base64')
    fs.writeFileSync(path.join(syncDir, SALT), peerSalt)
    setSyncPassphrase('pw')
    expect(fs.readFileSync(path.join(syncDir, SALT), 'utf8')).toBe(peerSalt) // adopted, not clobbered
  })
})

describe('F7/F33: whole-shard rewrites are atomic', () => {
  it('leaves no temp file and preserves data after a successful encryption toggle', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'atomic-secret' })
    setSyncPassphrase('pw')
    const shard = selfShard()
    expect(fs.existsSync(shard + '.tmp')).toBe(false)
    expect(fs.readFileSync(shard, 'utf8')).toContain('enc:v1:')
    expect(memoryList().some((e) => e.content === 'atomic-secret')).toBe(true)
  })

  it('keeps the original shard intact when the atomic rewrite cannot complete', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'must-survive-failed-rewrite' })
    const shard = selfShard()
    const before = fs.readFileSync(shard, 'utf8')
    // Block the temp path so the atomic write fails at openSync('w') — original must be untouched.
    fs.mkdirSync(shard + '.tmp')
    setSyncPassphrase('pw') // rewrite fails internally; must NOT truncate the real shard
    expect(fs.readFileSync(shard, 'utf8')).toBe(before)
    fs.rmSync(shard + '.tmp', { recursive: true, force: true })
  })
})
