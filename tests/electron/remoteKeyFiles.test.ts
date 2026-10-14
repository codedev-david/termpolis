import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// A mutable copy of fs, so a test can make one rename fail the way a file held open by a scanner does.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, default: { ...actual } }
})

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { inspectSecret, listRetiredSecrets, setSafeStorage, writeSecret } from '../../src/main/secureKeyStore'
import { remoteIdentityPath } from '../../src/main/remoteIdentityStore'
import { linkedStatePath } from '../../src/main/linkedStore'
import { remoteDevicesPath } from '../../src/main/remoteDeviceStore'
import { encryptKeyFiles, retireLinkedStateFile, retireRemoteKeyFiles, unencryptedKeyFiles } from '../../src/main/remoteKeyFiles'

const XOR = 0x5a
function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ XOR)),
    decryptString: (b: Buffer) => Buffer.from([...b].map((x) => x ^ XOR)).toString('utf8'),
  }
}

const SECRET = 'cd'.repeat(32)
const STATE = JSON.stringify({ v: 1, links: [], meta: [] })

let dir: string
let identity: string
let linked: string
let devices: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-keys-'))
  identity = remoteIdentityPath(dir)
  linked = linkedStatePath(dir)
  devices = remoteDevicesPath(dir)
})
afterEach(() => {
  setSafeStorage(null)
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Both key files written the way a keyring-less launch wrote them. */
function inTheClear(): void {
  fs.writeFileSync(identity, SECRET)
  fs.writeFileSync(linked, STATE)
}

const renameFailsFor = (name: string) => {
  const real = fs.renameSync
  return vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (path.basename(String(from)).startsWith(name)) throw Object.assign(new Error(`${name} is in use`), { code: 'EBUSY' })
    real(from, to)
  })
}

describe('unencryptedKeyFiles', () => {
  it('names the key files saved in the clear, identity first, once a keychain could seal them', () => {
    inTheClear()
    setSafeStorage(fakeSafeStorage())
    expect(unencryptedKeyFiles(dir)).toEqual([identity, linked])
  })

  it('names none without a keychain: there is nothing to seal them with', () => {
    inTheClear()
    expect(unencryptedKeyFiles(dir)).toEqual([])
  })

  it('names none that are sealed already, or not there at all', () => {
    setSafeStorage(fakeSafeStorage())
    expect(unencryptedKeyFiles(dir)).toEqual([])
    writeSecret(identity, SECRET)
    fs.writeFileSync(linked, STATE)
    expect(unencryptedKeyFiles(dir)).toEqual([linked])
  })
})

describe('encryptKeyFiles', () => {
  it('seals both, each opening to exactly what it held', () => {
    inTheClear()
    setSafeStorage(fakeSafeStorage())
    encryptKeyFiles(dir)
    expect(inspectSecret(identity)).toEqual({ state: 'encrypted', value: SECRET })
    expect(inspectSecret(linked)).toEqual({ state: 'encrypted', value: STATE })
    expect(unencryptedKeyFiles(dir)).toEqual([])
  })

  it('a failure part-way leaves the first sealed and the second exactly as it was', () => {
    inTheClear()
    setSafeStorage(fakeSafeStorage())
    renameFailsFor('linked-machines')
    expect(() => encryptKeyFiles(dir)).toThrow(/linked-machines is in use/)
    expect(inspectSecret(identity)).toEqual({ state: 'encrypted', value: SECRET })
    expect(fs.readFileSync(linked, 'utf8')).toBe(STATE)
  })

  it('throws, changing nothing, with no keychain to seal with', () => {
    inTheClear()
    expect(() => encryptKeyFiles(dir)).toThrow(/no OS keychain/)
    expect(fs.readFileSync(identity, 'utf8')).toBe(SECRET)
  })
})

describe('retireRemoteKeyFiles', () => {
  it('sets all three aside, byte for byte, and deletes nothing', () => {
    setSafeStorage(fakeSafeStorage())
    writeSecret(identity, SECRET)
    writeSecret(linked, STATE)
    fs.writeFileSync(devices, '[]')
    const before = [identity, linked, devices].map((p) => fs.readFileSync(p))
    retireRemoteKeyFiles(dir)
    for (const [i, p] of [identity, linked, devices].entries()) {
      expect(fs.existsSync(p)).toBe(false)
      const [aside] = listRetiredSecrets(p)
      expect(fs.readFileSync(aside).equals(before[i])).toBe(true)
    }
  })

  it('is quiet about files that were never there', () => {
    expect(() => retireRemoteKeyFiles(dir)).not.toThrow()
    fs.writeFileSync(identity, SECRET)
    retireRemoteKeyFiles(dir)
    expect(listRetiredSecrets(identity)).toHaveLength(1)
  })

  it('touches nothing else when the identity cannot be moved', () => {
    inTheClear()
    fs.writeFileSync(devices, '[]')
    renameFailsFor('remote-identity-key')
    expect(() => retireRemoteKeyFiles(dir)).toThrow(/remote-identity-key is in use/)
    expect([identity, linked, devices].every((p) => fs.existsSync(p))).toBe(true)
    expect(fs.readdirSync(dir).some((n) => n.includes('.retired-'))).toBe(false)
  })

  it('goes on past a links or devices file that will not move: the hosts forget them anyway', () => {
    inTheClear()
    fs.writeFileSync(devices, '[]')
    renameFailsFor('linked-machines')
    expect(() => retireRemoteKeyFiles(dir)).not.toThrow()
    expect(fs.existsSync(identity)).toBe(false)
    expect(fs.existsSync(linked)).toBe(true)
    expect(fs.existsSync(devices)).toBe(false)
  })
})

describe('retireLinkedStateFile', () => {
  it('sets the links file aside alone, byte for byte: the identity and the devices stay', () => {
    setSafeStorage(fakeSafeStorage())
    writeSecret(identity, SECRET)
    writeSecret(linked, STATE)
    fs.writeFileSync(devices, '[]')
    const before = fs.readFileSync(linked)
    retireLinkedStateFile(dir)
    expect(fs.existsSync(linked)).toBe(false)
    expect(fs.readFileSync(listRetiredSecrets(linked)[0]).equals(before)).toBe(true)
    expect(inspectSecret(identity)).toEqual({ state: 'encrypted', value: SECRET })
    expect(fs.readFileSync(devices, 'utf8')).toBe('[]')
  })

  it('is quiet about a file that is not there, or will not move: the host forgets it anyway', () => {
    expect(() => retireLinkedStateFile(dir)).not.toThrow()
    fs.mkdirSync(linked)
    expect(() => retireLinkedStateFile(dir)).not.toThrow()
    expect(fs.statSync(linked).isDirectory()).toBe(true)
  })
})
