// Main's side of procHost: the only place in the main process that is allowed to want a child
// process, and it asks someone else to make one.
//
// See procHost.ts for why. Short version: CreateProcess is synchronous on the calling thread, main
// is the thread that pumps every PTY, and a git poll therefore froze terminals for 50-600 ms a
// spawn. Everything that used to be `execFile`/`execFileSync` on main routes through here instead.
//
// The transport is injected so the orchestration below — correlation, timeouts, restart budget,
// the in-process fallback — is testable without forking anything.

import type { ProcHostMessage, ProcOptions, ProcRequest, ProcResult, ProcTreeMsg, SerializedProcError } from './procHost'
import { cancelledError, runExec, runShell, serializeProcError, treeGroupsInFlight } from './procHost'
import { signalProcessGroup, TREE_KILL_GRACE_MS } from './processTree'

export interface ProcTransport {
  postMessage(msg: ProcHostMessage): void
  onMessage(cb: (msg: ProcResult | ProcTreeMsg) => void): void
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

/**
 * macOS and Linux: the process groups the host's `tree` runs lead, by request id, from the host's
 * ProcTreeMsg until that request's result. They are detached, so a host that dies leaves them running:
 * a host killed outright cannot end them itself. Main then does, with process.kill(-pid) only (no
 * spawn, nothing listed): SIGTERM, then SIGKILL after the grace, and SIGKILL for any left at quit.
 *
 * Only a pid the host reported, and whose result it has not sent, is ever signalled: the result is the
 * host's word that the run is over, after which the pid may be someone else's. A group stays reserved
 * while any member lives, so the one window left is a group whose last member dies in the grace before
 * its SIGKILL, the window processTree accepts too. Windows never reports one (see ProcTreeMsg).
 */
interface TrackedGroup {
  pid: number
  /** The host that runs it; null once that host is gone or shut down and main is ending the group. */
  host: ProcTransport | null
  escalation?: ReturnType<typeof setTimeout>
}
const groups = new Map<number, TrackedGroup>()
/**
 * Hosts whose exit main has seen. Neither Node nor Electron promises that a child's last message
 * arrives before its exit, so a group can be reported after its host is gone: it is ended at once.
 */
const exitedHosts = new WeakSet<ProcTransport>()

function forgetGroup(id: number): void {
  const g = groups.get(id)
  if (!g) return
  clearTimeout(g.escalation)
  groups.delete(id)
}

/** SIGTERM now, SIGKILL after the grace unless the group was gone. Kept until then, so a quit in the grace still ends it. */
function endGroup(id: number, g: TrackedGroup): void {
  if (g.host === null) return
  g.host = null
  if (signalProcessGroup(g.pid, 'SIGTERM') === 'gone') return void groups.delete(id)
  g.escalation = setTimeout(() => {
    groups.delete(id)
    signalProcessGroup(g.pid, 'SIGKILL')
  }, TREE_KILL_GRACE_MS)
  g.escalation.unref()
}

/** Ends the groups `host` left behind, or every group when `host` is undefined. */
function endGroupsOf(host?: ProcTransport): void {
  for (const [id, g] of [...groups]) if (host === undefined || g.host === host) endGroup(id, g)
}

/**
 * At quit (will-quit): SIGKILL for every process group a labelling run still leads, those the host
 * reported and those of runs main made itself while the host was down. The app exits right after, so
 * the grace's timer could not be counted on. No spawn: process.kill(-pid) only.
 */
export function endProcHostGroupsNow(): void {
  for (const [id, g] of [...groups]) {
    forgetGroup(id)
    signalProcessGroup(g.pid, 'SIGKILL')
  }
  for (const pid of treeGroupsInFlight()) signalProcessGroup(pid, 'SIGKILL')
}

/** The pids main would end if the host went now. Tests only. */
export function _trackedGroupsForTests(): number[] {
  return [...groups.values()].map((g) => g.pid)
}

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
  for (const id of [...groups.keys()]) forgetGroup(id)
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
  // The host ends its groups on the SIGTERM below, unless it is wedged or dies first: main does too,
  // and endProcHostGroupsNow sends SIGKILL to whatever is left at will-quit.
  endGroupsOf()
  const t = transport
  transport = null
  try { t?.kill() } catch { /* already gone */ }
}

