import { x25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from 'crypto'
import { SAFETY_WORDS } from './wordlist'

const POLY1305_TAG_BYTES = 16
const NONCE_BYTES = 12
/** Frame counter width. 6 bytes is 2^48 frames — unreachable at any real rate, and it
 *  fits exactly in a JS number, so the check stays integer-exact with no BigInt. */
export const COUNTER_BYTES = 6

/** What `seal` adds beyond the header and the plaintext.
 *
 *  Summed from the parts rather than written as a literal, so it cannot drift
 *  from the format it describes. A wrong value here would not fail loudly: it
 *  would oversize payloads until one crossed the relay's 1 MiB ceiling, and the
 *  relay CUTS an oversized frame rather than truncating it, which reads to a
 *  user as an unreliable network.
 *
 *  Exported because the output chunker sizes payloads against that ceiling, and
 *  the ceiling applies to the sealed frame rather than the plaintext.
 *  `tests/electron/remoteOutputChunker.test.ts` measures a real seal against it. */
export const SEAL_OVERHEAD_BYTES = COUNTER_BYTES + POLY1305_TAG_BYTES

export function writeCounter(buf: Uint8Array, value: number): void {
  for (let i = COUNTER_BYTES - 1; i >= 0; i--) {
    buf[i] = value % 256
    value = Math.floor(value / 256)
  }
}

export function readCounter(buf: Uint8Array): number {
  let value = 0
  for (let i = 0; i < COUNTER_BYTES; i++) value = value * 256 + buf[i]
  return value
}

/** The nonce is derived from the counter rather than drawn at random.
 *
 *  A key seals in exactly ONE direction, so its counter never repeats and neither
 *  does the nonce — uniqueness is structural, with no birthday bound to reason
 *  about, and 12 bytes per frame stay off the wire. The leading zeros pad a
 *  6-byte counter out to ChaCha20's 12-byte nonce. */
function nonceFor(counter: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES)
  writeCounter(nonce.subarray(NONCE_BYTES - COUNTER_BYTES), counter)
  return nonce
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex')
}
export function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'hex'))
}

export function generateIdentity(): { secretKey: string; publicKey: string } {
  const secretKey = new Uint8Array(randomBytes(32))
  return { secretKey: toHex(secretKey), publicKey: toHex(x25519.getPublicKey(secretKey)) }
}

/**
 * One key, one direction.
 *
 * The key is supplied rather than derived here: `sessionCrypto` runs the key
 * schedule and hands each direction its own. That split is the point. A single
 * key used both ways lets a relay reflect a peer's own frame back at it — the
 * tag verifies, because the peer sealed it — and the reflected counter poisons
 * the receive high-water mark permanently. Splitting the directions makes that
 * frame arrive under the wrong key and fail authentication, which is where it
 * should fail.
 *
 * Replay protection lives here; forward secrecy lives in the key schedule.
 */
export class SealedDirection {
  private readonly key: Uint8Array
  private frames = 0
  /** Highest counter accepted from the peer. Frames at or below it are replays.
   *  Starts at -1 so counter 0 — the peer's first frame — is accepted. */
  private peerHighWater = -1

  constructor(key: Uint8Array) {
    this.key = key
  }

  get sentFrames(): number {
    return this.frames
  }

  /** Seal one frame: `header || counter || AEAD(plaintext, aad=header)`.
   *
   *  The header stays in the clear because the receiver has to read it to know
   *  which key to try — a HANDSHAKE frame and a SESSION frame open under
   *  different keys. Passing it as associated data is what keeps that from being
   *  a hole: an altered tag fails authentication rather than being reinterpreted
   *  as another frame type.
   *
   *  The counter is in the clear too, and is authenticated implicitly: it derives
   *  the nonce, so raising it makes decryption fail and lowering it trips the
   *  replay check below. */
  seal(header: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const counter = this.frames
    const ct = chacha20poly1305(this.key, nonceFor(counter), header).encrypt(plaintext)
    this.frames++
    const out = new Uint8Array(header.length + COUNTER_BYTES + ct.length)
    out.set(header, 0)
    writeCounter(out.subarray(header.length), counter)
    out.set(ct, header.length + COUNTER_BYTES)
    return out
  }

  /** Throws if the frame was tampered with, replayed, or sealed under another key.
   *
   *  `headerBytes` is how much of the frame the caller already parsed and is
   *  passing through as associated data. */
  open(frame: Uint8Array, headerBytes: number): Uint8Array {
    if (frame.length < headerBytes + SEAL_OVERHEAD_BYTES) {
      // Below this a counter would be read off the end of the buffer, and the
      // garbage sequence number that produced would poison replay state for
      // every frame after it.
      throw new Error('sealed frame too short')
    }
    const header = frame.subarray(0, headerBytes)
    const counter = readCounter(frame.subarray(headerBytes))
    // Checked BEFORE decryption: a replay flood then costs an integer compare
    // instead of a Poly1305 verification over an attacker-chosen length.
    // Strictly increasing, so a replayed OR reordered frame is refused —
    // authenticity alone would happily accept both.
    if (counter <= this.peerHighWater) {
      throw new Error(`replayed sealed frame (counter ${counter} <= ${this.peerHighWater})`)
    }
    const ct = frame.subarray(headerBytes + COUNTER_BYTES)
    const plaintext = chacha20poly1305(this.key, nonceFor(counter), header).decrypt(ct)
    // Only now, once the tag has verified. Advancing before it would let anyone
    // walk the counter forward with garbage and deafen the peer for good.
    this.peerHighWater = counter
    return plaintext
  }
}

/** Words in a safety number. Eight words over a 256-word list is 64 bits.
 *
 *  The number that matters is the GRINDING cost, not the reading cost. The
 *  desktop public key is static and appears in every QR that machine ever shows,
 *  so an attacker searches offline, for days, from a photograph taken months
 *  ago -- the 90-second offer TTL constrains none of it. The previous six words
 *  over a 32-word list was 2^30, which finishes in under an hour, and a phrase
 *  ground to match does not merely evade the check: the user compares it, sees
 *  it match, and the comparison CONFIRMS the attacker.
 *
 *  One digest byte per word, no modulo -- SAFETY_WORDS holds exactly 256
 *  entries, so every byte maps to a distinct word and the mapping is uniform by
 *  construction. The old `% 32` over a 32-word list happened to be unbiased too,
 *  but only by coincidence of the length; this cannot silently stop being true.
 */
export const PHRASE_WORDS = 8

/**
 * Signal-style safety numbers. Both ends render this and the user confirms they
 * match, which is what stops a malicious relay from MITM-ing the pairing
 * handshake. Sorting the keys makes it order-independent, so both sides derive
 * the same phrase without agreeing on who is who.
 */
export function deriveVerificationPhrase(aPublicKey: string, bPublicKey: string): string {
  const [lo, hi] = [aPublicKey, bPublicKey].sort()
  const digest = sha256(new TextEncoder().encode(`${lo}:${hi}`))
  return Array.from({ length: PHRASE_WORDS }, (_, i) => SAFETY_WORDS[digest[i]]).join(' ')
}
