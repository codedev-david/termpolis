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
// Known gap (out of scope for 2.0): no Job Object (KILL_ON_JOB_CLOSE) or Linux cgroup, so a grandchild that detaches from the tree or calls setsid outlives a stop.
//
// Nothing here throws. A tree that is already gone is not a failure: ESRCH from a group, or a
// taskkill the caller says not to repeat. Any other failure is logged once per kill, as one line
// that names only the pid and the exit or error code, and a failed taskkill is tried once more
// while the caller says its root is still alive, unless taskkill found no such process.

import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'child_process'
import path from 'path'

/** How long a process group gets to exit on SIGTERM before it is sent SIGKILL. */
export const TREE_KILL_GRACE_MS = 2_000

/** How long a synchronous taskkill may hold the main thread (quit only). taskkill is slow even
 *  when nothing else is running: 1.1 to 2.1 s per call on Windows 11, measured on this tree shape.
 *  A 2 s cap cut it off under load before it reached the agent, and a taskkill cut off part way
 *  leaves the rest of the tree running. So the cap is only there for a taskkill that hangs. */
export const SYNC_TASKKILL_TIMEOUT_MS = 10_000

/** The same cap for the asynchronous taskkill, so one that hangs still ends, is logged and can be
 *  tried again, instead of waiting forever. */
export const TASKKILL_TIMEOUT_MS = SYNC_TASKKILL_TIMEOUT_MS

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
  /** Windows, asynchronous only: asked after a taskkill fails, just before it is tried once more.
   *  Answer true only while the root is still the caller's own child and has not exited. Windows
   *  reuses pids, and only the caller's open handle on a live child keeps the pid from naming a
   *  stranger. Without it a failed taskkill is logged and not repeated. */
  canRetry?: () => boolean
}

/** The part of a spawned taskkill used here. */
export interface TaskkillChild {
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  unref(): void
}

/** Injection seams for tests. Production uses the real child_process, process.kill and console. */
export interface KillTreeDeps {
  env?: NodeJS.ProcessEnv
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => TaskkillChild
  spawnSync?: (cmd: string, args: string[], opts: SpawnSyncOptions) => unknown
  kill?: (pid: number, signal: NodeJS.Signals) => unknown
  log?: (line: string) => void
}

/** taskkill by absolute path, so a taskkill.exe planted on PATH or in the cwd can't stand in. */
export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'taskkill.exe')
}

/** 0 and 1 are never ours to end: as a group, -0 is our OWN group and -1 is every process we are
 *  allowed to signal. */
function usablePid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isInteger(pid) && pid > 1
}

/** What a taskkill ended with: 0 for success, else its exit code, the signal that ended it (the
 *  timeout), or the error code of a spawn that failed. */
type Outcome = number | string

/** taskkill's exit code when no process has the pid. A retry can't help then: /T walks a tree only
 *  down from a live root, and by the time it ran the root's pid could name a stranger. */
const TASKKILL_NOT_FOUND = 128

function errorCode(e: unknown): string {
  return String((e as NodeJS.ErrnoException | undefined)?.code ?? 'error')
}

function logOf(deps: KillTreeDeps): (line: string) => void {
  return deps.log ?? ((line: string): void => { console.warn(line) })
}

function logTaskkill(log: (line: string) => void, pid: number, outcome: Outcome): void {
  log(`[processTree] taskkill did not end pid ${pid} (exit ${outcome})`)
}

// No shell: the pid is the only variable part, and it is an integer.
const taskkillArgs = (pid: number): string[] => ['/pid', String(pid), '/T', '/F']

/** One asynchronous taskkill, settled when it exits or fails to start. Never rejects. */
function taskkillOnce(pid: number, deps: KillTreeDeps): Promise<Outcome> {
  return new Promise((resolve) => {
    let done = false
    const end = (outcome: Outcome): void => { if (!done) { done = true; resolve(outcome) } }
    try {
      // Asynchronous: a blocking spawn on the main thread stalls every terminal's echo. Node arms
      // the timeout with a timer of its own that unref() doesn't reach, so a taskkill still running
      // keeps a plain Node process alive until it exits or times out. Electron's quit doesn't wait.
      const tk = (deps.spawn ?? spawn)(taskkillPath(deps.env), taskkillArgs(pid), { windowsHide: true, stdio: 'ignore', timeout: TASKKILL_TIMEOUT_MS })
      // An 'error' with no listener would be thrown as an uncaught exception in the main process.
      tk.on('error', (e) => end(errorCode(e)))
      tk.on('exit', (code, signal) => end(code ?? signal ?? 'none'))
      tk.unref()
    } catch (e) { end(errorCode(e)) }
  })
}

