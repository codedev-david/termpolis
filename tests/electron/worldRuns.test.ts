import { describe, expect, it, vi } from 'vitest'
import { CI_CACHE_MS, CI_RUNS_FETCHED, GH_TIMEOUT_MS, createWorldRuns, type RunsDeps } from '../../src/main/world/worldRuns'
import { commandOnPath } from '../../src/main/binPath'
import { gitSubcommand, guardGitArgs } from '../../src/main/gitSafety'
import { MAX_TRANSCRIPTS, TRANSCRIPT_CACHE_MS } from '../../src/main/world/transcriptRuns'

const ROOT = '/repo'
/** Where the tests' `gh` was found: ciRuns must start exactly this path, never a bare `gh`. */
const GH = '/usr/bin/gh'
/** Where the tests' git was found: every git call must start exactly this path, never a bare `git`. */
const GIT = '/usr/bin/git'
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const GH_ARGS = ['run', 'list', '--branch', 'feature/x', '--limit', String(CI_RUNS_FETCHED), '--json', 'conclusion,headSha,createdAt,databaseId,workflowName']
const REMOTES = 'origin\tgit@github.com:o/r.git (fetch)\norigin\tgit@github.com:o/r.git (push)\n'
/** Git's answers for the CI tests: HEAD, the branch and a GitHub remote. */
/** Every git run carries the read-only prefix (gitSafety.ts guardGitArgs): the git command as the code wrote it. */
const plain = (args: string[]): string[] => args.slice(gitSubcommand(args)?.index ?? 0)
/** The argument list git is started with for a read the code wrote as `args`. */
const guarded = (args: string[]): string[] => guardGitArgs(args, process.platform === 'win32')
const gitAnswer = (raw: string[], head = HEAD): { stdout: string } => {
  const args = plain(raw)
  return { stdout: args[0] === 'remote' ? REMOTES : args[1] === 'HEAD' ? head : 'feature/x' }
}
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
  const exec = vi.fn(async (bin: string, raw: string[]) => {
    const args = plain(raw)
    if (bin === GH) return { stdout: JSON.stringify(o.rows ?? [row()]) }
    if (args[0] === 'remote') return { stdout: o.remotes ?? REMOTES }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: (o.head ?? HEAD) + '\n' }
    if (args[0] === 'rev-parse') return { stdout: (o.branch ?? 'feature/x') + '\n' }
    return { stdout: o.changed ?? 'src/a.ts\n\n src/b.ts \n' }
  })
  const d: RunsDeps = { listTranscripts: async () => [], transcriptsAllowed: () => true, ciAllowed: async () => true, ghOnPath: async () => GH, gitBin: async () => GIT, realpath: async (p) => p, exec, now: () => clock.t, ...over }
  return { d, exec, clock }
}
const ciOf = async (o: Setup = {}, over: Partial<RunsDeps> = {}) => createWorldRuns(make(over, o).d).ciRuns(ROOT)
/** The runs of an answer that judged HEAD (WP4b fix round 1, I2): any other answer fails the test. */
const runsOf = async (o: Setup = {}, over: Partial<RunsDeps> = {}) => {
  const a = await ciOf(o, over)
  expect(a?.head).toBe(o.head ?? HEAD)
  return a?.runs
}
/** No CI read here at all: no commit judged, no runs. */
const NOT_READ = { head: null, runs: [], age: 0 }
const ghCalls = (exec: ReturnType<typeof vi.fn>): number => exec.mock.calls.filter((c) => c[0] === GH).length

