import { AppState } from 'react-native'
import { create } from 'zustand'
import { RelaySocket, type RelayState, type SocketLike } from '../net/relaySocket'
import { RemoteSession, type StatusUpdate } from '../net/remoteSession'
import { pairWithDesktop } from '../net/pairingClient'
import {
  addPairing,
  loadBook,
  newIdentity,
  publicKeyOf,
  publicPairing,
  removePairing,
  setActivePairing,
  wipeEverything,
  writePairing,
  MAX_PAIRINGS,
  type PairedDesktop,
  type StoredPairing,
} from '../storage/identity'
import { parseQrPayload } from '../wire/qr'
import { deriveVerificationPhrase } from '../wire/safetyNumber'
import { sanitizeDeviceLabel } from '../wire/deviceLabel'
import { Handshake } from '../wire/sessionCrypto'
import {
  NO_CAPABILITIES,
  parseCapabilities,
  parseTerminalList,
  type Capabilities,
  type RemoteRequest,
  type TerminalSummary,
} from '../wire/protocol'

/** Android fires `change` far more eagerly than iOS: a task-switcher swipe can
 *  produce several in a row, and one dial each is a reconnect storm against a
 *  relay that answers 409 to the duplicate. */
export const FOREGROUND_DEBOUNCE_MS = 250

/** How long the unpair goodbye stays outstanding before the session gives up on
 *  it.
 *
 *  Nothing on this phone waits for it -- see `sayGoodbye` -- so this does not
 *  bound a button, it bounds the pending-request entry the goodbye leaves
 *  behind. Far below the 20s a normal request gets, because that entry names a
 *  desktop this phone has just erased its key for: the reply can no longer be
 *  read even if it arrives, so holding the slot open for twenty seconds would
 *  be waiting on something that cannot matter. */
export const GOODBYE_TIMEOUT_MS = 2_000

/** The view only ever shows the tail, and a phone cannot hold a day of agent
 *  output. Trimming the head is what keeps a long session out of an OOM. */
export const MAX_OUTPUT_CHARS = 200_000

interface RemoteState {
  /** The relay connection, as the socket reports it. */
  status: RelayState
  /** Every desktop this phone is paired with, in the order they were paired.
   *
   *  Redacted -- the private keys stay in the vault below. A screen that could
   *  read one off the store is one `JSON.stringify` away from putting this
   *  phone's authority into a log. */
  pairings: PairedDesktop[]
  /** The one being shown, and the only one with a live connection. Null only
   *  when `pairings` is empty. */
  paired: PairedDesktop | null
  /** Compare it with the desktop's. Matching phrases are what rule out a relay
   *  that put itself in the middle. */
  safetyPhrase: string | null
  terminals: TerminalSummary[]
  /** What the desktop says this phone may do. Display only -- the desktop
   *  re-checks every request against its own record -- but a screen offering a
   *  control the desktop will refuse is worse than one that offers nothing. */
  capabilities: Capabilities
  output: Record<string, string>
  /** Per terminal, the desktop-stream offset that `output` currently ends at.
   *
   *  The desktop numbers its edits against the whole stream it has produced,
   *  and this phone's copy is not that stream: its head is trimmed at
   *  MAX_OUTPUT_CHARS and gap notices are spliced in where output was lost. One
   *  number is enough to translate between the two, because both only ever grow
   *  at the end -- and being an END anchor is why trimming the head leaves it
   *  alone. */
  outputEnd: Record<string, number>
  agentStatus: Record<string, StatusUpdate>
  /** True whenever what is on screen is not being kept current. */
  stale: boolean
  error: string | null

