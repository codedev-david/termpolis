import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { setSafeStorage } from '../../src/main/secureKeyStore'
import {
  DEFAULT_GRANTS,
  DEFAULT_MACHINE_NAME,
  LINKED_STATE_FILE,
  loadLinkedState,
  normalizeGrants,
  refOf,
  saveLinkedState,
  targetOf,
  type JoinedLink,
  type LinkedState,
  type LinkMeta,
} from '../../src/main/linkedStore'

const XOR = 0x5a
function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ XOR)),
    decryptString: (b: Buffer) => Buffer.from([...b].map((x) => x ^ XOR)).toString('utf8'),
  }
}

const link = (over: Partial<JoinedLink> = {}): JoinedLink => ({
  id: 'a1b2c3d4e5f60718',
  hostPublicKey: '0f'.repeat(32),
  relayUrl: 'wss://relay.example.com',
  sessionRoomId: 'c9dc49b87f0dc983be61f034ceab7c52',
  secretKey: '1e'.repeat(32),
  linkedAt: 1_700_000_000_000,
  ...over,
})

const meta = (over: Partial<LinkMeta> = {}): LinkMeta => ({
  ref: 'link:a1b2c3d4e5f60718',
  name: 'linux',
  grants: { run: true, write: false },
  confirmed: true,
  linkedAt: 1_700_000_000_000,
  ...over,
})

const PHRASE = 'acorn admiral agate album amber anchor antler apricot'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-store-'))
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

const file = (): string => path.join(dir, LINKED_STATE_FILE)

/** Put a document on disk as the store would, so a test can plant bad records. */
function writeDoc(doc: unknown): void {
  setSafeStorage(null)
  fs.writeFileSync(file(), JSON.stringify(doc))
  setSafeStorage(fakeSafeStorage())
}

