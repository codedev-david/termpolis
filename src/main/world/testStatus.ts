/**
 * Lumopolis test status, derived ONLY from results that already exist on disk
 * (vitest/jest JSON, JUnit XML) or from agent transcripts. Nothing here runs
 * tests or launches anything; all I/O comes in through `deps`. Pure: no fs,
 * or path imports, and nothing that launches a process.
 */
import type { BuildStatus, Claim } from '../../shared/world/types'

export interface TestRun {
  file: string
  passed: boolean
  at: number
  source: 'vitest' | 'jest' | 'junit' | 'transcript' | 'ci'
}

export interface TestResultDeps {
  readFile(p: string): Promise<string | null>
  /** `signal` aborts when the compile's search window ends (compile.ts SEARCH_TIME_MS): the walk should stop then. */
  glob(root: string, patterns: string[], opts: { signal: AbortSignal }): Promise<string[]>
  /** null: main gave no answer in time (RUNS_WAIT_MS), so the runs are not known, which is not the same as none. */
  transcriptRuns?: () => Promise<TestRun[] | null>
  /** The newest CI conclusion as runs (source 'ci'); null as for transcriptRuns. The caller decides whether CI is read at all. */
  ciRuns?: () => Promise<TestRun[] | null>
}

/** How long a compile waits for main's test runs (CI asks `gh` for up to 5 s, then git). */
export const RUNS_WAIT_MS = 20_000
/** How long past RUNS_WAIT_MS the compile still waits for one of main's answers, so the host's own wait for main
 *  always ends first and says whether main answered (fix round 3, N2). */
export const RUNS_GRACE_MS = 2_000

/** What the test-result sources gave, and whether every one of them gave all it had (a report search cut short by the
 *  compile's window, or an ask main did not answer in time, leaves `complete` false). */
export interface TestSources {
  runs: TestRun[]
  complete: boolean
}

export const PATTERNS: string[] = [
  '**/vitest-report*.json',
  '**/test-results*.json',
  '**/junit*.xml',
  '**/TEST-*.xml',
  '!**/node_modules/**'
]

const MAX_CHARS = 16 * 1024 * 1024
export const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/

// ---- tiny path helpers ----------------------------------------------------

const slashes = (p: string): string => p.replace(/\\/g, '/')

/** Repo-relative, '/'-separated. Paths outside `root` stay normalised absolute. */
function relativize(p: string, root: string): string {
  let s = slashes(p)
  const r = slashes(root).replace(/\/+$/, '')
  const win = /^[A-Za-z]:/.test(r)
  const head = s.slice(0, r.length + 1)
  const prefix = `${r}/`
  if (win ? head.toLowerCase() === prefix.toLowerCase() : head === prefix) {
    s = s.slice(prefix.length)
  }
  return s.startsWith('./') ? s.slice(2) : s
}

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

// ---- JSON (vitest / jest) -------------------------------------------------

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function parseJsonReport(text: string, root: string, source: 'vitest' | 'jest'): TestRun[] {
  const data: unknown = JSON.parse(text)
  const top = (data ?? {}) as { startTime?: unknown; testResults?: unknown }
  if (!Array.isArray(top.testResults)) return []
  const runs: TestRun[] = []
  for (const item of top.testResults as unknown[]) {
    const r = (item ?? {}) as { name?: unknown; status?: unknown; startTime?: unknown; endTime?: unknown }
    if (typeof r.name !== 'string') continue
    runs.push({
      file: relativize(r.name, root),
      passed: r.status === 'passed',
      at: num(r.endTime) ?? num(r.startTime) ?? num(top.startTime) ?? 0,
      source
    })
  }
  return runs
}

// ---- JUnit (regex scanner) ------------------------------------------------

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of raw.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)) {
    out[m[1]] = m[3].replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ENTITIES[e])
  }
  return out
}

interface Suite {
  file?: string
  at: number
}

type CaseState = 'pass' | 'fail' | 'skip'

const TAG_NAME = /\/?(testsuite|testcase|failure|error|skipped)\b/y
const MAX_ATTR_TEXT = 65536 // how much of a tag's attribute text is decoded; scanning itself is unbounded

/** Index of the '>' ending a tag, ignoring any inside quoted values; -1 at end of input (truncation). */
function tagEnd(text: string, from: number): number {
  let quote = 0
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (quote === 0 && (c === 34 || c === 39)) quote = c
    else if (c === quote) quote = 0
    else if (c === 62 && quote === 0) return i
  }
  return -1
}

