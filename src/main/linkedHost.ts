// Linked machines, wired into the running app: the one service that owns its
// state, answers its IPC, serves what linked computers ask of this one, and
// asks them on behalf of the `linked_machines` tool.
//
// Mirrors remoteHost.ts: a module singleton, IPC registered before it starts
// (Settings asks for status the moment it mounts), and every Electron
// dependency injected through the binding so all of it runs under vitest.
//
// It never starts or stops the bridge. Remote owns that lifecycle: this module
// says what it wants through `linkedInitForRemote()` and the bridge's
// `refresh()`, and hears everything the bridge says through the one port it
// subscribes to. The bridge is transport; this is policy (spec §5).
import { randomBytes } from 'crypto'
import { promises as fsp } from 'fs'
import { homedir } from 'os'
import { ok, err } from './ipcResult'
import type { ExecRequest, ExecResult } from './headlessExec'
import { isSafeModelId } from './modelCatalog'
import { inspectResult, riskBanner } from './mcpGateway/guard'
import {
  beginRemoteLinkPairing,
  cancelRemoteLinkPairing,
  refreshRemoteLinked,
  remoteLinkedPort,
} from './remoteHost'
import type { LinkedBridgePort, LinkedInit } from './remoteBridgeHost'
import {
  MAX_LINKED_MACHINES,
  type BridgeLink,
  type BridgeToHost,
  type HostToBridge,
  type LinkTarget,
  type PairedDevice,
  type PeerRequest,
} from './remoteBridge/protocol'
import { generateIdentity } from './remoteBridge/sealedChannel'
import { isBridgeLink, parseLinkCode } from './remoteBridge/linkCode'
import { localDesktopName } from './remoteBridge/desktopName'
import { sanitizeDeviceLabel } from './remoteBridge/deviceLabel'
import { loadLinkedSettings, saveLinkedSettings, type LinkedSettings } from './linkedSettings'
import {
  DEFAULT_GRANTS,
  DEFAULT_MACHINE_NAME,
  loadLinkedState,
  normalizeGrants,
  refOf,
  saveLinkedState,
  targetOf,
  type JoinedLink,
  type LinkedGrants,
  type LinkedState,
  type LinkMeta,
} from './linkedStore'
import { machineViews, pruneMeta, uniqueName, type LinkedMachineView } from './linkedDirectory'
import { createLinkedJobs, type LinkedActivity } from './linkedJobs'
import { createLinkedTool, type LinkedToolArgs } from './linkedTool'
// The renderer's own types, not a copy of them: what this module pushes and
// answers is exactly what Settings ▸ Linked machines reads, and a field either
// side renames fails the typecheck here instead of reaching the pane as
// undefined. Type-only, so nothing of the renderer is bundled into main.
import type { LinkedActivityView, LinkedEvent, LinkedStatusView } from '../renderer/src/types'

export type { LinkedActivityView, LinkedEvent, LinkedStatusView }

type AgentsInstalled = { claude: boolean; codex: boolean; gemini: boolean }

/** The bridge as this module reaches it. The app's is remoteHost's; a test
 *  stands in a fake. */
export interface LinkedBridgeAccess {
  port: LinkedBridgePort
  /** Re-read `linkedInitForRemote()` and bring the bridge in line. */
  refresh(): void
  beginLinkPairing(label?: string): void
  cancelLinkPairing(): void
}

export interface LinkedHostBinding {
  userDataDir: string
  /** This app's version, for `peerHello`. */
  version: string
  /** Push the whole picture. Two typed callbacks rather than one
   *  `send(channel, …)`, so the channel names are literals at the one call site
   *  that owns a BrowserWindow -- what the main<->preload guard scans for. */
  sendStatus(status: LinkedStatusView): void
  sendEvent(event: LinkedEvent): void
  /** runHeadless with deliver and the primer bound -- and NOT `remember`: text
   *  another machine asked for must not become a later run's primer. */
  runHeadless(req: ExecRequest): Promise<ExecResult>
  /** Which agents are installed here. Probed afresh on every call; cached here. */
  agentsInstalled(): Promise<AgentsInstalled>
  /** Test seams. */
  bridge?: LinkedBridgeAccess
  machineName?: string
  now?: () => number
}

/** Answered by every channel before the service has started -- which is every
 *  run where it never came up, since Settings asks regardless. A message, not a
 *  throw: an unhandled rejection in the renderer is a blank pane. */
export const LINKED_UNAVAILABLE = 'Linked machines is not running in this session'

/** The tool's answer while the feature is off -- or not started yet. Worded as
 *  linkedTool words it, so the agent hears one sentence either way. */
export const LINKED_TOOL_OFF = 'Linked machines is off. Turn it on under Settings ▸ Linked machines.'

