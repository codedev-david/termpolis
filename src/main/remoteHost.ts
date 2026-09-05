import {
  createRemoteHost,
  type RemoteEvent,
  type RemoteHost,
  type RemoteStatusView,
} from './remoteBridgeHost'
import {
  clearRemoteDisabled,
  createRemoteBridgeTransport,
  isRemoteBridgeRunning,
  isRemoteDisabled,
  onBridgeMessage,
  sendToBridge,
  setBridgeSpawner,
  startRemoteBridge,
  stopRemoteBridge,
  type BridgeHandle,
} from './remoteBridgeSupervisor'
import { coerceCapabilities } from './remoteDeviceStore'
import { NO_CAPABILITIES, type BridgeToHost, type Capabilities, type OutputSlice } from './remoteBridge/protocol'
import { ok, err } from './ipcResult'

/**
 * The app's single remote host: one bridge, one device registry, one IPC surface.
 *
 * `index.ts` owns nothing here but the bindings -- the BrowserWindow it pushes
 * to, the terminal buffers it reads from, and the real fork. Everything else is
 * in `remoteBridgeHost.ts`, which has no Electron in it at all.
 */

export interface RemoteHostBinding {
  userDataDir: string
  mcpPort: number
  mcpToken: string
  sendStatus(status: RemoteStatusView): void
  sendEvent(event: RemoteEvent): void
  readOutput(terminalId: string, fromOffset: number): OutputSlice
  /** How a bridge child is forked. Injected so tests never fork anything; the
   *  app passes `realBridgeTransport`. */
  createTransport(relayUrl: string): BridgeHandle
}

/** Answered by every remote channel while the feature has not started -- which is
 *  every run where remote never came up, since the renderer's Settings pane asks
 *  for status regardless. A message, not a throw: an unhandled rejection in the
 *  renderer would surface as a blank pane with nothing to read. */
export const REMOTE_UNAVAILABLE = 'Remote access is not running in this session'

let host: RemoteHost | null = null
let handler: ((m: BridgeToHost) => void) | null = null
let subscribed = false

/* c8 ignore start -- only reachable inside a packaged/dev Electron run, exactly
   like the transport it wraps. Named so `index.ts` holds no fork logic of its own. */
export function realBridgeTransport(relayUrl: string): BridgeHandle {
  return createRemoteBridgeTransport(undefined, relayUrl)
}
/* c8 ignore stop */

export function startRemoteBridgeHost(binding: RemoteHostBinding): void {
  if (host) return
  host = createRemoteHost({
    userDataDir: binding.userDataDir,
    mcpPort: binding.mcpPort,
    mcpToken: binding.mcpToken,
    sendStatus: binding.sendStatus,
    sendEvent: binding.sendEvent,
    readOutput: binding.readOutput,
    startBridge: (init, relayUrl) => {
      // Re-armed on every launch: the spawner closes over the relay URL, and the
      // supervisor calls it again on a crash restart. Wiring it once at bootstrap
      // would make a changed relay address take effect only until the first crash.
      setBridgeSpawner(() => binding.createTransport(relayUrl))
      startRemoteBridge(init)
    },
    stopBridge: stopRemoteBridge,
    sendToBridge,
    onBridgeMessage: (cb) => {
      handler = cb
      if (subscribed) return
      subscribed = true
      // One subscription for the life of the process, dispatching to whichever
      // host is current. The supervisor has no unsubscribe, so a stop/start cycle
      // that subscribed again would leave the previous host's handler live --
      // still writing its stale device list to disk on every `devicesChanged`.
      onBridgeMessage((m) => handler?.(m))
    },
    isBridgeRunning: isRemoteBridgeRunning,
    isDisabled: isRemoteDisabled,
    clearDisabled: clearRemoteDisabled,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  })
  host.start()
}

export function stopRemoteBridgeHost(): void {
  host?.stop()
  host = null
  handler = null
}

/** Both called from the PTY data path, on every chunk. A null host has to be
 *  free, not merely cheap -- this runs ahead of the renderer's own write. */
export function noteTerminalOutput(terminalId: string): void {
  host?.noteTerminalOutput(terminalId)
}

export function noteTerminalClosed(terminalId: string): void {
  host?.noteTerminalClosed(terminalId)
}

const MAX_LABEL = 64

/** A device label safe to persist and to render.
 *
 *  Control characters are dropped rather than escaped: the label is echoed into
 *  the device list beside a live terminal, and an embedded escape sequence there
 *  is a way to redraw a pane the label has no business touching. */
