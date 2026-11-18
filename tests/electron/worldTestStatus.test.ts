import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PATTERNS,
  parseTranscriptTestRuns,
  readTestResults,
  statusFor,
  testClaims,
  type TestRun
} from '../../src/main/world/testStatus'

const FIX = new URL('./fixtures/world/', import.meta.url)
const fixture = (n: string): string => readFileSync(new URL(n, FIX), 'utf8')
const SRC = readFileSync(new URL('../../src/main/world/testStatus.ts', import.meta.url), 'utf8')

const ROOT = '/repo'
const byFile = (runs: TestRun[]): Record<string, TestRun> => Object.fromEntries(runs.map((r) => [r.file, r]))

type Deps = Parameters<typeof readTestResults>[1]

function deps(files: Record<string, string | null>, extra: Partial<Deps> = {}): { calls: string[][]; d: Deps } {
  const calls: string[][] = []
  return {
    calls,
    d: {
      readFile: async (p: string) => (p in files ? files[p] : null),
      glob: async (_r: string, pats: string[]) => {
        calls.push(pats)
        return Object.keys(files)
      },
      ...extra
    }
  }
}

describe('readTestResults', () => {
  it('parses vitest reports with normalised paths', async () => {
    const { d, calls } = deps({ '/repo/out/vitest-report.json': fixture('vitest-report.json') })
    const runs = byFile(await readTestResults('C:/repo', d))
    expect(calls).toEqual([PATTERNS])
    expect(PATTERNS).toEqual([
      '**/vitest-report*.json',
      '**/test-results*.json',
      '**/junit*.xml',
      '**/TEST-*.xml',
      '!**/node_modules/**'
    ])
    expect(runs['src/main/a.test.ts']).toEqual({ file: 'src/main/a.test.ts', passed: true, at: 3000, source: 'vitest' })
    expect(runs['src/main/b.test.ts']).toMatchObject({ passed: false, at: 2500 })
    expect(runs['src/main/c.test.ts']).toMatchObject({ passed: true, at: 1000 })
    expect(runs['D:/elsewhere/d.test.ts']).toMatchObject({ passed: true })
    expect(runs['src/main/e.test.ts']).toMatchObject({ passed: false, at: 4000 })
  })

  it('uses jest source for test-results files and at=0 without any time', async () => {
    const body = JSON.stringify({ testResults: [{ name: '/repo/x.test.ts', status: 'passed' }] })
    const { d } = deps({ '/repo/test-results-1.json': body })
    expect(await readTestResults(ROOT, d)).toEqual([{ file: 'x.test.ts', passed: true, at: 0, source: 'jest' }])
  })

  it('normalises Windows roots case-insensitively and backslashes', async () => {
    const body = JSON.stringify({
      testResults: [
        { name: 'c:\\Repo\\a\\x.test.ts', status: 'passed' },
        { name: 'D:\\other\\y.test.ts', status: 'passed' },
        { name: 'C:\\RepoX\\z.test.ts', status: 'passed' }
      ]
    })
    const { d } = deps({ 'C:\\Repo\\vitest-report.json': body })
    const files = (await readTestResults('C:\\Repo\\', d)).map((r) => r.file)
    expect(files).toEqual(['a/x.test.ts', 'D:/other/y.test.ts', 'C:/RepoX/z.test.ts'])
  })

  it('keeps case-sensitive matching for a POSIX root', async () => {
    const body = JSON.stringify({ testResults: [{ name: '/Repo/x.test.ts', status: 'passed' }] })
    const { d } = deps({ '/repo/vitest-report.json': body })
    expect((await readTestResults(ROOT, d))[0].file).toBe('/Repo/x.test.ts')
  })

  it('parses vitest-shaped junit, nested suites, file attribute, quotes, CDATA and loose names', async () => {
    const { d } = deps({ '/repo/reports/junit.xml': fixture('junit.xml') })
    const runs = byFile(await readTestResults(ROOT, d))
    const t = (h: number): number => Date.parse(`2026-11-01T${h}:00:00.000Z`)
    const mk = (file: string, passed: boolean, at: number): TestRun => ({ file, passed, at, source: 'junit' })
    expect(runs['tests/a.test.ts']).toEqual(mk('tests/a.test.ts', true, t(10)))
    expect(runs['tests/b.test.ts']).toEqual(mk('tests/b.test.ts', false, t(11)))
    expect(runs['src/c.test.ts']).toEqual(mk('src/c.test.ts', false, t(12)))
    expect(runs['n/outer.test.ts']).toEqual(mk('n/outer.test.ts', true, t(13)))
    expect(runs['tests/q.test.ts']).toEqual(mk('tests/q.test.ts', true, t(14)))
    expect(runs['tests/cd.test.ts']).toEqual(mk('tests/cd.test.ts', true, t(15)))
    expect(Object.keys(runs).sort()).toEqual([
      'n/outer.test.ts',
      'src/c.test.ts',
      'tests/a.test.ts',
      'tests/b.test.ts',
      'tests/cd.test.ts',
      'tests/q.test.ts'
    ])
  })

  it('does not treat non-test suite names as files', async () => {
    const xml = '<testsuite name="Foo.bar"><testcase name="x"/></testsuite><testsuite name="v1.2 smoke"><testcase name="y"/></testsuite>'
    const { d } = deps({ '/repo/junit.xml': xml })
    expect(await readTestResults(ROOT, d)).toEqual([])
  })

  it('inherits file and timestamp through nested suites, but an own timestamp wins', async () => {
    const xml =
      '<testsuite file="a.test.ts" timestamp="2026-01-01T00:00:00Z"><testsuite name="inner" timestamp="2026-01-05T00:00:00Z"><testcase name="1"/></testsuite></testsuite>'
    const { d } = deps({ '/repo/junit.xml': xml })
    expect((await readTestResults(ROOT, d))[0]).toMatchObject({ file: 'a.test.ts', at: Date.parse('2026-01-05T00:00:00Z') })
  })

  it('ignores failure tags inside CDATA, including an unterminated section', async () => {
    const ok = '<testsuite name="a/x.test.ts"><testcase name="1"><system-out><![CDATA[<failure/>]]></system-out></testcase></testsuite>'
    const cut = '<testsuite name="a/y.test.ts"><testcase name="1"/></testsuite><system-out><![CDATA[<testsuite name="a/z.test.ts"><testcase><failure/>'
    const { d } = deps({ '/repo/junit-1.xml': ok, '/repo/junit-2.xml': cut })
    expect((await readTestResults(ROOT, d)).map((r) => [r.file, r.passed])).toEqual([
      ['a/x.test.ts', true],
      ['a/y.test.ts', true]
    ])
  })

  it('never reads a truncated junit file as passed', async () => {
    const S = '<testsuite name="x/f.test.ts" timestamp="2026-01-01T00:00:00Z">'
    const run = async (xml: string): Promise<TestRun[]> => readTestResults(ROOT, deps({ '/repo/junit.xml': xml }).d)
    const fail = [{ file: 'x/f.test.ts', passed: false, at: Date.parse('2026-01-01T00:00:00Z'), source: 'junit' }]
    // (a) a later testcase cut inside its failure tag
    expect(await run(S + '<testcase name="a"/><testcase name="b"><failure message="boom')).toEqual(fail)
    // (b) a complete failure, cut before </testcase>
    expect(await run(S + '<testcase name="a"/><testcase name="b"><failure/>')).toEqual(fail)
    // an open testcase with no failure yet is not a pass either
    expect(await run(S + '<testcase name="a"/><testcase name="b">')).toEqual(fail)
    expect(await run(S + '<testcase name="a"/><testcase name="b"><skipped/>')).toEqual(fail)
    // the unterminated tag is the testcase itself: suite file, then its own file attribute
    expect(await run(S + '<testcase name="a"/><testcase name="b"')).toEqual(fail)
    expect(await run('<testcase name="b" file="q/own.test.ts" cl')).toEqual([
      { file: 'q/own.test.ts', passed: false, at: 0, source: 'junit' }
    ])
    // an open testcase followed by an unterminated testcase tag
    expect(await run(S + '<testcase name="a"><testcase name="b"')).toEqual(fail)
    // nothing attributable: nothing added, completed runs stay
    expect(await run('<testcase name="a"><failure message="x')).toEqual([])
    expect(await run('<testsuite name="x/f.test.ts"><testcase name="a"/></testsuite><testsuite name="y')).toEqual([
      { file: 'x/f.test.ts', passed: true, at: 0, source: 'junit' }
    ])
    // (c) a clean file still passes
    expect((await run(S + '<testcase name="a"/><testcase name="b"></testcase></testsuite>'))[0].passed).toBe(true)
  })

  it('does not end a tag at a > inside a quoted attribute value', async () => {
    const xml =
      '<testsuite name="a/x.test.ts"><testcase name="a > b"><failure message=\'1 > 0\'/></testcase></testsuite>'
    const { d } = deps({ '/repo/junit.xml': xml })
    expect(await readTestResults(ROOT, d)).toEqual([{ file: 'a/x.test.ts', passed: false, at: 0, source: 'junit' }])
    const ok = '<testsuite name="a/y.test.ts"><testcase name="a > b"/></testsuite>'
    expect((await readTestResults(ROOT, deps({ '/repo/junit.xml': ok }).d))[0].passed).toBe(true)
  })

  it('long tags no longer cut a report short', async () => {
    const run = async (xml: string): Promise<TestRun[]> => readTestResults(ROOT, deps({ '/repo/junit.xml': xml }).d)
    const later = '<testsuite name="b/later.test.ts"><testcase name="ok"/></testsuite>'
    const laterRun = { file: 'b/later.test.ts', passed: true, at: 0, source: 'junit' }
    // (a) a 20,000-char testcase name
    const longName =
      '<testsuite name="a/x.test.ts"><testcase name="' + 'n'.repeat(20000) + '"/></testsuite>' + later
    expect(await run(longName)).toEqual([{ file: 'a/x.test.ts', passed: true, at: 0, source: 'junit' }, laterRun])
    // (b) a 50 KB failure message fails its own file only
    const longFail =
      '<testsuite name="a/y.test.ts"><testcase name="t"><failure message="' + 'm'.repeat(50000) + '"/></testcase></testsuite>' + later
    expect(await run(longFail)).toEqual([{ file: 'a/y.test.ts', passed: false, at: 0, source: 'junit' }, laterRun])
    // an unterminated quote runs to the end of input: truncation
    expect(await run('<testsuite name="a/z.test.ts"><testcase name="q>' + later)).toEqual([
      { file: 'a/z.test.ts', passed: false, at: 0, source: 'junit' }
    ])
  })

  it('records both files when testcases are mis-nested', async () => {
    const xml =
      '<testsuite name="a/one.test.ts"><testcase name="1"><failure/><testsuite name="b/two.test.ts"><testcase name="2"/></testcase></testsuite></testsuite>'
    const runs = await readTestResults(ROOT, deps({ '/repo/junit.xml': xml }).d)
    expect(runs.map((r) => [r.file, r.passed])).toEqual([
      ['a/one.test.ts', false],
      ['b/two.test.ts', true]
    ])
    const open = '<testsuite name="a/p.test.ts"><testcase name="1"><testcase name="2"/></testsuite>'
    expect((await readTestResults(ROOT, deps({ '/repo/junit.xml': open }).d)).map((r) => [r.file, r.passed])).toEqual([
      ['a/p.test.ts', true]
    ])
  })

  it('scans pathological junit and transcript input in linear time', async () => {
    const start = Date.now()
    const { d } = deps({ '/repo/junit.xml': '<testcase '.repeat(Math.floor((2 * 1024 * 1024) / 10)) })
    expect(await readTestResults(ROOT, d)).toEqual([])
    expect(Date.now() - start).toBeLessThan(500)
    const many = '<testsuite name="a/x.test.ts">' + '<testcase '.repeat(100000) + '>'
    const { d: d2 } = deps({ '/repo/junit.xml': many })
    const t2 = Date.now()
    await readTestResults(ROOT, d2)
    expect(Date.now() - t2).toBeLessThan(500)
    const digits = ' ❯ a.test.ts (' + '1 '.repeat(512 * 1024)
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: digits }] } })
    const t3 = Date.now()
    expect(parseTranscriptTestRuns(line, ROOT)).toEqual([])
    expect(Date.now() - t3).toBeLessThan(500)
  })

  it('never rejects: glob rejection and synchronous transcriptRuns throw give no runs', async () => {
    const g = deps({}, { glob: () => Promise.reject(new Error('boom')) })
    expect(await readTestResults(ROOT, g.d)).toEqual([])
    const ok = JSON.stringify({ testResults: [{ name: '/repo/ok.test.ts', status: 'passed' }] })
    const s = deps(
      { '/repo/vitest-report.json': ok },
      {
        transcriptRuns: () => {
          throw new Error('sync')
        }
      }
    )
    expect((await readTestResults(ROOT, s.d)).map((r) => r.file)).toEqual(['ok.test.ts'])
  })

  it('merges a file split over several suites using the latest time and any failure', async () => {
    const xml =
      '<testsuites><testsuite name="a/x.test.ts" timestamp="2026-01-02T00:00:00Z"><testcase name="1"/></testsuite>' +
      '<testsuite name="a/x.test.ts" timestamp="2026-01-01T00:00:00Z"><testcase name="2"><failure/></testcase></testsuite></testsuites>'
    const { d } = deps({ '/repo/TEST-x.xml': xml })
    expect(await readTestResults(ROOT, d)).toEqual([
      { file: 'a/x.test.ts', passed: false, at: Date.parse('2026-01-02T00:00:00Z'), source: 'junit' }
    ])
  })

  it('decodes the five XML entities in attributes', async () => {
    const xml = `<testsuite name="s"><testcase name="n" file="a&amp;b/&lt;&gt;&quot;&apos;.test.ts"/></testsuite>`
    const { d } = deps({ '/repo/junit-1.xml': xml })
    expect((await readTestResults(ROOT, d))[0].file).toBe(`a&b/<>"'.test.ts`)
  })

  it('ignores a failure tag outside any testcase and stray closing tags', async () => {
    const xml = '</testsuite><failure/><testsuite name="a/x.test.ts"><testcase name="1"/></testsuite></testsuite>'
    const { d } = deps({ '/repo/junit.xml': xml })
    expect((await readTestResults(ROOT, d)).map((r) => r.passed)).toEqual([true])
  })

  it('handles a testcase outside any suite and a skip after a failure', async () => {
    const xml =
      '</testcase><testcase name="x" file="a/y.test.ts"><failure/><skipped/></testcase>' +
      '<testcase name="z"/>'
    const { d } = deps({ '/repo/junit.xml': xml })
    expect(await readTestResults(ROOT, d)).toEqual([{ file: 'a/y.test.ts', passed: false, at: 0, source: 'junit' }])
  })

  it('skips null, malformed, oversized, unknown and node_modules files', async () => {
    const big = 'x'.repeat(16 * 1024 * 1024 + 1)
    const ok = JSON.stringify({ testResults: [{ name: '/repo/ok.test.ts', status: 'passed' }] })
    const { d } = deps({
      '/repo/vitest-report-null.json': null,
      '/repo/vitest-report-bad.json': '{not json',
      '/repo/vitest-report-big.json': big,
      '/repo/vitest-report-arr.json': '[1]',
      '/repo/vitest-report-nul.json': 'null',
      '/repo/vitest-report-notarray.json': '{"testResults":5}',
      '/repo/vitest-report-junk.json':
        '{"startTime":"x","testResults":[null,{"name":5,"status":"passed"},{"name":"/repo/ok2.test.ts","status":"passed","startTime":"x","endTime":"y"}]}',
      '/repo/junit-bad.xml': '<<<not xml',
      '/repo/notes.txt': 'whatever',
      '/repo/node_modules/pkg/vitest-report.json': ok,
      'C:\\repo\\node_modules\\pkg\\junit.xml': '<testsuite name="a/y.test.ts"><testcase/></testsuite>',
      '/repo/ok/vitest-report.json': ok
    })
    const runs = await readTestResults(ROOT, d)
    expect(runs.map((r) => r.file).sort()).toEqual(['ok.test.ts', 'ok2.test.ts'])
  })

  it('treats a throwing readFile as no result', async () => {
    const { d } = deps(
      { '/repo/vitest-report.json': '{}' },
      {
        readFile: async () => {
          throw new Error('EACCES')
        }
      }
    )
    expect(await readTestResults(ROOT, d)).toEqual([])
  })

  it('merges transcript runs, and a rejection becomes no runs', async () => {
    const tr: TestRun = { file: 't.test.ts', passed: false, at: 9, source: 'transcript' }
    const a = deps(
      { '/repo/junit.xml': '<testsuite name="a/x.test.ts"><testcase/></testsuite>' },
      { transcriptRuns: async () => [tr] }
    )
    const runs = await readTestResults(ROOT, a.d)
    expect(runs).toHaveLength(2)
    expect(runs[1]).toBe(tr)
    const b = deps({}, { transcriptRuns: () => Promise.reject(new Error('x')) })
    expect(await readTestResults(ROOT, b.d)).toEqual([])
    const c = deps({})
    expect(await readTestResults(ROOT, c.d)).toEqual([])
  })

  it('merges CI runs, and a rejection or throw gives no CI runs', async () => {
    const ci: TestRun = { file: 'src/a.ts', passed: true, at: 5, source: 'ci' }
    const a = deps({}, { ciRuns: async () => [ci] })
    expect(await readTestResults(ROOT, a.d)).toEqual([ci])
    const b = deps({}, { ciRuns: () => Promise.reject(new Error('gh')) })
    expect(await readTestResults(ROOT, b.d)).toEqual([])
    const c = deps({}, { ciRuns: () => { throw new Error('sync') } })
    expect(await readTestResults(ROOT, c.d)).toEqual([])
  })
})

