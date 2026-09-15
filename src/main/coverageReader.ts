// Reads a repository's OWN test-coverage artifact, so the diff view can say how much
// of a changed hunk is actually covered by tests.
//
// It parses FIVE formats, because parsing one was the thing standing between this feature
// and most of the world's code. lcov is the JS/TS default and Rust, C and C++ can all be
// made to emit it — but .NET defaults to Cobertura, Java and Kotlin to JaCoCo, Go to its
// own coverprofile text, and PHP to Clover. A repo in any of those languages had run its
// tests with coverage on and still been told "no coverage artifact found".
//
// Nothing here runs the tests — it reads what the project's own last run left behind, or
// reports nothing. Pure functions plus a couple of fs reads, deliberately kept out of
// index.ts for the same reason gitChanges.ts is: it stays testable with no Electron and
// no spawning.

import { existsSync, readFileSync, statSync, readdirSync } from 'fs'
import { join } from 'path'

/** The coverage formats worth parsing, which between them cover every popular language. */
export type CoverageFormat = 'lcov' | 'cobertura' | 'jacoco' | 'clover' | 'gocover'

/**
 * Where coverage artifacts actually land, in the order worth trying.
 *
 * Grouped by ecosystem rather than by format, because that is how they appear in the wild.
 * Ordered so that the formats carrying per-line hit counts for a whole repo come before the
 * ones that are more often partial.
 *
 * The non-JS entries are the point of this list. Each toolchain names its output something
 * different, and matching only `lcov.info` is why a correctly instrumented .NET, Go, Java
 * or PHP repo would otherwise report no coverage at all:
 *
 *  - coverlet (.NET) writes `coverage.cobertura.xml` BY DEFAULT, and `coverage.info` only
 *    when asked for lcov. The default is the case that matters.
 *  - coverage.py writes `coverage.lcov` for `coverage lcov`, `coverage.xml` for `coverage xml`.
 *  - `go test -coverprofile` writes Go's own text format, conventionally `coverage.out`.
 *  - JaCoCo writes `jacoco.xml` under target/ (Maven) or build/reports/ (Gradle).
 *  - PHPUnit writes Clover to `clover.xml`.
 *
 * Rust needs nothing of its own: cargo-llvm-cov has no default output path — it prints to
 * stdout unless given --output-path — and its documented invocation writes lcov.info at the
 * root, which the first group already covers.
 */
export const COVERAGE_CANDIDATES = [
  // lcov: JS/TS by default, and Rust/C/C++ when pointed at a file.
  'coverage/lcov.info',
  'coverage/lcov-report/lcov.info',
  'coverage/lcov/lcov.info',
  '.coverage/lcov.info',
  'lcov.info',
  'build/coverage/lcov.info',
  'target/coverage/lcov.info',
  // lcov under the names .NET and Python give it.
  'coverage.info',
  'coverage/coverage.info',
  'TestResults/coverage.info',
  'coverage.lcov',
  // Cobertura: coverlet's DEFAULT, and `coverage xml` for Python.
  'coverage.cobertura.xml',
  'coverage/coverage.cobertura.xml',
  'TestResults/coverage.cobertura.xml',
  'coverage.xml',
  'coverage/coverage.xml',
  'coverage/cobertura-coverage.xml',
  // Go coverprofile.
  'coverage.out',
  'cover.out',
  'profile.cov',
  // JaCoCo: Maven layout, then Gradle.
  'target/site/jacoco/jacoco.xml',
  'build/reports/jacoco/test/jacocoTestReport.xml',
  // Clover: PHPUnit.
  'clover.xml',
  'build/logs/clover.xml',
]

/** Artifacts above this are not worth blocking the main process to parse. */
export const MAX_COVERAGE_BYTES = 32 * 1024 * 1024

