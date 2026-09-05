import {
  FRAME_KEEPALIVE,
  FRAME_SESSION,
  SESSION_HEADER_BYTES,
  type Handshake,
} from '../wire/sessionCrypto'
import type { SealedSession } from '../wire/sealedChannel'
import type { QuotaLimit, RelayControlFrame } from '../wire/protocol'

/** Every session frame is tagged so a receiver knows which key opens it before it
 *  tries. One byte, and it is the AEAD's associated data -- retagging a frame
 *  fails authentication rather than being reinterpreted as another frame type. */
const SESSION_HEADER = Uint8Array.from([FRAME_SESSION])

/** The whole keepalive: one reserved tag byte. */
const KEEPALIVE_FRAME = Uint8Array.from([FRAME_KEEPALIVE])

const ROOM_ID_RE = /^[0-9a-f]{32}$/

/** Where this end stands in the relay room.
 *
 *  `connecting` -- dialing, or holding a socket the relay has not yet seated.
 *  `online`     -- seated. Reachable, with nobody on the other end.
 *  `attached`   -- a sealed session with the desktop. The only state frames flow in.
 *  `offline`    -- no socket.
 *  `blocked`    -- the relay cut this client for something only this client can
 *                  fix, and it has stopped dialing. Terminal until the app
 *                  rebuilds the socket.
 *
 *  `online` and `attached` are separate because losing the DESKTOP is not the
 *  same event as losing the RELAY. Collapsing them tells the user their phone
 *  dropped off the network when in fact the desktop went to sleep. */
export type RelayState = 'connecting' | 'online' | 'attached' | 'offline' | 'blocked'

/** The slice of the WebSocket surface this uses.
 *
 *  React Native's WebSocket is the browser shape -- assignable `on*` properties,
 *  a `data` field on the message event -- not the `ws` emitter the desktop bridge
 *  talks to. Naming it here lets tests inject a fake without a server, and keeps
 *  the global reference in exactly one place. */
export interface SocketLike {
  binaryType: string
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  send(data: Uint8Array): void
  close(): void
}

export interface RelaySocketDeps {
  /** Relay origin, without a trailing slash: `wss://relay.termpolis.com`. */
  url: string
  /** The derived session room. Never announced, so a wrong one is a silent wait
   *  in an empty room rather than an error. */
  roomId: string
  /** Injected so tests need no server, and so `new WebSocket` has one home. */
  open(url: string): SocketLike
  /** A FACTORY, not a handshake: every attachment needs its own ephemeral key.
   *  Reusing one makes recorded traffic replayable across a reattach. */
  handshake(): Handshake
  /** Receives the OPENED plaintext of a session frame, never the sealed bytes.
   *  Frames that do not open never reach here. */
  onFrame(plaintext: Uint8Array): void
  /** Every control frame the relay sent that parsed, including ones this client
   *  acted on itself. The UI wants to show a quota cut even though the socket
   *  already handled it. */
  onControl(control: RelayControlFrame): void
  onState(state: RelayState): void
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  /** Injected so backoff jitter is deterministic under test. */
  random?(): number
}

const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 60_000

/** How often a seated connection sends a keepalive.
 *
 *  The relay closes a connection whose last BINARY frame is older than 300 s, and
 *  it drops text above the `lastSeen` update -- so only a binary frame holds a
 *  room. A phone in someone's pocket sends nothing at all, so without this it is
 *  cut every five minutes and redials a second later, forever. 120 s leaves room
 *  for one lost frame. */
export const KEEPALIVE_MS = 120_000

/** Limits that mean this client is the problem, and so must stop it dialing.
 *
 *  `idle` and `connection-bytes` are deliberately absent. An idle cut is a lost
 *  keepalive, not a fault, and never redialing after one takes remote dark until
 *  the app is force-quit. `connection-bytes` takes 256 MiB to reach, so a loop on
 *  it is self-limiting. */
const FATAL_LIMITS: readonly QuotaLimit[] = ['frame-size', 'frame-rate']

