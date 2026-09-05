import { chacha20poly1305 } from '@noble/ciphers/chacha.js'

const POLY1305_TAG_BYTES = 16
const NONCE_BYTES = 12

/** Frame counter width. 6 bytes is 2^48 frames -- unreachable at any real rate,
 *  and it fits exactly in a JS number, so the check stays integer-exact with no
 *  BigInt. */
export const COUNTER_BYTES = 6

/** What `seal` adds beyond the header and the plaintext.
 *
 *  Summed from the parts rather than written as a literal, so it cannot drift
 *  from the format it describes. A wrong value here would not fail loudly: it
 *  would oversize payloads until one crossed the relay's 1 MiB ceiling, and the
 *  relay CUTS an oversized frame rather than truncating it, which reads to a user
 *  as an unreliable network. */
export const SEAL_OVERHEAD_BYTES = COUNTER_BYTES + POLY1305_TAG_BYTES

/** Six-byte big-endian, written into the first `COUNTER_BYTES` of `buf`. */
export function writeCounter(buf: Uint8Array, value: number): void {
  for (let i = COUNTER_BYTES - 1; i >= 0; i--) {
    buf[i] = value % 256
    value = Math.floor(value / 256)
  }
}

export function readCounter(buf: Uint8Array): number {
  let value = 0
  for (let i = 0; i < COUNTER_BYTES; i++) value = value * 256 + (buf[i] as number)
  return value
}

/** The nonce is derived from the counter rather than drawn at random.
 *
 *  A key seals in exactly ONE direction, so its counter never repeats and neither
 *  does the nonce -- uniqueness is structural, with no birthday bound to reason
 *  about, and 12 bytes per frame stay off the wire. The leading zeros pad a
 *  6-byte counter out to ChaCha20's 12-byte nonce. */
function nonceFor(counter: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES)
  writeCounter(nonce.subarray(NONCE_BYTES - COUNTER_BYTES), counter)
  return nonce
}

/**
 * One key per direction, and one counter per key.
 *
 * The desktop models this as two `SealedDirection`s; the phone folds both halves
 * into one object because every phone-side caller holds both at once. The
 * behaviour on the wire is identical -- what matters is that the two keys are
 * genuinely different. A single key used both ways lets a relay reflect a peer's
 * own frame back at it (the tag verifies, because the peer sealed it) and the
 * reflected counter poisons the receive high-water mark permanently. Splitting
 * the directions makes that frame arrive under the wrong key and fail
 * authentication, which is where it should fail.
 *
 * Replay protection lives here; forward secrecy lives in the key schedule.
 */
export class SealedSession {
  private readonly txKey: Uint8Array
  private readonly rxKey: Uint8Array
  private frames = 0
  /** Highest counter accepted from the peer. Frames at or below it are replays.
   *  Starts at -1 so counter 0 -- the peer's first frame -- is accepted. */
  private peerHighWater = -1

  constructor(txKey: Uint8Array, rxKey: Uint8Array) {
    this.txKey = txKey
    this.rxKey = rxKey
  }

  get sentFrames(): number {
    return this.frames
  }

  /** Seal one frame: `header || counter || AEAD(plaintext, aad = header)`.
   *
   *  The header stays in the clear because the receiver has to read it to know
   *  which key to try -- a HANDSHAKE frame and a SESSION frame open under
   *  different keys. Passing it as associated data is what keeps that from being
   *  a hole: an altered tag fails authentication rather than being reinterpreted
   *  as another frame type.
   *
   *  The counter is in the clear too, and is authenticated implicitly: it derives
   *  the nonce, so raising it makes decryption fail and lowering it trips the
   *  replay check in `open`. */
  seal(header: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const counter = this.frames
    const ct = chacha20poly1305(this.txKey, nonceFor(counter), header).encrypt(plaintext)
    this.frames++
    const out = new Uint8Array(header.length + COUNTER_BYTES + ct.length)
    out.set(header, 0)
    writeCounter(out.subarray(header.length), counter)
    out.set(ct, header.length + COUNTER_BYTES)
    return out
  }

  /**
   * Returns the plaintext, or `null` if the frame was truncated, tampered with,
   * replayed, reordered, or sealed under another key.
   *
   * `null` rather than a throw, deliberately: this runs straight out of the
   * socket's message handler, and a throw there tears down the connection --
   * which would hand any peer on the relay a free disconnect for the cost of one
   * junk frame. The desktop throws because its caller is a dispatcher that
   * catches; the phone's caller is an event listener that does not.
   *
   * The order of the four steps is load-bearing and is fixed by wire format
   * section 5.1.
   */
  open(frame: Uint8Array, headerBytes: number): Uint8Array | null {
    if (frame.length < headerBytes + SEAL_OVERHEAD_BYTES) {
      // Below this a counter would be read off the end of the buffer, and the
      // garbage sequence number that produced would poison replay state for
      // every frame after it.
      return null
    }
    const header = frame.subarray(0, headerBytes)
    const counter = readCounter(frame.subarray(headerBytes))
    // Checked BEFORE decryption: a replay flood then costs an integer compare
    // instead of a Poly1305 verification over an attacker-chosen length.
    // Strictly increasing, so a replayed OR reordered frame is refused --
    // authenticity alone would happily accept both.
    if (counter <= this.peerHighWater) return null
    const ct = frame.subarray(headerBytes + COUNTER_BYTES)
    let plaintext: Uint8Array
    try {
      plaintext = chacha20poly1305(this.rxKey, nonceFor(counter), header).decrypt(ct)
    } catch {
      return null
    }
    // Only now, once the tag has verified. Advancing before it would let anyone
    // walk the counter forward with garbage and deafen the peer for good.
    this.peerHighWater = counter
    return plaintext
  }
}
