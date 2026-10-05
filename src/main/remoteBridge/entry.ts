import { createHash } from 'crypto'
import { DeviceRegistry } from './deviceRegistry'
import { RequestDispatcher } from './dispatcher'
import { OutputFanout, type DrainedChunk } from './outputFanout'
import { ScreenFlattener } from './screenFlattener'
import { LocalMcpClient } from './mcpClient'
import { localDesktopName } from './desktopName'
import {
  createPairingOffer,
  openPairingAck,
  openPairingHello,
  sealPairingAck,
  sealPairingHello,
  PairingSession,
  type PairingOffer,
} from './pairing'
import { chunkOutbound, MAX_PAYLOAD_BYTES } from './outputChunker'
import { RelayClient, type RelayClientDeps, type RelayState } from './relayClient'
import { Handshake, deriveSessionRoomId } from './sessionCrypto'
import { deriveVerificationPhrase, fromHex, toHex } from './sealedChannel'
import {
  LINK_OFFER_TTL_MS,
  encodeLinkCode,
  isBridgeLink,
  isLinkRelayUrl,
  parseLinkCode,
} from './linkCode'
import { CapabilityError } from './remotePolicy'
import {
  DEFAULT_RELAY_URL,
  DEVICE_EXPIRY_SWEEP_MS,
  DEVICE_IDLE_EXPIRY_MS,
  MAX_LINKED_MACHINES,
  NO_CAPABILITIES,
  SEEN_ANNOUNCE_INTERVAL_MS,
  isPeerKind,
} from './protocol'
import { sanitizeDeviceLabel } from './deviceLabel'
import { x25519 } from '@noble/curves/ed25519.js'
import type { AgentStatus } from '../../shared/agentStatusDetector'
import type {
  BridgeLink,
  BridgeToHost,
  Capabilities,
  HostToBridge,
  LinkTarget,
  PairedDevice,
  PeerRequest,
  RemoteEnvelope,
  RemoteResponse,
} from './protocol'

// The protocol surface, re-exported so the built bundle is a complete, self-describing
// module. `scripts/remote-test-client.cjs` stands in for the phone and needs to mint an
// identity, seal frames and render a safety number; the Expo client will need exactly
// the same three. Neither should reimplement the crypto to talk to this bridge.
export { generateIdentity, deriveVerificationPhrase } from './sealedChannel'
export { Handshake, SealedSession, deriveSessionRoomId, FRAME_SESSION } from './sessionCrypto'
// The phone's half of pairing. `sealPairingHello` and `openPairingAck` are never
// called on this side; they are exported so the CLI client -- and after it the
// Expo client -- can speak the pairing wire without reimplementing it, which is
// the only way the two halves stay in step.
export { sealPairingHello, openPairingAck, openPairingHello, sealPairingAck } from './pairing'
export { NO_CAPABILITIES } from './protocol'
export type { Capabilities, PairedDevice, RemoteRequest, RemoteResponse } from './protocol'

interface McpLike {
  callTool(name: string, args: Record<string, unknown>, deviceId: string): Promise<unknown>
}

/** What the bridge needs from a relay room. Narrower than `RelayClient` so a
 *  test can stand one in without a socket, and so nothing here reaches for
 *  reconnect internals that are the client's own business. */
export interface RelayLike {
  start(): void
  send(payload: unknown): void
  /** Write a frame already sealed by the caller. Only pairing uses it: its frames
   *  are sealed under a root derived from the QR, not under a session the relay
   *  client owns. */
  sendFrame(frame: Uint8Array): void
  /** Ask the other end something over the session and wait for its answer.
   *  Optional so a room that only ever answers -- every phone room, and every
   *  stub a test stands in -- need not implement it; a room without it is a
   *  room nothing can be asked through, and a linked call reports it offline. */
  request?(request: unknown, timeoutMs: number): Promise<unknown>
  stop(): void
  readonly state: RelayState
}

// ── Linked machines ──────────────────────────────────────────────────────────

/** How long a join waits for the host's answer. Shorter than the link offer's
 *  five minutes on purpose: the code is already on the other screen when it is
 *  entered here, so a minute of silence means it is not being shown any more. */
export const JOIN_TIMEOUT_MS = 60_000

/** How long a linked request may wait on main before it is answered for it. */
export const PEER_CALL_TIMEOUT_MS = 30_000

/** A `peerResult` is a long-poll: main holds it up to `waitMs`, so the bridge
 *  waits that long plus this, for the job's answer to reach it. */
export const PEER_RESULT_GRACE_MS = 15_000

/** The longest a `peerResult` may ask main to hold it. */
export const MAX_PEER_WAIT_MS = 50_000

/** The longest main may ask a linked call to wait. Bounded because a timer past
 *  2^31 - 1 ms fires at once, and nothing a link does takes ten minutes to answer. */
export const MAX_LINK_CALL_TIMEOUT_MS = 10 * 60_000

/** What every refusal of a kind outside the allowed set reads -- the same words
 *  the policy uses for a phone, so a desktop peer and a phone are refused alike. */
const UNRECOGNISED_KIND = new CapabilityError(null).message

const LINK_CODE_FOR_COMPUTER = 'That code is for linking another computer, not a phone.'
const PHONE_CODE_NOT_LINK =
  'That code is for a phone. Create a code under Settings ▸ Linked machines.'
const LINKED_OFF = 'Linked machines is off. Switch it on under Settings ▸ Linked machines first.'
const PHONES_OFF = 'Phone pairing is off. Switch on "Allow phones to connect" first.'
const LINK_CAP = `This computer already has ${MAX_LINKED_MACHINES} linked machines. Unlink one before linking another.`
const LINK_RELAY_UNENCRYPTED =
  'Linked machines needs an encrypted relay (wss://). Change the relay under Settings ▸ Remote.'
const JOIN_NOT_A_CODE =
  'That is not a link code. Copy the whole code from Settings ▸ Linked machines on the other computer.'
const JOIN_OWN_CODE = 'That code was made on this computer. Enter it on the other one.'
const JOIN_BAD_KEY = 'This computer could not make a key for the link. Try again.'
const JOIN_PEER_GONE = 'The other computer stopped showing that code.'
const JOIN_TIMED_OUT =
  'No answer. Check the code is still showing under Settings ▸ Linked machines on the other computer.'
const JOIN_BAD_ACK =
  'The other computer answered for a different key than this one sent. Create a new code and try again.'

const SECRET_KEY_RE = /^[0-9a-f]{64}$/

/** A request kind narrowed to the linked set. A sealed frame proves who sent
 *  it, not that the sender spoke this version, so this asks rather than assumes. */
function isPeerRequest(request: { kind: unknown }): request is PeerRequest {
  return isPeerKind(request.kind)
}

/** How long main may take over one inbound linked request. */
function mainTimeout(request: PeerRequest): number {
  if (request.kind !== 'peerResult') return PEER_CALL_TIMEOUT_MS
  // `waitMs` arrived over the relay. Anything that is not a finite number means
  // "do not hold it", and the hold is capped where the spec caps it.
  const wait: unknown = request.waitMs
  const held =
    typeof wait === 'number' && Number.isFinite(wait) ? Math.min(Math.max(wait, 0), MAX_PEER_WAIT_MS) : 0
  return held + PEER_RESULT_GRACE_MS
}

/** How long one outbound linked call may wait for its answer. */
function callTimeout(timeoutMs: unknown): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, MAX_LINK_CALL_TIMEOUT_MS)
    : PEER_CALL_TIMEOUT_MS
}

/** Whether two records name the same room with the same keys. A link whose
 *  record changed under the same id is a different room, not the same one. */
