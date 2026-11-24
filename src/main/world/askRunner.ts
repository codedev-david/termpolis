// Lumopolis ask runner: one question about a stored world, answered by the user's own agent run
// hidden and read-only through runHeadless. A second ask for the same root cancels the first.
import { probe } from '../probeLog'
import { parseAnswer } from '../../shared/world/answerProtocol'
import { itemsForEvidence } from '../../shared/world/evidenceLinks'
import { estimateTokens } from '../../shared/world/tokens'
import type { AskNoMemory, AskRequest, AskResult, CitedEvidence, Evidence, WorldDoc, WorldReadResult } from '../../shared/world/types'
import { isMissingCli, type ExecAgent, type ExecDeps, type ExecRequest, type ExecResult } from '../headlessExec'
import { isSafeModelId } from '../modelCatalog'
import { ISOLATION_SETUP_FAILED } from '../readOnlyIsolation'
import { LUMOPOLIS_RUN } from './agentProfile'
import { buildAskPrompt, summarize } from './askContext'
import type { WorldClient } from './worldClient'

export interface AskRunnerDeps {
  exec: (req: ExecRequest, deps: ExecDeps) => Promise<ExecResult>
  execDeps: ExecDeps
  client: Pick<WorldClient, 'get' | 'read'> & Partial<Pick<WorldClient, 'whenCompiled'>>
  /** The agent every ask runs on (the Lumopolis agent setting). */
  agent(): ExecAgent
  /** The environment (and, for Codex, the proxy base URL) a run in `cwd` gets. A failure here never blocks a question. */
  runEnv(agent: ExecAgent, cwd: string): Promise<{ env: Record<string, string>; baseUrl?: string }>
  /** The memory primer for the project folder; null for none. A failure never blocks a question. `signal` fires when the ask
   *  is cancelled or the step runs out, and the primer stops reading then. Throw memoryUnavailable to say why there is none. */
  primer(cwd: string, signal?: AbortSignal): Promise<string | null>
  timeoutMs?: number
  /** How long loading the stored world may take before the ask gives up. Default 15 s. */
  getTimeoutMs?: number
  /** How long an ask on a project whose first world is still compiling waits for it before it gives up (the client's
   *  whenCompiled; its first map from the listing is never asked about, fix round 1 I1). Default the compile's own
   *  call limit, DEFAULT_COMPILE_WAIT_MS. */
  compileWaitMs?: number
  /** How long each step between the world and the agent (the matches, the run environment, the memory primer) may take
   *  before the ask goes on without it. Default DEFAULT_PREP_TIMEOUT_MS. */
  prepTimeoutMs?: number
  /** Writes a line to the app log. Default console.warn, which main mirrors into the app log. */
  log?: (message: string) => void
}

export interface AskRunner {
  ask(req: AskRequest): Promise<AskResult>
  cancel(askId: string): void
}

const MARKER = /\[(E\d+)\]/g

/** The labels whose [E<n>] markers appear in the answer text. */
const citedLabels = (text: string, labels: Record<string, Evidence>, doc: WorldDoc): Record<string, CitedEvidence> => {
  const out: Record<string, CitedEvidence> = {}
  for (const m of text.matchAll(MARKER)) if (labels[m[1]]) out[m[1]] = { ...labels[m[1]], items: itemsForEvidence(doc, labels[m[1]]) }
  return out
}

const NOT_MAPPED = 'This project has not been mapped yet.'
/** Shown for any failure to load the stored world (host down, restarting or too slow): never the raw error. */
export const MAP_FAILED = "Lumopolis couldn't load this project's map. Try again."
export const DEFAULT_GET_TIMEOUT_MS = 15_000
/** The longest an ask waits for a first world being compiled: the world process's own call limit for a compile. */
export const DEFAULT_COMPILE_WAIT_MS = 600_000
/** Each step before the agent gets this long: a memory primer has taken over 100 s on a busy machine, and a question
 *  must not sit at Thinking… for it. A step that runs out is left out, as one that fails is. */
export const DEFAULT_PREP_TIMEOUT_MS = 10_000

const AGENT_NAMES: Record<ExecAgent, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }
/** Shown when the chosen agent's CLI is not installed. */
export const agentMissingMessage = (agent: ExecAgent): string => `${AGENT_NAMES[agent]} isn't installed. Choose another agent in Settings › Lumopolis.`
export { isMissingCli }

