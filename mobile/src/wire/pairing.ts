import { sha256 } from '@noble/hashes/sha2.js'
import { fromHex, toHex, utf8Decode, utf8Encode } from './bytes'
import {
  FRAME_PAIRING_ACK,
  FRAME_PAIRING_HELLO,
  GREETING_HEADER_BYTES,
  SESSION_HEADER_BYTES,
  pairingRoot,
  sessionFromRoot,
} from './sessionCrypto'
import { PROTOCOL_VERSION } from './version'

/** The desktop's stable handle for a phone: eight bytes of SHA-256 over the hex
 *  form of its public key. Derived on both ends from the same public value, so
 *  the phone can show the id the desktop will list without being told it. */
export function deviceIdFor(devicePublicKeyHex: string): string {
  return toHex(sha256(utf8Encode(devicePublicKeyHex))).slice(0, 16)
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
  const header = new Uint8Array(GREETING_HEADER_BYTES)
  header[0] = FRAME_PAIRING_HELLO
  header.set(fromHex(opts.devicePublicKey), 1)

  const root = pairingRoot(opts.deviceSecretKey, opts.desktopPublicKey, opts.pairingId)
  const payload = {
    v: PROTOCOL_VERSION,
    label: opts.label,
    oneTimeSecret: opts.oneTimeSecret,
  }
  return sessionFromRoot(root, 'device').seal(header, utf8Encode(JSON.stringify(payload)))
}

const DEVICE_ID_RE = /^[0-9a-f]{16}$/

/** Read the desktop's answer, or `null`.
 *
 *  The desktop's half of this throws, because it reads from a room whose name is
 *  on screen and a frame that will not open is news. The phone's half must not:
 *  it is reading inside a React render tree, where an exception from a socket
 *  callback is an unhandled rejection and a red screen rather than the "that
 *  didn't work, try again" the user needs. Every rejection here is the same
 *  answer -- this is not our ack -- so they collapse to one.
 *
 *  Opened on a session built FRESH from the pairing root, so the counter it
 *  expects is the first on the desktop-to-phone direction. That freshness is what
 *  lets the phone open an ack without having kept the session object it sealed
 *  its own hello with. */
export function openPairingAck(opts: {
  frame: Uint8Array
  deviceSecretKey: string
  desktopPublicKey: string
  pairingId: string
}): { deviceId: string } | null {
  if (opts.frame.length < SESSION_HEADER_BYTES) return null
  if (opts.frame[0] !== FRAME_PAIRING_ACK) return null

  const root = pairingRoot(opts.deviceSecretKey, opts.desktopPublicKey, opts.pairingId)
  const opened = sessionFromRoot(root, 'device').open(opts.frame, SESSION_HEADER_BYTES)
  if (opened === null) return null

  let payload: unknown
  try {
    payload = JSON.parse(utf8Decode(opened))
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null

  const { v, deviceId } = payload as Record<string, unknown>
  // The phone is a separate codebase shipped through two app stores, so an older
  // desktop really does answer here. An unrecognised shape is refused rather than
  // half-read: the id becomes the handle the user revokes by.
  if (v !== PROTOCOL_VERSION) return null
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) return null
  return { deviceId }
}
