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

// Named rather than positional. `conservative` used to build itself out of BASE[0] and
// BASE[3]; inserting a line into BASE then silently re-pointed it at a different directive.
// Names make that class of edit impossible.
/**
 * The one sentence every steering mode emits, conservative through max — which makes it the
 * marker the wire layer uses to tell a steered request from an unsteered one. Exported rather
 * than duplicated as a string literal in the proxy: a detector that can drift from the thing it
 * detects reports "steering off" forever and nobody notices, because a false negative here looks
 * exactly like a user who left the feature disabled.
 */
export const STEERING_MARK = 'Output style: be terse and information-dense.'
const D_TERSE = STEERING_MARK
const D_DEPTH = 'Reserve depth for genuinely hard or ambiguous work.'
const D_NO_RESTATE = 'Never repeat content already visible in tool output — reference it instead.'

const BASE = [
  D_TERSE,
  'Skip preamble and postamble — no restating the question, no "Here is…", no summary of what you are about to do.',
  'Prefer the smallest correct answer; do not over-explain routine steps (file reads, simple edits).',
  D_DEPTH,
  // Promoted from MAX_EXTRA to BASE in v1.36.0. Output is the second-largest slice of the
  // measured bill (33% of effective units, and worth ~1.6x face value once you count the
  // amortized prefix every generated token later gets re-read inside), and in an agentic
  // coding loop restating tool output is the single largest avoidable sink. There is no
  // version of that instruction that only a max-mode user needs — it costs nothing in
  // fidelity, because the content it suppresses is by definition already on screen.
  D_NO_RESTATE,
]

const MAX_EXTRA = [
  'Answer in as few words as the question allows; a bare value, path, or verdict is a complete answer.',
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
  // Conservative keeps D_NO_RESTATE even though it drops everything else: restating tool
  // output is the one verbosity that costs the reader nothing to lose, because the content is
  // by definition already on their screen. Trimming it is not a fidelity trade at any tier.
  if (mode === 'conservative') return [D_TERSE, D_DEPTH, D_NO_RESTATE].join(' ')
  // Max: everything aggressive says, plus the hardest cuts. The wire tier and the steering tier
  // share one setting, so selecting the hardest compression must not hand back a WEAKER directive
  // than aggressive — which is exactly what an unhandled mode would do by falling through to BASE.
  if (mode === 'max') return [...BASE, ...AGGRESSIVE_EXTRA, ...MAX_EXTRA].join(' ')
  // Aggressive: the full base plus harder cuts to output length.
  if (mode === 'aggressive') return [...BASE, ...AGGRESSIVE_EXTRA].join(' ')
  // Balanced (default): byte-identical to the historical directive — no behavior change.
  return BASE.join(' ')
}
