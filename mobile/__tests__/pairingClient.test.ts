import { utf8Encode } from '../src/wire/bytes'
import { deviceIdFor } from '../src/wire/pairing'
import { deriveVerificationPhrase } from '../src/wire/safetyNumber'
import {
  FRAME_KEEPALIVE,
  FRAME_PAIRING_ACK,
  GREETING_HEADER_BYTES,
  deriveSessionRoomId,
  pairingRoot,
  sessionFromRoot,
} from '../src/wire/sessionCrypto'
import { PROTOCOL_VERSION } from '../src/wire/version'
import type { RelayControlFrame } from '../src/wire/protocol'
import type { SocketLike } from '../src/net/relaySocket'
import type { QrPayload } from '../src/wire/qr'
import {
  DEFAULT_DESKTOP_LABEL,
  PAIRING_TIMEOUT_MS,
  pairWithDesktop,
  type PairingDeps,
} from '../src/net/pairingClient'

const DESKTOP_SK = '11'.repeat(32)
const DESKTOP_PK = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'
const PHONE_SK = '22'.repeat(32)
const PHONE_PK = '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20'
const PAIRING_ID = '0123456789abcdef0123456789abcdef'
const ONE_TIME_SECRET = 'aa'.repeat(32)
const NOW = 1_700_000_000_000

const OFFER: QrPayload = {
  v: 1,
  relayUrl: 'wss://relay.test',
  pairingId: PAIRING_ID,
  desktopPublicKey: DESKTOP_PK,
  oneTimeSecret: ONE_TIME_SECRET,
}

const IDENTITY = { secretKey: PHONE_SK, publicKey: PHONE_PK }

/** A WebSocket that does nothing until the test tells it to. */
class FakeSocket implements SocketLike {
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly sent: Uint8Array[] = []
  closed = false
  binaryTypeWhenFirstSent: string | null = null

  send(data: Uint8Array): void {
    if (this.binaryTypeWhenFirstSent === null) this.binaryTypeWhenFirstSent = this.binaryType
    this.sent.push(data.slice())
  }

  close(): void {
    this.closed = true
  }

  open(): void {
    this.onopen?.()
  }

  control(frame: RelayControlFrame | string): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }

  binary(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length) })
  }

  drop(): void {
    this.onclose?.()
  }
}

interface Harness {
  sockets: FakeSocket[]
  latest(): FakeSocket
  urls: string[]
  advance(ms: number): void
  deps: PairingDeps
}

function harness(): Harness {
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const clock = { value: NOW }
  const timers = new Map<number, { at: number; fn: () => void }>()
  let nextTimer = 1

  const deps: PairingDeps = {
    open: (url) => {
      urls.push(url)
      const sock = new FakeSocket()
      sockets.push(sock)
      return sock
    },
    now: () => clock.value,
    setTimer: (fn, ms) => {
      const id = nextTimer++
      timers.set(id, { at: clock.value + ms, fn })
      return id
    },
    clearTimer: (timer) => {
      timers.delete(timer as number)
    },
  }

  return {
    sockets,
    latest: () => sockets[sockets.length - 1] as FakeSocket,
    urls,
    advance(ms) {
      clock.value += ms
      for (const [id, t] of [...timers]) {
        if (t.at <= clock.value) {
          timers.delete(id)
          t.fn()
        }
      }
    },
    deps,
  }
}

/** The desktop's half: an ack sealed on a fresh session off the pairing root. */
function sealAck(deviceId: string, opts: { pairingId?: string; version?: number } = {}): Uint8Array {
  const root = pairingRoot(DESKTOP_SK, PHONE_PK, opts.pairingId ?? PAIRING_ID)
  const header = new Uint8Array([FRAME_PAIRING_ACK])
  const payload = { v: opts.version ?? PROTOCOL_VERSION, deviceId }
  return sessionFromRoot(root, 'desktop').seal(header, utf8Encode(JSON.stringify(payload)))
}

