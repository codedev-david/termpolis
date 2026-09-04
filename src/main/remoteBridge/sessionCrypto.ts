import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { SealedDirection, fromHex, toHex } from './sealedChannel'

export type Role = 'desktop' | 'device'

/** A frame that carries nothing.
 *
 *  One byte, unsealed, and the same byte every time -- there is nothing in it to
 *  protect and no state it can move. It exists because the relay closes any
 *  connection whose last BINARY frame is older than its idle timeout, and a peer
 *  waiting alone in a room has no sealed frame it could send: there is no session
 *  until the other end arrives.
 *
 *  Reserved as the FIRST tag so a receiver recognises and drops it before
 *  consulting a key. That ordering is the whole safety argument: a keepalive that
 *  raced the peer's arrival would otherwise reach the greeting path, fail to open,
 *  and cost the peer its connection. */
export const FRAME_KEEPALIVE = 0x00
export const FRAME_PAIRING_HELLO = 0x01
export const FRAME_PAIRING_ACK = 0x02
export const FRAME_SESSION_HELLO = 0x03
export const FRAME_SESSION = 0x04

/** Bumped only for a breaking wire change. A peer that sees anything else says so
 *  instead of misreading the payload -- an old phone against a new desktop should
 *  report a version mismatch, not a decryption failure. */
export const PROTOCOL_VERSION = 2

const KEY_BYTES = 32
const PUBLIC_KEY_BYTES = 32
/** A SESSION frame's header: the tag byte, and nothing else.
 *
 *  Exported because it is part of what a frame costs on the wire, and the output
 *  chunker sizes payloads against the relay's cap -- which applies to the whole
 *  frame, header included. */
export const SESSION_HEADER_BYTES = 1
/** The SESSION HELLO header: the frame tag plus the sender's ephemeral public key. */
export const GREETING_HEADER_BYTES = SESSION_HEADER_BYTES + PUBLIC_KEY_BYTES

const label = (s: string): Uint8Array => new TextEncoder().encode(s)
const D2P = label('termpolis-d2p-v2')
const P2D = label('termpolis-p2d-v2')

const dh = (ownSecretKey: string, peerPublicKey: string): Uint8Array =>
  x25519.getSharedSecret(fromHex(ownSecretKey), fromHex(peerPublicKey))

/** Two directional keys from one root. Which one seals is decided by role, so both
 *  ends derive the same pair and use them in opposite directions. */
export class SealedSession {
  private constructor(
    private readonly tx: SealedDirection,
    private readonly rx: SealedDirection,
  ) {}

  static fromRoot(root: Uint8Array, role: Role): SealedSession {
    const d2p = new SealedDirection(hkdf(sha256, root, undefined, D2P, KEY_BYTES))
    const p2d = new SealedDirection(hkdf(sha256, root, undefined, P2D, KEY_BYTES))
    return role === 'desktop' ? new SealedSession(d2p, p2d) : new SealedSession(p2d, d2p)
  }

  seal(header: Uint8Array, plaintext: Uint8Array): Uint8Array {
    return this.tx.seal(header, plaintext)
  }

  open(frame: Uint8Array, headerBytes: number): Uint8Array {
    return this.rx.open(frame, headerBytes)
  }
}

/** The room a paired desktop and phone meet in, derived rather than announced.
 *
 *  Sixteen bytes of HKDF over the static shared secret. Both ends compute it from
 *  what they already hold, so it never crosses the wire and never appears in a QR --
 *  which is the point: the pairing room's name is public the moment someone
 *  photographs the code, and a name is enough to squat a room. */
export function deriveSessionRoomId(ownSecretKey: string, peerPublicKey: string): string {
  return toHex(
    hkdf(sha256, dh(ownSecretKey, peerPublicKey), undefined, label('termpolis-session-room-v2'), 16),
  )
}

/** The root for the two PAIRING frames, before either end knows a session.
 *
 *  Salted with the pairing id so a hello is valid in the room it was sealed for and
 *  nowhere else. Without that binding, a hello captured from one offer replays into
 *  the next offer the same desktop shows -- the identity keys have not changed. */
export function pairingRoot(
  ownSecretKey: string,
  peerPublicKey: string,
  pairingId: string,
): Uint8Array {
  return hkdf(
    sha256,
    dh(ownSecretKey, peerPublicKey),
    label(pairingId),
    label('termpolis-pair-v2'),
    KEY_BYTES,
  )
}

