// Every child process main used to spawn, spawned somewhere else instead.
//
// `execFile` is only half asynchronous. The OUTPUT arrives on a callback, but the spawn itself —
// libuv's uv_spawn, which is CreateProcess on Windows — runs SYNCHRONOUSLY on the calling thread.
// Main is the thread that pumps every PTY, so every git poll froze the terminal for the whole
// process-creation tax. Measured on a Windows box with Defender and no exclusions, spawning
// `git status --porcelain -b -z`:
//
//     spawn() synchronous block:  p50 47.9 ms   p90 70.2 ms   max 623.3 ms   mean 94 ms
//
// With the Changes rail, the git dot and the status bar all polling, that read as 1-10 SECOND
// stalls on main's event loop (p99 887 ms, max 10,411 ms over 4,670 samples) and as ten seconds
// of typing lag in a terminal. Moving to `execFile` from `execFileSync` fixed the waiting and
// left the spawning, which was the expensive half all along.
//
// So: main never calls child_process. This host does, in a utilityProcess, where a blocked thread
// blocks nothing anyone is typing into.
//
// Constraints, same shape as memoryHost:
//  1. NOTHING heavy at import. This child exists to be cheap; pulling in the memory store or the
//     Electron app module would defeat the point and slow every fork.
//  2. Errors cross the wire as plain data. `code` carries BOTH shapes node uses — the string
//     'ENOENT' when the binary is missing and the numeric exit status when it ran and failed —
//     because gitCommand's install-location fallback keys on exactly that distinction.

import { execFile, exec } from 'child_process'
import { withoutEnv } from './gitSafety'
import { lowerHostPriority } from './hostPriority'
import { endProcessTree, signalProcessGroup, TREE_KILL_GRACE_MS, type KillTreeDeps } from './processTree'

export interface ProcExecMsg {
  kind: 'exec'
  id: number
  bin: string
  args: string[]
  opts: ProcOptions
}

export interface ProcShellMsg {
  kind: 'shell'
  id: number
  cmd: string
  opts: ProcOptions
}

export interface ProcOptions {
  cwd?: string
  timeout?: number
  maxBuffer?: number
  env?: Record<string, string | undefined>
  /** Variables added to the child's environment (`env`, or else the runner's own), not a replacement for it: a git
   *  read adds GIT_NO_LAZY_FETCH and keeps everything else, the host's GIT_OPTIONAL_LOCKS=0 included. */
  addEnv?: Record<string, string>
  /** Variables left out of the child's environment (`env`, or else the runner's own), by name in any case; a name
   *  ending in `*` leaves out every variable it starts. A git read drops what would move it away from the repository
   *  its filter scan read (gitSafety.ts guardGitDropEnv). Applied before `addEnv`. */
  dropEnv?: readonly string[]
  /** argv form only: written to the child's stdin, which is then ended. For text that must not sit
   *  on a command line (process command lines are visible to every endpoint scanner), such as a
   *  prompt carrying repository source. Without it stdin is left as before. */
  input?: string
  /** argv form only: the command may start processes of its own (an agent CLI), so a cancel and the timeout
   *  end its whole tree, not only the direct child. On macOS and Linux it is spawned detached, to lead its
   *  own process group, which is signalled even after its leader exits (its members are what is being
   *  ended; see runExec's stop); on Windows taskkill /T runs while the child is still alive and ours. A
   *  cancelled request answers with no output and a `cancelled` error (code ABORT_ERR). */
  tree?: boolean
}

export type ProcRequest = ProcExecMsg | ProcShellMsg

/** Stop an exec request still in flight, by its id. A request already answered, a shell request, or one
 *  started without `tree` is left as it is. */
export interface ProcCancelMsg {
  kind: 'cancel'
  id: number
}

/** Everything main posts to the host. */
export type ProcHostMessage = ProcRequest | ProcCancelMsg

/** macOS and Linux: the host tells main the process group a `tree` exec leads, as soon as it is spawned.
 *  Main ends the group itself if the host goes away first, a host that crashed included: SIGTERM, then
 *  SIGKILL after the grace, kept until that SIGKILL even if the result arrives in between, and at once
 *  for a group reported after the host's exit. While the host lives, the result (its word that the run is
 *  over) is when main forgets it. The host, told to go, does the same on its own way out: SIGTERM, and
 *  SIGKILL at its exit (installHostExitHandlers). Windows sends none: there the child is in the host's
 *  kill-on-close job, which ends it with the host however the host ends. */
export interface ProcTreeMsg {
  kind: 'tree'
  id: number
  pid: number
}

