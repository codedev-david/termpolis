import { describe, it, expect, vi } from 'vitest'
import { RelayClient, backoffDelay } from '../../src/main/remoteBridge/relayClient'
import { generateIdentity } from '../../src/main/remoteBridge/sealedChannel'
import { Handshake, FRAME_SESSION, type SealedSession } from '../../src/main/remoteBridge/sessionCrypto'

/** The one-byte header every session frame carries, and the AEAD's associated data. */
const H = new Uint8Array([FRAME_SESSION])

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
 *  once: the client mints one per dial and so must the test's phone. */
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

/** Drive the greeting exchange the way a real phone does, and hand back the
 *  phone's end of the session.
 *
 *  Nearly every test needs this now: nothing opens until both greetings have
 *  crossed. The desktop's greeting is SHIFTED off `sent` rather than read in
 *  place, so assertions about what the client wrote still index from zero. */
function connect(sock: ReturnType<typeof fakeSocket>, p: ReturnType<typeof pair>): SealedSession {
  sock.emit('open')
  const phone = p.phone()
  const session = phone.accept(sock.sent.shift()!)
  sock.emit('message', Buffer.from(phone.greeting), true)
  return session
}

function client(
  sock: ReturnType<typeof fakeSocket>,
  p: ReturnType<typeof pair>,
  onRequest: RelayClientTestRequest,
  onStateChange: (s: string) => void = () => {},
) {
  return new RelayClient({
    url: 'wss://relay.test',
    pairingId: 'a'.repeat(32),
    handshake: p.handshake,
    onRequest,
    onStateChange,
    openSocket: () => sock as never,
  })
}

type RelayClientTestRequest = ConstructorParameters<typeof RelayClient>[0]['onRequest']