export const LINKED_OFF = 'Linked machines is off. Turn on "Let this computer link with my other computers" first.'
export const LINKED_NOT_CONNECTED =
  'Linked machines is not connected to the relay. Switch it off and on again to retry.'
export const LINKED_CAP = `This computer already has ${MAX_LINKED_MACHINES} linked machines. Unlink one before linking another.`
export const LINKED_BAD_GRANTS = 'Permissions must be two booleans: run and write'
export const LINKED_BAD_CODE =
  'That is not a link code. Copy the whole code from Settings ▸ Linked machines on the other computer.'
export const LINKED_UNKNOWN_MACHINE = 'That computer is not linked with this one.'
export const LINKED_NAME_REQUIRED = 'A name is required'
export const LINKED_UNLINK_NEEDS_BRIDGE =
  'Turn Linked machines on first: the relay has to be told to drop a computer that entered a code from this one.'
export const LINKED_JOIN_NO_ANSWER =
  'No answer from the other computer. Check the code is still showing under Settings ▸ Linked machines there, then try again.'
export const LINKED_CODE_LOST =
  'The connection to the relay restarted, so that code no longer works. Create a new one.'
export const LINKED_JOIN_BAD_ANSWER =
  'The other computer answered with a link this computer cannot use. Create a new code and try again.'

/** How much longer than a linked call's own timeout main waits for the
 *  bridge's answer -- the bridge times the call out itself, so this only fires
 *  for a bridge that has stopped answering altogether. */
export const CALL_GRACE_MS = 5_000

/** The goodbye on unlink. Best effort: a machine that is offline or slow is
 *  unlinked here all the same, and must not hold the user's click for long. */
export const BYE_TIMEOUT_MS = 2_000

/** How long a join waits for any answer. The bridge gives up after 60 s
 *  (remoteBridge/entry.ts JOIN_TIMEOUT_MS) and says so; this is the backstop
 *  for a bridge that died holding the join and will never say anything. */
export const JOIN_ANSWER_TIMEOUT_MS = 65_000

/** Which agents are installed changes when the user installs one, not per
 *  request -- and each probe is a process spawn per agent. */
export const AGENTS_CACHE_MS = 5 * 60_000

/** What the injection guard inspects of another machine's answer. Above the
 *  200_000 chars an executor sends, so the guard never cuts a whole answer. */
export const INSPECT_MAX_CHARS = 210_000

/** Rows in the activity view, and how many are remembered behind them. */
export const ACTIVITY_ROWS = 20
const MAX_ACTIVITY = 100

/** Names of hosted machines the bridge dropped, kept a while for the goodbye
 *  that follows the device list announcing it. */
const MAX_GONE_NAMES = 32