export interface SerializedProcError {
  message: string
  /** 'ENOENT' when the binary could not be found; the exit status when it ran and failed. Callers
   *  branch on exactly that distinction — gitCommand's install-location fallback only fires for the
   *  string form, never for "git ran and said no". */
  code?: string | number
  /** Populated on timeout kills — the caller distinguishes "slow" from "broken". */
  signal?: string
  killed?: boolean
}

/** Output is carried whether the command succeeded or not. A failing test runner says everything
 *  useful on stdout, and rejecting with only a message would throw that away. */
export interface ProcResult {
  kind: 'result'
  id: number
  ok: boolean
  stdout: string
  stderr: string
  error?: SerializedProcError
}

/** Structured-clone-safe: an Error does not survive postMessage. */
export function serializeProcError(err: unknown): SerializedProcError {
  const e = err as NodeJS.ErrnoException & { signal?: string; killed?: boolean }
  const out: SerializedProcError = { message: e?.message ? String(e.message) : String(err) }
  if (e?.code !== undefined) out.code = e.code as string | number
  if (e?.signal) out.signal = String(e.signal)
  if (e?.killed) out.killed = true
  return out
}

const DEFAULT_TIMEOUT = 10_000
const DEFAULT_MAX_BUFFER = 1024 * 1024

function baseOptions(opts: ProcOptions): {
  cwd?: string
  timeout: number
  maxBuffer: number
  windowsHide: true
  env?: Record<string, string | undefined>
} {
  return {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    windowsHide: true,
    ...(opts.env || opts.addEnv || opts.dropEnv?.length ? { env: { ...withoutEnv(opts.env ?? process.env, opts.dropEnv ?? []), ...opts.addEnv } } : {}),
  }
}

/** What both runners settle with. They never REJECT: node hands `exec` the output even when the
 *  command failed, and a rejection would throw it away — which matters, because the one caller that
 *  runs arbitrary commands (runSafeCommand) reports that output to the user as the result. */
export interface RunOutcome {
  stdout: string
  stderr: string
  error?: unknown
}

/** How long a stopped tree has to close its pipes before its request is answered anyway: a process
 *  outside the tree (one that broke away) can hold them open for good. */
export const TREE_STOP_SETTLE_MS = 3_000

export interface RunExecDeps {
  platform?: NodeJS.Platform
  endTree?: typeof endProcessTree
  /** macOS and Linux, `tree` only: told the pid of the process group just spawned. */
  onGroup?: (pid: number) => void
}

/** macOS and Linux: the process groups `tree` runs lead, while their request is unanswered. They are
 *  detached (their own session), so nothing else ends them when this process goes: its own exit does. */
const groupsInFlight = new Set<number>()

/** The groups a `tree` run in this process leads now: main sweeps its own (fallback runs) at quit. */
export function treeGroupsInFlight(): number[] {
  return [...groupsInFlight]
}

/** The error a cancelled request answers with: AbortError's code, and no output. */
export function cancelledError(): Error {
  return Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' })
}

/** argv form: no shell, so a file name full of metacharacters is one literal argument. With
 *  `opts.tree`, `signal` cancels it, and a cancel or the timeout ends its whole tree. */
export function runExec(bin: string, args: string[], opts: ProcOptions, signal?: AbortSignal, deps: RunExecDeps = {}): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const tree = opts.tree === true
    const base = baseOptions(opts)
    if (tree && signal?.aborted) return resolve({ stdout: '', stderr: '', error: cancelledError() })
    const isWin = (deps.platform ?? process.platform) === 'win32'
    let settled = false
    let stopped: 'cancelled' | 'timeout' | null = null
    let exited = false
    let limit: ReturnType<typeof setTimeout> | undefined
    let backstop: ReturnType<typeof setTimeout> | undefined
    let group: number | undefined
    const finish = (r: RunOutcome): void => {
      if (settled) return
      settled = true
      if (group !== undefined) groupsInFlight.delete(group)
      clearTimeout(limit)
      clearTimeout(backstop)
      signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const stoppedOutcome = (stdout: string, stderr: string): RunOutcome => stopped === 'cancelled'
      ? { stdout: '', stderr, error: cancelledError() }
      : { stdout, stderr, error: Object.assign(new Error(`timed out after ${base.timeout}ms`), { killed: true, signal: 'SIGTERM' }) }
    // The tree first, while its root lives: `taskkill /T` walks down from a live root only, and once the
    // child's 'exit' has run its pid may name a stranger. The request is answered when the pipes close,
    // or by the backstop.
    //
    // On POSIX the group is signalled even after its leader has exited, ON PURPOSE: do not gate it on
    // `exited` the way Windows is. A process group outlives its leader, and the members still in it
    // (claude's tool subprocesses) are exactly what this kill is for. The pgid stays reserved while any
    // member lives, so `-pid` can only name a stranger once the whole group is gone AND the pid has been
    // handed out again in the moments before the signal lands: the same narrow window accepted for the
    // SIGKILL that follows the SIGTERM (processTree's ESRCH check).
    const stop = (why: 'cancelled' | 'timeout'): void => {
      if (settled || stopped) return
      stopped = why
      clearTimeout(limit)
      if (!(isWin && exited)) void (deps.endTree ?? endProcessTree)(child.pid, { platform: deps.platform, canRetry: () => !exited })
      backstop = setTimeout(() => finish(stoppedOutcome('', '')), TREE_STOP_SETTLE_MS)
    }
    const onAbort = (): void => stop('cancelled')
    // With `tree` the timeout is this module's, so it ends the tree too; execFile's own would end the child only.
    const child = execFile(bin, args, { ...base, ...(tree ? { timeout: 0, detached: !isWin } : {}), shell: false }, (err, stdout, stderr) => {
      if (stopped) return finish(stoppedOutcome(String(stdout ?? ''), String(stderr ?? '')))
      finish({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ...(err ? { error: err } : {}) })
    })
    if (tree) {
      if (!isWin && child.pid !== undefined) {
        group = child.pid
        groupsInFlight.add(group)
        deps.onGroup?.(group)
      }
      child.on('exit', () => { exited = true })
      if (base.timeout > 0) limit = setTimeout(() => stop('timeout'), base.timeout)
      signal?.addEventListener('abort', onAbort, { once: true })
    }
    if (opts.input !== undefined && child.stdin) {
      // A child that exits before reading everything raises EPIPE here; its exit already reports it.
      child.stdin.on('error', () => undefined)
      child.stdin.end(opts.input)
    }
  })
}

