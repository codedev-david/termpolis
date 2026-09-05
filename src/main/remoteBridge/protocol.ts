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
  /** The relay room this device and this desktop meet in.
   *
   *  DERIVED from the two identity keys, never announced -- see
   *  `deriveSessionRoomId`. It used to be the pairing id straight off the QR,
   *  which made the session room's address public to anyone who photographed the
   *  code: a room name is not a credential, so a stranger could take the `device`
   *  seat and leave the real phone looping on a 409 with nothing to show the user.
   *  Neither the offer's TTL nor its single-use flag touches that, because the
   *  exposure is the NAME and the name outlived the secret.
   *
   *  Stored rather than recomputed only so the registry is self-describing; both
   *  ends can derive it at any time from keys they already hold, which is what
   *  lets a desktop restart re-dial the room the phone is still waiting in. */
  sessionRoomId: string
  capabilities: Capabilities
  pairedAt: number
  lastSeenAt: number
}

/** Requests a remote device may send. */
export type RemoteRequest =
  // Needs no grant, and deliberately has no case in `requiredCapability`: it is
  // answered above the dispatcher in `entry.ts`. A device granted nothing must
  // still be able to learn that, or the only way for a phone to discover a
  // missing capability is to attempt the action and read the refusal -- which
  // means showing a button that errors. Keeping it out of the policy means that
  // if that interception is ever lost, the policy's default arm refuses it
  // rather than waving an ungranted kind through.
  | { kind: 'getCapabilities' }
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
  // Pushed when the user changes the grants in Settings, not only answered on
  // request. Same reason the fan-out is dropped on the same edit: a toggle the
  // phone learns about only on its next attempt leaves the two screens
  // disagreeing about what this device is allowed to do.
  | { kind: 'capabilities'; capabilities: Capabilities }

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
  // Agent status, derived in main from the same rolling buffer the slices come
  // from. It is computed there rather than here because the detector needs the
  // WINDOW and the bridge is only ever handed increments -- and because the
  // terminal's name, which the detector keys several of its rules off, lives in
  // main's session record and nowhere the bridge can see.
  | { kind: 'terminalStatus'; terminalId: string; status: AgentStatus; summary: string }
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
  // Which terminals at least one phone is watching. Main pumps PTY output for
  // exactly this set: without it main would either serialise every terminal
  // across the process boundary or none of them, and the bridge is the only
  // side that knows which a device actually subscribed to.
  | { kind: 'subscriptionsChanged'; terminalIds: string[] }
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

/** How long a paired phone may go unseen before the desktop forgets it.
 *
 *  The design promises that "idle pairings auto-expire", and a pairing that
 *  never expires is a key that outlives the phone it was minted for -- a lost
 *  handset stays authorised until somebody remembers to revoke it. Thirty days
 *  is long enough that a holiday does not cost the user a re-pair, and short
 *  enough that a drawer full of old phones does not accumulate access.
 *
 *  Counted from `lastSeenAt`, which the bridge advances on every request a
 *  device makes. */
export const DEVICE_IDLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000

/** How often the bridge looks for devices that have aged out.
 *
 *  Six hours, not six seconds: expiry is measured in days, and a sweep is only
 *  ever going to find something at the granularity the thing it sweeps for
 *  changes. The bridge also sweeps once at startup, which is what catches a
 *  desktop that was closed for the whole of a device's idle window. */
export const DEVICE_EXPIRY_SWEEP_MS = 6 * 60 * 60 * 1000

/** How stale `lastSeenAt` may get before the bridge tells main about it.
 *
 *  Every request a phone makes advances the timestamp, and announcing each one
 *  would rewrite `remote-devices.json` per keystroke. Settings rounds the column
 *  to the minute and redraws it on a one-minute tick, so anything finer than
 *  this could not be seen even if it were sent. */
export const SEEN_ANNOUNCE_INTERVAL_MS = 60_000

/** Where a desktop dials when the user has not named a relay of their own.
 *
 *  `wss:` and not `ws:`. Every frame that crosses it is already sealed end to
 *  end, so plaintext transport would not leak a keystroke -- but it would expose
 *  the room ids to any middlebox on the path, which is enough to map who talks to
 *  whom and when. It also makes the app's default traffic look strippable.
 *
 *  Lives here rather than in `remoteSettings` so the bridge child -- which reads
 *  it out of `TERMPOLIS_RELAY_URL` and must have a fallback -- and main agree by
 *  construction instead of by two matching string literals. */
export const DEFAULT_RELAY_URL = 'wss://relay.termpolis.com'

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
