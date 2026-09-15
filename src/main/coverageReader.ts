// Reads a repository's OWN test-coverage artifact, so the diff view can say how much
// of a changed hunk is actually covered by tests.
//
// lcov is the one format worth parsing: jest, vitest, nyc, c8, pytest-cov, karma and
// (via gcov2lcov) go all emit it, so a single parser covers most repos without
// Termpolis needing to know which test runner a project uses. Nothing here runs the
// tests — it reads what the project's own last run left behind, or reports nothing.
//
// Pure functions plus a couple of fs reads, deliberately kept out of index.ts for the
// same reason gitChanges.ts is: it stays testable with no Electron and no spawning.

import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Where coverage artifacts actually land, in the order worth trying.
 *
 * Ordered by how strongly each implies "this is the current run": a bare
 * `coverage/lcov.info` is the default for jest/vitest/nyc, while the deeper paths are
 * what a project produces once it has configured a reporter directory.
 */
export const LCOV_CANDIDATES = [
  'coverage/lcov.info',
  'coverage/lcov-report/lcov.info',
  'coverage/lcov/lcov.info',
  '.coverage/lcov.info',
  'lcov.info',
  'build/coverage/lcov.info',
  'target/coverage/lcov.info',
]

/** lcov files above this are not worth blocking the main process to parse. */
export const MAX_LCOV_BYTES = 32 * 1024 * 1024

export interface FileCoverage {
  /** Absolute path of the artifact the numbers came from. */
  source: string
  /** Executable line number → hit count, for the requested file only. */
  lines: Record<number, number>
  /**
   * True when the source file has been modified since the artifact was written, so
   * the numbers describe code that no longer exists. The UI shows a dash, not a digit:
   * a stale coverage percentage is worse than none, because it looks authoritative.
   */
  stale: boolean
}

/** Normalize a path for comparison: forward slashes, no `./` prefix, no drive case. */
export function normalizeForMatch(p: string): string {
  let s = p.replace(/\\/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  // Windows drive letters vary in case between tools; nothing else is case-folded,
  // because on Linux `Foo.ts` and `foo.ts` are genuinely different files.
  if (/^[a-zA-Z]:\//.test(s)) s = s[0].toLowerCase() + s.slice(1)
  return s
}

/**
 * Does an lcov `SF:` path refer to the repo-relative file we asked about?
 *
 * lcov writers disagree about what goes in SF: an absolute path, a repo-relative one,
 * or one relative to some intermediate directory. Matching on the SUFFIX covers all
 * three. The boundary check requires the character before the match to be a separator,
 * so `src/a.ts` does not match `foosrc/a.ts` — a path that merely ends in the same
 * characters without ending in the same PATH.
 *
 * It does NOT disambiguate a genuinely nested copy: `vendor/other/src/a.ts` ends with
 * `/src/a.ts` and so does match. That is inherent to suffix matching and is the right
 * trade — the alternative is knowing every writer's base directory, which we don't.
 * The consequence is bounded: a wrong percentage on a vendored duplicate of a path,
 * never a wrong revert or a wrong diff.
 */
export function sfMatches(sf: string, target: string): boolean {
  const a = normalizeForMatch(sf)
  const b = normalizeForMatch(target)
  if (a === b) return true
  if (!a.endsWith(b)) return false
  return a[a.length - b.length - 1] === '/'
}

/**
 * Pull one file's `DA:` records out of an lcov document.
 *
 * Scans for the matching `SF:` record rather than parsing the whole document into a
 * map: a monorepo's lcov can list thousands of files, and the diff view asks about
 * exactly one. Returns null when the file has no record at all, which is a different
 * answer from "recorded with zero hits" and must stay distinguishable.
 */
export function parseLcovForFile(text: string, target: string): Record<number, number> | null {
  const lines = text.split('\n')
  let inMatch = false
  let found: Record<number, number> | null = null
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('SF:')) {
      inMatch = sfMatches(line.slice(3), target)
      if (inMatch && !found) found = {}
      continue
    }
    if (line === 'end_of_record') {
      // Keep scanning: a file can legitimately appear in more than one record (two
      // test projects covering the same source), and the hits must be summed rather
      // than the first record winning.
      inMatch = false
      continue
    }
    if (!inMatch || !found) continue
    if (!line.startsWith('DA:')) continue
    const comma = line.indexOf(',', 3)
    if (comma < 0) continue
    const lineNo = parseInt(line.slice(3, comma), 10)
    if (!Number.isFinite(lineNo)) continue
    // A DA hit count can carry a third field (a checksum); parseInt stops at the comma.
    const hits = parseInt(line.slice(comma + 1), 10)
    if (!Number.isFinite(hits)) continue
    found[lineNo] = (found[lineNo] ?? 0) + hits
  }
  return found
}

