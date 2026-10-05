import { describe, it, expect } from 'vitest'
import {
  LINK_CODE_PREFIX,
  LINK_OFFER_TTL_MS,
  encodeLinkCode,
  isBridgeLink,
  isLinkRelayUrl,
  parseLinkCode,
} from '../../src/main/remoteBridge/linkCode'
import { createPairingOffer } from '../../src/main/remoteBridge/pairing'
import { generateIdentity } from '../../src/main/remoteBridge/sealedChannel'
import {
  PEER_REQUEST_KINDS,
  isPeerKind,
  type BridgeLink,
} from '../../src/main/remoteBridge/protocol'
// The phone's own scanner. A link code must never parse there: the prefix is
// what keeps a code meant for a computer from pairing a phone by accident.
import { parseQrPayload } from '../../mobile/src/wire/qr'

const desktop = generateIdentity()

/** The QR payload a desktop mints, as JSON -- the exact input `encodeLinkCode` wraps. */
function payload(over: Record<string, unknown> = {}): string {
  const offer = createPairingOffer({ relayUrl: 'wss://relay.test', desktopPublicKey: desktop.publicKey })
  return JSON.stringify({ ...JSON.parse(offer.qrPayload), ...over })
}

/** Wrap arbitrary text the way `encodeLinkCode` would, so a test can hand the
 *  parser any body it likes behind a valid prefix. */
const wrap = (text: string): string => LINK_CODE_PREFIX + Buffer.from(text, 'utf8').toString('base64url')