/** An error a primer throws to say the memory could not be used, and why (WPA: the answer then says so). */
// 'timeout': one memory call ran out of time inside the primer (WPA fix I2), as the whole step running out is.
export interface MemoryUnavailableError extends Error { noMemory: AskNoMemory }
export const memoryUnavailable = (why: AskNoMemory): MemoryUnavailableError =>
  Object.assign(new Error(`memory unavailable: ${why}`), { noMemory: why })

/** The rejection of a step that ran out (as opposed to one cancelled with the ask). */
const RAN_OUT = 'ran out'

/**
 * The step `start` begins, or a rejection once `ms` pass or `signal` aborts, whichever comes first. A cancel that
 * landed before the step began rejects at once, and the step is never started (a memory search left running costs the
 * machine). The step gets a signal of its own, which fires on either: a step given up on is stopped, not left running on
 * the host (WPA). A step that runs out says so in the app log (`log`): which step, its limit and how long it took, since
 * it is then left out of the answer with nothing on screen to show it, and it rejects with RAN_OUT.
 */
const bounded = <T>(start: (signal: AbortSignal) => Promise<T>, ms: number, signal: AbortSignal, step: string, log: (message: string) => void): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('stopped')); return }
    const began = Date.now()
    const own = new AbortController()
    const stop = (): void => { own.abort(); reject(new Error('stopped')) }
    const timer = setTimeout(() => {
      probe(`ask step ${step} RAN OUT ms=${Date.now() - began}`)
      log(`[world] ask: ${step} ran out after ${Date.now() - began} ms (limit ${ms} ms)`)
      own.abort()
      reject(new Error(RAN_OUT))
    }, ms)
    signal.addEventListener('abort', stop, { once: true })
    // A step that throws before it returns a promise fails here too, so its timer and listener are always cleared.
    let started: Promise<T>
    try { started = start(own.signal) } catch (err) { started = Promise.reject(err) }
    started.then((v) => { probe(`ask step ${step} ok ms=${Date.now() - began}`); resolve(v) }, (e) => { probe(`ask step ${step} fail ms=${Date.now() - began} ${e instanceof Error ? e.message.slice(0, 80) : ''}`); reject(e) }).finally(() => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
    })
  })

/** Why a primer that failed left the memory out: it ran out, or the reason it gave (empty is WPA2 M8), or (anything else) unreachable. */
const noMemoryOf = (err: unknown): AskNoMemory => {
  if (err instanceof Error && err.message === RAN_OUT) return 'timeout'
  const why = (err as Partial<MemoryUnavailableError> | null)?.noMemory
  return why === 'locked' || why === 'timeout' || why === 'empty' ? why : 'down'
}

