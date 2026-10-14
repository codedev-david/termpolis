import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// An ESM namespace can't be spied ("not configurable in ESM"), so fs is re-exported as a plain object:
// every call is still the real one, but a test can vi.spyOn a single method to inject a failure.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, default: { ...actual } }
})

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  setSafeStorage, isOsEncryptionAvailable, writeSecret, readSecret,
  inspectSecret, createSecretExclusive, retireSecretFile, listRetiredSecrets, keyStorageMode,
  keyStorageBackend, wrapSecretInPlace,
} from '../../src/main/secureKeyStore'

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

  it('returns null for an empty file', () => {
    const p = path.join(dir, 'empty')
    fs.writeFileSync(p, '  \n')
    expect(readSecret(p)).toBeNull()
  })

  it('returns null for an encrypted blob it cannot decrypt (no keychain here)', () => {
    setSafeStorage(fakeSafeStorage())
    const p = path.join(dir, 'enc')
    writeSecret(p, 'x')
    setSafeStorage(null) // lost the keychain
    expect(readSecret(p)).toBeNull()
  })

  it('returns null when the keychain refuses to unwrap a blob', () => {
    setSafeStorage(fakeSafeStorage())
    const p = path.join(dir, 'enc')
    writeSecret(p, 'x')
    setSafeStorage({ isEncryptionAvailable: () => true, encryptString: () => Buffer.alloc(0), decryptString: () => { throw new Error('refused') } })
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

describe('keyStorageMode', () => {
  it('reports where a new secret would live', () => {
    expect(keyStorageMode()).toBe('plaintext')
    setSafeStorage(fakeSafeStorage())
    expect(keyStorageMode()).toBe('keychain')
  })
})

// The key-file verbs. readSecret answers null for BOTH "no file" and "a file I can't open right now";
// for a key that encrypts a brain those are opposite facts, and minting over the second one is how a
// brain becomes unreadable for good. Each test below pins one of the distinctions.
describe('inspectSecret — never mistakes "can\'t open it now" for "not there"', () => {
  it('a missing file is absent', () => {
    expect(inspectSecret(path.join(dir, 'nope'))).toEqual({ state: 'absent' })
  })

  it('an OS-wrapped blob opens to its value', () => {
    setSafeStorage(fakeSafeStorage())
    const p = path.join(dir, 'k')
    writeSecret(p, 'wrapped-value')
    expect(inspectSecret(p)).toEqual({ state: 'encrypted', value: 'wrapped-value' })
  })

  it('a legacy plaintext file is reported as plaintext, trimmed', () => {
    const p = path.join(dir, 'k')
    fs.writeFileSync(p, 'legacy-value\n')
    expect(inspectSecret(p)).toEqual({ state: 'plaintext', value: 'legacy-value' })
  })

  it('an empty file is NOT absent — it is a damaged secret the caller must not mint over', () => {
    const p = path.join(dir, 'k')
    fs.writeFileSync(p, '')
    expect(inspectSecret(p)).toEqual({ state: 'plaintext', value: '' })
  })

  it('a wrapped blob with no keychain is locked, not absent', () => {
    setSafeStorage(fakeSafeStorage())
    const p = path.join(dir, 'k')
    writeSecret(p, 'x')
    setSafeStorage(null)
    expect(inspectSecret(p)).toEqual({ state: 'locked', reason: 'no-keychain' })
  })

  it('a wrapped blob the keychain refuses is locked, not absent', () => {
    setSafeStorage(fakeSafeStorage())
    const p = path.join(dir, 'k')
    writeSecret(p, 'x')
    setSafeStorage({ isEncryptionAvailable: () => true, encryptString: () => Buffer.alloc(0), decryptString: () => { throw new Error('DPAPI said no') } })
    expect(inspectSecret(p)).toEqual({ state: 'locked', reason: 'unwrap-failed' })
  })

  it('a path the OS will not read (a directory in the way) is locked, not absent', () => {
    const p = path.join(dir, 'k')
    fs.mkdirSync(p)
    expect(inspectSecret(p)).toEqual({ state: 'locked', reason: 'unreadable' })
  })
})

describe('createSecretExclusive — creates, and never overwrites', () => {
  it('creates an OS-wrapped secret that reads back', () => {
    setSafeStorage(fakeSafeStorage())
    const p = path.join(dir, 'k')
    createSecretExclusive(p, 'fresh-secret')
    expect(fs.readFileSync(p, 'utf8').startsWith('osk:v1:')).toBe(true)
    expect(readSecret(p)).toBe('fresh-secret')
    // No temp file is left beside it.
    expect(fs.readdirSync(dir)).toEqual(['k'])
  })

  it('refuses an existing target of ANY content and leaves its bytes identical', () => {
    setSafeStorage(fakeSafeStorage())
    for (const existing of ['osk:v1:AAAA', 'plain-old-key', '', 'garbage\u0000bytes']) {
      const p = path.join(dir, 'k')
      fs.writeFileSync(p, existing)
      const before = fs.readFileSync(p)
      let caught: NodeJS.ErrnoException | null = null
      try { createSecretExclusive(p, 'new-secret') } catch (e) { caught = e as NodeJS.ErrnoException }
      expect(caught?.code).toBe('EEXIST')
      expect(fs.readFileSync(p).equals(before)).toBe(true)
      expect(fs.readdirSync(dir)).toEqual(['k']) // and the staged temp file is cleaned up
      fs.rmSync(p)
    }
  })

  it('refuses to write a secret in plaintext when there is no keychain', () => {
    const p = path.join(dir, 'k')
    expect(() => createSecretExclusive(p, 'would-be-plain')).toThrow(/no OS keychain/)
    expect(fs.existsSync(p)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('a secret with surrounding whitespace is not mistaken for an unreadable one', () => {
    // readSecret hands back a wrapped secret exactly, and a plaintext file trimmed — the read-back
    // check has to expect the same, or a padded secret would be moved aside as "unreadable".
    setSafeStorage(fakeSafeStorage())
    const wrapped = path.join(dir, 'wrapped')
    createSecretExclusive(wrapped, '  padded-secret\n')
    expect(readSecret(wrapped)).toBe('  padded-secret\n')
    setSafeStorage(null)
    const plain = path.join(dir, 'plain')
    createSecretExclusive(plain, '  padded-secret\n', { allowPlaintext: true })
    expect(readSecret(plain)).toBe('padded-secret')
    expect(listRetiredSecrets(wrapped)).toEqual([])
    expect(listRetiredSecrets(plain)).toEqual([])
  })

  it('writes plaintext only when the caller explicitly allows it', () => {
    const p = path.join(dir, 'k')
    createSecretExclusive(p, 'allowed-plain', { allowPlaintext: true })
    expect(fs.readFileSync(p, 'utf8')).toBe('allowed-plain')
  })

  it('a keychain that refuses to wrap leaves nothing at all behind', () => {
    setSafeStorage({ isEncryptionAvailable: () => true, encryptString: () => { throw new Error('keychain locked') }, decryptString: () => '' })
    const p = path.join(dir, 'k')
    expect(() => createSecretExclusive(p, 's')).toThrow(/keychain locked/)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('falls back to a rename where hard links are unsupported, still only over nothing', () => {
    setSafeStorage(fakeSafeStorage())
    const link = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('not supported'), { code: 'EPERM' })
    })
    try {
      const p = path.join(dir, 'k')
      createSecretExclusive(p, 'renamed-in')
      expect(readSecret(p)).toBe('renamed-in')
      expect(fs.readdirSync(dir)).toEqual(['k'])
      // ...and the fallback refuses an existing file exactly like the link does.
      const before = fs.readFileSync(p)
      let code: string | undefined
      try { createSecretExclusive(p, 'clobber') } catch (e) { code = (e as NodeJS.ErrnoException).code }
      expect(code).toBe('EEXIST')
      expect(fs.readFileSync(p).equals(before)).toBe(true)
      expect(fs.readdirSync(dir)).toEqual(['k'])
    } finally {
      link.mockRestore()
    }
  })

  it('a secret that does not read back is moved aside (never deleted) and reported', () => {
    // A keychain whose decrypt disagrees with its encrypt: the blob is unusable, and nothing has been
    // encrypted under it yet, so it must not sit there blocking the next mint.
    setSafeStorage({ isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: () => 'something else' })
    const p = path.join(dir, 'k')
    expect(() => createSecretExclusive(p, 'expected')).toThrow(/could not be read back/)
    expect(fs.existsSync(p)).toBe(false)
    const retired = listRetiredSecrets(p)
    expect(retired).toHaveLength(1)
    expect(fs.readFileSync(retired[0], 'utf8').startsWith('osk:v1:')).toBe(true)
  })

  // POSIX needs the DIRECTORY fsync'd for a new name to survive a power cut; Windows can't open a
  // directory for that at all. Both arms run here whatever the host OS, by faking the platform and
  // standing a real file in for the directory handle.
  describe('directory fsync', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks() })

    it('on POSIX the directory is opened and fsync\'d after the link', () => {
      setSafeStorage(fakeSafeStorage())
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const stand = path.join(dir, 'stand-in')
      fs.writeFileSync(stand, '')
      const realOpen = fs.openSync
      const sync = vi.spyOn(fs, 'fsyncSync')
      const opened: string[] = []
      vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
        if (p === dir && flags === 'r') { opened.push(String(p)); return realOpen(stand, 'r') }
        return realOpen(p, flags, mode)
      }) as typeof fs.openSync)
      createSecretExclusive(path.join(dir, 'k'), 'posix')
      expect(opened).toEqual([dir])
      expect(sync.mock.calls.length).toBeGreaterThanOrEqual(2) // the temp file, then the directory
      expect(readSecret(path.join(dir, 'k'))).toBe('posix')
    })

    it('a directory that refuses to open is best effort — the secret is still created', () => {
      setSafeStorage(fakeSafeStorage())
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const realOpen = fs.openSync
      vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
        if (p === dir && flags === 'r') throw new Error('EISDIR: illegal operation on a directory')
        return realOpen(p, flags, mode)
      }) as typeof fs.openSync)
      createSecretExclusive(path.join(dir, 'k'), 'posix-too')
      expect(readSecret(path.join(dir, 'k'))).toBe('posix-too')
    })
  })
})

