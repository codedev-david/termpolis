import { describe, it, expect } from 'vitest'
import { createPairingOffer, PairingSession } from '../../src/main/remoteBridge/pairing'
import { generateIdentity } from '../../src/main/remoteBridge/sealedChannel'
import { NO_CAPABILITIES } from '../../src/main/remoteBridge/protocol'

const desktop = generateIdentity()
const phone = generateIdentity()

function offer(now = 1_000) {
  return createPairingOffer({ relayUrl: 'wss://relay.test', desktopPublicKey: desktop.publicKey, now })
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
    const s = new PairingSession(o, desktop.publicKey)
    const { device } = s.accept({
      oneTimeSecret: o.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'Pixel', now: 1_500,
    })
    expect(device.label).toBe('Pixel')
    expect(device.publicKey).toBe(phone.publicKey)
    expect(device.capabilities).toEqual(NO_CAPABILITIES)
  })

  it('returns a verification phrase both ends can compare', () => {
    const o = offer()
    const s = new PairingSession(o, desktop.publicKey)
    const { verificationPhrase } = s.accept({
      oneTimeSecret: o.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'Pixel', now: 1_500,
    })
    expect(verificationPhrase.split(' ')).toHaveLength(6)
  })

  it('rejects a wrong secret', () => {
    const o = offer()
    const s = new PairingSession(o, desktop.publicKey)
    expect(() => s.accept({
      oneTimeSecret: 'nope', devicePublicKey: phone.publicKey, label: 'Evil', now: 1_500,
    })).toThrow(/secret/i)
  })

  it('is single-use — a second accept fails even with the right secret', () => {
    const o = offer()
    const s = new PairingSession(o, desktop.publicKey)
    s.accept({ oneTimeSecret: o.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'A', now: 1_500 })
    expect(() => s.accept({
      oneTimeSecret: o.oneTimeSecret, devicePublicKey: generateIdentity().publicKey, label: 'B', now: 1_600,
    })).toThrow(/used/i)
  })

  it('rejects after expiry', () => {
    const o = offer(1_000)
    const s = new PairingSession(o, desktop.publicKey)
    expect(() => s.accept({
      oneTimeSecret: o.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'Late', now: 1_000 + 90_001,
    })).toThrow(/expired/i)
  })

  it('derives distinct device ids for distinct keys', () => {
    const a = new PairingSession(offer(), desktop.publicKey)
    const oa = offer()
    const sa = new PairingSession(oa, desktop.publicKey)
    const one = sa.accept({ oneTimeSecret: oa.oneTimeSecret, devicePublicKey: phone.publicKey, label: 'A', now: 1_500 })
    const ob = offer()
    const sb = new PairingSession(ob, desktop.publicKey)
    const two = sb.accept({ oneTimeSecret: ob.oneTimeSecret, devicePublicKey: generateIdentity().publicKey, label: 'B', now: 1_500 })
    expect(one.device.id).not.toBe(two.device.id)
    void a
  })
})