function start(h: Harness, label = "David's iPhone"): Promise<unknown> {
  // Attached immediately so a rejection never escapes as an unhandled one, which
  // jest reports as a pass with a warning rather than as the failure it is.
  const promise = pairWithDesktop({ offer: OFFER, identity: IDENTITY, label, deps: h.deps })
  return promise
}

describe('reaching the pairing room', () => {
  it('dials the room the QR names, as the device', async () => {
    const h = harness()
    const p = start(h).catch(() => undefined)
    expect(h.urls).toEqual([`wss://relay.test/v1/pair/${PAIRING_ID}?role=device`])
    h.latest().drop()
    await p
  })

  it('sets binaryType before a byte can be sent', async () => {
    // React Native defaults to 'blob', and send() coerces a Blob to the literal
    // string "[object Blob]" -- every byte of the hello destroyed while the frame
    // count and timing stay right.
    const h = harness()
    const p = start(h).catch(() => undefined)
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    expect(h.latest().binaryTypeWhenFirstSent).toBe('arraybuffer')
    h.latest().drop()
    await p
  })

  it('waits for the desktop rather than shouting into an empty room', async () => {
    // The relay DROPS a frame sent to a room with no partner in it. A hello sent
    // early is not queued, it is gone, and the pairing then times out for a
    // reason nothing on either screen can explain.
    const h = harness()
    const p = start(h).catch(() => undefined)
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: false })
    expect(h.latest().sent).toHaveLength(0)
    h.latest().drop()
    await p
  })

  it('sends the hello once the desktop arrives', async () => {
    const h = harness()
    const p = start(h).catch(() => undefined)
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: false })
    h.latest().control({ kind: 'peer-joined', role: 'desktop' })
    expect(h.latest().sent).toHaveLength(1)
    h.latest().drop()
    await p
  })

  it('sends the hello exactly once when both signals arrive', async () => {
    const h = harness()
    const p = start(h).catch(() => undefined)
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    h.latest().control({ kind: 'peer-joined', role: 'desktop' })
    expect(h.latest().sent).toHaveLength(1)
    h.latest().drop()
    await p
  })

  it('ignores relay text that is not a control frame', async () => {
    const h = harness()
    const p = start(h).catch(() => undefined)
    h.latest().open()
    h.latest().control('{ truncated')
    h.latest().control('null')
    expect(h.latest().sent).toHaveLength(0)
    h.latest().drop()
    await p
  })
})

describe('the hello it sends', () => {
  function helloOf(h: Harness): Uint8Array {
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    return h.latest().sent[0] as Uint8Array
  }

  it('carries the device key in the clear and nothing else', async () => {
    const h = harness()
    const p = start(h).catch(() => undefined)
    const hello = helloOf(h)
    expect(hello[0]).toBe(0x01)
    expect(hello.length).toBeGreaterThan(GREETING_HEADER_BYTES)
    h.latest().drop()
    await p
  })

  it('never lets the one-time secret cross in the clear', async () => {
    // It is a bearer token for this pairing. A relay that could read it could
    // pair itself as the phone.
    const h = harness()
    const p = start(h).catch(() => undefined)
    const hello = helloOf(h)
    const asText = Array.from(hello, (b) => String.fromCharCode(b)).join('')
    expect(asText).not.toContain(ONE_TIME_SECRET)
    expect(asText).not.toContain('aaaaaaaa')
    h.latest().drop()
    await p
  })

  it('never lets the phone label cross in the clear', async () => {
    const h = harness()
    const p = start(h, 'SECRETLABEL').catch(() => undefined)
    const hello = helloOf(h)
    const asText = Array.from(hello, (b) => String.fromCharCode(b)).join('')
    expect(asText).not.toContain('SECRETLABEL')
    h.latest().drop()
    await p
  })
})

