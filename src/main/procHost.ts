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
}

export type ProcRequest = ProcExecMsg | ProcShellMsg

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
    ...(opts.env ? { env: opts.env } : {}),
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

/** argv form: no shell, so a file name full of metacharacters is one literal argument. */
export function runExec(bin: string, args: string[], opts: ProcOptions): Promise<RunOutcome> {
  return new Promise((resolve) => {
    execFile(bin, args, { ...baseOptions(opts), shell: false }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ...(err ? { error: err } : {}) })
    })
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

export async function handleProcMessage(msg: ProcRequest): Promise<ProcResult | null> {
  if (!msg || (msg.kind !== 'exec' && msg.kind !== 'shell')) return null
  const { stdout, stderr, error } = msg.kind === 'exec'
    ? await runExec(msg.bin, msg.args, msg.opts)
    : await runShell(msg.cmd, msg.opts)
  return error
    ? { kind: 'result', id: msg.id, ok: false, stdout, stderr, error: serializeProcError(error) }
    : { kind: 'result', id: msg.id, ok: true, stdout, stderr }
}

interface ParentPortLike {
  on(event: 'message', cb: (e: { data: ProcRequest }) => void): void
  postMessage(msg: ProcResult): void
}

// `process.parentPort` exists ONLY when this module runs as a forked utilityProcess, so importing
// it from a test is inert. Note the asymmetry that bites every time: in the CHILD the payload is
// `e.data`; in the PARENT `child.on('message', m => …)` receives it directly.
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort

/* c8 ignore start */
if (parentPort) {
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
