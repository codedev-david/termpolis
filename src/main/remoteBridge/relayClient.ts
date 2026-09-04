import WebSocket from 'ws'
import {
  FRAME_KEEPALIVE,
  FRAME_SESSION,
  type Handshake,
  type SealedSession,
} from './sessionCrypto'
import type {
  QuotaLimit,
  RelayControlFrame,
  RemoteEnvelope,
  RemoteResponse,
} from './protocol'

/** Every session frame is tagged, so a receiver knows which key opens it before it
 *  tries. One byte, and it is the AEAD's associated data -- retagging a frame fails
 *  authentication rather than being reinterpreted as another frame type. */
const SESSION_HEADER = new Uint8Array([FRAME_SESSION])

/** The whole keepalive: one reserved tag byte. See `FRAME_KEEPALIVE`. */
const KEEPALIVE_FRAME = new Uint8Array([FRAME_KEEPALIVE])

/** Where this end stands in the relay room.
 *
 *  `connecting` -- dialing, or holding a socket the relay has not yet seated.
 *  `online`     -- seated. Reachable, with nobody on the other end.
 *  `attached`   -- a sealed session with the peer. The only state frames flow in.
 *  `offline`    -- no socket.
 *
 *  `online` and `attached` are separate because losing the PHONE is not the same
 *  event as losing the RELAY. Collapsing them tells the user their own machine
 *  dropped off the network when in fact the phone walked away, and it hides the
 *  case that actually needs a diagnosis: seated, reachable, and nobody arriving. */
export type RelayState = 'connecting' | 'online' | 'attached' | 'offline'

/** The subset of `ws` this module uses. Named so tests can inject a fake without
 *  standing up a server, and so the `ws` import stays in exactly one place.
 *
 *  `ws` is here because Electron 30 runs Node 20.16, where `WebSocket` is not a
 *  global -- `fetch` is, `WebSocket` is not. The utility process cannot dial the
 *  relay without it. */
export interface SocketLike {
  on(event: string, fn: (...args: never[]) => void): unknown
  send(data: Uint8Array): void
  close(): void
}

export interface RelayClientDeps {
  url: string
  pairingId: string
  /** A FACTORY, not a session: every attachment needs its own ephemeral key.
   *  Handing this client one long-lived channel is what made recorded traffic
   *  replayable across a bridge restart. */
  handshake(): Handshake
  onRequest(env: RemoteEnvelope): Promise<RemoteResponse>
  onStateChange(state: RelayState): void
  /** Told which limit the relay cut this connection for. Optional: it is a
   *  diagnosis for the user, not part of the request path. */
  onQuota?(limit: QuotaLimit): void
  /** Injected in tests. Production dials the real relay. */
  openSocket?(url: string): SocketLike
}

const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 60_000

/** How often a seated connection sends a keepalive.
 *
 *  The relay closes a connection whose last BINARY frame is older than 300 s
 *  (`IDLE_TIMEOUT_MS`, `relay/src/quota.ts`), and it drops text ABOVE the
 *  `lastSeen` update -- so only a binary frame holds a room. A desktop waiting for
 *  a phone that has not arrived sends nothing at all, so without this it is cut
 *  every five minutes and redials a second later, forever: a Durable Object
 *  instantiation per paired device per ~301 s, and a window each time in which the
 *  phone finds an empty room. 120 s leaves room for one lost frame. */
export const KEEPALIVE_MS = 120_000

/** Limits that mean this client is the problem, and so must stop dialing.
 *
 *  The relay names the limit precisely so a client can tell "you sent too much"
 *  from "the network broke" (`relay/src/pairingRoom.ts`); the alternative is a
 *  client bug that reconnects in a loop and becomes a denial of service against
 *  everyone else on the relay.
 *
 *  `idle` and `connection-bytes` are deliberately absent. An idle cut is not a
 *  fault -- it is a lost keepalive, and never redialing after one would take
 *  remote dark until the app restarts. `connection-bytes` takes 256 MiB to reach,
 *  so a loop on it is self-limiting: worth reporting, not worth stranding a heavy
 *  user for. */
const FATAL_LIMITS: readonly QuotaLimit[] = ['frame-size', 'frame-rate']

/** Doubling backoff with a one-minute ceiling.
 *
 *  The ceiling matters more than the curve: a desktop left running overnight
 *  against a relay that is down would otherwise reach delays measured in days
 *  and never notice the relay coming back. */
