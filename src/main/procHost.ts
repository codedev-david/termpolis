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
import { endProcessTree } from './processTree'

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
   *  own process group; on Windows taskkill /T runs while the child is still alive and ours. A cancelled
   *  request answers with no output and a `cancelled` error (code ABORT_ERR). */
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
    const finish = (r: RunOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(limit)
      clearTimeout(backstop)
      signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const stoppedOutcome = (stdout: string, stderr: string): RunOutcome => stopped === 'cancelled'
      ? { stdout: '', stderr, error: cancelledError() }
      : { stdout, stderr, error: Object.assign(new Error(`timed out after ${base.timeout}ms`), { killed: true, signal: 'SIGTERM' }) }
    // The tree first, while its root lives: `taskkill /T` walks down from a live root only, and once the
    // child's 'exit' has run its pid may name a stranger. A POSIX group outlives its leader, so it is
    // still signalled. The request is answered when the pipes close, or by the backstop.
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

export async function handleProcMessage(msg: ProcHostMessage): Promise<ProcResult | null> {
  if (msg?.kind === 'cancel') {
    inFlight.get(msg.id)?.abort()
    return null
  }
  if (!msg || (msg.kind !== 'exec' && msg.kind !== 'shell')) return null
  let run: Promise<RunOutcome>
  if (msg.kind === 'exec') {
    const ctl = new AbortController()
    inFlight.set(msg.id, ctl)
    run = runExec(msg.bin, msg.args, msg.opts, ctl.signal).finally(() => { inFlight.delete(msg.id) })
  } else {
    run = runShell(msg.cmd, msg.opts)
  }
  const { stdout, stderr, error } = await run
  return error
    ? { kind: 'result', id: msg.id, ok: false, stdout, stderr, error: serializeProcError(error) }
    : { kind: 'result', id: msg.id, ok: true, stdout, stderr }
}

interface ParentPortLike {
  on(event: 'message', cb: (e: { data: ProcHostMessage }) => void): void
  postMessage(msg: ProcResult): void
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
  parentPort.on('message', (e) => {
    const msg = e?.data
    const id = (msg as ProcRequest)?.id
    void handleProcMessage(msg)
      .then((res) => { if (res) parentPort.postMessage(res) })
      .catch((err) => {
        if (typeof id === 'number') {
          parentPort.postMessage({ kind: 'result', id, ok: false, error: serializeProcError(err) })
        }
      })
  })
}
/* c8 ignore stop */
