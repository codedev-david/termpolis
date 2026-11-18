// What main tells the world compiler about test runs. Main knows where the agent transcripts are and owns the
// settings, so the compiler (in the utility process) asks it for two things: the transcript FILES to read (the
// host reads and parses them, never main), and the CI conclusion of the commit that is checked out. Nothing
// here touches the main thread's disk or process table: the two commands go through the off-thread exec
// helper. Dependencies are injected so the logic is tested without a disk, a git repository or the GitHub CLI.

import type { TestRun } from './testStatus'
import { MAX_TRANSCRIPTS, TRANSCRIPT_CACHE_MS } from './transcriptRuns'

/** How long one root's CI result is kept (while HEAD stays the same). */
export const CI_CACHE_MS = 10 * 60_000
/** How long `gh` may take. */
export const GH_TIMEOUT_MS = 5000
const GIT_TIMEOUT_MS = 5000
const MAX_CI_FILES = 2000
/** How many recent runs of the branch are fetched and filtered. */
export const CI_RUNS_FETCHED = 20
/** The workflow whose conclusion judges the tests. */
const TEST_WORKFLOW = /^tests?$/i
const BRANCH = /^\w[\w./-]{0,199}$/
const FULL_SHA = /^[0-9a-f]{40,64}$/

export interface ExecOutcome {
  stdout: string
  error?: unknown
}
export interface RunsDeps {
  /** The agent transcripts of a folder, newest first. */
  listTranscripts: (root: string) => Promise<string[]>
  /** Whether Termpolis may read agent transcripts (the memory setting "learn from conversations"). */
  transcriptsAllowed: () => boolean
  /** Whether the person turned on "Read CI results with GitHub CLI". Nothing runs `gh` or git for CI unless this is true. */
  ciAllowed: () => Promise<boolean>
  /** Runs a command off the main thread, never throwing. */
  exec: (bin: string, args: string[], opts: { cwd: string; timeout: number }) => Promise<ExecOutcome>
  now: () => number
}

export interface WorldRuns {
  /** The transcript files the host should read: at most the 20 newest, or none when conversations may not be read. */
  transcriptFiles: (root: string) => Promise<string[]>
  ciRuns: (root: string) => Promise<TestRun[]>
}

interface CachedFiles {
  at: number
  files: string[]
}
interface CachedCi {
  at: number
  head: string
  runs: TestRun[]
}

interface GhRow {
  conclusion?: unknown
  headSha?: unknown
  createdAt?: unknown
  workflowName?: unknown
}

export function createWorldRuns(d: RunsDeps): WorldRuns {
  const transcripts = new Map<string, CachedFiles>()
  const ci = new Map<string, CachedCi>()

  const transcriptFiles = async (root: string): Promise<string[]> => {
    if (!d.transcriptsAllowed()) return []
    const hit = transcripts.get(root)
    if (hit && d.now() - hit.at < TRANSCRIPT_CACHE_MS) return hit.files
    let files: string[] = []
    try {
      files = (await d.listTranscripts(root)).slice(0, MAX_TRANSCRIPTS)
    } catch {
      files = []
    }
    transcripts.set(root, { at: d.now(), files })
    return files
  }

  const git = async (root: string, args: string[]): Promise<string | null> => {
    const out = await d.exec('git', args, { cwd: root, timeout: GIT_TIMEOUT_MS })
    return out.error ? null : out.stdout.trim()
  }

  const lookUp = async (root: string, head: string): Promise<TestRun[]> => {
    const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    // A detached HEAD names no branch, so no run can be tied to it.
    if (branch === null || branch === 'HEAD' || !BRANCH.test(branch)) return []
    const listed = await d.exec(
      'gh',
      ['run', 'list', '--branch', branch, '--limit', String(CI_RUNS_FETCHED), '--json', 'conclusion,headSha,createdAt,databaseId,workflowName'],
      { cwd: root, timeout: GH_TIMEOUT_MS }
    )
    if (listed.error) return []
    const rows = JSON.parse(listed.stdout) as unknown
    if (!Array.isArray(rows)) return []
    // Only a run of the test workflow on exactly the commit that is checked out judges this code.
    const match = (rows as Array<GhRow | null>).find(
      (r) =>
        typeof r?.headSha === 'string' &&
        r.headSha.toLowerCase() === head &&
        typeof r.workflowName === 'string' &&
        TEST_WORKFLOW.test(r.workflowName) &&
        (r.conclusion === 'success' || r.conclusion === 'failure')
    )
    if (!match) return []
    const changed = await git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', head])
    if (changed === null) return []
    const parsed = typeof match.createdAt === 'string' ? Date.parse(match.createdAt) : NaN
    const at = Math.min(Number.isNaN(parsed) ? d.now() : parsed, d.now())
    return changed
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f !== '')
      .slice(0, MAX_CI_FILES)
      .map((file) => ({ file, passed: match.conclusion === 'success', at, source: 'ci' as const }))
  }

  const ciRuns = async (root: string): Promise<TestRun[]> => {
    // The consent first: `gh` reads its own stored login, so without the setting nothing for CI is started.
    if (!(await d.ciAllowed())) return []
    let runs: TestRun[] = []
    try {
      const head = ((await git(root, ['rev-parse', 'HEAD'])) ?? '').toLowerCase()
      if (!FULL_SHA.test(head)) return []
      const hit = ci.get(root)
      // A cached answer holds only while HEAD is the commit it judged.
      if (hit && hit.head === head && d.now() - hit.at < CI_CACHE_MS) return hit.runs
      runs = await lookUp(root, head)
      ci.set(root, { at: d.now(), head, runs })
    } catch {
      runs = []
    }
    return runs
  }

  return { transcriptFiles, ciRuns }
}
