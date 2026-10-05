import {
  NO_CAPABILITIES,
  type BridgeLink,
  type BridgeToHost,
  type Capabilities,
  type HostToBridge,
  type OutputSlice,
  type PairedDevice,
  type TerminalSize,
} from './remoteBridge/protocol'
import { deriveVerificationPhrase } from './remoteBridge/sealedChannel'
import { getOrCreateRemoteIdentity, type RemoteIdentity } from './remoteIdentityStore'
import { loadRemoteDevices, saveRemoteDevices } from './remoteDeviceStore'
import { DEFAULT_REMOTE_SETTINGS, loadRemoteSettings, saveRemoteSettings } from './remoteSettings'
import { createOutputPump, type OutputPump } from './remoteOutputPump'
import { createStatusPump, type StatusPump, type TerminalSnapshot } from './remoteStatusPump'
import { detectAgentStatus } from '../shared/agentStatusDetector'

type InitParams = Omit<Extract<HostToBridge, { kind: 'init' }>, 'kind'>

/** Linked machines' half of the bridge's init: its switch, and the links this
 *  machine joined. The rooms of computers this machine HOSTS travel with the
 *  devices, like every other paired device. */
export interface LinkedInit {
  enabled: boolean
  links: BridgeLink[]
}

/** Everything the host reaches out to, injected.
 *
 *  The supervisor functions arrive as deps rather than as imports so this module
 *  is unit-testable with no Electron and no forked child: `index.ts` binds them
 *  to the real supervisor once, at wiring time. */
