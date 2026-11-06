// How the renderer hears terminal output (1.54.5, plan package P9).
//
// onTerminalData used to register one ipcRenderer.on('terminal:data') listener per call, and TerminalPane calls it once
// per mounted pane, each pane then dropping every chunk that was not its own terminal's. For N panes one chunk was N
// listener runs and N crossings of the context bridge, the whole string copied each time, N-1 of them for nothing.
//
//   onFor(id, cb)   ONE ipcRenderer.on listener, shared by every pane, hands a chunk to the callbacks of its own terminal
//                   only; and main is told the terminal is listened to (terminal:subscribe), so it sends terminal:data for
//                   it. The announcement leaves BEFORE onFor returns: a pane asks for its replay straight after, and main
//                   reads the two in order.
//   onAll(cb)       what onTerminalData always was: one listener of its own, every terminal's chunks. Main is told once
//                   that something listens to everything (a launch waiting for its shell to go quiet has no pane yet).
//
// `end` is where the chunk ends in the terminal's output stream (absent for output main never buffered, such as a
// strict-mode banner). A replaying TerminalPane compares it with the reply's nextOffset.
//
// Announcements carry `epoch`, the page's load time: main starts from nothing when a page with a newer one speaks (a
// reload) and ignores a page it has replaced. See src/main/terminalDataRouting.ts for the rest.

export type TerminalDataCallback = (id: string, data: string, end?: number) => void

// `any[]`: the argument lists are ipcRenderer's own (its listener is `(event, ...args: any[]) => void`), and narrowing them here
// would stop ipcRenderer itself from being passed in.
export interface RouterIpc {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (channel: string, listener: (event: unknown, ...args: any[]) => void) => unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener: (channel: string, listener: (event: unknown, ...args: any[]) => void) => unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send: (channel: string, ...args: any[]) => void
}

export interface RouterStats {
  /** The shared ipcRenderer listener is installed. */
  shared: boolean
  /** Terminals with a pane listening. */
  ids: number
  /** Pane callbacks registered. */
  panes: number
  /** All-terminal callbacks registered. */
  all: number
  /** Pane callbacks run so far. */
  delivered: number
  /** Chunks no pane listened for. */
  dropped: number
}

export interface TerminalDataRouter {
  onAll: (cb: TerminalDataCallback) => () => void
  onFor: (id: string, cb: TerminalDataCallback) => () => void
  stats: () => RouterStats
}

interface Entry {
  cb: TerminalDataCallback
}

// The parameter is NAMED ipcRenderer, and the channel is a literal at each call: tests/electron/ipcChannelSync.test.ts reads
// the preload's source text for listener registrations to prove every channel main sends has a listener, and it must keep
// seeing this one.
export function createTerminalDataRouter(ipcRenderer: RouterIpc, epoch: number = Date.now()): TerminalDataRouter {
  const byId = new Map<string, Entry[]>()
  let shared: ((event: unknown, id: string, data: string, end?: number) => void) | null = null
  let allCount = 0
  let panes = 0
  let delivered = 0
  let dropped = 0

  const announce = (channel: string, msg: Record<string, unknown>): void => {
    try {
      ipcRenderer.send(channel, { ...msg, epoch })
    } catch {
      // Not sent: main keeps sending everything until an announcement reaches it, so a listener is never starved.
    }
  }

  const call = (entry: Entry, id: string, data: string, end: number | undefined): void => {
    delivered++
    try {
      entry.cb(id, data, end)
    } catch (e) {
      // One pane's failure must not cost the others their chunk (a throwing listener stops an EventEmitter's loop).
      console.error('[termpolis] a terminal output callback threw', e)
    }
  }

  const dispatch = (id: string, data: string, end: number | undefined): void => {
    const entries = byId.get(id)
    if (!entries) {
      dropped++
      return
    }
    if (entries.length === 1) {
      call(entries[0], id, data, end)
      return
    }
    // A copy: a callback may unsubscribe while the chunk is being handed round.
    for (const entry of entries.slice()) call(entry, id, data, end)
  }

  const ensureShared = (): void => {
    if (shared) return
    shared = (_event, id, data, end) => dispatch(id, data, end)
    ipcRenderer.on('terminal:data', shared)
  }

  const releaseShared = (): void => {
    if (!shared || byId.size > 0) return
    ipcRenderer.removeListener('terminal:data', shared)
    shared = null
  }

  return {
    onFor(id, cb) {
      const entry: Entry = { cb }
      const existing = byId.get(id)
      if (existing) {
        existing.push(entry)
      } else {
        byId.set(id, [entry])
      }
      panes++
      ensureShared()
      if (!existing) announce('terminal:subscribe', { id })
      let live = true
      return () => {
        if (!live) return
        live = false
        panes--
        const entries = byId.get(id)
        /* v8 ignore next -- unreachable by construction: an id's list is deleted only when its LAST entry has been removed,
           and this entry is live until `live` flips above. Kept so a bug elsewhere can never make a pane's cleanup throw. */
        if (!entries) return
        const at = entries.indexOf(entry)
        /* v8 ignore next -- the same invariant: a live entry is always in its list */
        if (at >= 0) entries.splice(at, 1)
        if (entries.length === 0) {
          byId.delete(id)
          announce('terminal:unsubscribe', { id })
        }
        releaseShared()
      }
    },
    onAll(cb) {
      const handler = (_event: unknown, id: string, data: string, end?: number): void => cb(id, data, end)
      ipcRenderer.on('terminal:data', handler)
      if (allCount++ === 0) announce('terminal:subscribe', { all: true })
      let live = true
      return () => {
        if (!live) return
        live = false
        ipcRenderer.removeListener('terminal:data', handler)
        if (--allCount === 0) announce('terminal:unsubscribe', { all: true })
      }
    },
    stats: () => ({ shared: shared !== null, ids: byId.size, panes, all: allCount, delivered, dropped }),
  }
}
