// nliContradict.ts — an OPT-IN, model-backed upgrade to the conservative heuristicContradicts.
//
// A cross-encoder NLI model judges whether two lessons genuinely CONTRADICT, catching real
// conflicts the negation heuristic can't ("Use Postgres for the store" vs "Use MySQL for the
// store" — same subject, opposite, no negation word). It is:
//   - OFF by default (setNliConflictsEnabled) — per the learning-soundness rule, an un-benchmarked
//     mechanism never ships enabled; until the eval harness shows it beats the heuristic, callers
//     get the heuristic.
//   - injectable (setNliScorer) — tests and custom backends plug in a scorer with no model.
//   - local-only + best-effort — the real path uses the already-bundled transformers.js with remote
//     models DISABLED; if the NLI model isn't bundled, it returns null and the caller falls back.
//   - scalable — the expensive NLI runs ONLY on same-subject candidate pairs (sameSubject
//     prefilter), never all O(n²) combinations.

import { type AgentLesson, type LessonConflict, detectConflicts, sameSubject, heuristicContradicts } from './mnemeSociety'

/** premise, hypothesis → probability [0,1] that they CONTRADICT. */
export type NliScorer = (premise: string, hypothesis: string) => Promise<number>

const NLI_MODEL = 'Xenova/nli-deberta-v3-xsmall'

let injected: NliScorer | null = null
let cached: NliScorer | null = null
let loadAttempted = false
let enabled = false

/** Enable/disable the real NLI path (default OFF). When off (and no scorer injected) conflict
 *  detection stays on the pure heuristic with zero model loads. */
export function setNliConflictsEnabled(v: boolean): void {
  enabled = v
}
export function nliConflictsEnabled(): boolean {
  return enabled
}

/** Inject a scorer (tests / custom backend). null clears it and resets the lazy loader. */
export function setNliScorer(s: NliScorer | null): void {
  injected = s
  cached = null
  loadAttempted = false
}

/** The injected scorer, else a real cross-encoder via the bundled transformers.js (remote models
 *  disabled → strictly local). Best-effort: null when the model isn't bundled, so callers fall back. */
export async function getNliScorer(): Promise<NliScorer | null> {
  if (injected) return injected
  if (cached) return cached
  if (loadAttempted) return null
  loadAttempted = true
  try {
    const mod = (await import('@huggingface/transformers')) as {
      pipeline: (task: string, model: string) => Promise<unknown>
      env?: { allowRemoteModels?: boolean; allowLocalModels?: boolean }
    }
    if (mod.env) {
      mod.env.allowRemoteModels = false // never hit the network — local bundled model only
      mod.env.allowLocalModels = true
    }
    const clf = (await mod.pipeline('text-classification', NLI_MODEL)) as (
      input: { text: string; text_pair: string },
      opts: { top_k: number },
    ) => Promise<Array<{ label: string; score: number }>>
    cached = async (premise, hypothesis) => {
      const out = await clf({ text: premise, text_pair: hypothesis }, { top_k: 3 })
      const c = Array.isArray(out) ? out.find((o) => /contradict/i.test(o.label)) : undefined
      return c ? c.score : 0
    }
    return cached
  } catch {
    return null // model not bundled → heuristic fallback
  }
}

/** An async contradicts predicate from a scorer + threshold. Checks BOTH directions (NLI is not
 *  symmetric) and takes the max contradiction probability. */
export function makeNliContradicts(scorer: NliScorer, threshold = 0.6): (a: AgentLesson, b: AgentLesson) => Promise<boolean> {
  return async (a, b) => {
    const [ab, ba] = await Promise.all([scorer(a.content, b.content), scorer(b.content, a.content)])
    return Math.max(ab, ba) >= threshold
  }
}

/** Conflict detection with the NLI upgrade when available: a cheap sameSubject prefilter narrows
 *  to candidate pairs, then the model confirms each. Falls back to the pure heuristic when the NLI
 *  path is disabled or no model is present — so the default behaviour is unchanged. */
export async function detectConflictsNli(
  lessons: AgentLesson[],
  opts: { scorer?: NliScorer | null; threshold?: number } = {},
): Promise<LessonConflict[]> {
  const scorer = opts.scorer ?? (enabled ? await getNliScorer() : null)
  if (!scorer) return detectConflicts(lessons, heuristicContradicts)
  const candidates = detectConflicts(lessons, (a, b) => sameSubject(a, b, 0.5)) // broad, cheap prefilter
  const contradicts = makeNliContradicts(scorer, opts.threshold)
  const confirmed: LessonConflict[] = []
  for (const pair of candidates) if (await contradicts(pair.a, pair.b)) confirmed.push(pair)
  return confirmed
}

export function _resetNliForTests(): void {
  injected = null
  cached = null
  loadAttempted = false
  enabled = false
}
