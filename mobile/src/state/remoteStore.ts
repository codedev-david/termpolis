import { AppState } from 'react-native'
import { create } from 'zustand'
import { RelaySocket, type RelayState, type SocketLike } from '../net/relaySocket'
import { RemoteSession, type StatusUpdate } from '../net/remoteSession'
import { pairWithDesktop } from '../net/pairingClient'
import {
  clearPaired,
  loadIdentity,
  loadPaired,
  savePaired,
  type PairedDesktop,
} from '../storage/identity'
import { parseQrPayload } from '../wire/qr'
import { deriveVerificationPhrase } from '../wire/safetyNumber'
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

/** The view only ever shows the tail, and a phone cannot hold a day of agent
 *  output. Trimming the head is what keeps a long session out of an OOM. */
export const MAX_OUTPUT_CHARS = 200_000

interface RemoteState {
  /** The relay connection, as the socket reports it. */
  status: RelayState
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
  agentStatus: Record<string, StatusUpdate>
  /** True whenever what is on screen is not being kept current. */
  stale: boolean
  error: string | null

  boot(): Promise<void>
  pairFromQr(raw: string, label: string): Promise<void>
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
let identity: { secretKey: string; publicKey: string } | null = null
let appStateSub: { remove(): void } | null = null
let foregroundTimer: ReturnType<typeof setTimeout> | null = null

export const useRemoteStore = create<RemoteState>((set, get) => {
  /** Every action that needs the desktop passes through here.
   *
   *  Nothing is ever queued. Work must not silently execute later: a runCommand
   *  buffered through an outage and fired on reconnect is arbitrary shell
   *  execution at a moment the user has stopped expecting it. */
  async function ask<T>(request: RemoteRequest): Promise<T> {
    const { paired, stale } = get()
    if (paired === null) throw new Error('This phone is not paired with a desktop yet.')
    if (session === null || stale) {
      throw new Error('The desktop is offline. Reconnect before sending anything.')
    }
    try {
      return await session.request<T>(request)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ error: message })
      throw err
    }
  }

  function connect(desktop: PairedDesktop): void {
    if (socket !== null || identity === null) return
    const me = identity

    const live = new RemoteSession({
      send: (plaintext) => socket?.send(plaintext),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    })
    session = live

    live.onOutput((chunks) => {
      set((prev) => {
        const output = { ...prev.output }
        for (const c of chunks) {
          // The marker rides on the FIRST piece of a split chunk only, so
          // appending it whenever it is present renders the gap exactly once.
          const gap = c.missed > 0 && c.marker !== null ? c.marker : ''
          const joined = (output[c.terminalId] ?? '') + gap + c.chunk
          output[c.terminalId] =
            joined.length > MAX_OUTPUT_CHARS ? joined.slice(joined.length - MAX_OUTPUT_CHARS) : joined
        }
        return { output }
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
      set({ capabilities: caps })
    })

    socket = new RelaySocket({
      url: desktop.relayUrl,
      // The STORED room, never one recomputed here. Recomputing would look right
      // until an identity change made the two ends disagree in silence.
      roomId: desktop.sessionRoomId,
      open: (url) => new WebSocket(url) as unknown as SocketLike,
      // A factory: one ephemeral key per attachment is what makes a recorded
      // session unreadable after the fact.
      handshake: () => new Handshake('device', me.secretKey, desktop.desktopPublicKey),
      onFrame: (plaintext) => live.handleFrame(plaintext),
      onControl: () => undefined,
      onState: (next) => {
        const attached = next === 'attached'
        if (!attached) live.reset('The connection dropped.')
        set({ status: next, stale: !attached })
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
        const { paired } = get()
        if (paired !== null) connect(paired)
      }, FOREGROUND_DEBOUNCE_MS)
    })
  }

  return {
    status: 'offline',
    paired: null,
    safetyPhrase: null,
    terminals: [],
    // Nothing until a desktop says otherwise. A phone that assumed a grant it
    // has not been given would offer a control that errors on first use.
    capabilities: { ...NO_CAPABILITIES },
    output: {},
    agentStatus: {},
    // Nothing on screen has been confirmed against a live desktop yet, which is
    // exactly what stale means.
    stale: true,
    error: null,

    async boot() {
      identity ??= await loadIdentity()
      watchAppState()
      const paired = await loadPaired()
      if (paired === null) {
        set({ paired: null, safetyPhrase: null })
        return
      }
      set({
        paired,
        safetyPhrase: deriveVerificationPhrase(identity.publicKey, paired.desktopPublicKey),
      })
      connect(paired)
    },

    async pairFromQr(raw, label) {
      const offer = parseQrPayload(raw)
      // Refused before any key work and before storage is touched: a code that
      // did not parse is a bad scan, not a desktop.
      if (offer === null) {
        set({ error: 'That is not a Termpolis pairing code. Try scanning it again.' })
        return
      }
      identity ??= await loadIdentity()
      watchAppState()
      set({ error: null })
      try {
        const { desktop, safetyPhrase } = await pairWithDesktop({
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
        // Stored only once the desktop has answered. A record written earlier
        // would leave a phone that believes it is paired to a machine that
        // never heard of it.
        await savePaired(desktop)
        set({ paired: desktop, safetyPhrase, error: null })
        connect(desktop)
      } catch (err) {
        set({ error: err instanceof Error ? err.message : 'Pairing failed.' })
      }
    },

    async unpair() {
      disconnect()
      await clearPaired()
      // Everything on screen belonged to that desktop. Leaving any of it behind
      // would show the next pairing another machine's terminals.
      set({
        paired: null,
        safetyPhrase: null,
        terminals: [],
        capabilities: { ...NO_CAPABILITIES },
        output: {},
        agentStatus: {},
        error: null,
      })
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
        delete output[terminalId]
        return { terminals: prev.terminals.filter((t) => t.id !== terminalId), output }
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
  identity = null
  appStateSub?.remove()
  appStateSub = null
  if (foregroundTimer !== null) {
    clearTimeout(foregroundTimer)
    foregroundTimer = null
  }
  useRemoteStore.setState({
    status: 'offline',
    paired: null,
    safetyPhrase: null,
    terminals: [],
    // Grants belong to the desktop that issued them. A teardown that left them
    // behind would let the next screen enable a button on the strength of what
    // some earlier desktop allowed.
    capabilities: { ...NO_CAPABILITIES },
    output: {},
    agentStatus: {},
    stale: true,
    error: null,
  })
}
