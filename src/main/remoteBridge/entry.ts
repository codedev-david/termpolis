import { DeviceRegistry } from './deviceRegistry'
import { RequestDispatcher } from './dispatcher'
import { OutputFanout, type DrainedChunk } from './outputFanout'
import { LocalMcpClient } from './mcpClient'
import {
  createPairingOffer,
  openPairingHello,
  sealPairingAck,
  PairingSession,
  type PairingOffer,
} from './pairing'
import { chunkOutbound, MAX_PAYLOAD_BYTES } from './outputChunker'
import { RelayClient, type RelayClientDeps, type RelayState } from './relayClient'
import { Handshake } from './sessionCrypto'
import { DEFAULT_RELAY_URL } from './protocol'
import { x25519 } from '@noble/curves/ed25519.js'
import type {
  BridgeToHost,
  HostToBridge,
  PairedDevice,
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
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
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
  stop(): void
  readonly state: RelayState
}

export interface BridgeCoreDeps {
  send(msg: BridgeToHost): void
  /** Injected in tests; built from init params in production. */
  mcp?: McpLike
  relayUrl: string
  /** Injected in tests; production dials the real relay. */
  openRelay?(deps: RelayClientDeps): RelayLike
}

export interface BridgeCore {
  handleHostMessage(msg: HostToBridge): void
  handleRemoteRequest(deviceId: string, env: RemoteEnvelope): Promise<RemoteResponse>
  acceptPairing(input: {
    oneTimeSecret: string
    devicePublicKey: string
    label: string
    now?: number
  }): { device: PairedDevice; verificationPhrase: string }
  /** Pull everything queued for one device. Destructive -- see the implementation. */
  drainOutput(deviceId: string): DrainedChunk[]
}

