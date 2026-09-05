import { describe, it, expect } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import {
  COUNTER_BYTES,
  SEAL_OVERHEAD_BYTES,
  deriveVerificationPhrase,
  fromHex,
  toHex,
} from '../../src/main/remoteBridge/sealedChannel'
import {
  FRAME_KEEPALIVE,
  FRAME_PAIRING_ACK,
  FRAME_PAIRING_HELLO,
  FRAME_SESSION,
  FRAME_SESSION_HELLO,
  GREETING_HEADER_BYTES,
  Handshake,
  PROTOCOL_VERSION,
  SESSION_HEADER_BYTES,
  deriveSessionRoomId,
  pairingRoot,
} from '../../src/main/remoteBridge/sessionCrypto'
import {
  HELLO_HEADER_BYTES,
  PairingSession,
  createPairingOffer,
  openPairingAck,
  openPairingHello,
  sealPairingAck,
  sealPairingHello,
} from '../../src/main/remoteBridge/pairing'
import { RELAY_MAX_FRAME_BYTES } from '../../src/main/remoteBridge/protocol'

/**
 * The normative vectors behind `docs/remote-wire-format.md`.
 *
 * The phone is a SECOND implementation of this protocol, in another language
 * runtime, shipped through two app stores on its own schedule. Nothing else in
 * this suite would catch a change both ends of THIS codebase make together:
 * rename an HKDF info string, reverse the salt sort, swap the two direction
 * keys, and every other test still passes while every shipped phone stops
 * talking to every shipped desktop -- silently, with no error either end can
 * show, because a frame that fails to open and a frame that never arrives look
 * identical from the outside.
 *
 * So each literal below is a byte-for-byte commitment. They were generated once
 * from this implementation and pasted in; the point is not that they are right
 * today but that they cannot change unnoticed. If one of these fails, the
 * question is never "what is the new value" -- it is whether the wire format
 * just broke compatibility with a phone already in someone's pocket.
 *
 * Every pinned frame is also OPENED here, against the counterpart half of the
 * implementation. A vector asserted only as a hex string would still pass if
 * both the sealer and the literal drifted to something that decodes to garbage.
 */

/** Fixed identities. Production draws these at random; only vectors pin them. */
const DESKTOP_SK = '11'.repeat(32)
const DEVICE_SK = '22'.repeat(32)
/** Fixed ephemerals. `Handshake` accepts these for exactly this reason. */
const DESKTOP_EPH = '33'.repeat(32)
const DEVICE_EPH = '44'.repeat(32)
const PAIRING_ID = '0123456789abcdef0123456789abcdef'
const ONE_TIME_SECRET = 'aa'.repeat(32)
/** Not arbitrary: this is what `PairingSession.accept` derives from `DEVICE_PK`,
 *  pinned below. The ack vector carries it so the whole worked example is
 *  self-consistent — a porter can compute this id and reproduce those bytes. */
const DEVICE_ID = '12faa049f0ec7720'

const DESKTOP_PK = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'
const DEVICE_PK = '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)
const pub = (sk: string) => toHex(x25519.getPublicKey(fromHex(sk)))

describe('wire vectors: constants', () => {
  it('pins the frame tags', () => {
    // A renumber is the cheapest possible break and the hardest to see: the
    // desktop would keep talking to itself perfectly.
    expect([
      FRAME_KEEPALIVE,
      FRAME_PAIRING_HELLO,
      FRAME_PAIRING_ACK,
      FRAME_SESSION_HELLO,
      FRAME_SESSION,
    ]).toEqual([0x00, 0x01, 0x02, 0x03, 0x04])
  })

  it('pins the header and overhead widths', () => {
    // These decide where a receiver starts reading and how much a payload costs
    // against the relay's cap. A porter that gets one wrong sees an AEAD failure
    // and blames its crypto library.
    expect(SESSION_HEADER_BYTES).toBe(1)
    expect(GREETING_HEADER_BYTES).toBe(33)
    expect(HELLO_HEADER_BYTES).toBe(33)
    expect(COUNTER_BYTES).toBe(6)
    expect(SEAL_OVERHEAD_BYTES).toBe(22)
    expect(RELAY_MAX_FRAME_BYTES).toBe(1_048_576)
  })

  it('pins the protocol version', () => {
    // Both ends refuse a payload that names any other number, so this IS the
    // compatibility boundary rather than a label near it.
    expect(PROTOCOL_VERSION).toBe(2)
  })

  it('derives the pinned public keys from the pinned secrets', () => {
    expect(pub(DESKTOP_SK)).toBe(DESKTOP_PK)
    expect(pub(DEVICE_SK)).toBe(DEVICE_PK)
  })

  it('pins the keepalive frame', () => {
    // One byte, unsealed, the same every time. Worth pinning precisely because
    // there is nothing in it: a port that "improves" it into a sealed frame
    // would have its keepalives reach the greeting path and cost it the socket.
    expect(toHex(new Uint8Array([FRAME_KEEPALIVE]))).toBe('00')
  })
})

