// Lumopolis test runs that come from main: what the agents' transcripts say they ran, and the newest CI
// conclusion. The compiler (in the utility process) asks main for both, because main knows where the
// transcripts are and owns the settings. Nothing here touches the main thread's disk or process table:
// reads are async and capped, and the two commands go through the off-thread exec helper. Dependencies
// are injected so the logic is tested without a disk, a git repository or the GitHub command line.

import { open } from 'fs/promises'
import type { TestRun } from './testStatus'
import { parseTranscriptTestRuns } from './testStatus'

/** Transcript files read per project: the newest ones. */
export const MAX_TRANSCRIPTS = 20
/** The last bytes of a transcript that are read (a transcript can run to hundreds of MB; its newest part is what matters). */
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
/** How long one root's transcript runs are reused (a watcher recompile can come every few seconds). */
export const TRANSCRIPT_CACHE_MS = 20_000
/** How long one root's CI result is kept. */
export const CI_CACHE_MS = 10 * 60_000
/** How long `gh` may take. */
export const GH_TIMEOUT_MS = 5000
const GIT_TIMEOUT_MS = 5000
const MAX_CI_FILES = 2000

export interface ExecOutcome {
  stdout: string
  error?: unknown
}
export interface RunsDeps {
  /** The agent transcripts of a folder, newest first. */
  listTranscripts: (root: string) => Promise<string[]>
  /** The last `maxBytes` of a file as text; null when unreadable. */
  readTail: (path: string, maxBytes: number) => Promise<string | null>
  /** Whether Termpolis may read agent transcripts (the memory setting "learn from conversations"). */
  transcriptsAllowed: () => boolean
  /** Whether the person turned on "Read CI results with GitHub CLI". Nothing runs `gh` unless this is true. */
  ciAllowed: () => Promise<boolean>
  /** Runs a command off the main thread, never throwing. */
  exec: (bin: string, args: string[], opts: { cwd: string; timeout: number }) => Promise<ExecOutcome>
  now: () => number
}

export interface WorldRuns {
  transcriptRuns: (root: string) => Promise<TestRun[]>
  ciRuns: (root: string) => Promise<TestRun[]>
}

interface Cached {
  at: number
  runs: TestRun[]
}

/** The last `maxBytes` of a file as text, read asynchronously; null when it cannot be read. A cut can start mid-line: the parser skips a line that does not parse. */
export async function tailOfFile(path: string, maxBytes: number): Promise<string | null> {
  let handle
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, size - length)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export function createWorldRuns(d: RunsDeps): WorldRuns {
  const transcripts = new Map<string, Cached>()
  const ci = new Map<string, Cached>()
  const fresh = (m: Map<string, Cached>, root: string, ttl: number): TestRun[] | null => {
    const hit = m.get(root)
    return hit && d.now() - hit.at < ttl ? hit.runs : null
  }

  const transcriptRuns = async (root: string): Promise<TestRun[]> => {
    if (!d.transcriptsAllowed()) return []
    const hit = fresh(transcripts, root, TRANSCRIPT_CACHE_MS)
    if (hit) return hit
    const runs: TestRun[] = []
    try {
      for (const file of (await d.listTranscripts(root)).slice(0, MAX_TRANSCRIPTS)) {
        const text = await d.readTail(file, MAX_TRANSCRIPT_BYTES)
        if (text !== null) runs.push(...parseTranscriptTestRuns(text, root))
      }
    } catch {
      // unreadable: the runs found so far stand
    }
    transcripts.set(root, { at: d.now(), runs })
    return runs
  }

  const lookUp = async (root: string): Promise<TestRun[]> => {
    const listed = await d.exec('gh', ['run', 'list', '--limit', '1', '--json', 'conclusion,headSha,createdAt,databaseId'], { cwd: root, timeout: GH_TIMEOUT_MS })
    if (listed.error) return []
    const first = (JSON.parse(listed.stdout) as unknown[])[0] as { conclusion?: unknown; headSha?: unknown; createdAt?: unknown } | undefined
    const conclusion = first?.conclusion
    if (conclusion !== 'success' && conclusion !== 'failure') return []
    const sha = first?.headSha
    if (typeof sha !== 'string' || !/^[0-9a-f]{7,64}$/.test(sha)) return []
    const changed = await d.exec('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha], { cwd: root, timeout: GIT_TIMEOUT_MS })
    if (changed.error) return []
    const parsed = typeof first?.createdAt === 'string' ? Date.parse(first.createdAt) : NaN
    const at = Number.isNaN(parsed) ? d.now() : parsed
    return changed.stdout
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f !== '')
      .slice(0, MAX_CI_FILES)
      .map((file) => ({ file, passed: conclusion === 'success', at, source: 'ci' as const }))
  }

  const ciRuns = async (root: string): Promise<TestRun[]> => {
    // The consent first: `gh` reads its own stored login, so without the setting it is never started.
    if (!(await d.ciAllowed())) return []
    const hit = fresh(ci, root, CI_CACHE_MS)
    if (hit) return hit
    let runs: TestRun[]
    try {
      runs = await lookUp(root)
    } catch {
      runs = []
    }
    ci.set(root, { at: d.now(), runs })
    return runs
  }

  return { transcriptRuns, ciRuns }
}
