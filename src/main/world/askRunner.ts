// Lumopolis ask runner: one question about a stored world, answered by the user's own agent run
// hidden and read-only through runHeadless. A second ask for the same root cancels the first.
import { parseAnswer } from '../../shared/world/answerProtocol'
import { itemsForEvidence } from '../../shared/world/evidenceLinks'
import { estimateTokens } from '../../shared/world/tokens'
import type { AskRequest, AskResult, CitedEvidence, Evidence, WorldDoc, WorldReadResult } from '../../shared/world/types'
import type { ExecAgent, ExecDeps, ExecRequest, ExecResult } from '../headlessExec'
import { isSafeModelId } from '../modelCatalog'
import { buildAskPrompt, summarize } from './askContext'
import type { WorldClient } from './worldClient'

export interface AskRunnerDeps {
  exec: (req: ExecRequest, deps: ExecDeps) => Promise<ExecResult>
  execDeps: ExecDeps
  client: Pick<WorldClient, 'get' | 'read'>
  /** The agent every ask runs on (the Lumopolis agent setting). */
  agent(): ExecAgent
  /** The environment (and, for Codex, the proxy base URL) a run in `cwd` gets. A failure here never blocks a question. */
  runEnv(agent: ExecAgent, cwd: string): Promise<{ env: Record<string, string>; baseUrl?: string }>
  /** The memory primer for the project folder; null for none. A failure never blocks a question. */
  primer(cwd: string): Promise<string | null>
  timeoutMs?: number
  /** How long loading the stored world may take before the ask gives up. Default 15 s. */
  getTimeoutMs?: number
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
/** Each step before the agent gets this long: a memory primer has taken over 100 s on a busy machine, and a question
 *  must not sit at Thinking… for it. A step that runs out is left out, as one that fails is. */
export const DEFAULT_PREP_TIMEOUT_MS = 10_000

const AGENT_NAMES: Record<ExecAgent, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }
/** Shown when the chosen agent's CLI is not installed. */
export const agentMissingMessage = (agent: ExecAgent): string => `${AGENT_NAMES[agent]} isn't installed. Choose another agent in Settings › Lumopolis.`
/** True when a failed run says the agent's program could not be found. */
export const isMissingCli = (error: string | undefined): boolean => /ENOENT|is not recognized as/i.test(error ?? '')

/**
 * The step `start` begins, or a rejection once `ms` pass or `signal` aborts, whichever comes first. A cancel that
 * landed before the step began rejects at once, and the step is never started (a memory search left running costs the
 * machine). A step that runs out says so in the app log (`log`): which step, its limit and how long it took, since it is
 * then left out of the answer with nothing on screen to show it.
 */
const bounded = <T>(start: () => Promise<T>, ms: number, signal: AbortSignal, step: string, log: (message: string) => void): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('stopped')); return }
    const began = Date.now()
    const stop = (): void => reject(new Error('stopped'))
    const timer = setTimeout(() => {
      log(`[world] ask: ${step} ran out after ${Date.now() - began} ms (limit ${ms} ms)`)
      stop()
    }, ms)
    signal.addEventListener('abort', stop, { once: true })
    // A step that throws before it returns a promise fails here too, so its timer and listener are always cleared.
    let started: Promise<T>
    try { started = start() } catch (err) { started = Promise.reject(err) }
    started.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
    })
  })

export function createAskRunner(deps: AskRunnerDeps): AskRunner {
  const log = deps.log ?? ((message: string) => console.warn(message))
  const byAsk = new Map<string, AbortController>()
  const byRoot = new Map<string, string>()

  const cancel = (askId: string): void => {
    byAsk.get(askId)?.abort()
  }

  const ask = async (req: AskRequest): Promise<AskResult> => {
    const { askId, root } = req
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
        doc = await bounded(() => deps.client.get(root, { refresh: false }), deps.getTimeoutMs ?? DEFAULT_GET_TIMEOUT_MS, ctl.signal, 'loading the map', log)
      } catch (err) {
        if (ctl.signal.aborted) return cancelled()
        // A limit that ran out was logged by bounded; a host that failed says how, so a retry has a reason on record.
        const why = err instanceof Error ? err.message : String(err)
        if (why !== 'stopped') log(`[world] ask: loading the map failed: ${why}`)
        return { askId, ok: false, error: MAP_FAILED }
      }
      if (ctl.signal.aborted) return cancelled()
      if (!doc) return { askId, ok: false, error: NOT_MAPPED }
      let matches: WorldReadResult
      try {
        matches = await bounded(() => deps.client.read(root, { text: req.question, limit: 20 }), prepMs, ctl.signal, 'reading matches', log)
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
      try {
        res = await deps.exec(
          {
            task: prompt, agent, cwd: root, write: false, noRemember: true, timeoutMs: deps.timeoutMs ?? 90_000, signal: ctl.signal,
            ...(isSafeModelId(req.model) ? { model: req.model } : {}),
            env: run.env,
            ...(run.baseUrl ? { baseUrl: run.baseUrl } : {})
          },
          { ...deps.execDeps, primer: async (cwd) => { try { return await bounded(() => deps.primer(cwd), prepMs, ctl.signal, 'the memory primer', log) } catch { return null } } }
        )
      } catch (e) {
        if (ctl.signal.aborted) return cancelled()
        res = { ok: false, error: e instanceof Error ? e.message : String(e) } as ExecResult
      }
      if (ctl.signal.aborted) return cancelled()
      if (!res.ok && isMissingCli(res.error)) return { askId, ok: false, error: agentMissingMessage(agent) }
      if (!res.ok) return { askId, ok: false, error: `Lumopolis couldn't reach your agent: ${res.error ?? 'no answer'}` }
      const answer = parseAnswer(res.output, doc, labels)
      return { askId, ok: true, answer, summary: summarize(req.summary, req.question, answer.text), cited: citedLabels(answer.text, labels, doc), tokens: estimateTokens(prompt) + estimateTokens(res.output) + Math.ceil(res.primerChars / 4) }
    } finally {
      byAsk.delete(askId)
      if (byRoot.get(root) === askId) byRoot.delete(root)
    }
  }

  return { ask, cancel }
}