export interface RemoteHostDeps {
  userDataDir: string
  mcpPort: number
  mcpToken: string
  /** Push the whole picture. Two typed callbacks and not one
   *  `send(channel, payload)`: the channel names then appear as literals at the
   *  one call site that owns a BrowserWindow, which is what the main<->preload
   *  anti-drift guard scans for -- a variable channel is invisible to it, and the
   *  matching preload listener would read as a ghost. */
  sendStatus(status: RemoteStatusView): void
  /** Push one thing that just happened, for a toast or a modal. */
  sendEvent(event: RemoteEvent): void
  readOutput(terminalId: string, fromOffset: number): OutputSlice
  /** The terminal's current grid size, or null when it is gone.
   *
   *  Sent down with every slice rather than on resize alone: the bridge may
   *  start watching a terminal that was sized long ago, and a resize message it
   *  was not running to hear would leave it emulating the wrong grid forever. */
  terminalSize(terminalId: string): TerminalSize | null
  /** The whole rolling window plus the terminal's name, for status detection.
   *  Separate from `readOutput` because that one is an incremental read that
   *  advances an offset, and the detector needs the window every time. */
  readRecent(terminalId: string): TerminalSnapshot | null
  /** `init` is a FACTORY, and the supervisor asks it again on every crash
   *  respawn. Params captured at launch would bring a bridge back an hour later
   *  with the devices, links and switches of an hour ago. */
  startBridge(init: () => InitParams, relayUrl: string): void
  stopBridge(): void
  sendToBridge(msg: HostToBridge): void
  onBridgeMessage(cb: (m: BridgeToHost) => void): void
  isBridgeRunning(): boolean
  isDisabled(): boolean
  clearDisabled(): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** Linked machines' state, asked at every bridge start and respawn and by
   *  `refreshLinked()`. Optional: absent means Linked machines is off, which is
   *  what every host built before it existed meant. */
  linkedInit?: () => LinkedInit
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

/** The one bridge, as Linked machines (`linkedHost.ts`) sees it.
 *
 *  Remote and Linked machines share a child process and a relay identity, and
 *  Remote owns the lifecycle: Linked machines never starts or stops the bridge
 *  itself, it says what it wants through `linkedInit` and `refreshLinked()`.
 *  This is everything else it needs. */
export interface LinkedBridgePort {
  /** The bridge is up AND was started with linked rooms open. */
  running(): boolean
  /** Post to the bridge. A no-op when it is down, like every send to it. */
  send(msg: HostToBridge): void
  /** EVERY bridge message, unfiltered -- the ones Remote hears too. Called after
   *  the host has applied the message, so the readers below already reflect
   *  it. Returns the unsubscribe. */
  onMessage(cb: (m: BridgeToHost) => void): () => void
  /** The paired devices that are linked computers (`kind: 'desktop'`). */
  desktopPeers(): PairedDevice[]
  /** Device ids whose session room is attached right now; empty while the
   *  bridge is down. Phones are in it too -- intersect with `desktopPeers()`. */
  attachedDeviceIds(): ReadonlySet<string>
  /** The safety words for a hosted device, from the two public keys. */
  verificationPhraseFor(deviceId: string): string | null
  /** The relay this machine's rooms -- and every code it makes -- use. */
  relayUrl(): string
  /** Whether the bridge's one offer -- the code it holds, or the one it was
   *  last asked for and has not answered yet -- is for another computer.
   *
   *  The bridge's `{kind:'error'}` names no owner, so this is what does: an
   *  error delivered while this is true is Linked machines' to show, and Remote
   *  never shows it. A refused request is answered by exactly such an error,
   *  and this still says so while that error is being delivered. */
  linkOfferLive(): boolean
}

export interface RemoteHost {
  start(): void
  stop(): void
  status(): RemoteStatusView
  setEnabled(enabled: boolean): void
  setRelayUrl(url: string): void
  /** `capabilities` is what the user granted before the QR is shown, so the
   *  device is created with it rather than being granted a moment later. */
  beginPairing(label: string, capabilities?: Capabilities): void
  cancelPairing(): void
  revokeDevice(deviceId: string): void
  setDeviceCapabilities(deviceId: string, capabilities: Capabilities): void
  verificationPhraseFor(deviceId: string): string | null
  noteTerminalOutput(terminalId: string): void
  noteTerminalClosed(terminalId: string): void
  /** Re-read `linkedInit()` and bring the bridge in line: start or stop it (it
   *  runs while Remote OR Linked machines is on), restart it when the kinds of
   *  room it should open changed, or hand it the new link list when only that
   *  changed. Does nothing before `start()`, which reads `linkedInit` itself. */
  refreshLinked(): void
  /** Ask the bridge for a code for another computer. The bridge holds one offer
   *  at a time, so this replaces any phone QR on screen. */
  beginLinkPairing(label?: string): void
  /** Withdraw the code for another computer -- and only that. A phone QR that
   *  has since replaced it is left alone. */
  cancelLinkPairing(): void
  linkedPort(): LinkedBridgePort
}

/** Which kind of device an offer pairs. */
type OfferKind = 'phone' | 'link'

/** One string per link list, for "has it changed?". Every field, because a link
 *  whose record changed under the same id is a different room to the bridge. */
function linksKey(links: BridgeLink[]): string {
  return JSON.stringify(links.map((l) => [l.id, l.hostPublicKey, l.relayUrl, l.sessionRoomId, l.secretKey]))
}

/**
 * Owns the remote feature's lifecycle: the on/off switch, the identity, the
 * device registry, the pairing state and the output pump.
 *
 * A module rather than lines in `index.ts` because `index.ts` is already ~3,700
 * lines and its uncovered IPC handlers have historically been the repo's worst
 * coverage offender. Nothing here needs Electron, so all of it is testable.
 *
 * The bridge it runs also carries Linked machines, so it runs while EITHER
 * feature is on, and `init` tells it which kinds of room to open. Everything a
 * linked computer does stays out of the Remote views and events: the phone UI
 * lists phones, and a computer is managed under Settings ▸ Linked machines.
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
  let statusPump: StatusPump | null = null
  let started = false
  /** Every device id known to be a linked computer.
   *
   *  Never pruned. An id is a hash of the device's public key, so a phone can
   *  never turn up under one -- and the bridge reports a revoked computer's room
   *  closing AFTER the device list that dropped it, so a set that followed the
   *  list would let that last word through to the phone UI. */
  const desktopIds = new Set<string>()
  /** The bridge holds ONE offer, and starting one replaces the other. These two
   *  mirror it, because the bridge's errors name no owner and only the offer
   *  says whose an error is.
   *
   *  `offerAsks` are the requests it has not answered yet, oldest first: it
   *  answers each, in order, with a code or a refusal. `cancelled` is a request
   *  withdrawn before its code came back -- that code is already gone over
   *  there. */
  let offerAsks: Array<{ kind: OfferKind; cancelled: boolean }> = []
  /** The offer the bridge holds, as its last code announced it. */
  let offerLive: { kind: OfferKind; expiresAt: number } | null = null
  /** Whether the init factory's next call is a crash respawn rather than the
   *  first spawn after `launch()`. */
  let respawn = false
  /** What the running bridge was told at init, and the link list it has been
   *  handed since. Null while it is down. Filled in by the init factory itself,
   *  so a crash respawn that read newer state is recorded as what it read. */
  let launched: { phones: boolean; linked: boolean; links: string } | null = null
  /** The Linked machines switch as `start()` or the last `refreshLinked()` saw
   *  it, so that turning it ON can re-arm the supervisor the way turning Remote
   *  on does. */
  let linkedWasOn = false
  const linkedListeners = new Set<(m: BridgeToHost) => void>()

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
  function push(send: () => void): void {
    try {
      send()
    } catch {
      /* window is gone */
    }
  }

