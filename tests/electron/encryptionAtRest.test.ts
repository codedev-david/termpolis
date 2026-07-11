// WP-F — default-ON encryption at rest for a LOCAL store, reachable without cross-machine sync.
// A random per-device key lives in the OS keychain (Electron safeStorage: DPAPI / Keychain /
// libsecret); the store on disk is AES-256-GCM ciphertext; recall transparently decrypts. Where the
// OS keychain is unavailable we DO NOT fake it — we stay plaintext and honestly report not-encrypted
// (a plaintext key beside the ciphertext would be security theatre). Migration is safe: enabling/
// disabling rewrites the shard atomically and plaintext/ciphertext lines coexist.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { setSafeStorage } from '../../src/main/secureKeyStore'
import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  getSyncStatus,
  enableLocalEncryption,
  disableEncryption,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

// A fake OS keychain that round-trips through base64 (how secureKeyStore stores the blob).
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from('SAFE:' + s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').slice(5),
}

describe('encryption at rest (WP-F)', () => {
  let tmp: string
  const storeFile = () => path.join(tmp, 'swarm-memory.jsonl')
  const storeText = () => fs.readFileSync(storeFile(), 'utf8')
  const contents = () => memoryList().map((e) => e.content)

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-'))
    _resetForTests()
    _setEmbeddingsAvailable(false)
  })
  afterEach(() => {
    setSafeStorage(null)
    _resetForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const relaunch = () => { _resetForTests(); _setEmbeddingsAvailable(false); initSwarmMemory(tmp) }

  it('is ON by default for a local store when the OS keychain is available (ciphertext at rest, plaintext recall)', async () => {
    setSafeStorage(fakeSafe)
    initSwarmMemory(tmp)
    expect(getSyncStatus().encrypted).toBe(true)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'SUPERSECRETMARKER alpha detail' })
    expect(storeText()).not.toContain('SUPERSECRETMARKER') // encrypted on disk
    expect(contents()).toContain('SUPERSECRETMARKER alpha detail') // decrypted in memory
  })

  it('persists the device key in the keychain so a relaunch still decrypts', async () => {
    setSafeStorage(fakeSafe)
    initSwarmMemory(tmp)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'RELAUNCHMARKER bravo' })
    relaunch()
    expect(getSyncStatus().encrypted).toBe(true)
    expect(contents()).toContain('RELAUNCHMARKER bravo') // key reloaded from the keychain
  })

  it('honest fallback when no OS keychain: plaintext at rest, reported not-encrypted, no key file', async () => {
    setSafeStorage(null)
    initSwarmMemory(tmp)
    expect(getSyncStatus().encrypted).toBe(false)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'PLAINMARKER charlie' })
    expect(storeText()).toContain('PLAINMARKER charlie') // honest: plaintext, since we can't protect a key
    expect(fs.existsSync(path.join(tmp, 'memory-sync.key'))).toBe(false) // never wrote a key
  })

  it('opt-out: disableEncryption decrypts and default-on does NOT re-enable on relaunch', async () => {
    setSafeStorage(fakeSafe)
    initSwarmMemory(tmp)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'OPTOUTMARKER delta' })
    expect(getSyncStatus().encrypted).toBe(true)
    disableEncryption()
    expect(getSyncStatus().encrypted).toBe(false)
    expect(storeText()).toContain('OPTOUTMARKER delta') // decrypted back to plaintext
    relaunch()
    expect(getSyncStatus().encrypted).toBe(false) // opt-out remembered
    expect(contents()).toContain('OPTOUTMARKER delta')
  })

  it('enableLocalEncryption re-enables after an opt-out', async () => {
    setSafeStorage(fakeSafe)
    initSwarmMemory(tmp)
    disableEncryption() // opt out
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'REENABLEMARKER echo' })
    expect(getSyncStatus().encrypted).toBe(false)
    enableLocalEncryption()
    expect(getSyncStatus().encrypted).toBe(true)
    expect(storeText()).not.toContain('REENABLEMARKER echo') // re-encrypted at rest
    expect(contents()).toContain('REENABLEMARKER echo')
  })
})