describe('linkedStore persistence', () => {
  it('round-trips the links and their meta', () => {
    const state: LinkedState = {
      links: [link(), link({ id: 'ffffffffffffffff', relayUrl: 'ws://127.0.0.1:8787' })],
      meta: [
        meta(),
        meta({ ref: 'device:0011223344556677', name: 'desk', confirmed: false, phrase: PHRASE }),
      ],
    }
    saveLinkedState(dir, state)
    expect(LINKED_STATE_FILE).toBe('linked-machines')
    expect(loadLinkedState(dir)).toEqual(state)
  })

  it('stores the link keys OS-encrypted when a keyring exists', () => {
    saveLinkedState(dir, { links: [link()], meta: [meta()] })
    const raw = fs.readFileSync(file(), 'utf8')
    expect(raw.startsWith('osk:v1:')).toBe(true)
    expect(raw).not.toContain('1e'.repeat(32))
  })

  it('falls back to honest plaintext without a keyring', () => {
    setSafeStorage(null)
    saveLinkedState(dir, { links: [link()], meta: [] })
    const doc = JSON.parse(fs.readFileSync(file(), 'utf8'))
    expect(doc).toEqual({ v: 1, links: [link()], meta: [] })
    expect(loadLinkedState(dir)).toEqual({ links: [link()], meta: [] })
  })

  it('reads missing, corrupt and wrong-shaped files as no links', () => {
    const empty = { links: [], meta: [] }
    expect(loadLinkedState(dir)).toEqual(empty)
    for (const raw of ['{ not json', 'null', '[]', '"links"', '{"links":"x","meta":{}}']) {
      setSafeStorage(null)
      fs.writeFileSync(file(), raw)
      setSafeStorage(fakeSafeStorage())
      expect(loadLinkedState(dir)).toEqual(empty)
    }
  })

  it('reads an encrypted file as empty when the keyring has gone', () => {
    saveLinkedState(dir, { links: [link()], meta: [meta()] })
    setSafeStorage(null)
    expect(loadLinkedState(dir)).toEqual({ links: [], meta: [] })
  })

  it('reads the records whatever version the file claims', () => {
    // Every record is validated on the way in, so a file from a newer build is
    // read for what still parses -- a downgrade must not cost the user every link.
    writeDoc({ v: 2, links: [link()], meta: [meta()] })
    expect(loadLinkedState(dir)).toEqual({ links: [link()], meta: [meta()] })
  })

  it('drops links whose keys, room or relay are not well formed', () => {
    const good = link()
    writeDoc({
      v: 1,
      links: [
        good,
        link({ id: 'A1B2C3D4E5F60718' }),
        link({ id: 'a1b2c3d4e5f6071' }),
        link({ hostPublicKey: '0f'.repeat(31) }),
        link({ sessionRoomId: 'zz'.repeat(16) }),
        link({ secretKey: '' }),
        link({ relayUrl: 'https://relay.example.com' }),
        link({ relayUrl: 'ws://relay.example.com' }),
        'not a link',
        null,
        42,
      ],
      meta: [],
    })
    expect(loadLinkedState(dir).links).toEqual([good])
  })

  it('rebuilds each link field by field', () => {
    writeDoc({ v: 1, links: [{ ...link(), extra: 'dropped', linkedAt: 'yesterday' }], meta: [] })
    const [loaded] = loadLinkedState(dir).links
    expect(loaded).toEqual({ ...link(), linkedAt: 0 })
    expect(Object.keys(loaded)).not.toContain('extra')
  })

  it('keeps the first record of a repeated link id or meta ref', () => {
    writeDoc({
      v: 1,
      links: [link({ linkedAt: 1 }), link({ linkedAt: 2 })],
      meta: [meta({ name: 'first' }), meta({ name: 'second' })],
    })
    const state = loadLinkedState(dir)
    expect(state.links).toEqual([link({ linkedAt: 1 })])
    expect(state.meta).toEqual([meta({ name: 'first' })])
  })

  it('drops meta whose ref or grants are not well formed', () => {
    const good = meta()
    writeDoc({
      v: 1,
      links: [],
      meta: [
        good,
        meta({ ref: 'phone:a1b2c3d4e5f60718' }),
        meta({ ref: 'link:a1b2' }),
        { ...meta({ ref: 'device:0011223344556677' }), grants: { run: 'yes', write: false } },
        { ...meta({ ref: 'device:8899aabbccddeeff' }), grants: null },
        { ...meta({ ref: 'link:8899aabbccddeeff' }), ref: 7 },
        'meta',
        null,
      ],
    })
    expect(loadLinkedState(dir).meta).toEqual([good])
  })

  it('rebuilds meta field by field, failing closed', () => {
    writeDoc({
      v: 1,
      links: [],
      meta: [
        {
          ref: 'device:0011223344556677',
          name: '  \u001b[31mdesk\u0007  ',
          // write implies run, even when the file says otherwise
          grants: { run: false, write: true, admin: true },
          confirmed: 'true',
          linkedAt: 'later',
          phrase: PHRASE,
          extra: 1,
        },
        { ref: 'link:0011223344556677', name: '\u0000\u0001', grants: { run: false, write: false }, confirmed: true, linkedAt: 5 },
      ],
    })
    expect(loadLinkedState(dir).meta).toEqual([
      {
        ref: 'device:0011223344556677',
        name: '[31mdesk',
        grants: { run: true, write: true },
        confirmed: false,
        linkedAt: 0,
        phrase: PHRASE,
      },
      { ref: 'link:0011223344556677', name: DEFAULT_MACHINE_NAME, grants: { run: false, write: false }, confirmed: true, linkedAt: 5 },
    ])
  })

  it('keeps the safety phrase only while the link is unconfirmed, and only a real one', () => {
    writeDoc({
      v: 1,
      links: [],
      meta: [
        meta({ ref: 'device:0000000000000001', confirmed: true, phrase: PHRASE }),
        meta({ ref: 'device:0000000000000002', confirmed: false, phrase: 'acorn admiral' }),
        meta({ ref: 'device:0000000000000003', confirmed: false, phrase: PHRASE.toUpperCase() }),
        { ...meta({ ref: 'device:0000000000000004', confirmed: false }), phrase: 12 },
        meta({ ref: 'device:0000000000000005', confirmed: false, phrase: PHRASE }),
      ],
    })
    const phrases = loadLinkedState(dir).meta.map((m) => m.phrase)
    expect(phrases).toEqual([undefined, undefined, undefined, undefined, PHRASE])
  })

  it('writes only the known fields, and drops the phrase once confirmed', () => {
    setSafeStorage(null)
    saveLinkedState(dir, {
      links: [{ ...link(), extra: 'x' } as JoinedLink],
      meta: [
        { ...meta({ phrase: PHRASE }), extra: 'y' } as LinkMeta,
        { ...meta({ ref: 'device:0011223344556677', confirmed: false, phrase: PHRASE }), grants: { run: true, write: false, x: 1 } as LinkMeta['grants'] },
      ],
    })
    const doc = JSON.parse(fs.readFileSync(file(), 'utf8'))
    expect(doc).toEqual({
      v: 1,
      links: [link()],
      meta: [meta(), meta({ ref: 'device:0011223344556677', confirmed: false, phrase: PHRASE })],
    })
  })

  it('does not throw when the state cannot be written', () => {
    expect(() => saveLinkedState(path.join(dir, 'missing', 'dir'), { links: [link()], meta: [] })).not.toThrow()
    expect(() => saveLinkedState(dir, null as unknown as LinkedState)).not.toThrow()
  })
})

