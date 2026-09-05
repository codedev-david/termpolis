import { fromHex, toHex, utf8Encode } from '../src/wire/bytes'
import {
  deriveSessionRoomId,
  FRAME_KEEPALIVE,
  FRAME_PAIRING_ACK,
  FRAME_PAIRING_HELLO,
  FRAME_SESSION,
  FRAME_SESSION_HELLO,
  generateIdentity,
  GREETING_HEADER_BYTES,
  Handshake,
  pairingRoot,
  SESSION_HEADER_BYTES,
  sessionFromRoot,
} from '../src/wire/sessionCrypto'

// Wire format section 12. Production draws all of these at random; they are
// fixed here so the bytes below are reproducible.
const DESKTOP_ID_SK = '11'.repeat(32)
const DEVICE_ID_SK = '22'.repeat(32)
const DESKTOP_EPH_SK = '33'.repeat(32)
const DEVICE_EPH_SK = '44'.repeat(32)
const PAIRING_ID = '0123456789abcdef0123456789abcdef'

const DESKTOP_ID_PK = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'
const DEVICE_ID_PK = '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20'
const SESSION_ROOM_ID = 'c9dc49b87f0dc983be61f034ceab7c52'
const PAIRING_ROOT = '4bc2d5c4a6e0afc1271ef4bc1d5abbadcdbd6c8ab1d20580a76fcf84c7413762'

const DESKTOP_HELLO =
  '037b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b140000000000004e' +
  '3e2c52e1bf5db5275ed739c1ccf1213e2f439b8c85808d50840539048ec50df4560e0deed81054'
const DEVICE_HELLO =
  '03ff2ee45601ec1b67310c7790404585ae697331eee1c1f8cf2419731c1fff3e6b000000000000ff' +
  '9d3f9caf2252eda92794b52a8c84ca560016a24ef17718cc2a72c02262d859e881a5d8aac2a7'

const D2P_0 =
  '04000000000000bffaf517d1df8789618e3ca2997945eb3c91937be39b360bc1d86dde6043cc98d7' +
  '9abd82e8c05592fb9c34e8ef0eda17'
const D2P_1 =
  '040000000000019998de6962497e05e699698a3766a6ad231ccaeb5675e77ca4d60e9d98df86e2e4' +
  '9323a050c5f1de4d2bb87724832b94'
const P2D_0 =
  '040000000000008ef9a596d3ee7d5353b7dc6bd3da2d8b8fe43237783a9dd938d9f78c66625218cd' +
  '005aed0b0eb419434def65dc31ab9cf5236ed96dd3df0856d36c'

describe('frame tags', () => {
  it('are the five the desktop dispatches on', () => {
    expect(FRAME_KEEPALIVE).toBe(0x00)
    expect(FRAME_PAIRING_HELLO).toBe(0x01)
    expect(FRAME_PAIRING_ACK).toBe(0x02)
    expect(FRAME_SESSION_HELLO).toBe(0x03)
    expect(FRAME_SESSION).toBe(0x04)
  })

  it('fix the two header widths', () => {
    expect(GREETING_HEADER_BYTES).toBe(33)
    expect(SESSION_HEADER_BYTES).toBe(1)
  })
})

describe('identity', () => {
  it('derives the golden public keys from the golden secrets', () => {
    // Recomputing these is the first thing a port should get right: none of them
    // cross the wire as an input.
    expect(fromHex(DESKTOP_ID_SK)).toHaveLength(32)
    expect(new Handshake('desktop', DESKTOP_ID_SK, DEVICE_ID_PK, DESKTOP_EPH_SK).ownPublicKey).toBe(
      DESKTOP_ID_PK,
    )
    expect(new Handshake('device', DEVICE_ID_SK, DESKTOP_ID_PK, DEVICE_EPH_SK).ownPublicKey).toBe(
      DEVICE_ID_PK,
    )
  })

  it('generates a fresh 32-byte keypair', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    expect(a.secretKey).toMatch(/^[0-9a-f]{64}$/)
    expect(a.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(a.secretKey).not.toBe(b.secretKey)
    expect(a.publicKey).not.toBe(b.publicKey)
  })
})

