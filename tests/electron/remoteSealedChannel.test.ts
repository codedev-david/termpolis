import { describe, it, expect } from 'vitest'
import {
  generateIdentity,
  SealedDirection,
  SEAL_OVERHEAD_BYTES,
  deriveVerificationPhrase,
  PHRASE_WORDS,
} from '../../src/main/remoteBridge/sealedChannel'
import { SAFETY_WORDS } from '../../src/main/remoteBridge/wordlist'

const enc = new TextEncoder()
const dec = new TextDecoder()

const key = (fill = 7) => new Uint8Array(32).fill(fill)
/** A one-byte header, standing in for a SESSION frame's type tag. */
const H = new Uint8Array([0x04])

describe('SealedDirection', () => {
  it('round-trips through a direction holding the same key', () => {
    const tx = new SealedDirection(key())
    const rx = new SealedDirection(key())
    expect(dec.decode(rx.open(tx.seal(H, enc.encode('hello agent')), 1))).toBe('hello agent')
  })

  it('costs exactly SEAL_OVERHEAD_BYTES beyond the header and plaintext', () => {
    // The output chunker budgets against this number. If it drifts, frames cross
    // the relay's 1 MiB ceiling -- and the relay CUTS the connection rather than
    // truncating the frame, which reads to a user as an unreliable network.
    const tx = new SealedDirection(key())
    expect(tx.seal(H, new Uint8Array(0)).length).toBe(H.length + SEAL_OVERHEAD_BYTES)
    expect(tx.seal(H, new Uint8Array(100)).length).toBe(H.length + 100 + SEAL_OVERHEAD_BYTES)
  })

  it('derives the nonce from the counter, so identical plaintexts differ', () => {
    // A fixed nonce would be catastrophic and a random one wastes 12 bytes per
    // frame. The counter is unique under a key because a key seals in exactly one
    // direction -- a structural guarantee, with no birthday bound to reason about.
    const tx = new SealedDirection(key())
    expect(Buffer.from(tx.seal(H, enc.encode('same'))).toString('hex'))
      .not.toBe(Buffer.from(tx.seal(H, enc.encode('same'))).toString('hex'))
  })

  it('rejects a tampered frame rather than returning garbage', () => {
    const frame = new SealedDirection(key()).seal(H, enc.encode('transfer 10'))
    frame[frame.length - 1] ^= 0xff
    expect(() => new SealedDirection(key()).open(frame, 1)).toThrow()
  })

  it('rejects a frame whose header was altered', () => {
    // The header sits outside the ciphertext because the receiver must read it to
    // know which key to try. Feeding it to the AEAD as associated data is what
    // stops that from being a hole: flipping a SESSION tag to a HANDSHAKE tag
    // must fail authentication, not be reinterpreted as a different frame type.
    const frame = new SealedDirection(key()).seal(H, enc.encode('hello'))
    frame[0] = 0x03
    expect(() => new SealedDirection(key()).open(frame, 1)).toThrow()
  })

  it('rejects a frame whose counter was altered', () => {
    // The counter is outside the ciphertext too, but it derives the nonce -- so
    // raising it makes decryption fail and lowering it trips the replay check.
    const frame = new SealedDirection(key()).seal(H, enc.encode('hello'))
    frame[H.length + 5] = 0x7f
    expect(() => new SealedDirection(key()).open(frame, 1)).toThrow()
  })

  it('rejects a frame sealed under a different key', () => {
    const evil = new SealedDirection(key(9)).seal(H, enc.encode('malicious'))
    expect(() => new SealedDirection(key()).open(evil, 1)).toThrow()
  })

  it('refuses a replayed frame', () => {
    // The attack this exists to stop: capture one sealed `run_command` off the
    // wire and send it again. The tag still verifies -- authenticity alone
    // accepts it, so the counter is what makes each frame usable exactly once.
    const tx = new SealedDirection(key())
    const rx = new SealedDirection(key())
    const frame = tx.seal(H, enc.encode('run_command rm -rf /'))

    expect(dec.decode(rx.open(frame, 1))).toBe('run_command rm -rf /')
    expect(() => rx.open(frame, 1)).toThrow(/replay/i)
  })

  it('refuses a frame delivered out of order', () => {
    const tx = new SealedDirection(key())
    const rx = new SealedDirection(key())
    const first = tx.seal(H, enc.encode('one'))
    const second = tx.seal(H, enc.encode('two'))

    // Deliver the second first; the first is then stale and must be refused
    // rather than silently applied after the command that superseded it.
    expect(dec.decode(rx.open(second, 1))).toBe('two')
    expect(() => rx.open(first, 1)).toThrow(/replay/i)
  })

  it('does not advance its high-water mark on a frame that fails to open', () => {
    // Advancing before the tag verifies would let anyone walk the counter forward
    // with garbage and deafen the peer permanently -- a denial of service that
    // needs no key at all.
    const tx = new SealedDirection(key())
    const rx = new SealedDirection(key())
    tx.seal(H, enc.encode('skipped'))
    tx.seal(H, enc.encode('skipped'))
    const third = tx.seal(H, enc.encode('third'))
    const forged = Uint8Array.from(third)
    forged[forged.length - 1] ^= 0xff

    expect(() => rx.open(forged, 1)).toThrow()
    expect(dec.decode(rx.open(third, 1))).toBe('third')
  })

  it('accepts a long run of frames in order', () => {
    const tx = new SealedDirection(key())
    const rx = new SealedDirection(key())
    for (let i = 0; i < 500; i++) {
      const text = `frame ${i}`
      expect(dec.decode(rx.open(tx.seal(H, enc.encode(text)), 1))).toBe(text)
    }
  })

  it('rejects a frame too short to hold a counter and a tag', () => {
    // Reading a counter off the end of the buffer hands back a garbage sequence
    // number that poisons replay state for every frame after it.
    const rx = new SealedDirection(key())
    expect(() => rx.open(new Uint8Array([1, 2, 3]), 1)).toThrow(/short/)
    expect(() => rx.open(new Uint8Array(H.length + SEAL_OVERHEAD_BYTES - 1), 1)).toThrow(/short/)
  })

  it('counts the frames it has sealed', () => {
    const tx = new SealedDirection(key())
    expect(tx.sentFrames).toBe(0)
    tx.seal(H, enc.encode('one'))
    tx.seal(H, enc.encode('two'))
    // The counter is 48 bits wide, so a direction has to be able to say how close
    // it is before the host decides to rotate.
    expect(tx.sentFrames).toBe(2)
  })
})

