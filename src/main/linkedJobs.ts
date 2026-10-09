// The executing side of Linked machines: what another computer may ask this
// one to do, checked and run.
//
// The bridge is transport and this is policy (spec §5). Every request that
// reaches here arrived over the network from a machine trusted only up to the
// grants the user gave it, so each field is validated before anything is
// spawned, and every refusal is a sentence a person can act on -- the bridge
// sends the message back verbatim, and the agent on the other machine reads it.
//
// Jobs run through the existing headless executor with the confinement rules
// in spec §4.5: Termpolis's own MCP cut down to this machine's memory and code
// index, read-only (linkedJob; the stdio adapter enforces it), the job marked in its
// environment so a nested delegation is refused, nothing written to the brain
// (output another machine asked for must not become a later run's primer), and
// read-only unless the write grant is held. The memory primer IS kept: a job
// run here should start as warm as one started here.
//
// Jobs live in memory only. A restart forgets them, and the asking machine's
// next poll gets `unknown job`.
import path from 'path'
import { normalizeShellPath } from '../shared/cwdPath'
import {
  EXEC_DEFAULT_TIMEOUT_MS,
  clampExecTimeout,
  isExecAgent,
  type ExecRequest,
  type ExecResult,
} from './headlessExec'
import type { LinkTarget, PeerAgent, PeerHelloInfo, PeerJobView, PeerRequest } from './remoteBridge/protocol'
import { normalizeGrants, refOf, type LinkedGrants, type LinkMeta } from './linkedStore'

/** One row of the activity view, for a job either machine started. */
export interface LinkedActivity {
  /** The executor's job id for an inbound job; `<link id>-<job id>` for an outbound one. */
  id: string
  direction: 'in' | 'out'
  ref: string
  machine: string
  agent: string
  summary: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: number
  durationMs?: number
}

export interface LinkedJobsDeps {
  /** The caller binds deliver and the primer. */
  runHeadless(req: ExecRequest): Promise<ExecResult>
  agentsInstalled(): Promise<{ claude: boolean; codex: boolean; gemini: boolean }>
  localName(): string
  version: string
  homedir(): string
  /** Whether a path is an existing directory. May answer asynchronously -- this
   *  runs on the main thread, where a synchronous stat of a slow disk stalls the
   *  whole app (see headlessExec's own check). */
  isDirectory(p: string): boolean | Promise<boolean>
  /** modelCatalog.isSafeModelId. */
  isSafeModel(model: string): boolean
  now(): number
  /** 12 lowercase hex. */
  randomId(): string
  /** Called when a job starts and on every status change, under the same id. */
  onActivity(a: LinkedActivity): void
}

/** The longest prompt another machine may send. Below the 24,000 the spec
 *  allows, leaving room for the framing line and the primer inside the Windows
 *  command-line limit of 32,767. */
export const MAX_PROMPT_CHARS = 20_000

/** An answer longer than this keeps its TAIL -- where an agent puts its
 *  conclusion -- so a reply stays far below the relay's 1 MiB frame. */
export const MAX_OUTPUT_CHARS = 200_000

/** ...and its tail is cut further to this many bytes once written as a JSON
 *  string. Characters alone do not bound a reply: a control character is six
 *  bytes there (`\u0001`), so 200,000 of them make 1.2 MB -- a reply the bridge
 *  refuses to send, losing a finished answer on every poll. Three bytes a
 *  character is the most text free of control characters takes, so no such
 *  answer is cut by this. */
export const MAX_OUTPUT_JSON_BYTES = 3 * MAX_OUTPUT_CHARS + 2

/** At most this many jobs at once for one linked machine... */
export const MAX_JOBS_PER_LINK = 2

/** ...and this many in all. Anything past either is refused with `busy:`. */
export const MAX_JOBS_TOTAL = 4

/** A finished job is kept this long for the asking machine to collect... */
export const JOB_RETENTION_MS = 2 * 60 * 60_000

/** ...and at most this many finished jobs are kept, the oldest forgotten first. */
export const MAX_FINISHED_JOBS = 100