describe('parseTranscriptTestRuns', () => {
  it('reads tool output only, in Claude and codex shapes, with timestamps', () => {
    const runs = parseTranscriptTestRuns(fixture('transcript-testrun.jsonl'), ROOT)
    const t = Date.parse('2026-11-02T10:00:00.000Z')
    const mk = (file: string, passed: boolean, at: number): TestRun => ({ file, passed, at, source: 'transcript' })
    expect(runs).toEqual([
      mk('src/main/a.test.ts', true, t),
      mk('src/main/b.test.ts', false, t),
      mk('src/main/c.test.ts', false, t),
      mk('src/main/d.test.ts', true, t),
      mk('src/main/e.test.ts', false, t),
      mk('src/main/h.test.mts', true, t),
      mk('src/main/g.spec.tsx', true, 0),
      mk('src/main/f.test.mjs', true, 0),
      mk('src/main/i.test.cts', false, 0),
      mk('src/main/j.test.js', false, 0)
    ])
  })

  it('does not walk tool_use blocks, even nested output keys', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't', input: { stdout: ' ✓ src/x.test.ts (1 test)' } }] }
    })
    expect(parseTranscriptTestRuns(line, ROOT)).toEqual([])
  })

  it('does not count assistant text or tool_use input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-02T10:01:00.000Z',
      message: { content: [{ type: 'text', text: ' ✓ src/x.test.ts (2 tests)' }] }
    })
    expect(parseTranscriptTestRuns(line, ROOT)).toEqual([])
  })

  it('normalises absolute paths and ignores non-object scalars', () => {
    const line = JSON.stringify({ a: 1, b: null, c: true, output: 'PASS /repo/src/x.test.js' })
    expect(parseTranscriptTestRuns(line, ROOT)).toEqual([
      { file: 'src/x.test.js', passed: true, at: 0, source: 'transcript' }
    ])
  })
})

