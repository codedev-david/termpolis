/**
 * How a review loop spends tokens (v1.55.0 Task 14). The four 1.55 branches cost 61M tokens, about
 * 0.6M per agent run, mostly reviews of code that had already been reviewed. The rules:
 * - tests, lint and typecheck run as commands, never as a model lens;
 * - reviewers and fixers run on Sonnet; Opus is only the one deep lens in round 1;
 * - from round 2 on a reviewer sees only the diff since the last reviewed commit;
 * - the loop stops after round 3, or as soon as a round finds no blocker or major;
 * - minors are fixed in one final pass and never start another round.
 */
export type ReviewSeverity = 'blocker' | 'major' | 'minor'

export interface ReviewPolicy {
  reviewer: { model: 'sonnet'; effort: 'medium' }
  fixer: { model: 'sonnet'; effort: 'high' }
  deepLens: { model: 'opus'; effort: 'high' }
  maxRounds: 3
  deltaOnly: true
  stopWhen: 'no-blockers-or-majors'
}

export const REVIEW_POLICY: ReviewPolicy = {
  reviewer: { model: 'sonnet', effort: 'medium' },
  fixer: { model: 'sonnet', effort: 'high' },
  deepLens: { model: 'opus', effort: 'high' },
  maxRounds: 3,
  deltaOnly: true,
  stopWhen: 'no-blockers-or-majors',
}

/** What the next round reviews: everything up to HEAD the first time, then only what changed since. */
export function nextReviewScope(lastReviewedSha: string | null, headSha: string): { range: string; full: boolean } {
  const last = lastReviewedSha?.trim()
  if (!last || last === headSha) return { range: headSha, full: !last }
  return { range: `${last}..${headSha}`, full: false }
}

/** True once `round` (1-based) reaches the cap, or when its findings hold no blocker or major. */
export function shouldStop(round: number, findings: readonly { severity: ReviewSeverity }[]): boolean {
  return round >= REVIEW_POLICY.maxRounds || !findings.some((f) => f.severity !== 'minor')
}

/** The policy as conductor prompt lines. */
export function reviewPolicyText(): string {
  const p = REVIEW_POLICY
  return [
    `  REVIEW LOOPS — conserve tokens:`,
    `    • Run tests, lint and typecheck as commands (run_and_wait), never as a reviewer agent.`,
    `    • Reviewers use '--model ${p.reviewer.model} --effort ${p.reviewer.effort}', fixers '--model ${p.fixer.model} --effort ${p.fixer.effort}'.`,
    `      Only one deep reviewer in round 1 may use '--model ${p.deepLens.model}'.`,
    `    • From round 2, review only the diff since the last reviewed commit (git diff <last>..HEAD).`,
    `    • Stop after round ${p.maxRounds}, or when a round finds no blocker or major. Fix minors in one final pass.`,
  ].join('\n')
}