describe('wire vectors: pairing', () => {
  it('pins the QR payload shape', () => {
    // The phone's scanner parses this before it holds any key at all, so the
    // field names are as load-bearing as any ciphertext below.
    const offer = createPairingOffer({
      relayUrl: 'wss://relay.termpolis.com',
      desktopPublicKey: DESKTOP_PK,
      now: 1_700_000_000_000,
    })
    const qr = JSON.parse(offer.qrPayload)
    expect(Object.keys(qr).sort()).toEqual([
      'desktopPublicKey',
      'oneTimeSecret',
      'pairingId',
      'relayUrl',
      'v',
    ])
    // The QR envelope versions separately from the frames inside it: it is read
    // by a scanner that has not yet decided whether it can speak to this desktop.
    expect(qr.v).toBe(1)
    expect(qr.relayUrl).toBe('wss://relay.termpolis.com')
    expect(qr.desktopPublicKey).toBe(DESKTOP_PK)
    expect(qr.pairingId).toMatch(/^[0-9a-f]{32}$/)
    expect(qr.oneTimeSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(offer.expiresAt).toBe(1_700_000_000_000 + 90_000)
  })

  it('pins the pairing root', () => {
    // Salted with the pairing id, so a hello sealed for one offer is useless
    // against the next. Both ends must salt it identically or the hello simply
    // fails to open, with nothing on screen to say why.
    expect(toHex(pairingRoot(DEVICE_SK, DESKTOP_PK, PAIRING_ID))).toBe(
      '4bc2d5c4a6e0afc1271ef4bc1d5abbadcdbd6c8ab1d20580a76fcf84c7413762',
    )
    expect(toHex(pairingRoot(DESKTOP_SK, DEVICE_PK, PAIRING_ID))).toBe(
      '4bc2d5c4a6e0afc1271ef4bc1d5abbadcdbd6c8ab1d20580a76fcf84c7413762',
    )
  })

  const hello = (label: string) =>
    sealPairingHello({
      deviceSecretKey: DEVICE_SK,
      devicePublicKey: DEVICE_PK,
      desktopPublicKey: DESKTOP_PK,
      pairingId: PAIRING_ID,
      label,
      oneTimeSecret: ONE_TIME_SECRET,
    })

  it('pins the phone hello', () => {
    const frame = hello('Pixel 9 Pro')
    expect(toHex(frame)).toBe(
      '010faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f2000000000000020' +
        '81553da47997d20ba9ead687b5284bc29952a3fa91efcff877f847813c9b10cddd32a7d112f4ee6' +
        '45add4095efbc5f45797dcacdd271e925ecab97466b3a7ecb3fba9bd3cd247ce0f2ea6ee5313cf1' +
        '323e3e5fd8f54fafcad27a09d5b774cb629d9953544b558a9e8c8f35157d4a630821b9da811a465' +
        'aa39c3d02029d4a58',
    )
    // The clear header is the tag and the device key, in that order, and it is
    // also the AEAD's associated data -- which is why a relay cannot substitute
    // its own key here and be paired as itself.
    expect(frame[0]).toBe(FRAME_PAIRING_HELLO)
    expect(toHex(frame.subarray(1, HELLO_HEADER_BYTES))).toBe(DEVICE_PK)

    expect(
      openPairingHello({ desktopSecretKey: DESKTOP_SK, pairingId: PAIRING_ID, frame }),
    ).toEqual({
      devicePublicKey: DEVICE_PK,
      label: 'Pixel 9 Pro',
      oneTimeSecret: ONE_TIME_SECRET,
    })
  })

  it('pins a hello whose label is not ASCII', () => {
    // The payload is UTF-8 before it is sealed. A React Native runtime whose
    // TextEncoder shim writes UTF-16, or escapes non-ASCII the way some JSON
    // encoders do, produces a frame that opens fine and then shows the user a
    // mangled device name in Settings forever -- it is stored at pairing time.
    const frame = hello('Téléphone — 9')
    expect(toHex(frame)).toBe(
      '010faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f2000000000000020' +
        '81553da47997d20ba9ead687b5284bc63383aa5518a687c76bf2454f9e605e91ab77e8db2ff4d97' +
        'f52cc31caaeaf5b503a2689cdd271e925ecab97466b3a7ecb3fba9bd3cd247ce0f2ea6ee5313cf1' +
        '323e3e5fd8f54fafcad27a09d5b774cb629d9953544b558a9e8c8f35157d097f09908f284212b23' +
        '62736c1792e001968ccad6b75b8b2',
    )
    expect(
      openPairingHello({ desktopSecretKey: DESKTOP_SK, pairingId: PAIRING_ID, frame }).label,
    ).toBe('Téléphone — 9')
    // Three bytes for the em dash, two for each accented vowel: 13 characters,
    // 17 bytes. Spelled out so the intent survives a copy-paste of the literal.
    expect(bytes('Téléphone — 9').length).toBe(17)
  })

  it('pins the desktop ack', () => {
    const frame = sealPairingAck({
      desktopSecretKey: DESKTOP_SK,
      devicePublicKey: DEVICE_PK,
      pairingId: PAIRING_ID,
      deviceId: DEVICE_ID,
    })
    expect(toHex(frame)).toBe(
      '02000000000000d58c0735797b5b7a4a055b26fff0cb3cc88c3a055e9452feee281c91e91cd4859f' +
        '6c24be770d00f17470eb1a8f69659a9cccb79167',
    )
    // Sealed on a session built fresh from the pairing root, so its counter is
    // the FIRST on the desktop-to-phone direction. That is what lets the phone
    // open it without having kept the session it sealed its own hello with.
    expect(toHex(frame.subarray(1, 1 + COUNTER_BYTES))).toBe('000000000000')
    expect(
      openPairingAck({
        deviceSecretKey: DEVICE_SK,
        desktopPublicKey: DESKTOP_PK,
        pairingId: PAIRING_ID,
        frame,
      }),
    ).toEqual({ deviceId: DEVICE_ID })
  })

  it('pins what a pairing produces', () => {
    // The device id is the desktop's stable handle for this phone, and the phone
    // reads it out of the ack. It is a hash of the public key HEX STRING, not of
    // the key bytes -- a port that hashes the bytes gets a different id for the
    // same phone, and the two ends then disagree about who is connected.
    const session = new PairingSession(
      {
        pairingId: PAIRING_ID,
        oneTimeSecret: ONE_TIME_SECRET,
        qrPayload: '',
        expiresAt: 1_700_000_090_000,
      },
      DESKTOP_PK,
      DESKTOP_SK,
    )
    const { device, verificationPhrase } = session.accept({
      oneTimeSecret: ONE_TIME_SECRET,
      devicePublicKey: DEVICE_PK,
      label: 'Pixel 9 Pro',
      now: 1_700_000_000_000,
    })
    expect(device.id).toBe(DEVICE_ID)
    expect(device.sessionRoomId).toBe('c9dc49b87f0dc983be61f034ceab7c52')
    expect(verificationPhrase).toBe('hurdle desert ember kelp velvet tundra thicket pebble')
    // Every capability off. A freshly paired phone can do nothing at all until
    // the user grants it something.
    expect(device.capabilities).toEqual({
      read: false,
      createTerminal: false,
      writeToTerminal: false,
      closeTerminal: false,
    })
  })

  it('pins the safety number', () => {
    // Both ends render this and the user compares them, which is the only thing
    // standing between a malicious relay and a MITM. A port that sorts the keys
    // differently, or joins them without the colon, shows eight plausible words
    // that never match -- and a user who sees a mismatch blames the app.
    const phrase = 'hurdle desert ember kelp velvet tundra thicket pebble'
    expect(deriveVerificationPhrase(DESKTOP_PK, DEVICE_PK)).toBe(phrase)
    expect(deriveVerificationPhrase(DEVICE_PK, DESKTOP_PK)).toBe(phrase)
  })

  it('pins the derived session room', () => {
    // Never announced and never in a QR: both ends compute it from keys they
    // already hold. A port that changed the HKDF label would not fail a
    // handshake -- it would sit alone in a room forever, and the only symptom
    // would be a phone that never connects.
    const room = 'c9dc49b87f0dc983be61f034ceab7c52'
    expect(deriveSessionRoomId(DESKTOP_SK, DEVICE_PK)).toBe(room)
    expect(deriveSessionRoomId(DEVICE_SK, DESKTOP_PK)).toBe(room)
  })
})

describe('wire vectors: session', () => {
  const pair = () => ({
    d: new Handshake({
      ownSecretKey: DESKTOP_SK,
      peerPublicKey: DEVICE_PK,
      role: 'desktop',
      ephemeralSecretKey: DESKTOP_EPH,
    }),
    p: new Handshake({
      ownSecretKey: DEVICE_SK,
      peerPublicKey: DESKTOP_PK,
      role: 'device',
      ephemeralSecretKey: DEVICE_EPH,
    }),
  })

  it('pins both greetings', () => {
    const { d, p } = pair()
    expect(toHex(d.greeting)).toBe(
      '037b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b140000000000004e' +
        '3e2c52e1bf5db5275ed739c1ccf1213e2f439b8c85808d50840539048ec50df4560e0deed81054',
    )
    expect(toHex(p.greeting)).toBe(
      '03ff2ee45601ec1b67310c7790404585ae697331eee1c1f8cf2419731c1fff3e6b000000000000ff' +
        '9d3f9caf2252eda92794b52a8c84ca560016a24ef17718cc2a72c02262d859e881a5d8aac2a7',
    )
    // Tag, then the sender's EPHEMERAL public key -- not its identity key. The
    // identity key is what seals the greeting, so accepting one already proves
    // identity; the ephemeral is what makes the session forward-secret.
    expect(d.greeting[0]).toBe(FRAME_SESSION_HELLO)
    expect(toHex(d.greeting.subarray(1, GREETING_HEADER_BYTES))).toBe(pub(DESKTOP_EPH))
    expect(toHex(p.greeting.subarray(1, GREETING_HEADER_BYTES))).toBe(pub(DEVICE_EPH))
  })

  it('pins the first frames in both directions', () => {
    const { d, p } = pair()
    const ds = d.accept(p.greeting)
    const ps = p.accept(d.greeting)
    const H = new Uint8Array([FRAME_SESSION])

    const down0 = ds.seal(H, bytes('{"kind":"ok","id":1,"data":null}'))
    const down1 = ds.seal(H, bytes('{"kind":"ok","id":2,"data":null}'))
    const up0 = ps.seal(H, bytes('{"id":1,"request":{"kind":"listTerminals"}}'))

    expect(toHex(down0)).toBe(
      '04000000000000bffaf517d1df8789618e3ca2997945eb3c91937be39b360bc1d86dde6043cc98d7' +
        '9abd82e8c05592fb9c34e8ef0eda17',
    )
    // Same key, next counter. Pinned alongside the first so a port that redraws
    // a nonce per frame, or restarts the counter, fails here rather than in the
    // field on the second message of a session.
    expect(toHex(down1)).toBe(
      '040000000000019998de6962497e05e699698a3766a6ad231ccaeb5675e77ca4d60e9d98df86e2e4' +
        '9323a050c5f1de4d2bb87724832b94',
    )
    // Counter 0 again: the two directions carry independent counters, because
    // they are sealed under different keys.
    expect(toHex(up0)).toBe(
      '040000000000008ef9a596d3ee7d5353b7dc6bd3da2d8b8fe43237783a9dd938d9f78c66625218cd' +
        '005aed0b0eb419434def65dc31ab9cf5236ed96dd3df0856d36c',
    )

    // Opened by the OTHER end, in order -- the receive side is strictly
    // increasing, so this also pins that down1 is accepted after down0.
    expect(text(ps.open(down0, SESSION_HEADER_BYTES))).toBe('{"kind":"ok","id":1,"data":null}')
    expect(text(ps.open(down1, SESSION_HEADER_BYTES))).toBe('{"kind":"ok","id":2,"data":null}')
    expect(text(ds.open(up0, SESSION_HEADER_BYTES))).toBe(
      '{"id":1,"request":{"kind":"listTerminals"}}',
    )
  })
})
