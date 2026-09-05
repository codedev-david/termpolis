import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { deriveVerificationPhrase, fromHex, toHex } from './sealedChannel'
import {
  deriveSessionRoomId,
  pairingRoot,
  SealedSession,
  FRAME_PAIRING_HELLO,
  FRAME_PAIRING_ACK,
  PROTOCOL_VERSION,
} from './sessionCrypto'
import { NO_CAPABILITIES, type PairedDevice } from './protocol'

const DEFAULT_TTL_MS = 90_000

export interface PairingOffer {
  pairingId: string
  oneTimeSecret: string
  qrPayload: string
  expiresAt: number
}

export function createPairingOffer(opts: {
  relayUrl: string
  desktopPublicKey: string
  now?: number
  ttlMs?: number
}): PairingOffer {
  const now = opts.now ?? Date.now()
  const pairingId = randomBytes(16).toString('hex')
  const oneTimeSecret = randomBytes(32).toString('hex')
  const expiresAt = now + (opts.ttlMs ?? DEFAULT_TTL_MS)
  return {
    pairingId,
    oneTimeSecret,
    expiresAt,
    qrPayload: JSON.stringify({
      v: 1,
      relayUrl: opts.relayUrl,
      pairingId,
      desktopPublicKey: opts.desktopPublicKey,
      oneTimeSecret,
    }),
  }
}

/** A hello's clear header: the frame tag, then the sender's 32-byte X25519 key. */
export const HELLO_HEADER_BYTES = 33

/** What a hello carries, sealed. */
interface HelloPayload {
  v: number
  label: string
  oneTimeSecret: string
}

/** The phone's opening frame: `0x01 || devicePublicKey[32] || sealed`.
 *
 *  The device key rides in the CLEAR because it has to: the desktop has never seen
 *  this phone, and it cannot derive the sealing key without the key it is deriving
 *  against. Everything an eavesdropper would want -- the label, and the one-time
 *  secret that is a bearer token for this pairing -- is inside the seal.
 *
 *  The clear header is the AEAD's associated data, so a relay that swaps in its own
 *  public key to be paired as itself fails Poly1305 rather than being believed. */
export function sealPairingHello(opts: {
  deviceSecretKey: string
  devicePublicKey: string
  desktopPublicKey: string
  pairingId: string
  label: string
  oneTimeSecret: string
}): Uint8Array {
  const header = new Uint8Array(HELLO_HEADER_BYTES)
  header[0] = FRAME_PAIRING_HELLO
  header.set(fromHex(opts.devicePublicKey), 1)

  const root = pairingRoot(opts.deviceSecretKey, opts.desktopPublicKey, opts.pairingId)
  const payload: HelloPayload = {
    v: PROTOCOL_VERSION,
    label: opts.label,
    oneTimeSecret: opts.oneTimeSecret,
  }
  return SealedSession.fromRoot(root, 'device').seal(
    header,
    new TextEncoder().encode(JSON.stringify(payload)),
  )
}

/** Read a hello, or throw.
 *
 *  Throwing is the only sound answer to a frame that does not open: the desktop is
 *  reading from a relay room whose name is on screen, so anything at all can arrive
 *  in it. The length check comes first because `slice` past the end of a short
 *  buffer yields a SHORT key rather than an error, and a curve-library complaint
 *  about scalar length is a poor way to learn the frame was truncated. */
export function openPairingHello(opts: {
  desktopSecretKey: string
  pairingId: string
  frame: Uint8Array
}): { devicePublicKey: string; label: string; oneTimeSecret: string } {
  const { frame } = opts
  if (frame.length < HELLO_HEADER_BYTES) throw new Error('pairing hello too short')
  if (frame[0] !== FRAME_PAIRING_HELLO) throw new Error('not a pairing hello')

  const devicePublicKey = toHex(frame.subarray(1, HELLO_HEADER_BYTES))
  const root = pairingRoot(opts.desktopSecretKey, devicePublicKey, opts.pairingId)
  const opened = SealedSession.fromRoot(root, 'desktop').open(frame, HELLO_HEADER_BYTES)

  const payload = JSON.parse(new TextDecoder().decode(opened)) as HelloPayload
  // The phone is a separate codebase shipped through two app stores, so an older
  // version of it really does arrive here. Say so, rather than letting a changed
  // payload shape surface as an unexplained failure further in.
  if (payload.v !== PROTOCOL_VERSION) {
    throw new Error(`unsupported pairing version ${payload.v}`)
  }
  return { devicePublicKey, label: payload.label, oneTimeSecret: payload.oneTimeSecret }
}