/** Doubling backoff with a one-minute ceiling and jitter over the lower half.
 *
 *  The ceiling matters more than the curve: a phone left on a table against a
 *  relay that is down would otherwise reach delays measured in days and never
 *  notice it come back. The jitter matters because every phone paired to a relay
 *  that blinked would otherwise redial in the same millisecond. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(attempt, 30))
  return Math.round(base * (0.5 + 0.5 * random()))
}

export class RelaySocket {
  private socket: SocketLike | null = null
  private attempt = 0
  private stopped = false
  private retryTimer: unknown = null
  private keepaliveTimer: unknown = null
  /** Latched when the relay cuts us for something only this client can fix.
   *  Nothing here ever clears it: the connection comes back when the app does. */
  private blocked = false
  /** The handshake awaiting the desktop's greeting, then the session it made.
   *  Both are per-attachment, and both die with the peer or with the socket. */
  private pending: Handshake | null = null
  private session: SealedSession | null = null
  state: RelayState = 'offline'

  constructor(private readonly deps: RelaySocketDeps) {}

  connect(): void {
    // Validated before a socket exists, so a room id that came out of a bad
    // derivation is a throw at the call site rather than a Durable Object named
    // after the bug, waited in forever.
    if (!ROOM_ID_RE.test(this.deps.roomId)) {
      throw new Error('relay room id must be 32 lowercase hex characters')
    }
    this.stopped = false
    this.dial()
  }

  private dial(): void {
    this.setState('connecting')
    const sock = this.deps.open(`${this.deps.url}/v1/pair/${this.deps.roomId}?role=device`)
    this.socket = sock
    // Before any handler can fire. React Native defaults to 'blob', and send()
    // does not accept a Blob -- it coerces to a string, so the far end receives
    // the literal text "[object Blob]". Every byte of every sealed frame is
    // destroyed while the frame count and the timing stay right, which is the
    // hardest possible version of this bug to see.
    sock.binaryType = 'arraybuffer'

    sock.onopen = () => {
      // Reaching an open socket is what proves the relay is up, which is what the
      // backoff measures -- so the counter resets here rather than at `hello`.
      // A 409 never opens, so a duplicate device keeps backing off.
      //
      // Deliberately does not greet, and deliberately not `online` either: a raw
      // socket is not a seat, and a frame sent to a room with no partner in it is
      // DROPPED rather than queued.
      this.attempt = 0
    }

    sock.onmessage = (event) => {
      const { data } = event
      // Text is the relay speaking for itself. Peers speak binary only and the
      // relay refuses to forward text, so nothing here came from the desktop.
      if (typeof data === 'string') {
        this.control(sock, data)
        return
      }
      const frame = toBytes(data)
      if (frame === null) return
      // A keepalive carries nothing and is not sealed. Dropped BY TAG, before
      // either the greeting path or the frame path can mistake it for something
      // that ought to open -- reaching the greeting path it would cost this end
      // its connection, for a frame whose entire purpose is to keep it.
      if (frame[0] === FRAME_KEEPALIVE) return
      if (this.session) {
        // `open` returns null rather than throwing, so a forged, replayed or
        // corrupted frame is a dropped frame and nothing more. Notably it does
        // NOT advance the counter high-water mark, so one injected frame cannot
        // deafen the phone to every real one after it.
        const plaintext = this.session.open(frame, SESSION_HEADER_BYTES)
        if (plaintext !== null) this.deps.onFrame(plaintext)
        return
      }
      this.acceptGreeting(sock, frame)
    }

    // `onclose` and `onerror` both land here, and React Native fires `error`
    // followed by `close`. Guarding on socket identity keeps that pair from
    // counting as two failures and doubling the backoff twice for one outage.
    const down = (): void => {
      if (this.socket !== sock) return
      this.socket = null
      this.stopKeepalive()
      // The session dies with the socket, and this is the only place that kills
      // it. Carrying one into the next connection routes the next peer's
      // greeting down the frame path, where it cannot open -- leaving a socket
      // that is connected, attached, and permanently mute.
      this.pending = null
      this.session = null
      this.setState('offline')
      this.retry()
    }
    sock.onclose = down
    sock.onerror = down
  }

  /** Act on a frame the relay authored.
   *
   *  Anything unparseable, or of a kind this client does not know, is dropped.
   *  The relay is untrusted and a control frame is a hint, never an instruction
   *  worth a disconnect. */
  private control(sock: SocketLike, text: string): void {
    let frame: RelayControlFrame
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    switch (frame.kind) {
      case 'hello':
        this.setState('online')
        this.startKeepalive(sock)
        // Greet only into a room that has someone in it.
        if (frame.peer) this.greet(sock)
        break
      case 'peer-joined':
        this.greet(sock)
        break
      case 'peer-gone':
        // `online`, NOT `offline`: this phone is still seated and still
        // reachable, and saying otherwise blames the wrong end of the link.
        //
        // The session is over regardless. Whoever takes the desktop role next is
        // a different connection with a different ephemeral key.
        this.pending = null
        this.session = null
        this.setState('online')
        break
      case 'quota-exceeded':
        if (FATAL_LIMITS.indexOf(frame.limit) !== -1) {
          this.blocked = true
          this.setState('blocked')
        }
        break
      default:
        // An unknown kind from a newer relay. Report it and carry on.
        break
    }
    this.deps.onControl(frame)
  }

  /** Mint an ephemeral key for this attachment and send the greeting it makes.
   *
   *  Once per PEER rather than once per socket, so a desktop that drops and comes
   *  back while this socket holds gets a session key that is new at both ends. */
  private greet(sock: SocketLike): void {
    this.pending = this.deps.handshake()
    sock.send(this.pending.greeting())
    this.lastSentAt = this.deps.now()
  }

  /** The desktop's first binary frame must be its greeting. Anything else is an
   *  impostor, a stale frame from a previous connection, or a relay playing
   *  games. */
  private acceptGreeting(sock: SocketLike, frame: Uint8Array): void {
    const session = this.pending?.accept(frame) ?? null
    if (session === null) {
      // Drop the connection rather than sit in a half-open state the user cannot
      // see. A room that never reaches `attached` is at least legible, and the
      // backoff will try again against what may be a transient fault.
      sock.close()
      return
    }
    this.session = session
    this.setState('attached')
  }

  /** Seal a payload and write it.
   *
   *  Drops when there is no socket or no session rather than throwing. This runs
   *  on the request path, and between `hello` and the desktop's greeting there is
   *  a live socket and no key -- throwing there would surface as a crash on a
   *  keystroke. */
  send(plaintext: Uint8Array): void {
    if (!this.socket || !this.session) return
    try {
      this.socket.send(this.session.seal(SESSION_HEADER, plaintext))
      this.lastSentAt = this.deps.now()
    } catch {
      // A write to a socket the far end already closed. `onclose` will follow.
    }
  }

  /** Hold the room open for as long as this socket is seated.
   *
   *  The socket is captured rather than read off `this`, so a timer that somehow
   *  outlived its connection cannot write into the next one. Rescheduled on each
   *  tick rather than left as an interval, because that is what lets a tick that
   *  finds recent traffic push the deadline out instead of firing.
   *
   *  The relay's idle timer watches the last BINARY frame of any kind, so a
   *  session frame holds the room exactly as well as a keepalive does. Sending
   *  one anyway during an active session wakes the radio for nothing, which on a
   *  phone is battery rather than bytes. */
  private startKeepalive(sock: SocketLike): void {
    this.stopKeepalive()
    const tick = (): void => {
      if (this.socket !== sock) return
      const idleFor = this.deps.now() - this.lastSentAt
      if (idleFor >= KEEPALIVE_MS) {
        sock.send(KEEPALIVE_FRAME)
        this.lastSentAt = this.deps.now()
        this.keepaliveTimer = this.deps.setTimer(tick, KEEPALIVE_MS)
        return
      }
      this.keepaliveTimer = this.deps.setTimer(tick, KEEPALIVE_MS - idleFor)
    }
    this.lastSentAt = this.deps.now()
    this.keepaliveTimer = this.deps.setTimer(tick, KEEPALIVE_MS)
  }

  /** When this end last put a binary frame on the wire, keepalive or not. */
  private lastSentAt = 0

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) this.deps.clearTimer(this.keepaliveTimer)
    this.keepaliveTimer = null
  }

  private retry(): void {
    if (this.stopped || this.blocked) return
    const delay = backoffDelay(this.attempt++, this.deps.random)
    this.retryTimer = this.deps.setTimer(() => this.dial(), delay)
  }

  close(): void {
    this.stopped = true
    if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer)
    this.retryTimer = null
    this.stopKeepalive()
    const sock = this.socket
    this.socket = null
    this.pending = null
    this.session = null
    sock?.close()
    this.setState('offline')
  }

  private setState(next: RelayState): void {
    // `blocked` is terminal. Without this the `offline` that follows the relay
    // hanging up would overwrite the only state that explains why nothing is
    // reconnecting.
    if (this.blocked && next !== 'blocked') return
    if (this.state === next) return
    this.state = next
    this.deps.onState(next)
  }
}

/** React Native delivers an ArrayBuffer once `binaryType` is 'arraybuffer', but
 *  a Blob before that and on some Android builds regardless. A Blob is not
 *  readable synchronously, so it is dropped rather than mishandled -- and the
 *  keepalive holds the room while the next real frame arrives. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return null
}