/** Shell form, for the callers that genuinely need one: `where`/`which` binary probes, the
 *  login-shell PATH dump, and Windows `.cmd` shims which CreateProcess cannot launch directly. */
export function runShell(cmd: string, opts: ProcOptions): Promise<RunOutcome> {
  return new Promise((resolve) => {
    exec(cmd, baseOptions(opts), (err, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ...(err ? { error: err } : {}) })
    })
  })
}

/** The exec requests in flight, by id, so a cancel can reach the one it names. */
const inFlight = new Map<number, AbortController>()

/** `post` carries the host's other messages to main: the process group of a `tree` run, once spawned. */
export async function handleProcMessage(msg: ProcHostMessage, post?: (m: ProcTreeMsg) => void): Promise<ProcResult | null> {
  if (msg?.kind === 'cancel') {
    inFlight.get(msg.id)?.abort()
    return null
  }
  if (!msg || (msg.kind !== 'exec' && msg.kind !== 'shell')) return null
  let run: Promise<RunOutcome>
  if (msg.kind === 'exec') {
    const ctl = new AbortController()
    inFlight.set(msg.id, ctl)
    const id = msg.id
    const onGroup = post ? (pid: number): void => post({ kind: 'tree', id, pid }) : undefined
    run = runExec(msg.bin, msg.args, msg.opts, ctl.signal, onGroup ? { onGroup } : {}).finally(() => { inFlight.delete(id) })
  } else {
    run = runShell(msg.cmd, msg.opts)
  }
  const { stdout, stderr, error } = await run
  return error
    ? { kind: 'result', id: msg.id, ok: false, stdout, stderr, error: serializeProcError(error) }
    : { kind: 'result', id: msg.id, ok: true, stdout, stderr }
}

/** The part of `process` the host's exit handling needs. */
export interface HostProcessLike {
  on(event: 'SIGTERM' | 'SIGINT' | 'exit', listener: () => void): unknown
  exit(code?: number): void
}

export interface HostExitDeps extends KillTreeDeps {
  graceMs?: number
}

/**
 * Tests only: the real-process suite sets this in a forked host's environment to lengthen its exit grace,
 * so a stalled runner cannot outlast it. Nothing in the app sets it, so the host keeps TREE_KILL_GRACE_MS.
 */
export const HOST_GRACE_ENV = 'TERMPOLIS_TEST_PROC_HOST_GRACE_MS'

/** The host's exit grace: HOST_GRACE_ENV when it is a whole number of ms from 1 to 60 000, else the 2 s default. */
export function hostGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const ms = Number(env[HOST_GRACE_ENV])
  return Number.isInteger(ms) && ms >= 1 && ms <= 60_000 ? ms : TREE_KILL_GRACE_MS
}

