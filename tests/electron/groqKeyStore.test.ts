import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { setSafeStorage } from '../../src/main/secureKeyStore'
import {
  groqKeyPath,
  setGroqKey,
  getGroqKey,
  getGroqKeyStatus,
  clearGroqKey,
  maskKey,
} from '../../src/main/groqKeyStore'

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-'))
  setSafeStorage(fakeSafeStorage())
})
afterEach(() => {
  setSafeStorage(null)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('groqKeyStore', () => {
  it('stores the key OS-encrypted at rest and round-trips it', () => {
    setGroqKey(dir, 'gsk_supersecretkey1234')
    const onDisk = fs.readFileSync(groqKeyPath(dir), 'utf8')
    expect(onDisk.startsWith('osk:v1:')).toBe(true)
    expect(onDisk).not.toContain('gsk_supersecretkey1234')
    expect(getGroqKey(dir)).toBe('gsk_supersecretkey1234')
  })

  it('trims surrounding whitespace on write', () => {
    setGroqKey(dir, '  gsk_padded1234  ')
    expect(getGroqKey(dir)).toBe('gsk_padded1234')
  })

  it('returns null when no key is stored', () => {
    expect(getGroqKey(dir)).toBeNull()
  })

  it('reports disconnected with an empty hint when no key is set', () => {
    expect(getGroqKeyStatus(dir)).toEqual({ connected: false, hint: '' })
  })

  it('reports connected with a masked hint that never leaks the full key', () => {
    setGroqKey(dir, 'gsk_abcd12345678wxyz')
    const status = getGroqKeyStatus(dir)
    expect(status.connected).toBe(true)
    expect(status.hint).not.toContain('abcd12345678wxyz')
    expect(status.hint).toContain('••••')
  })

  it('clears the key (status returns to disconnected)', () => {
    setGroqKey(dir, 'gsk_xyz12345678')
    expect(getGroqKeyStatus(dir).connected).toBe(true)
    clearGroqKey(dir)
    expect(getGroqKeyStatus(dir).connected).toBe(false)
    expect(getGroqKey(dir)).toBeNull()
  })

  it('clearing a missing key does not throw', () => {
    expect(() => clearGroqKey(dir)).not.toThrow()
  })

  describe('maskKey', () => {
    it('keeps the first and last 4 chars, masks the middle', () => {
      expect(maskKey('gsk_abcd1234efgh5678')).toBe('gsk_••••5678')
    })
    it('fully masks short keys', () => {
      expect(maskKey('short')).toBe('••••')
    })
    it('handles null/undefined keys without throwing', () => {
      expect(maskKey(null as unknown as string)).toBe('••••')
      expect(maskKey(undefined as unknown as string)).toBe('••••')
    })
  })

  describe('nullish key handling', () => {
    it('treats undefined / null / whitespace-only as "no key"', () => {
      setGroqKey(dir, undefined as unknown as string)
      expect(getGroqKey(dir)).toBeNull()
      setGroqKey(dir, '   ')
      expect(getGroqKey(dir)).toBeNull()
      expect(getGroqKeyStatus(dir)).toEqual({ connected: false, hint: '' })
    })
  })
})
