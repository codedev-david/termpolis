import { DeviceRegistry } from './deviceRegistry'
import { RequestDispatcher } from './dispatcher'
import { OutputFanout, type DrainedChunk } from './outputFanout'
import { LocalMcpClient } from './mcpClient'
import { createPairingOffer, PairingSession } from './pairing'
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
export { generateIdentity, deriveVerificationPhrase, SealedChannel } from './sealedChannel'
export { NO_CAPABILITIES } from './protocol'
export type { Capabilities, PairedDevice, RemoteRequest, RemoteResponse } from './protocol'

interface McpLike {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
}

export interface BridgeCoreDeps {
  send(msg: BridgeToHost): void
  /** Injected in tests; built from init params in production. */
  mcp?: McpLike
  relayUrl: string
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
  const fanout = new OutputFanout()

  function announceDevices(): void {
    deps.send({ kind: 'devicesChanged', devices: registry.list() })
  }

  function handleHostMessage(msg: HostToBridge): void {
    switch (msg.kind) {
      case 'init': {
        registry = new DeviceRegistry(msg.devices)
        const mcp = deps.mcp ?? new LocalMcpClient(msg.mcpPort, msg.mcpToken)
        dispatcher = new RequestDispatcher(mcp)
        publicKey = Buffer.from(
          x25519.getPublicKey(new Uint8Array(Buffer.from(msg.identitySecretKey, 'hex'))),
        ).toString('hex')
        deps.send({ kind: 'ready' })
        return
      }
      case 'beginPairing': {
        const offer = createPairingOffer({ relayUrl: deps.relayUrl, desktopPublicKey: publicKey })
        pairing = new PairingSession(offer, publicKey)
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
        return
      case 'revokeDevice':
        registry.revoke(msg.deviceId)
        fanout.dropDevice(msg.deviceId)
        announceDevices()
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
        return
      case 'terminalOutput':
        fanout.ingest(msg.terminalId, msg.slice)
        return
      case 'shutdown':
        dispatcher = null
        return
    }
  }

  async function handleRemoteRequest(deviceId: string, env: RemoteEnvelope): Promise<RemoteResponse> {
    const device = registry.get(deviceId)
    if (!device) return { kind: 'error', id: env.id, message: 'unknown or revoked device' }
    if (!dispatcher) return { kind: 'error', id: env.id, message: 'bridge not initialised' }

    if (env.request.kind === 'subscribe') fanout.subscribe(deviceId, env.request.terminalId)
    if (env.request.kind === 'unsubscribe') fanout.unsubscribe(deviceId, env.request.terminalId)

    try {
      const data = await dispatcher.dispatch(env.request, device.capabilities)
      registry.touch(deviceId)
      return { kind: 'ok', id: env.id, data }
    } catch (err) {
      return { kind: 'error', id: env.id, message: (err as Error).message }
    }
  }

  /** Complete a pairing from a device's hello.
   *
   *  Separate from `handleHostMessage` because it is driven by the RELAY, not by
   *  main: the device's public key arrives over the wire. Sub-project 2's transport
   *  calls this; Task 12's CLI client calls it directly, which is what makes pairing
   *  verifiable end to end with no mobile code and no relay.
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
    relayUrl: process.env.TERMPOLIS_RELAY_URL ?? 'wss://relay.termpolis.com',
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