function sameLink(a: BridgeLink, b: BridgeLink): boolean {
  return (
    a.hostPublicKey === b.hostPublicKey &&
    a.relayUrl === b.relayUrl &&
    a.sessionRoomId === b.sessionRoomId &&
    a.secretKey === b.secretKey
  )
}

/** Run something once the answer now being returned has been sent.
 *
 *  A goodbye is answered and THEN acted on: closing the room first would close
 *  the socket the answer has to leave by. The answer goes out in the microtask
 *  after the handler returns, and a timer runs after every microtask. */
function afterAnswering(fn: () => void): void {
  setTimeout(fn, 0)
}

export interface BridgeCoreDeps {
  send(msg: BridgeToHost): void
  /** Injected in tests; built from init params in production. */
  mcp?: McpLike
  relayUrl: string
  /** Injected in tests; production dials the real relay. */
  openRelay?(deps: RelayClientDeps): RelayLike
  /** Injected in tests; production emulates with xterm. */
  flattener?: FlattenerLike
  /** What the phone will call this machine in its list of paired desktops.
   *  Injected in tests; production reads the hostname. Resolved once at
   *  construction rather than per pairing, so a syscall cannot fail on the one
   *  code path where a phone is waiting. */
  desktopName?: string
}

/** The part of ScreenFlattener this file uses. Named so a test can stand in for
 *  a real emulator -- there is no input that makes xterm throw on demand, and the
 *  handler's promise chain has to survive one that does. */
export type FlattenerLike = Pick<ScreenFlattener, 'feed' | 'snapshot' | 'forget' | 'forgetAll'>

export interface BridgeCore {
  handleHostMessage(msg: HostToBridge): void
  handleRemoteRequest(deviceId: string, env: RemoteEnvelope): Promise<RemoteResponse>
  acceptPairing(input: {
    oneTimeSecret: string
    devicePublicKey: string
    label: string
    capabilities?: Capabilities
    now?: number
  }): { device: PairedDevice; verificationPhrase: string }
  /** Pull everything queued for one device. Destructive -- see the implementation. */
  drainOutput(deviceId: string): DrainedChunk[]
  /** Resolves once every terminal chunk handed over so far has been flattened and
   *  fanned out.
   *
   *  `handleHostMessage` stays synchronous because the host's port has no use for
   *  a promise, but flattening is not: a chunk is queued behind the emulator write
   *  that produced it. Anything that needs to observe the fan-out after feeding
   *  output -- shutdown, and every test that drains -- has to wait for that, and
   *  the only alternative is polling a queue that may legitimately stay empty. */
  settled(): Promise<void>
}

