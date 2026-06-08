import { describe, it, expect } from 'vitest'
import { newSalt, deriveKey, encryptLine, decryptLine, isEncryptedLine } from '../../src/main/memoryCrypto'

describe('memoryCrypto', () => {
  it('round-trips plaintext through encrypt/decrypt and does not leak it', () => {
    const key = deriveKey('hunter2', newSalt())
    const ct = encryptLine(key, 'the quick brown fox')
    expect(isEncryptedLine(ct)).toBe(true)
    expect(ct).not.toContain('quick') // ciphertext doesn't reveal the plaintext
    expect(decryptLine(key, ct)).toBe('the quick brown fox')
  })

  it('derives the SAME key from the same passphrase + salt (cross-device unlock)', () => {
    const salt = newSalt()
    const a = deriveKey('correct horse', salt)
    const b = deriveKey('correct horse', salt)
    expect(a.equals(b)).toBe(true)
    expect(a.length).toBe(32)
  })

  it('derives different keys for different passphrases or salts', () => {
    const salt = newSalt()
    expect(deriveKey('a', salt).equals(deriveKey('b', salt))).toBe(false)
    expect(deriveKey('a', newSalt()).equals(deriveKey('a', newSalt()))).toBe(false)
  })

  it('returns null when decrypting with the wrong key', () => {
    const ct = encryptLine(deriveKey('right', newSalt()), 'secret')
    expect(decryptLine(deriveKey('wrong', newSalt()), ct)).toBeNull()
  })

  it('returns null on corrupt / truncated ciphertext', () => {
    const key = deriveKey('k', newSalt())
    expect(decryptLine(key, 'enc:v1:not-valid-base64-@@@')).toBeNull()
    expect(decryptLine(key, 'enc:v1:' + Buffer.from('short').toString('base64'))).toBeNull()
  })

  it('passes plaintext (non-encrypted) lines through unchanged', () => {
    const key = deriveKey('k', newSalt())
    expect(isEncryptedLine('{"id":"x"}')).toBe(false)
    expect(decryptLine(key, '{"id":"x"}')).toBe('{"id":"x"}')
  })

  it('uses a random IV — same plaintext encrypts to different ciphertext', () => {
    const key = deriveKey('k', newSalt())
    const a = encryptLine(key, 'same')
    const b = encryptLine(key, 'same')
    expect(a).not.toBe(b)
    expect(decryptLine(key, a)).toBe('same')
    expect(decryptLine(key, b)).toBe('same')
  })
})
