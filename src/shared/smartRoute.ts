// v1.56.0 per-message routing: the local classifier's vote and how it meets the word rules. Pure.
//
// The classifier is k-nearest-neighbours over sentence embeddings: the message and every labelled
// example are bge-small vectors (unit length, so a dot product is the cosine), the k closest examples
// vote with their similarity, and the user's own picks count double. No model call, no network: one
// embedding (a few milliseconds) and a few hundred dot products.

import { routeTask, type RouteDecision, type RouterTuning, type EffortLevel } from './taskRouter'
import type { SeedLabel } from './routerSeeds'

export interface LabeledVec {
  label: SeedLabel
  vec: ArrayLike<number>
  /** 1 for a seed, USER_WEIGHT for the user's own pick. */
  weight?: number
}

export interface Classification {
  label: SeedLabel
  /** The winner's share of the vote, 0..1. */
  confidence: number
  /** Cosine of the nearest example. Low = nothing like this has been seen. */
  topSim: number
}

export const KNN_K = 7
export const USER_WEIGHT = 2
/** Below this the nearest example is too unlike the message for its vote to mean anything. */
export const MIN_TOP_SIM = 0.55
/** The classifier overrides a disagreeing rule from this share of the vote. */
export const OVERRIDE_CONFIDENCE = 0.55

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/** The k nearest examples' vote. null when there is nothing to compare with. */
export function knnClassify(q: ArrayLike<number>, examples: readonly LabeledVec[], k = KNN_K): Classification | null {
  if (!q || q.length === 0 || examples.length === 0) return null
  const scored = examples.map((e) => ({ e, sim: dot(q, e.vec) }))
  scored.sort((a, b) => b.sim - a.sim)
  const top = scored.slice(0, Math.max(1, k))
  const votes: Record<SeedLabel, number> = { keep: 0, haiku: 0, sonnet: 0, opus: 0 }
  let total = 0
  for (const { e, sim } of top) {
    const w = Math.max(0, sim) * (e.weight ?? 1)
    votes[e.label] += w
    total += w
  }
  if (total <= 0) return null
  let label: SeedLabel = top[0].e.label
  for (const l of ['keep', 'haiku', 'sonnet', 'opus'] as const) if (votes[l] > votes[label]) label = l
  return { label, confidence: votes[label] / total, topSim: top[0].sim }
}

export interface MessageRoute {
  /** 'keep' = stay on the session's model. */
  label: SeedLabel
  effort: EffortLevel
  confidence: number
  /** Who decided: rules, local-model, or both (they agreed). */
  source: 'rules' | 'local-model' | 'both'
  /** The rule's name when the rules decided. */
  rule?: string
}

const EFFORT_OF: Readonly<Record<Exclude<SeedLabel, 'keep'>, EffortLevel>> = { haiku: 'low', sonnet: 'medium', opus: 'high' }

function ruleLabel(d: RouteDecision): SeedLabel {
  return d.model === 'opusplan' ? 'opus' : d.model
}

/** One message's route: the classifier's vote where it is sure and the message looks like something it
 *  knows, the word rules otherwise. A confirmation ("yes", "go ahead") the classifier calls 'keep' stays
 *  on the session's model, whatever the rules would say about two words. */
export function routeMessage(prompt: string, cls: Classification | null, tune?: RouterTuning): MessageRoute {
  const rule = routeTask({ prompt }, tune)
  const rl = ruleLabel(rule)
  const fromRules: MessageRoute = { label: rl, effort: rule.effort, confidence: rule.confidence, source: 'rules', rule: rule.rule }
  if (rule.rule === 'no-task') return { ...fromRules, label: 'keep' }
  if (!cls || cls.topSim < MIN_TOP_SIM) return fromRules
  if (cls.label === rl) return { ...fromRules, confidence: Math.max(cls.confidence, rule.confidence), source: 'both' }
  if (cls.label === 'keep') return cls.confidence >= OVERRIDE_CONFIDENCE ? { label: 'keep', effort: rule.effort, confidence: cls.confidence, source: 'local-model' } : fromRules
  if (cls.confidence >= OVERRIDE_CONFIDENCE && cls.confidence >= rule.confidence) {
    return { label: cls.label, effort: EFFORT_OF[cls.label], confidence: cls.confidence, source: 'local-model' }
  }
  return fromRules
}

/** One routed message, as main tells its pane (messageRouter.routePrompt → 'router:message'). */
export interface RouteEvent {
  terminalId: string
  /** The message (first 2000 characters), for the pane's "should have been" menu to teach the classifier. */
  prompt: string
  /** The model the message runs on. */
  model: 'opus' | 'sonnet' | 'haiku'
  /** The model the session was on before it; null for a session's first message. */
  from: 'opus' | 'sonnet' | 'haiku' | null
  switched: boolean
  /** Why: first, keep, same, cheaper, switch-costs-more, needs-stronger, not-sure-enough, context-too-big, too-big-for-haiku. */
  reason: string
  /** What the message looked like. */
  label: SeedLabel
  source: MessageRoute['source']
  confidence: number
  /** Milliseconds the decision took, embedding included. */
  ms: number
  /** Dollars the pick is expected to save over staying (negative for a stronger model). */
  saving: number
}
