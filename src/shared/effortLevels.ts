// v1.57.0 effort routing: the effort levels, in order, and what each one is expected to cost. Pure.
//
// Effort (`output_config.effort`) scales how much a model thinks and how many tool calls it makes, on
// the same model. Every Claude 5.5 model takes all five levels. Sending a model's default level is the
// same request as sending none, so a missing effort counts as the default everywhere here: the prompt
// cache does not tell the two apart either.

import type { EffortLevel } from './taskRouter'
import type { RouteFamily } from './switchEconomics'

export type { EffortLevel }

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** What a 5.5 model runs at when the request names no effort. */
export const DEFAULT_EFFORT: Readonly<Record<RouteFamily, EffortLevel>> = { opus: 'medium', sonnet: 'high', haiku: 'medium' }

/** Output tokens at each level, relative to high: thinking and tool depth grow with effort. A rough
 *  shape for the cost gate, not a measurement of any one task. */
export const EFFORT_OUT: Readonly<Record<EffortLevel, number>> = { low: 0.35, medium: 0.6, high: 1, xhigh: 1.4, max: 1.9 }

export function isEffort(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v)
}

export function effortRank(e: EffortLevel): number {
  return EFFORT_LEVELS.indexOf(e)
}

/** The level `steps` up (or down, when negative) from `e`, never below `low`. A raise stops at `cap`,
 *  and never lowers a level already above it. */
export function bumpEffort(e: EffortLevel, steps: number, cap: EffortLevel = 'max'): EffortLevel {
  const r = effortRank(e)
  const s = Math.trunc(steps)
  if (s > 0) return EFFORT_LEVELS[Math.max(r, Math.min(r + s, effortRank(cap)))]
  return EFFORT_LEVELS[Math.max(0, r + s)]
}

/** The level a request on `family` runs at: its own, or the model's default when it names none. */
export function effortOrDefault(family: RouteFamily, e: unknown): EffortLevel {
  return isEffort(e) ? e : DEFAULT_EFFORT[family]
}
