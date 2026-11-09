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
//  3. Never lower this host's priority (unlike proc and memory): it IS the typing path once a terminal lives here.
//  4. Never fork from here. node-pty's kill() lists the programs on a Windows console by forking its helper script
//     with child_process.fork, which from a utility process is not guaranteed to start Electron as Node. Main sends the
//     list it read through the proc host (shellAlone.ts); without one the shell alone is ended, as node-pty does when
//     its helper times out.

/** What main asks. `key` is main's handle for one spawn, never reused: a terminal id can be (a workflow step that
 *  falls back to another shell starts again under the same id). */
export type PtyHostRequest =
  /** args: node-pty's own two forms, a list, or (Windows) one command line. */
  | { kind: 'spawn'; key: number; file: string; args: string[] | string; opts: PtyHostSpawnOptions }
  | { kind: 'write'; key: number; data: string }
  | { kind: 'resize'; key: number; cols: number; rows: number }
  /** consolePids: the programs on the shell's console (Windows), to end with it; null or absent ends the shell alone. */
  | { kind: 'kill'; key: number; consolePids?: number[] | null }

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

/** node-pty's Windows agent: kill() asks `_getConsoleProcessList` what to end, and that forks unless replaced. */
function setConsoleList(p: HostedPty, list: number[] | null | undefined): void {
  const agent = (p as unknown as { _agent?: { innerPid?: number; _getConsoleProcessList?: () => Promise<number[]> } })._agent
  if (!agent || typeof agent._getConsoleProcessList !== 'function') return
  agent._getConsoleProcessList = () => Promise.resolve(list && list.length > 0 ? list : [agent.innerPid ?? p.pid])
}

/**
 * The host's whole job, apart from the wire: start, feed, size and end ptys by key. Pure, so the unit suite drives it
 * with a fake spawn and a recording `post`.
 */
export function createPtyHostHandler(spawn: PtySpawn, post: (reply: PtyHostReply) => void): {
  handle(msg: PtyHostRequest): void
  readonly size: number
} {
  const ptys = new Map<number, HostedPty>()
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
        p.onData((data) => post({ kind: 'data', key: msg.key, data }))
        p.onExit((e) => {
          ptys.delete(msg.key)
          post({ kind: 'exit', key: msg.key, code: typeof e?.exitCode === 'number' ? e.exitCode : -1 })
        })
        return
      }
      case 'write':
        try { ptys.get(msg.key)?.write(msg.data) } catch { /* closed */ }
        return
      case 'resize':
        try { ptys.get(msg.key)?.resize(msg.cols, msg.rows) } catch { /* closed */ }
        return
      case 'kill': {
        const p = ptys.get(msg.key)
        if (!p) return
        setConsoleList(p, msg.consolePids)
        try { p.kill() } catch { /* already gone */ }
        return
      }
    }
  }
  return { handle, get size() { return ptys.size } }
}

interface ParentPortLike {
  on(event: 'message', cb: (e: { data: PtyHostRequest }) => void): void
  postMessage(msg: PtyHostReply): void
}

// `process.parentPort` exists ONLY in the forked utilityProcess, so importing this module from main or a test is inert.
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort

/* c8 ignore start */
if (parentPort) {
  // A child in an unknown state goes away; main ends its terminals and opens new ones itself (ptyHostClient.ts).
  process.on('unhandledRejection', (reason) => {
    console.error('[pty host] unhandled rejection:', reason)
    process.exit(1)
  })
  void import('node-pty').then((mod) => {
    const pty = ((mod as { default?: unknown }).default ?? mod) as { spawn: PtySpawn }
    const host = createPtyHostHandler((file, args, opts) => pty.spawn(file, args, opts), (r) => parentPort.postMessage(r))
    parentPort.on('message', (e) => host.handle(e?.data))
    parentPort.postMessage({ kind: 'ready' })
  }, (err) => {
    console.error('[pty host] node-pty did not load:', err)
    process.exit(1)
  })
}
/* c8 ignore stop */
