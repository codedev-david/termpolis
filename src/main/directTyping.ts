// The direct typing line, main's part (1.61.0). See src/shared/ptyDirect.ts for the wire and ptyHost.ts for the host.
//
// Main sets the line up and stays the judge of every write, but off the keystroke's path:
//  * On each page load, and when the pty host becomes ready, it makes a MessageChannelMain and gives one end to the
//    host and the other to the page (the preload keeps it; the page itself never sees a port).
//  * When the host goes away it tells the page to forget the line: every write goes through main again.
//  * The host hands main a copy of each write it made (`typed`), which runs terminal:write's watchers only, and each
//    write main must make itself (`via-main`), which runs the whole handler; main then tells the host it is done.
//  * The renderer's mark that main has written everything it sent through main for a terminal goes on to the host
//    behind those writes (the host's queue is in order, and so is this process's to it).
//  * A relaunch's hold on a terminal is passed to the host the moment it is set or lifted.
//
// Everything Electron is injected, so the unit suite drives all of it with fakes.
import { directTypingDisabledByEnv } from '../shared/ptyDirect'
import type { PtyHostInput } from './ptyHostClient'

export interface DirectPortLike {
  close(): void
}

export interface DirectWindowLike<P extends DirectPortLike = DirectPortLike> {
  isDestroyed(): boolean
  webContents: {
    on?(event: 'did-finish-load', cb: () => void): unknown
    isLoading(): boolean
    isDestroyed(): boolean
    postMessage(channel: string, message: unknown, transfer: P[]): void
    send(channel: string, ...args: unknown[]): void
  }
}

export interface DirectTypingDeps<P extends DirectPortLike = DirectPortLike> {
  platform: string
  env: NodeJS.ProcessEnv
  window: () => DirectWindowLike<P> | null
  makeChannel: () => { port1: P; port2: P }
  /** ptyHostClient.connectRendererPort. */
  connectPort: (port: P) => boolean
  onHostReady: (cb: () => void) => void
  onHostDown: (cb: () => void) => void
  onHostInput: (cb: (input: PtyHostInput) => void) => void
  routed: (key: number) => void
  sync: (id: string, n: number) => void
  /** terminal:write's handler: `written` = the host already wrote it, so only what watches writes runs. */
  handleWrite: (id: string, data: string, key: string | undefined, written: boolean) => void
  /** ipcMain.on for the renderer's mark. */
  onMark: (cb: (msg: { id?: unknown; n?: unknown } | undefined) => void) => void
  onLockChange: (cb: (id: string, hold: { until: number } | undefined) => void) => void
  lockUntil: (id: string) => number
  gate: (id: string, until: number) => void
  /** What main's output buffer holds for the terminal now. */
  bufferTotal: (id: string) => number
}

export interface DirectTyping<P extends DirectPortLike = DirectPortLike> {
  /** Whether the line is on at all (Windows, the pty host, no kill switch). */
  readonly enabled: boolean
  /** Hand the page a fresh line. Called on every page load (attachWindow). */
  connect(): boolean
  /** A new window: each load of its page gets a fresh line. */
  attachWindow(win: DirectWindowLike<P>): void
  /** What spawnTerminal gets for a terminal whose output main buffers under its id and sends with end offsets. */
  spawnOption(id: string): { base: number; until?: number } | undefined
  /** After such a spawn: a hold already on the id applies to the new pty too. */
  afterSpawn(id: string): void
}

export function installDirectTyping<P extends DirectPortLike>(deps: DirectTypingDeps<P>): DirectTyping<P> {
  const enabled = deps.platform === 'win32' && !directTypingDisabledByEnv(deps.env)

  deps.onHostInput((input) => {
    if (input.kind === 'typed') {
      deps.handleWrite(input.id, input.data, undefined, true)
      return
    }
    try {
      deps.handleWrite(input.id, input.data, undefined, false)
    } finally {
      // Always: a host left waiting on main would hold every later write to the terminal.
      if (input.key !== null) deps.routed(input.key)
    }
  })

  deps.onMark((msg) => {
    if (!msg || typeof msg.id !== 'string' || typeof msg.n !== 'number' || !Number.isFinite(msg.n)) return
    deps.sync(msg.id, msg.n)
  })

  deps.onLockChange((id, hold) => deps.gate(id, hold ? hold.until : 0))

  const connect = (): boolean => {
    if (!enabled) return false
    const win = deps.window()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false
    let channel: { port1: P; port2: P }
    try {
      channel = deps.makeChannel()
    } catch (e) {
      console.error('[direct typing] no channel; typing stays on the path through main:', e)
      return false
    }
    const { port1, port2 } = channel
    if (!deps.connectPort(port1)) {
      port1.close()
      port2.close()
      return false
    }
    try {
      win.webContents.postMessage('pty:direct-port', null, [port2])
      return true
    } catch (e) {
      // The host holds a line nobody is on; it sends nothing to it until a page subscribes, and the next load replaces it.
      console.error('[direct typing] could not hand the page its line:', e)
      port2.close()
      return false
    }
  }

  deps.onHostReady(() => {
    // A page still loading gets its line when it finishes (did-finish-load calls connect).
    const win = deps.window()
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isLoading()) connect()
  })

  deps.onHostDown(() => {
    const win = deps.window()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    try { win.webContents.send('pty:direct-reset') } catch { /* the page is going */ }
  })

  return {
    enabled,
    connect,
    attachWindow: (win) => {
      if (enabled && typeof win.webContents.on === 'function') win.webContents.on('did-finish-load', () => { connect() })
    },
    spawnOption: (id) => {
      if (!enabled) return undefined
      // A hold already on the id goes with the spawn, so the host gates the new pty before any write can reach it.
      const until = deps.lockUntil(id)
      return until > 0 ? { base: deps.bufferTotal(id), until } : { base: deps.bufferTotal(id) }
    },
    afterSpawn: (id) => {
      if (!enabled) return
      const until = deps.lockUntil(id)
      if (until > 0) deps.gate(id, until)
    },
  }
}
