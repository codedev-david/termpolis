import { describe, it, expect, vi } from 'vitest'
import { RelayClient, backoffDelay } from '../../src/main/remoteBridge/relayClient'
import { SealedChannel, generateIdentity } from '../../src/main/remoteBridge/sealedChannel'

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

function pair() {
  const desktop = generateIdentity()
  const phone = generateIdentity()
  return {
    desktopSide: new SealedChannel(desktop.secretKey, phone.publicKey),
    phoneSide: new SealedChannel(phone.secretKey, desktop.publicKey),
  }
}

function client(
  sock: ReturnType<typeof fakeSocket>,
  channel: SealedChannel,
  onRequest: RelayClientTestRequest,
  onStateChange: (s: string) => void = () => {},
) {
  return new RelayClient({
    url: 'wss://relay.test',
    pairingId: 'a'.repeat(32),
    channel,
    onRequest,
    onStateChange,
    openSocket: () => sock as never,
  })
}

type RelayClientTestRequest = ConstructorParameters<typeof RelayClient>[0]['onRequest']

describe('relay client', () => {
  it('opens a sealed request, dispatches it, and seals the response back', async () => {
    const { desktopSide, phoneSide } = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn().mockResolvedValue({ kind: 'ok', id: 1, data: { terminals: [] } })

    const c = client(sock, desktopSide, onRequest)
    c.start()
    sock.emit('open')

    const request = phoneSide.seal(
      new TextEncoder().encode(JSON.stringify({ id: 1, request: { kind: 'listTerminals' } })),
    )
    sock.emit('message', Buffer.from(request), true)
    await vi.waitFor(() => expect(sock.sent.length).toBe(1))

    expect(onRequest).toHaveBeenCalledWith({ id: 1, request: { kind: 'listTerminals' } })
    const reply = JSON.parse(new TextDecoder().decode(phoneSide.open(sock.sent[0])))
    expect(reply).toEqual({ kind: 'ok', id: 1, data: { terminals: [] } })
  })

  // The relay is untrusted and the phone may be hostile. Neither may make the
  // desktop throw its way out of the message handler and kill the connection.
  it('ignores a frame it cannot open instead of dying', async () => {
    const { desktopSide } = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn()

    const c = client(sock, desktopSide, onRequest)
    c.start()
    sock.emit('open')

    sock.emit('message', Buffer.from([1, 2, 3, 4]), true) // not a sealed frame
    await new Promise((r) => setTimeout(r, 20))

    expect(onRequest).not.toHaveBeenCalled()
    expect(sock.closed).toBe(false)
  })

  it('ignores an authentic frame whose plaintext is not a request envelope', async () => {
    const { desktopSide, phoneSide } = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn()

    const c = client(sock, desktopSide, onRequest)
    c.start()
    sock.emit('open')

    sock.emit('message', Buffer.from(phoneSide.seal(new TextEncoder().encode('not json'))), true)
    await new Promise((r) => setTimeout(r, 20))
    expect(onRequest).not.toHaveBeenCalled()
  })

  it('reports offline and does not send when the socket is gone', () => {
    const { desktopSide } = pair()
    const states: string[] = []
    const sock = fakeSocket()

    const c = client(sock, desktopSide, vi.fn(), (s) => states.push(s))
    c.start()
    sock.emit('open')
    expect(states).toContain('online')
    sock.emit('close')
    expect(states).toContain('offline')

    // Fails closed: a send with no socket is dropped, never buffered forever and
    // never written to the socket that just died. Nor does it burn a nonce -- the
    // payload is not sealed at all, so the counter the peer's replay guard tracks
    // stays in step with what was actually put on the wire.
    const before = desktopSide.sentFrames
    expect(() => c.send({ any: 'thing' })).not.toThrow()
    expect(sock.sent).toHaveLength(0)
    expect(desktopSide.sentFrames).toBe(before)
    c.stop()
  })

  it('answers a request whose handler throws instead of leaving the phone hanging', async () => {
    const { desktopSide, phoneSide } = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn().mockRejectedValue(new Error('terminal is gone'))

    const c = client(sock, desktopSide, onRequest)
    c.start()
    sock.emit('open')
    sock.emit(
      'message',
      Buffer.from(
        phoneSide.seal(
          new TextEncoder().encode(JSON.stringify({ id: 7, request: { kind: 'listTerminals' } })),
        ),
      ),
      true,
    )
    await vi.waitFor(() => expect(sock.sent.length).toBe(1))

    // Silence here would strand the caller: every phone request is correlated by
    // id and waits for exactly one reply. A thrown dispatch still owes an answer.
    expect(JSON.parse(new TextDecoder().decode(phoneSide.open(sock.sent[0])))).toEqual({
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
    const { desktopSide, phoneSide } = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn()

    const c = client(sock, desktopSide, onRequest)
    c.start()
    sock.emit('open')
    sock.emit('message', Buffer.from(phoneSide.seal(new TextEncoder().encode(body))), true)
    await new Promise((r) => setTimeout(r, 20))

    // The frame is authentic -- it came from the paired phone. Authenticity is not
    // well-formedness, and the dispatcher is not the place to discover that.
    expect(onRequest).not.toHaveBeenCalled()
  })

  it('ignores text frames, which never carry payload', async () => {
    const { desktopSide, phoneSide } = pair()
    const sock = fakeSocket()
    const onRequest = vi.fn()

    const c = client(sock, desktopSide, onRequest)
    c.start()
    sock.emit('open')
    // The relay's own control frames (hello, peer-joined) arrive as text on this
    // same socket. Reading them as payload would hand relay-authored bytes to the
    // channel opener.
    sock.emit(
      'message',
      Buffer.from(
        phoneSide.seal(
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
      const { desktopSide } = pair()
      const o = opener()
      const c = new RelayClient({
        url: 'wss://relay.test',
        pairingId: 'a'.repeat(32),
        channel: desktopSide,
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
      const { desktopSide } = pair()
      const o = opener()
      const c = new RelayClient({
        url: 'wss://relay.test',
        pairingId: 'a'.repeat(32),
        channel: desktopSide,
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
      const { desktopSide } = pair()
      const o = opener()
      const states: string[] = []
      const c = new RelayClient({
        url: 'wss://relay.test',
        pairingId: 'a'.repeat(32),
        channel: desktopSide,
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
      const { desktopSide } = pair()
      const o = opener()
      const states: string[] = []
      const c = new RelayClient({
        url: 'wss://relay.test',
        pairingId: 'a'.repeat(32),
        channel: desktopSide,
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
    const { desktopSide } = pair()
    const sock = fakeSocket()
    sock.send = () => {
      throw new Error('WebSocket is not open')
    }
    const c = client(sock, desktopSide, vi.fn())
    c.start()
    sock.emit('open')

    // The close event has not arrived yet but the socket is already gone. Throwing
    // here would escape the output pump and stall every later chunk.
    expect(() => c.send({ kind: 'output', terminalId: 't', chunk: 'x', missed: 0 })).not.toThrow()
    c.stop()
  })

  it('dials a real ws socket when no opener is injected', async () => {
    const { desktopSide } = pair()
    const states: string[] = []
    const c = new RelayClient({
      // Port 1 refuses immediately. The point is not the connection but that the
      // production path -- new WebSocket(url) from the `ws` package -- constructs
      // and wires up at all under the Node that Electron ships, which no injected
      // fake can tell us.
      url: 'ws://127.0.0.1:1',
      pairingId: 'a'.repeat(32),
      channel: desktopSide,
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
