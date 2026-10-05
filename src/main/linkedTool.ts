// The asking side of Linked machines: the body of the `linked_machines` MCP
// tool (spec §8).
//
// An agent here names a machine, an agent and a prompt; this sends the job over
// the link and waits for the answer -- up to `waitSec`, which stays under the
// 60 s an agent's MCP client gives one tool call (Codex's default). A job still
// running when the wait ends comes back with its jobId, and the agent collects
// it with `result`: start, then check.
//
// It never throws. `executeTool` masks a thrown message, and an agent told only
// "tool failed" cannot fix its call or tell the user why -- so every failure is
// data, `{ error }`, worded for the agent to act on or pass on.
//
// Everything that came from the other machine is untrusted text: a job's output
// and error, and any refusal the other side worded. All of it goes through
// `inspect` (the gateway's injection guard) before an agent reads it.
import type { LinkTarget, PeerAgent, PeerJobView, PeerRequest } from './remoteBridge/protocol'
import { sanitizeDeviceLabel } from './remoteBridge/deviceLabel'
import { resolveMachine, type LinkedMachineView } from './linkedDirectory'
import { refOf, targetOf } from './linkedStore'
import { MAX_PROMPT_CHARS, activitySummary, type LinkedActivity } from './linkedJobs'

export interface LinkedToolArgs {
  action?: string
  machine?: string
  agent?: string
  prompt?: string
  cwd?: string
  write?: boolean
  model?: string
  jobId?: string
  waitSec?: number
}

export interface LinkedToolDeps {
  /** One request over the link. Rejects Error(message), e.g. 'offline' or 'timed out'. */
  call(target: LinkTarget, request: PeerRequest, timeoutMs: number): Promise<unknown>
  machines(): LinkedMachineView[]
  enabled(): boolean
  localName(): string
  /** riskBanner(inspectResult(text, 210_000), machine, agent). */
  inspect(text: string, machine: string, agent: string): string
  onActivity(a: LinkedActivity): void
  now(): number
}

/** How long `list` waits on each machine's `peerHello`. */
export const HELLO_TIMEOUT_MS = 8_000

/** How long `run` waits for the other machine to accept the job. */
export const RUN_TIMEOUT_MS = 20_000

/** The longest one `peerResult` long-poll asks the other machine to hold... */
export const MAX_POLL_WAIT_MS = 25_000

/** ...and how much longer than its hold the poll may take to come back. */
export const POLL_GRACE_MS = 20_000

/** How long `run` and `result` wait for a job by default, in seconds. */
export const DEFAULT_WAIT_SEC = 45

/** The longest wait an agent may ask for: under the 60 s Codex gives one tool call. */
export const MAX_WAIT_SEC = 50

/** A machine that answers every poll at once with "running" -- an older or a
 *  broken build -- is asked this many times per call, not in a tight loop until
 *  the wait runs out. Two or three polls cover a real wait. */
export const MAX_POLLS_PER_CALL = 8

/** Outbound jobs remembered for the activity view, the oldest forgotten first. */
const MAX_REMEMBERED_JOBS = 100

const MAX_ERROR_CHARS = 4_000
const MAX_REFUSAL_CHARS = 1_000

const PEER_AGENTS: readonly PeerAgent[] = ['claude', 'codex', 'gemini']
const JOB_STATUSES: readonly PeerJobView['status'][] = ['running', 'done', 'failed', 'cancelled']
const REMOTE_JOB_ID_RE = /^[0-9a-f]{12}$/
const AGENT_JOB_ID_RE = /^([0-9a-f]{16})-([0-9a-f]{12})$/

/** The bridge's words for a kind the other side does not know (remotePolicy's
 *  CapabilityError): an older Termpolis, which has no linked machines. */
const OLD_VERSION_REFUSAL = 'remote device sent an unrecognised request kind'

const OFF = 'Linked machines is off. Turn it on under Settings ▸ Linked machines.'
const BAD_ACTION = 'Invalid action: expected "list", "run" or "result".'
const BAD_AGENT = 'Invalid agent: expected claude, codex or gemini.'
const BAD_PROMPT = `Invalid prompt: expected 1 to ${MAX_PROMPT_CHARS} characters.`
const BAD_CWD = 'Invalid cwd: expected a folder path on the other machine.'
const BAD_WRITE = 'Invalid write: expected true or false.'
const BAD_MODEL = 'Invalid model: expected a model id.'
const BAD_WAIT = `Invalid waitSec: expected a number of seconds from 0 to ${MAX_WAIT_SEC}.`
const BAD_JOB_ID = 'Invalid jobId: expected the jobId that "run" returned, such as "0011223344556677-0123456789ab".'
const NONE_LINKED = 'No machines are linked yet. Link one under Settings ▸ Linked machines.'