describe('linkedStore refs and grants', () => {
  it('turns a target into a ref and back', () => {
    expect(refOf({ via: 'device', id: 'a1b2c3d4e5f60718' })).toBe('device:a1b2c3d4e5f60718')
    expect(refOf({ via: 'link', id: 'a1b2c3d4e5f60718' })).toBe('link:a1b2c3d4e5f60718')
    expect(targetOf('device:a1b2c3d4e5f60718')).toEqual({ via: 'device', id: 'a1b2c3d4e5f60718' })
    expect(targetOf('link:a1b2c3d4e5f60718')).toEqual({ via: 'link', id: 'a1b2c3d4e5f60718' })
  })

  it('refuses a malformed ref', () => {
    for (const ref of [
      '',
      'device:',
      'link:A1B2C3D4E5F60718',
      'link:a1b2c3d4e5f6071',
      'link:a1b2c3d4e5f607180',
      'phone:a1b2c3d4e5f60718',
      ' link:a1b2c3d4e5f60718',
      'link:a1b2c3d4e5f60718 ',
      'a1b2c3d4e5f60718',
    ]) {
      expect(targetOf(ref)).toBeNull()
    }
    expect(targetOf(42 as unknown as string)).toBeNull()
    expect(targetOf(null as unknown as string)).toBeNull()
  })

  it('defaults to read-only agents', () => {
    expect(DEFAULT_GRANTS).toEqual({ run: true, write: false })
  })

  it('accepts exactly two booleans, and write implies run', () => {
    expect(normalizeGrants({ run: true, write: false })).toEqual({ run: true, write: false })
    expect(normalizeGrants({ run: false, write: false })).toEqual({ run: false, write: false })
    expect(normalizeGrants({ run: true, write: true })).toEqual({ run: true, write: true })
    // An agent that may edit files can certainly read them.
    expect(normalizeGrants({ run: false, write: true })).toEqual({ run: true, write: true })
    expect(normalizeGrants({ run: true, write: false, extra: true })).toEqual({ run: true, write: false })
  })

  it('refuses anything that is not two booleans', () => {
    for (const g of [
      null,
      undefined,
      'run',
      1,
      [],
      {},
      { run: true },
      { write: false },
      { run: 'true', write: false },
      { run: true, write: 1 },
    ]) {
      expect(normalizeGrants(g)).toBeNull()
    }
  })
})