function sanitizeLabel(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  const clean = [...text]
    // Compared as strings so an astral character survives whole: `[...text]`
    // yields the surrogate pair, and its high surrogate sorts well above the
    // control range.
    .filter((c) => c > '' && c !== '')
    .join('')
    .trim()
    .slice(0, MAX_LABEL)
    .trim()
  return clean || 'Phone'
}

function deviceIdOf(input: unknown): string {
  const raw = (input as { deviceId?: unknown } | undefined)?.deviceId
  return typeof raw === 'string' ? raw.trim() : ''
}

/** Validate a capability payload, or say why it is not one.
 *
 *  The one place a compromised renderer could grant itself `writeToTerminal`, so
 *  it rejects rather than coerces: a payload that is not exactly four booleans is
 *  a bug or an attack, and answering it with "granted nothing" would hide both.
 *  `coerceCapabilities` still rebuilds the object afterwards, so an extra key
 *  that passed the shape check cannot ride along into the registry. */
function readCapabilities(input: unknown): { caps: Capabilities } | { error: string } {
  const raw = (input as { capabilities?: unknown } | undefined)?.capabilities
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'Capabilities must be an object' }
  }
  const record = raw as Record<string, unknown>
  const bad = (Object.keys(NO_CAPABILITIES) as (keyof Capabilities)[]).filter(
    (key) => key in record && typeof record[key] !== 'boolean',
  )
  if (bad.length > 0) return { error: `Capability flags must be booleans: ${bad.join(', ')}` }
  return { caps: coerceCapabilities(record) }
}

export interface RemoteIpcLike {
  handle(channel: string, listener: (event: unknown, input?: unknown) => unknown): void
}

/**
 * Register the remote channels. Safe to call before the host starts -- every
 * handler resolves the singleton at call time, because `index.ts` registers IPC
 * during bootstrap and starts remote only once the MCP port is bound.
 */
export function registerRemoteIpc(ipc: RemoteIpcLike): void {
  ipc.handle('remote:status', () => (host ? ok(host.status()) : err(REMOTE_UNAVAILABLE)))

  ipc.handle('remote:set-enabled', (_e, input) => {
    if (!host) return err(REMOTE_UNAVAILABLE)
    // `=== true`, so a malformed payload turns remote OFF rather than on. The
    // safe direction for a switch that opens a network path.
    host.setEnabled((input as { enabled?: unknown } | undefined)?.enabled === true)
    return ok(host.status())
  })

  ipc.handle('remote:set-relay-url', (_e, input) => {
    if (!host) return err(REMOTE_UNAVAILABLE)
    const raw = (input as { relayUrl?: unknown } | undefined)?.relayUrl
    const wanted = typeof raw === 'string' ? raw.trim() : ''
    host.setRelayUrl(wanted)
    const status = host.status()
    // The store keeps the previous address when it refuses one, so the effective
    // value is the only honest answer to "did that take?". Without the check the
    // field would appear to save and every device would keep using the old relay.
    if (status.relayUrl !== wanted) return err('Relay URL must be a ws:// or wss:// address')
    return ok(status)
  })

  ipc.handle('remote:begin-pairing', (_e, input) => {
    if (!host) return err(REMOTE_UNAVAILABLE)
    host.beginPairing(sanitizeLabel((input as { label?: unknown } | undefined)?.label))
    return ok(host.status())
  })

  ipc.handle('remote:cancel-pairing', () => {
    if (!host) return err(REMOTE_UNAVAILABLE)
    host.cancelPairing()
    return ok(host.status())
  })

  ipc.handle('remote:revoke-device', (_e, input) => {
    if (!host) return err(REMOTE_UNAVAILABLE)
    const deviceId = deviceIdOf(input)
    if (!deviceId) return err('A device id is required')
    host.revokeDevice(deviceId)
    return ok(host.status())
  })

  ipc.handle('remote:set-capabilities', (_e, input) => {
    if (!host) return err(REMOTE_UNAVAILABLE)
    const deviceId = deviceIdOf(input)
    if (!deviceId) return err('A device id is required')
    const read = readCapabilities(input)
    if ('error' in read) return err(read.error)
    host.setDeviceCapabilities(deviceId, read.caps)
    return ok(host.status())
  })

  ipc.handle('remote:verification-phrase', (_e, input) => {
    if (!host) return err(REMOTE_UNAVAILABLE)
    const deviceId = deviceIdOf(input)
    if (!deviceId) return err('A device id is required')
    const phrase = host.verificationPhraseFor(deviceId)
    if (!phrase) return err('That device is not paired with this desktop')
    return ok({ deviceId, phrase })
  })
}

/** @internal test-only */
export function _resetRemoteHostForTests(): void {
  host = null
  handler = null
  subscribed = false
}