describe('statusFor', () => {
  const run = (file: string, passed: boolean, at: number): TestRun => ({ file, passed, at, source: 'vitest' })
  const links = { 'src/a.ts': ['a.test.ts', 'shared.test.ts'], 'src/b.ts': ['b.test.ts', 'shared.test.ts'] }

  it('is gap with no linked tests or no runs among them', () => {
    expect(statusFor(['src/zzz.ts'], [run('a.test.ts', true, 1)], links)).toBe('gap')
    expect(statusFor(['src/a.ts'], [], links)).toBe('gap')
    expect(statusFor(['src/a.ts'], [run('other.test.ts', true, 1)], links)).toBe('gap')
  })

  it('is verified when every linked latest run passed', () => {
    const runs = [run('a.test.ts', true, 1), run('shared.test.ts', true, 2), run('unlinked.test.ts', false, 3)]
    expect(statusFor(['src/a.ts', 'src/b.ts'], runs, links)).toBe('verified')
  })

  it('is built when a linked latest run failed', () => {
    expect(statusFor(['src/a.ts'], [run('a.test.ts', true, 1), run('shared.test.ts', false, 1)], links)).toBe('built')
  })

  it('uses the latest run per test; a tie goes to the failure', () => {
    expect(statusFor(['src/a.ts'], [run('a.test.ts', false, 1), run('a.test.ts', true, 2)], links)).toBe('verified')
    expect(statusFor(['src/a.ts'], [run('a.test.ts', true, 1), run('a.test.ts', false, 2)], links)).toBe('built')
    expect(statusFor(['src/a.ts'], [run('a.test.ts', true, 5), run('a.test.ts', false, 5)], links)).toBe('built')
    expect(statusFor(['src/a.ts'], [run('a.test.ts', false, 5), run('a.test.ts', true, 5)], links)).toBe('built')
    expect(statusFor(['src/a.ts'], [run('a.test.ts', true, 5), run('a.test.ts', true, 5)], links)).toBe('verified')
    expect(statusFor(['src/a.ts'], [run('a.test.ts', true, 9), run('a.test.ts', false, 1)], links)).toBe('verified')
  })
})