function withinRestartBudget(now: number): boolean {
  while (restartTimes.length > 0 && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift()
  return restartTimes.length < RESTART_BUDGET
}

function onHostExit(host: ProcTransport, code: number): void {
  if (transport === host) transport = null
  exitedHosts.add(host)
  // Its labelling runs' groups did not die with it (they are detached): end them here.
  endGroupsOf(host)
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
      if (msg?.kind === 'tree') {
        if (typeof msg.id === 'number' && Number.isInteger(msg.pid) && msg.pid > 1) {
          const g: TrackedGroup = { pid: msg.pid, host: t }
          groups.set(msg.id, g)
          if (exitedHosts.has(t)) endGroup(msg.id, g)
        }
        return
      }
      if (!msg || msg.kind !== 'result') return
      // The run is over: its pid is no longer the host's to report, nor main's to signal. Unless main is
      // already ending the group: the answer only means its pipes closed, and a member that ignores
      // SIGTERM and let go of them is still there, so the SIGKILL stays armed (endProcessTree's rule).
      if (groups.get(msg.id)?.host !== null) forgetGroup(msg.id)
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
    t.onExit((code) => onHostExit(t, code))
    transport = t
    return t
  } catch {
    // A fork that cannot even start is not worth retrying every call.
    disabled = true
    return null
  }
}

async function send(req: Omit<ProcExecRequest, 'id'> | Omit<ProcShellRequest, 'id'>, timeout: number, signal?: AbortSignal): Promise<ProcOutcome> {
  // Cancelled before it was asked: nothing starts.
  if (signal?.aborted) return { stdout: '', stderr: '', error: serializeProcError(cancelledError()) }
  const t = ensureTransport()
  if (!t) {
    // No host: do it here. This is the fallback, taken only while the host is down or after it has used up
    // its restart budget: it exists so the app degrades to "as slow as v1.47" rather than to "git does not
    // work". It is NOT the only place main creates a process (terminals, the host forks themselves, a quit-time
    // taskkill and a few user-started actions are others): tests/electron/main-thread-allowlist.json lists every
    // one and why it may stay, and tests/electron/mainThreadScan.test.ts fails on a new one.
    const r = req.kind === 'exec'
      ? await runExec(req.bin, req.args, req.opts, signal)
      : await runShell(req.cmd, req.opts)
    // Same shape either way, so a caller can never tell (or accidentally depend on) which path ran.
    return { stdout: r.stdout, stderr: r.stderr, ...(r.error ? { error: serializeProcError(r.error) } : {}) }
  }
  const id = nextId++
  // A cancel is the host's to carry out: it ends the request's tree and answers it, so the call settles
  // once the tree is stopped (or by the host's backstop), never while the CLI still runs.
  const onAbort = (): void => { try { t.postMessage({ kind: 'cancel', id }) } catch { /* the host is gone, and the call with it */ } }
  return new Promise<ProcOutcome>((resolve, reject) => {
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
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  }).finally(() => signal?.removeEventListener('abort', onAbort))
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
 *  rather than treating failure as an exception. With `opts.tree`, `signal` cancels the command and
 *  ends its whole tree; the call then settles with a `cancelled` error (code ABORT_ERR) and no output. */
export function execCaptureOffThread(bin: string, args: string[], opts: ProcOptions = {}, signal?: AbortSignal): Promise<ProcOutcome> {
  return send({ kind: 'exec', bin, args, opts }, opts.timeout ?? DEFAULT_TIMEOUT, opts.tree ? signal : undefined)
}

export function execShellCaptureOffThread(cmd: string, opts: ProcOptions = {}): Promise<ProcOutcome> {
  return send({ kind: 'shell', cmd, opts }, opts.timeout ?? DEFAULT_TIMEOUT)
}
