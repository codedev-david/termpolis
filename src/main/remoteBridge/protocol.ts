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

/** Responses and pushes the bridge may send back. */
export type RemoteResponse =
  | { kind: 'ok'; id: number; data: unknown }
  | { kind: 'error'; id: number; message: string }
  | { kind: 'output'; terminalId: string; chunk: string; missed: number }
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
  | { kind: 'error'; message: string }
