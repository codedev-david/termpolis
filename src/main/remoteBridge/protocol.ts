import type { AgentStatus } from '../../shared/agentStatusDetector'

/** Capabilities a paired device may be granted. Each is opt-in, default false. */
export interface Capabilities {
  /** List terminals and read their output. */
  read: boolean
  /** Create a new AI terminal. Commands go through sanitizeAgentCommand. */
  createTerminal: boolean
  /** Type into an EXISTING terminal. Bypasses the command allowlist entirely —
   *  see spec §4.5. Off until explicitly granted. */
  writeToTerminal: boolean
  /** Close a terminal. */
  closeTerminal: boolean
}

export const NO_CAPABILITIES: Capabilities = {
  read: false,
  createTerminal: false,
  writeToTerminal: false,
  closeTerminal: false,
}

/** A device the user has paired and not revoked. */
export interface PairedDevice {
  /** Stable id, derived from the device public key. */
  id: string
  /** Human label shown in Settings, supplied by the device at pairing. */
  label: string
  /** X25519 public key, hex. */
  publicKey: string
  /** The relay room this device dials, minted with the pairing offer.
   *
   *  Stored on the device rather than regenerated, so a desktop restart re-dials
   *  the room the phone is already waiting in instead of requiring a re-pair. */
  pairingId: string
  capabilities: Capabilities
  pairedAt: number
  lastSeenAt: number
}

/** Requests a remote device may send. */
export type RemoteRequest =
  | { kind: 'listTerminals' }
  | { kind: 'createTerminal'; name: string; cwd?: string }
  | { kind: 'runCommand'; terminalId: string; command: string }
  | { kind: 'writeToTerminal'; terminalId: string; text: string }
  | { kind: 'closeTerminal'; terminalId: string }
  | { kind: 'subscribe'; terminalId: string }
  | { kind: 'unsubscribe'; terminalId: string }

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

/** Terminal output, batched.
 *
 *  Many chunks per frame rather than one frame per chunk: the relay bills per
 *  frame and allows a burst of 40, so a frame per echoed keystroke would spend
 *  the whole burst on ordinary typing. */
export interface OutputPayload {
  kind: 'output'
  chunks: OutputChunk[]
}

/** What `onRequest` returns: an answer to exactly one envelope. */
export type RemoteResponse =
  | { kind: 'ok'; id: number; data: unknown }
  | { kind: 'error'; id: number; message: string }

/** Everything the desktop may put on the wire, answers and pushes alike. The
 *  phone switches on `kind` over exactly this union.
 *
 *  Kept as one type because two shapes behind a single discriminator is not a
 *  style problem -- it is a renderer that silently shows nothing. `RemoteResponse`
 *  used to declare an `output` variant with a `chunk` field that nothing
 *  constructed, while the bridge actually sent an `OutputPayload` with `chunks`.
 *  A phone reading `.chunk` off that would have got `undefined` for every field,
 *  with no error anywhere. */
export type RemoteMessage =
  | RemoteResponse
  | OutputPayload
  | { kind: 'status'; terminalId: string; status: AgentStatus; summary: string }

/** Envelope carrying a request with its correlation id. */
export interface RemoteEnvelope {
  id: number
  request: RemoteRequest
}

/** Messages main sends down to the bridge process. */
/** One read of a terminal's output stream, as `readOutputFrom` in main produces it. */
export interface OutputSlice {
  output: string
  nextOffset: number
  /** Chars evicted before the reader got to them. Non-zero means output is gone. */
  missed: number
}

export type HostToBridge =
  | { kind: 'init'; mcpPort: number; mcpToken: string; identitySecretKey: string; devices: PairedDevice[] }
  | { kind: 'beginPairing'; label: string }
  | { kind: 'cancelPairing' }
  | { kind: 'revokeDevice'; deviceId: string }
  | { kind: 'setCapabilities'; deviceId: string; capabilities: Capabilities }
  // PTY output, pushed down from main. Main already owns the rolling window and the
  // per-terminal offsets (terminalOutputBuffer.ts), so the bridge is handed slices
  // rather than reaching back for them -- it never touches the PTY.
  | { kind: 'terminalOutput'; terminalId: string; slice: OutputSlice }
  | { kind: 'shutdown' }

/** Messages the bridge sends up to main. */
export type BridgeToHost =
  | { kind: 'ready' }
  // No verificationPhrase: the safety number needs BOTH public keys and the
  // device's does not exist until it answers. It arrives in its own message below.
  | { kind: 'pairingCode'; qrPayload: string; expiresAt: number }
  | { kind: 'verificationPhrase'; deviceId: string; phrase: string }
  | { kind: 'paired'; device: PairedDevice }
  | { kind: 'devicesChanged'; devices: PairedDevice[] }
  | { kind: 'attachedChanged'; attachedDeviceIds: string[] }
  // Reachability, which is not the same as paired: a device stays paired while
  // the phone is in a tunnel. Settings shows the two separately.
  | { kind: 'deviceConnected'; deviceId: string }
  | { kind: 'deviceDisconnected'; deviceId: string }
  | { kind: 'error'; message: string }

/** The relay refuses -- and cuts the connection on -- any frame larger than this.
 *
 *  Mirrors `MAX_FRAME_BYTES` in `relay/src/quota.ts`. The two packages cannot
 *  share a module (one compiles for workerd, the other for Electron), so
 *  `tests/electron/remoteOutputChunker.test.ts` imports both and asserts they
 *  agree. Without that guard the drift shows up as a phone that disconnects
 *  under load, which looks like a network fault and is not.
 */
export const RELAY_MAX_FRAME_BYTES = 1_048_576

/** Which limit a peer hit, as the relay names it just before cutting it off.
 *
 *  Mirrors `QuotaLimit` in `relay/src/wire.ts`, for the reason
 *  `RELAY_MAX_FRAME_BYTES` mirrors `MAX_FRAME_BYTES`: the two packages compile for
 *  different runtimes and cannot share a module. */
export type QuotaLimit = 'frame-size' | 'frame-rate' | 'connection-bytes' | 'idle'

/** The relay's own messages -- the only frames it authors, and the only ones it
 *  reads. They arrive as JSON TEXT on the same socket as sealed payload, which is
 *  BINARY and opaque. Mirrors `ControlFrame` in `relay/src/wire.ts`.
 *
 *  `role` is `string` rather than a union: nothing here acts on it, and a relay is
 *  not trusted to be truthful about it anyway. `kind` and `hello.peer` are the
 *  only fields that change what this client does. */
export type RelayControlFrame =
  | { kind: 'hello'; role: string; peer: boolean }
  | { kind: 'peer-joined'; role: string }
  | { kind: 'peer-gone'; role: string }
  | { kind: 'quota-exceeded'; limit: QuotaLimit }