describe('relay client', () => {
  it('opens a sealed request, dispatches it, and seals the response back', async () => {
    const p = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn().mockResolvedValue({ kind: 'ok', id: 1, data: { terminals: [] } })

    const c = client(sock, p, onRequest)
    c.start()
    const phoneSide = connect(sock, p)

    const request = phoneSide.seal(
      H,
      new TextEncoder().encode(JSON.stringify({ id: 1, request: { kind: 'listTerminals' } })),
    )
    sock.emit('message', Buffer.from(request), true)
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

    sock.emit('message', Buffer.from(phoneSide.seal(H, new TextEncoder().encode('not json'))), true)
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
    expect(states).toContain('online')
    sock.emit('close')
    expect(states).toContain('offline')

    // Fails closed: a send with no socket is dropped, never buffered forever and
    // never written to the socket that just died.
    expect(() => c.send({ any: 'thing' })).not.toThrow()
    expect(sock.sent).toHaveLength(0)
    c.stop()
  })

  it('stays connecting until the peer greets, and drops output sent in that gap', () => {
    // A window that did not exist under the old static channel: the socket is
    // open and there is no key yet. Two things have to hold inside it.
    //
    // The state must not read `online`, because the bridge DRAINS the fan-out on
    // that edge and draining is destructive -- output handed to a client that
    // cannot seal is output deleted.
    //
    // And `send` must drop rather than throw. The output pump runs on every
    // terminal write, so a throw here escapes into the pump and stalls every
    // later chunk for this device.
    const p = pair()
    const states: string[] = []
    const sock = fakeSocket()
    const c = client(sock, p, vi.fn(), (s) => states.push(s))

    c.start()
    sock.emit('open')
    expect(c.state).toBe('connecting')
    expect(states).not.toContain('online')

    expect(() => c.send({ kind: 'output', terminalId: 't', chunk: 'x', missed: 0 })).not.toThrow()
    // The greeting, and nothing else. Sealing with no key cannot have happened.
    expect(sock.sent).toHaveLength(1)

    const phone = p.phone()
    phone.accept(sock.sent[0])
    sock.emit('message', Buffer.from(phone.greeting), true)
    expect(c.state).toBe('online')
    c.stop()
  })

  it('greets unprompted on every dial, with fresh keys each time', () => {
    // The relay forwards blind and neither end learns who arrived first, so both
    // greet without waiting. A client that held its greeting until the peer's
    // arrived would deadlock against a phone doing the same.
    vi.useFakeTimers()
    try {
      const p = pair()
      const o = opener()
      const c = new RelayClient({
        url: 'wss://relay.test',
        pairingId: 'a'.repeat(32),
        handshake: p.handshake,
        onRequest: vi.fn(),
        onStateChange: () => {},
        openSocket: o.open,
      })
      c.start()
      o.sockets[0].emit('open')
      expect(o.sockets[0].sent).toHaveLength(1)
      const first = o.sockets[0].sent[0]

      o.sockets[0].emit('close')
      vi.advanceTimersByTime(backoffDelay(0))
      o.sockets[1].emit('open')

      // A FRESH greeting, not the first one resent. Reusing it would reuse the
      // ephemeral key and hand every connection the same session key -- exactly
      // the property this rewrite exists to establish.
      expect(o.sockets[1].sent).toHaveLength(1)
      expect(Buffer.from(o.sockets[1].sent[0]).equals(Buffer.from(first))).toBe(false)
      c.stop()
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
      const c = new RelayClient({
        url: 'wss://relay.test',
        pairingId: 'a'.repeat(32),
        handshake: p.handshake,
        onRequest,
        onStateChange: () => {},
        openSocket: o.open,
      })
      c.start()

      const first = connect(o.sockets[0], p)
      expect(c.state).toBe('online')
      const stale = first.seal(
        H,
        new TextEncoder().encode(JSON.stringify({ id: 1, request: { kind: 'listTerminals' } })),
      )

      o.sockets[0].emit('close')
      vi.advanceTimersByTime(backoffDelay(0))

      // The second connection has to complete a handshake of its own. Carrying
      // the first one's session across is not a cosmetic leak: the message
      // handler routes on whether a session exists, so a stale one sends the
      // peer's greeting down the frame path where it cannot open -- and the
      // socket then sits connected and permanently mute.
      const second = connect(o.sockets[1], p)
      expect(c.state).toBe('online')

      o.sockets[1].emit('message', Buffer.from(stale), true)
      await vi.advanceTimersByTimeAsync(0)
      expect(onRequest).not.toHaveBeenCalled()

      o.sockets[1].emit(
        'message',
        Buffer.from(
          second.seal(
            H,
            new TextEncoder().encode(JSON.stringify({ id: 2, request: { kind: 'listTerminals' } })),
          ),
        ),
        true,
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(onRequest).toHaveBeenCalledOnce()
      c.stop()
    } finally {
      vi.useRealTimers()
    }
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

    const impostor = new Handshake({
      ownSecretKey: generateIdentity().secretKey,
      peerPublicKey: generateIdentity().publicKey,
      role: 'device',
    })
    sock.emit('message', Buffer.from(impostor.greeting), true)

    expect(sock.closed).toBe(true)
    expect(states).not.toContain('online')
    c.stop()
  })

  it('survives a frame that arrives before the socket opened', () => {
    // `ws` will not do this, but the relay is untrusted and nothing about the
    // handler's contract stops a hostile one from trying. There is no handshake
    // to accept with yet, and that has to look like every other bad greeting
    // rather than an unhandled throw out of the listener.
    const p = pair()
    const sock = fakeSocket()
    const c = client(sock, p, vi.fn())
    c.start()
    expect(() => sock.emit('message', Buffer.from([9, 9, 9]), true)).not.toThrow()
    expect(sock.closed).toBe(true)
    c.stop()
  })

  it('answers a request whose handler throws instead of leaving the phone hanging', async () => {
    const p = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn().mockRejectedValue(new Error('terminal is gone'))

    const c = client(sock, p, onRequest)
    c.start()
    const phoneSide = connect(sock, p)
    sock.emit(
      'message',
      Buffer.from(
        phoneSide.seal(
          H,
          new TextEncoder().encode(JSON.stringify({ id: 7, request: { kind: 'listTerminals' } })),
        ),
      ),
      true,
    )
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
    sock.emit('message', Buffer.from(phoneSide.seal(H, new TextEncoder().encode(body))), true)
    await new Promise((r) => setTimeout(r, 20))

    // The frame is authentic -- it came from the paired phone. Authenticity is not
    // well-formedness, and the dispatcher is not the place to discover that.
    expect(onRequest).not.toHaveBeenCalled()
  })

  it('ignores text frames, which never carry payload', async () => {
    const p = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn()

    const c = client(sock, p, onRequest)
    c.start()
    const phoneSide = connect(sock, p)
    // The relay's own control frames (hello, peer-joined) arrive as text on this
    // same socket. Reading them as payload would hand relay-authored bytes to the
    // channel opener.
    sock.emit(
      'message',
      Buffer.from(
        phoneSide.seal(
          H,
          new TextEncoder().encode(JSON.stringify({ id: 1, request: { kind: 'listTerminals' } })),
        ),
      ),
      false,
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(onRequest).not.toHaveBeenCalled()
  })

  it('redials after a drop, and counts one failure when error precedes close', () => {
    vi.useFakeTimers()
    try {
      const p = pair()
      const o = opener()
      const c = new RelayClient({
        url: 'wss://relay.test',
        pairingId: 'a'.repeat(32),
        handshake: p.handshake,
        onRequest: vi.fn(),
        onStateChange: () => {},
        openSocket: o.open,
      })
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
      c.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lengthens the delay while dials keep failing', () => {
    vi.useFakeTimers()
    try {
      const p = pair()
      const o = opener()
      const c = new RelayClient({
        url: 'wss://relay.test',
        pairingId: 'a'.repeat(32),
        handshake: p.handshake,
        onRequest: vi.fn(),
        onStateChange: () => {},
        openSocket: o.open,
      })
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
      c.stop()
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
      const c = new RelayClient({
        url: 'wss://relay.test',
        pairingId: 'a'.repeat(32),
        handshake: p.handshake,
        onRequest: vi.fn(),
        onStateChange: (s) => states.push(s),
        openSocket: o.open,
      })
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
      const c = new RelayClient({
        url: 'wss://relay.test',
        pairingId: 'a'.repeat(32),
        handshake: p.handshake,
        onRequest: vi.fn(),
        onStateChange: (x) => states.push(x),
        openSocket: o.open,
      })
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
    expect(() => c.send({ kind: 'output', terminalId: 't', chunk: 'x', missed: 0 })).not.toThrow()
    c.stop()
  })

  it('dials a real ws socket when no opener is injected', async () => {
    const p = pair()
    const states: string[] = []
    const c = new RelayClient({
      // Port 1 refuses immediately. The point is not the connection but that the
      // production path -- new WebSocket(url) from the `ws` package -- constructs
      // and wires up at all under the Node that Electron ships, which no injected
      // fake can tell us.
      url: 'ws://127.0.0.1:1',
      pairingId: 'a'.repeat(32),
      handshake: p.handshake,
      onRequest: vi.fn(),
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
