/**
 * Standing output-token steering appended to the launch system prompt.
 * Trims what the model WRITES BACK (output ≈ 5× input cost). Toggled by
 * settings.steering at the call site. Not per-request effort dialing (that
 * needs a proxy) — this is a durable verbosity/effort nudge.
 */
export function steeringDirective(): string {
  return [
    'Output style: be terse and information-dense.',
    'Skip preamble and postamble — no restating the question, no "Here is…", no summary of what you are about to do.',
    'Prefer the smallest correct answer; do not over-explain routine steps (file reads, simple edits).',
    'Reserve depth for genuinely hard or ambiguous work.',
  ].join(' ')
}