/** First existing lcov candidate under `root`, or null. */
export function findLcov(root: string, exists: (p: string) => boolean = existsSync): string | null {
  for (const rel of LCOV_CANDIDATES) {
    const p = join(root, rel)
    if (exists(p)) return p
  }
  return null
}

/**
 * Coverage for one repo-relative file, or null when this repo has none.
 *
 * Null is the overwhelmingly common answer — most repositories have never produced an
 * lcov file — and it is not an error state. The caller shows nothing at all, rather
 * than a zero.
 */
export function readFileCoverage(root: string, file: string): FileCoverage | null {
  const lcovPath = findLcov(root)
  if (!lcovPath) return null
  let artifactMtime: number
  let size: number
  try {
    const st = statSync(lcovPath)
    artifactMtime = st.mtimeMs
    size = st.size
  } catch {
    return null
  }
  if (size > MAX_LCOV_BYTES) return null
  let text: string
  try {
    text = readFileSync(lcovPath, 'utf8')
  } catch {
    return null
  }
  const lines = parseLcovForFile(text, file)
  if (!lines) return null
  let stale = false
  try {
    stale = statSync(join(root, file)).mtimeMs > artifactMtime
  } catch {
    // The file is gone (a delete), so nothing can be shown against it anyway.
    stale = true
  }
  return { source: lcovPath, lines, stale }
}

/**
 * The verdict for one file (or one hunk of it), condensed from the line-hit map.
 *
 * `percent` is null rather than 0 when the range holds no executable lines: a hunk that
 * changed only comments or braces is not 0% covered, it is not a question. Reporting 0
 * there reads as a failure to fix, and there is nothing to fix.
 */
export interface CoverageSummary {
  covered: number
  total: number
  percent: number | null
  /** Executable lines recorded with zero hits, ascending — the actionable part. */
  uncovered: number[]
  stale: boolean
  source: string
}

/**
 * Condense a FileCoverage into something an agent can act on.
 *
 * The raw `lines` map is the right shape for painting a gutter and the wrong shape for
 * answering "is my change tested": a 500-line file is a 500-entry object the caller must
 * scan before it learns anything. This answers directly, and answers in NUMBERS plus a
 * short list — which is what survives tool-output compaction intact, where a large map
 * would be top-K'd into uselessness.
 *
 * startLine/endLine narrow it to a single hunk, so the question can be "is the code I just
 * changed tested" rather than the much weaker "is this file tested".
 */
export function summarizeCoverage(
  cov: FileCoverage,
  startLine?: number,
  endLine?: number,
): CoverageSummary {
  const inRange = (n: number): boolean =>
    (startLine === undefined || n >= startLine) && (endLine === undefined || n <= endLine)
  const nums = Object.keys(cov.lines).map(Number).filter((n) => Number.isFinite(n) && inRange(n))
  const uncovered = nums.filter((n) => cov.lines[n] === 0).sort((a, b) => a - b)
  const total = nums.length
  const covered = total - uncovered.length
  return {
    covered,
    total,
    percent: total === 0 ? null : Math.round((covered / total) * 1000) / 10,
    uncovered,
    stale: cov.stale,
    source: cov.source,
  }
}