  /** Linked machines' view of its own switch and links.
   *
   *  Also asked inside the supervisor's respawn path, where a throw would escape
   *  into a child-exit handler with no caller to land on. A provider that fails
   *  reads as Linked machines off: the safe direction for a switch that opens
   *  network rooms. */
  function linkedState(): LinkedInit {
    try {
      const state = deps.linkedInit?.()
      const links = state?.links
      return { enabled: state?.enabled === true, links: Array.isArray(links) ? links : [] }
    } catch {
      return { enabled: false, links: [] }
    }
  }

  /** Whose offer the bridge has: the request it answers next, else the code
   *  it holds. A bridge that is not running has none and owes nothing -- so the
   *  supervisor's own "gave up" error stays Remote's, as it always was. */
  function offerOwner(): OfferKind | null {
    if (!deps.isBridgeRunning()) return null
    const ask = offerAsks[0]
    if (ask) return ask.kind
    return offerLive && offerLive.expiresAt > Date.now() ? offerLive.kind : null
  }

  function linkOfferLive(): boolean {
    return offerOwner() === 'link'
  }

  /** Whether a device is a linked computer.
   *
   *  A device this host has never heard of is the one pairing through the live
   *  offer right now: the bridge opens its room, and reports the room, before
   *  it reports the pairing. Only the offer knows what it is at that moment. */
  function isDesktop(deviceId: string): boolean {
    if (desktopIds.has(deviceId)) return true
    return !devices.some((d) => d.id === deviceId) && offerOwner() === 'link'
  }

  function noteDesktops(list: PairedDevice[]): void {
    for (const d of list) if (d.kind === 'desktop') desktopIds.add(d.id)
  }

  /** Everything this host posts to the bridge goes through here, so the offer
   *  mirror above sees every request for one. */
  function post(msg: HostToBridge): void {
    if (msg.kind === 'beginPairing') {
      // Only while a child is up to answer. The supervisor drops a message sent
      // with none running, and a request never answered would claim every
      // error after it.
      if (deps.isBridgeRunning()) offerAsks.push({ kind: msg.link === true ? 'link' : 'phone', cancelled: false })
    } else if (msg.kind === 'cancelPairing') {
      // Withdraws whatever is held -- and, since the bridge reads its messages
      // in order, whatever a request still on its way will make.
      for (const ask of offerAsks) ask.cancelled = true
      offerLive = null
    } else if (msg.kind === 'setLinks' && launched !== null) {
      launched.links = linksKey(msg.links)
    }
    deps.sendToBridge(msg)
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
    push(() => deps.sendStatus(status()))
  }

  function newStatusPump(): StatusPump {
    return createStatusPump({
      read: (terminalId) => deps.readRecent(terminalId),
      detect: detectAgentStatus,
      send: (terminalId, result) =>
        deps.sendToBridge({
          kind: 'terminalStatus',
          terminalId,
          status: result.status,
          summary: result.summary,
        }),
      setTimer: (fn, ms) => deps.setTimer(fn, ms),
      clearTimer: (handle) => deps.clearTimer(handle),
    })
  }

  function newPump(): OutputPump {
    return createOutputPump({
      read: (terminalId, fromOffset) => deps.readOutput(terminalId, fromOffset),
      send: (terminalId, slice, reset) => {
        const size = deps.terminalSize(terminalId)
        deps.sendToBridge({
          kind: 'terminalOutput',
          terminalId,
          slice,
          ...(size === null ? {} : { size }),
          // Only when set, so an ordinary slice is the same message it always was.
          ...(reset ? { reset: true } : {}),
        })
      },
      setTimer: (fn, ms) => deps.setTimer(fn, ms),
      clearTimer: (handle) => deps.clearTimer(handle),
    })
  }

