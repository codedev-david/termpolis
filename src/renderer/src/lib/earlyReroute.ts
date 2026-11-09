// v1.55.0 Task 9: early re-route. After a Claude session's first prompt, the header may offer a
// model that fits the task better ("Looks like a quick lookup. Continue on Haiku?"). A switch is
// cheap only while the conversation is short: the new model reads it all again at full price
// (its cache is cold), so the offer stops after REROUTE_MAX_TURNS. It is only an offer; nothing
// switches until the user clicks.
import { isClaudeModelWord, routeTask, type ClaudeModelWord, type RouteDecision, type RouterTuning } from '../../../shared/taskRouter'

export type RerouteDirection = 'up' | 'down'

/** Turns after which a switch costs more than it saves. */
export const REROUTE_MAX_TURNS = 2

const TIER: Record<ClaudeModelWord, number> = { haiku: 0, sonnet: 1, opus: 2, opusplan: 2 }
const NAME: Record<ClaudeModelWord, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', opusplan: 'Opus Plan' }

/** Should the header offer `decision.model` instead of what runs? `running` null = unknown (a session
 *  started without --model runs the account's default, which is never Haiku), so only a move down to
 *  Haiku is offered then. No offer for the default rule (a guess), for the same tier, or late. */
export function shouldOfferReroute(running: ClaudeModelWord | null, decision: RouteDecision, turns: number): RerouteDirection | null {
  if (turns > REROUTE_MAX_TURNS || decision.rule === 'default' || decision.rule === 'no-task') return null
  if (running === null) return decision.model === 'haiku' ? 'down' : null
  const from = TIER[running]
  const to = TIER[decision.model]
  if (from === to) return null
  return to < from ? 'down' : 'up'
}

/** The chip's words. */
export function rerouteChipText(direction: RerouteDirection, model: ClaudeModelWord): string {
  if (direction === 'down') return model === 'haiku' ? 'Looks like a quick lookup. Continue on Haiku?' : `Looks like everyday work. Continue on ${NAME[model]}?`
  return model === 'opus' ? 'This looks deep. Switch to Opus?' : `This looks like more than a lookup. Switch to ${NAME[model]}?`
}

function modelWord(value: string | undefined | null): ClaudeModelWord | null {
  if (!value) return null
  if (isClaudeModelWord(value)) return value
  const m = /(opusplan|opus|sonnet|haiku)/i.exec(value)
  return m ? (m[1].toLowerCase() as ClaudeModelWord) : null
}

/** The Claude model a pane runs, as far as Termpolis knows: the one picked in the header, else the
 *  one Auto launched it on, else the --model on its launch line. null when none says. */
export function runningClaudeModel(p: { liveModel?: string; routed?: RouteDecision; agentCommand?: string }): ClaudeModelWord | null {
  const fromCommand = /(?:^|\s)--model(?:=|\s+)(\S+)/.exec(p.agentCommand ?? '')
  return modelWord(p.liveModel) ?? (p.routed ? p.routed.model : null) ?? modelWord(fromCommand?.[1])
}

export interface RerouteOffer {
  direction: RerouteDirection
  model: ClaudeModelWord
  text: string
}

/** The offer for a prompt, or null. `turns` = prompts the session has had (1 for the first). */
export function rerouteOffer(prompt: string, running: ClaudeModelWord | null, turns = 1, tune?: RouterTuning): RerouteOffer | null {
  if (!prompt.trim()) return null
  const decision = routeTask({ prompt }, tune)
  const direction = shouldOfferReroute(running, decision, turns)
  return direction ? { direction, model: decision.model, text: rerouteChipText(direction, decision.model) } : null
}