/**
 * The host ends the process groups of its `tree` runs on its way out (macOS and Linux). They are
 * detached, so they would outlive it: a SIGTERM or SIGINT to the host (shutdownProcHost's kill, a Ctrl+C
 * in a dev terminal) sends them SIGTERM, and the host exits after the grace; its 'exit', however it was
 * reached (process.exit on an unhandled rejection included), sends SIGKILL to every group still
 * unanswered and to every group it sent SIGTERM, answered since or not: a run is answered when its pipes
 * close, and a member that ignores SIGTERM and has let go of them is still there (stop() escalates the
 * same way). Only process.kill(-pid): nothing is spawned or listed. A host killed outright runs none of
 * this, which is why it also reports each group to main (ProcTreeMsg).
 *
 * Nothing here can see main die, and nothing tries. A utilityProcess has no Node IPC channel, so no
 * 'disconnect'; its parentPort emits only 'message' and closes silently when the pipe breaks (Electron
 * 43, shell/services/node/parent_port.cc); and on macOS and Linux Chromium ends a child whose browser
 * channel breaks with TerminateCurrentProcessImmediately, before any JS (a timer polling process.ppid
 * included) could run. So a crash of main itself leaves a POSIX group running; every exit main lives
 * through is covered, here or in procClient.
 *
 * Windows has nothing to do here: a `tree` run's child is not detached there, so libuv puts it in this
 * host's kill-on-close job, and it ends with the host on any exit, a crash included. Its own ordinary
 * children are in its job in turn. Only a descendant that detaches itself is out of reach, the known
 * Job Object gap processTree.ts names.
 */
export function installHostExitHandlers(proc: HostProcessLike, deps: HostExitDeps = {}): void {
  // Read once, at startup.
  const graceMs = deps.graceMs ?? hostGraceMs()
  let leaving = false
  /** The groups leave() sent SIGTERM that were there to get it: each gets its SIGKILL at the exit. */
  const termed = new Set<number>()
  const leave = (): void => {
    if (leaving) return
    leaving = true
    if (groupsInFlight.size === 0) return proc.exit(0)
    for (const pid of groupsInFlight) {
      if (signalProcessGroup(pid, 'SIGTERM', deps) !== 'gone') termed.add(pid)
    }
    setTimeout(() => proc.exit(0), graceMs)
  }
  proc.on('SIGTERM', leave)
  proc.on('SIGINT', leave)
  proc.on('exit', () => {
    for (const pid of new Set([...termed, ...groupsInFlight])) signalProcessGroup(pid, 'SIGKILL', deps)
    termed.clear()
    groupsInFlight.clear()
  })
}

/** Resets the groups this module tracks. Tests only. */
export function _resetProcHostForTests(): void {
  groupsInFlight.clear()
  inFlight.clear()
}

interface ParentPortLike {
  on(event: 'message', cb: (e: { data: ProcHostMessage }) => void): void
  postMessage(msg: ProcResult | ProcTreeMsg): void
}

// `process.parentPort` exists ONLY when this module runs as a forked utilityProcess, so importing
// it from a test is inert. Note the asymmetry that bites every time: in the CHILD the payload is
// `e.data`; in the PARENT `child.on('message', m => …)` receives it directly.
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort

/* c8 ignore start */
if (parentPort) {
  // The first thing a forked host does: lower its OWN priority (never another process's, never main's).
  // Kill switch TERMPOLIS_NO_HOST_PRIORITY=1. Inside this block, so main and the unit suite never run it.
  lowerHostPriority({ host: 'proc' })
  // Every git this host starts skips git's OPTIONAL locks. `git status` otherwise takes .git/index.lock to refresh
  // the index, and the git dot polls status every few seconds: a person's own `git commit` or `git add` landing in
  // that window failed with "Unable to create '.git/index.lock': File exists" (the git-dot e2e hit it in CI on
  // v1.55.3). Writes still take the locks they need; only the opportunistic refresh is skipped. Set in this host's
  // own environment, so it never reaches a terminal (those inherit main's).
  process.env.GIT_OPTIONAL_LOCKS = '0'
  // Electron 37 stopped ending a utility process on an unhandled rejection: it only warns now.
  // The parent restarts this child when it dies and falls back when it keeps dying, which assumes
  // a child in an unknown state goes away. So it still does. Inside this block, not at the top:
  // main imports this module too, and there it must not exit the app.
  process.on('unhandledRejection', (reason) => {
    console.error('[proc host] unhandled rejection:', reason)
    process.exit(1)
  })
  installHostExitHandlers(process)
  const post = (m: ProcTreeMsg): void => parentPort.postMessage(m)
  parentPort.on('message', (e) => {
    const msg = e?.data
    const id = (msg as ProcRequest)?.id
    void handleProcMessage(msg, post)
      .then((res) => { if (res) parentPort.postMessage(res) })
      .catch((err) => {
        if (typeof id === 'number') {
          parentPort.postMessage({ kind: 'result', id, ok: false, error: serializeProcError(err) })
        }
      })
  })
}
/* c8 ignore stop */