describe('the ack it accepts', () => {
  async function paired(): Promise<Record<string, unknown>> {
    const h = harness()
    const p = start(h)
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    h.latest().binary(sealAck(deviceIdFor(PHONE_PK)))
    return (await p) as unknown as Record<string, unknown>
  }

  it('resolves with the desktop the phone is now paired to', async () => {
    const outcome = await paired()
    expect(outcome.desktop).toEqual({
      desktopPublicKey: DESKTOP_PK,
      sessionRoomId: deriveSessionRoomId(PHONE_SK, DESKTOP_PK),
      relayUrl: 'wss://relay.test',
      deviceId: deviceIdFor(PHONE_PK),
      label: DEFAULT_DESKTOP_LABEL,
      pairedAt: NOW,
    })
  })

  it('computes the safety phrase both screens must match', async () => {
    const outcome = await paired()
    expect(outcome.safetyPhrase).toBe(deriveVerificationPhrase(PHONE_PK, DESKTOP_PK))
  })

  it('leaves the pairing room once it is done with it', async () => {
    const h = harness()
    const p = start(h)
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    h.latest().binary(sealAck(deviceIdFor(PHONE_PK)))
    await p
    expect(h.latest().closed).toBe(true)
  })
})

describe('frames it must not be fooled by', () => {
  async function stillWaiting(feed: (h: Harness) => void): Promise<void> {
    const h = harness()
    let settled = false
    const p = start(h).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    feed(h)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(h.latest().closed).toBe(false)
    h.latest().drop()
    await p
  }

  it('ignores a keepalive', async () => {
    // Dropped by tag. The pairing root would refuse it anyway, but only after a
    // decrypt whose failure is indistinguishable from a forgery.
    await stillWaiting((h) => h.latest().binary(new Uint8Array([FRAME_KEEPALIVE])))
  })

  it('ignores a frame sealed under a different pairing', async () => {
    await stillWaiting((h) =>
      h.latest().binary(sealAck(deviceIdFor(PHONE_PK), { pairingId: 'ff'.repeat(16) })),
    )
  })

  it('ignores an ack from a desktop speaking a different protocol version', async () => {
    await stillWaiting((h) => h.latest().binary(sealAck(deviceIdFor(PHONE_PK), { version: 99 })))
  })

  it('ignores an ack whose device id is not a device id', async () => {
    await stillWaiting((h) => h.latest().binary(sealAck('nope')))
  })

  it('ignores a tampered ack', async () => {
    await stillWaiting((h) => {
      const frame = sealAck(deviceIdFor(PHONE_PK))
      frame[frame.length - 1] = (frame[frame.length - 1] as number) ^ 0x01
      h.latest().binary(frame)
    })
  })

  it('ignores junk bytes', async () => {
    await stillWaiting((h) => h.latest().binary(new Uint8Array([0x02, 0x00, 0x01, 0x02])))
  })

  it('ignores a frame that is not bytes at all', async () => {
    await stillWaiting((h) => h.latest().onmessage?.({ data: { not: 'bytes' } }))
  })
})

describe('when pairing does not work', () => {
  it('gives up rather than waiting forever', async () => {
    // A QR is time-boxed on the desktop too. A phone that waits past that is a
    // spinner with nothing behind it.
    const h = harness()
    const p = start(h)
    h.latest().open()
    h.advance(PAIRING_TIMEOUT_MS)
    await expect(p).rejects.toThrow(/timed out/i)
    expect(h.latest().closed).toBe(true)
  })

  it('fails when the socket closes before the ack', async () => {
    const h = harness()
    const p = start(h)
    h.latest().open()
    h.latest().drop()
    await expect(p).rejects.toThrow(/connection/i)
  })

  it('fails when the relay never lets it in', async () => {
    // A duplicate device role is a 409 on the upgrade, so the socket never opens.
    const h = harness()
    const p = start(h)
    h.latest().onerror?.()
    await expect(p).rejects.toThrow(/connection/i)
  })

  it('fails when the desktop cancels the code', async () => {
    const h = harness()
    const p = start(h)
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    h.latest().control({ kind: 'peer-gone', role: 'desktop' })
    await expect(p).rejects.toThrow(/desktop/i)
  })

  it('fails when the relay cuts it for a quota', async () => {
    const h = harness()
    const p = start(h)
    h.latest().open()
    h.latest().control({ kind: 'quota-exceeded', limit: 'frame-rate' })
    await expect(p).rejects.toThrow(/relay/i)
  })

  it('refuses an offer whose pairing id is not a room name', async () => {
    const h = harness()
    await expect(
      pairWithDesktop({
        offer: { ...OFFER, pairingId: 'nope' },
        identity: IDENTITY,
        label: 'phone',
        deps: h.deps,
      }),
    ).rejects.toThrow(/pairing code/i)
    expect(h.sockets).toHaveLength(0)
  })

  it('settles once, whatever arrives afterwards', async () => {
    const h = harness()
    const p = start(h)
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    h.latest().binary(sealAck(deviceIdFor(PHONE_PK)))
    h.latest().drop()
    h.advance(PAIRING_TIMEOUT_MS * 2)
    await expect(p).resolves.toBeDefined()
  })

  it('stops the timeout once it has succeeded', async () => {
    const h = harness()
    const p = start(h)
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    h.latest().binary(sealAck(deviceIdFor(PHONE_PK)))
    await p
    // A live timer here keeps the JS context awake and, on a phone, keeps the
    // radio from idling long after the screen is off.
    expect(() => h.advance(PAIRING_TIMEOUT_MS * 2)).not.toThrow()
  })
})

