// Competence signals from REAL work.
//
// WHY: the metacognition layer (mnemeCompetence) learns "how reliable am I in this
// domain" by folding in task OUTCOMES — but recordOutcome only ever fired on (a) a
// swarm task reaching a terminal status, or (b) a solo session whose LAST assistant
// turn happened to contain a magic phrase ("fixed", "tests pass", "still failing").
// Ordinary interactive work produced NOTHING, so every domain sat at attempts:0 /
// "unproven" forever and the dashboard's competence panel was permanently empty.
//
// This maps the things that actually PROVE whether the work landed onto outcomes:
//   - a git commit that succeeded   -> the change was accepted
//   - a test run that passed/failed -> ground truth, honest in BOTH directions
//
// Pure: the caller supplies the already-normalized project slug and persists the
// result, so this stays trivially unit-testable.

export type WorkEvent =
  | { kind: 'git-commit'; project: string; ok: boolean }
  | { kind: 'test-run'; project: string; exitCode: number }
  | { kind: 'session-end'; project: string; outcome?: 'success' | 'failure' }

export interface Outcome {
  domain: string
  success: boolean
  reason: string
}

export function deriveOutcome(e: WorkEvent): Outcome | null {
  const domain = (e.project || '').trim()
  if (!domain) return null

  switch (e.kind) {
    case 'git-commit':
      // Only a LANDED commit is evidence. A blocked/failed commit says nothing about
      // competence — it may have been an empty commit, or the secret shield firing —
      // and recording it as a failure would poison the calibration with non-evidence.
      return e.ok ? { domain, success: true, reason: 'commit landed' } : null

    case 'test-run':
      // The one signal that is honest in both directions. Without it, confidence can
      // only ever ratchet up; this is what actually calibrates it back DOWN.
      return e.exitCode === 0
        ? { domain, success: true, reason: 'tests passed' }
        : { domain, success: false, reason: `tests failed (exit ${e.exitCode})` }

    case 'session-end':
      if (e.outcome === 'success') return { domain, success: true, reason: 'session ended in success' }
      if (e.outcome === 'failure') return { domain, success: false, reason: 'session ended in failure' }
      return null
  }
}
