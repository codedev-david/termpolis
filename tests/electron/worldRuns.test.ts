import { describe, expect, it, vi } from 'vitest'
import { CI_CACHE_MS, CI_RUNS_FETCHED, GH_TIMEOUT_MS, commandOnPath, createWorldRuns, type RunsDeps } from '../../src/main/world/worldRuns'
import { MAX_TRANSCRIPTS, TRANSCRIPT_CACHE_MS } from '../../src/main/world/transcriptRuns'

const ROOT = '/repo'
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const GH_ARGS = ['run', 'list', '--branch', 'feature/x', '--limit', String(CI_RUNS_FETCHED), '--json', 'conclusion,headSha,createdAt,databaseId,workflowName']
const REMOTES = 'origin\tgit@github.com:o/r.git (fetch)\norigin\tgit@github.com:o/r.git (push)\n'
/** Git's answers for the CI tests: HEAD, the branch and a GitHub remote. */
const gitAnswer = (args: string[], head = HEAD): { stdout: string } =>
  ({ stdout: args[0] === 'remote' ? REMOTES : args[1] === 'HEAD' ? head : 'feature/x' })
const row = (over: object = {}): object => ({ conclusion: 'success', headSha: HEAD, createdAt: '2026-11-02T10:00:00Z', databaseId: 1, workflowName: 'Tests', ...over })

interface Setup {
  head?: string
  branch?: string
  rows?: unknown
  changed?: string
  remotes?: string
}
function make(over: Partial<RunsDeps> = {}, o: Setup = {}): { d: RunsDeps; exec: ReturnType<typeof vi.fn>; clock: { t: number } } {
  const clock = { t: Date.parse('2026-11-03T00:00:00Z') }
  const exec = vi.fn(async (bin: string, args: string[]) => {
    if (bin === 'gh') return { stdout: JSON.stringify(o.rows ?? [row()]) }
    if (args[0] === 'remote') return { stdout: o.remotes ?? REMOTES }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: (o.head ?? HEAD) + '\n' }
    if (args[0] === 'rev-parse') return { stdout: (o.branch ?? 'feature/x') + '\n' }
    return { stdout: o.changed ?? 'src/a.ts\n\n src/b.ts \n' }
  })
  const d: RunsDeps = { listTranscripts: async () => [], transcriptsAllowed: () => true, ciAllowed: async () => true, ghOnPath: async () => true, exec, now: () => clock.t, ...over }
  return { d, exec, clock }
}
const ciOf = async (o: Setup = {}, over: Partial<RunsDeps> = {}) => createWorldRuns(make(over, o).d).ciRuns(ROOT)
const ghCalls = (exec: ReturnType<typeof vi.fn>): number => exec.mock.calls.filter((c) => c[0] === 'gh').length