/** How a signal to a process group went: sent, the group was gone (ESRCH), or another failure. */
type GroupResult = 'sent' | 'gone' | 'failed'

/** Signals a process group, logging any failure but ESRCH once per kill. */
function groupSignaller(pid: number, deps: KillTreeDeps): (signal: NodeJS.Signals) => GroupResult {
  const kill = deps.kill ?? ((p: number, signal: NodeJS.Signals) => process.kill(p, signal))
  const log = logOf(deps)
  let logged = false
  return (signal) => {
    try {
      kill(-pid, signal)
      return 'sent'
    } catch (e) {
      const code = errorCode(e)
      // ESRCH: the group is already gone, which is what a kill wants.
      if (code === 'ESRCH') return 'gone'
      if (!logged) { logged = true; log(`[processTree] ${signal} did not reach process group ${pid} (${code})`) }
      return 'failed'
    }
  }
}

/**
 * End `pid` and every process under it, asynchronously. Resolves true once the kill is confirmed
 * sent: taskkill exited 0, or the POSIX group took SIGTERM or was already gone. Resolves false
 * for an unusable pid or a kill that failed (after one retry where `canRetry` allows it), and
 * logs that failure once. A true says the signal was delivered, not that every process has ended:
 * the caller confirms that by its child's exit and its pipes closing. Never rejects.
 */
export async function endProcessTree(pid: number | undefined, opts: Omit<KillTreeOptions, 'sync'> = {}, deps: KillTreeDeps = {}): Promise<boolean> {
  if (!usablePid(pid)) return false
  if ((opts.platform ?? process.platform) === 'win32') {
    let outcome = await taskkillOnce(pid, deps)
    if (outcome !== 0 && outcome !== TASKKILL_NOT_FOUND) {
      let again = false
      try { again = opts.canRetry?.() === true } catch { /* no answer is a no */ }
      if (again) outcome = await taskkillOnce(pid, deps)
    }
    if (outcome === 0) return true
    logTaskkill(logOf(deps), pid, outcome)
    return false
  }
  const signalGroup = groupSignaller(pid, deps)
  const term = signalGroup('SIGTERM')
  // A process group ID is not reused while any member lives. Once SIGTERM finds no member (ESRCH)
  // the ID is free, so no SIGKILL follows. A group whose last member dies during the grace leaves
  // that window open for the SIGKILL. unref keeps the timer from holding a quitting process open.
  if (term !== 'gone') setTimeout(() => signalGroup('SIGKILL'), opts.graceMs ?? TREE_KILL_GRACE_MS).unref()
  return term !== 'failed'
}

/**
 * End `pid` and every process under it. Returns false when there was no usable pid, and true once
 * a kill was sent, which says nothing about whether anything was still running. Never throws.
 * Without `sync` the kill finishes in the background, as endProcessTree.
 */
export function killProcessTree(pid: number | undefined, opts: KillTreeOptions = {}, deps: KillTreeDeps = {}): boolean {
  if (!usablePid(pid)) return false
  if (!opts.sync) {
    void endProcessTree(pid, opts, deps)
    return true
  }
  if ((opts.platform ?? process.platform) === 'win32') {
    // At quit there is no retry: the app exits right after, and the child's 'exit' event, the
    // only proof that the pid is still ours, can't arrive while this blocks.
    let outcome: Outcome
    try {
      const r = (deps.spawnSync ?? spawnSync)(taskkillPath(deps.env), taskkillArgs(pid), { windowsHide: true, stdio: 'ignore', timeout: SYNC_TASKKILL_TIMEOUT_MS }) as
        { status?: number | null; signal?: NodeJS.Signals | null; error?: Error } | undefined
      outcome = r?.error ? errorCode(r.error) : (r?.status ?? r?.signal ?? 'none')
    } catch (e) { outcome = errorCode(e) }
    if (outcome !== 0) logTaskkill(logOf(deps), pid, outcome)
    return true
  }
  groupSignaller(pid, deps)('SIGKILL')
  return true
}