  function handle(m: BridgeToHost): void {
    // What the Remote renderer is told: the event and a fresh status, the status
    // alone, or nothing. A linked computer is not a phone, so what concerns only
    // a computer stays out of the phone UI -- a `paired` here would put a
    // "phone paired" modal on screen for a machine.
    let tell: 'all' | 'status' | 'none' = 'all'
    /** Run once every listener has heard `m`. */
    let settle: (() => void) | null = null
    switch (m.kind) {
      case 'pairingCode': {
        const ask = offerAsks.shift()
        const kind: OfferKind = m.linkCode === undefined ? 'phone' : 'link'
        offerLive = ask?.cancelled ? null : { kind, expiresAt: m.expiresAt }
        if (kind === 'phone') {
          pairing = { qrPayload: m.qrPayload, expiresAt: m.expiresAt }
        } else {
          // A code for another computer. It REPLACED any phone QR, so that goes
          // from the Remote view -- quietly: Remote did not ask for this code.
          pairing = null
          tell = 'status'
        }
        break
      }
      case 'paired':
        // The offer is single-use. Leaving it on screen after it has been spent
        // invites the user to scan a code that will simply be refused.
        pairing = null
        offerLive = null
        if (m.device.kind === 'desktop') {
          desktopIds.add(m.device.id)
          tell = 'none'
        }
        break
      case 'verificationPhrase':
        if (isDesktop(m.deviceId)) tell = 'none'
        break
      case 'devicesChanged':
        // Computers included: `remote-devices.json` is the host's half of every
        // link, and the store keeps `kind` so they reload as computers.
        devices = m.devices
        noteDesktops(devices)
        saveRemoteDevices(deps.userDataDir, devices)
        for (const id of [...attached]) if (!devices.some((d) => d.id === id)) attached.delete(id)
        break
      case 'deviceConnected':
        if (isDesktop(m.deviceId)) tell = 'none'
        attached.add(m.deviceId)
        break
      case 'deviceDisconnected':
        if (isDesktop(m.deviceId)) tell = 'none'
        attached.delete(m.deviceId)
        break
      case 'subscriptionsChanged':
        pump?.setSubscriptions(m.terminalIds)
        statusPump?.setSubscriptions(m.terminalIds)
        break
      case 'ready':
        // A bridge that has just started is watching nothing, so neither pump
        // may think otherwise. After a first launch they are new and already
        // agree. After a crash they do not: the supervisor respawns the child
        // without `launch()`, and both pumps still hold the dead bridge's set.
        // A phone that then opens its terminal again makes the new bridge
        // announce that SAME set, nothing joins, and there is no opening read
        // and no status -- a blank screen until the terminal prints, and then
        // only the part it printed. Emptying the set here makes that a join.
        pump?.setSubscriptions([])
        statusPump?.setSubscriptions([])
        break
      case 'error': {
        // Linked machines' to show when the bridge marks it so (`scope`) -- a
        // link room the relay cut, a link record it refused -- or when the
        // offer says so, for an error that names nothing: one raised while a
        // code for another computer is the bridge's offer -- its refusal, or a
        // wrong machine knocking. The status still goes: it is the whole
        // picture, and it may have moved.
        if (m.scope === 'link' || linkOfferLive()) tell = 'status'
        // A refusal answers the oldest request still waiting. Spent only after
        // the listeners, so they hear it under the owner it had.
        const ask = deps.isBridgeRunning() ? offerAsks[0] : undefined
        if (ask) {
          settle = () => {
            offerAsks = offerAsks.filter((a) => a !== ask)
          }
        }
        break
      }
      case 'linkJoined':
      case 'joinFailed':
      case 'linkCallResult':
      case 'peerRequest':
      case 'linkStateChanged':
      case 'linkBye':
        tell = 'none'
        break
      default:
        break
    }
    // Remote's events are about phones. While Remote is off the bridge runs for
    // Linked machines alone, and nothing it says is the phone pane's to show --
    // a relay error about a linked computer least of all.
    if (tell === 'all' && settings.enabled) push(() => deps.sendEvent(toEvent(m)))
    if (tell !== 'none') emitStatus()
    // Last, so a listener reading `desktopPeers()` or `attachedDeviceIds()`
    // already sees what this message changed. Each one guarded: this runs inside
    // the supervisor's emit loop too.
    for (const cb of [...linkedListeners]) push(() => cb(m))
    settle?.()
  }

