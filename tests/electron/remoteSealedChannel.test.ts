import { describe, it, expect } from 'vitest'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { generateIdentity, SealedChannel, deriveVerificationPhrase } from '../../src/main/remoteBridge/sealedChannel'

const enc = new TextEncoder()
const dec = new TextDecoder()

describe('SealedChannel', () => {
  it('round-trips a message between two peers', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const ac = new SealedChannel(a.secretKey, b.publicKey)
    const bc = new SealedChannel(b.secretKey, a.publicKey)

    const frame = ac.seal(enc.encode('hello agent'))
    expect(dec.decode(bc.open(frame))).toBe('hello agent')
  })

  it('produces a different ciphertext each time (nonce is not reused)', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const ac = new SealedChannel(a.secretKey, b.publicKey)

    const one = ac.seal(enc.encode('same'))
    const two = ac.seal(enc.encode('same'))
    expect(Buffer.from(one).toString('hex')).not.toBe(Buffer.from(two).toString('hex'))
  })

  it('rejects a tampered frame rather than returning garbage', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const ac = new SealedChannel(a.secretKey, b.publicKey)
    const bc = new SealedChannel(b.secretKey, a.publicKey)

    const frame = ac.seal(enc.encode('transfer 10'))
    frame[frame.length - 1] ^= 0xff
    expect(() => bc.open(frame)).toThrow()
  })

  it('rejects a frame from a third party', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const evil = generateIdentity()
    const ec = new SealedChannel(evil.secretKey, b.publicKey)
    const bc = new SealedChannel(b.secretKey, a.publicKey)

    expect(() => bc.open(ec.seal(enc.encode('malicious')))).toThrow()
  })

  it('refuses a replayed frame', () => {
    // The attack this exists to stop: capture one sealed `run_command` off the wire
    // and send it again. The tag still verifies -- authenticity alone accepts it.
    const a = generateIdentity()
    const b = generateIdentity()
    const send = new SealedChannel(a.secretKey, b.publicKey)
    const recv = new SealedChannel(b.secretKey, a.publicKey)
    const frame = send.seal(new TextEncoder().encode('run_command rm -rf /'))

    expect(new TextDecoder().decode(recv.open(frame))).toBe('run_command rm -rf /')
    expect(() => recv.open(frame)).toThrow(/replay/i)
  })

  it('refuses a frame delivered out of order', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const send = new SealedChannel(a.secretKey, b.publicKey)
    const recv = new SealedChannel(b.secretKey, a.publicKey)
    const first = send.seal(new TextEncoder().encode('one'))
    const second = send.seal(new TextEncoder().encode('two'))

    // Deliver the second frame first; the first is then stale and must be refused
    // rather than silently applied after the command that superseded it.
    expect(new TextDecoder().decode(recv.open(second))).toBe('two')
    expect(() => recv.open(first)).toThrow(/replay/i)
  })

  it('accepts a long run of frames in order', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const send = new SealedChannel(a.secretKey, b.publicKey)
    const recv = new SealedChannel(b.secretKey, a.publicKey)
    for (let i = 0; i < 500; i++) {
      const text = `frame ${i}`
      expect(new TextDecoder().decode(recv.open(send.seal(new TextEncoder().encode(text))))).toBe(text)
    }
  })

  it('keeps each direction on its own counter', () => {
    // Both peers start sending at 0. If the two directions shared a high-water mark,
    // the first inbound frame would look like a replay of the first outbound one.
    const a = generateIdentity()
    const b = generateIdentity()
    const ca = new SealedChannel(a.secretKey, b.publicKey)
    const cb = new SealedChannel(b.secretKey, a.publicKey)
    expect(new TextDecoder().decode(cb.open(ca.seal(new TextEncoder().encode('a->b'))))).toBe('a->b')
    expect(new TextDecoder().decode(ca.open(cb.seal(new TextEncoder().encode('b->a'))))).toBe('b->a')
  })

  it('rejects a frame too short to hold a counter', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const send = new SealedChannel(a.secretKey, b.publicKey)
    const recv = new SealedChannel(b.secretKey, a.publicKey)
    // Seal an empty plaintext, then strip the counter from inside the ciphertext by
    // re-sealing a deliberately short payload with the same key.
    const short = send.seal(new Uint8Array(0))
    expect(() => recv.open(short.subarray(0, 4))).toThrow()
  })

  it('derives the same verification phrase regardless of argument order', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    expect(deriveVerificationPhrase(a.publicKey, b.publicKey))
      .toBe(deriveVerificationPhrase(b.publicKey, a.publicKey))
  })

  it('derives a 6-word phrase that differs for different peers', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const c = generateIdentity()
    const phrase = deriveVerificationPhrase(a.publicKey, b.publicKey)
    expect(phrase.split(' ')).toHaveLength(6)
    expect(phrase).not.toBe(deriveVerificationPhrase(a.publicKey, c.publicKey))
  })

  it('counts the frames it has sealed', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const ch = new SealedChannel(a.secretKey, b.publicKey)
    expect(ch.sentFrames).toBe(0)
    ch.seal(new TextEncoder().encode('one'))
    ch.seal(new TextEncoder().encode('two'))
    // This is the rekey trigger: the counter is 48 bits wide, so the channel has to
    // be able to say how close it is before the host decides to rotate keys.
    expect(ch.sentFrames).toBe(2)
  })

  // A frame that authenticates but carries fewer bytes than the counter header.
  // Only a peer holding the key can produce one, so this is not an outsider attack
  // -- it is a buggy or downgraded client, and reading the counter off the end of
  // the buffer would hand back a garbage sequence number that poisons replay state.
  it('refuses an authentic frame too short to hold a counter', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const sender = new SealedChannel(a.secretKey, b.publicKey)
    const receiver = new SealedChannel(b.secretKey, a.publicKey)

    // Forge a frame the receiver's key accepts, whose plaintext is 1 byte.
    const good = sender.seal(new Uint8Array([1, 2, 3]))
    const nonce = good.subarray(0, 12)
    const ct = chacha20poly1305(sha256(x25519.getSharedSecret(hexToBytes(a.secretKey), hexToBytes(b.publicKey))), nonce)
      .encrypt(new Uint8Array([9]))
    const short = new Uint8Array(nonce.length + ct.length)
    short.set(nonce, 0)
    short.set(ct, nonce.length)

    expect(() => receiver.open(short)).toThrow(/truncated/)
  })
})