interface PendingCall {
  resolve(data: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface PendingJoin {
  publicKey: string
  secretKey: string
  grants: LinkedGrants
  timer: ReturnType<typeof setTimeout>
}

interface LinkedHost {
  start(): void
  stop(): void
  status(): LinkedStatusView
  initForRemote(): LinkedInit
  toolCall(opts: LinkedToolArgs): Promise<unknown>
  setEnabled(input: unknown): unknown
  createCode(input: unknown): unknown
  cancelCode(): unknown
  join(input: unknown): unknown
  cancelJoin(): unknown
  confirm(input: unknown): unknown
  rename(input: unknown): unknown
  setGrants(input: unknown): unknown
  unlink(input: unknown): Promise<unknown>
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A field off an IPC payload, which may be anything at all. */
function field(input: unknown, key: string): unknown {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : undefined
}

const DEVICE_REF = 'device:'

/** The device id in a hosted machine's ref, or null for a joined link's. */
function hostedId(ref: string): string | null {
  return ref.startsWith(DEVICE_REF) ? ref.slice(DEVICE_REF.length) : null
}

/** The bridge's half of a joined link: everything but when it was made. */
function bridgeLinkOf(l: JoinedLink): BridgeLink {
  return { id: l.id, hostPublicKey: l.hostPublicKey, relayUrl: l.relayUrl, sessionRoomId: l.sessionRoomId, secretKey: l.secretKey }
}

/** The app's one bridge, which Remote owns. Its port is valid before Remote
 *  starts and across a Remote stop/start, so it is bound once. */
function appBridge(): LinkedBridgeAccess {
  return {
    port: remoteLinkedPort(),
    refresh: refreshRemoteLinked,
    beginLinkPairing: beginRemoteLinkPairing,
    cancelLinkPairing: cancelRemoteLinkPairing,
  }
}

function createLinkedHost(b: LinkedHostBinding): LinkedHost {
  const bridge = b.bridge ?? appBridge()
  const port = bridge.port
  const now = b.now ?? Date.now
  // Resolved once, like the bridge's own name for this machine: a syscall must
  // not fail on the path where another computer is waiting for an answer.
  const machineName = b.machineName ?? localDesktopName()

  let started = false
  let settings: LinkedSettings = { enabled: false }
  let state: LinkedState = { links: [], meta: [] }
  let unsubscribe: (() => void) | null = null
  /** The code on screen, as the bridge announced it. Shown only while the
   *  bridge still holds a link offer (`linkOfferLive`): a respawn, a phone QR
   *  or a pairing all end it over there whether or not anything says so here. */
  let code: { code: string; expiresAt: number } | null = null
  /** What the user chose, before the code was made, for the computer that
   *  enters it. Spent by that pairing: a grant chosen for one link is not
   *  consent for the next. */
  let codeGrants: LinkedGrants | null = null
  let join: PendingJoin | null = null
  /** Joined links whose room is attached. A dying bridge says no goodbye, so
   *  this is emptied on every `ready`. */
  const linkAttached = new Set<string>()
  /** Hosted machines being unlinked: hidden at once, refused at once, gone for
   *  good when the bridge's device list stops naming them. */
  const leaving = new Set<string>()
  const goneNames = new Map<string, string>()
  const calls = new Map<string, PendingCall>()
  let callSeq = 0
  /** Every job either way, by direction and id, oldest first. */
  const activity = new Map<string, LinkedActivity>()
  const lastActivity = new Map<string, number>()
  let agentsCache: { at: number; value: Promise<AgentsInstalled> } | null = null

  function guarded(fn: () => void): void {
    try {
      fn()
    } catch {
      /* the window is gone, or a bridge call failed: neither is the caller's fault */
    }
  }

  /** Push the whole picture -- while running: a job that winds down after
   *  `stop()` has nobody to tell. */
  function changed(): void {
    if (started) guarded(() => b.sendStatus(status()))
  }

  /** Every caller runs on a bridge message or an IPC call, neither of which
   *  reaches a stopped service. */
  function tell(event: LinkedEvent): void {
    guarded(() => b.sendEvent(event))
  }

  /** Post to the bridge. A no-op when it is down, like every send to it. */
  function send(msg: HostToBridge): void {
    guarded(() => port.send(msg))
  }

  /** Ask Remote to bring the bridge in line with this module's state. A bridge
   *  that fails to (re)start is not this module's failure: the status says it
   *  is not running, and the switch can be tried again. */
  function refresh(): void {
    guarded(() => bridge.refresh())
  }

  function save(): void {
    saveLinkedState(b.userDataDir, state)
  }

  function metaFor(ref: string): LinkMeta | undefined {
    return state.meta.find((m) => m.ref === ref)
  }

  // ── The directory ──────────────────────────────────────────────────────────

  /** Every linked machine but the ones on their way out. Online is attached
   *  right now: a hosted peer whose device room is attached, a joined link
   *  whose own room said so -- and nothing at all while the bridge is down. */
  function views(): LinkedMachineView[] {
    const running = port.running()
    const peers = port.desktopPeers()
    const attached = running ? port.attachedDeviceIds() : new Set<string>()
    const online = new Set<string>()
    for (const p of peers) if (attached.has(p.id)) online.add(refOf({ via: 'device', id: p.id }))
    if (running) for (const l of state.links) if (linkAttached.has(l.id)) online.add(refOf({ via: 'link', id: l.id }))
    return machineViews({
      peers: peers.map((p) => ({ id: p.id, label: p.label, pairedAt: p.pairedAt })),
      links: state.links,
      meta: state.meta,
      online,
      lastActivity,
    }).filter((v) => !leaving.has(v.ref))
  }

  /** The views as Settings shows them. A hosted machine still waiting for
   *  confirmation whose words were never written down -- its meta was lost --
   *  gets them from the two public keys, so it can still be confirmed. */
  function machines(): LinkedMachineView[] {
    return views().map((v) => {
      if (v.confirmed || v.phrase) return v
      const id = hostedId(v.ref)
      const phrase = id === null ? null : port.verificationPhraseFor(id)
      return phrase ? { ...v, phrase } : v
    })
  }

  function viewFor(ref: unknown): LinkedMachineView | undefined {
    return typeof ref === 'string' ? machines().find((v) => v.ref === ref) : undefined
  }

  /** The other machines' names, for `uniqueName`. */
  function takenNames(exceptRef: string): string[] {
    return views()
      .filter((v) => v.ref !== exceptRef)
      .map((v) => v.name)
  }

  /** Linked machines as the cap counts them: hosted and joined together, the
   *  ones still leaving included -- the bridge counts them until they are gone. */
  function linkCount(): number {
    return port.desktopPeers().length + state.links.length
  }

  /** Write one machine's meta, keeping only the known fields -- and the phrase
   *  only while it is unconfirmed. */
  function putMeta(next: LinkMeta): void {
    const clean: LinkMeta = {
      ref: next.ref,
      name: next.name,
      grants: { run: next.grants.run, write: next.grants.write },
      confirmed: next.confirmed,
      linkedAt: next.linkedAt,
      ...(!next.confirmed && next.phrase ? { phrase: next.phrase } : {}),
    }
    const others = state.meta.filter((m) => m.ref !== clean.ref)
    state = { links: state.links, meta: [...others, clean] }
    save()
  }

  /** A machine's meta, or one made from what the directory shows for it. */
  function metaOrView(view: LinkedMachineView): LinkMeta {
    return (
      metaFor(view.ref) ?? {
        ref: view.ref,
        name: view.name,
        grants: { ...view.grants },
        confirmed: view.confirmed,
        linkedAt: view.linkedAt,
        ...(view.phrase ? { phrase: view.phrase } : {}),
      }
    )
  }

  /** Keep the bridge's label for a hosted machine in step with its name, so
   *  `remote-devices.json` says the same as Settings. */
  function renameHosted(ref: string, name: string): void {
    const id = hostedId(ref)
    if (id !== null) send({ kind: 'renameDevice', deviceId: id, label: name })
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  function recentActivity(): LinkedActivityView[] {
    return [...activity.values()]
      .sort((x, y) => y.startedAt - x.startedAt)
      .slice(0, ACTIVITY_ROWS)
      .map((a) => ({
        id: a.id,
        direction: a.direction,
        machine: a.machine,
        agent: a.agent,
        summary: a.summary,
        status: a.status,
        startedAt: a.startedAt,
        ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
      }))
  }

  function status(): LinkedStatusView {
    const live = code && code.expiresAt > now() && port.linkOfferLive() ? { ...code } : null
    return {
      enabled: settings.enabled,
      running: settings.enabled && port.running(),
      relayUrl: port.relayUrl(),
      thisMachine: machineName || DEFAULT_MACHINE_NAME,
      code: live,
      joining: join !== null,
      machines: machines(),
      activity: recentActivity(),
    }
  }

  function noteActivity(a: LinkedActivity): void {
    const key = `${a.direction}:${a.id}`
    activity.set(key, { ...a })
    if (activity.size > MAX_ACTIVITY) activity.delete(activity.keys().next().value as string)
    const at = a.startedAt + (a.durationMs ?? 0)
    if (at > (lastActivity.get(a.ref) ?? 0)) lastActivity.set(a.ref, at)
    changed()
  }

  // ── Asking another machine ─────────────────────────────────────────────────

  /** One request over a link, answered by the bridge's `linkCallResult`.
   *  Rejects `Error(message)` -- 'offline' and 'timed out' are the bridge's
   *  own words, anything else the other machine's. */
  function callLinked(target: LinkTarget, request: PeerRequest, timeoutMs: number): Promise<unknown> {
    // A message to a bridge that is down is dropped, and would wait out its
    // whole timeout for an answer nothing will ever send.
    if (!started || !port.running()) return Promise.reject(new Error('offline'))
    const callId = `linked-${++callSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        calls.delete(callId)
        reject(new Error('timed out'))
      }, timeoutMs + CALL_GRACE_MS)
      calls.set(callId, { resolve, reject, timer })
      send({ kind: 'linkCall', callId, target, request, timeoutMs })
    })
  }

  /** Every call still waiting, answered now: the bridge that would have
   *  answered them is gone. */
  function failCalls(message: string): void {
    for (const [callId, call] of [...calls]) {
      calls.delete(callId)
      clearTimeout(call.timer)
      call.reject(new Error(message))
    }
  }

  function onCallResult(m: Extract<BridgeToHost, { kind: 'linkCallResult' }>): void {
    const call = calls.get(m.callId)
    // Late (already timed out), or a call a stopped service no longer waits on.
    if (!call) return
    calls.delete(m.callId)
    clearTimeout(call.timer)
    if (m.ok) call.resolve(m.data)
    else call.reject(new Error(m.message))
  }

  // ── Being asked ────────────────────────────────────────────────────────────

  /** The probe, at most once per AGENTS_CACHE_MS. The promise is what is
   *  cached, so a burst of hellos shares one probe; a failed probe is not
   *  remembered, so the next request tries again. */
  function agentsInstalled(): Promise<AgentsInstalled> {
    const at = now()
    if (agentsCache && at - agentsCache.at < AGENTS_CACHE_MS) return agentsCache.value
    const entry = { at, value: Promise.resolve().then(() => b.agentsInstalled()) }
    agentsCache = entry
    // Expired at once, so the next request probes again. Harmless when a
    // newer probe has replaced it already.
    entry.value.catch(() => {
      entry.at = Number.NEGATIVE_INFINITY
    })
    return entry.value
  }

  const jobs = createLinkedJobs({
    runHeadless: (req) => b.runHeadless(req),
    agentsInstalled,
    localName: () => machineName,
    version: b.version,
    homedir,
    // Asynchronous: this runs on the main thread, where a synchronous stat of
    // a slow disk stalls the whole app.
    isDirectory: async (p) => (await fsp.stat(p)).isDirectory(),
    isSafeModel: isSafeModelId,
    now,
    randomId: () => randomBytes(6).toString('hex'),
    onActivity: noteActivity,
  })

  async function serve(from: LinkTarget, request: PeerRequest): Promise<unknown> {
    const here = machineName || 'the other computer'
    if (!settings.enabled) throw new Error(`Linked machines is off on ${here}.`)
    const target = targetOf(refOf(from))
    if (!target) throw new Error('Malformed linked-machine request.')
    const ref = refOf(target)
    if (leaving.has(ref)) throw new Error(`${here} has unlinked this computer.`)
    // No meta is a machine whose pairing finished a moment ago: handle() serves
    // it as unconfirmed, which is exactly what it is.
    return jobs.handle(target, metaFor(ref) as LinkMeta, request)
  }

  function onPeerRequest(m: Extract<BridgeToHost, { kind: 'peerRequest' }>): void {
    void serve(m.from, m.request).then(
      (data) => send({ kind: 'peerReply', callId: m.callId, ok: true, data }),
      (e: unknown) => send({ kind: 'peerReply', callId: m.callId, ok: false, message: messageOf(e) }),
    )
  }

  const tool = createLinkedTool({
    call: callLinked,
    machines,
    enabled: () => settings.enabled,
    localName: () => machineName,
    inspect: (text, machine, agent) => riskBanner(inspectResult(text, INSPECT_MAX_CHARS), machine, agent),
    onActivity: noteActivity,
    now,
  })

  // ── What the bridge says ───────────────────────────────────────────────────

  /** A bridge that has just started: whatever the last one held -- calls in
   *  flight, attached links, the code it was offering -- went with it. */
  function onReady(): void {
    failCalls('offline')
    linkAttached.clear()
    // A code arrives after its bridge's `ready`, so a `ready` after a code is
    // a new bridge -- and the code went with the old one. Said, because the
    // code vanishing from the screen explains nothing.
    if (code && code.expiresAt > now()) tell({ kind: 'error', message: LINKED_CODE_LOST })
    code = null
    // An unlink whose revoke the dead bridge may never have applied: say it
    // again, or the machine comes back with its room.
    for (const p of port.desktopPeers()) {
      if (leaving.has(refOf({ via: 'device', id: p.id }))) send({ kind: 'revokeDevice', deviceId: p.id })
    }
    changed()
  }

  function onPairingCode(m: Extract<BridgeToHost, { kind: 'pairingCode' }>): void {
    if (typeof m.linkCode === 'string') {
      code = { code: m.linkCode, expiresAt: m.expiresAt }
      changed()
    } else if (code) {
      // A phone QR replaced it: the bridge holds one offer at a time.
      code = null
      changed()
    }
  }

  /** A computer entered this machine's code. Its meta is written now, with the
   *  grants chosen before the code was made; the words follow in their own
   *  message, and the device list after that. */
  function onHostedPaired(device: PairedDevice): void {
    code = null
    const ref = refOf({ via: 'device', id: device.id })
    if (!metaFor(ref)) {
      putMeta({
        ref,
        name: uniqueName(takenNames(ref), device.label),
        grants: codeGrants ?? { ...DEFAULT_GRANTS },
        confirmed: false,
        linkedAt: now(),
      })
    }
    codeGrants = null
    changed()
  }

  function onPhrase(deviceId: string, phrase: string): void {
    const ref = refOf({ via: 'device', id: deviceId })
    const meta = metaFor(ref)
    // A phone's words, or a computer already confirmed: neither is ours to ask about.
    if (!meta || meta.confirmed || !phrase) return
    putMeta({ ...meta, phrase })
    tell({ kind: 'pending', ref, phrase, suggestedName: meta.name })
    changed()
  }

  /** The bridge's device list is the truth about hosted machines: meta for a
   *  device it no longer has goes, and so does an unlink it has finished. */
  function onDevicesChanged(): void {
    const peers = port.desktopPeers()
    const listed = new Set(peers.map((p) => refOf({ via: 'device', id: p.id })))
    for (const ref of [...leaving]) if (!listed.has(ref)) leaving.delete(ref)
    const kept = pruneMeta(
      state.meta,
      peers.map((p) => ({ id: p.id, label: p.label, pairedAt: p.pairedAt })),
      state.links,
    )
    if (kept.length !== state.meta.length) {
      for (const m of state.meta) {
        if (kept.includes(m)) continue
        goneNames.set(m.ref, m.name)
        if (goneNames.size > MAX_GONE_NAMES) goneNames.delete(goneNames.keys().next().value as string)
      }
      state = { links: state.links, meta: kept }
      save()
    }
    changed()
  }

  function endJoin(): void {
    if (!join) return
    clearTimeout(join.timer)
    join = null
  }

  /** The join this machine started has finished: keep the link with the key
   *  minted for it, and ask the user to compare the words. */
  function onLinkJoined(m: Extract<BridgeToHost, { kind: 'linkJoined' }>): void {
    // A join this machine replaced or gave up on is answered too; only the
    // current one's key is ours to keep.
    if (!join || m.publicKey !== join.publicKey) return
    const pending = join
    endJoin()
    const link: JoinedLink = {
      id: m.deviceId,
      hostPublicKey: m.hostPublicKey,
      relayUrl: m.relayUrl,
      sessionRoomId: m.sessionRoomId,
      secretKey: pending.secretKey,
      linkedAt: now(),
    }
    const phrase = m.phrase
    // Checked as the store will check it on the next load: a link that would
    // not survive a restart must not be kept now.
    if (!isBridgeLink(link) || !phrase) {
      tell({ kind: 'error', message: LINKED_JOIN_BAD_ANSWER })
      changed()
      return
    }
    const ref = refOf({ via: 'link', id: link.id })
    // No name from the host: uniqueName falls back to 'Computer'.
    const name = uniqueName(takenNames(ref), m.hostName ?? '')
    state = {
      links: [...state.links.filter((l) => l.id !== link.id), link],
      meta: state.meta.filter((x) => x.ref !== ref),
    }
    putMeta({ ref, name, grants: pending.grants, confirmed: false, linkedAt: link.linkedAt, phrase })
    // The bridge dials the new room now, so it is open by the time the user
    // has compared the words.
    refresh()
    tell({ kind: 'pending', ref, phrase, suggestedName: name })
    changed()
  }

  function onJoinFailed(message: string): void {
    if (!join) return
    endJoin()
    tell({ kind: 'error', message })
    changed()
  }

  function onJoinTimeout(): void {
    join = null
    send({ kind: 'cancelJoin' })
    tell({ kind: 'error', message: LINKED_JOIN_NO_ANSWER })
    changed()
  }

  function onLinkState(id: string, attached: boolean): void {
    if (attached) linkAttached.add(id)
    else linkAttached.delete(id)
    changed()
  }

  /** The other machine unlinked this one. The bridge has dropped its side
   *  already; a joined link is forgotten here, a hosted one went with the
   *  device list that came first. */
  function onBye(from: LinkTarget): void {
    const target = targetOf(refOf(from))
    if (!target) return
    const ref = refOf(target)
    const name = metaFor(ref)?.name ?? goneNames.get(ref)
    // It threw its key away; what it started here is nobody's to collect.
    jobs.revoke(target, null)
    if (target.via === 'link' && state.links.some((l) => l.id === target.id)) {
      state = {
        links: state.links.filter((l) => l.id !== target.id),
        meta: state.meta.filter((m) => m.ref !== ref),
      }
      linkAttached.delete(target.id)
      save()
      refresh()
    }
    lastActivity.delete(ref)
    tell({
      kind: 'error',
      message: name ? `"${name}" unlinked this computer.` : 'A linked computer unlinked this computer.',
    })
    changed()
  }

  function onBridge(m: BridgeToHost): void {
    switch (m.kind) {
      case 'ready':
        return onReady()
      case 'pairingCode':
        return onPairingCode(m)
      case 'paired':
        if (m.device.kind === 'desktop') onHostedPaired(m.device)
        return
      case 'verificationPhrase':
        return onPhrase(m.deviceId, m.phrase)
      case 'devicesChanged':
        return onDevicesChanged()
      case 'deviceConnected':
      case 'deviceDisconnected':
        if (port.desktopPeers().some((p) => p.id === m.deviceId)) changed()
        return
      case 'linkJoined':
        return onLinkJoined(m)
      case 'joinFailed':
        return onJoinFailed(m.message)
      case 'linkCallResult':
        return onCallResult(m)
      case 'peerRequest':
        return onPeerRequest(m)
      case 'linkStateChanged':
        return onLinkState(m.id, m.attached)
      case 'linkBye':
        return onBye(m.from)
      case 'error':
        // Ours when the bridge says so, or when the offer it holds is a code
        // for another computer -- its refusal, or a wrong machine knocking.
        // Read now: the port stops saying so once the error is delivered.
        if (m.scope === 'link' || port.linkOfferLive()) {
          tell({ kind: 'error', message: m.message })
          changed()
        }
        return
      default:
        return
    }
  }

  // ── What the user does ─────────────────────────────────────────────────────

  /** Let go of everything that needs the bridge: it is about to stop, or to
   *  come back without linked rooms. */
  function quiesce(): void {
    jobs.cancelAll()
    failCalls('offline')
    code = null
    codeGrants = null
    endJoin()
    linkAttached.clear()
  }

  function setEnabled(input: unknown): unknown {
    // `=== true`, so a malformed payload turns it OFF: the safe direction for a
    // switch that lets another computer start agents here.
    settings = { enabled: field(input, 'enabled') === true }
    saveLinkedSettings(b.userDataDir, settings)
    if (!settings.enabled) quiesce()
    refresh()
    changed()
    return ok(status())
  }

  /** Why a new link cannot be made right now, or null when it can. */
  function cannotLink(): string | null {
    if (!settings.enabled) return LINKED_OFF
    // Checked first: a request posted to a bridge that is down is dropped, and
    // the pane would wait for a code nothing is making.
    if (!port.running()) return LINKED_NOT_CONNECTED
    if (linkCount() >= MAX_LINKED_MACHINES) return LINKED_CAP
    return null
  }

  function createCode(input: unknown): unknown {
    const grants = normalizeGrants(field(input, 'grants'))
    if (!grants) return err(LINKED_BAD_GRANTS)
    const refusal = cannotLink()
    if (refusal) return err(refusal)
    codeGrants = grants
    // The bridge replaces any code it holds; the old one is spent from here.
    code = null
    // Unnamed: the joiner's hello carries its own name, which the user then
    // confirms or changes on both screens.
    guarded(() => bridge.beginLinkPairing())
    changed()
    return ok(status())
  }

  function cancelCode(): unknown {
    guarded(() => bridge.cancelLinkPairing())
    code = null
    codeGrants = null
    changed()
    return ok(status())
  }

  function joinLink(input: unknown): unknown {
    const grants = normalizeGrants(field(input, 'grants'))
    if (!grants) return err(LINKED_BAD_GRANTS)
    const text = field(input, 'code')
    if (typeof text !== 'string' || !parseLinkCode(text)) return err(LINKED_BAD_CODE)
    const refusal = cannotLink()
    if (refusal) return err(refusal)
    endJoin()
    // A fresh keypair for this one link, minted here because the bridge has no
    // key store; the secret stays in main until the link is kept.
    const keys = generateIdentity()
    join = { publicKey: keys.publicKey, secretKey: keys.secretKey, grants, timer: setTimeout(onJoinTimeout, JOIN_ANSWER_TIMEOUT_MS) }
    send({ kind: 'joinLink', code: text, secretKey: keys.secretKey, label: machineName })
    changed()
    return ok(status())
  }

  function cancelJoin(): unknown {
    endJoin()
    send({ kind: 'cancelJoin' })
    changed()
    return ok(status())
  }

  function confirm(input: unknown): unknown {
    const view = viewFor(field(input, 'ref'))
    if (!view) return err(LINKED_UNKNOWN_MACHINE)
    const typed = sanitizeDeviceLabel(field(input, 'name'))
    const name = uniqueName(takenNames(view.ref), typed || view.name)
    putMeta({ ...metaOrView(view), name, confirmed: true })
    renameHosted(view.ref, name)
    tell({ kind: 'linked', ref: view.ref, name })
    changed()
    return ok(status())
  }

  function rename(input: unknown): unknown {
    const view = viewFor(field(input, 'ref'))
    if (!view) return err(LINKED_UNKNOWN_MACHINE)
    const typed = sanitizeDeviceLabel(field(input, 'name'))
    if (!typed) return err(LINKED_NAME_REQUIRED)
    const name = uniqueName(takenNames(view.ref), typed)
    putMeta({ ...metaOrView(view), name })
    renameHosted(view.ref, name)
    changed()
    return ok(status())
  }

  function setGrants(input: unknown): unknown {
    const grants = normalizeGrants(field(input, 'grants'))
    if (!grants) return err(LINKED_BAD_GRANTS)
    const view = viewFor(field(input, 'ref'))
    if (!view) return err(LINKED_UNKNOWN_MACHINE)
    putMeta({ ...metaOrView(view), grants })
    // A permission switched off stops what it allowed, not only what comes next.
    jobs.revoke(targetOf(view.ref) as LinkTarget, grants)
    changed()
    return ok(status())
  }

  async function unlink(input: unknown): Promise<unknown> {
    const view = viewFor(field(input, 'ref'))
    if (!view) return err(LINKED_UNKNOWN_MACHINE)
    const target = targetOf(view.ref) as LinkTarget
    // Only the bridge can drop a hosted machine: it owns the device registry,
    // and a record removed anywhere else comes back with the next device list.
    if (target.via === 'device' && !port.running()) return err(LINKED_UNLINK_NEEDS_BRIDGE)
    // The goodbye goes first: once this side lets go there is no room left to
    // say it in. Best effort -- offline or slow, the machine is unlinked here.
    if (port.running()) await callLinked(target, { kind: 'peerBye' }, BYE_TIMEOUT_MS).catch(() => undefined)
    // Stopped while waiting -- the app is quitting. Nothing more is written.
    if (!started) return err(LINKED_UNAVAILABLE)
    const ref = view.ref
    // What it has running here goes with it: an unlinked machine's agent does
    // not get to finish editing files on this one.
    jobs.revoke(target, null)
    if (target.via === 'device') {
      // Refused from now on, and hidden until the bridge's device list stops
      // naming it -- not shown as a fresh, unconfirmed machine in between.
      leaving.add(ref)
      state = { links: state.links, meta: state.meta.filter((m) => m.ref !== ref) }
      save()
      send({ kind: 'revokeDevice', deviceId: target.id })
    } else {
      state = {
        links: state.links.filter((l) => l.id !== target.id),
        meta: state.meta.filter((m) => m.ref !== ref),
      }
      linkAttached.delete(target.id)
      save()
      refresh()
    }
    lastActivity.delete(ref)
    changed()
    return ok(status())
  }

  return {
    start(): void {
      settings = loadLinkedSettings(b.userDataDir)
      state = loadLinkedState(b.userDataDir)
      // Once, for the life of the service: the port outlives Remote's own
      // stop/start, and hears a bridge whichever feature started it.
      unsubscribe = port.onMessage(onBridge)
      started = true
      // The state the bridge is started from is loaded now. A no-op while
      // Remote has not started -- its own start reads linkedInitForRemote().
      refresh()
      changed()
    },

    stop(): void {
      started = false
      unsubscribe?.()
      unsubscribe = null
      jobs.cancelAll()
      failCalls('offline')
      endJoin()
    },

    status,

    initForRemote: () => ({ enabled: settings.enabled, links: state.links.map(bridgeLinkOf) }),

    toolCall: (opts) => tool.call(opts),

    setEnabled,
    createCode,
    cancelCode,
    join: joinLink,
    cancelJoin,
    confirm,
    rename,
    setGrants,
    unlink,
  }
}

let host: LinkedHost | null = null

/** Load the state, subscribe to the bridge and start serving. Idempotent. */
export function startLinkedHost(binding: LinkedHostBinding): void {
  if (host) return
  // Assigned before start(): start() asks the bridge to refresh, and the
  // bridge asks `linkedInitForRemote()` -- which has to find this host.
  host = createLinkedHost(binding)
  host.start()
}

/** Stop every job and call. For quit: a delegated run must not outlive the app. */
export function stopLinkedHost(): void {
  host?.stop()
  host = null
}

/** The `linked_machines` MCP tool. Safe before start: it then answers that
 *  the feature is off, as data, never a throw. */
export function linkedToolCall(opts: LinkedToolArgs): Promise<unknown> {
  return host ? host.toolCall(opts) : Promise.resolve({ error: LINKED_TOOL_OFF })
}

/** Linked machines' half of the bridge's init. Synchronous and cheap: Remote
 *  asks it at every bridge start and from inside the supervisor's crash
 *  respawn, so it answers from memory. Off until the service has started. */
export function linkedInitForRemote(): LinkedInit {
  return host ? host.initForRemote() : { enabled: false, links: [] }
}

export interface LinkedIpcLike {
  handle(channel: string, listener: (event: unknown, input?: unknown) => unknown): void
}

/**
 * Register the linked channels. Safe before start -- each handler resolves the
 * singleton when it is called, because `index.ts` registers IPC during
 * bootstrap and starts the service only once the MCP port is bound.
 */
export function registerLinkedIpc(ipc: LinkedIpcLike): void {
  const on = (channel: string, fn: (h: LinkedHost, input: unknown) => unknown): void => {
    ipc.handle(channel, (_e, input) => (host ? fn(host, input) : err(LINKED_UNAVAILABLE)))
  }
  on('linked:status', (h) => ok(h.status()))
  on('linked:set-enabled', (h, input) => h.setEnabled(input))
  on('linked:create-code', (h, input) => h.createCode(input))
  on('linked:cancel-code', (h) => h.cancelCode())
  on('linked:join', (h, input) => h.join(input))
  on('linked:cancel-join', (h) => h.cancelJoin())
  on('linked:confirm', (h, input) => h.confirm(input))
  on('linked:rename', (h, input) => h.rename(input))
  on('linked:set-grants', (h, input) => h.setGrants(input))
  on('linked:unlink', (h, input) => h.unlink(input))
}

/** @internal test-only */
export function _resetLinkedHostForTests(): void {
  host?.stop()
  host = null
}
