// v1.56.0 per-message routing: the local classifier's vote and how it meets the word rules. Pure.
//
// The classifier is k-nearest-neighbours over sentence embeddings: the message and every labelled
// example are bge-small vectors (unit length, so a dot product is the cosine), the k closest examples
// vote with their similarity, and the user's own picks count double. No model call, no network: one
// embedding (a few milliseconds) and a few hundred dot products.

import { routeTask, type RouteDecision, type RouterTuning, type EffortLevel } from './taskRouter'
import type { SeedLabel } from './routerSeeds'
import { bumpEffort, effortRank } from './effortLevels'
import { UP_MIN_CONFIDENCE, type RouteFamily } from './switchEconomics'

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
/** v1.56.2: Haiku only on a clear vote for it. A hard task wrongly sent down costs a worse answer the user
 *  may not notice; one wrongly kept on Sonnet costs a little money. The word rules alone never pick Haiku. */
export const HAIKU_MIN_CONFIDENCE = 0.7
/** ...and a short one. */
export const HAIKU_MAX_WORDS = 20
/** Words that turn a quick question into work: asking for something made or changed, a status check or a
 *  "why", something not showing up, a file path or a link. Measured on 3,000 real prompts (npm run
 *  router:eval): Haiku picks with one of these were 52% heavy turns (15+ tool calls or 12k+ output tokens),
 *  those without 17%. */
const WORK_WORDS = [
  'can we', 'can you', 'could you', 'i want', 'i need', 'give me', 'make', 'create', 'build', 'write', 'set ?up',
  'deploy', 'complete', 'wipe', 'remove', 'add', 'update', 'change', 'automat\\w*', 'commit', 'test', 'report',
  'pdf', 'document', 'look at', 'look into', 'check', 'status', 'progress\\w*', "i don'?t see", 'remember', 'why',
  'run', 'running',
]
const SOUNDS_LIKE_WORK = new RegExp(`\\b(?:${WORK_WORDS.join('|')})\\b|[a-z]:\\\\|https?://`, 'i')

/** True when a message is short and asks nothing that sounds like work: the only kind Haiku gets. */
export function quickQuestion(prompt: string): boolean {
  const words = prompt.trim().split(/\s+/).filter(Boolean).length
  return words > 0 && words <= HAIKU_MAX_WORDS && !SOUNDS_LIKE_WORK.test(prompt)
}

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

/** v1.57.0: the lowest and highest effort each model is routed to. Haiku is for quick answers; Opus is
 *  only worth its price with some thought behind it. */
export const EFFORT_RANGE: Readonly<Record<RouteFamily, readonly [EffortLevel, EffortLevel]>> = {
  haiku: ['low', 'medium'],
  sonnet: ['low', 'xhigh'],
  opus: ['medium', 'max'],
}
/** A message longer than this is a spec, not a question: one level more. */
export const LONG_PROMPT_WORDS = 200
/** Asked in so many words for the most thought there is. */
const MAX_THINK = /\bultrathink\b|\bthink (?:as hard as|harder than)\b/i
/** Asks for care: one level more. */
const DEEP_THINK = /\b(?:think (?:hard|harder|deeply|carefully|it through)|step[- ]by[- ]step|thorough(?:ly)?|careful(?:ly)?|rigorous(?:ly)?|root cause|deep dive|edge cases?|prove|audit|security review|race conditions?|deadlock\w*|subtle)\b/i
/** Says it is small: one level less, when the route is sure of itself. */
const LIGHT = /\b(?:quick(?:ly)?|simple|briefly|tiny|trivial|typo|one[- ]liner)\b/i

function clampEffort(label: RouteFamily, e: EffortLevel): EffortLevel {
  const [lo, hi] = EFFORT_RANGE[label]
  if (effortRank(e) < effortRank(lo)) return lo
  return effortRank(e) > effortRank(hi) ? hi : e
}

/** How hard a routed message should think, on the model its route picked. It starts from the route's own
 *  level (the rule's, or the model's usual one), goes up for a message that asks for care or is long, down
 *  for one that says it is small (only when the route is sure: unsure keeps the safer level), and stays
 *  in the model's range. 'keep' keeps the route's level: the session's own effort is not changed. */
export function chooseEffort(prompt: string, r: MessageRoute, opts: { countLength?: boolean } = {}): EffortLevel {
  if (r.label === 'keep') return r.effort
  if (MAX_THINK.test(prompt)) return clampEffort(r.label, 'max')
  const deep = DEEP_THINK.test(prompt)
  let steps = deep ? 1 : 0
  if (opts.countLength !== false && prompt.trim().split(/\s+/).length > LONG_PROMPT_WORDS) steps++
  if (!deep && r.confidence >= OVERRIDE_CONFIDENCE && LIGHT.test(prompt)) steps--
  return clampEffort(r.label, bumpEffort(r.effort, steps))
}

