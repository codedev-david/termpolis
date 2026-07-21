/**
 * Standing output-token steering appended to the launch system prompt.
 * Trims what the model WRITES BACK (output ≈ 5× input cost). Toggled by
 * settings.steering at the call site, and graded by settings.mode. Not
 * per-request effort dialing (that needs a proxy) — a durable verbosity nudge.
 *
 * Pure + deterministic (same mode → same bytes): the directive rides in the
 * re-sent system prompt, so any per-launch variation would bust the prompt cache.
 */
export type SteeringMode = 'conservative' | 'balanced' | 'aggressive'

const BASE = [
  'Output style: be terse and information-dense.',
  'Skip preamble and postamble — no restating the question, no "Here is…", no summary of what you are about to do.',
  'Prefer the smallest correct answer; do not over-explain routine steps (file reads, simple edits).',
  'Reserve depth for genuinely hard or ambiguous work.',
]

const AGGRESSIVE_EXTRA = [
  'Lead with the answer or result; put any reasoning after it, and only when it changes the outcome.',
  'Omit restated context, status narration, and closing summaries entirely.',
  'Default to the shortest reply that fully answers; expand only when explicitly asked to.',
]

export function steeringDirective(mode: SteeringMode = 'balanced'): string {
  // Conservative: a gentle nudge that still leaves room for explanation the user may want.
  if (mode === 'conservative') return [BASE[0], BASE[3]].join(' ')
  // Aggressive: the full base plus harder cuts to output length.
  if (mode === 'aggressive') return [...BASE, ...AGGRESSIVE_EXTRA].join(' ')
  // Balanced (default): byte-identical to the historical directive — no behavior change.
  return BASE.join(' ')
}