  boot(): Promise<void>
  pairFromQr(raw: string, label: string): Promise<void>
  /** Put a different paired desktop on screen. */
  selectDesktop(desktopPublicKey: string): Promise<void>
  /** Rename one, for the switcher. Local to this phone; the desktop is not told
   *  and does not care. */
  renameDesktop(desktopPublicKey: string, label: string): Promise<void>
  /** Forget one desktop and erase this phone's key for it. */
  forgetDesktop(desktopPublicKey: string): Promise<void>
  /** Forget the desktop currently on screen. What Settings calls unpairing. */
  unpair(): Promise<void>
  refreshTerminals(): Promise<void>
  refreshCapabilities(): Promise<void>
  subscribe(terminalId: string): Promise<void>
  unsubscribe(terminalId: string): Promise<void>
  send(terminalId: string, text: string): Promise<void>
  runCommand(terminalId: string, command: string): Promise<void>
  createTerminal(name: string, cwd?: string): Promise<void>
  closeTerminal(terminalId: string): Promise<void>
}

/** The live connection. Not state: a socket is not renderable, and re-rendering
 *  on its internals would repaint the terminal view on every frame. */
let socket: RelaySocket | null = null
let session: RemoteSession | null = null
/** Every pairing, secrets included, kept out of the store for the reason given
 *  on `RemoteState.pairings`. Insertion-ordered, seeded from the stored index,
 *  and `Map.set` on an existing key keeps its position -- so re-pairing a known
 *  desktop updates its row in place instead of making the list jump. */
let vault = new Map<string, StoredPairing>()
/** The desktop on screen, and the source of truth for which one that is.
 *
 *  Held here rather than read back out of `state.paired`, so the connection
 *  layer never has to ask a React store which machine it is talking to, and so
 *  the key it needs is one property away. */
let active: StoredPairing | null = null
let appStateSub: { remove(): void } | null = null
let foregroundTimer: ReturnType<typeof setTimeout> | null = null

