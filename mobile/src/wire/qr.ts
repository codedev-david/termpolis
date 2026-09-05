import { QR_ENVELOPE_VERSION } from './version'

/**
 * What the desktop paints as a QR, for 90 seconds.
 *
 * Treat the whole payload as a credential: it is a bearer token for exactly one
 * pairing, and the desktop stops honouring it the moment it is used or expires.
 */
export interface QrPayload {
  /** The QR envelope's version, deliberately not `PROTOCOL_VERSION`. This is
   *  read by a scanner that has not yet decided whether it can speak to this
   *  desktop at all. */
  v: number
  relayUrl: string
  /** 16 random bytes, hex. */
  pairingId: string
  /** The desktop's long-lived X25519 public key. Never its secret. */
  desktopPublicKey: string
  /** 32 random bytes, hex. Proves the scanner saw this screen. */
  oneTimeSecret: string
}

const PAIRING_ID_RE = /^[0-9a-f]{32}$/
const KEY_RE = /^[0-9a-f]{64}$/

function isHex(value: unknown, re: RegExp): value is string {
  return typeof value === 'string' && re.test(value)
}

/** `wss:` only. The transport is not negotiable: a `ws://` or `http://` URL in a
 *  QR is either a downgrade attempt or a misconfiguration, and both end with
 *  frames crossing the internet unwrapped by TLS. */
function isRelayUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'wss:'
  } catch {
    return false
  }
}

/**
 * Parse and validate a scanned payload, or return `null`.
 *
 * `null` rather than a throw because the camera is pointed at an arbitrary
 * surface: a scan of a cereal box should show "that is not a pairing code", not
 * a crash. Unknown fields are tolerated -- the QR envelope versions
 * independently of the protocol, and a future desktop may add one.
 */
export function parseQrPayload(raw: string): QrPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { v, relayUrl, pairingId, desktopPublicKey, oneTimeSecret } = parsed as Record<
    string,
    unknown
  >
  if (v !== QR_ENVELOPE_VERSION) return null
  if (!isRelayUrl(relayUrl)) return null
  if (!isHex(pairingId, PAIRING_ID_RE)) return null
  if (!isHex(desktopPublicKey, KEY_RE)) return null
  if (!isHex(oneTimeSecret, KEY_RE)) return null
  // Rebuilt field by field rather than returned as-is, so an unknown field a
  // future desktop adds cannot reach the rest of the app unvalidated.
  return { v, relayUrl, pairingId, desktopPublicKey, oneTimeSecret }
}