describe('retireSecretFile — rename aside, prove the bytes, never delete', () => {
  it('moves the file to <name>.retired-<epochMs> with identical bytes', () => {
    const p = path.join(dir, 'memory-sync.key')
    fs.writeFileSync(p, 'osk:v1:some-wrapped-blob')
    const before = fs.readFileSync(p)
    const now = Date.now()
    const target = retireSecretFile(p, 'test')
    expect(fs.existsSync(p)).toBe(false)
    expect(path.basename(target)).toMatch(/^memory-sync\.key\.retired-\d+$/)
    expect(Number(path.basename(target).split('.retired-')[1])).toBeGreaterThanOrEqual(now)
    expect(fs.readFileSync(target).equals(before)).toBe(true)
  })

  it('never overwrites an earlier retired copy that shares the millisecond', () => {
    const p = path.join(dir, 'k')
    const fixed = 1_700_000_000_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(fixed)
    try {
      fs.writeFileSync(p, 'first')
      const a = retireSecretFile(p, 'one')
      fs.writeFileSync(p, 'second')
      const b = retireSecretFile(p, 'two')
      expect(a).not.toBe(b)
      expect(fs.readFileSync(a, 'utf8')).toBe('first')
      expect(fs.readFileSync(b, 'utf8')).toBe('second')
    } finally {
      clock.mockRestore()
    }
  })

  it('throws when there is nothing to retire', () => {
    expect(() => retireSecretFile(path.join(dir, 'missing'), 'test')).toThrow()
  })

  it('reports a retired copy whose bytes do not match', () => {
    const p = path.join(dir, 'k')
    fs.writeFileSync(p, 'original')
    const realRead = fs.readFileSync
    let reads = 0
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(((f: fs.PathOrFileDescriptor, o?: unknown) => {
      reads++
      // The read-back of the retired copy comes second: hand back something different.
      return reads === 2 ? Buffer.from('tampered') : realRead(f, o as never)
    }) as typeof fs.readFileSync)
    try {
      expect(() => retireSecretFile(p, 'verify')).toThrow(/does not match the original bytes/)
    } finally {
      read.mockRestore()
    }
    // The rename still happened, and nothing was deleted.
    expect(listRetiredSecrets(p)).toHaveLength(1)
  })
})