describe('ciRuns', () => {
  it('a test run on exactly HEAD marks the commit files, with the 5 s gh timeout', async () => {
    const { d, exec } = make()
    const answer = await createWorldRuns(d).ciRuns(ROOT)
    const at = Date.parse('2026-11-02T10:00:00Z')
    // The answer names the commit it judged, and is new.
    expect(answer?.head).toBe(HEAD)
    expect(answer?.age).toBe(0)
    expect(answer?.runs).toEqual([
      { file: 'src/a.ts', passed: true, at, source: 'ci' },
      { file: 'src/b.ts', passed: true, at, source: 'ci' }
    ])
    expect(exec).toHaveBeenCalledWith(GH, GH_ARGS, { cwd: ROOT, timeout: GH_TIMEOUT_MS })
    expect(exec).toHaveBeenCalledWith(GIT, guarded(['rev-parse', 'HEAD']), expect.objectContaining({ cwd: ROOT }))
    expect(exec).toHaveBeenCalledWith(GIT, guarded(['remote', '-v']), expect.objectContaining({ cwd: ROOT }))
    expect(exec).toHaveBeenCalledWith(GIT, guarded(['rev-parse', '--abbrev-ref', 'HEAD']), expect.objectContaining({ cwd: ROOT }))
    expect(exec).toHaveBeenCalledWith(GIT, guarded(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', HEAD]), expect.objectContaining({ cwd: ROOT }))
    expect(GH_TIMEOUT_MS).toBe(5000)
  })

  it('failure marks them failed; a future createdAt is clamped to now; a bad one uses now', async () => {
    const f = await runsOf({ rows: [row({ conclusion: 'failure' })], changed: 'x.ts' })
    expect(f).toEqual([{ file: 'x.ts', passed: false, at: Date.parse('2026-11-02T10:00:00Z'), source: 'ci' }])
    const now = Date.parse('2026-11-03T00:00:00Z')
    expect((await runsOf({ rows: [row({ createdAt: '2099-01-01T00:00:00Z' })], changed: 'x.ts' }))?.[0].at).toBe(now)
    expect((await runsOf({ rows: [row({ createdAt: 'nope' })], changed: 'x.ts' }))?.[0].at).toBe(now)
    expect((await runsOf({ rows: [row({ createdAt: undefined })], changed: 'x.ts' }))?.[0].at).toBe(now)
  })

  it('picks the matching run among several, not just the first row', async () => {
    const runs = await runsOf({ rows: [row({ workflowName: 'Release' }), row({ headSha: OLD }), row({ conclusion: 'failure', headSha: HEAD.toUpperCase() })], changed: 'x.ts' })
    expect(runs).toEqual([{ file: 'x.ts', passed: false, at: Date.parse('2026-11-02T10:00:00Z'), source: 'ci' }])
  })

  it('an unrelated green workflow, a stale headSha, an unfinished run and a null row are no CI for HEAD', async () => {
    expect(await runsOf({ rows: [row({ workflowName: 'Release' })] })).toEqual([])
    expect(await runsOf({ rows: [row({ workflowName: undefined })] })).toEqual([])
    expect(await runsOf({ rows: [row({ headSha: OLD })] })).toEqual([])
    expect(await runsOf({ rows: [row({ headSha: 5 })] })).toEqual([])
    expect(await runsOf({ rows: [row({ conclusion: 'cancelled' })] })).toEqual([])
    expect(await runsOf({ rows: [null] })).toEqual([])
    expect(await runsOf({ rows: [] })).toEqual([])
    // gh printing something other than a list did not answer: no answer, not "no CI".
    expect(await ciOf({ rows: { not: 'a list' } })).toBeNull()
  })

  it('asks only about the current branch; a detached or odd branch gives no result and no gh call', async () => {
    const a = make({}, { branch: 'other' })
    await createWorldRuns(a.d).ciRuns(ROOT)
    expect(a.exec).toHaveBeenCalledWith(GH, expect.arrayContaining(['--branch', 'other']), expect.anything())
    for (const branch of ['HEAD', '--evil', '']) {
      const b = make({}, { branch })
      expect(await createWorldRuns(b.d).ciRuns(ROOT)).toEqual({ head: HEAD, runs: [], age: 0 })
      expect(ghCalls(b.exec)).toBe(0)
    }
  })

  it('a HEAD that cannot be read is no answer, and no gh call', async () => {
    const fails = [async () => ({ stdout: '', error: new Error('git') }), async () => ({ stdout: 'not a sha' })] as RunsDeps['exec'][]
    for (const exec of fails) {
      const spy = vi.fn(exec)
      expect(await createWorldRuns(make({ exec: spy }).d).ciRuns(ROOT)).toBeNull()
      expect(spy.mock.calls.every((c) => c[0] === GIT)).toBe(true)
    }
  })

  it('never starts gh or git unless the setting is on', async () => {
    const ghOnPath = vi.fn(async () => GH)
    const { d, exec } = make({ ciAllowed: async () => false, ghOnPath })
    expect(await createWorldRuns(d).ciRuns(ROOT)).toEqual(NOT_READ)
    expect(exec).not.toHaveBeenCalled()
    expect(ghOnPath).not.toHaveBeenCalled()
  })

  it('with no gh on PATH, gives no result quietly and starts nothing at all', async () => {
    const { d, exec } = make({ ghOnPath: async () => null })
    expect(await createWorldRuns(d).ciRuns(ROOT)).toEqual(NOT_READ)
    expect(exec).not.toHaveBeenCalled()
  })

  it('starts gh by the full path it found, and never a gh inside the repository', async () => {
    const { d, exec } = make()
    await createWorldRuns(d).ciRuns(ROOT)
    const bins = exec.mock.calls.map((c) => c[0])
    expect(bins).toContain(GH)
    expect(bins.every((b) => b === GIT || b === GH)).toBe(true)
    // A gh found in the repository itself (PATH names its folder) is refused: nothing runs for CI.
    for (const planted of ['/repo/gh', '/repo/tools/gh', '/REPO/gh']) {
      const m = make({ ghOnPath: async () => planted })
      expect(await createWorldRuns(m.d).ciRuns(ROOT)).toEqual(NOT_READ)
      expect(m.exec).not.toHaveBeenCalled()
    }
    // A sibling folder whose name only starts like the repository's is not inside it.
    const sib = make({ ghOnPath: async () => '/repo-tools/gh' })
    await createWorldRuns(sib.d).ciRuns(ROOT)
    expect(sib.exec).toHaveBeenCalledWith('/repo-tools/gh', GH_ARGS, expect.anything())
  })

  it('starts git by the full path it found; with no git, or a git inside the repository, nothing runs', async () => {
    const { d, exec } = make()
    await createWorldRuns(d).ciRuns(ROOT)
    expect(exec.mock.calls.map((c) => c[0])).not.toContain('git')
    expect(exec.mock.calls.filter((c) => c[0] === GIT).length).toBeGreaterThan(0)
    for (const gitBin of [async () => null, async () => '/repo/git', async () => '/repo/tools/git']) {
      const m = make({ gitBin })
      expect(await createWorldRuns(m.d).ciRuns(ROOT)).toEqual(NOT_READ)
      expect(m.exec).not.toHaveBeenCalled()
    }
  })

  it('a gh or git reached through a link into the repository counts as inside it', async () => {
    // /links/x resolves into the repository: neither program behind it is started.
    const realpath = async (p: string): Promise<string> => (p.startsWith('/links/') ? '/repo/' + p.slice('/links/'.length) : p)
    for (const over of [{ ghOnPath: async () => '/links/gh' }, { gitBin: async () => '/links/git' }]) {
      const m = make({ realpath, ...over })
      expect(await createWorldRuns(m.d).ciRuns(ROOT)).toEqual(NOT_READ)
      expect(m.exec).not.toHaveBeenCalled()
    }
  })

  it('on Windows, a gh.exe planted in the repo root and a relative PATH entry are not what runs', async () => {
    const root = 'C:\\Users\\me\\repo'
    const real = 'C:\\Program Files\\GitHub CLI\\gh.exe'
    const present = [root + '\\gh.exe', '.\\gh.exe', 'bin\\gh.exe', '\\gh.exe', 'C:gh.exe', real]
    const runnable = vi.fn(async (f: string) => {
      if (!present.includes(f)) throw new Error('ENOENT')
    })
    const Path = `.;bin;\\;C:;${root};C:\\Program Files\\GitHub CLI`
    const exec = vi.fn(async (bin: string, args: string[]) => (bin === real ? { stdout: JSON.stringify([row()]) } : gitAnswer(args)))
    const ghOnPath = (): Promise<string | null> => commandOnPath('gh', { Path }, 'win32', runnable, root)
    const runs = (await createWorldRuns({ ...make().d, exec, ghOnPath }).ciRuns(root))?.runs ?? []
    expect(runs.length).toBeGreaterThan(0)
    expect(runnable.mock.calls.map((c) => c[0])).toEqual([real])
    expect(exec).toHaveBeenCalledWith(real, GH_ARGS, { cwd: root, timeout: GH_TIMEOUT_MS })
    expect(exec.mock.calls.every((c) => c[0] === GIT || c[0] === real)).toBe(true)
    // With the repo folder named on PATH while Termpolis runs elsewhere, the planted gh.exe is found but refused.
    const planted = vi.fn(async (_bin: string, args: string[]) => gitAnswer(args))
    const fromRepo = (): Promise<string | null> => commandOnPath('gh', { Path: root }, 'win32', runnable, 'C:\\Windows')
    expect(await fromRepo()).toBe(root + '\\gh.exe')
    expect(await createWorldRuns({ ...make().d, exec: planted, ghOnPath: fromRepo }).ciRuns(root)).toEqual(NOT_READ)
    expect(planted).not.toHaveBeenCalled()
  })

  it('looks for gh once per 10 minutes, not on every call', async () => {
    const ghOnPath = vi.fn(async () => GH)
    const { d, clock } = make({ ghOnPath }, { rows: [] })
    const w = createWorldRuns(d)
    await w.ciRuns(ROOT)
    await w.ciRuns('/other')
    expect(ghOnPath).toHaveBeenCalledTimes(1)
    clock.t += CI_CACHE_MS
    await w.ciRuns(ROOT)
    expect(ghOnPath).toHaveBeenCalledTimes(2)
  })

  it('a repository with no GitHub remote is no CI for HEAD; remotes git cannot list are no answer; neither calls gh', async () => {
    const others = ['', 'origin\thttps://gitlab.com/o/r.git (fetch)\n', 'origin\thttps://notgithub.com/o/r (fetch)\n', 'origin\n', 'github.com:o/r (fetch)\n']
    for (const remotes of others) {
      const m = make({}, { remotes })
      expect(await createWorldRuns(m.d).ciRuns(ROOT)).toEqual({ head: HEAD, runs: [], age: 0 })
      expect(ghCalls(m.exec)).toBe(0)
    }
    const failing = vi.fn(async (bin: string, args: string[]) => (plain(args)[0] === 'remote' ? { stdout: '', error: new Error('git') } : gitAnswer(args)))
    expect(await createWorldRuns(make({ exec: failing }).d).ciRuns(ROOT)).toBeNull()
    expect(ghCalls(failing)).toBe(0)
    // A branch git cannot name is no answer either.
    const noBranch = vi.fn(async (bin: string, args: string[]) => (plain(args)[1] === '--abbrev-ref' ? { stdout: '', error: new Error('git') } : gitAnswer(args)))
    expect(await createWorldRuns(make({ exec: noBranch }).d).ciRuns(ROOT)).toBeNull()
    expect(ghCalls(noBranch)).toBe(0)
    // Every GitHub URL shape counts, on any remote line.
    for (const url of ['https://github.com/o/r.git', 'ssh://git@github.com/o/r', 'git@GitHub.com:o/r.git']) {
      const m = make({}, { remotes: `upstream\thttps://gitlab.com/x (fetch)\norigin\t${url} (fetch)\n`, changed: 'x.ts' })
      expect((await createWorldRuns(m.d).ciRuns(ROOT))?.runs).toHaveLength(1)
    }
  })

  it('every way gh can fail is no answer, never "no CI", and none is kept: the next call asks gh again (WP4b fix round 1, M1)', async () => {
    const git = (args: string[]): { stdout: string } => gitAnswer(args)
    const ghFails = (error: Error, stdout = ''): RunsDeps['exec'] => async (bin, args) => (bin === GH ? { stdout, error } : git(args))
    const failures: Record<string, RunsDeps['exec']> = {
      // procHost hands back the child's error: gh could not start.
      spawn: ghFails(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })),
      // gh exits 1 with its own words for each of these on stderr.
      offline: ghFails(new Error('error connecting to api.github.com')),
      auth: ghFails(new Error('To get started with GitHub CLI, please run:  gh auth login')),
      rateLimit: ghFails(new Error('HTTP 403: API rate limit exceeded')),
      // Past GH_TIMEOUT_MS the run is killed, with whatever it printed so far.
      timeout: ghFails(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }), '[{"conc'),
      unparsable: async (bin, args) => (bin === GH ? { stdout: 'not json' } : git(args)),
      diffTree: async (bin, args) => (bin === GH ? { stdout: JSON.stringify([row()]) } : plain(args)[0] === 'diff-tree' ? { stdout: '', error: new Error('git') } : git(args))
    }
    for (const [name, exec] of Object.entries(failures)) {
      const spy = vi.fn(exec)
      const w = createWorldRuns(make({ exec: spy }).d)
      expect(await w.ciRuns(ROOT), name).toBeNull()
      expect(await w.ciRuns(ROOT), name).toBeNull()
      expect(ghCalls(spy), name).toBe(2)
    }
    // gh back: the next call asks it again and gets the runs.
    let ghUp = false
    const back = vi.fn(async (bin: string, args: string[]) =>
      bin === GH ? (ghUp ? { stdout: JSON.stringify([row()]) } : { stdout: '', error: new Error('offline') }) : plain(args)[0] === 'diff-tree' ? { stdout: 'x.ts' } : gitAnswer(args)
    )
    const w = createWorldRuns(make({ exec: back }).d)
    expect(await w.ciRuns(ROOT)).toBeNull()
    ghUp = true
    expect((await w.ciRuns(ROOT))?.runs).toHaveLength(1)
  })

  it('only a gh that answered with zero runs of HEAD is "no CI", and that is kept', async () => {
    const { d, exec } = make({}, { rows: [] })
    const w = createWorldRuns(d)
    expect(await w.ciRuns(ROOT)).toEqual({ head: HEAD, runs: [], age: 0 })
    await w.ciRuns(ROOT)
    expect(ghCalls(exec)).toBe(1)
  })

  it('a kept answer says how old it is, and names the commit it judged', async () => {
    const { d, clock } = make({}, { rows: [row()], changed: 'x.ts' })
    const w = createWorldRuns(d)
    await w.ciRuns(ROOT)
    clock.t += 90_000
    expect(await w.ciRuns(ROOT)).toEqual({ head: HEAD, runs: [expect.objectContaining({ file: 'x.ts' })], age: 90_000 })
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
    moved.exec.mockImplementation(async (bin: string, args: string[]) => (bin === GH ? { stdout: '[]' } : gitAnswer(args, OLD)))
    await m.ciRuns(ROOT)
    expect(ghCalls(moved.exec)).toBe(2)
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
