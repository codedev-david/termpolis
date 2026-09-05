import { utf8Decode, utf8Encode } from '../src/wire/bytes'
import {
  FRAME_KEEPALIVE,
  FRAME_SESSION,
  Handshake,
  SESSION_HEADER_BYTES,
} from '../src/wire/sessionCrypto'
import type { RelayControlFrame } from '../src/wire/protocol'
import {
  backoffDelay,
  KEEPALIVE_MS,
  RelaySocket,
  type RelaySocketDeps,
  type RelayState,
  type SocketLike,
} from '../src/net/relaySocket'

const DESKTOP_SK = '11'.repeat(32)
const DESKTOP_PK = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'
const PHONE_SK = '22'.repeat(32)
const PHONE_PK = '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20'
const ROOM = 'c9dc49b87f0dc983be61f034ceab7c52'

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

  /** Everything below is the test driving the far end. */
  open(): void {
    this.onopen?.()
  }

  control(frame: RelayControlFrame | string): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }

  binary(frame: Uint8Array): void {
    // React Native hands an ArrayBuffer up once binaryType is 'arraybuffer'.
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length) })
  }

  drop(): void {
    this.onclose?.()
  }
}

interface Harness {
  socket: RelaySocket
  sockets: FakeSocket[]
  latest(): FakeSocket
  states: RelayState[]
  controls: RelayControlFrame[]
  frames: Uint8Array[]
  urls: string[]
  /** Fire every timer whose deadline has passed, advancing the clock first. */
  advance(ms: number): void
  clock: { value: number }
  deps: RelaySocketDeps
}

function harness(overrides: Partial<RelaySocketDeps> = {}): Harness {
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const states: RelayState[] = []
  const controls: RelayControlFrame[] = []
  const frames: Uint8Array[] = []
  const clock = { value: 1_700_000_000_000 }
  const timers = new Map<number, { at: number; fn: () => void }>()
  let nextTimer = 1

  const deps: RelaySocketDeps = {
    url: 'wss://relay.test',
    roomId: ROOM,
    open: (url) => {
      urls.push(url)
      const sock = new FakeSocket()
      sockets.push(sock)
      return sock
    },
    handshake: () => new Handshake('device', PHONE_SK, DESKTOP_PK),
    onFrame: (f) => frames.push(f),
    onControl: (c) => controls.push(c),
    onState: (s) => states.push(s),
    now: () => clock.value,
    setTimer: (fn, ms) => {
      const id = nextTimer++
      timers.set(id, { at: clock.value + ms, fn })
      return id
    },
    clearTimer: (t) => {
      timers.delete(t as number)
    },
    random: () => 0.5,
    ...overrides,
  }

  return {
    socket: new RelaySocket(deps),
    sockets,
    latest: () => sockets[sockets.length - 1] as FakeSocket,
    states,
    controls,
    frames,
    urls,
    clock,
    deps,
    advance(ms) {
      clock.value += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock.value) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
  }
}

/** The desktop half, so a greeting the phone sends can actually be answered. */
function desktopReply(greeting: Uint8Array): { greeting: Uint8Array; seal(text: string): Uint8Array } {
  const hs = new Handshake('desktop', DESKTOP_SK, PHONE_PK)
  const session = hs.accept(greeting)
  if (session === null) throw new Error('the desktop could not accept the phone greeting')
  return {
    greeting: hs.greeting(),
    seal: (text) => session.seal(Uint8Array.from([FRAME_SESSION]), utf8Encode(text)),
  }
}

