import { encode, isRole, type Role } from './wire'

export class PairingRoom {
  /** At most one socket per role. A Map rather than two fields so the peer lookup
   *  is "the entry that is not me" instead of a conditional that has to be kept in
   *  step with the role list by hand. */
  private readonly peers = new Map<Role, WebSocket>()

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
    this.peers.set(role, server)

    server.send(encode({ kind: 'hello', role }))
    this.peer(role)?.send(encode({ kind: 'peer-joined', role }))

    server.addEventListener('message', (event) => {
      // Text is a peer trying to talk to the relay, or to forge a control frame at
      // its partner. Neither is part of the protocol: peers speak to each other in
      // BINARY only, and the relay authors every control frame itself. Dropping
      // text unread means there is no parser for a peer to reach.
      if (typeof event.data === 'string') return

      const peer = this.peer(role)
      // No partner: drop. Queueing would make the relay hold payload between
      // connections, which is the one thing it promises not to do.
      if (!peer) return
      peer.send(event.data)
    })

    server.addEventListener('close', () => this.drop(role))
    server.addEventListener('error', () => this.drop(role))

    return new Response(null, { status: 101, webSocket: client })
  }

  /** The other end of the pairing, if it is connected. */
  private peer(role: Role): WebSocket | undefined {
    for (const [otherRole, sock] of this.peers) if (otherRole !== role) return sock
    return undefined
  }

  private drop(role: Role): void {
    if (!this.peers.delete(role)) return
    this.peer(role)?.send(encode({ kind: 'peer-gone', role }))
  }
}