  /** The bridge's init, built at the moment it is spawned -- see `startBridge`.
   *
   *  Both switches always travel. Absent `phones` means true to the bridge, so
   *  an init that left it out would open phone rooms on a machine that switched
   *  Remote off. */
  function initParams(secretKey: string): InitParams {
    // A respawn: the child before this one died holding whatever offer it held,
    // and owing answers it will never send. The FIRST spawn after `launch()`
    // keeps what was asked since -- a supervisor may spawn a beat after it is
    // told to, and a request posted in between went to this child.
    if (respawn) {
      offerAsks = []
      offerLive = null
    }
    respawn = true
    const linked = linkedState()
    launched = { phones: settings.enabled, linked: linked.enabled, links: linksKey(linked.links) }
    return {
      mcpPort: deps.mcpPort,
      mcpToken: deps.mcpToken,
      identitySecretKey: secretKey,
      devices,
      links: linked.links,
      phones: settings.enabled,
      linked: linked.enabled,
    }
  }

  /** Spawn the child with everything it needs to run unattended.
   *
   *  The secret key crosses this boundary and no other: `safeStorage` does not
   *  exist in a utilityProcess, so the child cannot read the identity for
   *  itself, and it must never travel to the renderer. */
  function launch(): void {
    pump?.stop()
    statusPump?.stop()
    // The pumps exist to stream terminals to a phone. A bridge running for
    // Linked machines alone has no phone to stream to, and reading terminals
    // anyway would charge every PTY write for a feature that is switched off.
    pump = settings.enabled ? newPump() : null
    statusPump = settings.enabled ? newStatusPump() : null
    // Whatever an earlier child held or was asked, this one starts with none.
    offerAsks = []
    offerLive = null
    respawn = false
    // Resolved here and not in the factory: the factory also runs inside the
    // supervisor's crash-respawn handler, where a throw from the key store would
    // have no caller to land on.
    const secretKey = ownIdentity().secretKey
    deps.startBridge(() => initParams(secretKey), settings.relayUrl)
  }

  function shutdown(): void {
    pump?.stop()
    pump = null
    statusPump?.stop()
    statusPump = null
    attached.clear()
    pairing = null
    offerAsks = []
    offerLive = null
    launched = null
    deps.stopBridge()
  }

  /** Bring the bridge in line with both switches.
   *
   *  It runs while Remote OR Linked machines is on. Which kinds of room it opens
   *  is fixed at init, so a change in which is on means a new bridge; a change
   *  in the link list alone is handed to the running one, which diffs it rather
   *  than dropping every live session. Returns whether the bridge was started,
   *  stopped or replaced. */
  function reconcile(linked: LinkedInit): boolean {
    if (!settings.enabled && !linked.enabled) {
      shutdown()
      return true
    }
    const running = deps.isBridgeRunning()
    if (
      running &&
      launched !== null &&
      launched.phones === settings.enabled &&
      launched.linked === linked.enabled
    ) {
      if (linksKey(linked.links) !== launched.links) post({ kind: 'setLinks', links: linked.links })
      return false
    }
    if (running) shutdown()
    launch()
    return true
  }