describe('deriveSessionRoomId', () => {
  it('matches the golden vector from either side', () => {
    expect(deriveSessionRoomId(DESKTOP_ID_SK, DEVICE_ID_PK)).toBe(SESSION_ROOM_ID)
    expect(deriveSessionRoomId(DEVICE_ID_SK, DESKTOP_ID_PK)).toBe(SESSION_ROOM_ID)
  })

  it('is exactly the 32 hex characters the relay room-id pattern wants', () => {
    // A port that got this wrong would not fail a handshake. It would sit in an
    // empty room forever, and the only symptom would be a phone that never
    // connects.
    expect(deriveSessionRoomId(DEVICE_ID_SK, DESKTOP_ID_PK)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('differs for a different peer', () => {
    expect(deriveSessionRoomId(DEVICE_ID_SK, generateIdentity().publicKey)).not.toBe(SESSION_ROOM_ID)
  })
})

describe('pairingRoot', () => {
  it('matches the golden vector from either side', () => {
    expect(toHex(pairingRoot(DESKTOP_ID_SK, DEVICE_ID_PK, PAIRING_ID))).toBe(PAIRING_ROOT)
    expect(toHex(pairingRoot(DEVICE_ID_SK, DESKTOP_ID_PK, PAIRING_ID))).toBe(PAIRING_ROOT)
  })

  it('is bound to the pairing id, so a hello does not replay into the next offer', () => {
    // The identity keys have not changed between offers. Without this binding a
    // captured hello replays into every subsequent offer the same desktop shows.
    const next = pairingRoot(DEVICE_ID_SK, DESKTOP_ID_PK, 'f'.repeat(32))
    expect(toHex(next)).not.toBe(PAIRING_ROOT)
  })
})

describe('sessionFromRoot', () => {
  const root = new Uint8Array(32).fill(0x55)

  it('gives the two roles opposite directions', () => {
    // Getting this backwards does not throw. It produces a session that seals
    // frames the peer cannot open and opens nothing, on a socket that stays
    // connected and looks healthy throughout.
    const desktop = sessionFromRoot(root, 'desktop')
    const device = sessionFromRoot(root, 'device')
    const frame = desktop.seal(Uint8Array.from([FRAME_SESSION]), utf8Encode('ping'))
    expect(device.open(frame, 1)).toEqual(utf8Encode('ping'))
  })

  it('gives two sessions of the same role no way to talk to each other', () => {
    const one = sessionFromRoot(root, 'device')
    const two = sessionFromRoot(root, 'device')
    expect(two.open(one.seal(Uint8Array.from([FRAME_SESSION]), utf8Encode('ping')), 1)).toBeNull()
  })
})

describe('the session handshake', () => {
  function desktop(): Handshake {
    return new Handshake('desktop', DESKTOP_ID_SK, DEVICE_ID_PK, DESKTOP_EPH_SK)
  }
  function device(): Handshake {
    return new Handshake('device', DEVICE_ID_SK, DESKTOP_ID_PK, DEVICE_EPH_SK)
  }

  it('produces the golden greetings byte for byte', () => {
    expect(toHex(desktop().greeting())).toBe(DESKTOP_HELLO)
    expect(toHex(device().greeting())).toBe(DEVICE_HELLO)
  })

  it('tags the greeting 0x03 and carries the ephemeral public key in the header', () => {
    const g = desktop().greeting()
    expect(g[0]).toBe(FRAME_SESSION_HELLO)
    expect(g.length).toBeGreaterThan(GREETING_HEADER_BYTES)
  })

  it('lets each side accept the other, reaching the same session root', () => {
    const d = desktop()
    const p = device()
    // Both greetings are in flight at once -- neither end can know who spoke
    // first, which is why the salt sorts the ephemeral keys.
    const dGreeting = d.greeting()
    const pGreeting = p.greeting()
    const dSession = d.accept(pGreeting)
    const pSession = p.accept(dGreeting)
    expect(dSession).not.toBeNull()
    expect(pSession).not.toBeNull()
    const frame = dSession!.seal(Uint8Array.from([FRAME_SESSION]), utf8Encode('same root'))
    expect(pSession!.open(frame, 1)).toEqual(utf8Encode('same root'))
  })

  it('produces the golden session frames, the two directions counting independently', () => {
    const d = desktop()
    const p = device()
    const dGreeting = d.greeting()
    const pGreeting = p.greeting()
    const dSession = d.accept(pGreeting)!
    const pSession = p.accept(dGreeting)!
    const header = Uint8Array.from([FRAME_SESSION])

    expect(toHex(dSession.seal(header, utf8Encode('{"kind":"ok","id":1,"data":null}')))).toBe(D2P_0)
    expect(toHex(dSession.seal(header, utf8Encode('{"kind":"ok","id":2,"data":null}')))).toBe(D2P_1)
    // Counter 0 again on a session that has sealed nothing: a shared counter
    // would have put this at 2.
    const req = utf8Encode('{"id":1,"request":{"kind":"listTerminals"}}')
    expect(toHex(pSession.seal(header, req))).toBe(P2D_0)
  })

  it('refuses a greeting shorter than the header', () => {
    expect(desktop().accept(new Uint8Array(GREETING_HEADER_BYTES - 1))).toBeNull()
    expect(desktop().accept(new Uint8Array(0))).toBeNull()
  })

  it('refuses a greeting whose tag is not 0x03', () => {
    const g = device().greeting()
    g[0] = FRAME_SESSION
    expect(desktop().accept(g)).toBeNull()
  })

  it('refuses a greeting sealed under a different identity', () => {
    // This is the authentication step: the root is derived from DH over the two
    // identity keys, so opening one is already proof of who sealed it.
    const stranger = generateIdentity()
    const impostor = new Handshake('device', stranger.secretKey, DESKTOP_ID_PK, DEVICE_EPH_SK)
    expect(desktop().accept(impostor.greeting())).toBeNull()
  })

  it('refuses a peer that seals with your own direction key', () => {
    // A handshake that claims 'desktop' derives the same handshake root -- the
    // identity DH is symmetric -- but seals with d2p, which is the key the
    // desktop opens WITH, not the one it opens against. It fails at the AEAD,
    // one step before the role check ever runs.
    const other = new Handshake('desktop', DEVICE_ID_SK, DESKTOP_ID_PK, DEVICE_EPH_SK)
    const d = desktop()
    expect(d.accept(other.greeting())).toBeNull()
    expect(d.lastRejection).toBe('unauthenticated')
  })

  it('refuses a correctly sealed greeting that lies about its role', () => {
    // Reachable only by a peer sealing with the right direction key, so the role
    // check is defence in depth behind the AEAD rather than the first line.
    const liar = new Handshake('device', DEVICE_ID_SK, DESKTOP_ID_PK, DEVICE_EPH_SK)
    const d = desktop()
    expect(d.accept(liar.greetingWithPayload(JSON.stringify({ v: 2, role: 'desktop' })))).toBeNull()
    expect(d.lastRejection).toBe('role')
  })

  it('reports a version mismatch distinguishably from a decryption failure', () => {
    // An old phone against a new desktop must be able to say so. Letting a
    // changed payload shape surface as an unexplained decryption failure is how
    // that turns into an unactionable bug report.
    const p = new Handshake('device', DEVICE_ID_SK, DESKTOP_ID_PK, DEVICE_EPH_SK, 99)
    const d = desktop()
    expect(d.accept(p.greeting())).toBeNull()
    expect(d.lastRejection).toBe('version')
  })

  it('distinguishes each rejection reason', () => {
    const d = desktop()
    d.accept(new Uint8Array(4))
    expect(d.lastRejection).toBe('too-short')

    const g = device().greeting()
    g[0] = FRAME_SESSION
    d.accept(g)
    expect(d.lastRejection).toBe('wrong-tag')

    const stranger = generateIdentity()
    d.accept(new Handshake('device', stranger.secretKey, DESKTOP_ID_PK, DEVICE_EPH_SK).greeting())
    expect(d.lastRejection).toBe('unauthenticated')

    const liar = new Handshake('device', DEVICE_ID_SK, DESKTOP_ID_PK, DEVICE_EPH_SK)
    d.accept(liar.greetingWithPayload(JSON.stringify({ v: 2, role: 'desktop' })))
    expect(d.lastRejection).toBe('role')

    expect(d.accept(device().greeting())).not.toBeNull()
    expect(d.lastRejection).toBeNull()
  })

  it('refuses a greeting whose payload is not JSON', () => {
    // Reached only by a peer holding the identity key, so this is a bug rather
    // than an attack -- but it must not throw out of the message handler.
    const d = desktop()
    const forged = new Handshake('device', DEVICE_ID_SK, DESKTOP_ID_PK, DEVICE_EPH_SK)
    expect(() => d.accept(forged.greetingWithPayload('not json'))).not.toThrow()
    expect(d.lastRejection).toBe('malformed')
  })

  it('refuses a greeting whose payload is JSON but not an object', () => {
    const d = desktop()
    const forged = new Handshake('device', DEVICE_ID_SK, DESKTOP_ID_PK, DEVICE_EPH_SK)
    expect(d.accept(forged.greetingWithPayload('"device"'))).toBeNull()
    expect(d.lastRejection).toBe('malformed')
  })

  it('can greet and accept on the same object', () => {
    // Build a FRESH handshake-root session for the seal and for the open. They
    // are independent counters that both start at zero; reusing one object makes
    // the second operation fail.
    const d = desktop()
    d.greeting()
    expect(d.accept(device().greeting())).not.toBeNull()
  })

  it('generates a fresh ephemeral key when none is supplied', () => {
    const a = new Handshake('device', DEVICE_ID_SK, DESKTOP_ID_PK)
    const b = new Handshake('device', DEVICE_ID_SK, DESKTOP_ID_PK)
    expect(toHex(a.greeting().subarray(1, 33))).not.toBe(toHex(b.greeting().subarray(1, 33)))
  })
})
