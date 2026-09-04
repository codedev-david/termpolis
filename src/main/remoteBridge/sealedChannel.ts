import { x25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from 'crypto'
import { SAFETY_WORDS } from './wordlist'

/** What `seal` adds to a plaintext: nonce, counter, and the Poly1305 tag.
 *  Exported because the output chunker has to size payloads against the relay's
 *  frame cap, which applies to the sealed frame rather than the plaintext.
 *  `tests/electron/remoteOutputChunker.test.ts` pins it by measuring a real seal,
 *  so it cannot drift from the format. */
export const SEAL_OVERHEAD_BYTES = 34

const NONCE_BYTES = 12
/** Frame counter width. 6 bytes is 2^48 frames — unreachable at any real rate, and it
 *  fits exactly in a JS number, so the check stays integer-exact with no BigInt. */
const COUNTER_BYTES = 6

function writeCounter(buf: Uint8Array, value: number): void {
  for (let i = COUNTER_BYTES - 1; i >= 0; i--) {
    buf[i] = value % 256
    value = Math.floor(value / 256)
  }
}

function readCounter(buf: Uint8Array): number {
  let value = 0
  for (let i = 0; i < COUNTER_BYTES; i++) value = value * 256 + buf[i]
  return value
}

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex')
}
function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'hex'))
}

export function generateIdentity(): { secretKey: string; publicKey: string } {
  const secretKey = new Uint8Array(randomBytes(32))
  return { secretKey: toHex(secretKey), publicKey: toHex(x25519.getPublicKey(secretKey)) }
}

/**
 * An authenticated channel between two X25519 identities.
 *
 * The shared secret is hashed rather than used raw: the raw ECDH output is not
 * uniformly distributed, and feeding it straight to a cipher is a classic footgun.
 */
export class SealedChannel {
  private readonly key: Uint8Array
  private frames = 0
  /** Highest counter accepted from the peer. Frames at or below it are replays.
   *  Starts at -1 so counter 0 — the peer's first frame — is accepted. */
  private peerHighWater = -1

  constructor(ownSecretKey: string, peerPublicKey: string) {
    const shared = x25519.getSharedSecret(fromHex(ownSecretKey), fromHex(peerPublicKey))
    this.key = sha256(shared)
  }

  get sentFrames(): number {
    return this.frames
  }

  /** Seal one frame: `nonce || AEAD(counter || plaintext)`.
   *
   *  The counter is INSIDE the ciphertext, not beside it, so it is covered by the
   *  Poly1305 tag and cannot be edited by anyone who lacks the key. A random nonce
   *  alone does not stop replay — the tag still verifies on a byte-identical frame
   *  the attacker captured earlier, and for this feature that means a captured
   *  `run_command` can be re-executed at will. The counter is what makes each frame
   *  usable exactly once. */
  seal(plaintext: Uint8Array): Uint8Array {
    const nonce = new Uint8Array(randomBytes(NONCE_BYTES))
    const framed = new Uint8Array(COUNTER_BYTES + plaintext.length)
    writeCounter(framed, this.frames)
    framed.set(plaintext, COUNTER_BYTES)
    const ct = chacha20poly1305(this.key, nonce).encrypt(framed)
    this.frames++
    const out = new Uint8Array(nonce.length + ct.length)
    out.set(nonce, 0)
    out.set(ct, nonce.length)
    return out
  }

  /** Throws if the frame was tampered with or came from another peer. */
  open(frame: Uint8Array): Uint8Array {
    if (frame.length <= NONCE_BYTES) throw new Error('frame too short')
    const nonce = frame.subarray(0, NONCE_BYTES)
    const ct = frame.subarray(NONCE_BYTES)
    const framed = chacha20poly1305(this.key, nonce).decrypt(ct)
    if (framed.length < COUNTER_BYTES) throw new Error('sealed frame is truncated')
    const counter = readCounter(framed)
    // Strictly increasing, so a replayed OR reordered frame is refused. Authenticity
    // alone would happily accept both.
    if (counter <= this.peerHighWater) {
      throw new Error(`replayed sealed frame (counter ${counter} <= ${this.peerHighWater})`)
    }
    this.peerHighWater = counter
    return framed.subarray(COUNTER_BYTES)
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