export function createAskRunner(deps: AskRunnerDeps): AskRunner {
  const log = deps.log ?? ((message: string) => console.warn(message))
  const byAsk = new Map<string, AbortController>()
  const byRoot = new Map<string, string>()

  const cancel = (askId: string): void => {
    byAsk.get(askId)?.abort()
  }

  const ask = async (req: AskRequest): Promise<AskResult> => {
    const { askId, root } = req
    // An id already running is refused (ipc shows ASK_FAILED): taking over its entry would leave that run with no Cancel.
    if (byAsk.has(askId)) throw new Error('askId already running')
    const prior = byRoot.get(root)
    if (prior !== undefined) cancel(prior)
    const ctl = new AbortController()
    byAsk.set(askId, ctl)
    byRoot.set(root, askId)
    const cancelled = (): AskResult => ({ askId, ok: false, error: 'cancelled', cancelled: true })
    const prepMs = deps.prepTimeoutMs ?? DEFAULT_PREP_TIMEOUT_MS
    try {
      let doc: WorldDoc | null
      try {
        // No background refresh from here: a refreshed world landing mid-answer would wipe the answer.
        const getMs = deps.getTimeoutMs ?? DEFAULT_GET_TIMEOUT_MS
        doc = await bounded((signal) => deps.client.get(root, { refresh: false, signal }), getMs, ctl.signal, 'loading the map', log)
        // No world saved yet while one is being compiled (its first map may be on screen): the ask waits for it.
        const whenCompiled = deps.client.whenCompiled
        if (!doc && whenCompiled) {
          const waited = await bounded(() => whenCompiled(root), deps.compileWaitMs ?? DEFAULT_COMPILE_WAIT_MS, ctl.signal, 'waiting for the map', log)
          doc = await bounded((signal) => deps.client.get(root, { refresh: false, signal }), getMs, ctl.signal, 'loading the map', log)
          // The compile it waited on saved nothing: the map failed, not "not mapped yet" (fix round 2, m1).
          if (!doc && waited === true) throw new Error('the compile saved no world')
        }
      } catch (err) {
        if (ctl.signal.aborted) return cancelled()
        // A limit that ran out was logged by bounded; a host that failed says how, so a retry has a reason on record.
        const why = err instanceof Error ? err.message : String(err)
        if (why !== 'stopped' && why !== RAN_OUT) log(`[world] ask: loading the map failed: ${why}`)
        return { askId, ok: false, error: MAP_FAILED }
      }
      if (ctl.signal.aborted) return cancelled()
      if (!doc) return { askId, ok: false, error: NOT_MAPPED }
      let matches: WorldReadResult
      try {
        matches = await bounded((signal) => deps.client.read(root, { text: req.question, limit: 20 }, { signal }), prepMs, ctl.signal, 'reading matches', log)
      } catch {
        matches = { items: [], evidence: [] }
      }
      if (ctl.signal.aborted) return cancelled()
      // An id that is not in the world (a stale or invented one) sends no proposal.
      const proposal = req.proposalId === undefined ? undefined : doc.layers.plan.find((p) => p.id === req.proposalId)
      const { prompt, labels } = buildAskPrompt({
        question: req.question, doc, selection: req.selection, cameraRegion: req.cameraRegion, matches, summary: req.summary,
        ...(proposal ? { proposal } : {})
      })
      const agent = deps.agent()
      let run: { env: Record<string, string>; baseUrl?: string } = { env: {} }
      try {
        run = await bounded(() => deps.runEnv(agent, root), prepMs, ctl.signal, 'the run environment', log)
      } catch {
        // A broken or slow proxy must not block a question: the run goes direct.
      }
      if (ctl.signal.aborted) return cancelled()
      let res: ExecResult
      // Set when the run asked for its primer and got none because the memory could not be used (not when it had no notes).
      let noMemory: AskNoMemory | undefined
      try {
        res = await deps.exec(
          {
            task: prompt, agent, cwd: root, ...LUMOPOLIS_RUN, timeoutMs: deps.timeoutMs ?? 90_000, signal: ctl.signal,
            ...(isSafeModelId(req.model) ? { model: req.model } : {}),
            env: run.env,
            ...(run.baseUrl ? { baseUrl: run.baseUrl } : {})
          },
          {
            ...deps.execDeps,
            primer: async (cwd) => {
              try {
                return await bounded((signal) => deps.primer(cwd, signal), prepMs, ctl.signal, 'the memory primer', log)
              } catch (err) {
                if (!ctl.signal.aborted) noMemory = noMemoryOf(err)
                return null
              }
            }
          }
        )
      } catch (e) {
        if (ctl.signal.aborted) return cancelled()
        res = { ok: false, error: e instanceof Error ? e.message : String(e) } as ExecResult
      }
      if (ctl.signal.aborted) return cancelled()
      if (!res.ok && isMissingCli(res.error)) return { askId, ok: false, error: agentMissingMessage(agent) }
      // A run that couldn't be made safe says so in its own fixed sentence, never inside "couldn't reach".
      if (!res.ok && res.error === ISOLATION_SETUP_FAILED) return { askId, ok: false, error: ISOLATION_SETUP_FAILED }
      if (!res.ok) return { askId, ok: false, error: `Lumopolis couldn't reach your agent: ${res.error ?? 'no answer'}` }
      const answer = parseAnswer(res.output, doc, labels)
      return {
        askId, ok: true, answer, summary: summarize(req.summary, req.question, answer.text), cited: citedLabels(answer.text, labels, doc),
        tokens: estimateTokens(prompt) + estimateTokens(res.output) + Math.ceil(res.primerChars / 4),
        ...(noMemory ? { noMemory } : {})
      }
    } finally {
      byAsk.delete(askId)
      if (byRoot.get(root) === askId) byRoot.delete(root)
    }
  }

  return { ask, cancel }
}
