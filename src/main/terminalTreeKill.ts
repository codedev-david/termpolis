// terminalTreeKill.ts
//
// Closing a terminal ends what runs in it, not just its shell.
//
// killTerminal used to end the shell alone (plus, on Windows, the programs still attached to the
// shell's console). Anything the shell's programs started outside that console, a child that made
// its own console or broke away, kept running after its pane was gone: an orphaned agent, an MCP
// server, a dev server holding its port.
//
// Windows: `taskkill /T /F` on the shell, run by the proc host, never on the main thread (a process
// created on main stalls every terminal's echo, and closing a terminal is a hot path). taskkill
// finds the tree by walking parent pids down from a LIVE root, so the caller waits for this before
// it ends the shell itself (processTree.ts: kill the tree while its root is alive).
//
// macOS and Linux: node-pty starts the shell with setsid, so the shell leads its own process group.
// The group gets SIGTERM now and SIGKILL after processTree's grace period. Jobs a job-control shell
// put in groups of their own get the hangup a closing terminal always sends.
//
// Off by default: the app turns it on at start-up (index.ts), the way it wires the proc host. A unit
// test that drives terminalManager with made-up pids therefore never ends a real process.

import { execCaptureOffThread } from './procClient'
import { killProcessTree, taskkillPath, SYNC_TASKKILL_TIMEOUT_MS } from './processTree'

/** Ends the tree under a terminal's shell. Resolves once it is safe to end the shell, with the pids it
 *  says it ended (Windows; empty where it can't tell); never rejects. */
export type TerminalTreeKiller = (pid: number) => Promise<ReadonlySet<number>>

const NONE: ReadonlySet<number> = new Set()

/** The pids in taskkill's report. Each line names the pid it ended and that pid's parent, which the
 *  tree also ended unless it is the root's parent: a process not on the terminal's console, so taking
 *  it too never spares one of the console's own. Read as numbers alone, since the words are localized. */
export function pidsInTaskkillReport(stdout: unknown): ReadonlySet<number> {
  if (typeof stdout !== 'string') return NONE
  return new Set((stdout.match(/\d+/g) ?? []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))
}

/** A console list read before the tree went, less what the tree killer ended: those pids are free for
 *  Windows to give to a new, unrelated process by the time the shell's own kill runs. */
export function withoutEnded(list: number[] | null, ended: ReadonlySet<number>): number[] | null {
  return list === null ? null : list.filter((pid) => !ended.has(pid))
}

export interface TerminalTreeKillDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Runs taskkill off the main thread. Default: the proc host. */
  run?: (bin: string, args: string[], opts: { timeout: number }) => Promise<unknown>
  /** POSIX signal seam. Default: process.kill. */
  kill?: (pid: number, signal: NodeJS.Signals) => unknown
  graceMs?: number
}

export function createTerminalTreeKiller(deps: TerminalTreeKillDeps = {}): TerminalTreeKiller {
  return (pid) => {
    // 0 and 1 are never ours (as a group, -0 is our own and -1 is everyone we may signal).
    if (!Number.isInteger(pid) || pid <= 1) return Promise.resolve(NONE)
    const platform = deps.platform ?? process.platform
    if (platform === 'win32') {
      const run = deps.run ?? execCaptureOffThread
      try {
        // A failed taskkill (the tree already gone, the host down) leaves the shell to its own kill.
        return run(taskkillPath(deps.env), ['/pid', String(pid), '/T', '/F'], { timeout: SYNC_TASKKILL_TIMEOUT_MS })
          .then((out) => pidsInTaskkillReport((out as { stdout?: unknown } | null)?.stdout), () => NONE)
      } catch {
        return Promise.resolve(NONE)
      }
    }
    killProcessTree(pid, { platform, ...(deps.graceMs !== undefined ? { graceMs: deps.graceMs } : {}) }, deps.kill ? { kill: deps.kill } : {})
    return Promise.resolve(NONE)
  }
}

let active: TerminalTreeKiller | null = null

/** Turned on by the app at start-up. null turns it off again. */
export function setTerminalTreeKiller(killer: TerminalTreeKiller | null): void {
  active = killer
}

/** The killer closing a terminal uses, or null while it is off. */
export function terminalTreeKiller(): TerminalTreeKiller | null {
  return active
}