describe('listRetiredSecrets', () => {
  it('lists only <name>.retired-<digits>, newest first', () => {
    const p = path.join(dir, 'memory-sync.key')
    fs.writeFileSync(`${p}.retired-100`, 'a')
    fs.writeFileSync(`${p}.retired-300`, 'c')
    fs.writeFileSync(`${p}.retired-200`, 'b')
    fs.writeFileSync(`${p}.retired-200.tmp`, 'not a retired key')
    fs.writeFileSync(path.join(dir, 'other.key.retired-999'), 'not ours')
    expect(listRetiredSecrets(p).map((f) => path.basename(f))).toEqual([
      'memory-sync.key.retired-300', 'memory-sync.key.retired-200', 'memory-sync.key.retired-100',
    ])
  })

  it('is empty when the directory cannot be listed', () => {
    expect(listRetiredSecrets(path.join(dir, 'no-such-dir', 'k'))).toEqual([])
  })
})

describe('keyStorageBackend -- small print, never a decision', () => {
  it('is the name Electron reports for its store, asked once when the keychain is wired up', () => {
    const backend = vi.fn(() => 'basic_text')
    // basic_text with no plain-text opt-in: Electron reports no encryption, and
    // that alone decides the mode. The name only rides along.
    setSafeStorage({ ...fakeSafeStorage(false), getSelectedStorageBackend: backend })
    expect(keyStorageMode()).toBe('plaintext')
    expect(keyStorageBackend()).toBe('basic_text')
    keyStorageBackend()
    expect(backend).toHaveBeenCalledTimes(1)
  })

  it('is null where Electron has no such method (Windows, macOS), and for no keychain at all', () => {
    setSafeStorage(fakeSafeStorage())
    expect(keyStorageBackend()).toBeNull()
    setSafeStorage(null)
    expect(keyStorageBackend()).toBeNull()
  })

  it('is null when the method throws or answers nothing', () => {
    setSafeStorage({ ...fakeSafeStorage(), getSelectedStorageBackend: () => { throw new Error('not ready') } })
    expect(keyStorageBackend()).toBeNull()
    expect(keyStorageMode()).toBe('keychain')
    setSafeStorage({ ...fakeSafeStorage(), getSelectedStorageBackend: () => '' })
    expect(keyStorageBackend()).toBeNull()
  })
})

