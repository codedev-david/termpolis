// Pure logic for SwarmReviewPanel — loading the diff, running tests, committing.
// Separated from the React component so it's easy to unit-test without a DOM.

import { parseUnifiedDiff, diffStat, type DiffFile } from './diffParser'

export interface ReviewState {
  /** Pre-swarm HEAD SHA — the baseline we diff against. */
  preSha: string
  /** Files parsed from the diff. */
  files: DiffFile[]
  /** Per-hunk approval state. undefined=pending, 'accept'=keep, 'reject'=revert. */
  hunkDecisions: Record<string, 'accept' | 'reject'>
  /** Whether the last test run passed (null = not run yet). */
  lastTestPassed: boolean | null
  /** Last test output. */
  lastTestOutput: string
}

export function emptyReviewState(preSha: string): ReviewState {
  return { preSha, files: [], hunkDecisions: {}, lastTestPassed: null, lastTestOutput: '' }
}

/**
 * Load the full pre-sha..HEAD diff from the main process.
 */
export async function loadReviewDiff(cwd: string, preSha: string): Promise<ReviewState> {
  const diffRes = await window.termpolis.gitDiffRange(cwd, preSha)
  const raw = diffRes.success && typeof diffRes.data === 'string' ? diffRes.data : ''
  const files = parseUnifiedDiff(raw)
  return {
    preSha,
    files,
    hunkDecisions: {},
    lastTestPassed: null,
    lastTestOutput: '',
  }
}

/**
 * Compute what's been decided so far.
 */
export function reviewProgress(state: ReviewState): { total: number; accepted: number; rejected: number; pending: number } {
  let accepted = 0
  let rejected = 0
  let total = 0
  for (const f of state.files) {
    for (const h of f.hunks) {
      total++
      const d = state.hunkDecisions[h.id]
      if (d === 'accept') accepted++
      else if (d === 'reject') rejected++
    }
  }
  return { total, accepted, rejected, pending: total - accepted - rejected }
}

/**
 * Quick count of added/removed/hunks/files for the summary line.
 */
export function reviewStat(state: ReviewState) {
  return diffStat(state.files)
}

export interface TestResult {
  passed: boolean
  output: string
  exitCode: number
}

/**
 * Run a shell command (typically the project test runner) and return the
 * result. Default command auto-detects from repo, but caller can override.
 */
export async function runTests(cwd: string, command: string): Promise<TestResult> {
  const res = await window.termpolis.swarmRunCommand(cwd, command)
  if (!res.success || !res.data) {
    return { passed: false, output: res.error || 'Failed to run command', exitCode: -1 }
  }
  return {
    passed: res.data.exitCode === 0,
    output: res.data.output,
    exitCode: res.data.exitCode,
  }
}

/**
 * Best-effort detection of the project test command. Falls back to `npm test`.
 */
export async function detectTestCommand(cwd: string): Promise<string> {
  // Quick heuristic: look for common package manager lockfiles + scripts.
  try {
    const pkgRes = await window.termpolis.readConfigFile(`${cwd}/package.json`)
    if (pkgRes.success && pkgRes.data) {
      const pkg = JSON.parse(pkgRes.data)
      if (pkg?.scripts?.test) {
        // Prefer pnpm/yarn/npm based on lockfile presence. Default: npm.
        return 'npm test'
      }
    }
  } catch { /* not a node project */ }
  return 'npm test'
}

/**
 * Build a default commit message from the review state.
 */
export function suggestCommitMessage(state: ReviewState, taskDescription?: string): string {
  const stat = reviewStat(state)
  const short = taskDescription ? taskDescription.split('\n')[0].slice(0, 72) : ''
  const body = `Swarm changes: ${stat.files} file${stat.files !== 1 ? 's' : ''}, ` +
               `+${stat.added} / -${stat.removed}`
  return short ? `${short}\n\n${body}` : body
}
