import { utf8Encode } from '../wire/bytes'
import { SEAL_OVERHEAD_BYTES } from '../wire/sealedChannel'
import { SESSION_HEADER_BYTES } from '../wire/sessionCrypto'
import {
  parseRemoteMessage,
  RELAY_MAX_FRAME_BYTES,
  type AgentStatus,
  type Capabilities,
  type OutputChunk,
  type RemoteRequest,
} from '../wire/protocol'

/** The largest request this end will put on the wire, measured as UTF-8 bytes of
 *  the serialised envelope.
 *
 *  The relay CUTS a connection over an oversized frame rather than truncating it,
 *  and that cut latches -- so one paste that was too big becomes a remote session
 *  that never comes back, which reads to the user as an unreliable network rather
 *  than as one message being too large. Refusing locally turns it into an error
 *  on the paste, where it belongs.
 *
 *  The budget is the relay ceiling minus what sealing adds: the one-byte frame
 *  tag, and the six-byte counter plus sixteen-byte Poly1305 tag. */
export const MAX_REQUEST_BYTES = RELAY_MAX_FRAME_BYTES - SESSION_HEADER_BYTES - SEAL_OVERHEAD_BYTES

/** How long a request waits before it is failed rather than left pending. */
export const DEFAULT_TIMEOUT_MS = 20_000

export interface StatusUpdate {
  terminalId: string
  status: AgentStatus
  summary: string
}

export interface RemoteSessionDeps {
  /** Hands a serialised envelope to the transport, which seals it. Dropping it
   *  is the transport's business: this end learns about that through the
   *  timeout, which is the only signal that covers a socket that is up and a
   *  desktop that is not answering. */
  send(plaintext: Uint8Array): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
}

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: unknown
}

/** Correlates requests with answers and fans pushes out to the screens.
 *
 *  Deals only in plaintext. Sealing, the socket, reconnects and the handshake all
 *  live in `relaySocket`; this file would behave identically over a pipe, which
 *  is what makes it testable without any of that. */
export class RemoteSession {
  private readonly pending = new Map<number, Pending>()
  private readonly outputSubscribers = new Set<(chunks: OutputChunk[]) => void>()
  private readonly statusSubscribers = new Set<(update: StatusUpdate) => void>()
  private readonly capabilitySubscribers = new Set<(caps: Capabilities) => void>()
  private nextId = 1

  constructor(private readonly deps: RemoteSessionDeps) {}

  request<T = unknown>(req: RemoteRequest, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++
    const plaintext = utf8Encode(JSON.stringify({ id, request: req }))
    if (plaintext.length > MAX_REQUEST_BYTES) {
      // Measured in BYTES, after encoding. A limit checked against string length
      // passes a paste of emoji that is four times over on the wire.
      return Promise.reject(
        new Error(
          `request is too large to send: ${plaintext.length} bytes, limit ${MAX_REQUEST_BYTES}`,
        ),
      )
    }

    return new Promise<T>((resolve, reject) => {
      const timer = this.deps.setTimer(() => {
        // Removed before rejecting, so the answer that arrives a moment later
        // finds nothing to settle rather than settling a dead promise.
        this.pending.delete(id)
        reject(new Error(`request ${id} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.deps.send(plaintext)
    })
  }

  onOutput(cb: (chunks: OutputChunk[]) => void): () => void {
    this.outputSubscribers.add(cb)
    return () => {
      this.outputSubscribers.delete(cb)
    }
  }

  onStatus(cb: (update: StatusUpdate) => void): () => void {
    this.statusSubscribers.add(cb)
    return () => {
      this.statusSubscribers.delete(cb)
    }
  }

  onCapabilities(cb: (caps: Capabilities) => void): () => void {
    this.capabilitySubscribers.add(cb)
    return () => {
      this.capabilitySubscribers.delete(cb)
    }
  }

  /** Route one opened frame.
   *
   *  Never throws, for any input. This runs inside the socket's message handler,
   *  where an exception is an unhandled rejection that tears the connection down
   *  -- which a hostile peer could then trigger at will. Everything unrecognised
   *  is dropped in silence. */
  handleFrame(plaintext: Uint8Array): void {
    const message = parseRemoteMessage(plaintext)
    if (message === null) return

    switch (message.kind) {
      case 'ok': {
        const entry = this.take(message.id)
        entry?.resolve(message.data)
        return
      }
      case 'error': {
        const entry = this.take(message.id)
        entry?.reject(new Error(message.message))
        return
      }
      case 'output':
        this.fanOut(this.outputSubscribers, message.chunks)
        return
      case 'status':
        this.fanOut(this.statusSubscribers, {
          terminalId: message.terminalId,
          status: message.status,
          summary: message.summary,
        })
        return
      case 'capabilities':
        this.fanOut(this.capabilitySubscribers, message.capabilities)
        return
    }
  }

  /** Fail everything in flight. The socket calls this when the session dies, so
   *  a phone that backgrounds mid-request does not come back to a screen that has
   *  been spinning since it left.
   *
   *  Subscribers deliberately survive: the socket reconnects underneath while the
   *  screen listening for output stays mounted, and re-subscribing on every
   *  reconnect is how listeners multiply. */
  reset(reason: string): void {
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id)
      this.deps.clearTimer(entry.timer)
      entry.reject(new Error(reason))
    }
  }

  /** Claim a pending entry, so each id is answered at most once. A duplicate or
   *  late answer then finds nothing and is dropped. */
  private take(id: number): Pending | null {
    const entry = this.pending.get(id)
    if (!entry) return null
    this.pending.delete(id)
    this.deps.clearTimer(entry.timer)
    return entry
  }

  /** Deliver to every subscriber, isolating each one.
   *
   *  A render callback that throws must not deafen the rest of the app to
   *  terminal output for the remainder of the session. Iterated over a copy
   *  because a callback is allowed to unsubscribe itself. */
  private fanOut<T>(subscribers: Set<(value: T) => void>, value: T): void {
    for (const cb of [...subscribers]) {
      try {
        cb(value)
      } catch {
        // The subscriber's problem, not the transport's.
      }
    }
  }
}
