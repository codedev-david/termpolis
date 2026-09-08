const mockStore = new Map<string, string>()
const mockOptions: Record<string, unknown>[] = []
const mockWrites: string[] = []
let mockReadThrows = false

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  getItemAsync: jest.fn(async (key: string) => {
    if (mockReadThrows) throw new Error('keychain is locked')
    return mockStore.get(key) ?? null
  }),
  setItemAsync: jest.fn(async (key: string, value: string, opts?: Record<string, unknown>) => {
    mockOptions.push({ key, value, ...opts })
    mockWrites.push(`set ${key}`)
    mockStore.set(key, value)
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockWrites.push(`delete ${key}`)
    mockStore.delete(key)
  }),
}))

import * as SecureStore from 'expo-secure-store'
import {
  addPairing,
  loadBook,
  MAX_PAIRINGS,
  newIdentity,
  publicKeyOf,
  publicPairing,
  removePairing,
  setActivePairing,
  wipeEverything,
  writePairing,
  type StoredPairing,
} from '../src/storage/identity'
import { publicKeyFor } from '../src/wire/sessionCrypto'

const INDEX_KEY = 'termpolis.remote.pairings.v2'
const RECORD_PREFIX = 'termpolis.remote.pairing.v2.'
const IDENTITY_KEY_V1 = 'termpolis.remote.identity.v1'
const PAIRED_KEY_V1 = 'termpolis.remote.paired.v1'

const SECRET = 'a'.repeat(64)
const DESK_A = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'
const DESK_B = '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20'

function pairing(over: Partial<StoredPairing> = {}): StoredPairing {
  return {
    desktopPublicKey: DESK_A,
    sessionRoomId: 'c9dc49b87f0dc983be61f034ceab7c52',
    relayUrl: 'wss://relay.termpolis.com',
    deviceId: '12faa049f0ec7720',
    label: "David's ThinkPad",
    pairedAt: 1_700_000_000_000,
    secretKey: SECRET,
    ...over,
  }
}

function storedIndex(): unknown {
  return JSON.parse(mockStore.get(INDEX_KEY) ?? 'null')
}

function put(key: string, value: unknown): void {
  mockStore.set(key, JSON.stringify(value))
}

beforeEach(() => {
  mockStore.clear()
  mockOptions.length = 0
  mockWrites.length = 0
  mockReadThrows = false
  jest.clearAllMocks()
})

