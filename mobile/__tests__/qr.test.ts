import { parseQrPayload } from '../src/wire/qr'

const GOOD = {
  v: 1,
  relayUrl: 'wss://relay.termpolis.com',
  pairingId: '0123456789abcdef0123456789abcdef',
  desktopPublicKey: '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13',
  oneTimeSecret: 'aa'.repeat(32),
}

function withField(patch: Record<string, unknown>): string {
  return JSON.stringify({ ...GOOD, ...patch })
}

describe('parseQrPayload', () => {
  it('parses a well-formed payload', () => {
    expect(parseQrPayload(JSON.stringify(GOOD))).toEqual(GOOD)
  })

  it('returns null rather than throwing on anything that is not a pairing code', () => {
    // The camera is pointed at an arbitrary surface. A scan of a cereal box
    // should show "that is not a pairing code", not a crash.
    for (const raw of ['', 'hello', '{', 'https://example.com', '[]', 'null', '42', '"x"']) {
      expect(() => parseQrPayload(raw)).not.toThrow()
      expect(parseQrPayload(raw)).toBeNull()
    }
  })

  it('refuses a QR envelope version it does not know', () => {
    expect(parseQrPayload(withField({ v: 2 }))).toBeNull()
    expect(parseQrPayload(withField({ v: '1' }))).toBeNull()
    expect(parseQrPayload(withField({ v: undefined }))).toBeNull()
  })

  it('refuses a relay URL that is not wss:', () => {
    // The transport is not negotiable. A ws:// or http:// URL in a QR is either a
    // downgrade attempt or a misconfiguration, and both end with frames crossing
    // the internet unwrapped by TLS.
    expect(parseQrPayload(withField({ relayUrl: 'ws://relay.termpolis.com' }))).toBeNull()
    expect(parseQrPayload(withField({ relayUrl: 'http://relay.termpolis.com' }))).toBeNull()
    expect(parseQrPayload(withField({ relayUrl: 'https://relay.termpolis.com' }))).toBeNull()
    expect(parseQrPayload(withField({ relayUrl: 'not a url' }))).toBeNull()
    expect(parseQrPayload(withField({ relayUrl: 42 }))).toBeNull()
  })

  it('refuses a pairing id that is not 32 lowercase hex characters', () => {
    for (const bad of ['', 'abc', '0'.repeat(31), '0'.repeat(33), 'A'.repeat(32), 'g'.repeat(32), 7]) {
      expect(parseQrPayload(withField({ pairingId: bad }))).toBeNull()
    }
  })

  it('refuses a desktop public key that is not 64 lowercase hex characters', () => {
    for (const bad of ['', '0'.repeat(63), '0'.repeat(65), 'F'.repeat(64), null]) {
      expect(parseQrPayload(withField({ desktopPublicKey: bad }))).toBeNull()
    }
  })

  it('refuses a one-time secret that is not 64 lowercase hex characters', () => {
    for (const bad of ['', '0'.repeat(63), 'Z'.repeat(64), []]) {
      expect(parseQrPayload(withField({ oneTimeSecret: bad }))).toBeNull()
    }
  })

  it('tolerates unknown fields, because the QR envelope versions independently', () => {
    const parsed = parseQrPayload(withField({ hint: 'David MacBook', futureField: [1, 2] }))
    expect(parsed).toEqual(GOOD)
  })

  it('accepts a relay URL with a port and a path', () => {
    const raw = withField({ relayUrl: 'wss://127.0.0.1:8787/staging' })
    expect(parseQrPayload(raw)?.relayUrl).toBe('wss://127.0.0.1:8787/staging')
  })
})
