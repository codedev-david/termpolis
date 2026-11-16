// Lumopolis ask runner: one question about a stored world, answered by the user's own agent run
// hidden and read-only through runHeadless. A second ask for the same root cancels the first.
import { parseAnswer } from '../../shared/world/answerProtocol'
import type { AskRequest, AskResult, Evidence, WorldReadResult } from '../../shared/world/types'
import type { ExecDeps, ExecRequest, ExecResult } from '../headlessExec'
import { buildAskPrompt, summarize } from './askContext'
import type { WorldClient } from './worldClient'

export interface AskRunnerDeps {
  exec: (req: ExecRequest, deps: ExecDeps) => Promise<ExecResult>
  execDeps: ExecDeps
  client: Pick<WorldClient, 'get' | 'read'>
  timeoutMs?: number
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
      const doc = await deps.client.get(root)
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
