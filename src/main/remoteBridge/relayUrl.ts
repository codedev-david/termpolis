/** The only hosts a relay may be reached on without TLS. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost']

/** `wss:`, or `ws:` on this machine only.
 *
 *  The one rule for every relay address Termpolis dials or hands out: the
 *  Remote setting, the rooms this desktop hosts on it, and the relay a link
 *  code names. Kept here, with nothing else in the file, because the bridge
 *  child and main both need it and neither may drag the other's imports in.
 *
 *  Plain `ws:` to another computer is refused because the room ids travel in
 *  the clear. The frames stay sealed either way, but anyone on the network in
 *  between learns when each device connects, and gets the name of a seat it
 *  can take first -- the relay answers the real device with a 409. Loopback
 *  crosses no network, which is what tests and a relay run locally with
 *  wrangler use. The phone goes further and accepts `wss:` alone
 *  (`mobile/src/wire/qr.ts`).
 *
 *  The WHATWG parser lowercases the host and reads `127.1` as `127.0.0.1`, so
 *  this compares what will actually be dialled rather than how it was typed.
 *  `[::1]` stays out: no relay anyone runs listens there, and every loopback
 *  rule is one more way to spell a host. */
export function isSecureRelayUrl(value: unknown): value is string {
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
