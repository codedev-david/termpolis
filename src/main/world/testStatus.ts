/**
 * Lumopolis test status, derived ONLY from results that already exist on disk
 * (vitest/jest JSON, JUnit XML) or from agent transcripts. Nothing here runs
 * tests or launches anything; all I/O comes in through `deps`. Pure: no fs,
 * or path imports, and nothing that launches a process.
 */
import type { BuildStatus } from '../../shared/world/types'

export interface TestRun {
  file: string
  passed: boolean
  at: number
  source: 'vitest' | 'jest' | 'junit' | 'transcript'
}

export interface TestResultDeps {
  readFile(p: string): Promise<string | null>
  glob(root: string, patterns: string[]): Promise<string[]>
  transcriptRuns?: () => Promise<TestRun[]>
}

export const PATTERNS: string[] = [
  '**/vitest-report*.json',
  '**/test-results*.json',
  '**/junit*.xml',
  '**/TEST-*.xml',
  '!**/node_modules/**'
]

const MAX_CHARS = 16 * 1024 * 1024
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/

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

function parseJunit(text: string, root: string): TestRun[] {
  const stack: Suite[] = []
  const files = new Map<string, { failed: boolean; passed: boolean; at: number }>()
  let current: { file?: string; at: number; state: CaseState } | null = null

  const finish = (): void => {
    if (current?.file !== undefined && current.state !== 'skip') {
      const key = relativize(current.file, root)
      const f = files.get(key) ?? { failed: false, passed: false, at: 0 }
      if (current.state === 'fail') f.failed = true
      else f.passed = true
      f.at = Math.max(f.at, current.at)
      files.set(key, f)
    }
    current = null
  }

  const tags = /<(\/?)(testsuite|testcase|failure|error|skipped)\b([^>]*)>/g
  for (const m of text.matchAll(tags)) {
    const closing = m[1] === '/'
    const name = m[2]
    const a = m[3]
    const selfClosing = a.endsWith('/')
    if (name === 'testsuite') {
      if (closing) {
        stack.pop()
      } else if (!selfClosing) {
        const at = attrs(a)
        const looksLikePath = at.name !== undefined && /[/.]/.test(at.name)
        const ts = Date.parse(at.timestamp ?? '')
        stack.push({
          file: at.file ?? (looksLikePath ? at.name : undefined),
          at: Number.isNaN(ts) ? 0 : ts
        })
      }
    } else if (name === 'testcase') {
      if (closing) {
        finish()
      } else {
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
  return [...files].map(([file, f]) => ({ file, passed: !f.failed, at: f.at, source: 'junit' as const }))
}

// ---- transcripts ----------------------------------------------------------

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

const LINE_RULES: Array<[RegExp, boolean]> = [
  [/^\s*[✓✔]\s+(\S+)\s+\(\d+ tests?/, true],
  [/^\s*❯\s+(\S+)\s+\(.*\d+ failed/, false],
  [/^\s*[×✗]\s+(\S+)/, false],
  [/^\s*PASS\s+(\S+)/, true],
  [/^\s*FAIL\s+(\S+)/, false]
]

function scanText(text: string, at: number, root: string, out: TestRun[]): void {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(ANSI, '')
    for (const [re, passed] of LINE_RULES) {
      const m = re.exec(line)
      if (m) {
        if (TEST_FILE.test(m[1])) out.push({ file: relativize(m[1], root), passed, at, source: 'transcript' })
        break
      }
    }
  }
}

function walk(v: unknown, at: number, root: string, out: TestRun[]): void {
  if (typeof v === 'string') {
    scanText(v, at, root, out)
  } else if (Array.isArray(v)) {
    for (const x of v) walk(x, at, root, out)
  } else if (v !== null && typeof v === 'object') {
    for (const x of Object.values(v)) walk(x, at, root, out)
  }
}

export function parseTranscriptTestRuns(jsonl: string, root: string): TestRun[] {
  const out: TestRun[] = []
  for (const line of jsonl.split('\n')) {
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const stamp = (obj as { timestamp?: unknown } | null)?.timestamp
    const parsed = typeof stamp === 'string' ? Date.parse(stamp) : NaN
    walk(obj, Number.isNaN(parsed) ? 0 : parsed, root, out)
  }
  return out
}

// ---- reading --------------------------------------------------------------

export async function readTestResults(root: string, deps: TestResultDeps): Promise<TestRun[]> {
  const paths = (await deps.glob(root, PATTERNS)).filter((p) => !slashes(p).split('/').includes('node_modules'))
  const runs: TestRun[] = []
  for (const p of paths) {
    try {
      const text = await deps.readFile(p)
      if (text === null || text.length > MAX_CHARS) continue
      const base = baseName(slashes(p))
      if (/^vitest-report.*\.json$/.test(base)) runs.push(...parseJsonReport(text, root, 'vitest'))
      else if (/^test-results.*\.json$/.test(base)) runs.push(...parseJsonReport(text, root, 'jest'))
      else if (base.endsWith('.xml')) runs.push(...parseJunit(text, root))
    } catch {
      // unreadable or malformed: skipped silently
    }
  }
  const extra = await (deps.transcriptRuns?.() ?? Promise.resolve([] as TestRun[])).catch(() => [] as TestRun[])
  return [...runs, ...extra]
}

// ---- status ---------------------------------------------------------------

export function statusFor(
  members: string[],
  runs: TestRun[],
  testsByMember: Record<string, string[]>
): BuildStatus {
  const linked = new Set<string>()
  for (const m of members) for (const t of testsByMember[m] ?? []) linked.add(t)
  const latest = new Map<string, TestRun>()
  for (const r of runs) {
    if (!linked.has(r.file)) continue
    const cur = latest.get(r.file)
    if (!cur || r.at > cur.at || (r.at === cur.at && !r.passed)) latest.set(r.file, r)
  }
  if (latest.size === 0) return 'gap'
  for (const r of latest.values()) if (!r.passed) return 'built'
  return 'verified'
}