describe('verification phrase', () => {
  it('derives the same verification phrase regardless of argument order', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    expect(deriveVerificationPhrase(a.publicKey, b.publicKey))
      .toBe(deriveVerificationPhrase(b.publicKey, a.publicKey))
  })

  it('matches the cross-implementation golden vector', () => {
    // The one test that catches a phone shipping a different wordlist, a
    // different index scheme, or a different word count. Without it the two ends
    // produce eight plausible words that never match, the user is told the
    // phrase is the MITM defence, and they conclude the scan went wrong and
    // re-pair -- training away the only check that catches a substituted key.
    //
    // Mirror this exact pair and expectation in the phone's conformance suite.
    const a = '00'.repeat(31) + '01'
    const b = '00'.repeat(31) + '02'
    expect(deriveVerificationPhrase(a, b)).toBe(
      'yonder urchin unicorn igloo pine pumice pelican indigo',
    )
    expect(deriveVerificationPhrase(b, a)).toBe(deriveVerificationPhrase(a, b))
  })

  it('spends a full digest byte on every word', () => {
    // Eight words over 256 is 64 bits. Six over 32 was 30 -- grindable offline in
    // under an hour against a desktop key that is static and printed in every QR
    // that machine shows, which turns the user's comparison into a confirmation
    // of the attacker rather than a catch.
    const a = generateIdentity()
    const b = generateIdentity()
    for (const w of deriveVerificationPhrase(a.publicKey, b.publicKey).split(' ')) {
      expect(SAFETY_WORDS).toContain(w)
    }
    expect(PHRASE_WORDS).toBe(8)
    expect(SAFETY_WORDS).toHaveLength(256)
  })

  it('derives an 8-word phrase that differs for different peers', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const c = generateIdentity()
    const phrase = deriveVerificationPhrase(a.publicKey, b.publicKey)
    expect(phrase.split(' ')).toHaveLength(PHRASE_WORDS)
    expect(phrase).not.toBe(deriveVerificationPhrase(a.publicKey, c.publicKey))
  })

})
