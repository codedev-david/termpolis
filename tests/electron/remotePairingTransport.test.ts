import { describe, it, expect } from 'vitest'
import {
  createPairingOffer,
  sealPairingHello,
  openPairingHello,
  sealPairingAck,
  openPairingAck,
  HELLO_HEADER_BYTES,
} from '../../src/main/remoteBridge/pairing'
import { generateIdentity, fromHex } from '../../src/main/remoteBridge/sealedChannel'
import {
  FRAME_PAIRING_HELLO,
  FRAME_PAIRING_ACK,
  PROTOCOL_VERSION,
  SealedSession,
  pairingRoot,
} from '../../src/main/remoteBridge/sessionCrypto'

const desktop = generateIdentity()
const phone = generateIdentity()
const impostor = generateIdentity()

function offer() {
  return createPairingOffer({
    relayUrl: 'wss://relay.test',
    desktopPublicKey: desktop.publicKey,
    now: 1_000,
  })
}

function hello(o = offer(), label = 'Pixel', secret = o.oneTimeSecret) {
  return sealPairingHello({
    deviceSecretKey: phone.secretKey,
    devicePublicKey: phone.publicKey,
    desktopPublicKey: desktop.publicKey,
    pairingId: o.pairingId,
    label,
    oneTimeSecret: secret,
  })
}

describe('pairing hello', () => {
  it('round-trips the device key, label and secret', () => {
    const o = offer()
    const opened = openPairingHello({
      desktopSecretKey: desktop.secretKey,
      pairingId: o.pairingId,
      frame: hello(o),
    })
    expect(opened).toEqual({
      devicePublicKey: phone.publicKey,
      label: 'Pixel',
      oneTimeSecret: o.oneTimeSecret,
    })
  })

  it('is tagged and carries the device key in the clear, so the desktop can read it', () => {
    // The desktop has never seen this key and cannot derive the sealing key without
    // it, so the header has to be readable. Everything that matters is in the body.
    const frame = hello()
    expect(frame[0]).toBe(FRAME_PAIRING_HELLO)
    expect(frame.slice(1, 33)).toEqual(fromHex(phone.publicKey))
  })

  it('keeps the one-time secret from the relay', () => {
    // The secret is a bearer token: anyone holding it can pair. It travels sealed to
    // the desktop's QR-published public key, so the relay -- which sees the frame and
    // the clear device key -- cannot read it and therefore cannot pair itself in.
    const o = offer()
    expect(Buffer.from(hello(o)).toString('hex')).not.toContain(o.oneTimeSecret)
  })

  it('refuses a hello sealed for a different room', () => {
    // The pairing root is salted with the pairing id, so a hello captured from one
    // offer cannot be resent into another. Nothing else changes between two offers
    // from the same desktop to the same phone -- the identity keys are the same
    // keys -- so without the salt a replayed hello would open cleanly.
    expect(() =>
      openPairingHello({
        desktopSecretKey: desktop.secretKey,
        pairingId: offer().pairingId,
        frame: hello(),
      }),
    ).toThrow()
  })

  it('refuses a hello whose clear device key was swapped', () => {
    // The device key rides in the clear because the desktop must read it to derive
    // the key. It is in the AAD, so swapping it fails Poly1305 -- a relay cannot put
    // its own key in front of an honest phone's sealed body and be paired as itself.
    const o = offer()
    const frame = hello(o)
    frame.set(fromHex(impostor.publicKey), 1)
    expect(() =>
      openPairingHello({
        desktopSecretKey: desktop.secretKey,
        pairingId: o.pairingId,
        frame,
      }),
    ).toThrow()
  })

  it('refuses a truncated frame rather than reading past its end', () => {
    // A short frame is what a hostile relay sends when it is probing for a crash.
    // Slicing 32 bytes out of a 20-byte buffer yields a SHORT key, not an error, so
    // the length check is what turns this into a protocol error rather than a
    // complaint from inside the curve library about a scalar it was handed.
    const o = offer()
    expect(() =>
      openPairingHello({
        desktopSecretKey: desktop.secretKey,
        pairingId: o.pairingId,
        frame: hello(o).slice(0, 20),
      }),
    ).toThrow(/too short/)
  })

  it('names a version mismatch rather than failing obscurely', () => {
    // The phone is a separate codebase shipped through two app stores, so an older
    // one really does arrive here. `sealPairingHello` always writes the current
    // version, so the frame is built the way that older phone would build it.
    const o = offer()
    const header = new Uint8Array(HELLO_HEADER_BYTES)
    header[0] = FRAME_PAIRING_HELLO
    header.set(fromHex(phone.publicKey), 1)
    const frame = SealedSession.fromRoot(
      pairingRoot(phone.secretKey, desktop.publicKey, o.pairingId),
      'device',
    ).seal(
      header,
      new TextEncoder().encode(
        JSON.stringify({
          v: PROTOCOL_VERSION - 1,
          label: 'Old phone',
          oneTimeSecret: o.oneTimeSecret,
        }),
      ),
    )
    expect(() =>
      openPairingHello({
        desktopSecretKey: desktop.secretKey,
        pairingId: o.pairingId,
        frame,
      }),
    ).toThrow(/unsupported pairing version 1/)
  })

  it('refuses a frame that is not a hello', () => {
    // Swapping the tag also breaks the AAD, so this frame would fail to open
    // regardless. The guard's whole contribution is saying WHY -- hence matching
    // on the message rather than on the throw.
    const o = offer()
    const frame = hello(o)
    frame[0] = 0x09
    expect(() =>
      openPairingHello({
        desktopSecretKey: desktop.secretKey,
        pairingId: o.pairingId,
        frame,
      }),
    ).toThrow(/not a pairing hello/)
  })
})

