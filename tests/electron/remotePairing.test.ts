import { describe, it, expect } from 'vitest'
import { createPairingOffer, PairingSession } from '../../src/main/remoteBridge/pairing'
import { generateIdentity, PHRASE_WORDS } from '../../src/main/remoteBridge/sealedChannel'
import { deriveSessionRoomId } from '../../src/main/remoteBridge/sessionCrypto'
import { NO_CAPABILITIES } from '../../src/main/remoteBridge/protocol'

const desktop = generateIdentity()
const phone = generateIdentity()

function offer(now = 1_000) {
  return createPairingOffer({ relayUrl: 'wss://relay.test', desktopPublicKey: desktop.publicKey, now })
}

function session(o = offer()) {
  return new PairingSession(o, desktop.publicKey, desktop.secretKey)
}

describe('pairing', () => {
  it('builds a QR payload carrying relay, pairing id and desktop key', () => {
    const parsed = JSON.parse(offer().qrPayload)
    expect(parsed.relayUrl).toBe('wss://relay.test')
    expect(parsed.desktopPublicKey).toBe(desktop.publicKey)
    expect(parsed.pairingId).toBeTruthy()
    expect(parsed.oneTimeSecret).toBeTruthy()
  })

  it('expires 90 seconds out by default', () => {
    expect(offer(1_000).expiresAt).toBe(1_000 + 90_000)
  })

  it('accepts a device presenting the correct secret', () => {
    const o = offer()
    const s = session(o)
    const { device } = s.accept({
      oneTimeSecret: o.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'Pixel', now: 1_500,
    })
    expect(device.label).toBe('Pixel')
    expect(device.publicKey).toBe(phone.publicKey)
    expect(device.capabilities).toEqual(NO_CAPABILITIES)
  })

  it('returns a verification phrase both ends can compare', () => {
    const o = offer()
    const s = session(o)
    const { verificationPhrase } = s.accept({
      oneTimeSecret: o.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'Pixel', now: 1_500,
    })
    expect(verificationPhrase.split(' ')).toHaveLength(PHRASE_WORDS)
  })

  it('rejects a wrong secret', () => {
    const o = offer()
    const s = session(o)
    expect(() => s.accept({
      oneTimeSecret: 'nope', devicePublicKey: phone.publicKey, label: 'Evil', now: 1_500,
    })).toThrow(/secret/i)
  })

  it('is single-use — a second accept fails even with the right secret', () => {
    const o = offer()
    const s = session(o)
    s.accept({ oneTimeSecret: o.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'A', now: 1_500 })
    expect(() => s.accept({
      oneTimeSecret: o.oneTimeSecret, devicePublicKey: generateIdentity().publicKey, label: 'B', now: 1_600,
    })).toThrow(/used/i)
  })

  it('rejects after expiry', () => {
    const o = offer(1_000)
    const s = session(o)
    expect(() => s.accept({
      oneTimeSecret: o.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'Late', now: 1_000 + 90_001,
    })).toThrow(/expired/i)
  })

  it('derives distinct device ids for distinct keys', () => {
    const oa = offer()
    const one = session(oa).accept({ oneTimeSecret: oa.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'A', now: 1_500 })
    const ob = offer()
    const two = session(ob).accept({ oneTimeSecret: ob.oneTimeSecret, devicePublicKey: generateIdentity().publicKey, label: 'B', now: 1_500 })
    expect(one.device.id).not.toBe(two.device.id)
  })

  it('gives the device a session room that never appeared in the QR', () => {
    const o = offer()
    const { device } = session(o).accept({
      oneTimeSecret: o.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'Pixel', now: 1_500,
    })
    // The pairing id is on screen for anyone with a camera, and a room name is
    // not a credential: knowing it is enough to take the `device` seat and leave
    // the real phone looping on a 409 it cannot explain. So the room the pair
    // actually meets in must not be the one that was photographed.
    expect(device.sessionRoomId).not.toBe(o.pairingId)
    expect(o.qrPayload).not.toContain(device.sessionRoomId)
    // The phone computes the same id from what it already holds. It is derived,
    // never announced -- there is no frame an eavesdropper could read it from.
    expect(device.sessionRoomId).toBe(deriveSessionRoomId(phone.secretKey, desktop.publicKey))
  })

  it('sends the same phone back to the same room when it re-pairs', () => {
    const o1 = offer()
    const first = session(o1).accept({
      oneTimeSecret: o1.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'Pixel', now: 1_500,
    })
    const o2 = offer(2_000)
    const again = session(o2).accept({
      oneTimeSecret: o2.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'Pixel', now: 2_500,
    })
    // Two offers, two pairing ids, one room -- because the room is a function of
    // the two identities and neither changed. A phone that re-pairs after a
    // desktop restart walks back into the room the desktop is already sitting in.
    expect(o2.pairingId).not.toBe(o1.pairingId)
    // Pinned, or the comparison below passes on two undefineds.
    expect(first.device.sessionRoomId).toMatch(/^[0-9a-f]{32}$/)
    expect(again.device.sessionRoomId).toBe(first.device.sessionRoomId)
  })

  it('puts a phone that re-pairs with a new keypair in a new room', () => {
    const o1 = offer()
    const first = session(o1).accept({
      oneTimeSecret: o1.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'Pixel', now: 1_500,
    })
    const o2 = offer(2_000)
    const rekeyed = session(o2).accept({
      oneTimeSecret: o2.oneTimeSecret, devicePublicKey: generateIdentity().publicKey, label: 'Pixel', now: 2_500,
    })
    expect(rekeyed.device.sessionRoomId).not.toBe(first.device.sessionRoomId)
  })
})