/** Removes `<![CDATA[...]]>` sections (an unterminated one drops the rest). Linear. */
function stripCdata(text: string): string {
  let out = ''
  let pos = 0
  for (;;) {
    const start = text.indexOf('<![CDATA[', pos)
    if (start < 0) return out + text.slice(pos)
    out += text.slice(pos, start)
    const end = text.indexOf(']]>', start + 9)
    if (end < 0) return out
    pos = end + 3
  }
}

function parseJunit(raw: string, root: string): TestRun[] {
  const text = stripCdata(raw)
  const stack: Suite[] = []
  const files = new Map<string, { failed: boolean; passed: boolean; at: number }>()
  let current: { file?: string; at: number; state: CaseState } | null = null

  const finish = (force?: CaseState): void => {
    const state = force ?? current?.state
    if (current?.file !== undefined && state !== 'skip') {
      const key = relativize(current.file, root)
      const f = files.get(key) ?? { failed: false, passed: false, at: 0 }
      if (state === 'fail') f.failed = true
      else f.passed = true
      f.at = Math.max(f.at, current.at)
      files.set(key, f)
    }
    current = null
  }

  // indexOf scan: each '<' costs O(distance to the next '>'), and a tag consumes that span.
  let pos = 0
  for (;;) {
    const lt = text.indexOf('<', pos)
    if (lt < 0) break
    pos = lt + 1
    TAG_NAME.lastIndex = pos
    const m = TAG_NAME.exec(text)
    if (!m) continue
    const closing = m[0].startsWith('/')
    const name = m[1]
    const from = lt + 1 + m[0].length
    const gt = tagEnd(text, from)
    if (gt < 0) {
      // Truncated input: an unterminated testcase tag still names the file that must not read as passed.
      if (name === 'testcase' && !closing) {
        finish()
        const cut = text.slice(from, from + MAX_ATTR_TEXT)
        const suite = stack[stack.length - 1] as Suite | undefined
        current = { file: attrs(cut).file ?? suite?.file, at: suite?.at ?? 0, state: 'pass' }
      }
      break
    }
    pos = gt + 1
    const a = text.slice(from, Math.min(gt, from + MAX_ATTR_TEXT))
    const selfClosing = text[gt - 1] === '/'
    if (name === 'testsuite') {
      if (closing) {
        stack.pop()
      } else if (!selfClosing) {
        const at = attrs(a)
        const parent = stack[stack.length - 1] as Suite | undefined
        const ts = Date.parse(at.timestamp ?? '')
        stack.push({
          file: at.file ?? (at.name !== undefined && TEST_FILE.test(at.name) ? at.name : parent?.file),
          at: Number.isNaN(ts) ? (parent?.at ?? 0) : ts
        })
      }
    } else if (name === 'testcase') {
      if (closing) {
        finish()
      } else {
        finish() // a testcase opening inside an open one: record the open one as it stands
        const suite = stack[stack.length - 1] as Suite | undefined
        current = { file: attrs(a).file ?? suite?.file, at: suite?.at ?? 0, state: 'pass' }
        if (selfClosing) finish()
      }
    } else if (!closing && current) {
      // failure / error / skipped inside the open testcase; a failure is never downgraded
      if (name === 'skipped') {
        if (current.state === 'pass') current.state = 'skip'
      } else {
        current.state = 'fail'
      }
    }
  }
  // A testcase still open at the end of input: a crashed or cut-off report is not a pass.
  finish('fail')
  return [...files].map(([file, f]) => ({ file, passed: !f.failed, at: f.at, source: 'junit' as const }))
}

// ---- transcripts ----------------------------------------------------------

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

