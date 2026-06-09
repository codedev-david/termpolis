import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { setSafeStorage, isOsEncryptionAvailable, writeSecret, readSecret } from '../../src/main/secureKeyStore'

// A fake OS keychain: "encrypts" by XOR (so the on-disk blob is clearly not the
// plaintext) and round-trips correctly — stands in for Electron safeStorage.
const KEY = 0x5a
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ KEY)),
    decryptString: (b: Buffer) => Buffer.from([...b].map((x) => x ^ KEY)).toString('utf8'),
  }
}

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-')) })
afterEach(() => {
  setSafeStorage(null)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('secureKeyStore', () => {
  it('OS-encrypts the secret at rest and round-trips it', () => {
    setSafeStorage(fakeSafeStorage())
    expect(isOsEncryptionAvailable()).toBe(true)
    const p = path.join(dir, 'k')
    writeSecret(p, 'super-secret-key')
    const onDisk = fs.readFileSync(p, 'utf8')
    expect(onDisk.startsWith('osk:v1:')).toBe(true)
    expect(onDisk).not.toContain('super-secret-key') // not plaintext on disk
    expect(readSecret(p)).toBe('super-secret-key')   // …but decrypts correctly
  })

  it('falls back to plaintext when OS encryption is unavailable', () => {
    setSafeStorage(null)
    expect(isOsEncryptionAvailable()).toBe(false)
    const p = path.join(dir, 'k')
    writeSecret(p, 'plain')
    expect(fs.readFileSync(p, 'utf8')).toBe('plain')
    expect(readSecret(p)).toBe('plain')
  })

  it('reads a legacy plaintext value even after OS encryption is enabled', () => {
    const p = path.join(dir, 'k')
    fs.writeFileSync(p, 'legacy-plain') // written before the keychain existed
    setSafeStorage(fakeSafeStorage())
    expect(readSecret(p)).toBe('legacy-plain')
  })

  it('returns null for a missing file', () => {
    expect(readSecret(path.join(dir, 'nope'))).toBeNull()
  })

  it('returns null for an encrypted blob it cannot decrypt (no keychain here)', () => {
    setSafeStorage(fakeSafeStorage())
    const p = path.join(dir, 'enc')
    writeSecret(p, 'x')
    setSafeStorage(null) // lost the keychain
    expect(readSecret(p)).toBeNull()
  })

  it('treats isEncryptionAvailable=false as unavailable', () => {
    setSafeStorage(fakeSafeStorage(false))
    expect(isOsEncryptionAvailable()).toBe(false)
  })

  it('survives a safeStorage that throws on probe', () => {
    setSafeStorage({ isEncryptionAvailable: () => { throw new Error('boom') } } as never)
    expect(isOsEncryptionAvailable()).toBe(false)
  })
})