export interface FileCoverage {
  /** Absolute path of the artifact the numbers came from. */
  source: string
  /** Which format that artifact turned out to be, decided by content and not by name. */
  format: CoverageFormat
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
 * Does a path recorded in an artifact refer to the repo-relative file we asked about?
 *
 * Coverage writers disagree about what they record: an absolute path, a repo-relative one,
 * one relative to some intermediate directory, or — in Go's case — a full module import
 * path. Matching on the SUFFIX covers all of them. The boundary check requires the
 * character before the match to be a separator, so `src/a.ts` does not match `foosrc/a.ts`
 * — a path that merely ends in the same characters without ending in the same PATH.
 *
 * The match runs in BOTH directions, because the recorded path can be either longer or
 * shorter than the repo-relative one:
 *
 *  - LONGER is the absolute-path case — lcov's `/home/me/repo/src/a.ts` for `src/a.ts`.
 *  - SHORTER is the source-root-relative case, and it is why Java works at all. JaCoCo
 *    records `com/example/A.java`, relative to the source root, while the diff view asks
 *    about `src/main/java/com/example/A.java`. Checking only the longer direction reports
 *    "no coverage" for every correctly instrumented Maven and Gradle project.
 *
 * The shorter direction additionally requires a separator in the recorded path, so a bare
 * basename never matches. `A.java` on its own would otherwise claim every A.java in the
 * repository — the one case where suffix matching stops being merely imprecise.
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
  if (a.endsWith(b)) return a[a.length - b.length - 1] === '/'
  if (b.endsWith(a) && a.includes('/')) return b[b.length - a.length - 1] === '/'
  return false
}

/**
 * Decide the format from the artifact's CONTENT, never from its filename.
 *
 * Filenames are ambiguous in exactly the cases that matter: `coverage.info` is lcov from
 * coverlet, `coverage.xml` is Cobertura from coverage.py but could be Clover from another
 * tool, and any of them can be renamed by a CI script. Every one of these formats has an
 * unmistakable signature in its first few hundred bytes, so reading those is both cheaper
 * and more reliable than maintaining a filename-to-format table.
 *
 * Cobertura and Clover both use a `<coverage>` root element and are told apart by their
 * attributes: Cobertura carries `line-rate`, Clover carries `generated` plus a `<project>`.
 */
export function sniffFormat(text: string): CoverageFormat | null {
  const head = text.slice(0, 8192)
  // Go first: a bare `mode:` line is unambiguous and cheap to test for.
  if (/^mode:\s*(set|count|atomic)\s*$/m.test(head)) return 'gocover'
  if (/^(SF:|TN:)/m.test(head)) return 'lcov'
  // JaCoCo's root element is <report>, which neither of the others uses. The DOCTYPE names
  // JaCoCo outright, but some pipelines strip it, so the child elements stand in — without
  // that fallback a perfectly good Java report would sniff as null and read as "no coverage".
  if (/<\s*report\b/.test(head) && (/jacoco/i.test(head) || /<\s*(counter|sourcefile)\b/.test(head))) {
    return 'jacoco'
  }
  // Cobertura and Clover share a <coverage> root and are told apart by attributes only.
  if (/<!DOCTYPE\s+coverage/i.test(head)) return 'cobertura'
  if (/<\s*coverage\b[^>]*\bline-rate\s*=/.test(head)) return 'cobertura'
  if (/<\s*coverage\b[^>]*\bclover\s*=/.test(head)) return 'clover'
  if (/<\s*coverage\b[^>]*\bgenerated\s*=/.test(head) && /<\s*project\b/.test(head)) return 'clover'
  return null
}

/** Pull the attributes out of one XML start-tag's body. */
function attrs(tagBody: string): Record<string, string> {
  const out: Record<string, string> = {}
  // Built per call rather than hoisted: a module-level /g regex carries lastIndex between
  // calls, which silently drops attributes on the second document parsed.
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tagBody))) out[m[1]] = m[2]
  return out
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

/**
 * Pull one file's lines out of a Cobertura document — coverlet's default, so this is the
 * parser that makes .NET and C# work.
 *
 * Takes the MAX hit count per line rather than the sum, which is the opposite of lcov and
 * deliberately so. Cobertura nests a copy of each method's `<line>` elements inside
 * `<methods>` AND lists them again in the class's own `<lines>`, so every covered line is
 * reported at least twice. Summing would roughly double every hit count in the file —
 * still a plausible-looking number, which is the worst kind of wrong.
 */
export function parseCoberturaForFile(text: string, target: string): Record<number, number> | null {
  const tag = /<\s*(class|line)\b([^>]*)>/g
  let found: Record<number, number> | null = null
  let inMatch = false
  let m: RegExpExecArray | null
  while ((m = tag.exec(text))) {
    if (m[1] === 'class') {
      const filename = attrs(m[2]).filename
      inMatch = filename ? sfMatches(filename, target) : false
      if (inMatch && !found) found = {}
      continue
    }
    if (!inMatch || !found) continue
    const a = attrs(m[2])
    const lineNo = parseInt(a.number, 10)
    const hits = parseInt(a.hits, 10)
    if (!Number.isFinite(lineNo) || !Number.isFinite(hits)) continue
    found[lineNo] = Math.max(found[lineNo] ?? 0, hits)
  }
  return found
}

