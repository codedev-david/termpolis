// The terminal process host (perf155 P14): node-pty, run somewhere other than the main thread.
//
// node-pty's spawn is synchronous. On Windows it is ConPTY plus CreateProcess, and with Defender scanning every new
// process that costs 0.1-1.6 s on the calling thread. Main is the thread that echoes every keystroke in every pane, so
// opening a terminal, or a hidden sign-in session starting Claude, froze typing everywhere for that long. Here the same
// spawn blocks only this utilityProcess.
//
// Main keeps everything else a terminal is: the output buffer, the coalescer, the phone pump, the cwd and shell-alone
// reads. This host owns the ptys and nothing more, and forwards each one's bytes as they come.
//
// Constraints, same shape as procHost:
//  1. Nothing heavy at import: node-pty is the whole of it.
//  2. Plain data across the wire. A spawn that throws comes back as `spawn-error` with the message, never a crash.
//  3. Never lower this host's priority (unlike proc and memory): it IS the typing path once a terminal lives here. It
//     raises itself instead (1.61.0, hostPriority.ts).
//  4. Never fork from here. node-pty's kill() lists the programs on a Windows console by forking its helper script
//     with child_process.fork, which from a utility process is not guaranteed to start Electron as Node. Main sends the
//     list it read through the proc host (shellAlone.ts); without one the shell alone is ended, as node-pty does when
//     its helper times out.
//
// The direct typing line (1.61.0). Main hands this host one end of a MessagePort and the renderer the other, so a
// keystroke goes renderer -> here -> the shell, and its echo shell -> here -> renderer, and main's thread is on
// neither path (src/shared/ptyDirect.ts has the wire). Main keeps everything it did, from copies:
//  * Output: every chunk still goes to main as before (its buffer, coalescer, phone pump, terminal:data). The renderer
//    is sent a second copy, coalesced the same way, for the terminals it has a pane on, tagged with where it ends in
//    the stream; it keeps whichever copy of a stretch arrives first.
//  * Input: a write this host makes is copied to main afterwards (`typed`: the secret scan, the launch audit, account
//    tracking, the typing-quiet clock). A write main must judge FIRST is not written here at all: it goes to main
//    (`via-main`), which runs terminal:write's whole handler and says when it is done (`routed`). That is any write
//    while a relaunch holds the terminal (main sends the hold as `gate`) and any write strict mode might refuse.
//    Until main says done, later writes to that terminal wait here, so nothing overtakes it.
//  * A write that went through main before the renderer switched a terminal to this line: the renderer's writes carry
//    a mark (`sync`) and wait here until main says it has written everything up to that mark.
//  * A write for a terminal this host does not hold (it ended, or opened in main) goes to main as well.
import { createOutputCoalescer, type OutputCoalescer } from './ptyCoalescer'
import { raiseHostPriority } from './hostPriority'
import { directWriteNeedsMain, type DirectFromHost, type DirectToHost } from '../shared/ptyDirect'

/** What main asks. `key` is main's handle for one spawn, never reused: a terminal id can be (a workflow step that
 *  falls back to another shell starts again under the same id). */
export type PtyHostRequest =
  /** args: node-pty's own two forms, a list, or (Windows) one command line. direct: the terminal as the renderer knows
   *  it, and how much output main's buffer already holds under that id (where this spawn's output starts). */
  | { kind: 'spawn'; key: number; file: string; args: string[] | string; opts: PtyHostSpawnOptions; direct?: DirectSpawn }
  | { kind: 'write'; key: number; data: string }
  | { kind: 'resize'; key: number; cols: number; rows: number }
  /** consolePids: the programs on the shell's console (Windows), to end with it; null or absent ends the shell alone. */
  | { kind: 'kill'; key: number; consolePids?: number[] | null }
  /** Until when (ms since the epoch) a write typed straight in goes through main: a relaunch holds the terminal. 0 lifts it. */
  | { kind: 'gate'; key: number; until: number }
  /** Main finished a write this host handed it (`via-main` with this key): the next one may go. */
  | { kind: 'routed'; key: number }
  /** Main has written every write the renderer sent it for `id` up to the renderer's mark `n`. */
  | { kind: 'sync'; id: string; n: number }