describe('frames this version of the phone was not written for', () => {
  it('ignores a relay control frame it does not recognise', async () => {
    // The relay is deployed separately from the app stores, so it will one day
    // speak a kind this build has never heard of. An unknown kind is not a
    // failure -- abandoning the pairing over one would strand a phone whose
    // only fault is being a version behind.
    const h = harness()
    const pending = start(h)
    h.latest().open()
    h.latest().control('{"kind":"rate-hint","perMinute":30}')

    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    h.latest().binary(sealAck(deviceIdFor(PHONE_PK)))
    await expect(pending).resolves.toMatchObject({
      desktop: { deviceId: deviceIdFor(PHONE_PK) },
    })
  })

  it('reads an ack delivered as a typed array, not only as an ArrayBuffer', async () => {
    // Same platform quirk the session socket has to survive, and it lands here
    // first: a phone that cannot read the ack never gets as far as a session.
    const h = harness()
    const pending = start(h)
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    h.latest().onmessage?.({ data: sealAck(deviceIdFor(PHONE_PK)) })
    await expect(pending).resolves.toMatchObject({
      desktop: { deviceId: deviceIdFor(PHONE_PK) },
    })
  })
})

describe('a connection that drops in the same breath as the ack', () => {
  it('keeps the pairing it already resolved', async () => {
    // onclose and onerror are the same function, and a relay that cuts the room
    // the instant the ack lands fires both. A second settlement would reject a
    // promise that already resolved -- in Node that is an unhandled rejection,
    // and on the phone it is a pairing the user watched succeed and then fail.
    const h = harness()
    const p = start(h)
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    const down = h.latest().onclose
    h.latest().binary(sealAck(deviceIdFor(PHONE_PK)))

    // The handlers are detached by then, so this is the platform re-entering
    // with an event it had already queued.
    down?.()
    down?.()

    const outcome = (await p) as { desktop: { deviceId: string } }
    expect(outcome.desktop.deviceId).toBe(deviceIdFor(PHONE_PK))
  })

  it('keeps the failure it already rejected with when a late ack arrives', async () => {
    // The desktop closing the QR and the ack it just sent cross on the wire. The
    // relay delivers peer-gone first, and the ack lands on handlers that have
    // been detached -- but the platform had already queued the event, so the
    // listener still runs. Resolving there would settle a rejected promise and
    // leave the phone claiming a pairing the desktop has no record of.
    const h = harness()
    const p = start(h)
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    const deliver = h.latest().onmessage
    h.latest().control({ kind: 'peer-gone', role: 'desktop' })

    const ack = sealAck(deviceIdFor(PHONE_PK))
    deliver?.({ data: ack.buffer.slice(ack.byteOffset, ack.byteOffset + ack.length) })

    await expect(p).rejects.toThrow('The desktop stopped showing that code.')
  })
})
