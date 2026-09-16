import { encode, isRole, byteLength, type Role, type QuotaLimit } from './wire'
import type { Env } from './index'
import {
  ByteBudget,
  TokenBucket,
  resolveByteBudget,
  IDLE_TIMEOUT_MS,
  FRAME_BURST,
  FRAME_RATE_PER_SEC,
  MAX_FRAME_BYTES,
} from './quota'

/** True while a socket can still be written to.
 *
 *  "It is seated, therefore it is open" is not true, only usually true. A peer is
 *  unseated by its own close handler, which runs *after* the close, so there is
 *  always a window in which a closed socket is still in the registry -- and two
 *  ordinary things land in it. A client that floods past the frame rate has more
 *  frames already queued behind the one that trips the limit, and every one of
 *  them arrives at a socket this file has just closed. An idle alarm closes both
 *  peers in a single pass, before either close event is dispatched.
 *
 *  It matters because workerd throws on both `send()` and `close()` after a
 *  close, and every call to either happens inside a handler the runtime invoked,
 *  where a throw is an uncaught exception in the Durable Object rather than an
 *  error some caller can handle. */
function isOpen(sock: WebSocket): boolean {
  return sock.readyState === WebSocket.READY_STATE_OPEN
}

/** The other end of a pairing.
 *
 *  A total lookup rather than a conditional: a third role added to `ROLES` fails
 *  to compile here instead of silently inheriting one of these two as its
 *  partner. */
const PARTNER: Record<Role, Role> = { desktop: 'device', device: 'desktop' }

/** Everything about one connection that has to outlive the isolate.
 *
 *  None of this can be a field on the room. Hibernation evicts the isolate while
 *  a pair sits idle, so a `peers` map is EMPTY on the next frame -- which would
 *  free both roles, hand every connection a fresh allowance and make the
 *  two-peer cap advisory. It rides on the socket instead, where the runtime
 *  keeps it. */
interface Conn {
  role: Role
  /** `TokenBucket` mid-flight -- see `BucketState`. */
  tokens: number
  last: number
  /** `ByteBudget` mid-flight. */
  spent: number
  /** When this connection last sent a frame the relay accepted. */
  lastSeen: number
}