describe('newIdentity', () => {
  it('mints a fresh keypair and persists nothing', async () => {
    // A key is written only alongside the record that gives it a purpose, so an
    // abandoned pairing attempt leaves nothing in the keystore behind it.
    const identity = newIdentity()
    expect(identity.secretKey).toMatch(/^[0-9a-f]{64}$/)
    expect(identity.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(identity.secretKey).not.toBe(identity.publicKey)
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
  })

  it('mints a DIFFERENT keypair every time', async () => {
    // The whole point of per-desktop keys: two desktops handed the same public
    // key can compare notes and know they are talking to one handset.
    expect(newIdentity().secretKey).not.toBe(newIdentity().secretKey)
  })
})

describe('publicPairing', () => {
  it('drops the private key', () => {
    const redacted = publicPairing(pairing())
    expect(redacted).not.toHaveProperty('secretKey')
    expect(Object.keys(redacted).sort()).toEqual([
      'desktopPublicKey',
      'deviceId',
      'label',
      'pairedAt',
      'relayUrl',
      'sessionRoomId',
    ])
  })
})

describe('publicKeyOf', () => {
  it('derives the public half rather than reading a stored one', () => {
    const identity = newIdentity()
    expect(publicKeyOf(pairing({ secretKey: identity.secretKey }))).toBe(identity.publicKey)
    expect(publicKeyOf(pairing({ secretKey: identity.secretKey }))).toBe(
      publicKeyFor(identity.secretKey),
    )
  })
})

describe('addPairing', () => {
  it('writes the record BEFORE the index names it', async () => {
    // Interrupted between the two, the keystore holds a record nothing names --
    // invisible, and overwritten the next time this desktop is paired. The other
    // order leaves the index pointing at a record that does not exist, which is
    // a row the user can tap that can never connect.
    await addPairing(pairing())
    expect(mockWrites).toEqual([`set ${RECORD_PREFIX}${DESK_A}`, `set ${INDEX_KEY}`])
  })

  it('appends to the order and makes the new desktop active', async () => {
    await addPairing(pairing())
    await addPairing(pairing({ desktopPublicKey: DESK_B }))
    expect(storedIndex()).toEqual({ v: 2, order: [DESK_A, DESK_B], active: DESK_B })
  })

  it('re-pairing a known desktop replaces its record without a second row', async () => {
    await addPairing(pairing())
    await addPairing(pairing({ desktopPublicKey: DESK_B }))
    await addPairing(pairing({ label: 'Renamed', pairedAt: 2 }))
    expect(storedIndex()).toEqual({ v: 2, order: [DESK_A, DESK_B], active: DESK_A })
    const book = await loadBook()
    expect(book.pairings.map((p) => p.label)).toEqual(['Renamed', "David's ThinkPad"])
  })

  it('copes with an index that is not there yet', async () => {
    mockStore.set(INDEX_KEY, 'not json')
    await addPairing(pairing())
    expect(storedIndex()).toEqual({ v: 2, order: [DESK_A], active: DESK_A })
  })
})

describe('writePairing', () => {
  it('stores every record as WHEN_UNLOCKED_THIS_DEVICE_ONLY', async () => {
    // The `THIS_DEVICE_ONLY` half is the load-bearing one. Without it a restored
    // iCloud keychain produces a second handset holding the same private keys --
    // two devices the desktop cannot tell apart.
    await writePairing(pairing())
    expect(mockOptions).toHaveLength(1)
    expect(mockOptions[0]?.keychainAccessible).toBe('whenUnlockedThisDeviceOnly')
  })

  it('cleans the label on the way in', async () => {
    await writePairing(pairing({ label: `  Work${String.fromCharCode(7)}shop  ` }))
    expect(JSON.parse(mockStore.get(RECORD_PREFIX + DESK_A) ?? '{}').label).toBe('Workshop')
  })

  it('writes the fields it knows and no others', async () => {
    // Wire format section 7.5: the one-time secret is discarded the moment the
    // hello is sealed. Rebuilding the record field by field is what stops one
    // riding along in a value that picked it up somewhere upstream.
    await writePairing({
      ...pairing(),
      oneTimeSecret: 'must-not-persist',
    } as unknown as StoredPairing)
    const raw = mockStore.get(RECORD_PREFIX + DESK_A) ?? ''
    expect(raw).not.toContain('must-not-persist')
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'desktopPublicKey',
      'deviceId',
      'label',
      'pairedAt',
      'relayUrl',
      'secretKey',
      'sessionRoomId',
    ])
  })

  it('leaves the index alone, which is what makes renaming cheap', async () => {
    await addPairing(pairing())
    mockWrites.length = 0
    await writePairing(pairing({ label: 'Renamed' }))
    expect(mockWrites).toEqual([`set ${RECORD_PREFIX}${DESK_A}`])
  })
})

