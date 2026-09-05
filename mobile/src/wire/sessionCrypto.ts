import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concat, fromHex, toHex, utf8Decode, utf8Encode } from './bytes'
import { SealedSession } from './sealedChannel'
import { PROTOCOL_VERSION } from './version'

/** Which end of the channel this is. The role decides which direction key you
 *  seal with, and it is the one mistake in this file that fails silently. */
export type Role = 'desktop' | 'device'

/** One byte, sent alone, every 120 seconds. Dropped by tag before any key is
 *  consulted -- it carries no counter and would fail every length check. */
export const FRAME_KEEPALIVE = 0x00
export const FRAME_PAIRING_HELLO = 0x01
export const FRAME_PAIRING_ACK = 0x02
export const FRAME_SESSION_HELLO = 0x03
export const FRAME_SESSION = 0x04

/** Tag only. PAIRING_ACK and SESSION carry nothing else in the clear. */
export const SESSION_HEADER_BYTES = 1
/** Tag plus the sender's 32-byte ephemeral public key. Shared by SESSION_HELLO
 *  and PAIRING_HELLO. */
export const GREETING_HEADER_BYTES = 33

const KEY_BYTES = 32
const ROOM_ID_BYTES = 16

function hkdf32(ikm: Uint8Array, salt: Uint8Array | undefined, info: string): Uint8Array {
  return hkdf(sha256, ikm, salt, utf8Encode(info), KEY_BYTES)
}

/**
 * One root produces two keys, and the role decides which one you seal with.
 *
 * Getting this backwards does not throw. It produces a session that seals frames
 * the peer cannot open and opens nothing, and the socket stays connected and
 * looks healthy throughout -- the phone simply never hears back.
 */
export function sessionFromRoot(root: Uint8Array, role: Role): SealedSession {
  const d2p = hkdf32(root, undefined, 'termpolis-d2p-v2')
  const p2d = hkdf32(root, undefined, 'termpolis-p2d-v2')
  return role === 'desktop' ? new SealedSession(d2p, p2d) : new SealedSession(p2d, d2p)
}

/**
 * The room the two ends move to once they are paired. Never announced.
 *
 * Both ends compute it from what they already hold, so it never crosses the wire
 * and never appears in a QR. That is the point: a room name is not a credential,
 * and anyone who photographed the QR could otherwise squat the session room
 * forever and answer the real phone with a 409 -- with neither the offer's TTL
 * nor its single-use flag touching it, because the exposure is the *name* and
 * the name outlives the secret.
 *
 * Sixteen bytes, hex: exactly the 32 characters the relay's room-id pattern
 * wants.
 */
export function deriveSessionRoomId(ownSecretKeyHex: string, peerPublicKeyHex: string): string {
  const shared = x25519.getSharedSecret(fromHex(ownSecretKeyHex), fromHex(peerPublicKeyHex))
  const info = utf8Encode('termpolis-session-room-v2')
  return toHex(hkdf(sha256, shared, undefined, info, ROOM_ID_BYTES))
}

/**
 * The root a PAIRING_HELLO and PAIRING_ACK are sealed under.
 *
 * Salted with the pairing id, so a hello is valid in the room it was sealed for
 * and nowhere else. Without that binding, a hello captured from one offer
 * replays into the next offer the same desktop shows -- the identity keys have
 * not changed.
 */
export function pairingRoot(
  ownSecretKeyHex: string,
  peerPublicKeyHex: string,
  pairingId: string,
): Uint8Array {
  const shared = x25519.getSharedSecret(fromHex(ownSecretKeyHex), fromHex(peerPublicKeyHex))
  return hkdf32(shared, utf8Encode(pairingId), 'termpolis-pair-v2')
}

/** A fresh X25519 keypair, hex-encoded.
 *
 *  `randomBytes` reads `globalThis.crypto.getRandomValues`, which on a phone is
 *  only a CSPRNG once `react-native-get-random-values` has been imported. That
 *  import is the first line of `index.ts` for exactly this reason: a key drawn
 *  before it is a total break that passes every test you would think to write. */
/** The public half of an identity key.
 *
 *  Pure function of the private half, so a stored keypair is never two values
 *  that can drift apart -- only the secret is ever persisted. */
export function publicKeyFor(secretKeyHex: string): string {
  return toHex(x25519.getPublicKey(fromHex(secretKeyHex)))
}

export function generateIdentity(): { secretKey: string; publicKey: string } {
  const secretKey = randomBytes(KEY_BYTES)
  return { secretKey: toHex(secretKey), publicKey: toHex(x25519.getPublicKey(secretKey)) }
}

/** Why a greeting was refused. `null` once one has been accepted. */
export type GreetingRejection =
  | 'too-short'
  | 'wrong-tag'
  | 'unauthenticated'
  | 'malformed'
  | 'version'
  | 'role'

/**
 * The session handshake: ephemeral-static, both directions in flight at once.
 *
 * The ephemeral term gives forward secrecy; the static term authenticates. An
 * attacker needs the ephemeral private key AND an identity private key -- one is
 * not enough.
 */