/** What a greeting carries beyond its ephemeral key. */
interface GreetingPayload {
  v: number
  role: Role
}

/** One end of a session handshake.
 *
 *  Ephemeral-static: the ephemeral term gives forward secrecy (the spec promises it
 *  and the old static-static channel never delivered it), the static term
 *  authenticates. Both are in the IKM, so an attacker needs the ephemeral private
 *  key AND an identity private key -- one is not enough.
 *
 *  Construct it, send `greeting`, feed the peer's greeting to `accept`, then use the
 *  session it returns. Both greetings are in flight at once; neither end waits. */
export class Handshake {
  readonly greeting: Uint8Array
  private readonly ephemeralSecret: Uint8Array
  private readonly ephemeralPublic: Uint8Array
  private readonly ownSecretKey: string
  private readonly peerPublicKey: string
  private readonly role: Role

  constructor(opts: {
    ownSecretKey: string
    peerPublicKey: string
    role: Role
    /** Injected in tests so a handshake is reproducible. Production omits it. */
    ephemeralSecretKey?: string
  }) {
    this.ownSecretKey = opts.ownSecretKey
    this.peerPublicKey = opts.peerPublicKey
    this.role = opts.role
    this.ephemeralSecret = opts.ephemeralSecretKey
      ? fromHex(opts.ephemeralSecretKey)
      : x25519.utils.randomSecretKey()
    this.ephemeralPublic = x25519.getPublicKey(this.ephemeralSecret)

    // The greeting is sealed under a key only the two identity holders can derive,
    // so accepting one is already proof of identity. The ephemeral public key rides
    // in the header, and the header is the AEAD's associated data -- substituting it
    // fails Poly1305 rather than silently redirecting the session to a key the
    // substituter chose.
    const header = new Uint8Array(GREETING_HEADER_BYTES)
    header[0] = FRAME_SESSION_HELLO
    header.set(this.ephemeralPublic, 1)
    const payload: GreetingPayload = { v: PROTOCOL_VERSION, role: opts.role }
    this.greeting = this.handshakeSession().seal(header, label(JSON.stringify(payload)))
  }

  /** A fresh one each time: `SealedSession` carries counter state, and the seal in
   *  the constructor and the open in `accept` are independent counters that both
   *  start at zero. */
  private handshakeSession(): SealedSession {
    return SealedSession.fromRoot(
      hkdf(
        sha256,
        dh(this.ownSecretKey, this.peerPublicKey),
        undefined,
        label('termpolis-handshake-v2'),
        KEY_BYTES,
      ),
      this.role,
    )
  }

  accept(peerGreeting: Uint8Array): SealedSession {
    if (peerGreeting.length < GREETING_HEADER_BYTES) throw new Error('greeting too short')
    if (peerGreeting[0] !== FRAME_SESSION_HELLO) throw new Error('not a session greeting')
    const peerEphemeral = peerGreeting.subarray(1, GREETING_HEADER_BYTES)

    // Throws unless the peer holds an identity private key for this pairing. This is
    // the authentication step; everything after it is key agreement.
    const plaintext = this.handshakeSession().open(peerGreeting, GREETING_HEADER_BYTES)
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as GreetingPayload
    if (payload.v !== PROTOCOL_VERSION) {
      throw new Error(`unsupported protocol version ${payload.v}`)
    }
    if (payload.role !== (this.role === 'desktop' ? 'device' : 'desktop')) {
      throw new Error(`greeting claims role ${payload.role}`)
    }

    const ikm = new Uint8Array(KEY_BYTES * 2)
    ikm.set(x25519.getSharedSecret(this.ephemeralSecret, peerEphemeral), 0)
    ikm.set(dh(this.ownSecretKey, this.peerPublicKey), KEY_BYTES)

    // Sorted, so both ends compute the same salt without needing to agree on who
    // spoke first -- which they cannot, since both greetings are in flight at once.
    const [lo, hi] = [toHex(this.ephemeralPublic), toHex(peerEphemeral)].sort()
    const salt = sha256(label(`${lo}${hi}`))

    return SealedSession.fromRoot(
      hkdf(sha256, ikm, salt, label('termpolis-session-v2'), KEY_BYTES),
      this.role,
    )
  }
}
