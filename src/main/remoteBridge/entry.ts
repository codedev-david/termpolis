import { DeviceRegistry } from './deviceRegistry'
import { RequestDispatcher } from './dispatcher'
import { OutputFanout } from './outputFanout'
import { LocalMcpClient } from './mcpClient'
import { createPairingOffer, PairingSession } from './pairing'
import { x25519 } from '@noble/curves/ed25519.js'
import type { BridgeToHost, HostToBridge, RemoteEnvelope, RemoteResponse } from './protocol'

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
        // The phrase shown here is against the desktop's own key until a device
        // completes the handshake; the device recomputes and both are compared.
        deps.send({
          kind: 'pairingCode',
          qrPayload: offer.qrPayload,
          verificationPhrase: offer.pairingId.slice(0, 12).match(/.{1,2}/g)!.slice(0, 6).join(' '),
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
        announceDevices()
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

  return { handleHostMessage, handleRemoteRequest }
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