describe('dialing', () => {
  it('sets binaryType to arraybuffer before anything is sent', () => {
    // React Native's WebSocket defaults to 'blob', and send() does not accept a
    // Blob -- it coerces to a string, so the far end receives the literal text
    // "[object Blob]". Every byte of every sealed frame is destroyed and the
    // connection still looks healthy, because the frame count and timing are right.
    const h = harness()
    h.socket.connect()
    expect(h.latest().binaryType).toBe('arraybuffer')

    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    expect(h.latest().binaryTypeWhenFirstSent).toBe('arraybuffer')
  })

  it('dials the room as the device role', () => {
    const h = harness()
    h.socket.connect()
    expect(h.urls).toEqual([`wss://relay.test/v1/pair/${ROOM}?role=device`])
  })

  it('refuses a room id that is not 32 hex characters, before opening a socket', () => {
    // A malformed room id is a bug in whatever derived it. Dialing anyway would
    // open a Durable Object named after the bug and wait in it forever.
    for (const bad of ['', 'nope', ROOM.toUpperCase(), `${ROOM}0`, ROOM.slice(0, 31), '../admin']) {
      const h = harness({ roomId: bad })
      expect(() => h.socket.connect()).toThrow()
      expect(h.sockets).toHaveLength(0)
    }
  })

  it('reports connecting, then online once the relay seats it', () => {
    const h = harness()
    h.socket.connect()
    expect(h.states).toEqual(['connecting'])

    h.latest().open()
    // A raw socket is not a seat in the room. Only the relay's hello says so.
    expect(h.states).toEqual(['connecting'])

    h.latest().control({ kind: 'hello', role: 'device', peer: false })
    expect(h.states).toEqual(['connecting', 'online'])
  })
})

describe('the greeting rule', () => {
  it('does not greet into an empty room', () => {
    // A frame sent to a room with no partner in it is DROPPED, not queued. The
    // most expensive mistake available in this file is greeting on socket-open:
    // the greeting goes nowhere and the peer waits for a key already thrown away.
    const h = harness()
    h.socket.connect()
    h.latest().open()
    expect(h.latest().sent).toHaveLength(0)

    h.latest().control({ kind: 'hello', role: 'device', peer: false })
    expect(h.latest().sent).toHaveLength(0)
  })

  it('greets when the peer arrives', () => {
    const h = harness()
    h.socket.connect()
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: false })
    h.latest().control({ kind: 'peer-joined', role: 'desktop' })
    expect(h.latest().sent).toHaveLength(1)
  })

  it('greets immediately when the peer is already there', () => {
    const h = harness()
    h.socket.connect()
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    expect(h.latest().sent).toHaveLength(1)
  })

  it('reaches attached once the peer greeting opens', () => {
    const h = harness()
    h.socket.connect()
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    const desktop = desktopReply(h.latest().sent[0] as Uint8Array)

    h.latest().binary(desktop.greeting)
    expect(h.states).toEqual(['connecting', 'online', 'attached'])
  })

  it('mints a new ephemeral key for every attachment', () => {
    // Once per PEER, not once per socket. A phone that reattaches while the same
    // socket holds must not reuse the key recorded traffic was sealed under.
    const h = harness({ handshake: () => new Handshake('device', PHONE_SK, DESKTOP_PK) })
    h.socket.connect()
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    h.latest().control({ kind: 'peer-gone', role: 'desktop' })
    h.latest().control({ kind: 'peer-joined', role: 'desktop' })

    const [first, second] = h.latest().sent
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(Array.from(second as Uint8Array)).not.toEqual(Array.from(first as Uint8Array))
  })
})

/** Connected, seated and attached, with the desktop half in hand. */
function attached(overrides: Partial<RelaySocketDeps> = {}): Harness & {
  desktop: ReturnType<typeof desktopReply>
} {
  const h = harness(overrides)
  h.socket.connect()
  h.latest().open()
  h.latest().control({ kind: 'hello', role: 'device', peer: true })
  const desktop = desktopReply(h.latest().sent[0] as Uint8Array)
  h.latest().binary(desktop.greeting)
  return { ...h, desktop }
}

