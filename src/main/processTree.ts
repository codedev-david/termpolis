// processTree.ts
//
// Ending a process TREE: the process we started and everything it started, not just the one
// process `child.kill()` reaches.
//
// On Windows `child.kill()` is TerminateProcess on the direct child, and its children keep
// running. That hurts most when the direct child is a wrapper. Second Opinion starts every agent
// through powershell.exe, so killing the child ended PowerShell and orphaned the agent, which
// went on working and kept the output pipes open (so `close` never fired). Killing the wrapper
// first also loses the trail: `taskkill /T` finds a tree by walking parent PIDs down from a LIVE
// root, so once the wrapper is gone nothing leads to the agent. Hence the one rule here: kill the
// tree while its root is alive, never the root first. libuv's job object doesn't cover it either.
// It ends the direct child when Termpolis exits and lets every grandchild break away.
//
// On macOS and Linux the child must have been spawned `detached`, which makes it the leader of
// its own process group. Signalling the negative pid then reaches the whole group: SIGTERM first,
// then SIGKILL for whatever is still there after a grace period.
//
// Every failure is ignored. The usual one is that the tree is already gone.

import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'child_process'
import path from 'path'

/** How long a process group gets to exit on SIGTERM before it is sent SIGKILL. */
export const TREE_KILL_GRACE_MS = 2_000

/** How long a synchronous taskkill may hold the main thread (quit only). taskkill is slow even
 *  when nothing else is running: 1.1 to 2.1 s per call on Windows 11, measured on this tree shape.
 *  A 2 s cap cut it off under load before it reached the agent, and a taskkill cut off part way
 *  leaves the rest of the tree running. So the cap is only there for a taskkill that hangs. */
export const SYNC_TASKKILL_TIMEOUT_MS = 10_000

export interface KillTreeOptions {
  /** The platform the tree was started on. Defaults to this one. */
  platform?: NodeJS.Platform
  /** POSIX: the SIGTERM → SIGKILL delay. Windows has no gentle step: taskkill needs /F to end a
   *  console process at all. */
  graceMs?: number
  /** Finish before returning. This is for app quit, where the app exits right after its quit
   *  handlers return and work left to a timer can't be counted on. On Windows that exit also
   *  ends our direct child (libuv's job), and `taskkill /T` finds the rest of the tree only
   *  through a live root, so Windows waits for taskkill. POSIX sends SIGKILL straight away. */
  sync?: boolean
}

/** Injection seams for tests. Production uses the real child_process and process.kill. */
export interface KillTreeDeps {
  env?: NodeJS.ProcessEnv
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => { on(event: 'error', listener: (err: Error) => void): unknown; unref(): void }
  spawnSync?: (cmd: string, args: string[], opts: SpawnSyncOptions) => unknown
  kill?: (pid: number, signal: NodeJS.Signals) => unknown
}

/** taskkill by absolute path, so a taskkill.exe planted on PATH or in the cwd can't stand in. */
export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'taskkill.exe')
}

/**
 * End `pid` and every process under it. Returns false when there was no usable pid, and true once
 * a kill was sent, which says nothing about whether anything was still running. Never throws.
 */
export function killProcessTree(pid: number | undefined, opts: KillTreeOptions = {}, deps: KillTreeDeps = {}): boolean {
  // 0 and 1 are never ours to end: as a group, -0 is our OWN group and -1 is every process we
  // are allowed to signal.
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return false
  if ((opts.platform ?? process.platform) === 'win32') {
    // No shell: the pid is the only variable part, and it is an integer.
    const args = ['/pid', String(pid), '/T', '/F']
    try {
      if (opts.sync) {
        ;(deps.spawnSync ?? spawnSync)(taskkillPath(deps.env), args, { windowsHide: true, stdio: 'ignore', timeout: SYNC_TASKKILL_TIMEOUT_MS })
      } else {
        // Asynchronous: a blocking spawn on the main thread stalls every terminal's echo.
        const tk = (deps.spawn ?? spawn)(taskkillPath(deps.env), args, { windowsHide: true, stdio: 'ignore' })
        tk.on('error', () => { /* no taskkill to run: nothing else to try */ })
        tk.unref()
      }
    } catch { /* the same: nothing else to try */ }
    return true
  }
  const kill = deps.kill ?? ((p: number, signal: NodeJS.Signals) => process.kill(p, signal))
  const signalGroup = (signal: NodeJS.Signals): void => {
    try { kill(-pid, signal) } catch { /* ESRCH: the group is already gone */ }
  }
  if (opts.sync) {
    signalGroup('SIGKILL')
    return true
  }
  signalGroup('SIGTERM')
  // A process group ID is not reused while any member lives, so a late SIGKILL can't hit a
  // stranger's group, and unref keeps it from holding a quitting process open.
  setTimeout(() => signalGroup('SIGKILL'), opts.graceMs ?? TREE_KILL_GRACE_MS).unref()
  return true
}
