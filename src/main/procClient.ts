// Main's side of procHost: the only place in the main process that is allowed to want a child
// process, and it asks someone else to make one.
//
// See procHost.ts for why. Short version: CreateProcess is synchronous on the calling thread, main
// is the thread that pumps every PTY, and a git poll therefore froze terminals for 50-600 ms a
// spawn. Everything that used to be `execFile`/`execFileSync` on main routes through here instead.
//
// The transport is injected so the orchestration below — correlation, timeouts, restart budget,
// the in-process fallback — is testable without forking anything.

import type { ProcOptions, ProcRequest, ProcResult, SerializedProcError } from './procHost'
import { runExec, runShell, serializeProcError } from './procHost'

export interface ProcTransport {
  postMessage(msg: ProcRequest): void
  onMessage(cb: (msg: ProcResult) => void): void
  onExit(cb: (code: number) => void): void
  kill(): void
  readonly pid?: number | undefined
}

/** An Error carrying the fields callers branch on. `code` is 'ENOENT' for a missing binary and the
 *  exit status for a command that ran and failed — gitCommand's install-location fallback needs to
 *  tell those apart, and a plain `new Error(message)` would erase the difference. */
export class ProcError extends Error {
  code?: string | number
  signal?: string
  stderr?: string
  constructor(e: SerializedProcError, stderr = '') {
    super(e.message)
    this.name = 'ProcError'
    if (e.code !== undefined) this.code = e.code
    if (e.signal) this.signal = e.signal
    this.stderr = stderr
  }
}

/** Everything a caller could want to branch on, whether the command worked or not. */
export interface ProcOutcome {
  stdout: string
  stderr: string
  error?: SerializedProcError
}

interface Pending {
  resolve: (v: ProcOutcome) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

// A crash loop must not turn into a fork bomb on the thread we are protecting. Past the budget the
// host stays down and calls run in-process: slower (the old lag is back) but WORKING, which is the
// right trade for a status bar and a commit button.
const RESTART_BUDGET = 5
const RESTART_WINDOW_MS = 60_000
/** Head-room over the per-call timeout so the child, not the client, reports a genuine timeout. */
const CLIENT_TIMEOUT_SLACK_MS = 5_000

let spawner: (() => ProcTransport) | null = null
let transport: ProcTransport | null = null
let disabled = false
const pending = new Map<number, Pending>()
const restartTimes: number[] = []
let nextId = 1

/** Wired by the app at startup; never in tests, which inject their own. */
export function setProcSpawner(fn: (() => ProcTransport) | null): void {
  spawner = fn
}

export function _resetProcClientForTests(): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer)
    p.reject(new Error('proc client reset'))
  }
  pending.clear()
  try { transport?.kill() } catch { /* already gone */ }
  transport = null
  spawner = null
  disabled = false
  restartTimes.length = 0
  nextId = 1
}

/** True when the host is up and owning spawns. Exposed for the diagnostics panel. */
export function procHostActive(): boolean {
  return transport !== null
}

/**
 * Reap the host on the way out, and make sure nothing forks a replacement.
 *
 * Not just hygiene. `disabled` is the load-bearing half: the git dot, the Changes rail and the
 * status bar are all still polling while the window closes, so without it the very next poll walks
 * into `ensureTransport` and forks a BRAND NEW utility process out of a process that is trying to
 * exit. The in-flight calls are rejected for the same reason `onHostExit` rejects them — a promise
 * that can only settle by firing its own 15 s timeout is a promise nothing can await during a quit.
 */
export function shutdownProcHost(): void {
  disabled = true
  for (const p of pending.values()) {
    clearTimeout(p.timer)
    p.reject(new Error('proc host shut down'))
  }
  pending.clear()
  const t = transport
  transport = null
  try { t?.kill() } catch { /* already gone */ }
}