describe('loadBook', () => {
  it('reads back what was written, in pairing order', async () => {
    await addPairing(pairing())
    await addPairing(pairing({ desktopPublicKey: DESK_B, label: 'Linux box' }))
    const book = await loadBook()
    expect(book.pairings.map((p) => p.desktopPublicKey)).toEqual([DESK_A, DESK_B])
    expect(book.pairings.map((p) => p.label)).toEqual(["David's ThinkPad", 'Linux box'])
    expect(book.active).toBe(DESK_B)
  })

  it('keeps the private key, which the store needs and no screen sees', async () => {
    await addPairing(pairing())
    expect((await loadBook()).pairings[0]?.secretKey).toBe(SECRET)
  })

  it('drops a row the index names but the keystore no longer holds', async () => {
    // The phone could not authenticate to that desktop if it tried, so drawing
    // the row would be offering a button that cannot work.
    await addPairing(pairing())
    await addPairing(pairing({ desktopPublicKey: DESK_B }))
    mockStore.delete(RECORD_PREFIX + DESK_B)
    const book = await loadBook()
    expect(book.pairings.map((p) => p.desktopPublicKey)).toEqual([DESK_A])
    expect(book.active).toBe(DESK_A)
  })

  it('drops a record filed under one desktop that claims to be another', async () => {
    // Not reachable through this module's own writers. It is reachable through
    // a keystore someone has edited, and a record that lies about which desktop
    // it belongs to would send this phone's key to the wrong machine.
    put(INDEX_KEY, { v: 2, order: [DESK_A], active: DESK_A })
    put(RECORD_PREFIX + DESK_A, pairing({ desktopPublicKey: DESK_B }))
    expect(await loadBook()).toEqual({ pairings: [], active: null })
  })

  it('falls back to the first desktop when the active one failed to load', async () => {
    // A phone that opens on the pair screen while three desktops are stored has
    // lost them as far as its owner can tell.
    await addPairing(pairing())
    await addPairing(pairing({ desktopPublicKey: DESK_B }))
    mockStore.delete(RECORD_PREFIX + DESK_B)
    expect((await loadBook()).active).toBe(DESK_A)
  })

  it('treats a locked keychain as a phone with nothing stored', async () => {
    // SecureStore throws on a locked keychain and this runs at launch, before
    // any screen exists to catch it. A throw here is an app that will not start.
    await addPairing(pairing())
    mockReadThrows = true
    expect(await loadBook()).toEqual({ pairings: [], active: null })
  })

  it('treats an unreadable index as no index', async () => {
    mockStore.set(INDEX_KEY, '{ this is not json')
    expect(await loadBook()).toEqual({ pairings: [], active: null })
  })

  it.each([
    ['a string', '"nope"'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a v1-shaped index', JSON.stringify({ v: 1, order: [DESK_A], active: DESK_A })],
    ['an index with no order', JSON.stringify({ v: 2, active: DESK_A })],
  ])('refuses an index that is %s', async (_name, raw) => {
    mockStore.set(INDEX_KEY, raw)
    put(RECORD_PREFIX + DESK_A, pairing())
    expect((await loadBook()).pairings).toEqual([])
  })

  it('de-duplicates the order', async () => {
    // A duplicate would draw the same desktop twice and would let one removal
    // leave the other copy naming a record that has just been deleted.
    put(INDEX_KEY, { v: 2, order: [DESK_A, DESK_A], active: DESK_A })
    put(RECORD_PREFIX + DESK_A, pairing())
    expect((await loadBook()).pairings).toHaveLength(1)
  })

  it('ignores entries in the order that are not desktop keys', async () => {
    put(INDEX_KEY, { v: 2, order: [42, 'short', DESK_A, null], active: DESK_A })
    put(RECORD_PREFIX + DESK_A, pairing())
    expect((await loadBook()).pairings.map((p) => p.desktopPublicKey)).toEqual([DESK_A])
  })

  it('clamps a too-long order, and does not keep an active key it just trimmed', async () => {
    const keys = Array.from({ length: MAX_PAIRINGS + 4 }, (_, i) =>
      i.toString(16).padStart(2, '0').repeat(32),
    )
    for (const key of keys) put(RECORD_PREFIX + key, pairing({ desktopPublicKey: key }))
    put(INDEX_KEY, { v: 2, order: keys, active: keys[MAX_PAIRINGS + 1] })
    const book = await loadBook()
    expect(book.pairings).toHaveLength(MAX_PAIRINGS)
    expect(book.active).toBe(keys[0])
  })

  it('holds the ceiling at sixteen', async () => {
    // Pinned because it is a number other suites inline rather than import --
    // the store's mock of this module carries its own copy, and a ceiling that
    // drifted apart between the two would be tested against itself.
    expect(MAX_PAIRINGS).toBe(16)
  })

  it('drops an active key that names no stored desktop', async () => {
    put(INDEX_KEY, { v: 2, order: [DESK_A], active: DESK_B })
    put(RECORD_PREFIX + DESK_A, pairing())
    expect((await loadBook()).active).toBe(DESK_A)
  })

  it.each([
    ['is not an object', '"nope"'],
    ['is an array', '[]'],
    ['has a short desktop key', JSON.stringify(pairing({ desktopPublicKey: 'abc' }))],
    ['has no room id', JSON.stringify({ ...pairing(), sessionRoomId: 'xyz' })],
    ['has an empty relay url', JSON.stringify({ ...pairing(), relayUrl: '' })],
    ['has a malformed device id', JSON.stringify({ ...pairing(), deviceId: 'zz' })],
    ['has a non-string label', JSON.stringify({ ...pairing(), label: 7 })],
    ['has no paired-at', JSON.stringify({ ...pairing(), pairedAt: 'yesterday' })],
    ['has an infinite paired-at', JSON.stringify({ ...pairing(), pairedAt: null })],
    ['has a truncated private key', JSON.stringify({ ...pairing(), secretKey: 'aa' })],
  ])('refuses a record that %s', async (_name, raw) => {
    put(INDEX_KEY, { v: 2, order: [DESK_A], active: DESK_A })
    mockStore.set(RECORD_PREFIX + DESK_A, raw)
    expect(await loadBook()).toEqual({ pairings: [], active: null })
  })
})

describe('removePairing', () => {
  it('rewrites the index BEFORE deleting the record', async () => {
    // Between the two writes the pairing is invisible rather than
    // named-but-missing, and the key is gone by the end either way.
    await addPairing(pairing())
    await addPairing(pairing({ desktopPublicKey: DESK_B }))
    mockWrites.length = 0
    await removePairing(DESK_A, DESK_B)
    expect(mockWrites).toEqual([`set ${INDEX_KEY}`, `delete ${RECORD_PREFIX}${DESK_A}`])
  })

  it('erases the key as well as the row, which is what unpairing promises', async () => {
    await addPairing(pairing())
    await addPairing(pairing({ desktopPublicKey: DESK_B }))
    await removePairing(DESK_A, DESK_B)
    expect(mockStore.has(RECORD_PREFIX + DESK_A)).toBe(false)
    const book = await loadBook()
    expect(book.pairings.map((p) => p.desktopPublicKey)).toEqual([DESK_B])
    expect(book.active).toBe(DESK_B)
  })

  it('leaves the other desktops paired', async () => {
    await addPairing(pairing())
    await addPairing(pairing({ desktopPublicKey: DESK_B }))
    await removePairing(DESK_A, DESK_B)
    expect((await loadBook()).pairings[0]?.secretKey).toBe(SECRET)
  })

  it('copes with an index that cannot be read', async () => {
    put(RECORD_PREFIX + DESK_A, pairing())
    mockStore.set(INDEX_KEY, 'not json')
    await removePairing(DESK_A, null)
    expect(storedIndex()).toEqual({ v: 2, order: [], active: null })
    expect(mockStore.has(RECORD_PREFIX + DESK_A)).toBe(false)
  })

  it('picks a surviving desktop when handed an active key it just removed', async () => {
    await addPairing(pairing())
    await addPairing(pairing({ desktopPublicKey: DESK_B }))
    await removePairing(DESK_B, DESK_B)
    expect(storedIndex()).toEqual({ v: 2, order: [DESK_A], active: DESK_A })
  })
})

describe('setActivePairing', () => {
  it('remembers which desktop is on screen without touching the records', async () => {
    await addPairing(pairing())
    await addPairing(pairing({ desktopPublicKey: DESK_B }))
    mockWrites.length = 0
    await setActivePairing(DESK_A)
    expect(mockWrites).toEqual([`set ${INDEX_KEY}`])
    expect((await loadBook()).active).toBe(DESK_A)
  })

  it('refuses to remember a desktop that is not in the list', async () => {
    await addPairing(pairing())
    await setActivePairing(DESK_B)
    expect(storedIndex()).toEqual({ v: 2, order: [DESK_A], active: DESK_A })
  })

  it('copes with an index that cannot be read', async () => {
    await setActivePairing(DESK_A)
    expect(storedIndex()).toEqual({ v: 2, order: [], active: null })
  })
})

describe('wipeEverything', () => {
  it('deletes the index first, then every record it named', async () => {
    // Interrupted, what is left is orphaned records no code path can reach,
    // rather than an index pointing at keys that are already gone.
    await addPairing(pairing())
    await addPairing(pairing({ desktopPublicKey: DESK_B }))
    mockWrites.length = 0
    await wipeEverything()
    expect(mockWrites).toEqual([
      `delete ${INDEX_KEY}`,
      `delete ${RECORD_PREFIX}${DESK_A}`,
      `delete ${RECORD_PREFIX}${DESK_B}`,
      `delete ${PAIRED_KEY_V1}`,
      `delete ${IDENTITY_KEY_V1}`,
    ])
    expect(mockStore.size).toBe(0)
  })

  it('still clears the v1 keys when there is no index at all', async () => {
    put(PAIRED_KEY_V1, { desktopPublicKey: DESK_A })
    put(IDENTITY_KEY_V1, { secretKey: SECRET })
    await wipeEverything()
    expect(mockStore.size).toBe(0)
  })
})

describe('migrating a 1.39 install', () => {
  function v1(): void {
    put(PAIRED_KEY_V1, {
      desktopPublicKey: DESK_A,
      sessionRoomId: 'c9dc49b87f0dc983be61f034ceab7c52',
      relayUrl: 'wss://relay.termpolis.com',
      deviceId: '12faa049f0ec7720',
      label: "David's ThinkPad",
      pairedAt: 1_700_000_000_000,
    })
    put(IDENTITY_KEY_V1, { secretKey: SECRET })
  }

  it('carries the one desktop, and its key, into the new format', async () => {
    v1()
    const book = await loadBook()
    expect(book.active).toBe(DESK_A)
    expect(book.pairings).toEqual([pairing()])
  })

  it('deletes the v1 keys, so the phone does not hold two copies of its authority', async () => {
    // Leaving them would mean unpairing -- which erases the v2 copy -- quietly
    // leaves the other behind. The cost is that a downgrade to 1.39 arrives
    // unpaired, which is not a route a store-installed app can take.
    v1()
    await loadBook()
    expect(mockStore.has(PAIRED_KEY_V1)).toBe(false)
    expect(mockStore.has(IDENTITY_KEY_V1)).toBe(false)
  })

  it('writes the v2 record and index before deleting the v1 keys', async () => {
    v1()
    await loadBook()
    expect(mockWrites).toEqual([
      `set ${RECORD_PREFIX}${DESK_A}`,
      `set ${INDEX_KEY}`,
      `delete ${PAIRED_KEY_V1}`,
      `delete ${IDENTITY_KEY_V1}`,
    ])
  })

  it('runs exactly once, because the index is written either way', async () => {
    v1()
    await loadBook()
    mockWrites.length = 0
    const book = await loadBook()
    expect(book.pairings).toHaveLength(1)
    expect(mockWrites).toEqual([])
  })

  it('takes both halves or neither', async () => {
    // A record whose key is gone is a phone that believes it is paired and fails
    // every handshake with nothing on screen to explain it.
    v1()
    mockStore.delete(IDENTITY_KEY_V1)
    expect((await loadBook()).pairings).toEqual([])
  })

  it('ignores a key with no pairing, which is just an app that has been opened', async () => {
    put(IDENTITY_KEY_V1, { secretKey: SECRET })
    expect(await loadBook()).toEqual({ pairings: [], active: null })
  })

  it.each([
    ['is not an object', '"nope"'],
    ['is an array', '[]'],
    ['has a truncated key', JSON.stringify({ secretKey: 'aa' })],
    ['has no key at all', JSON.stringify({})],
  ])('refuses a v1 identity that %s', async (_name, raw) => {
    put(PAIRED_KEY_V1, {
      desktopPublicKey: DESK_A,
      sessionRoomId: 'c9dc49b87f0dc983be61f034ceab7c52',
      relayUrl: 'wss://relay.termpolis.com',
      deviceId: '12faa049f0ec7720',
      label: 'Old',
      pairedAt: 1,
    })
    mockStore.set(IDENTITY_KEY_V1, raw)
    expect((await loadBook()).pairings).toEqual([])
  })

  it('leaves a fresh install with nothing, and does not come back for it', async () => {
    expect(await loadBook()).toEqual({ pairings: [], active: null })
    expect(storedIndex()).toEqual({ v: 2, order: [], active: null })
  })
})