export function createBridgeCore(deps: BridgeCoreDeps): BridgeCore {
  const desktopName = deps.desktopName ?? localDesktopName()
  let registry = new DeviceRegistry()
  let dispatcher: RequestDispatcher | null = null
  let pairing: PairingSession | null = null
  let publicKey = ''
  /** The label the desktop user typed for the offer currently open. Held here
   *  rather than on the offer because the offer is minted before the device
   *  exists, and it is the device row this name ends up on. */
  let requestedLabel = ''
  /** What the user granted before showing the QR, held for the one pairing it
   *  belongs to.
   *
   *  A phone paired with nothing granted looks broken from the phone's side: it
   *  attaches, asks for the terminal list, and is refused -- which reads as "this
   *  app cannot see my terminals" rather than "you have not said it may". The
   *  grant travels with the offer so the device is never in that state at all,
   *  instead of being granted a moment later by a follow-up the phone may already
   *  have raced. Reset with every offer: a grant chosen for one pairing is not
   *  consent for the next one. */
  let requestedCapabilities: Capabilities = { ...NO_CAPABILITIES }
  /** Whether the offer currently open is for a phone or for another computer.
   *  Reset with every offer, like the grant: it decides which hello the offer
   *  takes, and what the device it makes may ask. */
  let requestedKind: 'phone' | 'desktop' = 'phone'
  /** Which kinds of room this bridge opens, from `init`. Phones default on and
   *  links default off, so an init written before linked machines existed means
   *  exactly what it meant then -- and turning on one feature never opens the
   *  other's rooms. */
  let phonesEnabled = true
  let linkedEnabled = false
  /** One room per link this machine JOINED, keyed by link id. Kept apart from
   *  `rooms` because this end sits in the DEVICE seat here, holds a per-link key
   *  instead of the identity, and serves nothing but `peer*` -- and so that the
   *  output pump, which walks `rooms`, never drains a phone's queue into one. */
  const linkRooms = new Map<string, { link: BridgeLink; client: RelayLike; attached: boolean }>()
  /** The join in progress, if any: its pairing room and the timer that gives up
   *  on it. One at a time -- a second join replaces the first. */
  let joining: { room: RelayLike; timer: ReturnType<typeof setTimeout> } | null = null
  /** Linked requests handed to main and not yet answered, by call id. */
  const peerCalls = new Map<
    string,
    { resolve(data: unknown): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  let peerCallSeq = 0
  /** Per device, the `lastSeenAt` main was last told about. Throttles the
   *  announcement; see `noteSeen`. */
  const announcedSeenAt = new Map<string, number>()
  let expirySweep: ReturnType<typeof setInterval> | null = null
  let identitySecretKey = ''
  const fanout = new OutputFanout()
  /** Keeps a real terminal grid per watched terminal so the phone does not have
   *  to. See screenFlattener.ts for why the phone cannot. */
  const flattener: FlattenerLike = deps.flattener ?? new ScreenFlattener()
  /** Serialises flattening. Terminal bytes only mean anything in order, and
   *  xterm's write completes asynchronously, so overlapping two writes to one
   *  grid would interleave them. One chain is enough: it preserves order within
   *  every terminal, which is the only order that matters. */
  let flattening: Promise<void> = Promise.resolve()
  /** The last status main reported for each watched terminal.
   *
   *  Kept because a status frame is a fact about the present, not an entry in a
   *  queue: a phone that was offline when it was sent has missed it, and main
   *  will not send it again until the answer CHANGES. Replaying the remembered
   *  one on subscribe is what stops a reconnecting phone from showing a blank
   *  label under a terminal that has been sitting in the same state for an hour.
   *
   *  Bounded by pruning against the fan-out's watched set on every status
   *  message: the bridge is never told a terminal closed, so nothing else would
   *  ever remove an entry. */
  const lastStatus = new Map<string, { status: AgentStatus; summary: string }>()

  /** One relay room per paired device, keyed by device id.
   *
   *  Per DEVICE, not per desktop: a pairing IS a desktop-device pair, so the
   *  relay never multiplexes and never learns how many devices a user has beyond
   *  the rooms it happens to hold. It also means revoking one device closes
   *  exactly one socket and cannot disturb the others. */
  const rooms = new Map<string, { client: RelayLike; roomId: string }>()

  /** The room named by the QR currently on screen, if there is one.
   *
   *  Separate from `rooms` because it is a different KIND of room: named in the
   *  clear, held for ninety seconds, and carrying frames that no session opens.
   *  Keeping it out of `rooms` is also what stops the output pump from ever
   *  draining a device's queue into it. */
  let pairingRoom: RelayLike | null = null
  let pairingTimer: ReturnType<typeof setTimeout> | null = null

  /** Tell main something went wrong. `link` marks it as Linked machines' to
   *  show (`scope` on the error, protocol.ts), so it never reaches the phone
   *  pane; an error about a phone is the same unmarked message it always was. */
  function report(message: string, link = false): void {
    deps.send(link ? { kind: 'error', message, scope: 'link' } : { kind: 'error', message })
  }

  function closePairingRoom(): void {
    if (pairingTimer) clearTimeout(pairingTimer)
    pairingTimer = null
    pairingRoom?.stop()
    pairingRoom = null
  }

  /** Sit in the QR's room and wait for a phone to speak first.
   *
   *  The desktop cannot greet here: a greeting is a handshake against an identity
   *  key, and learning the phone's key is what this room is FOR. So the phone
   *  opens, sealed under a root both ends derive from the QR. */
  function openPairingRoom(offer: PairingOffer): void {
    closePairingRoom()
    // Fixed for this room's life: it holds this offer, of this kind, and no other.
    const link = requestedKind === 'desktop'
    const open = deps.openRelay ?? ((d: RelayClientDeps) => new RelayClient(d))
    pairingRoom = open({
      url: deps.relayUrl,
      roomId: offer.pairingId,
      mode: 'pairing',
      onFrame: (frame) => onPairingFrame(offer, frame),
      // Nothing to report: this room's states are about a QR the user is already
      // looking at, and `deviceConnected` for a device that does not exist yet
      // would light the Settings indicator for nobody.
      onStateChange: () => {},
      onQuota: (limit) => report(`relay closed the pairing connection: ${limit}`, link),
    })
    // The offer outlives its usefulness by exactly its TTL, and an abandoned QR
    // would otherwise hold a socket -- keepalived every two minutes -- for as long
    // as the app runs.
    pairingTimer = setTimeout(closePairingRoom, Math.max(0, offer.expiresAt - Date.now()))
    pairingRoom.start()
  }

  function onPairingFrame(offer: PairingOffer, frame: Uint8Array): void {
    let hello: ReturnType<typeof openPairingHello>
    try {
      hello = openPairingHello({
        desktopSecretKey: identitySecretKey,
        pairingId: offer.pairingId,
        frame,
      })
    } catch {
      // The room's name is on screen, so anything at all can arrive in it. A frame
      // that does not open is the ordinary noise of a public room name -- reporting
      // each one would train the user to ignore the report that matters, and
      // closing on one would let a photographed QR deny pairing outright.
      return
    }

    // The kind of code must match the kind of sender, both ways. The marker is
    // sealed, so it is the sender's own word for what it is -- and it is checked
    // BEFORE the secret, so a sender of the wrong kind never spends the offer:
    // the room stays open and the right machine can still finish. Reported,
    // because the user is looking at this code and wondering why nothing happens.
    const link = requestedKind === 'desktop'
    if (link && hello.peer !== 'desktop') {
      report(LINK_CODE_FOR_COMPUTER, true)
      return
    }
    // The PHONE code's error, shown with the QR it is about.
    if (!link && hello.peer === 'desktop') {
      report(PHONE_CODE_NOT_LINK)
      return
    }
    // Checked again here, not only when the code was made: a join can finish
    // inside the five minutes this code is on screen.
    if (link && linkCount() >= MAX_LINKED_MACHINES) {
      report(LINK_CAP, true)
      return
    }

    let result: { device: PairedDevice; verificationPhrase: string }
    try {
      result = acceptPairing({
        oneTimeSecret: hello.oneTimeSecret,
        devicePublicKey: hello.devicePublicKey,
        // The name the user chose wins; the phone's own name is the fallback for
        // a user who left the field empty. Both are cleaned, because both end up
        // in `remote-devices.json` and in the device list -- and the phone's
        // arrives over the relay, so its length and its bytes are the sender's
        // choice entirely. Unsanitised, a paired phone could park an escape
        // sequence or a few kilobytes of text in the desktop's settings file.
        label:
          requestedLabel || sanitizeDeviceLabel(hello.label) || (link ? 'Linked computer' : 'Phone'),
        capabilities: requestedCapabilities,
      })
    } catch (err) {
      // This one IS worth surfacing: the frame opened, so the sender had the QR's
      // pairing id and public key but not its secret. The offer survives a refusal,
      // so the room stays open and the real phone can still finish.
      report(`pairing failed: ${(err as Error).message}`, link)
      return
    }

    // Ack first, close second. `acceptPairing` has already seated this desktop in
    // the session room, so by the time the phone reads this and follows, there is
    // someone there to meet it -- a frame into an empty relay room is dropped
    // rather than queued.
    pairingRoom?.sendFrame(
      sealPairingAck({
        desktopSecretKey: identitySecretKey,
        devicePublicKey: result.device.publicKey,
        pairingId: offer.pairingId,
        deviceId: result.device.id,
        name: desktopName,
      }),
    )
    closePairingRoom()
  }

  function openRoom(dev: PairedDevice): void {
    const current = rooms.get(dev.id)
    // A device id is a hash of the phone's public key, and so is the session room,
    // so re-pairing the same phone lands on the same room and the live socket is
    // left alone. A phone that re-pairs with a NEW keypair is a different room --
    // the old one leads nowhere, and holding it is a re-pair that never connects.
    if (current) {
      if (current.roomId === dev.sessionRoomId) return
      closeRoom(dev.id)
    }
    const open = deps.openRelay ?? ((d: RelayClientDeps) => new RelayClient(d))
    const client = open({
      url: deps.relayUrl,
      roomId: dev.sessionRoomId,
      // A factory, so every dial gets a fresh ephemeral key and therefore a fresh
      // session key. That is what makes per-connection counters sound: they may
      // start at zero on each connection precisely because the key they count
      // under is new. The old single long-lived channel had counters that reset
      // the same way over a key that did NOT change, so a recorded session
      // replayed verbatim after any bridge restart.
      handshake: () =>
        new Handshake({
          ownSecretKey: identitySecretKey,
          peerPublicKey: dev.publicKey,
          role: 'desktop',
        }),
      onRequest: (env) => handleRemoteRequest(dev.id, env),
      onStateChange: (state) => onRoomState(dev.id, state),
      // Reported, not swallowed. A quota cut is the relay saying this desktop is
      // the problem, and for `frame-size`/`frame-rate` the client also stops
      // redialing -- so without this the room goes quiet permanently and the only
      // symptom the user gets is a phone that stopped working. A linked
      // computer's cut is Linked machines' to show, not the phone pane's.
      onQuota: (limit) => report(`relay closed the ${dev.label} connection: ${limit}`, dev.kind === 'desktop'),
    })
    rooms.set(dev.id, { client, roomId: dev.sessionRoomId })
    client.start()
  }

  function closeRoom(deviceId: string): void {
    rooms.get(deviceId)?.client.stop()
    rooms.delete(deviceId)
  }

  /** Whether a paired device's room may open, by the switch for its kind. */
  function roomAllowed(dev: PairedDevice): boolean {
    return dev.kind === 'desktop' ? linkedEnabled : phonesEnabled
  }

  /** Linked machines, hosted and joined together -- what the cap counts. */
  function linkCount(): number {
    return registry.list().filter((d) => d.kind === 'desktop').length + linkRooms.size
  }

  /** Dial the room of a link this machine joined.
   *
   *  The DEVICE seat, with the link's own keypair: this end is the one that
   *  entered the code, so it sits where a phone would. Same greeting rule and
   *  the same fresh-handshake-per-dial factory as a phone room. */
  function openLinkRoom(link: BridgeLink): void {
    const open = deps.openRelay ?? ((d: RelayClientDeps) => new RelayClient(d))
    const client = open({
      url: link.relayUrl,
      roomId: link.sessionRoomId,
      role: 'device',
      handshake: () =>
        new Handshake({
          ownSecretKey: link.secretKey,
          peerPublicKey: link.hostPublicKey,
          role: 'device',
        }),
      onRequest: (env) => handleLinkRequest(link.id, env),
      onStateChange: (state) => onLinkState(link.id, state),
      onQuota: (limit) => report(`relay closed a linked machine connection: ${limit}`, true),
    })
    linkRooms.set(link.id, { link, client, attached: false })
    client.start()
  }

  /** Stop first, forget second: a room that was attached reports going offline
   *  on its way out, so main is not left believing a link it removed is up. */
  function closeLinkRoom(id: string): void {
    const entry = linkRooms.get(id)
    if (!entry) return
    entry.client.stop()
    linkRooms.delete(id)
  }

  /** Tell main when a joined link starts or stops being reachable -- on the
   *  change only. `online` is not reachable: it is a seat in a room the other
   *  machine is not in. */
  function onLinkState(id: string, state: RelayState): void {
    const entry = linkRooms.get(id)
    if (!entry) return
    const attached = state === 'attached'
    if (attached === entry.attached) return
    entry.attached = attached
    deps.send({ kind: 'linkStateChanged', id, attached })
  }

  /** Bring the joined-link rooms in line with the list main holds.
   *
   *  A diff, not a rebuild: closing a live room to reopen the same one would
   *  drop a session that had nothing wrong with it, and cost both machines a
   *  handshake for nothing. Records that are not safe to dial are refused here,
   *  where a bad key is an error message rather than an exception inside a
   *  socket handler. Nothing opens while linked machines is off. */
  function applyLinks(next: BridgeLink[]): void {
    const wanted = new Map<string, BridgeLink>()
    for (const link of linkedEnabled ? next : []) {
      if (isBridgeLink(link)) wanted.set(link.id, link)
      else report('a linked machine record is malformed and was skipped', true)
    }
    for (const [id, entry] of [...linkRooms]) {
      const want = wanted.get(id)
      if (!want || !sameLink(want, entry.link)) closeLinkRoom(id)
    }
    for (const link of wanted.values()) if (!linkRooms.has(link.id)) openLinkRoom(link)
  }

  /** The room a linked call goes out through, if there is one to use.
   *
   *  A hosted computer is reached through its device room -- but only a device
   *  that IS a computer: a phone is never sent a `peer*` request, whatever main
   *  asks for. */
  function linkClient(target: LinkTarget): RelayLike | undefined {
    if (target?.via === 'device') {
      return registry.get(target.id)?.kind === 'desktop' ? rooms.get(target.id)?.client : undefined
    }
    if (target?.via === 'link') return linkRooms.get(target.id)?.client
    return undefined
  }

  /** Hand one inbound linked request to main and wait for its answer.
   *
   *  The bridge is transport and main is policy: names, grants, confirmation and
   *  the jobs themselves all live there. Bounded, so a main that never answers
   *  costs the asker a refusal rather than a request that hangs forever. */
  function askMain(from: LinkTarget, request: PeerRequest): Promise<unknown> {
    const callId = `peer-${++peerCallSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Removed first, so a reply that arrives a moment later finds nothing.
        peerCalls.delete(callId)
        reject(new Error('timed out'))
      }, mainTimeout(request))
      peerCalls.set(callId, { resolve, reject, timer })
      deps.send({ kind: 'peerRequest', callId, from, request })
    })
  }

  async function forwardToMain(from: LinkTarget, request: PeerRequest, id: number): Promise<RemoteResponse> {
    try {
      return { kind: 'ok', id, data: await askMain(from, request) }
    } catch (err) {
      return { kind: 'error', id, message: (err as Error).message }
    }
  }

  /** A request from a computer this machine HOSTS.
   *
   *  The `peer*` set and nothing else (spec §4.4). A computer is paired with no
   *  phone capabilities, but this does not rest on that: a grant set on it by
   *  mistake still could not reach a terminal, because no phone kind gets past
   *  here at all. */
  async function handleHostedPeer(device: PairedDevice, env: RemoteEnvelope): Promise<RemoteResponse> {
    const request = env.request as { kind: unknown }
    if (!isPeerRequest(request)) return { kind: 'error', id: env.id, message: UNRECOGNISED_KIND }
    if (request.kind === 'peerBye') {
      // The other machine unlinked this one. Revoked exactly as a phone's
      // `unpair` is -- the sender and only the sender, by the id its sealed
      // session proves, never by anything in the payload. Unlike `unpair`, the
      // room is closed too, once the answer is out: the other end has thrown
      // its key away, so this seat would otherwise wait in an empty room for
      // as long as the app runs. Nothing to drop from the fan-out: a computer
      // can never subscribe, since no phone kind gets past this function.
      registry.revoke(device.id)
      announcedSeenAt.delete(device.id)
      announceDevices()
      afterAnswering(() => {
        closeRoom(device.id)
        deps.send({ kind: 'linkBye', from: { via: 'device', id: device.id } })
      })
      return { kind: 'ok', id: env.id, data: null }
    }
    noteSeen(device)
    return forwardToMain({ via: 'device', id: device.id }, request, env.id)
  }

  /** A request from the computer that hosts a link this machine JOINED. Same
   *  rule: `peer*` only. */
  async function handleLinkRequest(linkId: string, env: RemoteEnvelope): Promise<RemoteResponse> {
    if (!linkRooms.has(linkId)) return { kind: 'error', id: env.id, message: 'unknown or removed link' }
    const request = env.request as { kind: unknown }
    if (!isPeerRequest(request)) return { kind: 'error', id: env.id, message: UNRECOGNISED_KIND }
    if (request.kind === 'peerBye') {
      // Answered, then acted on. Main drops its record when it hears `linkBye`
      // and hands down a link list without this one; the room is closed here
      // already so nothing more is served on it in between.
      afterAnswering(() => {
        closeLinkRoom(linkId)
        deps.send({ kind: 'linkBye', from: { via: 'link', id: linkId } })
      })
      return { kind: 'ok', id: env.id, data: null }
    }
    return forwardToMain({ via: 'link', id: linkId }, request, env.id)
  }

  /** Send one request to a linked machine for main, and answer with the outcome.
   *
   *  Offline is answered AT ONCE when there is no attached room: the relay is a
   *  rendezvous, not a mailbox, so a request into a room the other machine is
   *  not in is dropped -- waiting out a timeout for it would only tell an agent
   *  the machine is slow when it is not there at all. */
  async function linkCall(msg: Extract<HostToBridge, { kind: 'linkCall' }>): Promise<void> {
    // Every outcome is an answer, including a throw nobody planned for: this
    // runs detached (`void`), so anything escaping it would be an unhandled
    // rejection -- which ends the utilityProcess.
    let result: BridgeToHost
    try {
      result = { kind: 'linkCallResult', callId: msg.callId, ok: true, data: await callLinked(msg) }
    } catch (err) {
      result = { kind: 'linkCallResult', callId: msg.callId, ok: false, message: (err as Error).message }
    }
    deps.send(result)
  }

  /** The request a `linkCall` carries, sent. Throws what main is to be told. */
  function callLinked(msg: Extract<HostToBridge, { kind: 'linkCall' }>): Promise<unknown> {
    const request = msg.request as { kind?: unknown } | null
    if (typeof request !== 'object' || request === null || !isPeerKind(request.kind)) {
      throw new Error('not a linked-machine request')
    }
    const client = linkClient(msg.target)
    if (!client?.request || client.state !== 'attached') throw new Error('offline')
    return client.request(request, callTimeout(msg.timeoutMs))
  }

  function endJoin(): void {
    if (!joining) return
    clearTimeout(joining.timer)
    joining.room.stop()
    joining = null
  }

  /** Enter a link code: the joining half of pairing, which the phone does on
   *  its side (`mobile/src/net/pairingClient.ts`) and this machine now does for
   *  itself.
   *
   *  Sits in the DEVICE seat of the code's room, speaks first with a hello sealed
   *  under the code's root and marked as a computer, and waits for the host's
   *  ack. The keypair is the one main minted for this link -- never the machine
   *  identity (see `BridgeLink`). */
  function joinLink(msg: Extract<HostToBridge, { kind: 'joinLink' }>): void {
    endJoin()
    const fail = (message: string): void => deps.send({ kind: 'joinFailed', message })
    if (!linkedEnabled) return fail(LINKED_OFF)
    if (linkCount() >= MAX_LINKED_MACHINES) return fail(LINK_CAP)
    const offer = parseLinkCode(msg.code)
    if (!offer) return fail(JOIN_NOT_A_CODE)
    // The code this machine is showing, pasted into its own box. The two text
    // fields sit on one screen, so it is an easy slip -- and followed through it
    // would link this machine to itself, under its own name.
    if (offer.desktopPublicKey === publicKey) return fail(JOIN_OWN_CODE)
    // From main, and about to reach the curve library: checked, not assumed.
    if (typeof msg.secretKey !== 'string' || !SECRET_KEY_RE.test(msg.secretKey)) return fail(JOIN_BAD_KEY)

    const secretKey = msg.secretKey
    const linkPublicKey = toHex(x25519.getPublicKey(fromHex(secretKey)))
    // The id the host will settle on for this machine: the same hash it takes,
    // so an ack naming any other id is refused rather than believed.
    const expectedId = createHash('sha256').update(linkPublicKey).digest('hex').slice(0, 16)
    const label = sanitizeDeviceLabel(msg.label)
    let greeted = false

    // Every callback asks whether it still belongs to the join in progress: a
    // room that was replaced or cancelled may still deliver what was in flight.
    const current = (): boolean => joining?.room === room
    const finish = (event: BridgeToHost): void => {
      endJoin()
      deps.send(event)
    }

    const open = deps.openRelay ?? ((d: RelayClientDeps) => new RelayClient(d))
    const room: RelayLike = open({
      url: offer.relayUrl,
      roomId: offer.pairingId,
      mode: 'pairing',
      role: 'device',
      // Nothing to report: a join has one outcome, and it is `linkJoined` or
      // `joinFailed`.
      onStateChange: () => {},
      onControl: (frame) => {
        if (!current()) return
        if (frame.kind === 'peer-gone') return finish({ kind: 'joinFailed', message: JOIN_PEER_GONE })
        if (frame.kind === 'quota-exceeded') {
          return finish({
            kind: 'joinFailed',
            message: `The relay refused the connection (${frame.limit}).`,
          })
        }
        // Speak only into a room the host is in -- a frame into an empty room is
        // dropped -- and only once.
        const hostPresent = frame.kind === 'peer-joined' || (frame.kind === 'hello' && frame.peer)
        if (!hostPresent || greeted) return
        greeted = true
        room.sendFrame(
          sealPairingHello({
            deviceSecretKey: secretKey,
            devicePublicKey: linkPublicKey,
            desktopPublicKey: offer.desktopPublicKey,
            pairingId: offer.pairingId,
            label,
            oneTimeSecret: offer.oneTimeSecret,
            peer: 'desktop',
          }),
        )
      },
      onFrame: (frame) => {
        if (!current()) return
        let ack: ReturnType<typeof openPairingAck>
        try {
          ack = openPairingAck({
            deviceSecretKey: secretKey,
            desktopPublicKey: offer.desktopPublicKey,
            pairingId: offer.pairingId,
            frame,
          })
        } catch {
          // Not an ack this join can open: a stray, a forgery, or noise in a
          // room whose name was on a screen. The real ack may be one frame behind.
          return
        }
        // Authentic -- only the host could seal it -- but for a different key.
        // That is a broken host, not something to wait out.
        if (ack.deviceId !== expectedId) return finish({ kind: 'joinFailed', message: JOIN_BAD_ACK })
        finish({
          kind: 'linkJoined',
          publicKey: linkPublicKey,
          hostPublicKey: offer.desktopPublicKey,
          hostName: ack.name,
          deviceId: ack.deviceId,
          // Derived, never announced, exactly as the host derives it.
          sessionRoomId: deriveSessionRoomId(secretKey, offer.desktopPublicKey),
          relayUrl: offer.relayUrl,
          phrase: deriveVerificationPhrase(linkPublicKey, offer.desktopPublicKey),
        })
      },
    })
    joining = {
      room,
      timer: setTimeout(() => finish({ kind: 'joinFailed', message: JOIN_TIMED_OUT }), JOIN_TIMEOUT_MS),
    }
    room.start()
  }

  function onRoomState(deviceId: string, state: RelayState): void {
    // `attached`, not `online`. Settings is reporting whether the PHONE is
    // reachable, and `online` means only that this desktop got a seat in an
    // otherwise empty room -- reporting that as "connected" lights the indicator
    // for a device that is not there and cannot be sent anything.
    deps.send({
      kind: state === 'attached' ? 'deviceConnected' : 'deviceDisconnected',
      deviceId,
    })
    // Attaching is the one moment a device has a backlog AND somewhere to put it.
    // Without this, output queued during an outage sits in the fan-out until the
    // next keystroke happens to flush it.
    if (state === 'attached') {
      pump(deviceId)
      // Status is not queued the way output is -- it is a fact about the present,
      // and main only re-sends it when the answer CHANGES. A phone that spent the
      // outage on a terminal screen keeps its subscription across the drop, so it
      // never re-subscribes on the way back; without this replay its status label
      // stays blank until the agent happens to move, which for an idle terminal
      // is never.
      for (const terminalId of fanout.terminalsOf(deviceId)) sendStatus(deviceId, terminalId)
    }
  }

  /** Push whatever is queued for one device, in frames the relay will accept.
   *
   *  Draining is destructive and sending is best-effort, so the state check
   *  immediately precedes the drain: a device that is not attached keeps its
   *  queue, which is the whole point of the fan-out. Output drained into a socket
   *  that dies in the microseconds after that check is lost, and that is the
   *  accepted trade -- the alternative is a second buffer shadowing the one that
   *  exists.
   *
   *  `attached` and not `online`: a seated connection with no phone in the room
   *  has no session, so every frame drained into it would be dropped unsealed --
   *  destructively, since the drain already emptied the queue. */
  function pump(deviceId: string): void {
    const room = rooms.get(deviceId)
    if (!room || room.client.state !== 'attached') return
    const chunks = fanout.drain(deviceId)
    if (chunks.length === 0) return
    // Never one frame per drain: a full queue of escape-dense output serialises
    // past the relay's 1 MiB cap, and an oversized frame is not truncated -- the
    // connection is cut.
    for (const payload of chunkOutbound(chunks, MAX_PAYLOAD_BYTES)) room.client.send(payload)
  }

  /** Send one device the remembered status of one terminal.
   *
   *  Silent when there is nothing remembered: a terminal main has not reported on
   *  yet has no status, and inventing one would put a wrong label on the phone
   *  that is indistinguishable from a right one. */
  function sendStatus(deviceId: string, terminalId: string): void {
    const known = lastStatus.get(terminalId)
    if (!known) return
    const room = rooms.get(deviceId)
    if (!room || room.client.state !== 'attached') return
    room.client.send({ kind: 'status', terminalId, status: known.status, summary: known.summary })
  }

  function announceDevices(): void {
    deps.send({ kind: 'devicesChanged', devices: registry.list() })
  }

  /** Mark a device seen, and let main know if the record has drifted far enough
   *  from what main last wrote to be worth another disk write.
   *
   *  `registry.touch` alone only ever moved a number inside this process. Main
   *  owns `remote-devices.json` and the Settings "last seen" column, and it was
   *  never told -- so a phone in daily use showed the moment it was paired,
   *  months after the fact, and every device looked equally stale on a list
   *  whose whole job is telling them apart. */
  function noteSeen(device: PairedDevice): void {
    // The record, not the id: `touch` writes through the same object `get`
    // returned, so `lastSeenAt` is the fresh stamp and is typed `number`.
    // Looking it up again would reintroduce an `undefined` this function has no
    // reachable way to receive -- both callers are past the `!device` guard.
    registry.touch(device.id)
    const seenAt = device.lastSeenAt
    if (seenAt - (announcedSeenAt.get(device.id) ?? 0) < SEEN_ANNOUNCE_INTERVAL_MS) return
    announcedSeenAt.set(device.id, seenAt)
    announceDevices()
  }

  /** Forget devices that have not been heard from inside the idle window.
   *
   *  Runs at startup and on a slow timer. Startup matters most: a desktop that
   *  was shut for six weeks has to drop those pairings before it reopens their
   *  rooms, or an expired device is briefly live again every time the app
   *  starts. */
  function expireIdleDevices(): void {
    const expired = registry.expireIdle(DEVICE_IDLE_EXPIRY_MS)
    if (expired.length === 0) return
    for (const id of expired) {
      fanout.dropDevice(id)
      closeRoom(id)
      announcedSeenAt.delete(id)
      deps.send({
        kind: 'error',
        message: `a paired phone was forgotten after ${Math.round(
          DEVICE_IDLE_EXPIRY_MS / 86_400_000,
        )} days without contact -- pair it again to reconnect`,
      })
    }
    announceDevices()
    announceSubscriptions()
  }

  /** The last set main was told about, sorted. Starts as the empty set, which is
   *  what main assumes before the first announcement -- so a core that opens
   *  with nothing subscribed correctly says nothing. */
  let announced: string[] = []

  /** Tell main which terminals are worth pumping, but only when that changes.
   *
   *  Main pumps PTY output for exactly this set. A phone re-subscribing on every
   *  reconnect is routine, and re-announcing an identical set would wake main and
   *  reset its pump for no reason -- so the comparison is on the SORTED ids
   *  rather than on insertion order, which varies with who subscribed first.
   *
   *  It is also where a terminal's emulator is let go. A terminal leaving this
   *  set has nobody left watching it, and main is about to stop reading it, so
   *  its grid would never be fed again; when a phone opens it next, main's
   *  opening read starts the screen over from the whole window anyway. Every
   *  way a watch list can empty ends here -- an unsubscribe, a revoke, an
   *  unpair, a withdrawn `read` grant, an expired pairing. Forgetting only on
   *  unsubscribe, as this once did, left the other four keeping a grid alive
   *  for a terminal nobody was watching, and the next phone to open it was sent
   *  edits against that stale grid instead of the terminal's real screen. */
  function announceSubscriptions(): void {
    const terminalIds = fanout.subscribedTerminals().sort()
    // '\u0000' as an escape, never a literal NUL: a raw one makes the whole file
    // read as binary to grep and to the code indexer, which is how it hid before
    // (v1.25.6). The separator itself is right -- it cannot occur in a uuid.
    if (terminalIds.join('\u0000') === announced.join('\u0000')) return
    for (const id of announced) if (!terminalIds.includes(id)) flattener.forget(id)
    announced = terminalIds
    deps.send({ kind: 'subscriptionsChanged', terminalIds })
  }

  /** Queue one device the screen of one terminal as it stands right now.
   *
   *  Main reads a terminal when it prints, and once more when it joins the set
   *  announced above. Neither happens when a phone opens a terminal that is
   *  ALREADY being watched -- a second phone, or the same phone back without its
   *  copy after the app was killed, re-subscribing into a subscription this
   *  process never dropped. Such a phone was sent only the next edit, measured
   *  against a screen it had never been given, so it sat blank until the
   *  terminal happened to print -- which, for an agent parked at its prompt, is
   *  when the user typed into it.
   *
   *  `fresh` is whether the device was not watching the terminal until now. It
   *  may still hold a copy from an earlier visit, anchored in a numbering that
   *  may not even exist any more, so that copy is cleared before the screen is
   *  drawn. A device that WAS watching holds this stream or nothing, and its
   *  queue still carries whatever it has not been sent; clearing would throw
   *  away the history it kept across a dropped connection, so the screen is
   *  drawn over the end of its copy instead -- which leaves a copy that is
   *  already current exactly as it was. A screen that starts at 0 replaces the
   *  copy either way (see `FORGET_FROM`): it is the whole stream, so there is no
   *  history beyond it to keep.
   *
   *  Nothing when there is no grid: no output has been flattened for the
   *  terminal since it joined the watched set, and main's opening read is
   *  already on its way to draw it for every watcher at once. */
  function resync(deviceId: string, terminalId: string, fresh: boolean): void {
    const view = flattener.snapshot(terminalId)
    if (view === null) return
    fanout.seed(deviceId, terminalId, view, fresh)
    pump(deviceId)
  }

  function handleHostMessage(msg: HostToBridge): void {
    switch (msg.kind) {
      case 'init': {
        registry = new DeviceRegistry(msg.devices)
        identitySecretKey = msg.identitySecretKey
        phonesEnabled = msg.phones !== false
        linkedEnabled = msg.linked === true
        const mcp = deps.mcp ?? new LocalMcpClient(msg.mcpPort, msg.mcpToken)
        dispatcher = new RequestDispatcher(mcp)
        publicKey = Buffer.from(
          x25519.getPublicKey(new Uint8Array(Buffer.from(msg.identitySecretKey, 'hex'))),
        ).toString('hex')
        deps.send({ kind: 'ready' })
        // Before any room opens: a pairing that aged out while the desktop was
        // closed must not come back to life for the length of one startup.
        expireIdleDevices()
        expirySweep ??= setInterval(expireIdleDevices, DEVICE_EXPIRY_SWEEP_MS)
        // Every device already paired gets its room back on start. A phone left
        // waiting overnight reconnects without the user touching either machine.
        // Each kind only while its own switch is on: Remote alone never opens a
        // linked computer's room, and Linked machines alone never opens a phone's.
        for (const dev of registry.list()) if (roomAllowed(dev)) openRoom(dev)
        applyLinks(msg.links ?? [])
        return
      }
      case 'beginPairing': {
        const link = msg.link === true
        // A code for a kind that is switched off would pair something whose room
        // this bridge then refuses to open.
        // Each refusal is marked with the kind of code it refuses, so main shows
        // it beside the button that asked for that code.
        if (link ? !linkedEnabled : !phonesEnabled) {
          report(link ? LINKED_OFF : PHONES_OFF, link)
          return
        }
        if (link && linkCount() >= MAX_LINKED_MACHINES) {
          report(LINK_CAP, true)
          return
        }
        // Remote takes a plain ws:// relay anywhere; a joining computer takes one
        // only on loopback (`isLinkRelayUrl`). A code minted over any other would
        // be refused over there as "not a link code" -- so say why here instead.
        if (link && !isLinkRelayUrl(deps.relayUrl)) {
          report(LINK_RELAY_UNENCRYPTED, true)
          return
        }
        requestedKind = link ? 'desktop' : 'phone'
        // What the user typed in Settings. It is already sanitised on the way in,
        // but this process does not get to assume that about anything it is sent.
        requestedLabel = sanitizeDeviceLabel(msg.label)
        // A computer is granted no PHONE capability, whatever arrived: what it
        // may do on this machine is main's linked grants, enforced where the job
        // runs, and its requests never reach the terminal dispatcher at all.
        requestedCapabilities = link ? { ...NO_CAPABILITIES } : { ...NO_CAPABILITIES, ...msg.capabilities }
        const offer = createPairingOffer({
          relayUrl: deps.relayUrl,
          desktopPublicKey: publicKey,
          ...(link ? { ttlMs: LINK_OFFER_TTL_MS } : {}),
        })
        pairing = new PairingSession(offer, publicKey, identitySecretKey)
        openPairingRoom(offer)
        // NO verification phrase here, deliberately. The safety number is a function
        // of BOTH public keys, and the device's key does not exist yet -- it arrives
        // with its hello. Emitting a placeholder that merely looks like a phrase is
        // worse than emitting none: the UI would render it, the user would compare
        // it against the phone, and they would be comparing a value that encodes
        // nothing about who they are actually talking to. The real phrase is sent
        // with `paired`, computed in PairingSession.accept().
        deps.send({
          kind: 'pairingCode',
          qrPayload: offer.qrPayload,
          expiresAt: offer.expiresAt,
          // The same offer, as text a person can carry to another computer.
          ...(link ? { linkCode: encodeLinkCode(offer.qrPayload) } : {}),
        })
        return
      }
      case 'cancelPairing':
        pairing = null
        closePairingRoom()
        return
      case 'revokeDevice':
        registry.revoke(msg.deviceId)
        announcedSeenAt.delete(msg.deviceId)
        fanout.dropDevice(msg.deviceId)
        // Revoking has to reach the wire. Dropping the record alone leaves a
        // socket the phone is still holding, and the next request on it would be
        // refused by the registry -- but the connection itself would persist,
        // which is not what the user asked for when they removed the device.
        closeRoom(msg.deviceId)
        announceDevices()
        announceSubscriptions()
        return
      case 'setCapabilities':
        registry.setCapabilities(msg.deviceId, msg.capabilities)
        // Subscriptions outlive the grant that created them. Withdrawing `read`
        // stops future requests at the policy check, but an ALREADY-SUBSCRIBED
        // device would keep receiving live terminal output -- the user would see
        // the capability turned off in Settings while the phone kept streaming.
        // Dropping the fan-out state is what makes the toggle mean what it says.
        if (!msg.capabilities.read) fanout.dropDevice(msg.deviceId)
        // And tell the phone, for the same reason. Its Settings screen shows the
        // grants as facts and hides the controls it has none for; a phone that
        // hears about a change only on its next attempt shows a button that
        // errors. A no-op when the device is not attached -- it re-asks on
        // every attach.
        rooms.get(msg.deviceId)?.client.send({
          kind: 'capabilities',
          capabilities: msg.capabilities,
        })
        announceDevices()
        announceSubscriptions()
        return
      case 'terminalOutput': {
        // Flatten before fanning out. What arrives here is raw terminal bytes,
        // including the cursor motion a TUI agent redraws itself with; what the
        // phone can render is text and colour. Emulating once, here, is what
        // stops a status line that ticks in place from reaching the phone as a
        // thousand separate lines of "Compacting conversation...".
        //
        // Serialised through one chain because xterm's write is asynchronous and
        // a terminal's bytes only mean anything in the order they were written.
        // `size` is the geometry these bytes were drawn for, straight from the
        // pty. Without it the emulator here guesses, and a TUI redraw replayed
        // into a grid of the wrong width lands on the wrong cells -- holes
        // punched through words, and a spinner frame settled as permanent text
        // while the real terminal is still painting over it.
        const { terminalId, slice, size, reset } = msg
        flattening = flattening
          .then(async () => {
            // Nobody is watching it. Main pumps only the announced set, but a
            // slice it read just before hearing that a terminal left is still on
            // its way here, and feeding it would plant a grid holding one stray
            // slice for a terminal nobody watches -- the grid the next phone to
            // open it would then be sent edits against. Asked when the slice's
            // turn comes rather than when it arrived, because that is when it
            // would be fed.
            if (fanout.subscribersOf(terminalId).length === 0) return
            // Main's opening read: the whole window again, from its start. Drawn
            // on top of the grid already here it would show the terminal twice,
            // so the grid starts over, and its first edit replaces everything a
            // phone holds (`replaceFrom` 0, which the fan-out turns into the
            // whole copy -- see `FORGET_FROM`).
            if (reset === true) flattener.forget(terminalId)
            const edit = await flattener.feed(terminalId, slice.output, size)
            if (edit === null && slice.missed === 0 && reset !== true) return
            fanout.ingest(terminalId, {
              output: edit?.text ?? '',
              nextOffset: slice.nextOffset,
              missed: slice.missed,
              // An opening read that draws nothing -- an empty terminal -- must
              // still clear whatever an earlier screen left on the phone.
              replaceFrom: edit?.replaceFrom ?? (reset === true ? 0 : null),
            })
            for (const deviceId of rooms.keys()) pump(deviceId)
          })
          .catch(() => {
            // A terminal whose emulator threw must not take the bridge with it.
            // The next write re-renders the whole screen anyway, so the failure
            // costs at most one frame.
          })
        return
      }
      case 'terminalStatus': {
        lastStatus.set(msg.terminalId, { status: msg.status, summary: msg.summary })
        const watched = new Set(fanout.subscribedTerminals())
        for (const id of [...lastStatus.keys()]) {
          if (!watched.has(id)) lastStatus.delete(id)
        }
        for (const deviceId of fanout.subscribersOf(msg.terminalId)) {
          sendStatus(deviceId, msg.terminalId)
        }
        return
      }
      case 'joinLink':
        joinLink(msg)
        return
      case 'cancelJoin':
        endJoin()
        return
      case 'setLinks':
        applyLinks(msg.links)
        return
      case 'renameDevice': {
        // Cleaned here for the same reason a pairing label is: it is written to
        // `remote-devices.json` and drawn in the device list. A name that cleans
        // to nothing is no name, so the old one stands.
        const label = sanitizeDeviceLabel(msg.label)
        if (label && registry.setLabel(msg.deviceId, label)) announceDevices()
        return
      }
      case 'linkCall':
        void linkCall(msg)
        return
      case 'peerReply': {
        const call = peerCalls.get(msg.callId)
        // Late (already timed out), duplicated, or never asked: nothing to settle.
        if (!call) return
        peerCalls.delete(msg.callId)
        clearTimeout(call.timer)
        if (msg.ok) call.resolve(msg.data)
        else call.reject(new Error(msg.message))
        return
      }
      case 'shutdown':
        dispatcher = null
        if (expirySweep) clearInterval(expirySweep)
        expirySweep = null
        closePairingRoom()
        endJoin()
        for (const deviceId of [...rooms.keys()]) closeRoom(deviceId)
        for (const id of [...linkRooms.keys()]) closeLinkRoom(id)
        // Every request still waiting on main is answered now, with a refusal,
        // rather than left holding a timer in a bridge that is going away.
        for (const [callId, call] of [...peerCalls]) {
          peerCalls.delete(callId)
          clearTimeout(call.timer)
          call.reject(new Error('bridge shutting down'))
        }
        // Main's pump outlives this process by however long the teardown takes.
        // Leaving it pumping into a bridge that is going away is the cost this
        // whole mechanism exists to avoid.
        fanout.dropAll()
        flattener.forgetAll()
        announceSubscriptions()
        return
    }
  }

  async function handleRemoteRequest(deviceId: string, env: RemoteEnvelope): Promise<RemoteResponse> {
    const device = registry.get(deviceId)
    if (!device) return { kind: 'error', id: env.id, message: 'unknown or revoked device' }
    if (!dispatcher) return { kind: 'error', id: env.id, message: 'bridge not initialised' }

    // A linked computer is served the `peer*` set and nothing else -- above the
    // phone branches below, so not even `getCapabilities` or `unpair` reaches
    // it. A phone sending a `peer*` kind goes on down to the dispatcher, whose
    // policy has no case for it and refuses it as unrecognised.
    if (device.kind === 'desktop') return handleHostedPeer(device, env)

    // Answered here, above the dispatcher, because it needs no grant. A device
    // that has been granted nothing must still be able to learn that: without
    // it the phone can only discover a missing capability by attempting the
    // action and reading the refusal, which means offering a control that
    // errors. It is deliberately absent from `requiredCapability`, so losing
    // this branch fails closed rather than open.
    if (env.request.kind === 'getCapabilities') {
      noteSeen(device)
      return { kind: 'ok', id: env.id, data: device.capabilities }
    }

    // A phone leaving, saying so. Answered here for the same reason as the
    // request above -- it needs no grant, and is absent from
    // `requiredCapability` so that losing this branch fails closed.
    //
    // Since v1.40 the phone mints a fresh keypair per desktop, which is what
    // stops two desktops correlating one handset. The cost is that a phone
    // which unpairs and pairs again arrives as a genuinely different device,
    // and the desktop has no way to recognise it as the same handset -- that
    // is the point of per-pairing keys, not an oversight. Without this request
    // every unpair would leave a row behind that nothing can ever remove
    // except the user, by hand, guessing which of several identical-looking
    // entries is the dead one.
    //
    // Deliberately no `closeRoom` here, unlike the host-initiated
    // `revokeDevice`. There the user removed a device that may still be
    // holding a live socket, so the socket has to die with the record. Here
    // the phone is hanging up on itself the moment this returns, and the
    // registry row is already gone -- so anything further arriving on that
    // socket meets the `!device` guard at the top of this function and is
    // refused. Closing it first would only cost us the ability to answer.
    if (env.request.kind === 'unpair') {
      registry.revoke(deviceId)
      announcedSeenAt.delete(deviceId)
      fanout.dropDevice(deviceId)
      announceDevices()
      announceSubscriptions()
      return { kind: 'ok', id: env.id, data: null }
    }

    try {
      const data = await dispatcher.dispatch(env.request, device.capabilities, deviceId)
      // Fan-out state changes only AFTER dispatch has returned without throwing.
      // These two lines used to run first, which made the `read` grant advisory:
      // a device refused `read` still got enrolled by its refused `subscribe`,
      // and then received every subsequent chunk of terminal output. The error
      // response said no while the output stream said yes. A side effect applied
      // ahead of the check that authorises it is not a check.
      if (env.request.kind === 'subscribe') {
        const { terminalId } = env.request
        const fresh = !fanout.terminalsOf(deviceId).includes(terminalId)
        fanout.subscribe(deviceId, terminalId)
        // The screen as it stands, for a phone opening a terminal somebody is
        // already watching -- main will not read it again until it prints.
        resync(deviceId, terminalId, fresh)
        // Before the phone has waited for a change: main only sends a status
        // when the answer moves, so a terminal that has been idle for an hour
        // would otherwise open with a blank label and keep it.
        sendStatus(deviceId, terminalId)
      }
      // The emulator goes when the LAST watcher does, and that is decided in
      // `announceSubscriptions` -- the one place every way of leaving ends up.
      if (env.request.kind === 'unsubscribe') fanout.unsubscribe(deviceId, env.request.terminalId)
      // After the fan-out, never before: the announcement has to follow what the
      // fan-out actually holds, or main starts pumping a terminal for a device
      // that was refused. `announceSubscriptions` is a no-op when nothing moved.
      announceSubscriptions()
      noteSeen(device)
      return { kind: 'ok', id: env.id, data }
    } catch (err) {
      return { kind: 'error', id: env.id, message: (err as Error).message }
    }
  }

  /** Complete a pairing from a device's hello.
   *
   *  Separate from `handleHostMessage` because it is driven by the RELAY, not by
   *  main: the device's public key arrives over the wire. `onPairingFrame` calls
   *  this once a hello has opened; the CLI client also calls it directly, which is
   *  what keeps pairing verifiable end to end with no relay and no mobile code.
   *
   *  Returns the safety number so the caller can show it. Both ends derive it from
   *  the same two public keys, so a relay that substituted its own key produces
   *  different words on the two screens and the user sees the substitution. */
  function acceptPairing(input: {
    oneTimeSecret: string
    devicePublicKey: string
    label: string
    capabilities?: Capabilities
    now?: number
  }): { device: PairedDevice; verificationPhrase: string } {
    if (!pairing) throw new Error('no pairing offer is open')
    // The KIND comes from the offer, not from the caller: a code made for a
    // computer makes a computer, and one made for a phone makes a phone. A
    // computer gets no phone capability even if one was passed in.
    const link = requestedKind === 'desktop'
    const result = pairing.accept(link ? { ...input, capabilities: { ...NO_CAPABILITIES } } : input)
    // Single-use: the offer is spent whether or not the caller retries.
    pairing = null
    const device: PairedDevice = link ? { ...result.device, kind: 'desktop' } : result.device
    registry.add(device)
    openRoom(device)
    deps.send({ kind: 'paired', device })
    deps.send({
      kind: 'verificationPhrase',
      deviceId: device.id,
      phrase: result.verificationPhrase,
    })
    announceDevices()
    return { device, verificationPhrase: result.verificationPhrase }
  }

  /** Everything queued for one device, clearing the queue.
   *
   *  The transport calls this: the fan-out is the buffer between a terminal that
   *  writes whenever it likes and a phone on a link that comes and goes, so output
   *  is PULLED when there is somewhere to put it rather than pushed into a socket
   *  that may be gone. Draining is destructive, so a caller that drops the result
   *  drops the output -- send first, then drain, or accept the loss knowingly. */
  function drainOutput(deviceId: string): DrainedChunk[] {
    return fanout.drain(deviceId)
  }

  return {
    handleHostMessage,
    handleRemoteRequest,
    acceptPairing,
    drainOutput,
    settled: () => flattening,
  }
}

// ── Child-process bootstrap ──────────────────────────────────────────────────
// `process.parentPort` exists ONLY when this module is running as a forked
// utilityProcess, so importing it from a test is a no-op — same guard as
// memoryHost.ts:317 and embedWorker.ts. Unreachable under vitest, hence the
// coverage exemption; the logic worth testing lives in createBridgeCore above.
//
// GOTCHA: here in the CHILD the payload is `e.data`. In the PARENT
// (remoteBridgeSupervisor) it arrives DIRECTLY. Unwrap on both sides and every
// message is undefined.
/* c8 ignore start */
interface ParentPortLike {
  on(event: 'message', cb: (e: { data: HostToBridge }) => void): void
  postMessage(msg: BridgeToHost): void
}
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort
if (parentPort) {
  const core = createBridgeCore({
    send: (m) => parentPort.postMessage(m),
    relayUrl: process.env.TERMPOLIS_RELAY_URL ?? DEFAULT_RELAY_URL,
  })
  parentPort.on('message', (e) => {
    try {
      core.handleHostMessage(e.data)
    } catch (err) {
      // Last-resort net: a throw escaping here kills the bridge and looks to the
      // user like remote silently stopped working.
      parentPort.postMessage({ kind: 'error', message: (err as Error).message })
    }
  })
}
/* c8 ignore stop */