describe('wrapSecretInPlace -- seal a secret saved in the clear, never leaving its name empty', () => {
  it('seals a plaintext secret under the same name, opening to the same value', () => {
    const p = path.join(dir, 'remote-identity-key')
    fs.writeFileSync(p, 'ab'.repeat(32) + '\n')
    setSafeStorage(fakeSafeStorage())
    expect(wrapSecretInPlace(p)).toBe(true)
    expect(fs.readFileSync(p, 'utf8').startsWith('osk:v1:')).toBe(true)
    expect(inspectSecret(p)).toEqual({ state: 'encrypted', value: 'ab'.repeat(32) })
    // Nothing left beside it: the sealed copy became the file.
    expect(fs.readdirSync(dir)).toEqual(['remote-identity-key'])
  })

  it('does nothing to a file that is absent, empty, already sealed or locked', () => {
    setSafeStorage(fakeSafeStorage())
    expect(wrapSecretInPlace(path.join(dir, 'absent'))).toBe(false)
    const empty = path.join(dir, 'empty')
    fs.writeFileSync(empty, '  ')
    expect(wrapSecretInPlace(empty)).toBe(false)
    const sealed = path.join(dir, 'sealed')
    writeSecret(sealed, 'secret')
    const before = fs.readFileSync(sealed)
    expect(wrapSecretInPlace(sealed)).toBe(false)
    setSafeStorage(null) // now it can't be opened at all
    expect(wrapSecretInPlace(sealed)).toBe(false)
    expect(fs.readFileSync(sealed).equals(before)).toBe(true)
    expect(fs.readFileSync(empty, 'utf8')).toBe('  ')
  })

  it('refuses without a keychain to seal with, leaving the secret as it was', () => {
    const p = path.join(dir, 'k')
    fs.writeFileSync(p, 'plain')
    setSafeStorage(null)
    expect(() => wrapSecretInPlace(p)).toThrow(/no OS keychain/)
    expect(fs.readFileSync(p, 'utf8')).toBe('plain')
    expect(fs.readdirSync(dir)).toEqual(['k'])
  })

  it('a sealed copy that cannot be renamed into place is removed, and the original kept', () => {
    const p = path.join(dir, 'k')
    fs.writeFileSync(p, 'plain')
    setSafeStorage(fakeSafeStorage())
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('in use'), { code: 'EBUSY' })
    })
    try {
      expect(() => wrapSecretInPlace(p)).toThrow(/in use/)
    } finally {
      rename.mockRestore()
    }
    expect(fs.readFileSync(p, 'utf8')).toBe('plain')
    expect(fs.readdirSync(dir)).toEqual(['k'])
  })

  it('still reports the rename when the sealed copy will not go either', () => {
    const p = path.join(dir, 'k')
    fs.writeFileSync(p, 'plain')
    setSafeStorage(fakeSafeStorage())
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('in use'), { code: 'EBUSY' })
    })
    const realRm = fs.rmSync
    const rm = vi.spyOn(fs, 'rmSync').mockImplementation((target, opts) => {
      // createSecretExclusive tidies its own temp name first; only the sealed copy refuses.
      if (String(target).endsWith('.sealed')) throw new Error('locked by a scanner')
      realRm(target, opts)
    })
    try {
      expect(() => wrapSecretInPlace(p)).toThrow(/in use/)
    } finally {
      rename.mockRestore()
      rm.mockRestore()
    }
    expect(fs.readFileSync(p, 'utf8')).toBe('plain')
  })

  it('a sealed copy that does not read back never replaces the original', () => {
    const p = path.join(dir, 'k')
    fs.writeFileSync(p, 'plain')
    // A keychain whose wrap does not open again: createSecretExclusive catches it.
    setSafeStorage({ ...fakeSafeStorage(), decryptString: () => 'something else' })
    expect(() => wrapSecretInPlace(p)).toThrow(/could not be read back/)
    expect(fs.readFileSync(p, 'utf8')).toBe('plain')
  })
})