export function backoffDelay(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt)
}

export class RelayClient {
  private socket: SocketLike | null = null
  private attempt = 0
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private keepalive: ReturnType<typeof setInterval> | null = null
  /** Latched when the relay cuts us for something only this client can fix.
   *  Redialing then is exactly the loop the relay warns about, so nothing here
   *  ever clears it: the connection comes back when the bridge does. */
  private cutForQuota = false
  /** The handshake awaiting the peer's greeting, then the session it produced.
   *  Both are per-attachment, and both die with the peer or with the socket. */
  private pending: Handshake | null = null
  private session: SealedSession | null = null
  state: RelayState = 'offline'

  constructor(private readonly deps: RelayClientDeps) {}

  start(): void {
    this.stopped = false
    this.dial()
  }

  /** Deliberately has no `stopped` guard of its own. Both callers already hold
   *  the invariant -- `start` clears the flag before calling, and `retry` refuses
   *  to schedule while it is set, having had its pending timer cleared by `stop`
   *  besides. A third check here would be a branch no test could reach, which is
   *  a worse thing to have than the one it was guarding against. */
  private dial(): void {
    this.setState('connecting')
    const open =
      this.deps.openSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike)
    const sock = open(`${this.deps.url}/v1/pair/${this.deps.pairingId}?role=desktop`)
    this.socket = sock

    sock.on('open', (() => {
      // Reaching an open socket is what proves the relay is up, which is what the
      // backoff measures -- so the counter resets here rather than at `hello`.
      //
      // Deliberately does NOT greet, and deliberately not `online` either. A raw
      // socket is not a seat in the room, and a frame sent to a room with no
      // partner in it is DROPPED rather than queued. The desktop is almost always
      // first in, so greeting here put its half of the handshake nowhere and left
      // the phone waiting for a key that had already been thrown away. `hello`
      // says whether anyone is there and `peer-joined` says when someone arrives;
      // both are answered in `control`.
      this.attempt = 0
    }) as never)

    sock.on('message', ((data: Buffer, isBinary: boolean) => {
      // Text is the relay speaking for itself. Peers speak binary only, and the
      // relay refuses to forward text at all, so nothing here can have come from
      // the phone.
      if (!isBinary) {
        this.control(sock, data)
        return
      }
      const frame = new Uint8Array(data)
      // A keepalive carries nothing and is not sealed. Dropped here BY TAG, before
      // either the greeting path or the frame path can mistake it for something
      // that ought to open -- reaching `acceptGreeting` it would cost this end its
      // connection, for a frame whose entire purpose is to keep the connection.
      if (frame[0] === FRAME_KEEPALIVE) return
      if (this.session) {
        void this.handleFrame(frame)
        return
      }
      this.acceptGreeting(sock, frame)
    }) as never)

