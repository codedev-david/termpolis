// An in-memory stand-in for the Termpolis relay (relay/src/pairingRoom.ts), for
// tests that join two real bridge cores -- or a bridge and anything else that
// speaks the wire -- without a network.
//
// It keeps the four behaviours every client is built around, because each one
// has cost a real bug when a fake got it wrong:
//
//   - one socket per role SEAT, and a second dial for a held seat is a 409
//     (`error` then `close`, as `ws` reports an unexpected response);
//   - the relay alone authors TEXT control frames -- `hello{peer}`, `peer-joined`,
//     `peer-gone`, `quota-exceeded` -- encoded with relay/src/wire's own `encode`,
//     and peer text is dropped unread;
//   - BINARY is forwarded byte for byte to the other seat, and DROPPED, not
//     queued, when that seat is empty;
//   - a frame over the 1 MiB cap is cut for `frame-size`.
//
// Delivery is asynchronous and ordered per socket, the way `ws` delivers: every
// event is a microtask queued in the order the relay produced it. Synchronous
// delivery would let a greeting overtake the `peer-joined` that must precede it.
// Microtasks are not faked by vitest's fake timers, so this runs under either.
//
// A client that hangs up is CLOSING until its `close` event, as with `ws`: the
// relay frees its seat at once, but frames already on their way to it still
// arrive. A client that acts on those after it stopped is a real bug, and a fake
// that silently swallowed them would hide it.
//
// The sockets are `ws`-shaped emitters, so `RelayClient` takes them as
// `openSocket` unchanged. An `error` with no listener THROWS, as an EventEmitter
// does -- in the bridge's utilityProcess that is a crash, and here it is an
// unhandled error that fails the test.
import { encode, isRole, type ControlFrame, type Role } from '../../../relay/src/wire'
import { MAX_FRAME_BYTES } from '../../../relay/src/quota'
import { RelayClient, type RelayClientDeps, type SocketLike } from '../../../src/main/remoteBridge/relayClient'

/** Captured before any test can install fake timers, so `settle` always waits
 *  on the real clock. */
const realSetTimeout = globalThis.setTimeout

const ROOM_ID_RE = /^[0-9a-f]{32}$/
const PARTNER: Record<Role, Role> = { desktop: 'device', device: 'desktop' }

type Listener = (...args: never[]) => void

/** Where a socket stands. `closing` is a client that hung up and has not yet
 *  had its `close` event: unseated, but still receiving what was in flight. */
export type MemorySocketState = 'connecting' | 'open' | 'closing' | 'closed'

/** One client connection: what `RelayClient` holds, plus what a test inspects. */
export interface MemorySocket extends SocketLike {
  readonly url: string
  /** Parsed off the dial URL; null when the URL was not a room address. */
  readonly roomId: string | null
  readonly role: Role | null
  readonly state: MemorySocketState
  /** Binary frames this socket wrote that the relay accepted, in order. */
  readonly written: readonly Uint8Array[]
  /** Fire an event at the socket's listeners, as `ws` would. */
  emit(event: string, ...args: unknown[]): void
}

export interface MemoryRelay {
  /** Hand this to `RelayClient` as `openSocket`. */
  openSocket(url: string): MemorySocket
  /** Whether each seat of a room is held right now. */
  seats(roomId: string): { desktop: boolean; device: boolean }
  /** Hang up on a seated socket from the relay's side -- an outage, a deploy. */
  drop(roomId: string, role: Role): void
  /** Every socket ever opened, oldest first. */
  readonly sockets: readonly MemorySocket[]
  /** Every dial the relay refused, with the status it answered. */
  readonly refusals: ReadonlyArray<{ roomId: string | null; role: string | null; status: number }>
  /** Resolve once everything in flight has been delivered and reacted to.
   *
   *  Each round waits a millisecond of REAL time, which drains every queued
   *  microtask and lets any zero-delay real timer fire. Timers a test has faked
   *  are untouched: advance those yourself. */
  settle(rounds?: number): Promise<void>
}

class Socket implements MemorySocket {
  state: MemorySocketState = 'connecting'
  readonly written: Uint8Array[] = []
  private readonly listeners = new Map<string, Listener[]>()

  constructor(
    readonly url: string,
    readonly roomId: string | null,
    readonly role: Role | null,
    private readonly relay: RelayImpl,
  ) {}

  on(event: string, fn: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn])
    return this
  }

  send(data: Uint8Array): void {
    this.relay.fromClient(this, data)
  }

  close(): void {
    this.relay.closeFromClient(this)
  }

  emit(event: string, ...args: unknown[]): void {
    const fns = this.listeners.get(event) ?? []
    // EventEmitter semantics: an `error` nobody listens for is thrown.
    if (event === 'error' && fns.length === 0) throw args[0]
    for (const fn of [...fns]) (fn as (...a: unknown[]) => void)(...args)
  }
}

interface Room {
  desktop: Socket | null
  device: Socket | null
}

class RelayImpl implements MemoryRelay {
  readonly sockets: Socket[] = []
  readonly refusals: Array<{ roomId: string | null; role: string | null; status: number }> = []
  private readonly rooms = new Map<string, Room>()

