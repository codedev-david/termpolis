import WebSocket from 'ws'
import { FRAME_SESSION, type Handshake, type SealedSession } from './sessionCrypto'
import type { RemoteEnvelope, RemoteResponse } from './protocol'

/** Every session frame is tagged, so a receiver knows which key opens it before it
 *  tries. One byte, and it is the AEAD's associated data -- retagging a frame fails
 *  authentication rather than being reinterpreted as another frame type. */
const SESSION_HEADER = new Uint8Array([FRAME_SESSION])

export type RelayState = 'connecting' | 'online' | 'offline'

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
  /** A FACTORY, not a session: every dial needs its own ephemeral key. Handing
   *  this client one long-lived channel is what made recorded traffic replayable
   *  across a bridge restart. */
  handshake(): Handshake
  onRequest(env: RemoteEnvelope): Promise<RemoteResponse>
  onStateChange(state: RelayState): void
  /** Injected in tests. Production dials the real relay. */
  openSocket?(url: string): SocketLike
}

const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 60_000

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
  /** The handshake awaiting the peer's greeting, then the session it produced.
   *  Both are per-connection and both are cleared when the socket goes. */
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
      this.attempt = 0
      // Deliberately NOT `online` yet. A raw socket has no key: reporting online
      // here would have the bridge drain the fan-out into a client that cannot
      // seal, and draining is destructive -- the output would be gone. The state
      // advances when the peer's greeting lands.
      //
      // Nothing is cleared here. Teardown belongs to `down`, which is the only
      // route from a live socket back to another dial, and having both do it
      // left neither one observable.
      this.pending = this.deps.handshake()
      sock.send(this.pending.greeting)
    }) as never)

    sock.on('message', ((data: Buffer, isBinary: boolean) => {
      // Control frames are text and are not part of the request path. Only binary
      // carries sealed payload.
      if (!isBinary) return
      const frame = new Uint8Array(data)
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
      // The session dies with the socket, and this is the only place that kills
      // it: `dial` reaches a live socket exclusively through here, so clearing it
      // in the `open` handler too would just make both copies unfalsifiable.
      //
      // Carrying a session into the next connection is not a small bug. The
      // message handler routes on `session`, so a stale one sends the peer's
      // greeting down the frame path, where it cannot open -- and the socket then
      // sits connected and permanently mute.
      //
      // Nulling the handshake is hygiene rather than behaviour: `open` overwrites
      // it regardless. It drops the ephemeral secret the moment the socket dies
      // instead of holding it across a backoff that can run to a minute.
      this.pending = null
      this.session = null
      this.setState('offline')
      this.retry()
    }
    sock.on('close', down as never)
    sock.on('error', down as never)
  }

  /** The peer's first binary frame must be its greeting. Anything else is an
   *  impostor, a stale frame from a previous connection, or a relay playing games. */
  private acceptGreeting(sock: SocketLike, frame: Uint8Array): void {
    try {
      this.session = this.pending!.accept(frame)
    } catch {
      // Drop the connection rather than sit in a half-open state the user cannot
      // see: `connecting` that never becomes `online` is at least legible, and
      // the backoff will try again against what may be a transient relay fault.
      sock.close()
      return
    }
    this.setState('online')
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
   *  The session check is not redundant with the socket check. Between `open` and
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

  private retry(): void {
    if (this.stopped) return
    const delay = backoffDelay(this.attempt++)
    this.timer = setTimeout(() => this.dial(), delay)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
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
