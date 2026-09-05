import { describe, it, expect, vi, afterEach } from 'vitest'
import { RelayClient, backoffDelay, KEEPALIVE_MS } from '../../src/main/remoteBridge/relayClient'
import { generateIdentity } from '../../src/main/remoteBridge/sealedChannel'
import {
  Handshake,
  FRAME_KEEPALIVE,
  FRAME_SESSION,
  type SealedSession,
} from '../../src/main/remoteBridge/sessionCrypto'
// The relay's own encoder and its idle window, imported from the relay package
// rather than restated here. A hand-written control frame would let this suite
// keep passing against a shape the relay stopped sending -- which is precisely the
// class of drift Task 5 exists to close.
import { encode, type ControlFrame } from '../../relay/src/wire'
import { IDLE_TIMEOUT_MS } from '../../relay/src/quota'

/** The one-byte header every session frame carries, and the AEAD's associated data. */
const H = new Uint8Array([FRAME_SESSION])

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const envelope = (id: number): Uint8Array =>
  enc(JSON.stringify({ id, request: { kind: 'listTerminals' } }))

/** A socket that records what was written and lets the test push frames in. */
function fakeSocket() {
  const listeners = new Map<string, ((...a: never[]) => void)[]>()
  return {
    sent: [] as Uint8Array[],
    closed: false,
    on(event: string, fn: (...a: never[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
      return this
    },
    send(data: Uint8Array) {
      this.sent.push(data)
    },
    close() {
      this.closed = true
      this.emit('close')
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) (fn as (...a: unknown[]) => void)(...args)
    },
  }
}

/** A fresh socket per dial, so reconnects are countable and listeners from a
 *  dead connection never leak into the next one. */
function opener() {
  const sockets: ReturnType<typeof fakeSocket>[] = []
  return {
    sockets,
    open: () => {
      const s = fakeSocket()
      sockets.push(s)
      return s as never
    },
  }
}

/** A paired desktop and phone.
 *
 *  Both sides are FACTORIES rather than channels, because a handshake is spent
 *  once: the client mints one per peer and so must the test's phone. */
function pair() {
  const desktop = generateIdentity()
  const phone = generateIdentity()
  return {
    handshake: () =>
      new Handshake({
        ownSecretKey: desktop.secretKey,
        peerPublicKey: phone.publicKey,
        role: 'desktop' as const,
      }),
    phone: () =>
      new Handshake({
        ownSecretKey: phone.secretKey,
        peerPublicKey: desktop.publicKey,
        role: 'device' as const,
      }),
  }
}

type Deps = ConstructorParameters<typeof RelayClient>[0]
type RelayClientTestRequest = Deps['onRequest']

/** Every client this suite builds, stopped after the test that built it.
 *
 *  A seated client holds a repeating keepalive. One left running outlives its
 *  test, fires into a fake socket nothing is watching, and keeps the worker's
 *  event loop alive after the suite has finished. */
const live: RelayClient[] = []
afterEach(() => {
  for (const c of live.splice(0)) c.stop()
})

function build(p: ReturnType<typeof pair>, open: Deps['openSocket'], extra: Partial<Deps> = {}) {
  const c = new RelayClient({
    url: 'wss://relay.test',
    roomId: 'a'.repeat(32),
    handshake: p.handshake,
    onRequest: vi.fn(),
    onStateChange: () => {},
    openSocket: open,
    ...extra,
  })
  live.push(c)
  return c
}

function client(
  sock: ReturnType<typeof fakeSocket>,
  p: ReturnType<typeof pair>,
  onRequest: RelayClientTestRequest,
  onStateChange: (s: string) => void = () => {},
) {
  return build(p, () => sock as never, { onRequest, onStateChange })
}

/** Push one of the relay's control frames in, encoded by the relay's own encoder. */
function control(sock: ReturnType<typeof fakeSocket>, frame: ControlFrame): void {
  sock.emit('message', Buffer.from(encode(frame)), false)
}

/** Take a seat in the room. `peer` is whether the phone is already in it. */
function seat(sock: ReturnType<typeof fakeSocket>, peer: boolean): void {
  control(sock, { kind: 'hello', role: 'desktop', peer })
}

/** Drive a whole attachment the way the relay and a real phone do, and hand back
 *  the phone's end of the session.
 *
 *  Nearly every test needs this: nothing opens until the relay has seated the
 *  desktop AND both greetings have crossed. The desktop's greeting is SHIFTED off
 *  `sent` rather than read in place, so assertions about what the client wrote
 *  still index from zero. */
function connect(sock: ReturnType<typeof fakeSocket>, p: ReturnType<typeof pair>): SealedSession {
  sock.emit('open')
  seat(sock, true)
  const phone = p.phone()
  const session = phone.accept(sock.sent.shift()!)
  sock.emit('message', Buffer.from(phone.greeting), true)
  return session
}

describe('relay client', () => {
  it('opens a sealed request, dispatches it, and seals the response back', async () => {
    const p = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn().mockResolvedValue({ kind: 'ok', id: 1, data: { terminals: [] } })

    const c = client(sock, p, onRequest)
    c.start()
    const phoneSide = connect(sock, p)

    sock.emit('message', Buffer.from(phoneSide.seal(H, envelope(1))), true)
    await vi.waitFor(() => expect(sock.sent.length).toBe(1))

    expect(onRequest).toHaveBeenCalledWith({ id: 1, request: { kind: 'listTerminals' } })
    const reply = JSON.parse(new TextDecoder().decode(phoneSide.open(sock.sent[0], 1)))
    expect(reply).toEqual({ kind: 'ok', id: 1, data: { terminals: [] } })
  })

  // The relay is untrusted and the phone may be hostile. Neither may make the
  // desktop throw its way out of the message handler and kill the connection.
  it('ignores a frame it cannot open instead of dying', async () => {
    const p = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn()

    const c = client(sock, p, onRequest)
    c.start()
    connect(sock, p)

    sock.emit('message', Buffer.from([1, 2, 3, 4]), true) // not a sealed frame
    await new Promise((r) => setTimeout(r, 20))

    expect(onRequest).not.toHaveBeenCalled()
    expect(sock.closed).toBe(false)
  })

  it('ignores an authentic frame whose plaintext is not a request envelope', async () => {
    const p = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn()

    const c = client(sock, p, onRequest)
    c.start()
    const phoneSide = connect(sock, p)

    sock.emit('message', Buffer.from(phoneSide.seal(H, enc('not json'))), true)
    await new Promise((r) => setTimeout(r, 20))
    expect(onRequest).not.toHaveBeenCalled()
  })

  it('reports offline and does not send when the socket is gone', () => {
    const p = pair()
    const states: string[] = []
    const sock = fakeSocket()

    const c = client(sock, p, vi.fn(), (s) => states.push(s))
    c.start()
    connect(sock, p)
    expect(states).toContain('attached')
    sock.emit('close')
    expect(states).toContain('offline')

    // Fails closed: a send with no socket is dropped, never buffered forever and
    // never written to the socket that just died.
    expect(() => c.send({ any: 'thing' })).not.toThrow()
    expect(sock.sent).toHaveLength(0)
  })

  it('is connecting until the relay seats it and online until the peer greets', () => {
    // Three states across one connection, and each boundary matters.
    //
    // An open socket is not a seat in the room, so nothing is written before
    // `hello` -- a greeting sent then goes to a relay that has not decided where
    // to put it.
    //
    // A seat is not a peer. The state must not read `attached` while there is no
    // key, because the bridge DRAINS the fan-out on that edge and draining is
    // destructive: output handed to a client that cannot seal is output deleted.
    //
    // And `send` must drop rather than throw throughout. The output pump runs on
    // every terminal write, so a throw here escapes into the pump and stalls
    // every later chunk for this device.
    const p = pair()
    const states: string[] = []
    const sock = fakeSocket()
    const c = client(sock, p, vi.fn(), (s) => states.push(s))

    c.start()
    sock.emit('open')
    expect(c.state).toBe('connecting')
    expect(sock.sent).toHaveLength(0)

    seat(sock, true)
    expect(c.state).toBe('online')
    expect(states).not.toContain('attached')

    expect(() => c.send({ kind: 'output', chunks: [] })).not.toThrow()
    // The greeting, and nothing else. Sealing with no key cannot have happened.
    expect(sock.sent).toHaveLength(1)

    const phone = p.phone()
    phone.accept(sock.sent[0])
    sock.emit('message', Buffer.from(phone.greeting), true)
    expect(c.state).toBe('attached')
  })

  it('waits for a peer before greeting, so its handshake is not thrown away', () => {
    // The desktop is almost always first into the room, and the relay DROPS a
    // binary frame addressed to a room with nobody else in it -- it does not
    // queue it. Greeting on connect therefore spent the desktop's half of the
    // handshake on nothing: the phone arrived later, greeted, and the desktop
    // accepted and reported itself connected while the phone waited forever for a
    // key that had already been discarded. Output then flowed one way into a
    // phone with no key to open it, which looks exactly like a working link.
    const p = pair()
    const sock = fakeSocket()
    const c = client(sock, p, vi.fn())
    c.start()
    sock.emit('open')

    seat(sock, false)
    expect(c.state).toBe('online')
    expect(sock.sent).toHaveLength(0)

    control(sock, { kind: 'peer-joined', role: 'device' })
    expect(sock.sent).toHaveLength(1)

    const phone = p.phone()
    phone.accept(sock.sent[0])
    sock.emit('message', Buffer.from(phone.greeting), true)
    expect(c.state).toBe('attached')
  })

  it('greets with keys of its own on every dial', () => {
    vi.useFakeTimers()
    try {
      const p = pair()
      const o = opener()
      const c = build(p, o.open)
      c.start()
      o.sockets[0].emit('open')
      seat(o.sockets[0], true)
      expect(o.sockets[0].sent).toHaveLength(1)
      const first = o.sockets[0].sent[0]

      o.sockets[0].emit('close')
      vi.advanceTimersByTime(backoffDelay(0))
      o.sockets[1].emit('open')
      seat(o.sockets[1], true)

      // A FRESH greeting, not the first one resent. Reusing it would reuse the
      // ephemeral key and hand every connection the same session key -- exactly
      // the property this rewrite exists to establish.
      expect(o.sockets[1].sent).toHaveLength(1)
      expect(Buffer.from(o.sockets[1].sent[0]).equals(Buffer.from(first))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts a fresh session on reconnect, and frames from the old one are dead', async () => {
    vi.useFakeTimers()
    try {
      const p = pair()
      const o = opener()
      const onRequest = vi.fn().mockResolvedValue({ kind: 'ok', id: 1, data: { terminals: [] } })
      const c = build(p, o.open, { onRequest })
      c.start()

      const first = connect(o.sockets[0], p)
      expect(c.state).toBe('attached')
      const stale = first.seal(H, envelope(1))

      o.sockets[0].emit('close')
      vi.advanceTimersByTime(backoffDelay(0))

      // The second connection has to complete a handshake of its own. Carrying
      // the first one's session across is not a cosmetic leak: the message
      // handler routes on whether a session exists, so a stale one sends the
      // peer's greeting down the frame path where it cannot open -- and the
      // socket then sits connected and permanently mute.
      const second = connect(o.sockets[1], p)
      expect(c.state).toBe('attached')

      o.sockets[1].emit('message', Buffer.from(stale), true)
      await vi.advanceTimersByTimeAsync(0)
      expect(onRequest).not.toHaveBeenCalled()

      o.sockets[1].emit('message', Buffer.from(second.seal(H, envelope(2))), true)
      await vi.advanceTimersByTimeAsync(0)
      expect(onRequest).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to online when the peer leaves, and re-greets the one that replaces it', async () => {
    // A phone that drops and comes back inside one desktop socket lifetime. The
    // desktop's connection never wavered, so nothing tears it down and re-dials --
    // which means without `peer-gone` clearing the session, the returning phone's
    // greeting reaches the FRAME path, fails to open, and is dropped. The socket
    // then sits connected, reporting itself attached, and permanently mute.
    const p = pair()
    const sock = fakeSocket()
    const states: string[] = []
    const onRequest = vi.fn().mockResolvedValue({ kind: 'ok', id: 2, data: null })
    const c = client(sock, p, onRequest, (s) => states.push(s))
    c.start()

    const first = connect(sock, p)
    const stale = first.seal(H, envelope(1))

    control(sock, { kind: 'peer-gone', role: 'device' })
    // Online, NOT offline. This desktop is still seated and still reachable;
    // saying otherwise blames the wrong machine for the phone walking away.
    expect(c.state).toBe('online')
    expect(states).not.toContain('offline')
    expect(sock.closed).toBe(false)

    control(sock, { kind: 'peer-joined', role: 'device' })
    // A second greeting on the SAME socket, with an ephemeral key of its own --
    // re-sending the first would hand two different phones one session key.
    expect(sock.sent).toHaveLength(1)
    const phone = p.phone()
    const second = phone.accept(sock.sent.shift()!)
    sock.emit('message', Buffer.from(phone.greeting), true)
    expect(c.state).toBe('attached')

    sock.emit('message', Buffer.from(stale), true)
    await new Promise((r) => setTimeout(r, 20))
    expect(onRequest).not.toHaveBeenCalled()

    sock.emit('message', Buffer.from(second.seal(H, envelope(2))), true)
    await vi.waitFor(() => expect(onRequest).toHaveBeenCalledOnce())
  })

  it('drops the connection when the peer greeting will not open', () => {
    // An impostor in the room, or a relay substituting a key of its own. Sitting
    // in a half-open state would leave the desktop looking connected forever;
    // closing hands it to the backoff, which is the one path that can recover.
    const p = pair()
    const sock = fakeSocket()
    const states: string[] = []
    const c = client(sock, p, vi.fn(), (s) => states.push(s))
    c.start()
    sock.emit('open')
    seat(sock, true)

    const impostor = new Handshake({
      ownSecretKey: generateIdentity().secretKey,
      peerPublicKey: generateIdentity().publicKey,
      role: 'device',
    })
    sock.emit('message', Buffer.from(impostor.greeting), true)

    expect(sock.closed).toBe(true)
    expect(states).not.toContain('attached')
  })

  it('survives a frame that arrives before the socket opened', () => {
    // `ws` will not do this, but the relay is untrusted and nothing about the
    // handler's contract stops a hostile one from trying. There is no handshake
    // to accept with yet -- not even a seat in the room -- and that has to look
    // like every other bad greeting rather than an unhandled throw out of the
    // listener.
    const p = pair()
    const sock = fakeSocket()
    const c = client(sock, p, vi.fn())
    c.start()
    expect(() => sock.emit('message', Buffer.from([9, 9, 9]), true)).not.toThrow()
    expect(sock.closed).toBe(true)
  })

  it('answers a request whose handler throws instead of leaving the phone hanging', async () => {
    const p = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn().mockRejectedValue(new Error('terminal is gone'))

    const c = client(sock, p, onRequest)
    c.start()
    const phoneSide = connect(sock, p)
    sock.emit('message', Buffer.from(phoneSide.seal(H, envelope(7))), true)
    await vi.waitFor(() => expect(sock.sent.length).toBe(1))

    // Silence here would strand the caller: every phone request is correlated by
    // id and waits for exactly one reply. A thrown dispatch still owes an answer.
    expect(JSON.parse(new TextDecoder().decode(phoneSide.open(sock.sent[0], 1)))).toEqual({
      kind: 'error',
      id: 7,
      message: 'terminal is gone',
    })
  })

  it.each([
    ['a bare null', 'null'],
    ['an id that is not a number', '{"id":"1","request":{"kind":"listTerminals"}}'],
    ['a request with no kind', '{"id":1,"request":{}}'],
    ['no request at all', '{"id":1}'],
  ])('ignores authentic JSON that is %s', async (_label, body) => {
    const p = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn()

    const c = client(sock, p, onRequest)
    c.start()
    const phoneSide = connect(sock, p)
    sock.emit('message', Buffer.from(phoneSide.seal(H, enc(body))), true)
    await new Promise((r) => setTimeout(r, 20))

    // The frame is authentic -- it came from the paired phone. Authenticity is not
    // well-formedness, and the dispatcher is not the place to discover that.
    expect(onRequest).not.toHaveBeenCalled()
  })

  it('ignores text that is not a control frame it knows', async () => {
    const p = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn()
    const states: string[] = []

    const c = client(sock, p, onRequest, (s) => states.push(s))
    c.start()
    const phoneSide = connect(sock, p)
    const before = states.length

    // Not JSON at all; JSON of a kind this version has never heard of; and a
    // perfectly good sealed frame delivered on the text channel. A control frame
    // is a hint from an untrusted relay, so none of these may reach the opener,
    // change state, or cost the connection.
    sock.emit('message', Buffer.from('}{ not json'), false)
    sock.emit('message', Buffer.from(JSON.stringify({ kind: 'from-the-future' })), false)
    sock.emit('message', Buffer.from(phoneSide.seal(H, envelope(1))), false)
    await new Promise((r) => setTimeout(r, 20))

    expect(onRequest).not.toHaveBeenCalled()
    expect(sock.closed).toBe(false)
    expect(states).toHaveLength(before)
    expect(c.state).toBe('attached')
  })

  it.each(['frame-size', 'frame-rate'] as const)(
    'stops redialing when the relay cuts it for %s',
    (limit) => {
      // Both mean this desktop is the problem, and reconnecting does not fix a
      // frame this desktop will just send again. A client that cannot tell "you
      // sent too much" from "the network broke" turns its own bug into a denial
      // of service against everyone else on the relay.
      vi.useFakeTimers()
      try {
        const p = pair()
        const o = opener()
        const states: string[] = []
        const c = build(p, o.open, { onStateChange: (s) => states.push(s) })
        c.start()
        o.sockets[0].emit('open')
        seat(o.sockets[0], false)

        control(o.sockets[0], { kind: 'quota-exceeded', limit })
        o.sockets[0].emit('close')
        vi.advanceTimersByTime(10 * 60_000)

        expect(o.sockets.length).toBe(1)
        expect(states).toContain('offline')
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it.each(['idle', 'connection-bytes'] as const)('redials after a %s cut', (limit) => {
    // Neither is a fault worth latching. An idle cut means a keepalive was lost,
    // and never redialing after one takes remote dark until the app restarts.
    // `connection-bytes` takes 256 MiB to reach, so a loop on it is self-limiting
    // -- worth reporting, not worth stranding a heavy user for.
    vi.useFakeTimers()
    try {
      const p = pair()
      const o = opener()
      const c = build(p, o.open)
      c.start()
      o.sockets[0].emit('open')
      seat(o.sockets[0], false)

      control(o.sockets[0], { kind: 'quota-exceeded', limit })
      o.sockets[0].emit('close')
      vi.advanceTimersByTime(backoffDelay(0))

      expect(o.sockets.length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tells the host which limit the relay cut it for', () => {
    // The room going quiet is the only other symptom. Without the limit, a user
    // watching a phone that stopped working has nothing to act on.
    const p = pair()
    const sock = fakeSocket()
    const onQuota = vi.fn()
    const c = build(p, () => sock as never, { onQuota })
    c.start()
    sock.emit('open')
    seat(sock, false)

    control(sock, { kind: 'quota-exceeded', limit: 'frame-rate' })
    expect(onQuota).toHaveBeenCalledWith('frame-rate')
  })

  it('redials after a drop, and counts one failure when error precedes close', () => {
    vi.useFakeTimers()
    try {
      const p = pair()
      const o = opener()
      const c = build(p, o.open)
      c.start()
      o.sockets[0].emit('open')

      // `ws` emits `error` and then `close` for a single failed connection. Without
      // the socket-identity guard both would count, the attempt counter would
      // advance twice per outage, and the backoff would reach its ceiling in half
      // the failures it should.
      o.sockets[0].emit('error', new Error('ECONNRESET'))
      o.sockets[0].emit('close')
      expect(o.sockets.length).toBe(1)

      vi.advanceTimersByTime(backoffDelay(0))
      expect(o.sockets.length).toBe(2)

      o.sockets[1].emit('open')
      o.sockets[1].emit('close')
      // A connection that opened resets the attempt count, so a long-lived session
      // that drops once does not inherit last week's backoff.
      vi.advanceTimersByTime(backoffDelay(0))
      expect(o.sockets.length).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lengthens the delay while dials keep failing', () => {
    vi.useFakeTimers()
    try {
      const p = pair()
      const o = opener()
      const c = build(p, o.open)
      c.start()
      o.sockets[0].emit('close')
      vi.advanceTimersByTime(backoffDelay(0))
      expect(o.sockets.length).toBe(2)

      // Never opened, so the second failure must wait longer than the first. A flat
      // retry from a fleet of desktops is a self-inflicted flood the moment the
      // relay restarts.
      o.sockets[1].emit('close')
      vi.advanceTimersByTime(backoffDelay(0))
      expect(o.sockets.length).toBe(2)
      vi.advanceTimersByTime(backoffDelay(1) - backoffDelay(0))
      expect(o.sockets.length).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending redial when stopped', () => {
    vi.useFakeTimers()
    try {
      const p = pair()
      const o = opener()
      const states: string[] = []
      const c = build(p, o.open, { onStateChange: (s) => states.push(s) })
      c.start()
      o.sockets[0].emit('close')
      c.stop()
      vi.advanceTimersByTime(10 * 60_000)

      // A timer that outlives stop() reconnects an unpaired desktop to a relay it
      // was told to leave.
      expect(o.sockets.length).toBe(1)
      // Already offline when stopped: no duplicate notification.
      expect(states.filter((x) => x === 'offline').length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays down after being stopped while still connected', () => {
    vi.useFakeTimers()
    try {
      const p = pair()
      const o = opener()
      const states: string[] = []
      const c = build(p, o.open, { onStateChange: (x) => states.push(x) })
      c.start()
      o.sockets[0].emit('open')

      // stop() closes the socket, and closing it fires the same `close` handler an
      // outage would. Nothing but the stopped flag tells the two apart, so without
      // it an unpaired desktop keeps redialling the room it was told to leave --
      // and the earlier stop test cannot see this, because there the socket was
      // already gone and stop() had nothing left to close.
      c.stop()
      vi.advanceTimersByTime(10 * 60_000)

      expect(o.sockets.length).toBe(1)
      expect(o.sockets[0].closed).toBe(true)
      expect(c.state).toBe('offline')
      expect(states.filter((x) => x === 'offline').length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('swallows a write that races the socket closing', () => {
    const p = pair()
    const sock = fakeSocket()
    const c = client(sock, p, vi.fn())
    c.start()
    connect(sock, p)
    // Broken only now, so the greeting exchange lands normally and the client
    // reaches a state where it has a session to seal with. Breaking `send` before
    // the handshake would test the no-session drop instead, which is a different
    // test above.
    sock.send = () => {
      throw new Error('WebSocket is not open')
    }

    // The close event has not arrived yet but the socket is already gone. Throwing
    // here would escape the output pump and stall every later chunk.
    expect(() => c.send({ kind: 'output', chunks: [] })).not.toThrow()
  })

  it('dials a real ws socket when no opener is injected', async () => {
    const p = pair()
    const states: string[] = []
    const c = build(p, undefined, {
      // Port 1 refuses immediately. The point is not the connection but that the
      // production path -- new WebSocket(url) from the `ws` package -- constructs
      // and wires up at all under the Node that Electron ships, which no injected
      // fake can tell us.
      url: 'ws://127.0.0.1:1',
      onStateChange: (x) => states.push(x),
    })
    c.start()
    expect(states).toEqual(['connecting'])
    await new Promise((r) => setTimeout(r, 100))
    c.stop()
    expect(states).toContain('offline')
  })

  it('backs off exponentially with a ceiling', () => {
    expect(backoffDelay(0)).toBe(1000)
    expect(backoffDelay(1)).toBe(2000)
    expect(backoffDelay(2)).toBe(4000)
    expect(backoffDelay(10)).toBe(60_000) // ceiling
    expect(backoffDelay(100)).toBe(60_000)
  })
})

describe('relay client keepalive', () => {
  it('holds the room open while it waits alone, without greeting', () => {
    // The state this exists for: seated, no peer, and therefore no session and
    // nothing to seal. The relay drops TEXT above its `lastSeen` update, so only a
    // BINARY frame refreshes the idle clock -- which means a waiting desktop with
    // nothing to send is cut every five minutes and redials a second later,
    // forever, opening a window each time in which the phone finds an empty room.
    vi.useFakeTimers()
    try {
      const p = pair()
      const sock = fakeSocket()
      const c = client(sock, p, vi.fn())
      c.start()
      sock.emit('open')
      seat(sock, false)
      expect(sock.sent).toHaveLength(0)

      vi.advanceTimersByTime(KEEPALIVE_MS)
      expect(sock.sent).toHaveLength(1)
      // One reserved byte and nothing else. There is nothing in a keepalive to
      // protect and no state it can move, which is what lets it be sent with no
      // key in hand.
      expect([...sock.sent[0]]).toEqual([FRAME_KEEPALIVE])

      vi.advanceTimersByTime(KEEPALIVE_MS)
      expect(sock.sent).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pings often enough to survive a lost frame', () => {
    // Cross-package, like the frame-size assertion in remoteOutputChunker: the two
    // numbers live in packages that compile for different runtimes and cannot
    // share a module. Two intervals inside the window is the margin -- at one, a
    // single dropped keepalive costs the room.
    expect(KEEPALIVE_MS * 2).toBeLessThan(IDLE_TIMEOUT_MS)
  })

  it('stops pinging when the socket dies, and when the client is stopped', () => {
    vi.useFakeTimers()
    try {
      const p = pair()
      const o = opener()
      const c = build(p, o.open)
      c.start()
      o.sockets[0].emit('open')
      seat(o.sockets[0], false)

      o.sockets[0].emit('close')
      vi.advanceTimersByTime(10 * KEEPALIVE_MS)
      // An interval nothing holds a handle to, firing `send` into a dead socket,
      // throws out of a timer callback -- which in the bridge process is a crash,
      // not a logged warning.
      expect(o.sockets[0].sent).toHaveLength(0)

      vi.advanceTimersByTime(backoffDelay(0))
      o.sockets[1].emit('open')
      seat(o.sockets[1], false)
      c.stop()
      vi.advanceTimersByTime(10 * KEEPALIVE_MS)
      expect(o.sockets[1].sent).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops pinging when stopped before the close event arrives', () => {
    // `ws.close()` starts a closing handshake and the `close` event lands later.
    // By then `stop()` has dropped its reference to the socket, so `down` -- which
    // is what clears the keepalive on an ordinary outage -- sees a socket it no
    // longer owns and returns having done nothing. Every other fake in this file
    // closes synchronously and so cannot show this: the interval would survive
    // stop(), and firing `send` into a closed socket throws out of a timer
    // callback, which in the bridge process is a crash rather than a warning.
    vi.useFakeTimers()
    try {
      const p = pair()
      const sock = fakeSocket()
      sock.close = () => {
        sock.closed = true
      }
      const c = client(sock, p, vi.fn())
      c.start()
      sock.emit('open')
      seat(sock, false)

      c.stop()
      vi.advanceTimersByTime(10 * KEEPALIVE_MS)
      expect(sock.sent).toHaveLength(0)

      // And the late event changes nothing when it finally arrives.
      sock.emit('close')
      vi.advanceTimersByTime(10 * KEEPALIVE_MS)
      expect(sock.sent).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a peer keepalive by tag, without spending its pending handshake', () => {
    // A keepalive from the phone can race the desktop's greeting. Reaching
    // `accept` it would fail to open and cost this end its connection -- for a
    // frame whose entire purpose is to keep the connection. Dropping it by TAG,
    // above both the greeting path and the frame path, is the whole safety
    // argument for reserving byte zero.
    const p = pair()
    const sock = fakeSocket()
    const c = client(sock, p, vi.fn())
    c.start()
    sock.emit('open')
    seat(sock, true)

    sock.emit('message', Buffer.from([FRAME_KEEPALIVE]), true)
    expect(sock.closed).toBe(false)
    expect(c.state).toBe('online')

    // The handshake it would have consumed is still there for the real greeting.
    const phone = p.phone()
    phone.accept(sock.sent[0])
    sock.emit('message', Buffer.from(phone.greeting), true)
    expect(c.state).toBe('attached')
  })

  it('drops a peer keepalive on an attached session too', async () => {
    const p = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn()
    const c = client(sock, p, onRequest)
    c.start()
    connect(sock, p)

    // Past the greeting the frame path owns every binary frame, and an unsealed
    // byte cannot open. Silent there too -- but reached by the same tag check, so
    // it never touches a key.
    sock.emit('message', Buffer.from([FRAME_KEEPALIVE]), true)
    await new Promise((r) => setTimeout(r, 20))
    expect(onRequest).not.toHaveBeenCalled()
    expect(sock.closed).toBe(false)
    expect(c.state).toBe('attached')
  })
})