describe('ciRuns', () => {
  it('a test run on exactly HEAD marks the commit files, with the 5 s gh timeout', async () => {
    const { d, exec } = make()
    const runs = await createWorldRuns(d).ciRuns(ROOT)
    const at = Date.parse('2026-11-02T10:00:00Z')
    expect(runs).toEqual([
      { file: 'src/a.ts', passed: true, at, source: 'ci' },
      { file: 'src/b.ts', passed: true, at, source: 'ci' }
    ])
    expect(exec).toHaveBeenCalledWith('gh', GH_ARGS, { cwd: ROOT, timeout: GH_TIMEOUT_MS })
    expect(exec).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], expect.objectContaining({ cwd: ROOT }))
    expect(exec).toHaveBeenCalledWith('git', ['remote', '-v'], expect.objectContaining({ cwd: ROOT }))
    expect(exec).toHaveBeenCalledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'], expect.objectContaining({ cwd: ROOT }))
    expect(exec).toHaveBeenCalledWith('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', HEAD], expect.objectContaining({ cwd: ROOT }))
    expect(GH_TIMEOUT_MS).toBe(5000)
  })

  it('failure marks them failed; a future createdAt is clamped to now; a bad one uses now', async () => {
    const f = await ciOf({ rows: [row({ conclusion: 'failure' })], changed: 'x.ts' })
    expect(f).toEqual([{ file: 'x.ts', passed: false, at: Date.parse('2026-11-02T10:00:00Z'), source: 'ci' }])
    const now = Date.parse('2026-11-03T00:00:00Z')
    expect((await ciOf({ rows: [row({ createdAt: '2099-01-01T00:00:00Z' })], changed: 'x.ts' }))[0].at).toBe(now)
    expect((await ciOf({ rows: [row({ createdAt: 'nope' })], changed: 'x.ts' }))[0].at).toBe(now)
    expect((await ciOf({ rows: [row({ createdAt: undefined })], changed: 'x.ts' }))[0].at).toBe(now)
  })

  it('picks the matching run among several, not just the first row', async () => {
    const runs = await ciOf({ rows: [row({ workflowName: 'Release' }), row({ headSha: OLD }), row({ conclusion: 'failure', headSha: HEAD.toUpperCase() })], changed: 'x.ts' })
    expect(runs).toEqual([{ file: 'x.ts', passed: false, at: Date.parse('2026-11-02T10:00:00Z'), source: 'ci' }])
  })

  it('an unrelated green workflow, a stale headSha, an unfinished run and a null row give no result', async () => {
    expect(await ciOf({ rows: [row({ workflowName: 'Release' })] })).toEqual([])
    expect(await ciOf({ rows: [row({ workflowName: undefined })] })).toEqual([])
    expect(await ciOf({ rows: [row({ headSha: OLD })] })).toEqual([])
    expect(await ciOf({ rows: [row({ headSha: 5 })] })).toEqual([])
    expect(await ciOf({ rows: [row({ conclusion: 'cancelled' })] })).toEqual([])
    expect(await ciOf({ rows: [null] })).toEqual([])
    expect(await ciOf({ rows: { not: 'a list' } })).toEqual([])
  })

  it('asks only about the current branch; a detached or odd branch gives no result and no gh call', async () => {
    const a = make({}, { branch: 'other' })
    await createWorldRuns(a.d).ciRuns(ROOT)
    expect(a.exec).toHaveBeenCalledWith('gh', expect.arrayContaining(['--branch', 'other']), expect.anything())
    for (const branch of ['HEAD', '--evil', '']) {
      const b = make({}, { branch })
      expect(await createWorldRuns(b.d).ciRuns(ROOT)).toEqual([])
      expect(ghCalls(b.exec)).toBe(0)
    }
  })

  it('a HEAD that cannot be read gives no result and no gh call', async () => {
    const fails = [async () => ({ stdout: '', error: new Error('git') }), async () => ({ stdout: 'not a sha' })] as RunsDeps['exec'][]
    for (const exec of fails) {
      const spy = vi.fn(exec)
      expect(await createWorldRuns(make({ exec: spy }).d).ciRuns(ROOT)).toEqual([])
      expect(spy.mock.calls.every((c) => c[0] === 'git')).toBe(true)
    }
  })

  it('never starts gh or git unless the setting is on', async () => {
    const ghOnPath = vi.fn(async () => true)
    const { d, exec } = make({ ciAllowed: async () => false, ghOnPath })
    expect(await createWorldRuns(d).ciRuns(ROOT)).toEqual([])
    expect(exec).not.toHaveBeenCalled()
    expect(ghOnPath).not.toHaveBeenCalled()
  })

  it('with no gh on PATH, gives no result quietly and starts neither gh nor git', async () => {
    const { d, exec } = make({ ghOnPath: async () => false })
    expect(await createWorldRuns(d).ciRuns(ROOT)).toEqual([])
    expect(exec).not.toHaveBeenCalled()
  })

  it('a repository with no GitHub remote, or remotes git cannot list, gives no result and no gh call', async () => {
    const others = ['', 'origin\thttps://gitlab.com/o/r.git (fetch)\n', 'origin\thttps://notgithub.com/o/r (fetch)\n', 'origin\n', 'github.com:o/r (fetch)\n']
    for (const remotes of others) {
      const m = make({}, { remotes })
      expect(await createWorldRuns(m.d).ciRuns(ROOT)).toEqual([])
      expect(ghCalls(m.exec)).toBe(0)
    }
    const failing = vi.fn(async (bin: string, args: string[]) => (args[0] === 'remote' ? { stdout: '', error: new Error('git') } : gitAnswer(args)))
    expect(await createWorldRuns(make({ exec: failing }).d).ciRuns(ROOT)).toEqual([])
    expect(ghCalls(failing)).toBe(0)
    // Every GitHub URL shape counts, on any remote line.
    for (const url of ['https://github.com/o/r.git', 'ssh://git@github.com/o/r', 'git@GitHub.com:o/r.git']) {
      const m = make({}, { remotes: `upstream\thttps://gitlab.com/x (fetch)\norigin\t${url} (fetch)\n`, changed: 'x.ts' })
      expect(await createWorldRuns(m.d).ciRuns(ROOT)).toHaveLength(1)
    }
  })

  it('gh missing, failing or unparsable, or a failing diff, gives []', async () => {
    const git = (args: string[]): { stdout: string } => gitAnswer(args)
    const cases: RunsDeps['exec'][] = [
      async (bin, args) => (bin === 'gh' ? { stdout: '', error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) } : git(args)),
      async (bin, args) => (bin === 'gh' ? { stdout: 'not json' } : git(args)),
      async (bin, args) => (bin === 'gh' ? { stdout: JSON.stringify([row()]) } : args[0] === 'diff-tree' ? { stdout: '', error: new Error('git') } : git(args))
    ]
    for (const exec of cases) expect(await ciOf({}, { exec })).toEqual([])
  })

  it('keeps the answer 10 minutes while HEAD stays, even an empty one; a new HEAD asks again', async () => {
    const { d, exec, clock } = make({}, { rows: [] })
    const w = createWorldRuns(d)
    await w.ciRuns(ROOT)
    await w.ciRuns(ROOT)
    expect(ghCalls(exec)).toBe(1)
    await w.ciRuns('/other')
    expect(ghCalls(exec)).toBe(2)
    clock.t += CI_CACHE_MS
    await w.ciRuns(ROOT)
    expect(ghCalls(exec)).toBe(3)
    const moved = make({}, { rows: [] })
    const m = createWorldRuns(moved.d)
    await m.ciRuns(ROOT)
    moved.exec.mockImplementation(async (bin: string, args: string[]) => (bin === 'gh' ? { stdout: '[]' } : gitAnswer(args, OLD)))
    await m.ciRuns(ROOT)
    expect(ghCalls(moved.exec)).toBe(2)
  })
})