/**
 * Pull one file's lines out of a JaCoCo report — Java, Kotlin and Android.
 *
 * JaCoCo splits the path in two: `<package name="com/example">` holds the directory and
 * `<sourcefile name="Foo.java">` the basename, so neither alone can be matched against a
 * repo-relative path. `ci` is covered INSTRUCTIONS, not executions — a positive value means
 * the line ran, which is all the gutter needs, and zero means it did not.
 */
export function parseJacocoForFile(text: string, target: string): Record<number, number> | null {
  const tag = /<\s*(package|sourcefile|line)\b([^>]*)>/g
  let pkg = ''
  let inMatch = false
  let found: Record<number, number> | null = null
  let m: RegExpExecArray | null
  while ((m = tag.exec(text))) {
    const a = attrs(m[2])
    if (m[1] === 'package') {
      pkg = a.name ?? ''
      inMatch = false
      continue
    }
    if (m[1] === 'sourcefile') {
      inMatch = a.name ? sfMatches(pkg ? `${pkg}/${a.name}` : a.name, target) : false
      if (inMatch && !found) found = {}
      continue
    }
    if (!inMatch || !found) continue
    const lineNo = parseInt(a.nr, 10)
    if (!Number.isFinite(lineNo)) continue
    const ci = parseInt(a.ci ?? '0', 10)
    found[lineNo] = Math.max(found[lineNo] ?? 0, Number.isFinite(ci) ? ci : 0)
  }
  return found
}

/**
 * Pull one file's lines out of a Clover report — PHPUnit's format.
 *
 * Clover records the path on the `<file>` element, as `path` (absolute) when the writer
 * supplies one and `name` otherwise; older PHPUnit versions put the absolute path in
 * `name`, so both are tried. Statement, condition and method lines all carry `count`, and
 * all three are worth showing — a `cond` line that never ran is exactly what the gutter
 * exists to point at.
 */
export function parseCloverForFile(text: string, target: string): Record<number, number> | null {
  const tag = /<\s*(file|line)\b([^>]*)>/g
  let inMatch = false
  let found: Record<number, number> | null = null
  let m: RegExpExecArray | null
  while ((m = tag.exec(text))) {
    const a = attrs(m[2])
    if (m[1] === 'file') {
      const path = a.path || a.name
      inMatch = path ? sfMatches(path, target) : false
      if (inMatch && !found) found = {}
      continue
    }
    if (!inMatch || !found) continue
    const lineNo = parseInt(a.num, 10)
    const count = parseInt(a.count, 10)
    if (!Number.isFinite(lineNo) || !Number.isFinite(count)) continue
    found[lineNo] = Math.max(found[lineNo] ?? 0, count)
  }
  return found
}

/** A Go coverprofile block spanning more lines than this is taken as corrupt, not expanded. */
const MAX_GO_BLOCK_LINES = 10_000

/**
 * Pull one file's lines out of a Go coverprofile — what `go test -coverprofile` writes.
 *
 * Go is the one format here that does NOT record per-line hits. Each row is a BLOCK:
 * `import/path/file.go:12.34,15.2 3 1` — start line.column, end line.column, statement
 * count, execution count. Every line in the block gets the block's count, so the resulting
 * percentage is block-based where lcov's is line-based. That is a real difference in
 * meaning, and it is the honest translation: Go genuinely does not know which individual
 * lines ran.
 *
 * The file field is a module import path (`github.com/you/proj/pkg/file.go`), which suffix
 * matching handles without needing to know the module name.
 */
export function parseGoCoverForFile(text: string, target: string): Record<number, number> | null {
  const row = /^(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$/
  let found: Record<number, number> | null = null
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line || line.startsWith('mode:')) continue
    const m = row.exec(line)
    if (!m) continue
    if (!sfMatches(m[1], target)) continue
    if (!found) found = {}
    const start = parseInt(m[2], 10)
    const end = parseInt(m[3], 10)
    const count = parseInt(m[4], 10)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
    if (end - start > MAX_GO_BLOCK_LINES) continue
    for (let n = start; n <= end; n++) {
      // Blocks overlap on the lines that open and close them, so MAX rather than sum:
      // a line shared by a covered and an uncovered block did run.
      found[n] = Math.max(found[n] ?? 0, count)
    }
  }
  return found
}

