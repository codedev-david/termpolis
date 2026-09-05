const mockStore = new Map<string, string>()
const mockOptions: Record<string, unknown>[] = []

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string, opts?: Record<string, unknown>) => {
    mockOptions.push({ key, value, ...opts })
    mockStore.set(key, value)
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key)
  }),
}))

import * as SecureStore from 'expo-secure-store'
import {
  clearPaired,
  loadIdentity,
  loadPaired,
  savePaired,
  wipeIdentity,
  type PairedDesktop,
} from '../src/storage/identity'

const DESKTOP: PairedDesktop = {
  desktopPublicKey: '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13',
  sessionRoomId: 'c9dc49b87f0dc983be61f034ceab7c52',
  relayUrl: 'wss://relay.termpolis.com',
  deviceId: '12faa049f0ec7720',
  label: "David's ThinkPad",
  pairedAt: 1_700_000_000_000,
}

beforeEach(() => {
  mockStore.clear()
  mockOptions.length = 0
  jest.clearAllMocks()
})

describe('loadIdentity', () => {
  it('mints and persists a keypair on the first call', async () => {
    const identity = await loadIdentity()
    expect(identity.secretKey).toMatch(/^[0-9a-f]{64}$/)
    expect(identity.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(identity.secretKey).not.toBe(identity.publicKey)
    expect(SecureStore.setItemAsync).toHaveBeenCalled()
  })

  it('returns the same keypair thereafter, without writing again', async () => {
    // The private key IS this phone's authority. Minting a second one silently
    // unpairs the device: the desktop still trusts a key the phone no longer has,
    // and the user is told nothing.
    const first = await loadIdentity()
    jest.clearAllMocks()
    const second = await loadIdentity()
    expect(second).toEqual(first)
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
  })

  it('stores the private key as WHEN_UNLOCKED_THIS_DEVICE_ONLY', async () => {
    // THIS_DEVICE_ONLY keeps it out of an iCloud keychain backup. Without it,
    // restoring a backup onto a second handset produces two devices the desktop
    // cannot tell apart -- and revoking one does not revoke the other.
    await loadIdentity()
    for (const call of mockOptions) {
      expect(call.keychainAccessible).toBe(SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY)
    }
    expect(mockOptions.length).toBeGreaterThan(0)
  })

  it('mints a different keypair on a phone that has none', async () => {
    const first = await loadIdentity()
    mockStore.clear()
    expect((await loadIdentity()).publicKey).not.toBe(first.publicKey)
  })

  it('mints a fresh keypair rather than trusting a corrupt stored one', async () => {
    // A truncated key is not a key. Using one produces a phone that fails every
    // handshake with no explanation available to the user.
    for (const junk of ['', 'not hex', 'aa', 'ff'.repeat(31), `${'ff'.repeat(32)}00`]) {
      mockStore.clear()
      mockStore.set('termpolis.remote.identity.v1', JSON.stringify({ secretKey: junk }))
      const identity = await loadIdentity()
      expect(identity.secretKey).toMatch(/^[0-9a-f]{64}$/)
      expect(identity.secretKey).not.toBe(junk)
    }
  })

  it('mints a fresh keypair when the stored record is not JSON', async () => {
    mockStore.set('termpolis.remote.identity.v1', '{ truncated')
    expect((await loadIdentity()).secretKey).toMatch(/^[0-9a-f]{64}$/)
  })

  it('derives the public key rather than storing it', async () => {
    // Storing both invites them to disagree. The public key is a pure function of
    // the private one, and a disagreement would be a phone that greets under one
    // identity and is trusted under another.
    const identity = await loadIdentity()
    const stored = JSON.parse(mockStore.get('termpolis.remote.identity.v1') as string)
    expect(stored.publicKey).toBeUndefined()
    expect(stored.secretKey).toBe(identity.secretKey)
  })
})

describe('the paired desktop', () => {
  it('round-trips', async () => {
    await savePaired(DESKTOP)
    expect(await loadPaired()).toEqual(DESKTOP)
  })

  it('returns null when nothing is paired', async () => {
    expect(await loadPaired()).toBeNull()
  })

  it('returns null rather than throwing on a corrupt record', async () => {
    // A throw here happens at app launch, before any screen exists to catch it.
    // Null means the pair screen; a throw means a phone that will not start.
    for (const junk of ['{ truncated', 'null', '42', '[]', '{}', '{"desktopPublicKey":"zz"}']) {
      mockStore.set('termpolis.remote.paired.v1', junk)
      expect(await loadPaired()).toBeNull()
    }
  })

  it('returns null when a stored record is missing a field it needs', async () => {
    const { sessionRoomId: _omitted, ...incomplete } = DESKTOP
    mockStore.set('termpolis.remote.paired.v1', JSON.stringify(incomplete))
    expect(await loadPaired()).toBeNull()
  })

  it('stores the pairing as THIS_DEVICE_ONLY too', async () => {
    // The session room id is the address of a live connection to someone's
    // desktop. It has no business in a cloud backup either.
    await savePaired(DESKTOP)
    expect(mockOptions.at(-1)?.keychainAccessible).toBe(SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY)
  })

  it('replaces a previous pairing rather than accumulating', async () => {
    await savePaired(DESKTOP)
    await savePaired({ ...DESKTOP, label: 'The other machine' })
    expect((await loadPaired())?.label).toBe('The other machine')
  })
})

describe('unpairing', () => {
  it('clearPaired forgets the desktop and keeps the identity', async () => {
    // Unpairing must not mint a new key. The desktop still lists this device, and
    // re-pairing from the same identity is what lets the user see it is the same
    // phone rather than a second entry they have to reason about.
    const identity = await loadIdentity()
    await savePaired(DESKTOP)
    await clearPaired()

    expect(await loadPaired()).toBeNull()
    expect(await loadIdentity()).toEqual(identity)
  })

  it('wipeIdentity removes both', async () => {
    await loadIdentity()
    await savePaired(DESKTOP)
    await wipeIdentity()

    expect(await loadPaired()).toBeNull()
    expect(mockStore.size).toBe(0)
  })

  it('wipeIdentity on a phone that never paired is harmless', async () => {
    await expect(wipeIdentity()).resolves.toBeUndefined()
  })
})

describe('what must never be written', () => {
  it('never persists the one-time secret', async () => {
    // Wire format section 7.5: the phone discards it the moment the hello is
    // sealed. It is single-use and it is the only thing that would let a
    // recovered backup replay a pairing.
    const oneTimeSecret = 'aa'.repeat(32)
    await loadIdentity()
    await savePaired(DESKTOP)
    for (const value of mockStore.values()) {
      expect(value).not.toContain(oneTimeSecret)
    }
    for (const call of mockOptions) {
      expect(String(call.value)).not.toContain(oneTimeSecret)
    }
  })

  it('has no field that could carry one', async () => {
    await savePaired(DESKTOP)
    const stored = JSON.parse(mockStore.get('termpolis.remote.paired.v1') as string)
    expect(Object.keys(stored).sort()).toEqual(
      ['desktopPublicKey', 'deviceId', 'label', 'pairedAt', 'relayUrl', 'sessionRoomId'],
    )
  })

  it('survives a keystore that refuses to read', async () => {
    // SecureStore throws on a locked keychain. At launch that is an app that will
    // not start, which is a worse outcome than showing the pair screen.
    ;(SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error('keychain locked'))
    expect(await loadPaired()).toBeNull()
  })
})

describe('every field of a stored pairing is checked, not just the keys', () => {
  // The record comes back from the OS keystore, which is less a threat model
  // than a place where an older build's format survives an upgrade. Each of
  // these would otherwise reach a screen or the relay as the wrong thing: an
  // empty relayUrl dials nothing, a malformed deviceId is not the handle the
  // user revokes by, and a non-finite pairedAt renders as "Infinity" in the
  // device list.
  const BAD: [string, Record<string, unknown>][] = [
    ['a relayUrl that is not a string', { relayUrl: 42 }],
    ['an empty relayUrl', { relayUrl: '' }],
    ['a deviceId that is not a string', { deviceId: 42 }],
    ['a deviceId that is not 16 hex characters', { deviceId: 'not hex' }],
    ['a label that is not a string', { label: 42 }],
    ['a pairedAt that is not a number', { pairedAt: 'yesterday' }],
  ]

  it.each(BAD)('refuses a record with %s', async (_name, override) => {
    mockStore.set('termpolis.remote.paired.v1', JSON.stringify({ ...DESKTOP, ...override }))
    expect(await loadPaired()).toBeNull()
  })

  it('refuses a pairedAt that parses to Infinity', async () => {
    // Not reachable through JSON.stringify, which writes non-finite numbers as
    // null -- but 1e999 in the stored text parses straight to Infinity, and a
    // record written by a build that did the arithmetic differently would say
    // exactly that.
    const json = JSON.stringify(DESKTOP).replace(`"pairedAt":${DESKTOP.pairedAt}`, '"pairedAt":1e999')
    expect(JSON.parse(json).pairedAt).toBe(Number.POSITIVE_INFINITY)
    mockStore.set('termpolis.remote.paired.v1', json)
    expect(await loadPaired()).toBeNull()
  })

  it('still accepts the record all of those were built from', async () => {
    // Without this the table above would pass just as well against a validator
    // that refused everything.
    mockStore.set('termpolis.remote.paired.v1', JSON.stringify(DESKTOP))
    expect(await loadPaired()).toEqual(DESKTOP)
  })
})