/** One message's route: the classifier's vote where it is sure and the message looks like something it
 *  knows, the word rules otherwise. A confirmation ("yes", "go ahead") the classifier calls 'keep' stays
 *  on the session's model, whatever the rules would say about two words. Haiku needs a clear vote for it
 *  (HAIKU_MIN_CONFIDENCE) on a short message that does not sound like work (quickQuestion); anything less
 *  runs on Sonnet. v1.57.0: the effort is decided too (chooseEffort). */
export function routeMessage(prompt: string, cls: Classification | null, tune?: RouterTuning): MessageRoute {
  const r = capHaiku(prompt, decideRoute(prompt, cls, tune), cls)
  return { ...r, effort: chooseEffort(prompt, r) }
}

const RANK: Readonly<Record<RouteFamily, number>> = { haiku: 0, sonnet: 1, opus: 2 }

/** v1.57.0: the route for a subagent, from the task its parent gave it, against the model it was launched
 *  on. A subagent starts with an empty context, so moving it costs nothing yet, but whoever launched it
 *  on a model had a reason: it moves up only from UP_MIN_CONFIDENCE, down only from OVERRIDE_CONFIDENCE,
 *  and to Haiku only on a clear vote for it (a task is long by nature, so quickQuestion does not apply,
 *  and neither does the length rule for effort). 'keep' leaves the model as launched. */
export function routeSubagent(task: string, cls: Classification | null, asked: RouteFamily, tune?: RouterTuning): MessageRoute {
  const r = decideRoute(task, cls, tune)
  if (r.label === 'keep') return r
  let label: RouteFamily = r.label
  if (label === 'haiku' && !(cls && cls.label === 'haiku' && cls.topSim >= MIN_TOP_SIM && cls.confidence >= HAIKU_MIN_CONFIDENCE)) label = 'sonnet'
  if (RANK[label] > RANK[asked] && r.confidence < UP_MIN_CONFIDENCE) label = asked
  if (RANK[label] < RANK[asked] && r.confidence < OVERRIDE_CONFIDENCE) label = asked
  const base: MessageRoute = { ...r, label, effort: label === r.label ? r.effort : EFFORT_OF[label] }
  return { ...base, effort: chooseEffort(task, base, { countLength: false }) }
}

function decideRoute(prompt: string, cls: Classification | null, tune?: RouterTuning): MessageRoute {
  const rule = routeTask({ prompt }, tune)
  const rl = ruleLabel(rule)
  const fromRules: MessageRoute = { label: rl, effort: rule.effort, confidence: rule.confidence, source: 'rules', rule: rule.rule }
  if (rule.rule === 'no-task') return { ...fromRules, label: 'keep' }
  if (!cls || cls.topSim < MIN_TOP_SIM) return fromRules
  if (cls.label === rl) return { ...fromRules, confidence: Math.max(cls.confidence, rule.confidence), source: 'both' }
  // v1.56.2: a sure vote beats any disagreeing rule. Measured on the seeds (npm run router:eval) the vote
  // alone was right more often than the vote held back by a rule's own confidence ("why" forced Opus).
  if (cls.confidence < OVERRIDE_CONFIDENCE) return fromRules
  if (cls.label === 'keep') return { label: 'keep', effort: rule.effort, confidence: cls.confidence, source: 'local-model' }
  return { label: cls.label, effort: EFFORT_OF[cls.label], confidence: cls.confidence, source: 'local-model' }
}

function capHaiku(prompt: string, r: MessageRoute, cls: Classification | null): MessageRoute {
  if (r.label !== 'haiku') return r
  if (cls && cls.label === 'haiku' && cls.topSim >= MIN_TOP_SIM && cls.confidence >= HAIKU_MIN_CONFIDENCE && quickQuestion(prompt)) return r
  return { ...r, label: 'sonnet', effort: 'medium' }
}

/** v1.58.0: the reasoning efforts Codex takes. */
export type CodexEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** One routed message, as main tells its pane (messageRouter.routePrompt → 'router:message'). */
export interface RouteEvent {
  terminalId: string
  /** The message (first 2000 characters), for the pane's "should have been" menu to teach the classifier. */
  prompt: string
  /** The model the message runs on. */
  model: 'opus' | 'sonnet' | 'haiku'
  /** The model the session was on before it; null for a session's first message. */
  from: 'opus' | 'sonnet' | 'haiku' | null
  /** v1.57.0: the effort the message runs at; null = the session's own (nothing changed). */
  effort?: EffortLevel | null
  /** The effort the session ran at before it, when known. */
  fromEffort?: EffortLevel | null
  /** v1.57.0: a subagent's task, not a typed message: `from` is the model it was launched on. */
  agent?: boolean
  /** v1.58.0: a Codex turn. Only the effort moved (`from` = the one before: the last routed turn's, else
   *  what Codex asked); `model` is just the message's label as a family and names no model. */
  codex?: { effort: CodexEffort; from: string | null }
  switched: boolean
  /** Why: first, keep, same, cheaper, lighter, switch-costs-more, needs-stronger, more-thought,
   *  not-sure-enough, context-too-big, too-big-for-haiku; agent (a subagent's task); struggling (tool
   *  calls kept failing, so the effort went up for the rest of the message); codex (a Codex turn's effort). */
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
