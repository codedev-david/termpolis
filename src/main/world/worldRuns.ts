// What main tells the world compiler about test runs. Main knows where the agent transcripts are and owns the
// settings, so the compiler (in the utility process) asks it for two things: the transcript FILES to read (the
// host reads and parses them, never main), and the CI conclusion of the commit that is checked out. Nothing
// here touches the main thread's disk or process table: the two commands go through the off-thread exec
// helper. Dependencies are injected so the logic is tested without a disk, a git repository or the GitHub CLI.
// CI is read by default (David, 2026-11-18) and only where it can work: `gh` must be on PATH (found by looking at
// the PATH folders, never by starting anything, and then started by that full path) and the repository must have a
// GitHub remote.

import { posix, win32 } from 'path'
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
/** A remote URL on GitHub: https://github.com/o/r, git@github.com:o/r or ssh://git@github.com/o/r. */
const GITHUB_REMOTE = /(^|[@/])github\.com[:/]/i

/** A PATH folder that names one place whatever the current folder is: on Windows a drive path (`C:\…`) or a share
 *  (`\\server\…`), never `\tools` or `C:tools`, which hang off the current drive or folder. */
const FIXED_WIN_DIR = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/

/** The full path of the program `name` in the PATH folders, or null. Only a folder fixed on disk counts: relative
 *  entries, `.` and the current folder (`cwd`) are skipped, so a `gh.exe` planted in a repository never answers. On
 *  Windows only `name.exe` counts: the exec helper starts it without a shell, and a `.cmd` or `.bat` would need
 *  one, so they are refused rather than run. `runnable` throws for a file that is missing or may not be run; it
 *  is the only thing that touches the disk, and nothing is started. */
export async function commandOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  runnable: (file: string) => Promise<unknown>,
  cwd?: string
): Promise<string | null> {
  const win = platform === 'win32'
  const p = win ? win32 : posix
  const key = (dir: string): string => {
    const n = p.normalize(dir).replace(/[\\/]+$/, '')
    return win ? n.toLowerCase() : n
  }
  const here = cwd === undefined ? null : key(cwd)
  const dirs = (env.PATH ?? env.Path ?? '').replace(/"/g, '').split(win ? ';' : ':')
  for (const dir of dirs) {
    if (!(win ? FIXED_WIN_DIR.test(dir) : p.isAbsolute(dir)) || key(dir) === here) continue
    const file = p.join(dir, win ? name + '.exe' : name)
    try {
      await runnable(file)
      return file
    } catch {
      // not in this folder, or not a program this process may run
    }
  }
  return null
}

/** Throws unless `file` is a regular file this process may run (the execute bit on POSIX; on Windows X_OK only
 *  checks that it exists, so the regular-file check is what keeps a folder named `gh.exe` out). */
export async function assertRunnable(
  file: string,
  fs: { stat: (f: string) => Promise<{ isFile: () => boolean }>; access: (f: string, mode: number) => Promise<unknown> },
  xOk: number
): Promise<void> {
  if (!(await fs.stat(file)).isFile()) throw new Error('not a file')
  await fs.access(file, xOk)
}

/** Whether `file` lies inside the folder `root` (compared case-blind with either slash, which can only refuse more). */
function inside(file: string, root: string): boolean {
  const n = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return n(file).startsWith(n(root) + '/')
}

export interface ExecOutcome {
  stdout: string
  error?: unknown
}
export interface RunsDeps {
  /** The agent transcripts of a folder, newest first. */
  listTranscripts: (root: string) => Promise<string[]>
  /** Whether Termpolis may read agent transcripts (the memory setting "learn from conversations"). */
  transcriptsAllowed: () => boolean
  /** Whether "Read CI results with GitHub CLI" is on (it is by default). Nothing runs `gh` or git for CI unless this is true. */
  ciAllowed: () => Promise<boolean>
  /** The full path of `gh` on PATH, or null, found without starting anything (see commandOnPath). No git or `gh`
   *  runs for CI without it, and `gh` is started by exactly this path, never by name. */
  ghOnPath: () => Promise<string | null>
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

  // Where `gh` is, kept as long as a CI answer: PATH rarely changes, and this saves a disk look per call.
  let gh: { at: number; path: string | null } | null = null
  const ghPath = async (): Promise<string | null> => {
    if (gh && d.now() - gh.at < CI_CACHE_MS) return gh.path
    const path = await d.ghOnPath()
    gh = { at: d.now(), path }
    return path
  }

  const lookUp = async (root: string, head: string, ghBin: string): Promise<TestRun[]> => {
    // `gh` reads GitHub only: a repository with no GitHub remote has no run to find.
    const remotes = await git(root, ['remote', '-v'])
    if (remotes === null || !remotes.split('\n').some((line) => GITHUB_REMOTE.test(line.split(/\s+/)[1] ?? ''))) return []
    const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    // A detached HEAD names no branch, so no run can be tied to it.
    if (branch === null || branch === 'HEAD' || !BRANCH.test(branch)) return []
    const listed = await d.exec(
      ghBin,
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
    // No `gh` on PATH: no CI result, quietly, and no git started for it. A `gh` inside the repository itself is
    // never run either, whatever PATH says.
    const ghBin = await ghPath()
    if (ghBin === null || inside(ghBin, root)) return []
    let runs: TestRun[] = []
    try {
      const head = ((await git(root, ['rev-parse', 'HEAD'])) ?? '').toLowerCase()
      if (!FULL_SHA.test(head)) return []
      const hit = ci.get(root)
      // A cached answer holds only while HEAD is the commit it judged.
      if (hit && hit.head === head && d.now() - hit.at < CI_CACHE_MS) return hit.runs
      runs = await lookUp(root, head, ghBin)
      ci.set(root, { at: d.now(), head, runs })
    } catch {
      runs = []
    }
    return runs
  }

  return { transcriptFiles, ciRuns }
}
