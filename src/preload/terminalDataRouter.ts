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
// The direct typing line (1.61.0, directLine.ts) hands the router a second copy of a terminal's output, straight from the
// pty host: direct(id, data, end). Main still sends every byte as terminal:data. For a terminal with a pane, the router
// passes on whichever copy of a stretch of the stream arrives first and drops (or trims) the other by its end offset, so a
// pane sees each byte once and in order. A terminal's main copy is passed on untouched until a direct copy has been
// delivered for it, so with no line the router does exactly what it did before. onAll listeners only ever hear main.
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
  /** Direct-line chunks passed on to panes. */
  direct: number
  /** Chunks (either copy) dropped or trimmed as already delivered. */
  deduped: number
}

export interface TerminalDataRouter {
  onAll: (cb: TerminalDataCallback) => () => void
  onFor: (id: string, cb: TerminalDataCallback) => () => void
  stats: () => RouterStats
  /** A copy of output from the direct line (directLine.ts). */
  direct: (id: string, data: string, end: number) => void
  /** A terminal:read-buffer reply for `id` reached `next`: main's chunks up to there have all been passed on. */
  noteReplay: (id: string, next: number) => void
  /** A new shell under `id`: its stream starts over. */
  resetDirect: (id: string) => void
  /** Terminals with a pane now. */
  listened: () => string[]
  /** Told when a terminal gets its first pane (true) or loses its last (false). */
  onListen: (cb: (id: string, listening: boolean) => void) => void
}

interface Entry {
  cb: TerminalDataCallback
}

/** Where each copy of a pane-listened terminal's stream stands. */
interface Stream {
  /** End of what panes have been given, on the stream's scale; undefined until known. */
  last: number | undefined
  /** End of the last main chunk: main's are contiguous, so one that starts before it is a new shell's stream. */
  mainEnd: number | undefined
  /** A direct chunk has been passed on: main's copies are checked against `last` from now on. */
  directSeen: boolean
  /** Direct chunks ahead of `last`, waiting for main to close the gap. */
  pending: Array<{ data: string; end: number }>
  pendingChars: number
}

/** Direct chunks held at most, in characters, for one terminal; past this they are dropped and main's copies serve. */
const PENDING_CAP = 256 * 1024

const freshStream = (): Stream => ({ last: undefined, mainEnd: undefined, directSeen: false, pending: [], pendingChars: 0 })

/** What is left of a chunk ending at `end` once everything up to `last` has been delivered ('' = all of it was). */
function rest(data: string, end: number, last: number): string {
  if (end <= last) return ''
  const start = end - data.length
  return start < last ? data.slice(last - start) : data
}

// The parameter is NAMED ipcRenderer, and the channel is a literal at each call: tests/electron/ipcChannelSync.test.ts reads
// the preload's source text for listener registrations to prove every channel main sends has a listener, and it must keep
// seeing this one.
export function createTerminalDataRouter(ipcRenderer: RouterIpc, epoch: number = Date.now()): TerminalDataRouter {
  const byId = new Map<string, Entry[]>()
  const streams = new Map<string, Stream>()
  const listenCbs: Array<(id: string, listening: boolean) => void> = []
  let shared: ((event: unknown, id: string, data: string, end?: number) => void) | null = null
  let allCount = 0
  let panes = 0
  let delivered = 0
  let dropped = 0
  let directCount = 0
  let deduped = 0

  const announce = (channel: string, msg: Record<string, unknown>): void => {
    try {
      ipcRenderer.send(channel, { ...msg, epoch })
    } catch {
      // Not sent: main keeps sending everything until an announcement reaches it, so a listener is never starved.
    }
  }

  const tellListen = (id: string, listening: boolean): void => {
    for (const cb of listenCbs) {
      try {
        cb(id, listening)
      } catch (e) {
        console.error('[termpolis] a terminal listen callback threw', e)
      }
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

  /** Pass on a direct chunk's new part, given everything up to `st.last` is delivered. */
  const deliverDirect = (id: string, st: Stream, last: number, data: string, end: number): void => {
    const out = rest(data, end, last)
    if (out.length < data.length) deduped++
    if (!out) return
    st.last = end
    st.directSeen = true
    directCount++
    dispatch(id, out, end)
  }

  const flushPending = (id: string, st: Stream): void => {
    while (st.pending.length > 0 && st.last !== undefined && streams.get(id) === st) {
      const next = st.pending[0]
      if (next.end - next.data.length > st.last) return // still a gap
      st.pending.shift()
      st.pendingChars -= next.data.length
      deliverDirect(id, st, st.last, next.data, next.end)
    }
  }

  const fromMain = (id: string, data: string, end: number | undefined): void => {
    const st = streams.get(id)
    if (!st || end === undefined) {
      dispatch(id, data, end)
      return
    }
    // Main's chunks are contiguous; one starting before the last one ended is a new shell's stream (its buffer was dropped).
    if (st.mainEnd !== undefined && end - data.length < st.mainEnd) Object.assign(st, freshStream())
    st.mainEnd = end
    if (!st.directSeen || st.last === undefined) {
      st.last = st.last === undefined ? end : Math.max(st.last, end)
      dispatch(id, data, end)
      flushPending(id, st)
      return
    }
    const out = rest(data, end, st.last)
    if (out.length < data.length) deduped++
    if (!out) return
    st.last = end
    dispatch(id, out, end)
    flushPending(id, st)
  }

  const ensureShared = (): void => {
    if (shared) return
    shared = (_event, id, data, end) => fromMain(id, data, typeof end === 'number' ? end : undefined)
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
        streams.set(id, freshStream())
      }
      panes++
      ensureShared()
      if (!existing) {
        announce('terminal:subscribe', { id })
        tellListen(id, true)
      }
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
          streams.delete(id)
          announce('terminal:unsubscribe', { id })
          tellListen(id, false)
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
    stats: () => ({ shared: shared !== null, ids: byId.size, panes, all: allCount, delivered, dropped, direct: directCount, deduped }),
    direct(id, data, end) {
      const st = streams.get(id)
      if (!st || typeof data !== 'string' || data.length === 0 || typeof end !== 'number' || !Number.isFinite(end)) return
      if (st.last === undefined || end - data.length > st.last) {
        // Ahead of what the panes have: held until main's copy (or a replay) says where they are.
        if (st.pendingChars + data.length > PENDING_CAP) {
          st.pending = []
          st.pendingChars = 0
          return
        }
        st.pending.push({ data, end })
        st.pendingChars += data.length
        return
      }
      deliverDirect(id, st, st.last, data, end)
      flushPending(id, st)
    },
    noteReplay(id, next) {
      const st = streams.get(id)
      if (!st || typeof next !== 'number' || !Number.isFinite(next)) return
      st.last = st.last === undefined ? next : Math.max(st.last, next)
      flushPending(id, st)
    },
    resetDirect(id) {
      const st = streams.get(id)
      if (!st) return
      // mainEnd stays: main's first chunk of the new stream is recognised by starting before it.
      Object.assign(st, freshStream(), { mainEnd: st.mainEnd })
    },
    listened: () => [...byId.keys()],
    onListen(cb) {
      listenCbs.push(cb)
    },
  }
}