describe('frames', () => {
  it('hands the opened plaintext up, not the sealed frame', () => {
    const h = attached()
    h.latest().binary(h.desktop.seal('{"kind":"output"}'))
    expect(h.frames).toHaveLength(1)
    expect(utf8Decode(h.frames[0] as Uint8Array)).toBe('{"kind":"output"}')
  })

  it('seals what it is asked to send', () => {
    const h = attached()
    const before = h.latest().sent.length
    h.socket.send(utf8Encode('hello desktop'))
    const frame = h.latest().sent[before] as Uint8Array
    expect(frame[0]).toBe(FRAME_SESSION)
    expect(frame.length).toBeGreaterThan('hello desktop'.length + SESSION_HEADER_BYTES)
  })

  it('drops a send with no session rather than throwing', () => {
    // The output pump runs on every write. Throwing here escapes into a caller
    // that has no way to recover and stalls every later chunk.
    const h = harness()
    h.socket.connect()
    h.latest().open()
    expect(() => h.socket.send(utf8Encode('too early'))).not.toThrow()
    expect(h.latest().sent).toHaveLength(0)
  })

  it('drops a frame that does not open, and stays usable', () => {
    const h = attached()
    const junk = h.desktop.seal('{"kind":"output"}')
    junk[junk.length - 1] = (junk[junk.length - 1] as number) ^ 0x01
    h.latest().binary(junk)
    expect(h.frames).toHaveLength(0)

    h.latest().binary(h.desktop.seal('still here'))
    expect(h.frames).toHaveLength(1)
  })

  it('drops an inbound keepalive by tag before consulting any key', () => {
    // One that reached the greeting path would fail to open and cost the
    // connection -- for a frame whose entire purpose is to keep it.
    const h = attached()
    h.latest().binary(Uint8Array.from([FRAME_KEEPALIVE]))
    expect(h.frames).toHaveLength(0)
    expect(h.latest().closed).toBe(false)
    expect(h.socket.state).toBe('attached')
  })

  it('drops an inbound keepalive that arrives before any session exists', () => {
    const h = harness()
    h.socket.connect()
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: false })
    h.latest().binary(Uint8Array.from([FRAME_KEEPALIVE]))
    expect(h.latest().closed).toBe(false)
    expect(h.socket.state).toBe('online')
  })

  it('closes the socket when the peer greeting will not open', () => {
    const h = harness()
    h.socket.connect()
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: true })
    h.latest().binary(utf8Encode('not a greeting at all, not even close to one'))
    expect(h.latest().closed).toBe(true)
  })
})

describe('keepalive', () => {
  it('sends exactly one zero byte every 120 s while seated', () => {
    const h = harness()
    h.socket.connect()
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: false })
    expect(h.latest().sent).toHaveLength(0)

    h.advance(KEEPALIVE_MS)
    expect(h.latest().sent).toHaveLength(1)
    expect(Array.from(h.latest().sent[0] as Uint8Array)).toEqual([0x00])

    h.advance(KEEPALIVE_MS)
    expect(h.latest().sent).toHaveLength(2)
  })

  it('is 120 s, comfortably inside the relay 300 s idle cut', () => {
    expect(KEEPALIVE_MS).toBe(120_000)
  })

  it('does not send one on a socket that was never seated', () => {
    const h = harness()
    h.socket.connect()
    h.latest().open()
    h.advance(KEEPALIVE_MS * 3)
    expect(h.latest().sent).toHaveLength(0)
  })

  it('stops when the socket goes down', () => {
    const h = harness()
    h.socket.connect()
    h.latest().open()
    h.latest().control({ kind: 'hello', role: 'device', peer: false })
    const first = h.latest()
    first.drop()
    h.advance(KEEPALIVE_MS * 2)
    expect(first.sent).toHaveLength(0)
  })
})

