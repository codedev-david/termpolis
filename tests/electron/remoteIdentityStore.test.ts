import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The module namespace is frozen under ESM; a mutable copy lets a test make one fs call fail, the
// way a race or a locked file would, on the copy secureKeyStore reads too.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, default: { ...actual } }
})

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { x25519 } from '@noble/curves/ed25519.js'
import { listRetiredSecrets, setSafeStorage, writeSecret } from '../../src/main/secureKeyStore'
import { fromHex, generateIdentity, toHex } from '../../src/main/remoteBridge/sealedChannel'
import { remoteIdentityPath, resolveRemoteIdentity, type RemoteIdentity } from '../../src/main/remoteIdentityStore'

const XOR = 0x5a
function fakeSafeStorage(opens = true) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ XOR)),
    decryptString: (b: Buffer) => {
      // A keychain that refuses this blob: a password reset, another account's data folder.
      if (!opens) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return Buffer.from([...b].map((x) => x ^ XOR)).toString('utf8')
    },
  }
}

const derived = (secretKey: string): string => toHex(x25519.getPublicKey(fromHex(secretKey)))

function ok(dir: string): RemoteIdentity {
  const resolved = resolveRemoteIdentity(dir)
  if (resolved.kind !== 'ok') throw new Error(`locked: ${resolved.reason}`)
  return resolved.identity
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-id-'))
  setSafeStorage(fakeSafeStorage())
})
afterEach(() => {
  setSafeStorage(null)
  vi.restoreAllMocks()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('remoteIdentityStore', () => {
  it('mints once and returns the same identity thereafter', () => {
    const first = ok(dir)
    expect(first.secretKey).toMatch(/^[0-9a-f]{64}$/)
    expect(first.publicKey).toBe(derived(first.secretKey))

    // The identity is what every paired phone authenticates against. Re-minting
    // it silently would not look like a bug -- it would look like every phone
    // simultaneously forgetting how to connect.
    expect(ok(dir)).toEqual(first)
  })

  it('stores the secret OS-encrypted rather than in the clear', () => {
    const { secretKey } = ok(dir)
    const raw = fs.readFileSync(remoteIdentityPath(dir), 'utf8')
    expect(raw).not.toContain(secretKey)
    expect(raw.startsWith('osk:v1:')).toBe(true)
  })

  it('mints in the clear only where there is no keychain at all', () => {
    // The Remote and Linked panes warn about exactly this; refusing to mint would
    // leave a keyring-less Linux box with no remote at all.
    setSafeStorage(null)
    const { secretKey } = ok(dir)
    expect(fs.readFileSync(remoteIdentityPath(dir), 'utf8')).toBe(secretKey)
  })

  it('derives the public key from the stored secret rather than storing it', () => {
    // A stored pair can disagree with itself. A public key that does not match
    // the secret pairs phones against an identity this desktop cannot prove, and
    // the failure surfaces only later, as a handshake that will not open.
    const secretKey = '11'.repeat(32)
    fs.writeFileSync(remoteIdentityPath(dir), secretKey) // legacy-plaintext path
    expect(ok(dir)).toEqual({ secretKey, publicKey: derived(secretKey) })
  })

  it('re-mints over a file that is not a key, and sets that file aside rather than deleting it', () => {
    const keyPath = remoteIdentityPath(dir)
    const junk = ['', '   ', 'not-hex', '11'.repeat(16), '11'.repeat(32) + 'ff']
    for (const value of junk) {
      fs.writeFileSync(keyPath, value)
      const id = ok(dir)
      expect(id.secretKey).toMatch(/^[0-9a-f]{64}$/)
      expect(id.secretKey).not.toBe(value)
      expect(ok(dir)).toEqual(id) // and that one is kept
      fs.rmSync(keyPath)
    }
    // Every one of them still on disk, byte for byte: renaming loses nothing.
    const kept = listRetiredSecrets(keyPath).map((p) => fs.readFileSync(p, 'utf8'))
    expect(kept.sort()).toEqual([...junk].sort())
  })

  it('a sealed file that opens to something other than a key is locked, not minted over', () => {
    // What a keychain other than the one that sealed it can hand back instead of
    // refusing. In the clear it would be junk; sealed, it may still be the key.
    writeSecret(remoteIdentityPath(dir), 'not a key at all')
    const before = fs.readFileSync(remoteIdentityPath(dir))
    expect(resolveRemoteIdentity(dir)).toEqual({ kind: 'locked', reason: 'unwrap-failed' })
    expect(fs.readFileSync(remoteIdentityPath(dir)).equals(before)).toBe(true)
    expect(listRetiredSecrets(remoteIdentityPath(dir))).toEqual([])
  })

  describe('a key that is there but cannot be opened now', () => {
    // The data-loss guard. Each of these used to read as "no identity", and the
    // identity minted over it orphaned every phone and computer paired with it.
    it('is locked, not re-minted, when the keychain refuses it -- and its bytes are untouched', () => {
      ok(dir)
      const keyPath = remoteIdentityPath(dir)
      const before = fs.readFileSync(keyPath)
      setSafeStorage(fakeSafeStorage(false))
      expect(resolveRemoteIdentity(dir)).toEqual({ kind: 'locked', reason: 'unwrap-failed' })
      expect(fs.readFileSync(keyPath).equals(before)).toBe(true)
      // Nothing beside it either: no temp file, nothing retired.
      expect(fs.readdirSync(dir)).toEqual([path.basename(keyPath)])
    })

    it('is locked when there is no keychain to open it with', () => {
      ok(dir)
      const before = fs.readFileSync(remoteIdentityPath(dir))
      setSafeStorage(null)
      expect(resolveRemoteIdentity(dir)).toEqual({ kind: 'locked', reason: 'no-keychain' })
      expect(fs.readFileSync(remoteIdentityPath(dir)).equals(before)).toBe(true)
    })

    it('is locked when the file will not read at all', () => {
      // A directory where the file should be: exists, and readFileSync refuses it.
      fs.mkdirSync(remoteIdentityPath(dir))
      expect(resolveRemoteIdentity(dir)).toEqual({ kind: 'locked', reason: 'unreadable' })
      expect(fs.statSync(remoteIdentityPath(dir)).isDirectory()).toBe(true)
    })

    it('opens again, as the same identity, once the keychain does', () => {
      const first = ok(dir)
      setSafeStorage(fakeSafeStorage(false))
      expect(resolveRemoteIdentity(dir).kind).toBe('locked')
      setSafeStorage(fakeSafeStorage())
      expect(ok(dir)).toEqual(first)
    })
  })

  it('returns a usable identity when the key cannot be written', () => {
    // An unwritable userData directory must not take remote down entirely: the
    // user gets a working session that simply does not survive a restart, which
    // is far better than a feature that refuses to start with no explanation.
    const id = ok(path.join(dir, 'does', 'not', 'exist'))
    expect(id.secretKey).toMatch(/^[0-9a-f]{64}$/)
    expect(id.publicKey).toBe(derived(id.secretKey))
  })

  it('uses the identity another process wrote first, rather than its own', () => {
    // Two starts racing to mint: the file that won is the identity, as found.
    const theirs = generateIdentity()
    const realLink = fs.linkSync
    vi.spyOn(fs, 'linkSync').mockImplementationOnce((existing, target) => {
      writeSecret(String(target), theirs.secretKey)
      realLink(existing, target) // throws EEXIST: the race lost
    })
    expect(resolveRemoteIdentity(dir)).toEqual({ kind: 'ok', identity: theirs })
  })

  it('a file that is not a key and will not move aside leaves an identity for this run only', () => {
    const keyPath = remoteIdentityPath(dir)
    fs.writeFileSync(keyPath, 'not-hex')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('in use'), { code: 'EBUSY' })
    })
    const id = ok(dir)
    expect(id.secretKey).toMatch(/^[0-9a-f]{64}$/)
    // Never written over: the file is what it was, so the next launch tries again.
    expect(fs.readFileSync(keyPath, 'utf8')).toBe('not-hex')
  })
})