const LINE_RULES: Array<[RegExp, boolean]> = [
  // vitest per-file lines, with the optional "|project|" prefix
  [/^\s*[✓✔]\s+(?:\|[^|]{0,100}\|\s+)?(\S+)\s+\(\d+ tests?/, true],
  [/^\s*❯\s+(?:\|[^|]{0,100}\|\s+)?(\S+)\s+\([^)]{0,200}\d+ failed/, false],
  [/^\s*[×✗]\s+(?:\|[^|]{0,100}\|\s+)?(\S+)/, false],
  [/^\s*PASS\s+(\S+)/, true],
  [/^\s*FAIL\s+(\S+)/, false]
]
const MAX_LINE = 2000
/** A transcript line longer than this is skipped unparsed (the tail read is capped, so a longer one is cut or hostile). */
const MAX_JSON_LINE = 256 * 1024
/** A vitest or jest summary line: the proof that a block of output is a test run's report, not text that mimics one. */
const SUMMARY = /^\s*(?:Test Files\s+\d|Tests\s+\d|Test Suites:\s+\d|Tests:\s+\d)/m
const OUTPUT_KEYS = new Set(['output', 'stdout', 'aggregated_output'])

function scanText(text: string, at: number, root: string, out: TestRun[]): void {
  // Transcript output is whatever a command printed (a cat, a fetch, an echo): only a block that also carries a
  // test runner's summary line counts, so a lone `PASS x.test.ts` someone typed proves nothing.
  if (!SUMMARY.test(text.replace(ANSI, ''))) return
  for (const raw of text.split('\n')) {
    const line = raw.slice(0, MAX_LINE).replace(ANSI, '')
    for (const [re, passed] of LINE_RULES) {
      const m = re.exec(line)
      if (m) {
        if (TEST_FILE.test(m[1])) out.push({ file: relativize(m[1], root), passed, at, source: 'transcript' })
        break
      }
    }
  }
}

/**
 * Only tool output is scanned: strings inside `tool_result` blocks (Claude) and
 * string values of `output`/`stdout`/`aggregated_output` keys (codex/gemini).
 * Assistant text and tool_use input are never read.
 */
function walk(v: unknown, at: number, root: string, out: TestRun[], on: boolean): void {
  if (typeof v === 'string') {
    if (on) scanText(v, at, root, out)
  } else if (Array.isArray(v)) {
    for (const x of v) walk(x, at, root, out, on)
  } else if (v !== null && typeof v === 'object') {
    if ((v as { type?: unknown }).type === 'tool_use') return
    const here = on || (v as { type?: unknown }).type === 'tool_result'
    for (const [k, x] of Object.entries(v)) walk(x, at, root, out, here || (typeof x === 'string' && OUTPUT_KEYS.has(k)))
  }
}

/** `now` caps every timestamp: a transcript that claims the future does not outrank a real run. */
export function parseTranscriptTestRuns(jsonl: string, root: string, now: number): TestRun[] {
  const out: TestRun[] = []
  for (const line of jsonl.split('\n')) {
    if (line.length > MAX_JSON_LINE) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const stamp = (obj as { timestamp?: unknown } | null)?.timestamp
    const parsed = typeof stamp === 'string' ? Date.parse(stamp) : NaN
    walk(obj, Number.isNaN(parsed) ? 0 : Math.min(parsed, now), root, out, false)
  }
  return out
}

// ---- reading --------------------------------------------------------------

/** The reports under `root` into `into`, as each is read; true when the search and every read finished before
 *  `signal` aborted (compile.ts SEARCH_TIME_MS). The glob is handed the same signal, and no report is read after it. */
async function readReports(root: string, deps: TestResultDeps, signal: AbortSignal, into: TestRun[]): Promise<boolean> {
  let found: string[]
  try {
    found = await deps.glob(root, PATTERNS, { signal })
  } catch {
    found = []
  }
  const paths = found.filter((p) => !slashes(p).split('/').includes('node_modules'))
  for (const p of paths) {
    if (signal.aborted) break
    try {
      const text = await deps.readFile(p)
      if (text === null || text.length > MAX_CHARS) continue
      const base = baseName(slashes(p))
      if (/^vitest-report.*\.json$/.test(base)) into.push(...parseJsonReport(text, root, 'vitest'))
      else if (/^test-results.*\.json$/.test(base)) into.push(...parseJsonReport(text, root, 'jest'))
      else if (base.endsWith('.xml')) into.push(...parseJunit(text, root))
    } catch {
      // unreadable or malformed: skipped silently
    }
  }
  return !signal.aborted
}

/** One of main's answers within `ms`: null when none came (or main said it had none in time); a failure is no runs. */
function askWithin(ask: (() => Promise<TestRun[] | null>) | undefined, ms: number): Promise<TestRun[] | null> {
  if (!ask) return Promise.resolve([])
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))
  const answer = Promise.resolve().then(ask).catch((): TestRun[] => [])
  return Promise.race([answer, late]).finally(() => clearTimeout(timer))
}

/**
 * Every source of test results, each on its own clock (fix round 3, N2): the reports on disk until `signal` aborts
 * (what was read by then is kept), and main's transcript and CI runs each for up to `askMs`, asked together so a
 * slow answer costs its own wait, not the sum. A source cut short leaves `complete` false and costs only itself.
 */
export async function readTestSources(
  root: string,
  deps: TestResultDeps,
  signal: AbortSignal = new AbortController().signal,
  askMs: number = RUNS_WAIT_MS + RUNS_GRACE_MS
): Promise<TestSources> {
  const reports: TestRun[] = []
  // A read that never returns stops counting once the window ends: the reports read before it are kept.
  const stopped = signal.aborted
    ? Promise.resolve(false)
    : new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true }))
  const [read, transcript, ci] = await Promise.all([
    Promise.race([readReports(root, deps, signal, reports), stopped]),
    askWithin(deps.transcriptRuns, askMs),
    askWithin(deps.ciRuns, askMs)
  ])
  return { runs: [...reports, ...(transcript ?? []), ...(ci ?? [])], complete: read && transcript !== null && ci !== null }
}