export interface DirectSpawn {
  id: string
  base: number
  /** A relaunch hold already on the id when it spawns (ms since the epoch): gated from its first write. */
  until?: number
}

export interface PtyHostSpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

export type PtyHostReply =
  | { kind: 'ready' }
  | { kind: 'spawned'; key: number; pid: number }
  | { kind: 'spawn-error'; key: number; message: string }
  | { kind: 'data'; key: number; data: string }
  | { kind: 'exit'; key: number; code: number }
  /** A write this host made straight from the renderer, copied to main for what watches writes. */
  | { kind: 'typed'; key: number; id: string; data: string }
  /** A write main must make itself (terminal:write's handler); key null when no terminal here holds `id`. */
  | { kind: 'via-main'; key: number | null; id: string; data: string }

/** The part of node-pty's IPty this host drives. */
export interface HostedPty {
  readonly pid: number
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export type PtySpawn = (file: string, args: string[] | string, opts: PtyHostSpawnOptions) => HostedPty

/** The host's end of the direct line: Electron's MessagePortMain, or a fake. */
export interface DirectPort {
  postMessage(msg: DirectFromHost): void
}

/** A terminal on the direct line. */
interface Direct {
  id: string
  key: number
  /** Where this terminal's output stream ends now, on main's buffer scale. */
  end: number
  /** Where the output handed to `out` so far ends: what a batch it emits is tagged with. */
  pushedEnd: number
  /** Writes go through main until this time (a relaunch's hold). */
  gateUntil: number
  /** Writes handed to main and not yet done. */
  waiting: number
  /** Writes waiting behind them, or for a mark. */
  queue: Array<{ data: string; sync?: number }>
  out: OutputCoalescer
}

/** node-pty's Windows agent: kill() asks `_getConsoleProcessList` what to end, and that forks unless replaced. */
function setConsoleList(p: HostedPty, list: number[] | null | undefined): void {
  const agent = (p as unknown as { _agent?: { innerPid?: number; _getConsoleProcessList?: () => Promise<number[]> } })._agent
  if (!agent || typeof agent._getConsoleProcessList !== 'function') return
  agent._getConsoleProcessList = () => Promise.resolve(list && list.length > 0 ? list : [agent.innerPid ?? p.pid])
}

function isDirectSpawn(v: unknown): v is DirectSpawn {
  const d = v as DirectSpawn | null | undefined
  return !!d && typeof d.id === 'string' && d.id.length > 0 && typeof d.base === 'number' && Number.isFinite(d.base) && d.base >= 0
}

export interface PtyHostHandlerOptions {
  now?: () => number
  /** Passed to each direct terminal's coalescer (tests drive its window with fake timers). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * The host's whole job, apart from the wire: start, feed, size and end ptys by key, and serve the direct line. Pure,
 * so the unit suite drives it with a fake spawn, a recording `post` and a fake port.
 */
export function createPtyHostHandler(spawn: PtySpawn, post: (reply: PtyHostReply) => void, options: PtyHostHandlerOptions = {}): {
  handle(msg: PtyHostRequest): void
  /** A message from the renderer, on any port it was ever given (one being replaced may still carry writes). */
  fromRenderer(msg: DirectToHost): void
  /** The renderer's port: output and binds go to this one from now on. */
  attachRenderer(port: DirectPort): void
  readonly size: number
} {
  const now = options.now ?? Date.now
  const ptys = new Map<number, HostedPty>()
  const directByKey = new Map<number, Direct>()
  /** The latest spawn under each terminal id. */
  const directById = new Map<string, Direct>()
  /** Terminals the renderer has a pane on. */
  const subs = new Set<string>()
  /** The highest mark main has confirmed, per terminal id. Kept across ports: the marks are the page's, and only grow. */
  const synced = new Map<string, number>()
  let port: DirectPort | null = null

  const toRenderer = (msg: DirectFromHost): void => {
    if (!port) return
    try { port.postMessage(msg) } catch { /* the page is going; main still sends everything */ }
  }

  const take = (d: Direct, data: string): void => {
    if (now() < d.gateUntil || directWriteNeedsMain(data)) {
      d.waiting++
      post({ kind: 'via-main', key: d.key, id: d.id, data })
      return
    }
    try { ptys.get(d.key)?.write(data) } catch { /* closed */ }
    post({ kind: 'typed', key: d.key, id: d.id, data })
  }

  const drain = (d: Direct): void => {
    while (d.queue.length > 0 && d.waiting === 0) {
      const next = d.queue[0]
      if (next.sync !== undefined && (synced.get(d.id) ?? -Infinity) < next.sync) return
      d.queue.shift()
      take(d, next.data)
    }
  }

  const openDirect = (key: number, spec: DirectSpawn): Direct => {
    const d: Direct = {
      id: spec.id,
      key,
      end: spec.base,
      pushedEnd: spec.base,
      gateUntil: typeof spec.until === 'number' && Number.isFinite(spec.until) ? spec.until : 0,
      waiting: 0,
      queue: [],
      out: createOutputCoalescer((data) => toRenderer({ t: 'd', id: d.id, data, end: d.pushedEnd }), {
        ...(options.setTimer ? { setTimer: options.setTimer } : {}),
        ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
      }),
    }
    const before = directById.get(spec.id)
    if (before) before.out.flush()
    directByKey.set(key, d)
    directById.set(spec.id, d)
    toRenderer({ t: 'bind', id: spec.id, fresh: true })
    return d
  }

  const closeDirect = (d: Direct): void => {
    // The last of the output before the exit, as main's coalescer flushes before its exit callback.
    d.out.dispose()
    directByKey.delete(d.key)
    // Writes still waiting go to main, which writes them to whatever holds the id now (or drops them, as it would).
    for (const q of d.queue.splice(0)) post({ kind: 'via-main', key: null, id: d.id, data: q.data })
    if (directById.get(d.id) !== d) return
    directById.delete(d.id)
    toRenderer({ t: 'unbind', id: d.id })
  }

  const handle = (msg: PtyHostRequest): void => {
    if (!msg || typeof msg !== 'object') return
    switch (msg.kind) {
      case 'spawn': {
        let p: HostedPty
        try {
          p = spawn(msg.file, msg.args, msg.opts)
        } catch (e) {
          post({ kind: 'spawn-error', key: msg.key, message: (e as Error)?.message || String(e) })
          return
        }
        ptys.set(msg.key, p)
        // Before the first byte can arrive: the pid is how main learns the terminal started.
        post({ kind: 'spawned', key: msg.key, pid: p.pid })
        // Set at once, not at kill: a kill main sends before it knows the list still must not fork.
        setConsoleList(p, null)
        const direct = isDirectSpawn(msg.direct) ? openDirect(msg.key, msg.direct) : null
        p.onData((data) => {
          post({ kind: 'data', key: msg.key, data })
          if (!direct || !data) return
          direct.end += data.length
          if (port && subs.has(direct.id) && directById.get(direct.id) === direct) {
            // Before push: a push into an idle window emits at once, tagged with this.
            direct.pushedEnd = direct.end
            direct.out.push(data)
          }
        })
        p.onExit((e) => {
          ptys.delete(msg.key)
          if (direct) closeDirect(direct)
          post({ kind: 'exit', key: msg.key, code: typeof e?.exitCode === 'number' ? e.exitCode : -1 })
        })
        return
      }
      case 'write':
        try { ptys.get(msg.key)?.write(msg.data) } catch { /* closed */ }
        return
      case 'resize':
        // Output from before the resize reaches the pane first, as main's coalescer does (ptyResizeFlush.ts).
        directByKey.get(msg.key)?.out.flush()
        try { ptys.get(msg.key)?.resize(msg.cols, msg.rows) } catch { /* closed */ }
        return
      case 'kill': {
        const p = ptys.get(msg.key)
        if (!p) return
        setConsoleList(p, msg.consolePids)
        try { p.kill() } catch { /* already gone */ }
        return
      }
      case 'gate': {
        const d = directByKey.get(msg.key)
        if (d && typeof msg.until === 'number') {
          d.gateUntil = msg.until
          drain(d)
        }
        return
      }
      case 'routed': {
        const d = directByKey.get(msg.key)
        if (!d || d.waiting === 0) return
        d.waiting--
        drain(d)
        return
      }
      case 'sync': {
        if (typeof msg.id !== 'string' || typeof msg.n !== 'number') return
        synced.set(msg.id, Math.max(synced.get(msg.id) ?? -Infinity, msg.n))
        const d = directById.get(msg.id)
        if (d) drain(d)
        return
      }
    }
  }

  const fromRenderer = (msg: DirectToHost): void => {
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') return
    switch (msg.t) {
      case 'w': {
        if (typeof msg.data !== 'string') return
        const d = directById.get(msg.id)
        if (!d) {
          // Not here (it ended, or a new one under the id opened in main): main writes it to whatever holds the id.
          post({ kind: 'via-main', key: null, id: msg.id, data: msg.data })
          return
        }
        d.queue.push(typeof msg.sync === 'number' ? { data: msg.data, sync: msg.sync } : { data: msg.data })
        drain(d)
        return
      }
      case 'sub':
        subs.add(msg.id)
        return
      case 'unsub':
        // What the window holds goes now, while it may: a later subscription must not get it glued to newer output.
        directById.get(msg.id)?.out.flush()
        subs.delete(msg.id)
        return
    }
  }

  const attachRenderer = (next: DirectPort): void => {
    // What the old page's windows hold goes to it; the new page subscribes for itself.
    for (const d of directById.values()) d.out.flush()
    port = next
    subs.clear()
    for (const d of directById.values()) toRenderer({ t: 'bind', id: d.id })
  }

  return { handle, fromRenderer, attachRenderer, get size() { return ptys.size } }
}

/** Electron's MessagePortMain, the parts used here. */
interface MainPortLike extends DirectPort {
  on(event: 'message', cb: (e: { data: DirectToHost }) => void): void
  start(): void
}

interface ParentPortLike {
  on(event: 'message', cb: (e: { data: PtyHostRequest | { kind: 'renderer-port' }; ports?: MainPortLike[] }) => void): void
  postMessage(msg: PtyHostReply): void
}

// `process.parentPort` exists ONLY in the forked utilityProcess, so importing this module from main or a test is inert.
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort

/* c8 ignore start */
if (parentPort) {
  // The typing path: above the shells and agents it serves (Windows does not pass ABOVE_NORMAL on to the processes
  // this one starts). Only ever this process; TERMPOLIS_NO_HOST_PRIORITY turns it off (hostPriority.ts).
  raiseHostPriority({ host: 'pty' })
  // A child in an unknown state goes away; main ends its terminals and opens new ones itself (ptyHostClient.ts).
  process.on('unhandledRejection', (reason) => {
    console.error('[pty host] unhandled rejection:', reason)
    process.exit(1)
  })
  void import('node-pty').then((mod) => {
    const pty = ((mod as { default?: unknown }).default ?? mod) as { spawn: PtySpawn }
    const host = createPtyHostHandler((file, args, opts) => pty.spawn(file, args, opts), (r) => parentPort.postMessage(r))
    parentPort.on('message', (e) => {
      const msg = e?.data
      if (msg && (msg as { kind?: string }).kind === 'renderer-port') {
        const rp = e.ports?.[0]
        if (!rp) return
        rp.on('message', (m) => host.fromRenderer(m?.data))
        rp.start()
        host.attachRenderer(rp)
        return
      }
      host.handle(msg as PtyHostRequest)
    })
    parentPort.postMessage({ kind: 'ready' })
  }, (err) => {
    console.error('[pty host] node-pty did not load:', err)
    process.exit(1)
  })
}
/* c8 ignore stop */