describe('pairing ack', () => {
  function ack(o = offer(), deviceId = 'abc123') {
    return sealPairingAck({
      desktopSecretKey: desktop.secretKey,
      devicePublicKey: phone.publicKey,
      pairingId: o.pairingId,
      deviceId,
    })
  }

  function open(o: ReturnType<typeof offer>, frame: Uint8Array, secretKey = phone.secretKey) {
    return openPairingAck({
      deviceSecretKey: secretKey,
      desktopPublicKey: desktop.publicKey,
      pairingId: o.pairingId,
      frame,
    })
  }

  it('round-trips the device id the desktop settled on', () => {
    const o = offer()
    expect(open(o, ack(o, 'deadbeef'))).toEqual({ deviceId: 'deadbeef' })
  })

  it('opens with a session built from scratch, as a real phone must', () => {
    // Neither end keeps the sealing session between the two pairing frames: the
    // hello is sealed and forgotten, the ack sealed and forgotten. If the ack's
    // counter were not the first on its own direction, an RN client that did not
    // hold the hello's session object would trip the replay check and pairing
    // would fail on the phone only -- with the desktop believing it succeeded.
    const o = offer()
    const frame = ack(o)
    expect(open(o, frame)).toEqual({ deviceId: 'abc123' })
    expect(open(o, frame)).toEqual({ deviceId: 'abc123' })
  })

  it('is tagged as an ack, not as a hello', () => {
    expect(ack()[0]).toBe(FRAME_PAIRING_ACK)
  })

  it('refuses a hello in the ack position', () => {
    // Both frames are sealed on the same root, so only the tag -- which is the
    // AEAD's associated data -- keeps the relay from replaying the phone's own
    // hello back at it as an acceptance.
    const o = offer()
    expect(() => open(o, hello(o))).toThrow(/not a pairing ack/)
  })

  it('cannot be opened by anyone but the phone that asked', () => {
    // The relay sees the ack and the clear device key in the hello before it. It
    // still cannot read this: the root is a Diffie-Hellman, not a transcript.
    const o = offer()
    expect(() => open(o, ack(o), impostor.secretKey)).toThrow()
  })

  it('refuses an ack minted for a different offer', () => {
    expect(() => open(offer(), ack())).toThrow()
  })

  it('refuses an ack from a phone-era it does not know', () => {
    // The desktop updates on its own schedule and the phone updates on the app
    // stores'. `sealPairingAck` always writes the current version, so the frame is
    // built the way a newer desktop would build it.
    const o = offer()
    const frame = SealedSession.fromRoot(
      pairingRoot(desktop.secretKey, phone.publicKey, o.pairingId),
      'desktop',
    ).seal(
      new Uint8Array([FRAME_PAIRING_ACK]),
      new TextEncoder().encode(JSON.stringify({ v: 3, deviceId: 'abc123' })),
    )
    expect(() => open(o, frame)).toThrow(/unsupported pairing version 3/)
  })
})