const offline = (name: string): string => `"${name}" is offline — Termpolis must be running there.`
const unconfirmed = (name: string): string =>
  `"${name}" is not confirmed yet. Compare the safety words and click "They match — link" under Settings ▸ Linked machines on this computer.`
const unreachable = (name: string): string => `"${name}" cannot be reached from this computer.`
const malformed = (name: string): string =>
  `"${name}" sent an answer this computer does not understand. Update Termpolis on both computers.`
const stillRunning = (name: string, jobId: string): string =>
  `Still running on "${name}". Call linked_machines with action "result" and jobId "${jobId}" to collect the answer.`
const checkLater = (jobId: string): string =>
  `The job may still be running there: call linked_machines with action "result" and jobId "${jobId}" to check on it.`

type Answer = Record<string, unknown>

/** A job view as it crossed the wire, checked. */
interface JobView {
  jobId: string
  agent: PeerAgent
  status: PeerJobView['status']
  output?: string
  truncated?: boolean
  error?: string
  durationMs?: number
}

/** What this machine remembers of a job it sent, for the activity view. */
interface SentJob {
  ref: string
  machine: string
  agent: string
  summary: string
  startedAt: number
  status?: PeerJobView['status']
}

/** One job being followed: where it runs, and the two ids it goes by. */
interface Followed {
  target: LinkTarget
  name: string
  remoteId: string
  jobId: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Absent, for an optional argument: JSON writers emit `null` for "not set". */
const absent = (v: unknown): v is null | undefined => v === undefined || v === null

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function jobViewOf(v: unknown, expectedId?: string): JobView | null {
  if (!isRecord(v)) return null
  const { jobId, agent, status, output, truncated, error, durationMs } = v
  if (typeof jobId !== 'string' || !REMOTE_JOB_ID_RE.test(jobId)) return null
  if (expectedId !== undefined && jobId !== expectedId) return null
  if (!(PEER_AGENTS as readonly unknown[]).includes(agent)) return null
  if (!(JOB_STATUSES as readonly unknown[]).includes(status)) return null
  return {
    jobId,
    agent: agent as PeerAgent,
    status: status as PeerJobView['status'],
    ...(typeof output === 'string' ? { output } : {}),
    ...(truncated === true ? { truncated: true } : {}),
    ...(typeof error === 'string' ? { error } : {}),
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
  }
}

export function createLinkedTool(deps: LinkedToolDeps): { call(args: LinkedToolArgs): Promise<unknown> } {
  const sent = new Map<string, SentJob>()

  /** Words from the other machine, made safe to hand an agent. */
  function guarded(text: string, name: string, agent: string, max: number): string {
    return deps.inspect(clip(text, max), name, agent)
  }

  /** Why a call to `name` failed, as a sentence. The bridge's own two words are
   *  translated; anything else was worded by the other machine and is guarded. */
  function failure(message: string, name: string, agent: string): string {
    if (message === 'offline') return offline(name)
    if (message === 'timed out') return `"${name}" did not answer in time.`
    if (message === OLD_VERSION_REFUSAL) {
      return `"${name}" runs a version of Termpolis without Linked machines. Update Termpolis there.`
    }
    return guarded(message, name, agent, MAX_REFUSAL_CHARS)
  }

  /** Record a job's status for the activity view, once per change. */
  function record(job: Followed, view: JobView, seed?: { summary: string; startedAt: number }): void {
    const now = deps.now()
    let known = sent.get(job.jobId)
    if (!known) {
      known = {
        ref: refOf(job.target),
        machine: job.name,
        agent: view.agent,
        summary: seed?.summary ?? '',
        // A job first seen by `result` started before this machine knew of it.
        startedAt: seed?.startedAt ?? now - (view.durationMs ?? 0),
      }
      sent.set(job.jobId, known)
      if (sent.size > MAX_REMEMBERED_JOBS) sent.delete(sent.keys().next().value as string)
    }
    if (known.status === view.status) return
    known.status = view.status
    const finished = view.status !== 'running'
    try {
      deps.onActivity({
        id: job.jobId,
        direction: 'out',
        ref: known.ref,
        machine: known.machine,
        agent: known.agent,
        summary: known.summary,
        status: view.status,
        startedAt: known.startedAt,
        ...(finished ? { durationMs: view.durationMs ?? Math.max(0, now - known.startedAt) } : {}),
      })
    } catch {
      /* the answer still goes back to the agent */
    }
  }

  function answer(job: Followed, view: JobView, note?: string): Answer {
    return {
      jobId: job.jobId,
      machine: job.name,
      agent: view.agent,
      status: view.status,
      ...(view.output !== undefined ? { output: deps.inspect(view.output, job.name, view.agent) } : {}),
      ...(view.truncated ? { truncated: true } : {}),
      ...(view.error !== undefined ? { error: guarded(view.error, job.name, view.agent, MAX_ERROR_CHARS) } : {}),
      ...(view.durationMs !== undefined ? { durationMs: view.durationMs } : {}),
      ...(note ? { note } : {}),
    }
  }

  /** Long-poll a job until it is no longer running or the deadline passes.
   *  `last` is what is already known of it: nothing, for `result`, which then
   *  always asks at least once. */
  async function follow(job: Followed, last: JobView | null, deadline: number): Promise<Answer> {
    let view = last
    for (let polls = 0; polls < MAX_POLLS_PER_CALL; polls++) {
      if (view && view.status !== 'running') break
      const remaining = deadline - deps.now()
      if (view && remaining <= 0) break
      const waitMs = Math.max(0, Math.min(remaining, MAX_POLL_WAIT_MS))
      let reply: unknown
      try {
        reply = await deps.call(job.target, { kind: 'peerResult', jobId: job.remoteId, waitMs }, waitMs + POLL_GRACE_MS)
      } catch (err) {
        const message = messageOf(err)
        if (message === 'unknown job') {
          return {
            error: `"${job.name}" no longer has job ${job.jobId}. It finished more than 2 hours ago, or Termpolis restarted there.`,
            jobId: job.jobId,
            machine: job.name,
          }
        }
        const why = failure(message, job.name, view?.agent ?? 'linked_machines')
        // Losing touch is not the job failing: it may well still be running.
        if (view && (message === 'offline' || message === 'timed out')) return answer(job, view, `${why} ${checkLater(job.jobId)}`)
        return { error: why, jobId: job.jobId, machine: job.name }
      }
      const next = jobViewOf(reply, job.remoteId)
      if (!next) return { error: malformed(job.name), jobId: job.jobId, machine: job.name }
      view = next
      record(job, view)
    }
    // Reached only with a view: the first pass always polls when there is none.
    const final = view as JobView
    return answer(job, final, final.status === 'running' ? stillRunning(job.name, job.jobId) : undefined)
  }

  /** `waitSec` in seconds, clamped, or the reason it is not one. */
  function waitOf(raw: unknown): number | string {
    if (absent(raw)) return DEFAULT_WAIT_SEC
    if (typeof raw !== 'number') return BAD_WAIT
    if (Number.isNaN(raw)) return DEFAULT_WAIT_SEC
    return Math.min(MAX_WAIT_SEC, Math.max(0, raw))
  }

  /** A machine an agent may send work to, or the error saying why not. */
  function usable(view: LinkedMachineView): LinkTarget | string {
    if (!view.confirmed) return unconfirmed(view.name)
    if (!view.online) return offline(view.name)
    return targetOf(view.ref) ?? unreachable(view.name)
  }

  async function list(): Promise<Answer> {
    const machines = await Promise.all(
      deps.machines().map(async (m) => {
        const base = { name: m.name, online: m.online, confirmed: m.confirmed }
        const unknown = { agents: null, canRun: null, canWrite: null }
        if (!m.confirmed) {
          return {
            ...base,
            ...unknown,
            note: 'Waiting for confirmation: compare the safety words and click "They match — link" under Settings ▸ Linked machines on this computer.',
          }
        }
        if (!m.online) return { ...base, ...unknown, note: 'Offline — Termpolis must be running there.' }
        const target = targetOf(m.ref)
        if (!target) return { ...base, ...unknown, note: unreachable(m.name) }
        let hello: unknown
        try {
          hello = await deps.call(target, { kind: 'peerHello' }, HELLO_TIMEOUT_MS)
        } catch (err) {
          return { ...base, ...unknown, note: failure(messageOf(err), m.name, 'linked_machines') }
        }
        if (!isRecord(hello) || !isRecord(hello.agents) || !isRecord(hello.grants) || typeof hello.confirmed !== 'boolean') {
          return { ...base, ...unknown, note: malformed(m.name) }
        }
        if (!hello.confirmed) {
          return {
            ...base,
            confirmed: false,
            agents: null,
            canRun: false,
            canWrite: false,
            note: `Not confirmed yet on "${m.name}" — confirm the link under Settings ▸ Linked machines there.`,
          }
        }
        const installed = hello.agents
        const agents = PEER_AGENTS.filter((a) => installed[a] === true)
        const canRun = hello.grants.run === true
        return {
          ...base,
          agents,
          canRun,
          canWrite: hello.grants.write === true,
          ...(canRun && agents.length === 0 ? { note: `No agents are installed on "${m.name}".` } : {}),
        }
      }),
    )
    return { thisMachine: deps.localName(), machines }
  }

  async function run(args: LinkedToolArgs): Promise<Answer> {
    const started = deps.now()
    const agent = args.agent
    if (!(PEER_AGENTS as readonly unknown[]).includes(agent)) return { error: BAD_AGENT }
    const prompt = args.prompt
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) return { error: BAD_PROMPT }

    const views = deps.machines()
    const names = views.map((v) => v.name).join(', ')
    const asked = typeof args.machine === 'string' ? args.machine.trim() : ''
    if (!asked) return { error: views.length ? `Name a machine. Linked machines: ${names}` : NONE_LINKED }
    const view = resolveMachine(views, asked)
    if (!view) {
      const shown = sanitizeDeviceLabel(asked)
      return { error: `Unknown machine "${shown}". ${views.length ? `Linked machines: ${names}` : NONE_LINKED}` }
    }

    const { cwd, write, model } = args
    if (!absent(cwd) && typeof cwd !== 'string') return { error: BAD_CWD }
    if (!absent(write) && typeof write !== 'boolean') return { error: BAD_WRITE }
    if (!absent(model) && typeof model !== 'string') return { error: BAD_MODEL }
    const waitSec = waitOf(args.waitSec)
    if (typeof waitSec === 'string') return { error: waitSec }

    const target = usable(view)
    if (typeof target === 'string') return { error: target, machine: view.name }

    const request: PeerRequest = {
      kind: 'peerRun',
      agent: agent as PeerAgent,
      prompt,
      ...(cwd?.trim() ? { cwd } : {}),
      ...(write ? { write: true } : {}),
      ...(model?.trim() ? { model } : {}),
    }
    let reply: unknown
    try {
      reply = await deps.call(target, request, RUN_TIMEOUT_MS)
    } catch (err) {
      const message = messageOf(err)
      const why = failure(message, view.name, agent as string)
      // The start may have arrived and only its answer been lost.
      return {
        error: message === 'timed out' ? `${why} It may have started the job anyway — check before running it again.` : why,
        machine: view.name,
      }
    }
    const first = jobViewOf(reply)
    if (!first) return { error: malformed(view.name), machine: view.name }
    const job: Followed = { target, name: view.name, remoteId: first.jobId, jobId: `${target.id}-${first.jobId}` }
    record(job, first, { summary: activitySummary(prompt), startedAt: started })
    return follow(job, first, started + waitSec * 1000)
  }