/** Dispatch to whichever parser matches the sniffed format. */
export function parseCoverageForFile(
  text: string,
  target: string,
  format: CoverageFormat,
): Record<number, number> | null {
  switch (format) {
    case 'lcov': return parseLcovForFile(text, target)
    case 'cobertura': return parseCoberturaForFile(text, target)
    case 'jacoco': return parseJacocoForFile(text, target)
    case 'clover': return parseCloverForFile(text, target)
    case 'gocover': return parseGoCoverForFile(text, target)
  }
}

/**
 * Directory listing that answers "nothing here" rather than throwing.
 *
 * Every call site below is speculative — it asks about a directory most repositories do
 * not have — so ENOENT is the expected answer, not an exceptional one. ENOTDIR matters
 * too: a plain file named TestResults is listed like a directory and must read as empty.
 */
function safeReadDir(p: string): string[] {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}

/** What coverlet's VSTest collector may leave in its per-run directory, either format. */
const COLLECTOR_FILENAMES = ['coverage.info', 'coverage.cobertura.xml']

/**
 * First existing coverage artifact under `root`, or null.
 *
 * The fixed candidates come first: cheap, ordered, and enough for every toolchain that
 * writes to a predictable path. Two do not, and cannot be expressed as fixed strings at
 * all, because each embeds a segment that varies per run or per project:
 *
 *  - coverlet's VSTest collector writes TestResults/<guid>/coverage.cobertura.xml, the guid
 *    being generated fresh on every `dotnet test`.
 *  - simplecov-lcov's single-file mode writes coverage/lcov/<project-name>.lcov.
 *
 * Those two get a bounded scan, one directory deep, and only once every fixed candidate
 * has missed — so a repo that has a normal artifact still costs exactly the stat calls
 * it cost before, and a repo with no coverage costs a handful of failed readdirs.
 */
export function findCoverageArtifact(
  root: string,
  exists: (p: string) => boolean = existsSync,
  readDir: (p: string) => string[] = safeReadDir,
): string | null {
  for (const rel of COVERAGE_CANDIDATES) {
    const p = join(root, rel)
    if (exists(p)) return p
  }

  // Listing the guid directory is itself what establishes the file is there; probing with
  // `exists` afterwards would be a second syscall for an answer readdir already gave.
  const testResults = join(root, 'TestResults')
  for (const entry of readDir(testResults)) {
    const dir = join(testResults, entry)
    const names = readDir(dir)
    const hit = COLLECTOR_FILENAMES.find((n) => names.includes(n))
    if (hit) return join(dir, hit)
  }

  // simplecov-lcov's DEFAULT mode writes one .lcov per SOURCE FILE, named after the path
  // it came from. Returning any one of those would report a single file's coverage as if
  // it were the whole repository's — badly wrong, and wrong in the direction that looks
  // plausible. Exactly one match means single-file mode, which is a real tracefile; more
  // than one means fragments, and the honest answer there is that we found nothing.
  const lcovDir = join(root, 'coverage', 'lcov')
  const tracefiles = readDir(lcovDir).filter((f) => f.endsWith('.lcov'))
  if (tracefiles.length === 1) return join(lcovDir, tracefiles[0])

  return null
}

/**
 * Coverage for one repo-relative file, or null when this repo has none.
 *
 * Null is the overwhelmingly common answer — most repositories have never produced a
 * coverage artifact — and it is not an error state. The caller shows nothing at all,
 * rather than a zero.
 */
export function readFileCoverage(root: string, file: string): FileCoverage | null {
  const artifactPath = findCoverageArtifact(root)
  if (!artifactPath) return null
  let artifactMtime: number
  let size: number
  try {
    const st = statSync(artifactPath)
    artifactMtime = st.mtimeMs
    size = st.size
  } catch {
    return null
  }
  if (size > MAX_COVERAGE_BYTES) return null
  let text: string
  try {
    text = readFileSync(artifactPath, 'utf8')
  } catch {
    return null
  }
  // An artifact we cannot identify is the same answer as no artifact: show nothing.
  // Guessing a parser here would produce numbers from a document we do not understand.
  const format = sniffFormat(text)
  if (!format) return null
  const lines = parseCoverageForFile(text, file, format)
  if (!lines) return null
  let stale = false
  try {
    stale = statSync(join(root, file)).mtimeMs > artifactMtime
  } catch {
    // The file is gone (a delete), so nothing can be shown against it anyway.
    stale = true
  }
  return { source: artifactPath, format, lines, stale }
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