describe('peer-gone', () => {
  it('keeps the socket and reports online, not offline', () => {
    // Losing the DESKTOP is not the same event as losing the RELAY. Reporting
    // offline blames the phone's own network for the desktop walking away.
    const h = attached()
    h.latest().control({ kind: 'peer-gone', role: 'desktop' })
    expect(h.socket.state).toBe('online')
    expect(h.latest().closed).toBe(false)
  })

  it('discards the session, so a stale frame no longer opens', () => {
    // Holding it would route the next peer's greeting down the frame path, where
    // it cannot open, leaving a socket that is connected, attached, and mute.
    const h = attached()
    const stale = h.desktop.seal('from the old session')
    h.latest().control({ kind: 'peer-gone', role: 'desktop' })
    h.latest().binary(stale)
    expect(h.frames).toHaveLength(0)
  })

  it('lets the next peer attach on the same socket', () => {
    const h = attached()
    h.latest().control({ kind: 'peer-gone', role: 'desktop' })
    h.latest().control({ kind: 'peer-joined', role: 'desktop' })
    const next = desktopReply(h.latest().sent[1] as Uint8Array)
    h.latest().binary(next.greeting)
    expect(h.socket.state).toBe('attached')

    h.latest().binary(next.seal('second session'))
    expect(utf8Decode(h.frames[0] as Uint8Array)).toBe('second session')
  })
})

describe('quota', () => {
  it('latches on frame-size and never dials again', () => {
    const h = attached()
    h.latest().control({ kind: 'quota-exceeded', limit: 'frame-size' })
    expect(h.socket.state).toBe('blocked')

    h.latest().drop()
    h.advance(60 * 60 * 1000)
    expect(h.sockets).toHaveLength(1)
  })

  it('latches on frame-rate too', () => {
    // Both mean this client is the problem. Redialing is the loop the relay is
    // defending itself against, and it becomes a denial of service for everyone
    // else on it.
    const h = attached()
    h.latest().control({ kind: 'quota-exceeded', limit: 'frame-rate' })
    h.latest().drop()
    h.advance(60 * 60 * 1000)
    expect(h.sockets).toHaveLength(1)
    expect(h.socket.state).toBe('blocked')
  })

  it('reconnects after an idle cut', () => {
    // An idle cut is not a fault, it is a lost keepalive. Never redialing after
    // one takes remote dark until the app is force-quit and reopened.
    const h = attached()
    h.latest().control({ kind: 'quota-exceeded', limit: 'idle' })
    expect(h.socket.state).not.toBe('blocked')
    h.latest().drop()
    h.advance(60_000)
    expect(h.sockets).toHaveLength(2)
  })

  it('reconnects after a connection-bytes cut', () => {
    // 256 MiB to reach, so a loop on it is self-limiting. Worth reporting, not
    // worth stranding a heavy user for.
    const h = attached()
    h.latest().control({ kind: 'quota-exceeded', limit: 'connection-bytes' })
    h.latest().drop()
    h.advance(60_000)
    expect(h.sockets).toHaveLength(2)
  })

  it('reports every limit to the caller, fatal or not', () => {
    const h = attached()
    h.latest().control({ kind: 'quota-exceeded', limit: 'idle' })
    expect(h.controls).toContainEqual({ kind: 'quota-exceeded', limit: 'idle' })
  })
})

describe('control frames are hints, never instructions', () => {
  it('drops unparseable text without disconnecting', () => {
    const h = attached()
    h.latest().control('{not json')
    expect(h.latest().closed).toBe(false)
    expect(h.socket.state).toBe('attached')
  })

  it('drops a control frame of an unknown kind', () => {
    const h = attached()
    h.latest().control(JSON.parse('{"kind":"shutdown-everything"}'))
    expect(h.latest().closed).toBe(false)
    expect(h.socket.state).toBe('attached')
  })

  it('drops text that parses to something that is not an object', () => {
    const h = attached()
    for (const text of ['null', '42', '"hello"', '[]', 'true']) {
      h.latest().control(text)
    }
    expect(h.latest().closed).toBe(false)
    expect(h.socket.state).toBe('attached')
  })
})

