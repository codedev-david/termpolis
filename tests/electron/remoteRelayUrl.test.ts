import { describe, it, expect } from 'vitest'
import { isSecureRelayUrl } from '../../src/main/remoteBridge/relayUrl'
import { DEFAULT_RELAY_URL } from '../../src/main/remoteBridge/protocol'

describe('relay URLs Termpolis will dial', () => {
  it.each([
    ['wss://relay.termpolis.com', true],
    ['wss://relay.test:8443', true],
    ['wss://relay.example/ws', true],
    // Loopback: tests, and a relay run locally with wrangler.
    ['ws://127.0.0.1:1', true],
    ['ws://127.0.0.1:9/ws', true],
    ['ws://localhost:8787', true],
    ['ws://localhost', true],
    // The parser lowercases the host and fills in the short IPv4 forms, so the
    // rule judges what will be dialled, not how it was typed.
    ['ws://LOCALHOST:8787', true],
    ['ws://127.1:8787', true],
    // Plain ws:// that crosses a network: room ids in the clear.
    ['ws://10.0.0.5', false],
    ['ws://192.168.1.20:8787', false],
    ['ws://relay.example.com/ws', false],
    // Names that merely start like loopback are somewhere else entirely.
    ['ws://localhost.example.com', false],
    ['ws://127.0.0.1.example.com', false],
    // Loopback over IPv6 is left out on purpose: one more way to spell a host.
    ['ws://[::1]:8787', false],
    ['https://relay.test', false],
    ['http://localhost', false],
    ['wss:', false],
    ['', false],
    ['not a url', false],
    [undefined, false],
    [42, false],
  ])('%s -> %s', (url, ok) => {
    expect(isSecureRelayUrl(url)).toBe(ok)
  })

  it('takes the default relay', () => {
    expect(isSecureRelayUrl(DEFAULT_RELAY_URL)).toBe(true)
  })
})