export class PairingRoom {
  /** Resolved once per isolate rather than once per frame. It is the only thing
   *  this room ever wanted from `env`, so `env` itself is not kept. */
  private readonly budget: number

  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    this.budget = resolveByteBudget(env.CONNECTION_BYTE_BUDGET)
  }

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get('role')
    if (!isRole(role)) return new Response('bad role', { status: 400 })
    if (this.socketFor(role)) return new Response('role already connected', { status: 409 })

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    // The hibernation accept, NOT `server.accept()`. That is the whole shape of
    // this file: the runtime holds the socket, so the isolate can be evicted
    // between frames and rebuilt on the next one. `accept()` instead pins a
    // resident isolate for every connected pair -- and a terminal session is
    // idle the overwhelming majority of the time, so that is one resident copy
    // per pairing, almost all of it spent doing nothing.
    //
    // Tagged with the role, which is what makes `socketFor` a registry lookup
    // rather than a scan: the tag survives the eviction with the socket.
    this.state.acceptWebSocket(server, [role])
    // There is no `binaryType` to set here, and its absence is not an oversight.
    // The classic path handed this file a `MessageEvent` whose `data` defaulted
    // to a Blob, and `send()` coerces a Blob to the string "[object Blob]" --
    // which destroyed every byte of a forwarded frame while the frame count and
    // the timing stayed right. `webSocketMessage` is typed `string | ArrayBuffer`
    // by the runtime, so that hazard has no way to arise.
    const conn: Conn = {
      role,
      tokens: FRAME_BURST,
      last: 0,
      spent: 0,
      lastSeen: Date.now(),
    }
    server.serializeAttachment(conn)
    void this.state.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS)

    // One lookup, used twice: whether the partner is here is exactly what the
    // arriving peer needs to know before it greets, and exactly who to tell that
    // someone has arrived.
    const partner = this.socketFor(PARTNER[role])
    // `server` was accepted a few lines ago and its client half has not been
    // handed out yet, so it cannot be anything but open. The partner has been
    // connected for as long as it has been connected.
    server.send(encode({ kind: 'hello', role, peer: partner !== undefined }))
    if (partner) partner.send(encode({ kind: 'peer-joined', role }))

    return new Response(null, { status: 101, webSocket: client })
  }

  /** The socket seated in a role, if any.
   *
   *  `getWebSockets` is the RUNTIME's registry, not this object's, which is what
   *  carries the two-peer cap across a hibernation. Read from a field, a
   *  rehydrated room would believe both roles were free and seat a second
   *  desktop into a pairing that already had one -- quietly giving it a copy of
   *  someone else's traffic.
   *
   *  A seat is held by an OPEN socket, not merely a registered one. The runtime
   *  keeps a closed socket in the registry until it has finished delivering
   *  whatever was queued behind the close, which after a flood runs to hundreds
   *  of milliseconds. Taking the first registered socket would hold the seat for
   *  that whole window and answer 409 to the honest client trying to come back
   *  from the disconnect the relay just gave it. */
  private socketFor(role: Role): WebSocket | undefined {
    // `find(isOpen)`, not `[0]`, and this is the ONLY place that decides whether a
    // socket is usable as a recipient. Every caller sends synchronously on what it
    // gets back, so openness established here still holds at the send -- which is
    // why none of them re-checks. Introduce an await between a lookup and its send
    // and that stops being true: re-read here, or re-check there.
    return this.state.getWebSockets(role).find(isOpen)
  }

  /** A peer has sent a frame. Public because the runtime calls it. */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // A frame from a socket this room has ALREADY closed, which arrives as a
    // matter of routine: a client cut for flooding has every frame it queued
    // behind the offending one still to be delivered, and the cut does not
    // recall them.
    //
    // They cannot be allowed to forward. The rate limiter alone does not stop
    // them -- it refills at a token per 50 ms, and a long queue takes longer
    // than that to drain -- so a frame from the dead connection wins a token and
    // goes out. By then the offender's replacement is usually connected, and the
    // partner receives a frame from a disowned socket spliced into the middle of
    // the new connection's stream. Checking the SENDER is still open is what
    // makes "cut" mean cut.
    if (!isOpen(ws)) return

    // Text is a peer trying to talk to the relay, or to forge a control frame at
    // its partner. Neither is part of the protocol: peers speak to each other in
    // BINARY only, and the relay authors every control frame itself. Dropping
    // text unread means there is no parser for a peer to reach.
    if (typeof message === 'string') return

    const conn = ws.deserializeAttachment() as Conn
    const size = byteLength(message)
    // Enforce BEFORE forwarding. A limit applied after the send is a report, not
    // a control -- the frame the relay objected to would already have been
    // delivered and already have cost what it cost.
    if (size > MAX_FRAME_BYTES) return this.cut(ws, 1009, 'frame-size')

    const now = Date.now()
    // Rebuilt from the attachment on every frame because after a hibernation
    // there is nothing else to rebuild them from, and written back below. The
    // allowances belong to this CONNECTION, not to the role: a peer that is cut
    // and reconnects gets a fresh one, because the budget bounds one socket's
    // cost -- it is not a punishment attached to an identity the relay cannot
    // even see. Reading them off the socket makes that structural, so a frame
    // still queued behind a cut cannot spend its successor's allowance.
    const frames = new TokenBucket(FRAME_BURST, FRAME_RATE_PER_SEC / 1000, conn)
    if (!frames.take(now)) return this.cut(ws, 1008, 'frame-rate')
    const bytes = new ByteBudget(this.budget, conn.spent)
    if (!bytes.spend(size)) return this.cut(ws, 1008, 'connection-bytes')

    ws.serializeAttachment({
      ...conn,
      ...frames.snapshot(),
      spent: bytes.used,
      lastSeen: now,
    } as Conn)

    const partner = this.socketFor(PARTNER[conn.role])
    // No partner: drop. Queueing would make the relay hold payload between
    // connections, which is the one thing it promises not to do.
    if (!partner) return
    partner.send(message)
  }

  /** Both teardown handlers, and both are the runtime's to call. `close` and
   *  `error` are separate events for one departure, so `drop` is written to be
   *  called twice for the same socket. */
  webSocketClose(ws: WebSocket): void {
    this.drop(ws)
  }

  webSocketError(ws: WebSocket): void {
    this.drop(ws)
  }

  /** Close whatever has gone silent, then decide whether to look again.
   *
   *  Public because it is the Durable Object alarm handler -- the runtime calls it,
   *  and so does the lifecycle test, which is the only way to observe this without
   *  waiting five real minutes for a clock that does not advance inside a Workers
   *  invocation anyway.
   *
   *  The alarm is also what keeps the idle timeout honest under hibernation: it
   *  is delivered to an evicted room, waking it just long enough to look. */
  async alarm(): Promise<void> {
    const now = Date.now()
    const sockets = this.state.getWebSockets()
    for (const ws of sockets) {
      const { lastSeen } = ws.deserializeAttachment() as Conn
      if (now - lastSeen >= IDLE_TIMEOUT_MS) this.cut(ws, 1000, 'idle')
    }
    // Re-arm only while someone is still connected. An empty room that keeps
    // scheduling alarms is a Durable Object that never goes away, billed forever
    // for a pairing nobody is using -- and every wake-up is a write.
    if (sockets.length > 0) await this.state.storage.setAlarm(now + IDLE_TIMEOUT_MS)
  }

  /** Unseat a peer and tell its partner.
   *
   *  The departing socket is excluded by identity rather than by role. Whether
   *  the runtime has already removed it from `getWebSockets` by the time this
   *  runs is not something this file should have to know, and the answer differs
   *  between a close and an error; filtering on the socket itself is correct
   *  either way.
   *
   *  It is reached twice for one departure -- from `cut`, and again from the
   *  runtime's own teardown event -- so `announced` makes the announcement
   *  itself happen once. Telling the phone twice would say its desktop had left
   *  again, plausibly after the desktop had already reconnected.
   *
   *  That guard is in memory, exactly as the old `peers.delete()` return value
   *  was. A room cannot hibernate with a teardown still pending for a socket it
   *  is tearing down, so both paths run in the same wake-up. */
  private readonly announced = new Set<WebSocket>()

  private drop(ws: WebSocket): void {
    // No attachment means the socket was never seated in this room -- `fetch`
    // attaches before it hands the client half back, so there is no window in
    // which a peer exists without one. Nobody is paired with it, so there is
    // nobody its departure could concern.
    const conn = ws.deserializeAttachment() as Conn | null
    if (conn && !this.announced.has(ws)) {
      this.announced.add(ws)
      const partner = this.socketFor(PARTNER[conn.role])
      if (partner) partner.send(encode({ kind: 'peer-gone', role: conn.role }))
    }
    // Cancel the idle alarm once no LIVE peer is left. Leaving it armed would wake
    // an empty room five minutes later purely to discover it is empty -- a write
    // and a billable invocation for nothing, on every room anyone ever opened.
    // Asked of the other sockets rather than of `ws`, because whether the
    // departing one is still registered depends on how far the runtime has got.
    if (!this.state.getWebSockets().some((w) => w !== ws && isOpen(w))) {
      void this.state.storage.deleteAlarm()
    }
  }

  /** Tell the offender which limit it hit, then close it.
   *
   *  Naming the limit is deliberate: a client that cannot tell "you sent too much"
   *  from "the network broke" will reconnect in a loop and turn its own bug into a
   *  denial of service against the relay.
   *
   *  Telling the partner is done HERE rather than left to the teardown event,
   *  which is the one place hibernation genuinely changed the design. The runtime
   *  delivers `webSocketClose` only after everything already queued behind the
   *  close, so a peer cut mid-flood has its departure announced several hundred
   *  milliseconds late -- the partner sits waiting on a desktop the relay hung up
   *  on, and the offender meets 409 when it tries to come back. `drop` is written
   *  to be called twice for one socket, so this costs nothing but promptness.
   *
   *  Cutting a socket that is already closed is a no-op rather than a second
   *  close. It happens routinely -- see `isOpen` -- and workerd throws on both
   *  `send()` and `close()` after a close, so without the check one flooding
   *  client raises an uncaught exception per queued frame inside the room. */
  private cut(sock: WebSocket, code: number, limit: QuotaLimit): void {
    if (!isOpen(sock)) return
    sock.send(encode({ kind: 'quota-exceeded', limit }))
    sock.close(code, limit)
    this.drop(sock)
  }
}