/** The longest a `peerResult` is held. Mirrors MAX_PEER_WAIT_MS in the bridge
 *  (remoteBridge/entry.ts), which waits on main this long plus a grace. */
export const MAX_RESULT_WAIT_MS = 50_000

/** An error is stderr, which can be a whole log; its end says what went wrong. */
const MAX_ERROR_CHARS = 4_000

/** Longer than any real path; refused before it reaches the file system. */
const MAX_CWD_CHARS = 4_096

/** How much of an echoed path a refusal shows. */
const MAX_ECHO_CHARS = 200

const SUMMARY_CHARS = 80

const JOB_ID_RE = /^[0-9a-f]{12}$/

const NO_AGENTS = { claude: false, codex: false, gemini: false }
const NO_GRANTS: LinkedGrants = { run: false, write: false }

type JobStatus = PeerJobView['status']

interface Outcome {
  status: Exclude<JobStatus, 'running'>
  output?: string
  error?: string
}

interface Job {
  id: string
  /** The ref of the machine that started it: the only one that may read or cancel it. */
  owner: string
  machine: string
  agent: PeerAgent
  /** Started with the write grant: the one grant it stops running without. */
  write: boolean
  summary: string
  startedAt: number
  status: JobStatus
  finishedAt: number
  durationMs?: number
  output?: string
  truncated?: boolean
  error?: string
  controller: AbortController
  /** Resolves when the job finishes, which is what wakes a held `peerResult`. */
  settled: Promise<void>
  settle: () => void
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Absent, for an optional field: JSON writers emit `null` for "not set". */
const absent = (v: unknown): v is null | undefined => v === undefined || v === null

/** A path as a refusal may show it: no control characters, and not a page long. */
function printable(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  return clean.length > MAX_ECHO_CHARS ? `${clean.slice(0, MAX_ECHO_CHARS - 1)}\u2026` : clean
}

/** What the activity view shows for a prompt: its first line with text in it,
 *  flattened to plain spaces, at most 80 characters. */
export function activitySummary(prompt: string): string {
  const line =
    prompt
      .split(/\r\n|\r|\n/)
      .map((l) => l.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim())
      .find((l) => l.length > 0) ?? ''
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1).trimEnd()}\u2026` : line
}

function capTail(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(text.length - max), cut: true } : { text, cut: false }
}

const jsonBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text), 'utf8')

/** The tail of an answer that fits both caps. Each pass keeps the share of the
 *  tail that fits on average, a little under, and measures again: the tail may
 *  be denser than the whole. Every pass keeps at most 95%, so it ends. */
function capOutput(output: string): { text: string; cut: boolean } {
  let { text, cut } = capTail(output, MAX_OUTPUT_CHARS)
  let bytes = jsonBytes(text)
  while (bytes > MAX_OUTPUT_JSON_BYTES) {
    text = text.slice(text.length - Math.floor((text.length * MAX_OUTPUT_JSON_BYTES * 0.95) / bytes))
    cut = true
    bytes = jsonBytes(text)
  }
  return { text, cut }
}

function capError(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `\u2026${text.slice(text.length - (MAX_ERROR_CHARS - 1))}` : text
}

function outcomeOf(r: ExecResult): Outcome {
  const output = typeof r.output === 'string' ? r.output : ''
  if (r.ok === true) return { status: 'done', output }
  return {
    status: 'failed',
    ...(output ? { output } : {}),
    error: typeof r.error === 'string' && r.error.trim() ? r.error : `exit ${r.code}`,
  }
}

export function createLinkedJobs(deps: LinkedJobsDeps): {
  handle(from: LinkTarget, meta: LinkMeta, req: PeerRequest): Promise<unknown>
  revoke(from: LinkTarget, grants: LinkedGrants | null): void
  cancelAll(): void
} {
  const jobs = new Map<string, Job>()

  /** This machine, as a refusal names it to the machine that asked. */
  const here = (): string => deps.localName().trim() || 'the other computer'

  function view(job: Job): PeerJobView {
    return {
      jobId: job.id,
      agent: job.agent,
      status: job.status,
      ...(job.output !== undefined ? { output: job.output } : {}),
      ...(job.truncated ? { truncated: true } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
      startedAt: job.startedAt,
      ...(job.durationMs !== undefined ? { durationMs: job.durationMs } : {}),
    }
  }

  function emit(job: Job): void {
    try {
      deps.onActivity({
        id: job.id,
        direction: 'in',
        ref: job.owner,
        machine: job.machine,
        agent: job.agent,
        summary: job.summary,
        status: job.status,
        startedAt: job.startedAt,
        ...(job.durationMs !== undefined ? { durationMs: job.durationMs } : {}),
      })
    } catch {
      /* the job outlives a listener that broke */
    }
  }

  /** Finished jobs past their two hours go, then the oldest past the hundredth.
   *  A running job is never forgotten: the asking machine is still waiting on it. */
  function prune(): void {
    const now = deps.now()
    const finished: Job[] = []
    for (const job of jobs.values()) {
      if (job.status === 'running') continue
      if (now - job.finishedAt > JOB_RETENTION_MS) jobs.delete(job.id)
      else finished.push(job)
    }
    if (finished.length <= MAX_FINISHED_JOBS) return
    finished.sort((a, b) => a.finishedAt - b.finishedAt)
    for (const job of finished.slice(0, finished.length - MAX_FINISHED_JOBS)) jobs.delete(job.id)
  }

  /** The one way a job stops running. The first outcome wins: a run that winds
   *  down after it was cancelled does not turn the job back into a failure. */
  function finish(job: Job, outcome: Outcome): void {
    if (job.status !== 'running') return
    const now = deps.now()
    job.status = outcome.status
    job.finishedAt = now
    job.durationMs = Math.max(0, now - job.startedAt)
    if (outcome.output !== undefined) {
      const { text, cut } = capOutput(outcome.output)
      job.output = text
      if (cut) job.truncated = true
    }
    if (outcome.error !== undefined) job.error = capError(outcome.error)
    job.settle()
    emit(job)
    prune()
  }

  /** The job, if the asking machine started it. Anything else -- another
   *  machine's job, an id that never existed, one already forgotten -- is the
   *  same answer, so no machine learns what another has running. */
  function owned(owner: string, jobId: unknown): Job {
    const job = typeof jobId === 'string' ? jobs.get(jobId) : undefined
    if (!job || job.owner !== owner) throw new Error('unknown job')
    return job
  }

  async function agentsHere(): Promise<{ claude: boolean; codex: boolean; gemini: boolean }> {
    try {
      const found = await deps.agentsInstalled()
      return { claude: found.claude === true, codex: found.codex === true, gemini: found.gemini === true }
    } catch {
      return { ...NO_AGENTS }
    }
  }

  async function isDir(p: string): Promise<boolean> {
    try {
      return (await deps.isDirectory(p)) === true
    } catch {
      return false
    }
  }

  /** The folder a job runs in: home when none is given; `~`, `~/x` (and the
   *  other spellings a shell might print, via cwdPath) expanded; then it must be
   *  absolute and exist. Checked here rather than left to runHeadless so the
   *  asking machine is told which machine refused, and why. */
  async function folderFor(raw: unknown): Promise<string> {
    let cwd = deps.homedir()
    if (!absent(raw) && !(typeof raw === 'string' && !raw.trim())) {
      if (typeof raw !== 'string') throw new Error('Invalid cwd: expected a folder path.')
      if (raw.length > MAX_CWD_CHARS) throw new Error(`Invalid cwd: longer than ${MAX_CWD_CHARS} characters.`)
      const normal = normalizeShellPath(raw, { homedir: cwd })
      if (normal === null || !path.isAbsolute(normal)) {
        throw new Error(`cwd must be an absolute folder path on ${here()}, or start with ~: ${printable(raw)}`)
      }
      // Refused before it is touched. On Windows, opening \\host\share hands
      // that host this user's NTLM hash, and an unreachable one can hold the
      // check for many seconds. A linked job runs in a folder on THIS machine.
      if (/^[\\/]{2}/.test(normal)) {
        throw new Error(`cwd must be a folder on ${here()} itself, not a network path: ${printable(normal)}`)
      }
      cwd = normal
    }
    if (!(await isDir(cwd))) throw new Error(`Folder not found on ${here()}: ${printable(cwd)}`)
    return cwd
  }

  function timeoutOf(raw: unknown): number {
    if (absent(raw)) return EXEC_DEFAULT_TIMEOUT_MS
    const clamped = clampExecTimeout(raw)
    if (clamped === undefined) throw new Error('Invalid timeoutMs: expected a number of milliseconds.')
    return clamped
  }

  async function hello(meta: LinkMeta | null): Promise<PeerHelloInfo> {
    const confirmed = meta?.confirmed === true
    return {
      name: deps.localName(),
      // Nothing about this machine is told to one the user has not confirmed.
      agents: confirmed ? await agentsHere() : { ...NO_AGENTS },
      grants: confirmed ? (normalizeGrants(meta?.grants) ?? { ...NO_GRANTS }) : { ...NO_GRANTS },
      confirmed,
      version: deps.version,
    }
  }

  async function run(owner: string, meta: LinkMeta, req: Record<string, unknown>): Promise<PeerJobView> {
    const grants = normalizeGrants(meta.grants) ?? NO_GRANTS
    if (!grants.run) {
      throw new Error(
        `${here()} does not let this computer run agents there. Turn on "Run agents here" for it under Settings \u25b8 Linked machines on ${here()}.`,
      )
    }
    const write = absent(req.write) ? false : req.write
    if (typeof write !== 'boolean') throw new Error('Invalid write: expected true or false.')
    if (write && !grants.write) {
      throw new Error(
        `${here()} does not let this computer's agents edit files or run commands there. Run read-only, or turn on "Let agents edit files and run commands here" for it under Settings \u25b8 Linked machines on ${here()}.`,
      )
    }
    const agent = req.agent
    if (!isExecAgent(agent)) throw new Error('Invalid agent: expected claude, codex or gemini.')
    const prompt = req.prompt
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`Invalid prompt: expected 1 to ${MAX_PROMPT_CHARS} characters.`)
    }
    const model = absent(req.model) ? undefined : req.model
    if (model !== undefined && (typeof model !== 'string' || !deps.isSafeModel(model))) {
      throw new Error('Invalid model: expected a model id such as "sonnet" or "gpt-5-codex".')
    }
    const timeoutMs = timeoutOf(req.timeoutMs)
    const cwd = await folderFor(req.cwd)
    if (!(await agentsHere())[agent]) throw new Error(`${agent} is not installed on ${here()}.`)

    // No await from here until the job is in the map: the caps are counted
    // after every check above, so a burst of requests cannot all pass them
    // while each is still waiting on the file system or the agent probe.
    let mine = 0
    let total = 0
    for (const job of jobs.values()) {
      if (job.status !== 'running') continue
      total++
      if (job.owner === owner) mine++
    }
    if (mine >= MAX_JOBS_PER_LINK) {
      throw new Error(
        `busy: ${here()} is already running ${MAX_JOBS_PER_LINK} jobs for this computer. Wait for one to finish, or cancel one.`,
      )
    }
    if (total >= MAX_JOBS_TOTAL) {
      throw new Error(`busy: ${here()} is already running ${MAX_JOBS_TOTAL} linked jobs. Try again when one finishes.`)
    }
    const id = deps.randomId()
    if (typeof id !== 'string' || !JOB_ID_RE.test(id) || jobs.has(id)) {
      throw new Error(`Could not start the job on ${here()}. Try again.`)
    }

    let settle!: () => void
    const settled = new Promise<void>((resolve) => (settle = resolve))
    const controller = new AbortController()
    const job: Job = {
      id,
      owner,
      machine: meta.name,
      agent,
      write,
      summary: activitySummary(prompt),
      startedAt: deps.now(),
      status: 'running',
      finishedAt: 0,
      controller,
      settled,
      settle,
    }
    jobs.set(id, job)
    emit(job)

    const request: ExecRequest = {
      task:
        `[Delegated by "${meta.name}" over Termpolis Linked machines. Working folder: ${cwd}. ` +
        `Your final message is returned to the agent that asked.]\n\n${prompt}`,
      agent,
      ...(model !== undefined ? { model } : {}),
      cwd,
      write,
      timeoutMs,
      linkedJob: id,
      noRemember: true,
      env: { TERMPOLIS_LINKED_JOB: id },
      signal: controller.signal,
    }
    // Detached: the asking machine collects the outcome with `peerResult`.
    // Everything is inside the try, including reading the result, so nothing can
    // escape as an unhandled rejection.
    void (async () => {
      let outcome: Outcome
      try {
        outcome = outcomeOf(await deps.runHeadless(request))
      } catch (err) {
        outcome = { status: 'failed', error: messageOf(err) }
      }
      finish(job, outcome)
    })()
    return view(job)
  }

  /** The job as it stands, held until it finishes or `waitMs` passes. Woken by
   *  the job settling, never by polling, so a finished answer goes back at once. */
  async function result(owner: string, req: Record<string, unknown>): Promise<PeerJobView> {
    const job = owned(owner, req.jobId)
    const w = req.waitMs
    const waitMs = typeof w === 'number' && Number.isFinite(w) ? Math.min(Math.max(w, 0), MAX_RESULT_WAIT_MS) : 0
    if (job.status === 'running' && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([job.settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))])
      clearTimeout(timer)
    }
    return view(job)
  }

  function cancel(owner: string, req: Record<string, unknown>): PeerJobView {
    const job = owned(owner, req.jobId)
    if (job.status === 'running') {
      job.controller.abort()
      finish(job, { status: 'cancelled', error: 'Cancelled by the computer that asked for it.' })
    }
    return view(job)
  }

  return {
    async handle(from, meta, req) {
      prune()
      const r: unknown = req
      if (!isRecord(r) || typeof r.kind !== 'string') throw new Error('Malformed linked-machine request.')
      // No meta is a machine whose pairing finished a moment ago, before main
      // wrote any: unconfirmed, not an error.
      const known: LinkMeta | null = isRecord(meta) ? meta : null
      // Always answered, so the asking machine can tell "not confirmed yet" from
      // "not there"; what it learns before confirmation is nothing it may use.
      if (r.kind === 'peerHello') return hello(known)
      if (known?.confirmed !== true) {
        throw new Error(`Not confirmed yet on ${here()} \u2014 confirm the link under Settings \u25b8 Linked machines there.`)
      }
      const owner = refOf(from)
      switch (r.kind) {
        case 'peerRun':
          return run(owner, known, r)
        case 'peerResult':
          return result(owner, r)
        case 'peerCancel':
          return cancel(owner, r)
        default:
          throw new Error('Unsupported linked-machine request.')
      }
    },

    /** Stop what one machine has running here that it may no longer run: all of
     *  it once it is unlinked (`null`), else what the grants it now holds do not
     *  cover. Grants are checked when a job starts, and without this a job would
     *  run on -- an agent editing files here -- after the user unlinked the
     *  machine or switched its permission off: the toggle has to mean what it
     *  says, as a phone's withdrawn `read` does (remoteBridge/entry.ts). */
    revoke(from, grants) {
      const owner = refOf(from)
      for (const job of jobs.values()) {
        if (job.owner !== owner || job.status !== 'running') continue
        let why: string
        if (!grants) why = `Cancelled on ${here()}: the link was removed.`
        else if (!grants.run) why = `Cancelled: ${here()} no longer lets this computer run agents there.`
        else if (job.write && !grants.write) {
          why = `Cancelled: ${here()} no longer lets this computer's agents edit files or run commands there.`
        } else continue
        job.controller.abort()
        finish(job, { status: 'cancelled', error: why })
      }
    },

    /** Stop every running job, for when linked machines is switched off or the
     *  app is closing. */
    cancelAll() {
      for (const job of jobs.values()) {
        if (job.status !== 'running') continue
        job.controller.abort()
        finish(job, { status: 'cancelled', error: `Cancelled on ${here()}.` })
      }
    },
  }
}