  async function result(args: LinkedToolArgs): Promise<Answer> {
    const started = deps.now()
    const m = typeof args.jobId === 'string' ? AGENT_JOB_ID_RE.exec(args.jobId.trim()) : null
    if (!m) return { error: BAD_JOB_ID }
    const [jobId, id, remoteId] = m
    const waitSec = waitOf(args.waitSec)
    if (typeof waitSec === 'string') return { error: waitSec }

    // The id says which machine, not how it is reached: a hosted machine and a
    // joined link share one id space, so ask the directory which this one is.
    const views = deps.machines()
    const view =
      views.find((v) => v.ref === refOf({ via: 'device', id })) ?? views.find((v) => v.ref === refOf({ via: 'link', id }))
    if (!view) return { error: `Unknown jobId "${jobId}": no linked machine has that id. It may have been unlinked.` }
    const target = usable(view)
    if (typeof target === 'string') return { error: target, jobId, machine: view.name }
    return follow({ target, name: view.name, remoteId, jobId }, null, started + waitSec * 1000)
  }

  return {
    async call(args) {
      try {
        if (!deps.enabled()) return { error: OFF }
        const a: LinkedToolArgs = isRecord(args) ? args : {}
        switch (a.action) {
          case 'list':
            return await list()
          case 'run':
            return await run(a)
          case 'result':
            return await result(a)
          default:
            return { error: BAD_ACTION }
        }
      } catch (err) {
        return { error: `linked_machines failed: ${messageOf(err)}` }
      }
    },
  }
}