    // `close` and `error` both land here, and `ws` emits `error` followed by
    // `close`. Guarding on the socket identity keeps that pair from counting as
    // two failures and doubling the backoff twice for one outage.
    const down = () => {
      if (this.socket !== sock) return
      this.socket = null
      this.stopKeepalive()
      // The session dies with the socket, and this is the only place that kills
      // it: `dial` reaches a live socket exclusively through here, so clearing it
      // in the `open` handler too would just make both copies unfalsifiable.
      //
      // Carrying a session into the next connection is not a small bug. The
      // message handler routes on `session`, so a stale one sends the peer's
      // greeting down the frame path, where it cannot open -- and the socket then
      // sits connected and permanently mute.
      this.pending = null
      this.session = null
      this.setState('offline')
      this.retry()
    }
    sock.on('close', down as never)
    sock.on('error', down as never)
  }

  /** Act on a frame the relay authored.
   *
   *  Anything unparseable, or of a kind this client does not know, is dropped. The
   *  relay is untrusted and a control frame is a hint, never an instruction worth
   *  a disconnect. */
  private control(sock: SocketLike, data: Buffer): void {
    let frame: RelayControlFrame
    try {
      frame = JSON.parse(data.toString('utf8'))
    } catch {
      return
    }
    switch (frame?.kind) {
      case 'hello':
        this.setState('online')
        this.startKeepalive(sock)
        // Greet only into a room that has someone in it -- see `dial`.
        if (frame.peer) this.greet(sock)
        return
      case 'peer-joined':
        this.greet(sock)
        return
      case 'peer-gone':
        // `online`, NOT `offline`: this desktop is still seated and still
        // reachable, and telling the user otherwise blames the wrong machine.
        //
        // The session is over regardless. Whoever takes the role next is a
        // different connection with a different ephemeral key, and holding the old
        // session would route their greeting down the frame path where it cannot
        // open -- leaving a socket that is connected, attached, and mute.
        this.pending = null
        this.session = null
        this.setState('online')
        return
      case 'quota-exceeded':
        if (FATAL_LIMITS.includes(frame.limit)) this.cutForQuota = true
        this.deps.onQuota?.(frame.limit)
        return
    }
  }

  /** Mint an ephemeral key for this attachment and send the greeting it makes.
   *
   *  Once per PEER rather than once per socket. A phone that drops and comes back
   *  while the desktop's connection holds gets a session key that is new at both
   *  ends, because `peer-gone` cleared the last one and `peer-joined` lands here. */
  private greet(sock: SocketLike): void {
    this.pending = this.deps.handshake()
    sock.send(this.pending.greeting)
  }

  /** The peer's first binary frame must be its greeting. Anything else is an
   *  impostor, a stale frame from a previous connection, or a relay playing games. */
  private acceptGreeting(sock: SocketLike, frame: Uint8Array): void {
    try {
      this.session = this.pending!.accept(frame)
    } catch {
      // Drop the connection rather than sit in a half-open state the user cannot
      // see: a room that never reaches `attached` is at least legible, and the
      // backoff will try again against what may be a transient relay fault.
      sock.close()
      return
    }
    this.setState('attached')
  }

  private async handleFrame(frame: Uint8Array): Promise<void> {
    let envelope: RemoteEnvelope
    try {
      // Two distinct rejections, both silent: a frame that does not open (forged,
      // replayed, or corrupted in transit) and one that opens but is not an
      // envelope. Neither may throw out of here -- an unhandled rejection in the
      // message handler tears down a connection that a hostile phone could then
      // drop at will.
      envelope = JSON.parse(new TextDecoder().decode(this.session!.open(frame, 1)))
      if (typeof envelope?.id !== 'number' || typeof envelope?.request?.kind !== 'string') return
    } catch {
      return
    }

    let response: RemoteResponse
    try {
      response = await this.deps.onRequest(envelope)
    } catch (err) {
      response = { kind: 'error', id: envelope.id, message: (err as Error).message }
    }
    this.send(response)
  }

  /** Seal and write. Drops the payload when there is no socket or no session yet:
   *  the fan-out is the buffer for output, and a second queue here would
   *  double-store it.
   *
   *  The session check is not redundant with the socket check. Between `hello` and
   *  the peer's greeting there is a live socket and no key, and the output pump
   *  runs on every terminal write -- sealing on a null session there would throw
   *  into the pump and stall every later chunk for this device. */
  send(payload: unknown): void {
    if (!this.socket || !this.session) return
    try {
      this.socket.send(
        this.session.seal(SESSION_HEADER, new TextEncoder().encode(JSON.stringify(payload))),
      )
    } catch {
      // A write to a socket the peer already closed. `close` will follow.
    }
  }

  /** Hold the room open for as long as this socket is seated.
   *
   *  The socket is captured rather than read from `this`, so a timer that somehow
   *  outlived its connection could not write into the next one. It is replaced
   *  rather than added to: a second `hello` on one socket would otherwise leave an
   *  interval nothing holds a handle to, firing forever into a dead socket. */
  private startKeepalive(sock: SocketLike): void {
    this.stopKeepalive()
    this.keepalive = setInterval(() => sock.send(KEEPALIVE_FRAME), KEEPALIVE_MS)
  }

  private stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = null
  }

  private retry(): void {
    if (this.stopped || this.cutForQuota) return
    const delay = backoffDelay(this.attempt++)
    this.timer = setTimeout(() => this.dial(), delay)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.stopKeepalive()
    this.socket?.close()
    this.socket = null
    this.pending = null
    this.session = null
    this.setState('offline')
  }

  private setState(next: RelayState): void {
    if (this.state === next) return
    this.state = next
    this.deps.onStateChange(next)
  }
}
