// Lumopolis ask runner: one question about a stored world, answered by the user's own agent run
// hidden and read-only through runHeadless. A second ask for the same root cancels the first.
import { parseAnswer } from '../../shared/world/answerProtocol'
import type { AskRequest, AskResult, Evidence, WorldDoc, WorldReadResult } from '../../shared/world/types'
import type { ExecDeps, ExecRequest, ExecResult } from '../headlessExec'
import { buildAskPrompt, summarize } from './askContext'
import type { WorldClient } from './worldClient'

export interface AskRunnerDeps {
  exec: (req: ExecRequest, deps: ExecDeps) => Promise<ExecResult>
  execDeps: ExecDeps
  client: Pick<WorldClient, 'get' | 'read'>
  timeoutMs?: number
  /** How long loading the stored world may take before the ask gives up. Default 15 s. */
  getTimeoutMs?: number
}

export interface AskRunner {
  ask(req: AskRequest): Promise<AskResult>
  cancel(askId: string): void
}

const MARKER = /\[(E\d+)\]/g

/** The labels whose [E<n>] markers appear in the answer text. */
const citedLabels = (text: string, labels: Record<string, Evidence>): Record<string, Evidence> => {
  const out: Record<string, Evidence> = {}
  for (const m of text.matchAll(MARKER)) if (labels[m[1]]) out[m[1]] = labels[m[1]]
  return out
}

const NOT_MAPPED = 'This project has not been mapped yet.'
/** Shown for any failure to load the stored world (host down, restarting or too slow): never the raw error. */
export const MAP_FAILED = "Lumopolis couldn't load this project's map. Try again."
export const DEFAULT_GET_TIMEOUT_MS = 15_000

/** `p`, or a rejection once `ms` pass or `signal` aborts, whichever comes first. */
const bounded = <T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(new Error('stopped'))
    const timer = setTimeout(stop, ms)
    signal.addEventListener('abort', stop, { once: true })
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
    })
  })

export function createAskRunner(deps: AskRunnerDeps): AskRunner {
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
    try {
      let doc: WorldDoc | null
      try {
        // No background refresh from here: a refreshed world landing mid-answer would wipe the answer.
        doc = await bounded(deps.client.get(root, { refresh: false }), deps.getTimeoutMs ?? DEFAULT_GET_TIMEOUT_MS, ctl.signal)
      } catch {
        return ctl.signal.aborted ? cancelled() : { askId, ok: false, error: MAP_FAILED }
      }
      if (ctl.signal.aborted) return cancelled()
      if (!doc) return { askId, ok: false, error: NOT_MAPPED }
      let matches: WorldReadResult
      try {
        matches = await deps.client.read(root, { text: req.question, limit: 20 })
      } catch {
        matches = { items: [], evidence: [] }
      }
      if (ctl.signal.aborted) return cancelled()
      const { prompt, labels } = buildAskPrompt({
        question: req.question, doc, selection: req.selection, cameraRegion: req.cameraRegion, matches, summary: req.summary
      })
      let res: ExecResult
      try {
        res = await deps.exec(
          { task: prompt, cwd: root, write: false, noRemember: true, timeoutMs: deps.timeoutMs ?? 90_000, signal: ctl.signal },
          deps.execDeps
        )
      } catch (e) {
        if (ctl.signal.aborted) return cancelled()
        res = { ok: false, error: e instanceof Error ? e.message : String(e) } as ExecResult
      }
      if (ctl.signal.aborted) return cancelled()
      if (!res.ok) return { askId, ok: false, error: `Lumopolis couldn't reach your agent: ${res.error ?? 'no answer'}` }
      const answer = parseAnswer(res.output, doc, labels)
      return { askId, ok: true, answer, summary: summarize(req.summary, req.question, answer.text), cited: citedLabels(answer.text, labels) }
    } finally {
      byAsk.delete(askId)
      if (byRoot.get(root) === askId) byRoot.delete(root)
    }
  }

  return { ask, cancel }
}
