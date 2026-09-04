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

export class PairingRoom {
  // Classic Durable Object shape: the runtime constructs one per pairing id and
  // hands it the state and the environment. State is unused -- a pairing room is
  // deliberately amnesiac, holding nothing across an eviction, because anything it
  // remembered would be metadata about a conversation it is not entitled to know.
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  /** At most one socket per role. A Map rather than two fields so the peer lookup
   *  is "the entry that is not me" instead of a conditional that has to be kept in
   *  step with the role list by hand. */
  /** One record per connected peer, holding its socket AND its allowances.
   *
   *  These started as a Map and a parallel WeakMap keyed by the same socket, which
   *  forced every read to carry an `if (limit)` guard for a desync no caller could
   *  cause -- and coverage duly showed that branch was unreachable. One record
   *  makes the invariant structural: a peer either exists with its budgets, or it
   *  is not connected.
   *
   *  Budgets are per-CONNECTION, not per-role: a peer that is cut and reconnects
   *  gets a fresh allowance, because the budget bounds one socket's cost -- it is
   *  not a punishment attached to an identity the relay cannot even see. */
  private readonly peers = new Map<
    Role,
    { sock: WebSocket; frames: TokenBucket; bytes: ByteBudget; lastSeen: number }
  >()

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get('role')
    if (!isRole(role)) return new Response('bad role', { status: 400 })
    if (this.peers.has(role)) return new Response('role already connected', { status: 409 })

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    // workerd defaults binaryType to "blob", and WebSocket.send() does NOT accept a
    // Blob -- it coerces the argument to a string, so a forwarded payload frame
    // arrives at the far end as the literal text "[object Blob]". Every byte of
    // every sealed frame would be destroyed, and the relay would still look healthy
    // because the frame count and the timing would be right. Asking for
    // ArrayBuffers is what makes the forward below actually a forward.
    server.binaryType = 'arraybuffer'
    server.accept()
    // Held in the closure below, NOT looked up by role when a frame arrives. A role
    // is freed the moment its peer is cut and can be re-taken immediately, so a
    // lookup would let a late frame from the cut socket spend the NEW peer's budget
    // -- an honest client throttled for its predecessor's flood. The allowances
    // belong to this connection, so this connection holds them.
    const mine = {
      sock: server,
      frames: new TokenBucket(FRAME_BURST, FRAME_RATE_PER_SEC / 1000),
      bytes: new ByteBudget(resolveByteBudget(this.env.CONNECTION_BYTE_BUDGET)),
      lastSeen: Date.now(),
    }
    this.peers.set(role, mine)
    void this.state.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS)

    // One lookup, used twice: whether the partner is here is exactly what the
    // arriving peer needs to know before it greets, and exactly who to tell that
    // someone has arrived.
    const partner = this.peer(role)
    server.send(encode({ kind: 'hello', role, peer: partner !== undefined }))
    partner?.send(encode({ kind: 'peer-joined', role }))

    server.addEventListener('message', (event) => {
      // Text is a peer trying to talk to the relay, or to forge a control frame at
      // its partner. Neither is part of the protocol: peers speak to each other in
      // BINARY only, and the relay authors every control frame itself. Dropping
      // text unread means there is no parser for a peer to reach.
      if (typeof event.data === 'string') return

      const peer = this.peer(role)
      // No partner: drop. Queueing would make the relay hold payload between
      // connections, which is the one thing it promises not to do.
      const size = byteLength(event.data)
      // Enforce BEFORE forwarding. A limit applied after the send is a report, not
      // a control -- the frame the relay objected to would already have been
      // delivered and already have cost what it cost.
      if (size > MAX_FRAME_BYTES) return this.cut(role, server, 1009, 'frame-size')

      if (!mine.frames.take(Date.now())) return this.cut(role, server, 1008, 'frame-rate')
      if (!mine.bytes.spend(size)) return this.cut(role, server, 1008, 'connection-bytes')

      mine.lastSeen = Date.now()

      if (!peer) return
      peer.send(event.data)
    })

    server.addEventListener('close', () => this.drop(role))
    server.addEventListener('error', () => this.drop(role))

    return new Response(null, { status: 101, webSocket: client })
  }

  /** The other end of the pairing, if it is connected. */
  private peer(role: Role): WebSocket | undefined {
    for (const [otherRole, p] of this.peers) if (otherRole !== role) return p.sock
    return undefined
  }


  /** Close whatever has gone silent, then decide whether to look again.
   *
   *  Public because it is the Durable Object alarm handler -- the runtime calls it,
   *  and so does the lifecycle test, which is the only way to observe this without
   *  waiting five real minutes for a clock that does not advance inside a Workers
   *  invocation anyway. */
  async alarm(): Promise<void> {
    const now = Date.now()
    for (const [role, p] of [...this.peers]) {
      if (now - p.lastSeen >= IDLE_TIMEOUT_MS) this.cut(role, p.sock, 1000, 'idle')
    }
    // Re-arm only while someone is still connected. An empty room that keeps
    // scheduling alarms is a Durable Object that never goes away, billed forever
    // for a pairing nobody is using -- and every wake-up is a write.
    if (this.peers.size > 0) await this.state.storage.setAlarm(now + IDLE_TIMEOUT_MS)
  }

  /** Unseat a peer and tell its partner.
   *
   *  Deletes by ROLE, with no check that the leaving socket is the one seated --
   *  and that is safe rather than sloppy. `fetch` answers 409 while a role is
   *  occupied, so a replacement cannot seat until the incumbent's drop has already
   *  run; a close event can therefore never arrive for a socket some other
   *  connection has since replaced. A guard here would be an unreachable branch
   *  standing in for an invariant that the 409 already enforces. */
  private drop(role: Role): void {
    // Idempotent: `close` and `error` are both wired to this, and a socket that
    // errors then closes calls it twice. Without the early return the second call
    // would announce a `peer-gone` for a peer that had already gone.
    if (!this.peers.delete(role)) return
    this.peer(role)?.send(encode({ kind: 'peer-gone', role }))
    // Cancel the idle alarm when the last peer leaves. Leaving it armed would wake
    // an empty room five minutes later purely to discover it is empty -- a write
    // and a billable invocation for nothing, on every room anyone ever opened.
    if (this.peers.size === 0) void this.state.storage.deleteAlarm()
  }

  /** Tell the offender which limit it hit, then close it.
   *
   *  Naming the limit is deliberate: a client that cannot tell "you sent too much"
   *  from "the network broke" will reconnect in a loop and turn its own bug into a
   *  denial of service against the relay.
   *
   *  Freeing the role and telling the partner `peer-gone` is left to the `close`
   *  listener rather than done here. Doing both would be two paths for one event,
   *  and `close()` fires that listener anyway -- a mutation test proved the extra
   *  `drop` call changed nothing, which is the definition of a line that can only
   *  ever drift out of step with the one that matters. */
  private cut(role: Role, sock: WebSocket, code: number, limit: QuotaLimit): void {
    sock.send(encode({ kind: 'quota-exceeded', limit }))
    sock.close(code, limit)
  }
}
