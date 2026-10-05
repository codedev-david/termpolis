import type { BridgeLink } from './protocol'

/** What every link code starts with.
 *
 *  It is what keeps the two kinds of code apart. The phone's scanner parses JSON
 *  and nothing else, so a code that starts with this can never pair a phone; and
 *  `parseLinkCode` refuses anything without it, so a phone QR pasted into the
 *  link box is refused here rather than half-accepted by the desktop it names. */
export const LINK_CODE_PREFIX = 'termpolis-link:'

/** How long a link offer stays valid: five minutes, not the phone's ninety
 *  seconds. A phone scans a QR on the screen in front of it; a link code has to
 *  be carried from one computer to another -- pasted into a chat, dropped in a
 *  shared folder, or typed. */
export const LINK_OFFER_TTL_MS = 5 * 60_000

/** Longest text `parseLinkCode` will look at. A real code is a few hundred
 *  characters; anything far past that is a paste of something else, and it is
 *  refused on its length rather than decoded and handed to JSON.parse. */
const MAX_LINK_CODE_CHARS = 4096

/** The offer a link code carries -- the same five fields as the phone's QR. */
export interface LinkOffer {
  /** The QR envelope version, deliberately not `PROTOCOL_VERSION`. */
  v: 1
  relayUrl: string
  pairingId: string
  desktopPublicKey: string
  oneTimeSecret: string
}

const PAIRING_ID_RE = /^[0-9a-f]{32}$/
const KEY_RE = /^[0-9a-f]{64}$/
const DEVICE_ID_RE = /^[0-9a-f]{16}$/
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

/** The only hosts a link may reach without TLS. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost']

function isHex(value: unknown, re: RegExp): value is string {
  return typeof value === 'string' && re.test(value)
}

/** `wss:`, or `ws:` on this machine only.
 *
 *  The phone accepts `wss:` and nothing else (`mobile/src/wire/qr.ts`), and so
 *  does this outside one exception: a relay on loopback, which is what the tests
 *  and a relay run locally with wrangler use. Nothing on loopback crosses a
 *  network, so there is no middlebox to read room ids off the wire -- which is
 *  the whole reason `ws:` is refused everywhere else. */
export function isLinkRelayUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'wss:') return true
  return url.protocol === 'ws:' && LOOPBACK_HOSTS.includes(url.hostname)
}

/** The QR payload, as text a person can carry: prefix + base64url(utf8).
 *
 *  base64url rather than base64 because `+`, `/` and `=` are exactly the
 *  characters chat apps and URL bars rewrite. */
export function encodeLinkCode(qrPayloadJson: string): string {
  return LINK_CODE_PREFIX + Buffer.from(qrPayloadJson, 'utf8').toString('base64url')
}

/** Read a pasted link code, or return `null`.
 *
 *  `null` rather than a throw because the input is whatever the user pasted.
 *  Validated exactly as the phone validates a scanned QR (`mobile/src/wire/qr.ts`)
 *  -- the two describe the same offer -- with the loopback exception above.
 *
 *  Whitespace anywhere is ignored: a code that crossed a chat window can come
 *  back wrapped, and base64url has no whitespace of its own to lose. */
export function parseLinkCode(text: string): LinkOffer | null {
  if (typeof text !== 'string' || text.length > MAX_LINK_CODE_CHARS) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith(LINK_CODE_PREFIX)) return null
  const body = trimmed.slice(LINK_CODE_PREFIX.length).replace(/\s+/g, '')
  // Checked before decoding: Node's base64url decoder skips characters it does
  // not know rather than refusing them, so a mangled code would otherwise decode
  // to something that is merely wrong.
  if (!BASE64URL_RE.test(body)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { v, relayUrl, pairingId, desktopPublicKey, oneTimeSecret } = parsed as Record<
    string,
    unknown
  >
  if (v !== 1) return null
  if (!isLinkRelayUrl(relayUrl)) return null
  if (!isHex(pairingId, PAIRING_ID_RE)) return null
  if (!isHex(desktopPublicKey, KEY_RE)) return null
  if (!isHex(oneTimeSecret, KEY_RE)) return null
  // Rebuilt field by field, so nothing a future desktop adds reaches the bridge
  // unvalidated.
  return { v: 1, relayUrl, pairingId, desktopPublicKey, oneTimeSecret }
}

/** Whether a joined link, as main hands it down, is safe to dial.
 *
 *  The keys in it reach the curve library inside a relay socket's message
 *  handler, where a throw is an uncaught exception that takes the bridge down --
 *  so a malformed record is refused at the door instead. */
export function isBridgeLink(value: unknown): value is BridgeLink {
  if (typeof value !== 'object' || value === null) return false
  const l = value as Record<string, unknown>
  return (
    isHex(l.id, DEVICE_ID_RE) &&
    isHex(l.hostPublicKey, KEY_RE) &&
    isLinkRelayUrl(l.relayUrl) &&
    isHex(l.sessionRoomId, PAIRING_ID_RE) &&
    isHex(l.secretKey, KEY_RE)
  )
}