  openSocket = (url: string): MemorySocket => {
    const match = /\/v1\/pair\/([^/?]+)\?role=([^&]*)$/.exec(url)
    const role = match?.[2] ?? null
    const sock = new Socket(url, match?.[1] ?? null, isRole(role) ? role : null, this)
    this.sockets.push(sock)
    // Seated on a later tick, like a real upgrade: the dialler gets its socket
    // back first and wires its listeners before anything can happen to it.
    queueMicrotask(() => this.connect(sock, role))
    return sock
  }

  seats(roomId: string): { desktop: boolean; device: boolean } {
    const room = this.rooms.get(roomId)
    return { desktop: !!room?.desktop, device: !!room?.device }
  }

  drop(roomId: string, role: Role): void {
    const sock = this.rooms.get(roomId)?.[role]
    if (!sock) return
    this.unseat(sock)
    queueMicrotask(() => sock.emit('close'))
  }

  async settle(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise<void>((r) => realSetTimeout(r, 1))
  }

  private room(roomId: string): Room {
    let room = this.rooms.get(roomId)
    if (!room) {
      room = { desktop: null, device: null }
      this.rooms.set(roomId, room)
    }
    return room
  }

  /** The upgrade, as `fetch` in relay/src/pairingRoom.ts handles it. */
  private connect(sock: Socket, rawRole: string | null): void {
    // Closed while still connecting: `closeFromClient` already reported it.
    if (sock.state !== 'connecting') return
    if (sock.roomId === null || !ROOM_ID_RE.test(sock.roomId) || sock.role === null) {
      return this.refuse(sock, rawRole, 400)
    }
    const room = this.room(sock.roomId)
    if (room[sock.role]) return this.refuse(sock, rawRole, 409)

    room[sock.role] = sock
    sock.state = 'open'
    sock.emit('open')
    const partner = room[PARTNER[sock.role]]
    this.control(sock, { kind: 'hello', role: sock.role, peer: partner !== null })
    if (partner) this.control(partner, { kind: 'peer-joined', role: sock.role })
  }

  private refuse(sock: Socket, rawRole: string | null, status: number): void {
    sock.state = 'closed'
    this.refusals.push({ roomId: sock.roomId, role: rawRole, status })
    sock.emit('error', new Error(`Unexpected server response: ${status}`))
    sock.emit('close')
  }

  /** A relay-authored text frame. Queued while its target is seated, and
   *  delivered unless the target has finished closing by then. */
  private control(target: Socket, frame: ControlFrame): void {
    queueMicrotask(() => {
      if (target.state !== 'closed') target.emit('message', Buffer.from(encode(frame)), false)
    })
  }

  fromClient(sock: Socket, data: Uint8Array | string): void {
    // `ws` throws on a send before the upgrade completes, and drops one after
    // close (it would report through a callback nobody here passes).
    if (sock.state === 'connecting') throw new Error('WebSocket is not open: readyState 0 (CONNECTING)')
    if (sock.state !== 'open') return
    // Peer text is dropped unread: the relay authors every text frame itself.
    if (typeof data === 'string') return
    const bytes = new Uint8Array(data)
    if (bytes.byteLength > MAX_FRAME_BYTES) return this.cut(sock, 'frame-size')
    sock.written.push(bytes)
    const partner = this.room(sock.roomId!)[PARTNER[sock.role!]]
    // No partner: dropped. Queueing would make the relay hold payload between
    // connections, which is the one thing it promises not to do.
    if (!partner) return
    queueMicrotask(() => {
      if (partner.state !== 'closed') partner.emit('message', Buffer.from(bytes), true)
    })
  }

  closeFromClient(sock: Socket): void {
    if (sock.state === 'closed' || sock.state === 'closing') return
    if (sock.state === 'connecting') {
      // `ws` aborts the handshake and reports it on the next tick: `error`, then
      // `close`. A socket with no `error` listener crashes its process here.
      sock.state = 'closed'
      queueMicrotask(() => {
        sock.emit('error', new Error('WebSocket was closed before the connection was established'))
        sock.emit('close')
      })
      return
    }
    // Unseated now, closed a tick later: whatever was already queued for this
    // socket is delivered in between, as it is to a real one that is CLOSING.
    this.unseat(sock, 'closing')
    queueMicrotask(() => {
      sock.state = 'closed'
      sock.emit('close')
    })
  }

  /** Free the seat and tell whoever is left, once. */
  private unseat(sock: Socket, next: 'closing' | 'closed' = 'closed'): void {
    sock.state = next
    const room = this.room(sock.roomId!)
    room[sock.role!] = null
    const partner = room[PARTNER[sock.role!]]
    if (partner) this.control(partner, { kind: 'peer-gone', role: sock.role! })
  }

  /** Tell the offender which limit it hit, then hang up on it. */
  private cut(sock: Socket, limit: 'frame-size'): void {
    this.control(sock, { kind: 'quota-exceeded', limit })
    // A tick later, so the notice is delivered while the socket is still seated.
    queueMicrotask(() => {
      if (sock.state !== 'open') return
      this.unseat(sock)
      sock.emit('close')
    })
  }
}

export function createMemoryRelay(): MemoryRelay {
  return new RelayImpl()
}

/** An `openRelay` for `createBridgeCore` that builds real `RelayClient`s over
 *  this relay. Backoff jitter is pinned so redial timing is deterministic. */
export function relayOpener(relay: MemoryRelay): (deps: RelayClientDeps) => RelayClient {
  return (deps) => new RelayClient({ ...deps, openSocket: relay.openSocket, random: () => 0.5 })
}
