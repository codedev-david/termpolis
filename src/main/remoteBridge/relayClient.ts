import WebSocket from 'ws'
import type { SealedChannel } from './sealedChannel'
import type { RemoteEnvelope, RemoteResponse } from './protocol'

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
  channel: SealedChannel
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
      this.setState('online')
    }) as never)

    sock.on('message', ((data: Buffer, isBinary: boolean) => {
      // Control frames are text and are not part of the request path. Only binary
      // carries sealed payload.
      if (!isBinary) return
      void this.handleFrame(new Uint8Array(data))
    }) as never)

    // `close` and `error` both land here, and `ws` emits `error` followed by
    // `close`. Guarding on the socket identity keeps that pair from counting as
    // two failures and doubling the backoff twice for one outage.
    const down = () => {
      if (this.socket !== sock) return
      this.socket = null
      this.setState('offline')
      this.retry()
    }
    sock.on('close', down as never)
    sock.on('error', down as never)
  }

  private async handleFrame(frame: Uint8Array): Promise<void> {
    let envelope: RemoteEnvelope
    try {
      // Two distinct rejections, both silent: a frame that does not open (forged,
      // replayed, or corrupted in transit) and one that opens but is not an
      // envelope. Neither may throw out of here -- an unhandled rejection in the
      // message handler tears down a connection that a hostile phone could then
      // drop at will.
      envelope = JSON.parse(new TextDecoder().decode(this.deps.channel.open(frame)))
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

  /** Seal and write. Drops the payload when there is no socket: the fan-out is
   *  the buffer for output, and a second queue here would double-store it. */
  send(payload: unknown): void {
    if (!this.socket) return
    try {
      this.socket.send(this.deps.channel.seal(new TextEncoder().encode(JSON.stringify(payload))))
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
    this.setState('offline')
  }

  private setState(next: RelayState): void {
    if (this.state === next) return
    this.state = next
    this.deps.onStateChange(next)
  }
}