/** An ack's clear header: the frame tag, and nothing else. The phone has exactly
 *  one pairing in flight, so it already knows which root opens this. */
const ACK_HEADER_BYTES = 1

/** What an ack carries, sealed. */
interface AckPayload {
  v: number
  deviceId: string
}

/** The desktop's answer: `0x02 || sealed`.
 *
 *  Deliberately thin. Everything the phone needs next -- the session room, the
 *  safety number -- it DERIVES from the two identity keys it already holds, and
 *  sending either would invite a client that trusts the wire value instead. What
 *  is left is the fact of acceptance, and acceptance has to be authenticated: a
 *  relay that could forge one would send the phone off to a session room the
 *  desktop is not in, where it would wait with no error to show.
 *
 *  Sealed on a session built fresh from the pairing root, so its counter is the
 *  first on the desktop-to-phone direction. That is what lets the phone open it
 *  without having kept the session object it sealed its own hello with. */
export function sealPairingAck(opts: {
  desktopSecretKey: string
  devicePublicKey: string
  pairingId: string
  deviceId: string
}): Uint8Array {
  const root = pairingRoot(opts.desktopSecretKey, opts.devicePublicKey, opts.pairingId)
  const payload: AckPayload = { v: PROTOCOL_VERSION, deviceId: opts.deviceId }
  return SealedSession.fromRoot(root, 'desktop').seal(
    new Uint8Array([FRAME_PAIRING_ACK]),
    new TextEncoder().encode(JSON.stringify(payload)),
  )
}

/** Read an ack, or throw. The phone's half of `sealPairingAck`; the desktop never
 *  calls it. It lives here so the two halves of the wire format stay in one file
 *  and the Expo client has one module to mirror. */
export function openPairingAck(opts: {
  deviceSecretKey: string
  desktopPublicKey: string
  pairingId: string
  frame: Uint8Array
}): { deviceId: string } {
  if (opts.frame[0] !== FRAME_PAIRING_ACK) throw new Error('not a pairing ack')
  const root = pairingRoot(opts.deviceSecretKey, opts.desktopPublicKey, opts.pairingId)
  const opened = SealedSession.fromRoot(root, 'device').open(opts.frame, ACK_HEADER_BYTES)
  const payload = JSON.parse(new TextDecoder().decode(opened)) as AckPayload
  if (payload.v !== PROTOCOL_VERSION) {
    throw new Error(`unsupported pairing version ${payload.v}`)
  }
  return { deviceId: payload.deviceId }
}

function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * One pairing attempt. Single-use and time-boxed: a QR left on screen is a
 * credential, so it stops being one the moment it is used or expires.
 */
export class PairingSession {
  private used = false

  constructor(
    private readonly offer: PairingOffer,
    private readonly desktopPublicKey: string,
    /** The desktop's identity SECRET key.
     *
     *  Needed because the session room is a Diffie-Hellman over the two identities
     *  rather than a value anyone hands out. The public key alone cannot compute
     *  it -- which is exactly why the room name survives a photographed QR. */
    private readonly desktopSecretKey: string,
  ) {}

  accept(input: {
    oneTimeSecret: string
    devicePublicKey: string
    label: string
    now?: number
  }): { device: PairedDevice; verificationPhrase: string } {
    const now = input.now ?? Date.now()
    if (this.used) throw new Error('pairing offer already used')
    if (now > this.offer.expiresAt) throw new Error('pairing offer expired')
    if (!secretsMatch(input.oneTimeSecret, this.offer.oneTimeSecret)) {
      throw new Error('pairing secret mismatch')
    }
    this.used = true

    const device: PairedDevice = {
      id: createHash('sha256').update(input.devicePublicKey).digest('hex').slice(0, 16),
      label: input.label,
      publicKey: input.devicePublicKey,
      sessionRoomId: deriveSessionRoomId(this.desktopSecretKey, input.devicePublicKey),
      capabilities: { ...NO_CAPABILITIES },
      pairedAt: now,
      lastSeenAt: now,
    }

    return {
      device,
      verificationPhrase: deriveVerificationPhrase(this.desktopPublicKey, input.devicePublicKey),
    }
  }
}
