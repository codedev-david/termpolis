import {
  NO_CAPABILITIES,
  type BridgeToHost,
  type Capabilities,
  type HostToBridge,
  type OutputSlice,
  type PairedDevice,
} from './remoteBridge/protocol'
import { deriveVerificationPhrase } from './remoteBridge/sealedChannel'
import { getOrCreateRemoteIdentity, type RemoteIdentity } from './remoteIdentityStore'
import { loadRemoteDevices, saveRemoteDevices } from './remoteDeviceStore'
import { DEFAULT_REMOTE_SETTINGS, loadRemoteSettings, saveRemoteSettings } from './remoteSettings'
import { createOutputPump, type OutputPump } from './remoteOutputPump'

type InitParams = Omit<Extract<HostToBridge, { kind: 'init' }>, 'kind'>

/** Everything the host reaches out to, injected.
 *
 *  The supervisor functions arrive as deps rather than as imports so this module
 *  is unit-testable with no Electron and no forked child: `index.ts` binds them
 *  to the real supervisor once, at wiring time. */
export interface RemoteHostDeps {
  userDataDir: string
  mcpPort: number
  mcpToken: string
  sendToRenderer(channel: string, payload: unknown): void
  readOutput(terminalId: string, fromOffset: number): OutputSlice
  startBridge(init: InitParams, relayUrl: string): void
  stopBridge(): void
  sendToBridge(msg: HostToBridge): void
  onBridgeMessage(cb: (m: BridgeToHost) => void): void
  isBridgeRunning(): boolean
  isDisabled(): boolean
  clearDisabled(): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

/** One paired device as the renderer sees it.
 *
 *  A rebuilt view and not the stored record: `sessionRoomId` is deliberately
 *  absent. It decrypts nothing, but it is the address of the desktop's seat on
 *  the relay, and a seat is exclusive -- the relay answers a second socket for
 *  the same room with 409. Knowing the name is enough to keep the real phone
 *  out, which is a capability whether or not it is a key. */
export interface RemoteDeviceView {
  id: string
  label: string
  publicKey: string
  capabilities: Capabilities
  pairedAt: number
  lastSeenAt: number
  /** Reachable right now. Distinct from paired, which survives a tunnel. */
  attached: boolean
}

/** What the renderer is told when the bridge says something.
 *
 *  Rebuilt field by field rather than forwarded whole: `devicesChanged` and
 *  `paired` carry entire `PairedDevice` records, and those hold `sessionRoomId`
 *  -- the address of this desktop's seat on the relay. The renderer has no use
 *  for it, and a value that reaches a renderer is a value in a devtools console.
 *  Device detail reaches the UI through `remote:status`, which is scrubbed once,
 *  in one place. An allowlist and not a delete-list, so a field added to the
 *  protocol later is excluded by default rather than leaked by omission. */
export interface RemoteEvent {
  kind: BridgeToHost['kind']
  deviceId?: string
  label?: string
  phrase?: string
  message?: string
}

export interface RemotePairingView {
  qrPayload: string
  expiresAt: number
}

export interface RemoteStatusView {
  enabled: boolean
  running: boolean
  /** The supervisor gave up after a crash loop. The switch says on; nothing is. */
  disabled: boolean
  relayUrl: string
  /** This desktop's X25519 public key, hex. Safe to show: it is half of what a
   *  device needs to pair, and the half that is meant to be published. */
  publicKey: string
  pairing: RemotePairingView | null
  devices: RemoteDeviceView[]
}

export interface RemoteHost {
  start(): void
  stop(): void
  status(): RemoteStatusView
  setEnabled(enabled: boolean): void
  setRelayUrl(url: string): void
  beginPairing(label: string): void
  cancelPairing(): void
  revokeDevice(deviceId: string): void
  setDeviceCapabilities(deviceId: string, capabilities: Capabilities): void
  verificationPhraseFor(deviceId: string): string | null
  noteTerminalOutput(terminalId: string): void
  noteTerminalClosed(terminalId: string): void
}

/**
 * Owns the remote feature's lifecycle: the on/off switch, the identity, the
 * device registry, the pairing state and the output pump.
 *
 * A module rather than lines in `index.ts` because `index.ts` is already ~3,700
 * lines and its uncovered IPC handlers have historically been the repo's worst
 * coverage offender. Nothing here needs Electron, so all of it is testable.
 */
export function createRemoteHost(deps: RemoteHostDeps): RemoteHost {
  // Read in `start()`, not here: construction happens during app bootstrap, and
  // a factory that touches disk cannot be called before the userData directory
  // is settled.
  let settings = DEFAULT_REMOTE_SETTINGS
  let devices: PairedDevice[] = []
  let identity: RemoteIdentity | null = null
  const attached = new Set<string>()
  let pairing: RemotePairingView | null = null
  let pump: OutputPump | null = null

  /** The long-term X25519 identity, minted on first use.
   *
   *  Lazy on purpose: a user who never turns remote on never gets a key file
   *  written into their profile. Once minted it is stable, so a device paired
   *  last week still lands in the room this desktop dials today. */
  function ownIdentity(): RemoteIdentity {
    if (!identity) identity = getOrCreateRemoteIdentity(deps.userDataDir)
    return identity
  }

  /** Push at the renderer, which may have been destroyed a moment ago.
   *
   *  Every call site here is inside a bridge message handler, and a throw there
   *  escapes into the supervisor's emit loop -- one closing window would take
   *  remote down for the rest of the run. */
  function toRenderer(channel: string, payload: unknown): void {
    try {
      deps.sendToRenderer(channel, payload)
    } catch {
      /* window is gone */
    }
  }

  function toEvent(m: BridgeToHost): RemoteEvent {
    const e: RemoteEvent = { kind: m.kind }
    if (m.kind === 'paired') {
      e.deviceId = m.device.id
      e.label = m.device.label
    }
    if (m.kind === 'deviceConnected' || m.kind === 'deviceDisconnected') e.deviceId = m.deviceId
    if (m.kind === 'verificationPhrase') {
      e.deviceId = m.deviceId
      e.phrase = m.phrase
    }
    if (m.kind === 'error') e.message = m.message
    return e
  }

  function emitStatus(): void {
    toRenderer('remote:status', status())
  }

  function newPump(): OutputPump {
    return createOutputPump({
      read: (terminalId, fromOffset) => deps.readOutput(terminalId, fromOffset),
      send: (terminalId, slice) => deps.sendToBridge({ kind: 'terminalOutput', terminalId, slice }),
      setTimer: (fn, ms) => deps.setTimer(fn, ms),
      clearTimer: (handle) => deps.clearTimer(handle),
    })
  }

  function handle(m: BridgeToHost): void {
    switch (m.kind) {
      case 'pairingCode':
        pairing = { qrPayload: m.qrPayload, expiresAt: m.expiresAt }
        break
      case 'paired':
        // The offer is single-use. Leaving it on screen after it has been spent
        // invites the user to scan a code that will simply be refused.
        pairing = null
        break
      case 'devicesChanged':
        devices = m.devices
        saveRemoteDevices(deps.userDataDir, devices)
        for (const id of [...attached]) if (!devices.some((d) => d.id === id)) attached.delete(id)
        break
      case 'deviceConnected':
        attached.add(m.deviceId)
        break
      case 'deviceDisconnected':
        attached.delete(m.deviceId)
        break
      case 'subscriptionsChanged':
        pump?.setSubscriptions(m.terminalIds)
        break
      default:
        break
    }
    toRenderer('remote:event', toEvent(m))
    emitStatus()
  }

  /** Spawn the child with everything it needs to run unattended.
   *
   *  The secret key crosses this boundary and no other: `safeStorage` does not
   *  exist in a utilityProcess, so the child cannot read the identity for
   *  itself, and it must never travel to the renderer. */
  function launch(): void {
    pump?.stop()
    pump = newPump()
    deps.startBridge(
      {
        mcpPort: deps.mcpPort,
        mcpToken: deps.mcpToken,
        identitySecretKey: ownIdentity().secretKey,
        devices,
      },
      settings.relayUrl,
    )
  }

  function shutdown(): void {
    pump?.stop()
    pump = null
    attached.clear()
    pairing = null
    deps.stopBridge()
  }

  function status(): RemoteStatusView {
    return {
      enabled: settings.enabled,
      running: deps.isBridgeRunning(),
      disabled: deps.isDisabled(),
      relayUrl: settings.relayUrl,
      publicKey: ownIdentity().publicKey,
      // Computed at read time rather than cleared by a timer: a timer would have
      // to be cancelled on every path out of pairing, and forgetting one leaves a
      // stale callback holding this closure.
      pairing: pairing && pairing.expiresAt > Date.now() ? pairing : null,
      devices: devices.map((d) => ({
        id: d.id,
        label: d.label,
        publicKey: d.publicKey,
        capabilities: { ...NO_CAPABILITIES, ...d.capabilities },
        pairedAt: d.pairedAt,
        lastSeenAt: d.lastSeenAt,
        attached: attached.has(d.id),
      })),
    }
  }

  return {
    start(): void {
      settings = loadRemoteSettings(deps.userDataDir)
      devices = loadRemoteDevices(deps.userDataDir)
      deps.onBridgeMessage(handle)
      if (settings.enabled) launch()
    },

    stop: shutdown,
    status,

    setEnabled(enabled: boolean): void {
      settings = saveRemoteSettings(deps.userDataDir, { enabled })
      if (enabled) {
        // Re-arm first. The supervisor fails CLOSED on a crash loop and stays
        // that way, so without this the switch would do nothing at all until the
        // app restarted -- and say nothing about why.
        deps.clearDisabled()
        launch()
      } else {
        shutdown()
      }
      emitStatus()
    },

    setRelayUrl(url: string): void {
      settings = saveRemoteSettings(deps.userDataDir, { relayUrl: url })
      // The child reads the URL once, at bootstrap, so a running bridge has to be
      // replaced to pick it up. A stopped one is left stopped: changing an address
      // is not a request to start listening on it.
      if (deps.isBridgeRunning()) {
        shutdown()
        launch()
      }
      emitStatus()
    },

    beginPairing(label: string): void {
      deps.sendToBridge({ kind: 'beginPairing', label })
    },

    cancelPairing(): void {
      pairing = null
      deps.sendToBridge({ kind: 'cancelPairing' })
      emitStatus()
    },

    revokeDevice(deviceId: string): void {
      // No local edit of `devices`: the bridge owns the registry and answers with
      // `devicesChanged`. Trimming here too would show the device gone a beat
      // before it actually is, and disagree outright if the bridge refused.
      deps.sendToBridge({ kind: 'revokeDevice', deviceId })
    },

    setDeviceCapabilities(deviceId: string, capabilities: Capabilities): void {
      deps.sendToBridge({ kind: 'setCapabilities', deviceId, capabilities })
    },

    /** The safety number for one device.
     *
     *  Computed here from the two public keys rather than asked of the child: it
     *  is a pure function of both identities, so a round trip would add a failure
     *  mode and answer nothing extra -- and it works while the phone is offline,
     *  which is exactly when the user reads it aloud to compare. */
    verificationPhraseFor(deviceId: string): string | null {
      const device = devices.find((d) => d.id === deviceId)
      if (!device) return null
      return deriveVerificationPhrase(ownIdentity().publicKey, device.publicKey)
    },

    noteTerminalOutput(terminalId: string): void {
      pump?.markDirty(terminalId)
    },

    noteTerminalClosed(terminalId: string): void {
      pump?.dropTerminal(terminalId)
    },
  }
}
