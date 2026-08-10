/**
 * Standing output-token steering appended to the launch system prompt.
 * Trims what the model WRITES BACK (output ≈ 5× input cost). Toggled by
 * settings.steering at the call site, and graded by settings.mode. Not
 * per-request effort dialing (that needs a proxy) — a durable verbosity nudge.
 *
 * Pure + deterministic (same mode → same bytes): the directive rides in the
 * re-sent system prompt, so any per-launch variation would bust the prompt cache.
 */
export type SteeringMode = 'conservative' | 'balanced' | 'aggressive' | 'max'

const BASE = [
  'Output style: be terse and information-dense.',
  'Skip preamble and postamble — no restating the question, no "Here is…", no summary of what you are about to do.',
  'Prefer the smallest correct answer; do not over-explain routine steps (file reads, simple edits).',
  'Reserve depth for genuinely hard or ambiguous work.',
]

const MAX_EXTRA = [
  'Answer in as few words as the question allows; a bare value, path, or verdict is a complete answer.',
  'Never repeat content already visible in tool output — reference it instead.',
  'No lists or headings unless the answer is genuinely enumerable.',
]

const AGGRESSIVE_EXTRA = [
  'Lead with the answer or result; put any reasoning after it, and only when it changes the outcome.',
  'Omit restated context, status narration, and closing summaries entirely.',
  'Default to the shortest reply that fully answers; expand only when explicitly asked to.',
]

/**
 * Adaptive steering: pick the directive strength from how much the model has ACTUALLY been
 * writing, rather than from the compression mode alone.
 *
 * Resolved ONCE PER LAUNCH and then frozen for the session. The directive is part of the system
 * prompt that gets re-sent every turn, so a strength that drifted mid-conversation would
 * invalidate the cached prefix on the turn it changed — the adjustment has to be a launch-time
 * decision or it costs more than it saves.
 *
 * Below ADAPTIVE_MIN_REQUESTS there isn't enough history to justify overriding an explicit
 * setting, so the configured mode stands.
 */
export const ADAPTIVE_MIN_REQUESTS = 50
/** Average output tokens/request at or above which steering tightens one notch. */
export const ADAPTIVE_HIGH = 2200
/** ...and at or below which it relaxes one notch, so a terse session isn't over-constrained. */
export const ADAPTIVE_LOW = 700

const LADDER: SteeringMode[] = ['conservative', 'balanced', 'aggressive', 'max']

export function adaptSteeringMode(configured: SteeringMode, outputTokens: number, requests: number): SteeringMode {
  if (!Number.isFinite(outputTokens) || !Number.isFinite(requests) || requests < ADAPTIVE_MIN_REQUESTS) return configured
  const avg = outputTokens / requests
  const i = LADDER.indexOf(configured)
  if (i < 0) return configured
  if (avg >= ADAPTIVE_HIGH) return LADDER[Math.min(LADDER.length - 1, i + 1)]
  if (avg <= ADAPTIVE_LOW) return LADDER[Math.max(0, i - 1)]
  return configured
}

export function steeringDirective(mode: SteeringMode = 'balanced'): string {
  // Conservative: a gentle nudge that still leaves room for explanation the user may want.
  if (mode === 'conservative') return [BASE[0], BASE[3]].join(' ')
  // Max: everything aggressive says, plus the hardest cuts. The wire tier and the steering tier
  // share one setting, so selecting the hardest compression must not hand back a WEAKER directive
  // than aggressive — which is exactly what an unhandled mode would do by falling through to BASE.
  if (mode === 'max') return [...BASE, ...AGGRESSIVE_EXTRA, ...MAX_EXTRA].join(' ')
  // Aggressive: the full base plus harder cuts to output length.
  if (mode === 'aggressive') return [...BASE, ...AGGRESSIVE_EXTRA].join(' ')
  // Balanced (default): byte-identical to the historical directive — no behavior change.
  return BASE.join(' ')
}
