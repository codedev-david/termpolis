import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { x25519 } from '@noble/curves/ed25519.js'
import { setSafeStorage } from '../../src/main/secureKeyStore'
import { fromHex, toHex } from '../../src/main/remoteBridge/sealedChannel'
import {
  clearRemoteIdentity,
  getOrCreateRemoteIdentity,
  remoteIdentityPath,
} from '../../src/main/remoteIdentityStore'

const XOR = 0x5a
function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ XOR)),
    decryptString: (b: Buffer) => Buffer.from([...b].map((x) => x ^ XOR)).toString('utf8'),
  }
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
    const first = getOrCreateRemoteIdentity(dir)
    expect(first.secretKey).toMatch(/^[0-9a-f]{64}$/)
    expect(first.publicKey).toMatch(/^[0-9a-f]{64}$/)

    // The identity is what every paired phone authenticates against. Re-minting
    // it silently would not look like a bug -- it would look like every phone
    // simultaneously forgetting how to connect.
    expect(getOrCreateRemoteIdentity(dir)).toEqual(first)
  })

  it('stores the secret OS-encrypted rather than in the clear', () => {
    const { secretKey } = getOrCreateRemoteIdentity(dir)
    const raw = fs.readFileSync(remoteIdentityPath(dir), 'utf8')
    expect(raw).not.toContain(secretKey)
    expect(raw.startsWith('osk:v1:')).toBe(true)
  })

  it('derives the public key from the stored secret rather than storing it', () => {
    // A stored pair can disagree with itself. A public key that does not match
    // the secret pairs phones against an identity this desktop cannot prove, and
    // the failure surfaces only later, as a handshake that will not open.
    const secretKey = '11'.repeat(32)
    fs.writeFileSync(remoteIdentityPath(dir), secretKey) // legacy-plaintext path
    expect(getOrCreateRemoteIdentity(dir)).toEqual({
      secretKey,
      publicKey: toHex(x25519.getPublicKey(fromHex(secretKey))),
    })
  })

  it('re-mints when the stored value is not 64 hex chars', () => {
    for (const junk of ['', '   ', 'not-hex', '11'.repeat(16), '11'.repeat(32) + 'ff']) {
      fs.writeFileSync(remoteIdentityPath(dir), junk)
      const id = getOrCreateRemoteIdentity(dir)
      expect(id.secretKey).toMatch(/^[0-9a-f]{64}$/)
      expect(id.secretKey).not.toBe(junk)
    }
  })

  it('returns a usable identity when the key cannot be written', () => {
    // An unwritable userData directory must not take remote down entirely: the
    // user gets a working session that simply does not survive a restart, which
    // is far better than a feature that refuses to start with no explanation.
    const id = getOrCreateRemoteIdentity(path.join(dir, 'does', 'not', 'exist'))
    expect(id.secretKey).toMatch(/^[0-9a-f]{64}$/)
    expect(id.publicKey).toBe(toHex(x25519.getPublicKey(fromHex(id.secretKey))))
  })

  it('forgets the identity on clear, and mints a different one next time', () => {
    const first = getOrCreateRemoteIdentity(dir)
    clearRemoteIdentity(dir)
    expect(fs.existsSync(remoteIdentityPath(dir))).toBe(false)
    expect(getOrCreateRemoteIdentity(dir).secretKey).not.toBe(first.secretKey)
  })

  it('does not throw when clearing an identity that is not there', () => {
    expect(() => clearRemoteIdentity(dir)).not.toThrow()
  })
})