export function createBridgeCore(deps: BridgeCoreDeps): BridgeCore {
  let registry = new DeviceRegistry()
  let dispatcher: RequestDispatcher | null = null
  let pairing: PairingSession | null = null
  let publicKey = ''
  let identitySecretKey = ''
  const fanout = new OutputFanout()

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
      onQuota: (limit) =>
        deps.send({ kind: 'error', message: `relay closed the pairing connection: ${limit}` }),
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

    let result: { device: PairedDevice; verificationPhrase: string }
    try {
      result = acceptPairing({
        oneTimeSecret: hello.oneTimeSecret,
        devicePublicKey: hello.devicePublicKey,
        label: hello.label,
      })
    } catch (err) {
      // This one IS worth surfacing: the frame opened, so the sender had the QR's
      // pairing id and public key but not its secret. The offer survives a refusal,
      // so the room stays open and the real phone can still finish.
      deps.send({ kind: 'error', message: `pairing failed: ${(err as Error).message}` })
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
      // symptom the user gets is a phone that stopped working.
      onQuota: (limit) =>
        deps.send({
          kind: 'error',
          message: `relay closed the ${dev.label} connection: ${limit}`,
        }),
    })
    rooms.set(dev.id, { client, roomId: dev.sessionRoomId })
    client.start()
  }

  function closeRoom(deviceId: string): void {
    rooms.get(deviceId)?.client.stop()
    rooms.delete(deviceId)
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
    if (state === 'attached') pump(deviceId)
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

  function announceDevices(): void {
    deps.send({ kind: 'devicesChanged', devices: registry.list() })
  }

  /** The last set main was told about, as a stable key. Starts as the empty set,
   *  which is what main assumes before the first announcement -- so a core that
   *  opens with nothing subscribed correctly says nothing. */
  let announcedSubscriptions = ''

  /** Tell main which terminals are worth pumping, but only when that changes.
   *
   *  Main pumps PTY output for exactly this set. A phone re-subscribing on every
   *  reconnect is routine, and re-announcing an identical set would wake main and
   *  reset its pump for no reason -- so the comparison is on the SORTED ids
   *  rather than on insertion order, which varies with who subscribed first. */
  function announceSubscriptions(): void {
    const terminalIds = fanout.subscribedTerminals().sort()
    const key = terminalIds.join(' ')
    if (key === announcedSubscriptions) return
    announcedSubscriptions = key
    deps.send({ kind: 'subscriptionsChanged', terminalIds })
  }

  function handleHostMessage(msg: HostToBridge): void {
    switch (msg.kind) {
      case 'init': {
        registry = new DeviceRegistry(msg.devices)
        identitySecretKey = msg.identitySecretKey
        const mcp = deps.mcp ?? new LocalMcpClient(msg.mcpPort, msg.mcpToken)
        dispatcher = new RequestDispatcher(mcp)
        publicKey = Buffer.from(
          x25519.getPublicKey(new Uint8Array(Buffer.from(msg.identitySecretKey, 'hex'))),
        ).toString('hex')
        deps.send({ kind: 'ready' })
        // Every device already paired gets its room back on start. A phone left
        // waiting overnight reconnects without the user touching either machine.
        for (const dev of registry.list()) openRoom(dev)
        return
      }
      case 'beginPairing': {
        const offer = createPairingOffer({ relayUrl: deps.relayUrl, desktopPublicKey: publicKey })
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
        })
        return
      }
      case 'cancelPairing':
        pairing = null
        closePairingRoom()
        return
      case 'revokeDevice':
        registry.revoke(msg.deviceId)
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
        announceDevices()
        announceSubscriptions()
        return
      case 'terminalOutput':
        fanout.ingest(msg.terminalId, msg.slice)
        for (const deviceId of rooms.keys()) pump(deviceId)
        return
      case 'shutdown':
        dispatcher = null
        closePairingRoom()
        for (const deviceId of [...rooms.keys()]) closeRoom(deviceId)
        // Main's pump outlives this process by however long the teardown takes.
        // Leaving it pumping into a bridge that is going away is the cost this
        // whole mechanism exists to avoid.
        fanout.dropAll()
        announceSubscriptions()
        return
    }
  }

  async function handleRemoteRequest(deviceId: string, env: RemoteEnvelope): Promise<RemoteResponse> {
    const device = registry.get(deviceId)
    if (!device) return { kind: 'error', id: env.id, message: 'unknown or revoked device' }
    if (!dispatcher) return { kind: 'error', id: env.id, message: 'bridge not initialised' }

    try {
      const data = await dispatcher.dispatch(env.request, device.capabilities)
      // Fan-out state changes only AFTER dispatch has returned without throwing.
      // These two lines used to run first, which made the `read` grant advisory:
      // a device refused `read` still got enrolled by its refused `subscribe`,
      // and then received every subsequent chunk of terminal output. The error
      // response said no while the output stream said yes. A side effect applied
      // ahead of the check that authorises it is not a check.
      if (env.request.kind === 'subscribe') fanout.subscribe(deviceId, env.request.terminalId)
      if (env.request.kind === 'unsubscribe') fanout.unsubscribe(deviceId, env.request.terminalId)
      // After the fan-out, never before: the announcement has to follow what the
      // fan-out actually holds, or main starts pumping a terminal for a device
      // that was refused. `announceSubscriptions` is a no-op when nothing moved.
      announceSubscriptions()
      registry.touch(deviceId)
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
    now?: number
  }): { device: PairedDevice; verificationPhrase: string } {
    if (!pairing) throw new Error('no pairing offer is open')
    const result = pairing.accept(input)
    // Single-use: the offer is spent whether or not the caller retries.
    pairing = null
    registry.add(result.device)
    openRoom(result.device)
    deps.send({ kind: 'paired', device: result.device })
    deps.send({
      kind: 'verificationPhrase',
      deviceId: result.device.id,
      phrase: result.verificationPhrase,
    })
    announceDevices()
    return result
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

  return { handleHostMessage, handleRemoteRequest, acceptPairing, drainOutput }
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
