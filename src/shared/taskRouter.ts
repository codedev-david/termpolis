// v1.55.0 Task 6: one router for "which Claude model and effort fits this task". Pure (no IO),
// shared by main and renderer. It replaces the renderer's smartRouter + taskAnalyzer pair, which
// split a prompt into subtasks and scored agents per category; nothing outside their own tests
// used them. Rules run in order and the first one that matches decides. Word lists are short on
// purpose: a miss falls through to the safe default (Sonnet, high effort), never to Haiku.

export type ClaudeModelWord = 'opus' | 'sonnet' | 'haiku' | 'opusplan'
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface RouteInput {
  /** The task as the user typed it. Empty or missing = no task yet. */
  prompt?: string
  /** Files in the working folder, when known. Not a rule input yet; kept for the receipt. */
  cwdFileCount?: number
  /** Files the task names. More than 8 is cross-cutting work. */
  mentionsFiles?: number
  /** A relay session picking up where an earlier one stopped. */
  isRelay?: boolean
  /** The model the earlier session ran, for a relay. */
  lastModel?: ClaudeModelWord
}

export interface RouteDecision {
  model: ClaudeModelWord
  effort: EffortLevel
  /** Which rule decided: no-task, relay, deep, build, lookup or default. */
  rule: string
  /** 0..1, how sure the rule is. The default is a guess. */
  confidence: number
}

export interface RouterTuning {
  /** Longest prompt, in words, that may still go to Haiku. */
  haikuMaxWords: number
  /** Times the user overrode each rule's pick. */
  misroutes: Record<string, number>
}

export const DEFAULT_ROUTER_TUNING: RouterTuning = { haikuMaxWords: 25, misroutes: {} }

/** Misroutes after which a rule routes one tier up. */
export const MISROUTE_LIMIT = 3

const CLAUDE_MODEL_WORDS: readonly ClaudeModelWord[] = ['opus', 'sonnet', 'haiku', 'opusplan']

const DEEP = /\b(design|architect\w*|plan|planning|why|race|races|deadlock\w*|security review|migrat\w*)\b/i
const BUILD = /\b(implement\w*|fix|fixes|fixing|refactor\w*|add (?:a |an |the |some )?(?:unit |e2e |integration )?tests?|per the plan|rename\w* [^.]*\bacross)\b/i
const LOOKUP = /\b(explain\w*|what is|what's|find|list|format|commit message|summari[sz]e\w*)\b/i
// "Per the plan" is build work that names a plan, not a request to make one.
const NAMED_PLAN = /\b(per|following|from|in|on) the plan\b/gi

const UP: Record<ClaudeModelWord, ClaudeModelWord> = { haiku: 'sonnet', sonnet: 'opus', opus: 'opus', opusplan: 'opusplan' }
const EFFORT_UP: Record<EffortLevel, EffortLevel> = { low: 'medium', medium: 'high', high: 'high', xhigh: 'xhigh', max: 'max' }

export function isClaudeModelWord(v: unknown): v is ClaudeModelWord {
  return typeof v === 'string' && (CLAUDE_MODEL_WORDS as readonly string[]).includes(v)
}

function decide(input: RouteInput, tune: RouterTuning): RouteDecision {
  const prompt = (input.prompt ?? '').trim()
  if (!prompt) {
    if (input.isRelay && isClaudeModelWord(input.lastModel)) return { model: input.lastModel, effort: 'high', rule: 'relay', confidence: 0.6 }
    return { model: 'opusplan', effort: 'high', rule: 'no-task', confidence: 1 }
  }
  if (DEEP.test(prompt.replace(NAMED_PLAN, ' ')) || (input.mentionsFiles ?? 0) > 8) {
    return { model: 'opus', effort: 'high', rule: 'deep', confidence: 0.8 }
  }
  if (BUILD.test(prompt)) return { model: 'sonnet', effort: 'medium', rule: 'build', confidence: 0.75 }
  const words = prompt.split(/\s+/).length
  if (words <= tune.haikuMaxWords && LOOKUP.test(prompt)) return { model: 'haiku', effort: 'low', rule: 'lookup', confidence: 0.7 }
  return { model: 'sonnet', effort: 'high', rule: 'default', confidence: 0.4 }
}

/** The model and effort for a task. A rule the user overrode MISROUTE_LIMIT times or more
 *  routes one tier up from then on. Pure. */
export function routeTask(input: RouteInput, tune: RouterTuning = DEFAULT_ROUTER_TUNING): RouteDecision {
  const d = decide(input, tune)
  if ((tune.misroutes[d.rule] ?? 0) < MISROUTE_LIMIT) return d
  return { ...d, model: UP[d.model], effort: EFFORT_UP[d.effort] }
}

/** The tuning with one more misroute counted against `rule`. Returns a new object. */
export function recordMisroute(rule: string, tune: RouterTuning): RouterTuning {
  return { ...tune, misroutes: { ...tune.misroutes, [rule]: (tune.misroutes[rule] ?? 0) + 1 } }
}