describe('link code', () => {
  it('round-trips the offer a desktop mints', () => {
    const json = payload()
    const parsed = parseLinkCode(encodeLinkCode(json))
    expect(parsed).toEqual(JSON.parse(json))
  })

  it('is the prefix and then base64url, so it survives being pasted anywhere', () => {
    // No `+`, `/` or `=`: chat apps and URL bars mangle all three.
    const code = encodeLinkCode(payload())
    expect(code.startsWith('termpolis-link:')).toBe(true)
    expect(code.slice(LINK_CODE_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('lives five minutes, because it has to be carried between two computers', () => {
    expect(LINK_OFFER_TTL_MS).toBe(5 * 60_000)
  })

  it('tolerates the whitespace a copy and paste picks up on the way', () => {
    const code = encodeLinkCode(payload())
    const body = code.slice(LINK_CODE_PREFIX.length)
    const mangled = `\n  ${LINK_CODE_PREFIX}${body.slice(0, 40)}\r\n${body.slice(40, 90)} ${body.slice(90)}\t\n`
    expect(parseLinkCode(mangled)).toEqual(parseLinkCode(code))
  })

  it('is never mistaken for a phone pairing QR, nor the QR for a link code', () => {
    const json = payload()
    expect(parseQrPayload(encodeLinkCode(json))).toBeNull()
    // And the other way: a phone QR pasted where a link code belongs.
    expect(parseQrPayload(json)).not.toBeNull()
    expect(parseLinkCode(json)).toBeNull()
  })

  it('drops fields it does not know rather than passing them on', () => {
    const parsed = parseLinkCode(encodeLinkCode(payload({ extra: 'x', v: 1 })))
    expect(parsed).not.toBeNull()
    expect(Object.keys(parsed!).sort()).toEqual(
      ['desktopPublicKey', 'oneTimeSecret', 'pairingId', 'relayUrl', 'v'],
    )
  })

  it.each([
    ['nothing at all', ''],
    ['only the prefix', LINK_CODE_PREFIX],
    ['the prefix in the wrong case', 'Termpolis-Link:' + encodeLinkCode(payload()).slice(LINK_CODE_PREFIX.length)],
    ['characters outside base64url', `${LINK_CODE_PREFIX}abc+/def==`],
    ['base64url that is not JSON', wrap('}{ not json')],
    ['JSON that is a list', wrap('[1,2,3]')],
    ['JSON null', wrap('null')],
    ['a JSON number', wrap('42')],
    ['a JSON string', wrap('"termpolis"')],
    ['a newer envelope version', wrap(payload({ v: 2 }))],
    ['a version spelled as a string', wrap(payload({ v: '1' }))],
    ['no version', wrap(payload({ v: undefined }))],
    ['a plain http relay', wrap(payload({ relayUrl: 'http://relay.test' }))],
    ['an https relay', wrap(payload({ relayUrl: 'https://relay.test' }))],
    ['an unencrypted relay out on the network', wrap(payload({ relayUrl: 'ws://relay.test' }))],
    ['a relay that is not a URL', wrap(payload({ relayUrl: 'relay.test' }))],
    ['a relay that is not a string', wrap(payload({ relayUrl: 7 }))],
    ['an upper-case pairing id', wrap(payload({ pairingId: 'A'.repeat(32) }))],
    ['a short pairing id', wrap(payload({ pairingId: 'a'.repeat(31) }))],
    ['a pairing id that is not a string', wrap(payload({ pairingId: 1 }))],
    ['a short desktop key', wrap(payload({ desktopPublicKey: 'a'.repeat(62) }))],
    ['a desktop key that is not hex', wrap(payload({ desktopPublicKey: 'g'.repeat(64) }))],
    ['a short one-time secret', wrap(payload({ oneTimeSecret: 'b'.repeat(63) }))],
    ['no one-time secret', wrap(payload({ oneTimeSecret: undefined }))],
  ])('refuses %s', (_label, text) => {
    expect(parseLinkCode(text)).toBeNull()
  })

  it('refuses something that is not text at all', () => {
    // It crosses a process boundary on its way here, so its type is a claim.
    expect(parseLinkCode(42 as unknown as string)).toBeNull()
  })

  it('refuses a paste far longer than any code, without decoding it', () => {
    // A real code is a few hundred characters. A paste of a whole log should be
    // refused on its length, not base64-decoded and handed to JSON.parse.
    const huge = encodeLinkCode(payload({ pad: 'x'.repeat(10_000) }))
    expect(parseLinkCode(huge)).toBeNull()
  })

  it.each(['ws://127.0.0.1:8787', 'ws://localhost:8787', 'ws://localhost'])(
    'accepts an unencrypted relay only on this machine: %s',
    (relayUrl) => {
      // Tests and a relay run locally with wrangler. Nothing leaves the machine,
      // so there is no path for a middlebox to read room ids off.
      expect(parseLinkCode(wrap(payload({ relayUrl })))?.relayUrl).toBe(relayUrl)
    },
  )
})

describe('relay URLs a link may name', () => {
  it.each([
    ['wss://relay.termpolis.com', true],
    ['wss://relay.test:8443', true],
    ['ws://127.0.0.1:1', true],
    ['ws://localhost:8787', true],
    ['ws://10.0.0.5', false],
    ['ws://localhost.example.com', false],
    ['https://relay.test', false],
    ['not a url', false],
    [undefined, false],
  ])('%s -> %s', (url, ok) => {
    expect(isLinkRelayUrl(url)).toBe(ok)
  })
})

describe('a joined link as main hands it to the bridge', () => {
  const link = (): BridgeLink => ({
    id: '0123456789abcdef',
    hostPublicKey: 'a'.repeat(64),
    relayUrl: 'wss://relay.test',
    sessionRoomId: 'b'.repeat(32),
    secretKey: 'c'.repeat(64),
  })

  it('accepts a well-formed record', () => {
    expect(isBridgeLink(link())).toBe(true)
  })

  it.each([
    ['null', null],
    ['a string', 'link'],
    ['a short id', { ...link(), id: '0123' }],
    ['a host key that is not hex', { ...link(), hostPublicKey: 'z'.repeat(64) }],
    ['a relay with no TLS', { ...link(), relayUrl: 'ws://relay.test' }],
    ['a room id of the wrong length', { ...link(), sessionRoomId: 'b'.repeat(30) }],
    ['a missing secret', { ...link(), secretKey: undefined }],
  ])('refuses %s', (_label, value) => {
    // A malformed key reaches the curve library inside the relay socket's
    // message handler, where a throw is an uncaught exception in the bridge.
    expect(isBridgeLink(value)).toBe(false)
  })
})

describe('peer request kinds', () => {
  it('names exactly the five linked-machine kinds', () => {
    expect([...PEER_REQUEST_KINDS].sort()).toEqual(
      ['peerBye', 'peerCancel', 'peerHello', 'peerResult', 'peerRun'],
    )
    for (const kind of PEER_REQUEST_KINDS) expect(isPeerKind(kind)).toBe(true)
  })

  it.each(['listTerminals', 'getCapabilities', 'unpair', 'peer', 'PEERHELLO', '', 7, null, undefined])(
    'does not count %s',
    (kind) => {
      expect(isPeerKind(kind)).toBe(false)
    },
  )
})