describe('never spawns', () => {
  it('has no exec in deps and does not import child_process', () => {
    const { d } = deps({})
    expect(Object.keys(d).sort()).toEqual(['glob', 'readFile'])
    expect(SRC).not.toMatch(/child_process|require\(|spawn\(|execFile?\(/)
    expect(SRC).not.toMatch(/from 'node:|from 'fs'|from 'path'/)
  })
})

describe('testClaims', () => {
  const run = (file: string, passed: boolean, at = 1): TestRun => ({ file, passed, at, source: 'vitest' })
  const linked = { 'src/a.ts': ['t/a.test.ts', 't/b.test.ts'] }

  it('every linked test passing is one verified claim citing them', () => {
    expect(testClaims(['src/a.ts'], [run('t/a.test.ts', true), run('t/b.test.ts', true), run('t/other.test.ts', false)], linked)).toEqual([
      { text: 'Its 2 linked tests passed', state: 'verified', evidence: [{ kind: 'test', ref: 't/a.test.ts' }, { kind: 'test', ref: 't/b.test.ts' }] }
    ])
  })

  it('a failing one is an observed claim saying how many, citing the failing', () => {
    expect(testClaims(['src/a.ts'], [run('t/a.test.ts', true), run('t/b.test.ts', false)], linked)).toEqual([
      { text: '1 of 2 linked tests failed', state: 'observed', evidence: [{ kind: 'test', ref: 't/b.test.ts' }] }
    ])
  })

  it('the newest run of a file decides, and no runs is no claim', () => {
    expect(testClaims(['src/a.ts'], [run('t/a.test.ts', false, 1), run('t/a.test.ts', true, 2)], linked)[0].text).toBe('Its 1 linked tests passed')
    expect(testClaims(['src/a.ts'], [], linked)).toEqual([])
    expect(testClaims(['src/zzz.ts'], [run('t/a.test.ts', true)], linked)).toEqual([])
  })

  it('cites at most eight tests', () => {
    const files = Array.from({ length: 12 }, (_, i) => `t/${String(i).padStart(2, '0')}.test.ts`)
    const c = testClaims(['m'], files.map((f) => run(f, true)), { m: files })
    expect(c[0].text).toBe('Its 12 linked tests passed')
    expect(c[0].evidence).toHaveLength(8)
  })
})
