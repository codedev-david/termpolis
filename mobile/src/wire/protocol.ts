import { utf8Decode } from './bytes'

/** Capabilities a paired device may be granted. Each is opt-in, default false.
 *
 *  Mirrors `Capabilities` in `src/main/remoteBridge/protocol.ts`. The phone never
 *  enforces these -- the desktop does, on every request -- but it shows them, and
 *  a phone that displays a right the desktop is not granting is worse than one
 *  that shows nothing. */
export interface Capabilities {
  /** List terminals and read their output. */
  read: boolean
  /** Create a new AI terminal. Commands go through sanitizeAgentCommand. */
  createTerminal: boolean
  /** Type into an EXISTING terminal. Bypasses the command allowlist entirely. */
  writeToTerminal: boolean
  /** Close a terminal. */
  closeTerminal: boolean
}

/** Frozen so a missed spread fails loudly rather than granting one phone the
 *  rights another was given. */
export const NO_CAPABILITIES: Capabilities = Object.freeze({
  read: false,
  createTerminal: false,
  writeToTerminal: false,
  closeTerminal: false,
})

/** Mirrors `AgentStatus` in `src/shared/agentStatusDetector.ts`.
 *
 *  Retyped rather than imported: `wire/` compiles for React Native and must not
 *  reach into the desktop tree. `tests/electron/remoteMobileInterop.test.ts`
 *  imports both and asserts they agree, which is what keeps the copy honest. */
export type AgentStatus =
  | 'starting'
  | 'thinking'
  | 'waiting_for_input'
  | 'working'
  | 'idle'
  | 'errored'
  | 'completed'
  | 'blocked'

const AGENT_STATUSES: readonly string[] = [
  'starting',
  'thinking',
  'waiting_for_input',
  'working',
  'idle',
  'errored',
  'completed',
  'blocked',
]

/** Requests a remote device may send. */
export type RemoteRequest =
  | { kind: 'listTerminals' }
  | { kind: 'createTerminal'; name: string; cwd?: string }
  | { kind: 'runCommand'; terminalId: string; command: string }
  | { kind: 'writeToTerminal'; terminalId: string; text: string }
  | { kind: 'closeTerminal'; terminalId: string }
  | { kind: 'subscribe'; terminalId: string }
  | { kind: 'unsubscribe'; terminalId: string }

/** Envelope carrying a request with its correlation id. */
export interface RemoteEnvelope {
  id: number
  request: RemoteRequest
}

/** One terminal's output as it crosses the wire.
 *
 *  `missed` stays numeric alongside the rendered `marker` so a client can count a
 *  gap as well as print it. */
export interface OutputChunk {
  terminalId: string
  chunk: string
  /** Chars evicted before the fan-out reached them. Non-zero means output is gone. */
  missed: number
  /** Rendered gap notice, on the FIRST piece of a split chunk only. */
  marker: string | null
}

/** Terminal output, batched. Many chunks per frame rather than one frame per
 *  chunk: the relay bills per frame and allows a burst of 40, so a frame per
 *  echoed keystroke would spend the whole burst on ordinary typing. */
export interface OutputPayload {
  kind: 'output'
  chunks: OutputChunk[]
}

/** An answer to exactly one envelope. */
export type RemoteResponse =
  | { kind: 'ok'; id: number; data: unknown }
  | { kind: 'error'; id: number; message: string }

/** Everything the desktop may put on the wire, answers and pushes alike.
 *
 *  Kept as one type because two shapes behind a single discriminator is not a
 *  style problem -- it is a renderer that silently shows nothing. */
export type RemoteMessage =
  | RemoteResponse
  | OutputPayload
  | { kind: 'status'; terminalId: string; status: AgentStatus; summary: string }

/** The relay refuses -- and cuts the connection on -- any frame larger than this.
 *  Mirrors `RELAY_MAX_FRAME_BYTES` on the desktop and `MAX_FRAME_BYTES` in the
 *  relay; the interop test asserts all three agree. */
export const RELAY_MAX_FRAME_BYTES = 1_048_576

/** Where the phone dials when the QR did not name a relay of its own. */
export const DEFAULT_RELAY_URL = 'wss://relay.termpolis.com'

/** Which limit a peer hit, as the relay names it just before cutting it off. */
export type QuotaLimit = 'frame-size' | 'frame-rate' | 'connection-bytes' | 'idle'

/** The relay's own messages -- the only frames it authors, and the only ones it
 *  reads. They arrive as JSON TEXT on the same socket as sealed payload, which is
 *  BINARY and opaque.
 *
 *  `role` is `string` rather than a union: nothing here acts on it, and a relay is
 *  not trusted to be truthful about it anyway. */
export type RelayControlFrame =
  | { kind: 'hello'; role: string; peer: boolean }
  | { kind: 'peer-joined'; role: string }
  | { kind: 'peer-gone'; role: string }
  | { kind: 'quota-exceeded'; limit: QuotaLimit }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A correlation id has to be an integer we can key a map by. A float or a
 *  numeric string would resolve nothing and leave the request pending forever. */
function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isOutputChunk(value: unknown): value is OutputChunk {
  if (!isObject(value)) return false
  return (
    typeof value.terminalId === 'string' &&
    typeof value.chunk === 'string' &&
    typeof value.missed === 'number' &&
    (value.marker === null || typeof value.marker === 'string')
  )
}

/** Read one plaintext message, or `null`.
 *
 *  Never throws. A frame that opens and is not a valid envelope is dropped
 *  silently: an exception out of the message handler is an unhandled rejection
 *  that tears down the connection, which a hostile peer could then trigger at
 *  will. Every field that is later READ is guarded here, once, rather than at
 *  each of its call sites. */
export function parseRemoteMessage(plaintext: Uint8Array): RemoteMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(utf8Decode(plaintext))
  } catch {
    return null
  }
  if (!isObject(parsed)) return null

  switch (parsed.kind) {
    case 'ok':
      return isId(parsed.id) ? { kind: 'ok', id: parsed.id, data: parsed.data } : null

    case 'error':
      return isId(parsed.id) && typeof parsed.message === 'string'
        ? { kind: 'error', id: parsed.id, message: parsed.message }
        : null

    case 'output': {
      const { chunks } = parsed
      // The whole batch or none of it. Partial delivery would paint a terminal
      // that is missing a span it never marks as missing -- worse than nothing.
      if (!Array.isArray(chunks) || !chunks.every(isOutputChunk)) return null
      return { kind: 'output', chunks: chunks as OutputChunk[] }
    }

    case 'status':
      return typeof parsed.terminalId === 'string' &&
        typeof parsed.status === 'string' &&
        AGENT_STATUSES.includes(parsed.status) &&
        typeof parsed.summary === 'string'
        ? {
            kind: 'status',
            terminalId: parsed.terminalId,
            status: parsed.status as AgentStatus,
            summary: parsed.summary,
          }
        : null

    default:
      return null
  }
}