/** The runs readTestSources finds, whether or not every source answered. */
export async function readTestResults(root: string, deps: TestResultDeps, signal?: AbortSignal): Promise<TestRun[]> {
  return (await readTestSources(root, deps, signal)).runs
}

// ---- status ---------------------------------------------------------------

/** Transcripts and CI are weaker evidence than a report on disk: a report as new as them wins. */
const weak = (r: TestRun): boolean => r.source === 'transcript' || r.source === 'ci'

/** True when `r` replaces `cur`: newer wins; a tie goes to a report over a transcript or CI run, then to the failing one. */
function replaces(r: TestRun, cur: TestRun): boolean {
  const rw = weak(r)
  const cw = weak(cur)
  if (rw !== cw) return rw ? r.at > cur.at : r.at >= cur.at
  return r.at > cur.at || (r.at === cur.at && !r.passed)
}

/** The newest run of each test file linked to the members, by file (see `replaces`). */
/** Each runs list indexed by file, once: a compile asks for every building, so a scan of all runs per building
 *  (buildings x runs, twice) would stall the status pass on a big project with many results (fix round 2, R2). */
const byFileOf = new WeakMap<TestRun[], Map<string, TestRun[]>>()
function runsByFile(runs: TestRun[]): Map<string, TestRun[]> {
  const hit = byFileOf.get(runs)
  if (hit) return hit
  const index = new Map<string, TestRun[]>()
  for (const r of runs) {
    const list = index.get(r.file)
    if (list) list.push(r)
    else index.set(r.file, [r])
  }
  byFileOf.set(runs, index)
  return index
}

function latestRuns(members: string[], runs: TestRun[], testsByMember: Record<string, string[]>): Map<string, TestRun> {
  const index = runsByFile(runs)
  const latest = new Map<string, TestRun>()
  for (const m of members) {
    for (const t of testsByMember[m] ?? []) {
      if (latest.has(t)) continue
      // In the runs' own order, as before, so a tie keeps the same winner.
      for (const r of index.get(t) ?? []) {
        const cur = latest.get(t)
        if (!cur || replaces(r, cur)) latest.set(t, r)
      }
    }
  }
  return latest
}

export function statusFor(
  members: string[],
  runs: TestRun[],
  testsByMember: Record<string, string[]>
): BuildStatus {
  const latest = latestRuns(members, runs, testsByMember)
  if (latest.size === 0) return 'gap'
  for (const r of latest.values()) if (!r.passed) return 'built'
  return 'verified'
}

/** Most test files one claim cites. */
const MAX_TEST_REFS = 8

/** Where a run's result came from, as each test evidence says it (a transcript line or CI is weaker than a report). */
export function testSourceExcerpt(source: TestRun['source']): string {
  return source === 'transcript' ? 'from an agent transcript' : source === 'ci' ? 'from CI (gh)' : 'from a test report'
}

/** The claim's suffix when no linked result came from a report on disk: which weaker source(s) it rests on. */
function weakSuffix(list: TestRun[]): string {
  if (list.some((r) => !weak(r))) return ''
  const t = list.some((r) => r.source === 'transcript')
  const c = list.some((r) => r.source === 'ci')
  return t && c ? ' (agent transcript and CI)' : t ? ' (agent transcript)' : ' (CI)'
}

/**
 * What the test results say about a building, as claims: every linked test passing is a verified claim
 * citing them; any failing is an observed claim saying how many, citing the failing ones; no results, none.
 * Each cited test says where its result came from, and a claim resting only on agent transcripts or CI says so in
 * its text, so a card and world_read never pass those off as a test report.
 */
export function testClaims(members: string[], runs: TestRun[], testsByMember: Record<string, string[]>): Claim[] {
  const latest = latestRuns(members, runs, testsByMember)
  if (latest.size === 0) return []
  const refs = (list: TestRun[]): Claim['evidence'] => {
    const source = new Map(list.map((r) => [r.file, r.source]))
    return [...source.keys()].sort().slice(0, MAX_TEST_REFS).map((ref) => ({ kind: 'test' as const, ref, excerpt: testSourceExcerpt(source.get(ref) as TestRun['source']) }))
  }
  const all = [...latest.values()]
  const failed = all.filter((r) => !r.passed)
  if (failed.length === 0) return [{ text: `Its ${all.length} linked tests passed${weakSuffix(all)}`, state: 'verified', evidence: refs(all) }]
  return [{ text: `${failed.length} of ${all.length} linked tests failed${weakSuffix(failed)}`, state: 'observed', evidence: refs(failed) }]
}