describe('backoff', () => {
  it('is monotonic in the attempt number', () => {
    let previous = 0
    for (let attempt = 0; attempt < 12; attempt++) {
      const delay = backoffDelay(attempt, () => 0.5)
      expect(delay).toBeGreaterThanOrEqual(previous)
      previous = delay
    }
  })

  it('is capped at a minute', () => {
    // The ceiling matters more than the curve. A phone left on a table against a
    // relay that is down would otherwise reach delays measured in days and never
    // notice it come back.
    for (const attempt of [10, 20, 40, 100]) {
      expect(backoffDelay(attempt, () => 1)).toBeLessThanOrEqual(60_000)
    }
  })

  it('is jittered, so a relay coming back does not get every phone at once', () => {
    const low = backoffDelay(6, () => 0)
    const high = backoffDelay(6, () => 1)
    expect(low).toBeLessThan(high)
    expect(low).toBeGreaterThan(0)
  })

  it('never returns a delay of zero, however the jitter falls', () => {
    for (const r of [0, 0.5, 1]) expect(backoffDelay(0, () => r)).toBeGreaterThan(0)
  })

  it('grows across repeated failures, so a 409 does not become a tight loop', () => {
    // A 409 is the relay refusing a second device in the room. The upgrade never
    // completes, so the socket closes without ever opening -- and because the
    // attempt counter resets on open, not on dial, that keeps backing off.
    const h = harness()
    h.socket.connect()
    const delays: number[] = []
    for (let i = 0; i < 5; i++) {
      h.latest().drop()
      const before = h.sockets.length
      let waited = 0
      while (h.sockets.length === before && waited < 200_000) {
        h.advance(500)
        waited += 500
      }
      delays.push(waited)
    }
    expect(delays[4]).toBeGreaterThan(delays[0] as number)
    expect(h.sockets).toHaveLength(6)
  })

  it('resets once a socket actually opens', () => {
    const h = harness()
    h.socket.connect()
    h.latest().drop()
    h.advance(5_000)
    h.latest().open()
    h.latest().drop()
    // Back to the first rung: one second, jittered down to half of it.
    h.advance(1_000)
    expect(h.sockets).toHaveLength(3)
  })
})

describe('teardown', () => {
  it('reports offline and stops dialing after close', () => {
    const h = attached()
    h.socket.close()
    expect(h.socket.state).toBe('offline')
    expect(h.latest().closed).toBe(true)

    h.advance(60 * 60 * 1000)
    expect(h.sockets).toHaveLength(1)
  })

  it('discards the session on close, so a stale frame cannot open later', () => {
    const h = attached()
    const stale = h.desktop.seal('after close')
    h.socket.close()
    h.latest().binary(stale)
    expect(h.frames).toHaveLength(0)
  })

  it('counts an error followed by a close as one outage', () => {
    // React Native fires both. Counting two would double the backoff twice for
    // a single dropped connection.
    const h = harness()
    h.socket.connect()
    h.latest().open()
    h.latest().onerror?.()
    h.latest().drop()
    h.advance(1_000)
    expect(h.sockets).toHaveLength(2)
  })

  it('ignores a close from a socket it already replaced', () => {
    const h = harness()
    h.socket.connect()
    const first = h.latest()
    first.drop()
    h.advance(1_000)
    expect(h.sockets).toHaveLength(2)

    first.drop()
    h.advance(60_000)
    expect(h.sockets).toHaveLength(2)
  })
})

describe('keepalive backs off around real traffic', () => {
  it('skips a beat when a session frame went out recently', () => {
    // The relay's idle timer watches the last binary frame of any kind, so a
    // request holds the room just as well. Sending a keepalive anyway wakes the
    // radio for nothing, which on a phone is battery rather than bytes.
    const h = attached()
    h.advance(KEEPALIVE_MS - 1_000)
    const before = h.latest().sent.length
    h.socket.send(utf8Encode('a keystroke'))
    h.advance(1_000)
    expect(h.latest().sent).toHaveLength(before + 1)
  })

  it('sends one once the traffic actually stops', () => {
    const h = attached()
    h.socket.send(utf8Encode('a keystroke'))
    const before = h.latest().sent.length
    h.advance(KEEPALIVE_MS)
    h.advance(KEEPALIVE_MS)
    expect(h.latest().sent.length).toBeGreaterThan(before)
    const last = h.latest().sent[h.latest().sent.length - 1] as Uint8Array
    expect(Array.from(last)).toEqual([0x00])
  })
})