export class Handshake {
  readonly ownPublicKey: string
  private readonly role: Role
  private readonly ownSecretKey: string
  private readonly peerPublicKey: string
  private readonly ephemeralSk: Uint8Array
  private readonly ephemeralPk: Uint8Array
  private readonly version: number
  /** Set on every refusal, cleared on acceptance. A version mismatch has to be
   *  distinguishable from a decryption failure: an old phone against a new
   *  desktop must be able to say which it hit. */
  private rejection: GreetingRejection | null = null

  constructor(
    role: Role,
    ownSecretKeyHex: string,
    peerPublicKeyHex: string,
    ephemeralSecretKeyHex?: string,
    version: number = PROTOCOL_VERSION,
  ) {
    this.role = role
    this.ownSecretKey = ownSecretKeyHex
    this.peerPublicKey = peerPublicKeyHex
    this.ownPublicKey = toHex(x25519.getPublicKey(fromHex(ownSecretKeyHex)))
    this.ephemeralSk = ephemeralSecretKeyHex
      ? fromHex(ephemeralSecretKeyHex)
      : randomBytes(KEY_BYTES)
    this.ephemeralPk = x25519.getPublicKey(this.ephemeralSk)
    this.version = version
  }

  get lastRejection(): GreetingRejection | null {
    return this.rejection
  }

  /** The root only the two identity holders can derive. Accepting a greeting
   *  sealed under it is already proof of identity. */
  private handshakeRoot(): Uint8Array {
    const shared = x25519.getSharedSecret(fromHex(this.ownSecretKey), fromHex(this.peerPublicKey))
    return hkdf32(shared, undefined, 'termpolis-handshake-v2')
  }

  greeting(): Uint8Array {
    return this.greetingWithPayload(JSON.stringify({ v: this.version, role: this.role }))
  }

  /** Escape hatch for tests that need a greeting the real code would never
   *  build. Production callers want `greeting()`. */
  greetingWithPayload(payload: string): Uint8Array {
    const header = concat(Uint8Array.from([FRAME_SESSION_HELLO]), this.ephemeralPk)
    // A FRESH session for the seal. The seal and the open are independent
    // counters that both start at zero; reusing one object makes the second
    // operation fail.
    return sessionFromRoot(this.handshakeRoot(), this.role).seal(header, utf8Encode(payload))
  }

  /**
   * Returns the live session, or `null` with `lastRejection` set.
   *
   * Never throws: this runs from the socket's message handler.
   */
  accept(frame: Uint8Array): SealedSession | null {
    if (frame.length < GREETING_HEADER_BYTES) {
      this.rejection = 'too-short'
      return null
    }
    if (frame[0] !== FRAME_SESSION_HELLO) {
      this.rejection = 'wrong-tag'
      return null
    }
    const peerEphemeralPk = frame.slice(1, GREETING_HEADER_BYTES)
    // A fresh session again, for the same reason as in greetingWithPayload.
    // This open IS the authentication step.
    const opened = sessionFromRoot(this.handshakeRoot(), this.role).open(
      frame,
      GREETING_HEADER_BYTES,
    )
    if (!opened) {
      this.rejection = 'unauthenticated'
      return null
    }
    let payload: unknown
    try {
      payload = JSON.parse(utf8Decode(opened))
    } catch {
      this.rejection = 'malformed'
      return null
    }
    if (typeof payload !== 'object' || payload === null) {
      this.rejection = 'malformed'
      return null
    }
    const { v, role } = payload as { v?: unknown; role?: unknown }
    if (v !== this.version) {
      // Said out loud rather than letting a changed payload shape surface as an
      // unexplained decryption failure.
      this.rejection = 'version'
      return null
    }
    if (role !== (this.role === 'desktop' ? 'device' : 'desktop')) {
      this.rejection = 'role'
      return null
    }
    this.rejection = null
    return sessionFromRoot(this.sessionRoot(peerEphemeralPk), this.role)
  }

  /**
   * `ikm = DH(ownEphSk, peerEphPk) || DH(ownIdSk, peerIdPk)`, ephemeral first.
   * That order is not negotiable.
   *
   * The salt sorts the two ephemeral public keys, which is what lets both ends
   * compute the same salt without agreeing on who spoke first -- they cannot,
   * since both greetings are in flight at once.
   */
  private sessionRoot(peerEphemeralPk: Uint8Array): Uint8Array {
    const ikm = concat(
      x25519.getSharedSecret(this.ephemeralSk, peerEphemeralPk),
      x25519.getSharedSecret(fromHex(this.ownSecretKey), fromHex(this.peerPublicKey)),
    )
    const [lo, hi] = [toHex(this.ephemeralPk), toHex(peerEphemeralPk)].sort()
    const salt = sha256(utf8Encode(`${lo}${hi}`))
    return hkdf32(ikm, salt, 'termpolis-session-v2')
  }
}