function withinRestartBudget(now: number): boolean {
  while (restartTimes.length > 0 && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift()
  return restartTimes.length < RESTART_BUDGET
}

function onHostExit(code: number): void {
  transport = null
  // Everything in flight died with it. Reject rather than hang: a git dot that reports nothing is
  // recoverable, a promise that never settles wedges whatever awaited it forever.
  for (const p of pending.values()) {
    clearTimeout(p.timer)
    p.reject(new Error(`proc host exited (code ${code}) with the call in flight`))
  }
  pending.clear()
  const now = Date.now()
  if (!withinRestartBudget(now)) {
    disabled = true
    return
  }
  restartTimes.push(now)
}

function ensureTransport(): ProcTransport | null {
  if (disabled) return null
  if (transport) return transport
  if (!spawner) return null
  try {
    const t = spawner()
    t.onMessage((msg) => {
      if (!msg || msg.kind !== 'result') return
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      clearTimeout(p.timer)
      p.resolve({
        stdout: msg.stdout ?? '',
        stderr: msg.stderr ?? '',
        ...(msg.ok ? {} : { error: msg.error ?? { message: 'proc host failed with no error' } }),
      })
    })
    t.onExit(onHostExit)
    transport = t
    return t
  } catch {
    // A fork that cannot even start is not worth retrying every call.
    disabled = true
    return null
  }
}

async function send(req: Omit<ProcExecRequest, 'id'> | Omit<ProcShellRequest, 'id'>, timeout: number): Promise<ProcOutcome> {
  const t = ensureTransport()
  if (!t) {
    // No host: do it here. Note this is the ONLY path in main that spawns, and it exists so the
    // app degrades to "as slow as v1.47" rather than to "git does not work".
    const r = req.kind === 'exec'
      ? await runExec(req.bin, req.args, req.opts)
      : await runShell(req.cmd, req.opts)
    // Same shape either way, so a caller can never tell (or accidentally depend on) which path ran.
    return { stdout: r.stdout, stderr: r.stderr, ...(r.error ? { error: serializeProcError(r.error) } : {}) }
  }
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`proc host call timed out after ${timeout + CLIENT_TIMEOUT_SLACK_MS}ms`))
    }, timeout + CLIENT_TIMEOUT_SLACK_MS)
    pending.set(id, { resolve, reject, timer })
    try {
      t.postMessage({ ...req, id } as ProcRequest)
    } catch (e) {
      pending.delete(id)
      clearTimeout(timer)
      reject(e)
    }
  })
}

type ProcExecRequest = Extract<ProcRequest, { kind: 'exec' }>
type ProcShellRequest = Extract<ProcRequest, { kind: 'shell' }>

const DEFAULT_TIMEOUT = 10_000

function orThrow(r: ProcOutcome): string {
  if (r.error) throw new ProcError(r.error, r.stderr)
  return r.stdout
}

/** Run a binary with argv — no shell, so metacharacters in arguments stay literal.
 *  Throws `ProcError` on failure, matching what `execFileSync` callers already catch. */
export async function execOffThread(bin: string, args: string[], opts: ProcOptions = {}): Promise<string> {
  return orThrow(await send({ kind: 'exec', bin, args, opts }, opts.timeout ?? DEFAULT_TIMEOUT))
}

/** Run a command line through a shell. Only for callers whose command is a fixed template. */
export async function execShellOffThread(cmd: string, opts: ProcOptions = {}): Promise<string> {
  return orThrow(await send({ kind: 'shell', cmd, opts }, opts.timeout ?? DEFAULT_TIMEOUT))
}

/** Non-throwing variants, for the caller that reports a failed command's own output as its result
 *  rather than treating failure as an exception. */
export function execCaptureOffThread(bin: string, args: string[], opts: ProcOptions = {}): Promise<ProcOutcome> {
  return send({ kind: 'exec', bin, args, opts }, opts.timeout ?? DEFAULT_TIMEOUT)
}

export function execShellCaptureOffThread(cmd: string, opts: ProcOptions = {}): Promise<ProcOutcome> {
  return send({ kind: 'shell', cmd, opts }, opts.timeout ?? DEFAULT_TIMEOUT)
}