describe('commandOnPath', () => {
  const found = (files: string[]) => vi.fn(async (f: string) => {
    if (!files.includes(f)) throw new Error('ENOENT')
  })

  it('finds gh.exe or gh.com in a Windows PATH folder, skipping relative, empty and quoted-empty entries', async () => {
    const access = found(['C:\\Tools\\gh.com'])
    expect(await commandOnPath('gh', { Path: '"";rel\\bin;;C:\\Windows;"C:\\Tools"' }, 'win32', access)).toBe(true)
    expect(access.mock.calls.map((c) => c[0])).toEqual(['C:\\Windows\\gh.exe', 'C:\\Windows\\gh.com', 'C:\\Tools\\gh.exe', 'C:\\Tools\\gh.com'])
    expect(await commandOnPath('gh', { PATH: 'C:\\Tools' }, 'win32', found(['C:\\Tools\\gh.cmd']))).toBe(false)
  })

  it('finds gh in a POSIX PATH folder and says no when it is nowhere or PATH is unset', async () => {
    const access = found(['/usr/local/bin/gh'])
    expect(await commandOnPath('gh', { PATH: '/usr/bin:./bin:/usr/local/bin' }, 'linux', access)).toBe(true)
    expect(access.mock.calls.map((c) => c[0])).toEqual(['/usr/bin/gh', '/usr/local/bin/gh'])
    expect(await commandOnPath('gh', { PATH: '/usr/bin' }, 'darwin', found([]))).toBe(false)
    expect(await commandOnPath('gh', {}, 'linux', found(['/gh']))).toBe(false)
  })
})

describe('transcriptFiles', () => {
  it('names nothing when conversations may not be read', async () => {
    const listTranscripts = vi.fn(async () => ['a.jsonl'])
    const { d } = make({ transcriptsAllowed: () => false, listTranscripts })
    expect(await createWorldRuns(d).transcriptFiles(ROOT)).toEqual([])
    expect(listTranscripts).not.toHaveBeenCalled()
  })

  it('names the 20 newest files only, and caches 20 s', async () => {
    const files = Array.from({ length: 30 }, (_, i) => `f${i}.jsonl`)
    const listTranscripts = vi.fn(async () => files)
    const { d, clock } = make({ listTranscripts })
    const w = createWorldRuns(d)
    expect(await w.transcriptFiles(ROOT)).toEqual(files.slice(0, MAX_TRANSCRIPTS))
    await w.transcriptFiles(ROOT)
    expect(listTranscripts).toHaveBeenCalledTimes(1)
    clock.t += TRANSCRIPT_CACHE_MS
    await w.transcriptFiles(ROOT)
    expect(listTranscripts).toHaveBeenCalledTimes(2)
  })

  it('a listing failure gives none', async () => {
    const { d } = make({
      listTranscripts: async () => {
        throw new Error('gone')
      }
    })
    expect(await createWorldRuns(d).transcriptFiles(ROOT)).toEqual([])
  })
})