  function status(): RemoteStatusView {
    return {
      enabled: settings.enabled,
      // What the Remote pane means by running: phones can reach this desktop.
      // The bridge also runs for Linked machines alone, with no phone room open.
      running: deps.isBridgeRunning() && settings.enabled,
      disabled: deps.isDisabled(),
      relayUrl: settings.relayUrl,
      publicKey: ownIdentity().publicKey,
      // Computed at read time rather than cleared by a timer: a timer would have
      // to be cancelled on every path out of pairing, and forgetting one leaves a
      // stale callback holding this closure.
      pairing: pairing && pairing.expiresAt > Date.now() ? pairing : null,
      // Phones only. A linked computer is managed under Settings ▸ Linked
      // machines, and counted here it would light the Remote indicator for a
      // machine that is not a phone.
      devices: devices
        .filter((d) => d.kind !== 'desktop')
        .map((d) => ({
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

  /** The safety number for one device.
   *
   *  Computed here from the two public keys rather than asked of the child: it
   *  is a pure function of both identities, so a round trip would add a failure
   *  mode and answer nothing extra -- and it works while the phone is offline,
   *  which is exactly when the user reads it aloud to compare. */
  function verificationPhraseFor(deviceId: string): string | null {
    const device = devices.find((d) => d.id === deviceId)
    if (!device) return null
    return deriveVerificationPhrase(ownIdentity().publicKey, device.publicKey)
  }

  const port: LinkedBridgePort = {
    running: () => deps.isBridgeRunning() && launched?.linked === true,
    send: post,
    onMessage(cb) {
      linkedListeners.add(cb)
      return () => {
        linkedListeners.delete(cb)
      }
    },
    // Copies: the caller is another module, and the list is this host's record
    // of what the bridge last reported.
    desktopPeers: () =>
      devices.filter((d) => d.kind === 'desktop').map((d) => ({ ...d, capabilities: { ...d.capabilities } })),
    // Nothing is reachable through a bridge that is not running, whatever its
    // last words were: a crashed child never says goodbye.
    attachedDeviceIds: () => (deps.isBridgeRunning() ? new Set(attached) : new Set<string>()),
    verificationPhraseFor,
    relayUrl: () => settings.relayUrl,
    linkOfferLive,
  }

  return {
    start(): void {
      settings = loadRemoteSettings(deps.userDataDir)
      devices = loadRemoteDevices(deps.userDataDir)
      noteDesktops(devices)
      deps.onBridgeMessage(handle)
      started = true
      const linked = linkedState()
      linkedWasOn = linked.enabled
      if (settings.enabled || linked.enabled) launch()
    },

    stop(): void {
      started = false
      shutdown()
    },

    status,

    setEnabled(enabled: boolean): void {
      settings = saveRemoteSettings(deps.userDataDir, { enabled })
      // Re-arm first. The supervisor fails CLOSED on a crash loop and stays
      // that way, so without this the switch would do nothing at all until the
      // app restarted -- and say nothing about why.
      if (enabled) deps.clearDisabled()
      // Not a plain stop when switched off: the same bridge carries Linked
      // machines, and turning phones off must not cut the user's other
      // computers. It comes back without phone rooms instead.
      reconcile(linkedState())
      emitStatus()
    },

    setRelayUrl(url: string): void {
      const before = settings.relayUrl
      settings = saveRemoteSettings(deps.userDataDir, { relayUrl: url })
      // The child reads the URL once, at bootstrap, so a running bridge has to be
      // replaced to pick it up. A stopped one is left stopped: changing an address
      // is not a request to start listening on it.
      //
      // Only a real change is worth that: re-saving the address already in effect
      // -- or a malformed one the store refuses, which leaves the old value
      // standing -- would otherwise drop every connected phone for nothing.
      if (settings.relayUrl !== before && deps.isBridgeRunning()) {
        shutdown()
        launch()
      }
      emitStatus()
    },

    beginPairing(label: string, capabilities?: Capabilities): void {
      post({ kind: 'beginPairing', label, capabilities })
    },

    cancelPairing(): void {
      pairing = null
      // A code for another computer is Linked machines' to withdraw. The phone
      // dialog calls this whenever it closes, and the bridge's one offer may by
      // then be a code the user is halfway through carrying to another machine.
      if (!linkOfferLive()) post({ kind: 'cancelPairing' })
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

    verificationPhraseFor,

    noteTerminalOutput(terminalId: string): void {
      pump?.markDirty(terminalId)
      statusPump?.markDirty(terminalId)
    },

    noteTerminalClosed(terminalId: string): void {
      pump?.dropTerminal(terminalId)
      statusPump?.dropTerminal(terminalId)
    },

    refreshLinked(): void {
      if (!started) return
      const linked = linkedState()
      // Switching Linked machines on is the same explicit "try again" as
      // switching Remote on, so it re-arms a supervisor that gave up after a
      // crash loop. Only the switch does: a link list that changed while the
      // bridge is down is not a request to retry it.
      if (linked.enabled && !linkedWasOn) deps.clearDisabled()
      linkedWasOn = linked.enabled
      if (reconcile(linked)) emitStatus()
    },

    beginLinkPairing(label?: string): void {
      // Empty means "let the other computer name itself": the bridge then labels
      // the device from the joiner's hello, which carries its hostname, and the
      // user confirms or changes that name on both screens.
      post({ kind: 'beginPairing', label: label ?? '', link: true })
    },

    cancelLinkPairing(): void {
      if (linkOfferLive()) post({ kind: 'cancelPairing' })
    },

    linkedPort: () => port,
  }
}