export const useRemoteStore = create<RemoteState>((set, get) => {
  /** Every action that needs the desktop passes through here.
   *
   *  Nothing is ever queued. Work must not silently execute later: a runCommand
   *  buffered through an outage and fired on reconnect is arbitrary shell
   *  execution at a moment the user has stopped expecting it. */
  /** Refuse a request AND say why on screen.
   *
   *  Every screen swallows the rejection (`.catch(() => undefined)`) and reads the
   *  banner instead, so a refusal that only threw was a button that did nothing at
   *  all -- no output, no error, no clue. */
  function refuse(message: string): never {
    set({ error: message })
    throw new Error(message)
  }

  async function ask<T>(request: RemoteRequest): Promise<T> {
    const { paired, stale } = get()
    if (paired === null) refuse('This phone is not paired with a desktop yet.')
    if (session === null || stale) {
      refuse('The desktop is offline. Reconnect before sending anything.')
    }
    try {
      return await session.request<T>(request)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ error: message })
      throw err
    }
  }

  /** Tell the desktop this phone is unpairing. Best effort, by design.
   *
   *  Unpairing is a local act and has to succeed with the desktop switched
   *  off, on another network, or running a version that has never heard of
   *  this request. So this never throws, never sets `error`, and never stops
   *  the erase -- deliberately NOT `ask`, which surfaces a failure to the user.
   *  "The desktop is offline" is a true sentence and the wrong thing to say to
   *  someone who just asked to forget it.
   *
   *  When it does fail, all that survives is a row on a desktop the phone can
   *  no longer reach. Untidy, not unsafe: the key that row names is gone from
   *  this handset either way, so nothing can authenticate as it again. */
  function sayGoodbye(): void {
    if (session === null || get().stale) return
    // NOT awaited, and the ordering that makes that safe is deliberate: the
    // frame is handed to the socket inside this call, synchronously, before the
    // promise it returns is ever suspended on. So the goodbye is on the wire
    // before `disconnect()` runs on the next line of the caller.
    //
    // Awaiting instead would mean an Unpair button that sits there while a
    // desktop that is never going to answer runs down the clock. Nothing about
    // what happens on this phone depends on the reply.
    session.request<unknown>({ kind: 'unpair' }, GOODBYE_TIMEOUT_MS).catch(() => {
      // Offline, timed out, a pre-1.40 desktop answering "unknown request", or
      // simply the session being torn down underneath it by the disconnect that
      // follows. All four are expected, and none of them change what happens
      // next -- but the rejection still has to be caught, or an unpair with the
      // desktop switched off raises an unhandled rejection.
    })
  }

  function connect(desktop: StoredPairing): void {
    if (socket !== null) return

    const live = new RemoteSession({
      send: (plaintext) => socket?.send(plaintext),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    })
    session = live

    live.onOutput((chunks) => {
      set((prev) => {
        const output = { ...prev.output }
        const outputEnd = { ...prev.outputEnd }
        for (const c of chunks) {
          const held = output[c.terminalId] ?? ''
          const heldEnd = outputEnd[c.terminalId] ?? 0
          // The marker rides on the FIRST piece of a split chunk only, so
          // appending it whenever it is present renders the gap exactly once.
          const gap = c.missed > 0 && c.marker !== null ? c.marker : ''

          // A numeric `replaceFrom` means the desktop redrew rather than added:
          // the status line that ticks in place, which appending would stack up
          // sixty deep. Translate its stream offset into this copy, where the
          // same position sits `heldEnd - replaceFrom` chars back from the end.
          // Clamped low because the redraw may reach into a head this phone has
          // already trimmed, and high because a phone that subscribed late is
          // holding nothing the offset can point into; both degrade to an
          // append, which is what this did before the field existed.
          const keep =
            c.replaceFrom === null
              ? held.length
              : Math.min(held.length, Math.max(0, held.length - (heldEnd - c.replaceFrom)))

          const joined = held.slice(0, keep) + gap + c.chunk
          output[c.terminalId] =
            joined.length > MAX_OUTPUT_CHARS ? joined.slice(joined.length - MAX_OUTPUT_CHARS) : joined
          // Absolute when the desktop gave an anchor, so a wrong guess corrects
          // itself on the next redraw instead of drifting for the session.
          outputEnd[c.terminalId] =
            c.replaceFrom === null
              ? heldEnd + c.missed + c.chunk.length
              : c.replaceFrom + c.chunk.length
        }
        return { output, outputEnd }
      })
    })

    live.onStatus((update) => {
      set((prev) => ({ agentStatus: { ...prev.agentStatus, [update.terminalId]: update } }))
    })

    // The desktop pushes this when the user edits the grants. Taking it means a
    // capability withdrawn on the desktop stops being offered here at once,
    // rather than at whatever moment the user next taps the control and reads a
    // refusal.
    live.onCapabilities((caps) => {
      // A grant is retroactive, and only `read` gates content this store has
      // already fetched. The desktop refuses `listTerminals` without it, so a
      // phone that connected before the grant is holding an empty list AND the
      // refusal that produced it. Setting the flag alone leaves both on screen
      // until something unrelated happens to refresh -- which is exactly the
      // "I gave it read and it still says there are no terminals" report.
      // createTerminal and writeToTerminal need no equivalent: they gate
      // controls that read the flag live, so they correct themselves.
      const gainedRead = caps.read && !get().capabilities.read
      set({ capabilities: caps })
      if (!gainedRead) return
      // Clear the refusal before retrying rather than after: if the retry fails
      // for some other reason, `ask` writes that reason and the user sees the
      // real one instead of the stale capability message.
      set({ error: null })
      void get().refreshTerminals().catch(() => {
        // `ask` has already put the reason in the banner.
      })
    })

    socket = new RelaySocket({
      url: desktop.relayUrl,
      // The STORED room, never one recomputed here. Recomputing would look right
      // until an identity change made the two ends disagree in silence.
      roomId: desktop.sessionRoomId,
      open: (url) => new WebSocket(url) as unknown as SocketLike,
      // A factory: one ephemeral key per attachment is what makes a recorded
      // session unreadable after the fact.
      // This phone's key for THIS desktop. Each pairing has its own, so the
      // wrong one here would be a handshake the desktop cannot complete rather
      // than a silent cross-connection.
      handshake: () => new Handshake('device', desktop.secretKey, desktop.desktopPublicKey),
      onFrame: (plaintext) => live.handleFrame(plaintext),
      onControl: () => undefined,
      onState: (next) => {
        const attached = next === 'attached'
        if (!attached) live.reset('The connection dropped.')
        // The banner clears on ATTACH, not on the next successful request. The
        // message the user is reading describes a connection that no longer
        // exists, so leaving it up means a phone fresh out of a tunnel shows a
        // live terminal list underneath "The desktop is offline."
        set({ status: next, stale: !attached, error: attached ? null : get().error })
        // Whatever is on screen was true for the last connection. The list is
        // the cheapest thing to re-establish and everything else hangs off it.
        //
        // Capabilities are re-asked here and not merely taken from the push:
        // grants change while the phone is in a tunnel, and the push for that
        // edit was dropped at a desktop with nobody attached to send it to.
        if (attached) {
          void get().refreshCapabilities().catch(() => undefined)
          void get().refreshTerminals().catch(() => undefined)
        }
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    })
    socket.connect()
  }

  function disconnect(): void {
    socket?.close()
    socket = null
    session?.reset('The app went to the background.')
    session = null
    set({ stale: true, status: 'offline' })
  }

  function watchAppState(): void {
    if (appStateSub !== null) return
    appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        // A socket held in the background is a radio kept awake for frames
        // nobody is looking at, and the relay's idle timer cuts it anyway.
        // 'inactive' is deliberately NOT included: iOS fires it for a
        // notification-shade pull, and reconnecting on every glance is worse
        // than holding a socket through one.
        if (foregroundTimer !== null) {
          clearTimeout(foregroundTimer)
          foregroundTimer = null
        }
        disconnect()
        return
      }
      if (next !== 'active') return
      if (foregroundTimer !== null) clearTimeout(foregroundTimer)
      foregroundTimer = setTimeout(() => {
        foregroundTimer = null
        if (active !== null) connect(active)
      }, FOREGROUND_DEBOUNCE_MS)
    })
  }

  /** Publish the vault and the active desktop to the screen.
   *
   *  The one place `pairings`, `paired` and `safetyPhrase` are written, so they
   *  cannot drift apart -- a phrase belonging to a desktop that is no longer the
   *  active one is the exact failure the safety words exist to catch. */
  function present(): void {
    set({
      pairings: [...vault.values()].map(publicPairing),
      paired: active === null ? null : publicPairing(active),
      safetyPhrase:
        active === null
          ? null
          : deriveVerificationPhrase(publicKeyOf(active), active.desktopPublicKey),
    })
  }

  /** Drop everything on screen that belonged to one desktop.
   *
   *  Terminals, buffered output, agent status and grants are all statements
   *  about a particular machine. Carrying any of them into another desktop's
   *  view would show somebody else's terminals -- and a grant carried across
   *  would enable a control the new desktop has not allowed. */
  function clearDesktopView(): void {
    set({
      terminals: [],
      capabilities: { ...NO_CAPABILITIES },
      output: {},
      outputEnd: {},
      agentStatus: {},
      error: null,
    })
  }

  /** Two machines reporting the same hostname is ordinary -- a laptop and its
   *  VM, two fresh Ubuntu installs -- and two identical rows is a switcher that
   *  cannot be used. Numbered rather than refused, because the user can rename
   *  either one afterwards. */
  function uniqueLabel(wanted: string, ownKey: string): string {
    const taken = new Set(
      [...vault.values()].filter((p) => p.desktopPublicKey !== ownKey).map((p) => p.label),
    )
    if (!taken.has(wanted)) return wanted
    let n = 2
    while (taken.has(`${wanted} (${n})`)) n += 1
    return `${wanted} (${n})`
  }

  return {
    status: 'offline',
    pairings: [],
    paired: null,
    safetyPhrase: null,
    terminals: [],
    // Nothing until a desktop says otherwise. A phone that assumed a grant it
    // has not been given would offer a control that errors on first use.
    capabilities: { ...NO_CAPABILITIES },
    output: {},
    outputEnd: {},
    agentStatus: {},
    // Nothing on screen has been confirmed against a live desktop yet, which is
    // exactly what stale means.
    stale: true,
    error: null,

    async boot() {
      watchAppState()
      const book = await loadBook()
      vault = new Map(book.pairings.map((p) => [p.desktopPublicKey, p]))
      // `loadBook` has already reconciled the stored active desktop against what
      // actually loaded, so this cannot name a pairing the vault does not hold.
      // One lookup rather than a null check and then a lookup: the empty book has
      // to be answered for either way, and a key of `''` is not one any desktop
      // can have.
      active = vault.get(book.active ?? '') ?? null
      present()
      if (active !== null) connect(active)
    },

    async pairFromQr(raw, label) {
      const offer = parseQrPayload(raw)
      // Refused before any key work and before storage is touched: a code that
      // did not parse is a bad scan, not a desktop.
      if (offer === null) {
        set({ error: 'That is not a Termpolis pairing code. Try scanning it again.' })
        return
      }
      // Checked before dialling, so a phone at the ceiling says so instead of
      // burning the desktop's single-use code to find out. Re-pairing a desktop
      // already in the list replaces its row and so is always allowed.
      if (vault.size >= MAX_PAIRINGS && !vault.has(offer.desktopPublicKey)) {
        set({
          error: `This phone is paired with ${MAX_PAIRINGS} desktops already. Remove one first.`,
        })
        return
      }
      watchAppState()
      set({ error: null })
      // A fresh keypair for this desktop and no other. Minted here and written
      // only if the desktop answers, so an abandoned pairing leaves nothing in
      // the keystore -- and so no two desktops are ever handed the same public
      // key to correlate this handset by.
      const identity = newIdentity()
      try {
        const { desktop } = await pairWithDesktop({
          offer,
          identity,
          label,
          deps: {
            open: (url) => new WebSocket(url) as unknown as SocketLike,
            now: () => Date.now(),
            setTimer: (fn, ms) => setTimeout(fn, ms),
            clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
          },
        })
        const record: StoredPairing = {
          ...desktop,
          label: uniqueLabel(desktop.label, desktop.desktopPublicKey),
          secretKey: identity.secretKey,
        }
        // Stored only once the desktop has answered. A record written earlier
        // would leave a phone that believes it is paired to a machine that
        // never heard of it.
        await addPairing(record)
        vault.set(record.desktopPublicKey, record)
        // The new desktop becomes the one on screen, which means whatever the
        // last one had showing goes -- including its socket.
        disconnect()
        clearDesktopView()
        active = record
        present()
        connect(record)
      } catch (err) {
        set({ error: err instanceof Error ? err.message : 'Pairing failed.' })
      }
    },

    async selectDesktop(desktopPublicKey) {
      const next = vault.get(desktopPublicKey)
      // Not an error: a stale row can be tapped once after the pairing behind it
      // is gone, and throwing inside a list that has already moved on helps
      // nobody.
      // Compared by identity, not by key: every value in the vault is replaced
      // wholesale when it changes -- renamed, re-paired -- and `active` is always
      // one of them, so the same object IS the same desktop. It also answers the
      // unpaired case without a null check of its own.
      if (next === undefined || next === active) return
      // One connection at a time. Holding several would keep several radios
      // awake for frames nobody is looking at, and the reconnect and
      // foreground logic is written per socket.
      disconnect()
      clearDesktopView()
      active = next
      present()
      await setActivePairing(desktopPublicKey)
      connect(next)
    },

    async renameDesktop(desktopPublicKey, label) {
      const record = vault.get(desktopPublicKey)
      if (record === undefined) return
      const wanted = sanitizeDeviceLabel(label)
      // An empty rename is a user who cleared the field, not a request for a
      // blank row in the switcher.
      if (wanted.length === 0) return
      const renamed: StoredPairing = {
        ...record,
        label: uniqueLabel(wanted, desktopPublicKey),
      }
      vault.set(desktopPublicKey, renamed)
      if (record === active) active = renamed
      await writePairing(renamed)
      present()
    },

    async forgetDesktop(desktopPublicKey) {
      const record = vault.get(desktopPublicKey)
      // Two taps on Remove race, and the second must not throw inside a screen
      // that has already redrawn without the row.
      if (record === undefined) return
      const wasActive = record === active
      // Said before hanging up, so the desktop drops this phone's row instead
      // of keeping one whose key is about to stop existing. Only the desktop
      // on screen can be told -- the rest have no open session, and dialling
      // one purely to say goodbye would mean connecting to a machine the user
      // has already decided to forget. Those still leave a row behind.
      //
      // Not awaited: the frame is written inside the call, and the answer
      // cannot change anything below it. See `sayGoodbye`.
      if (wasActive) sayGoodbye()
      vault.delete(desktopPublicKey)
      if (wasActive) {
        disconnect()
        // Everything on screen belonged to that desktop.
        clearDesktopView()
        // Straight on to whichever pairing is next rather than a dead screen:
        // the user removed ONE desktop, and a phone that falls back to the
        // pairing screen while three others are still paired has lost them as
        // far as the user can tell.
        active = vault.values().next().value ?? null
      }
      // Erases the record AND this phone's key for that desktop. See
      // `removePairing` -- PRIVACY.md promises exactly this, and it is now a
      // promise that can be kept one desktop at a time.
      await removePairing(desktopPublicKey, active === null ? null : active.desktopPublicKey)
      present()
      if (wasActive && active !== null) connect(active)
    },

    async unpair() {
      // Unpairing has always meant "this desktop", and Settings still shows one
      // desktop at a time. Delegating keeps the erase in a single place.
      if (active === null) return
      await get().forgetDesktop(active.desktopPublicKey)
    },

    async refreshTerminals() {
      set({ terminals: parseTerminalList(await ask({ kind: 'listTerminals' })) })
    },

    /** Ask what this phone may do. Needs no grant, which is the point: a device
     *  granted nothing must still be able to learn that. */
    async refreshCapabilities() {
      set({ capabilities: parseCapabilities(await ask({ kind: 'getCapabilities' })) })
    },

    async subscribe(terminalId) {
      await ask({ kind: 'subscribe', terminalId })
    },

    async unsubscribe(terminalId) {
      await ask({ kind: 'unsubscribe', terminalId })
    },

    async send(terminalId, text) {
      await ask({ kind: 'writeToTerminal', terminalId, text })
    },

    async runCommand(terminalId, command) {
      await ask({ kind: 'runCommand', terminalId, command })
    },

    async createTerminal(name, cwd) {
      await ask({ kind: 'createTerminal', name, ...(cwd === undefined ? {} : { cwd }) })
      await get().refreshTerminals()
    },

    async closeTerminal(terminalId) {
      await ask({ kind: 'closeTerminal', terminalId })
      set((prev) => {
        const output = { ...prev.output }
        const outputEnd = { ...prev.outputEnd }
        delete output[terminalId]
        delete outputEnd[terminalId]
        return {
          terminals: prev.terminals.filter((t) => t.id !== terminalId),
          output,
          outputEnd,
        }
      })
    },
  }
})

/** Drop every live thing this module holds and reset the store.
 *
 *  The connection lives outside the store, so a test -- or a sign-out -- that
 *  only reset the state would leave a socket behind still writing into it. */
export function teardownRemote(): void {
  socket?.close()
  socket = null
  session = null
  vault = new Map()
  active = null
  appStateSub?.remove()
  appStateSub = null
  if (foregroundTimer !== null) {
    clearTimeout(foregroundTimer)
    foregroundTimer = null
  }
  useRemoteStore.setState({
    status: 'offline',
    pairings: [],
    paired: null,
    safetyPhrase: null,
    terminals: [],
    // Grants belong to the desktop that issued them. A teardown that left them
    // behind would let the next screen enable a button on the strength of what
    // some earlier desktop allowed.
    capabilities: { ...NO_CAPABILITIES },
    output: {},
    outputEnd: {},
    agentStatus: {},
    stale: true,
    error: null,
  })
}

/** Forget every desktop and erase every key. Not on any screen -- Settings
 *  unpairs one at a time -- but the promise in PRIVACY.md is that deleting the
 *  app destroys the key material, and a test proving it needs something to call. */
export async function forgetEverything(): Promise<void> {
  teardownRemote()
  await wipeEverything()
}
