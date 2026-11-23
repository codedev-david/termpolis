// Direct unit tests for gitCommand.ts. The IPC-layer security tests in
// security.test.ts cover argv-injection rejection paths, but they don't
// exercise safeGitAsync / runSafeCommandAsync defaults or the platform-specific
// exec vs execFile split — that's what this file is for.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockExec, mockExecFile, bin } = vi.hoisted(() => ({
  // The callback flavours. With no proc host wired up, procClient runs the spawn in-process through
  // exactly these.
  mockExec: vi.fn(),
  mockExecFile: vi.fn(),
  // Where binPath says git is (null: not installed), and how often it was told to forget.
  bin: { path: null as string | null, forgets: 0, looks: 0 },
}))

vi.mock('child_process', () => ({
  default: { exec: mockExec, execFile: mockExecFile },
  exec: mockExec,
  execFile: mockExecFile,
}))
// binPath's lookup is tested on its own (binPath.test.ts); here it answers what each test says. The inside-the-folder
// check is the real one.
vi.mock('../../src/main/binPath', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/binPath')>()
  return {
    ...real,
    resolveGitBin: async () => {
      bin.looks++
      return bin.path
    },
    forgetGitBin: () => {
      bin.forgets++
    },
  }
})

import { mkdirSync, mkdtempSync, promises as fsPromises, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { safeGitAsync, runSafeCommandAsync, parseSafeCommand, isValidGitRef, repoTopLevel, GitTooOldError, _resetGitBinForTests } from '../../src/main/gitCommand'
import { OLD_GIT_MESSAGE } from '../../src/main/world/gitLogin'
import { filterOverrides, guardGitArgs, UnsafeFilterError } from '../../src/main/gitSafety'

const GIT = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git'

beforeEach(() => {
  mockExec.mockReset()
  mockExecFile.mockReset()
  bin.path = GIT
  bin.forgets = 0
  bin.looks = 0
})

// safeGitAsync runs git in the proc host; with none wired up (here) procClient runs the same call in-process through
// execFile, which is what the mock below answers. There is no synchronous safeGit or runSafeCommand any more.
describe('safeGitAsync: git by its full path, never the bare name', () => {
  const enoent = (): Error => Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
  type Cb = (e: Error | null, out: string, err: string) => void

  it('starts git by the absolute path binPath found, with the cwd and defaults', async () => {
    mockExecFile.mockImplementation((_b: string, _a: string[], _o: unknown, cb: Cb) => cb(null, '/repo/root\n', ''))
    expect((await safeGitAsync(['rev-parse', '--show-toplevel'], { cwd: '/repo' })).trim()).toBe('/repo/root')
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const [spawned, args, opts] = mockExecFile.mock.calls[0]
    expect(spawned).toBe(GIT)
    expect(spawned).not.toBe('git')
    // A read carries the read-only prefix (gitSafety.ts); rev-parse keeps the hooks folder.
    expect(args).toEqual(guardGitArgs(['rev-parse', '--show-toplevel'], process.platform === 'win32'))
    expect(args.slice(-2)).toEqual(['rev-parse', '--show-toplevel'])
    expect(opts).toMatchObject({ cwd: '/repo', timeout: 10000, maxBuffer: 1024 * 1024 })
  })

  it('when git is not installed, starts nothing and fails with ENOENT, as a missing git always did', async () => {
    bin.path = null
    await expect(safeGitAsync(['status'], { cwd: '/repo' })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('a git.exe inside the repository it would run in is never started', async () => {
    const repo = process.platform === 'win32' ? 'C:\\work\\cloned' : '/work/cloned'
    bin.path = process.platform === 'win32' ? 'C:\\work\\cloned\\git.exe' : '/work/cloned/git'
    await expect(safeGitAsync(['log', '-1'], { cwd: repo })).rejects.toMatchObject({ code: 'ENOENT' })
    // …nor one deeper in it (a tools folder on PATH).
    bin.path = process.platform === 'win32' ? 'C:\\work\\cloned\\tools\\git.exe' : '/work/cloned/tools/git'
    await expect(safeGitAsync(['log', '-1'], { cwd: repo })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('an ENOENT from the spawn (git uninstalled since) makes binPath look again next time', async () => {
    mockExecFile.mockImplementation((_b: string, _a: string[], _o: unknown, cb: Cb) => cb(enoent(), '', ''))
    await expect(safeGitAsync(['status'], { cwd: '/repo' })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(bin.forgets).toBe(1)
  })

  it('re-throws a genuine git error (not ENOENT) and keeps the git it found', async () => {
    const notRepo = Object.assign(new Error('not a git repository'), { code: 128 })
    mockExecFile.mockImplementation((_b: string, _a: string[], _o: unknown, cb: Cb) => cb(notRepo, '', 'fatal: not a git repository'))
    await expect(safeGitAsync(['rev-parse', '--show-toplevel'], { cwd: '/tmp' })).rejects.toThrow(/not a git repository/)
    expect(bin.forgets).toBe(0)
  })

  it('_resetGitBinForTests forgets the cached git', () => {
    _resetGitBinForTests()
    expect(bin.forgets).toBe(1)
  })
})

// status and diff can run a clean filter, so safeGitAsync first reads which filter drivers the repository defines
// (gitSafety.ts filterScanArgs) and switches each off by name.
describe('safeGitAsync: the filter-driver read before status and diff', () => {
  type Cb = (e: Error | null, out: string, err: string) => void
  const isScan = (a: string[]): boolean => a.includes('--show-scope')
  const isWin = process.platform === 'win32'
  const answer = (scan: string | Error, out = 'ok'): void => {
    mockExecFile.mockImplementation((_b: string, a: string[], _o: unknown, cb: Cb) => {
      if (!isScan(a)) return cb(null, out, '')
      if (scan instanceof Error) return cb(scan, '', '')
      cb(null, scan, '')
    })
  }
  const command = (): string[] | undefined => mockExecFile.mock.calls.map((c) => c[1] as string[]).find((a) => !isScan(a))
  const scans = (): number => mockExecFile.mock.calls.filter((c) => isScan(c[1] as string[])).length
  beforeEach(() => _resetGitBinForTests())
  afterEach(() => vi.useRealTimers())

  it('switches off a driver the repository defines, in the same folder, with the read-only prefix', async () => {
    answer('local\0filter.evil.clean\nsh plant.sh\0')
    await safeGitAsync(['-C', '/sub', 'status', '--porcelain'], { cwd: '/repo' })
    const scan = mockExecFile.mock.calls[0]
    expect(scan[1]).toEqual(['-C', '/sub', ...guardGitArgs(['config'], isWin).slice(0, -1), 'config', '--show-scope', '-z', '--get-regexp', '^filter\\.'])
    expect(scan[2]).toMatchObject({ cwd: '/repo' })
    const over = filterOverrides('local\0filter.evil.clean\nsh plant.sh\0')
    expect([...over]).toEqual(['-c', 'filter.evil.clean=', '-c', 'filter.evil.smudge=', '-c', 'filter.evil.process=', '-c', 'filter.evil.required=false'])
    expect(command()).toEqual(guardGitArgs(['-C', '/sub', 'status', '--porcelain'], isWin, over))
  })

  it('exit 1 from git config means no driver: the read runs with nothing to switch off', async () => {
    answer(Object.assign(new Error('no match'), { code: 1 }))
    expect(await safeGitAsync(['diff', '--numstat'], { cwd: '/repo' })).toBe('ok')
    expect(command()).toEqual(guardGitArgs(['diff', '--numstat'], isWin, filterOverrides('')))
  })

  it('a git too old for the scan (no --show-scope before 2.26: a usage error, exit 129) fails every read that needs it with the old-git message, never a blank', async () => {
    const usage = Object.assign(new Error('Command failed'), { code: 129, stderr: "error: unknown option `show-scope'" })
    answer(usage)
    const tooOld = safeGitAsync(['status', '--porcelain', '-b', '-z'], { cwd: '/repo' })
    await expect(tooOld).rejects.toBeInstanceOf(GitTooOldError)
    await expect(tooOld).rejects.toThrow(OLD_GIT_MESSAGE)
    await expect(tooOld).rejects.toMatchObject({ code: 'GIT_TOO_OLD', name: 'GitTooOldError' })
    await expect(safeGitAsync(['diff', '--numstat'], { cwd: '/repo' })).rejects.toThrow(OLD_GIT_MESSAGE)
    expect(command()).toBeUndefined()
    // A read that needs no scan still runs on the old git.
    expect(await safeGitAsync(['rev-parse', 'HEAD'], { cwd: '/repo' })).toBe('ok')
  })

  it('any other failure of the read fails the command, which never runs, and is not kept', async () => {
    answer(Object.assign(new Error('fatal: bad config line 3'), { code: 128 }))
    await expect(safeGitAsync(['status'], { cwd: '/repo' })).rejects.toThrow(/bad config/)
    expect(command()).toBeUndefined()
    answer('')
    expect(await safeGitAsync(['status'], { cwd: '/repo' })).toBe('ok')
    expect(scans()).toBe(2)
  })

  it('a driver that cannot be switched off refuses the read', async () => {
    answer('local\0filter.a=b.clean\nx\0')
    await expect(safeGitAsync(['status'], { cwd: '/repo' })).rejects.toBeInstanceOf(UnsafeFilterError)
    expect(command()).toBeUndefined()
  })

  it('outside a repository every read is scanned, even two at once in the same folder', async () => {
    answer('')
    await Promise.all([safeGitAsync(['status'], { cwd: '/repo' }), safeGitAsync(['diff'], { cwd: '/repo' })])
    await safeGitAsync(['status'], { cwd: '/repo' })
    expect(scans()).toBe(3)
  })

  it('a read that needs no scan starts one git, and an ENOENT from the scan forgets the git it found', async () => {
    answer('')
    await safeGitAsync(['rev-parse', 'HEAD'], { cwd: '/repo' })
    expect(scans()).toBe(0)
    answer(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
    await expect(safeGitAsync(['status'], { cwd: '/repo2' })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(bin.forgets).toBe(2)
  })

  it('a write runs exactly as written, with no scan', async () => {
    answer('local\0filter.lfs.clean\nx\0')
    await safeGitAsync(['add', '--', 'a.bin'], { cwd: '/repo' })
    expect(scans()).toBe(0)
    expect(command()).toEqual(['add', '--', 'a.bin'])
  })
})

describe('safeGitAsync: one filter scan per repository, kept while its config says the same', () => {
  type Cb = (e: Error | null, out: string, err: string) => void
  let tmp = ''
  const scans = (): number => mockExecFile.mock.calls.filter((c) => (c[1] as string[]).includes('--show-scope')).length
  const status = (cwd: string, args: string[] = ['status']): Promise<string> => safeGitAsync(args, { cwd })
  const later = (ms: number): void => vi.setSystemTime(Date.now() + ms)
  /** What git needs to take a folder as a git folder: a HEAD naming a ref, and objects/ and refs/. */
  const gitFolder = (gitDir: string, head = 'ref: refs/heads/main\n'): void => {
    mkdirSync(join(gitDir, 'objects'), { recursive: true })
    mkdirSync(join(gitDir, 'refs'), { recursive: true })
    writeFileSync(join(gitDir, 'HEAD'), head)
  }
  /** A repository: a `.git` folder holding `config`. */
  const repo = (name: string, config = '[core]\n\tbare = false\n'): string => {
    const dir = join(tmp, name)
    gitFolder(join(dir, '.git'))
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
    writeFileSync(join(dir, '.git', 'config'), config)
    return dir
  }
  /** How many scans `cwd` costs over three reads: 1 where one is kept, 3 where every read is scanned. */
  const scansOver3 = async (cwd: string, args?: string[]): Promise<number> => {
    mockExecFile.mockClear()
    for (let i = 0; i < 3; i++) await status(cwd, args)
    return scans()
  }
  beforeEach(() => {
    _resetGitBinForTests()
    vi.useFakeTimers({ toFake: ['Date'] })
    tmp = mkdtempSync(join(tmpdir(), 'tp-gitcmd-scan-'))
    mockExecFile.mockImplementation((_b: string, a: string[], _o: unknown, cb: Cb) => {
      if (a.includes('--show-scope')) return cb(Object.assign(new Error('none'), { code: 1 }), '', '')
      cb(null, '', '')
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('shares one scan across the repository’s folders for 30 s, then scans again', async () => {
    const dir = repo('r')
    await status(dir)
    later(3000)
    await status(join(dir, 'src', 'deep'))
    await status(join(dir, 'src'), ['-C', 'deep', 'diff'])
    expect(scans()).toBe(1)
    later(27_000)
    await status(dir)
    expect(scans()).toBe(2)
  })

  it('scans again as soon as the config or config.worktree text changes', async () => {
    const dir = repo('r')
    await status(dir)
    writeFileSync(join(dir, '.git', 'config'), '[filter "x"]\n\tclean = sh plant.sh\n')
    await status(dir)
    expect(scans()).toBe(2)
    writeFileSync(join(dir, '.git', 'config.worktree'), '[filter "y"]\n\tclean = sh plant.sh\n')
    await status(dir)
    expect(scans()).toBe(3)
    await status(dir)
    expect(scans()).toBe(3)
  })

  it('a linked worktree reads the common config its commondir names, and is keyed apart from the main one', async () => {
    const main = repo('main')
    const wtGit = join(main, '.git', 'worktrees', 'wt')
    mkdirSync(wtGit, { recursive: true })
    writeFileSync(join(wtGit, 'commondir'), '../..\n')
    writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/wt\n')
    const wt = join(tmp, 'wt')
    mkdirSync(join(wt, 'sub'), { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`)
    await status(join(wt, 'sub'))
    await status(wt)
    expect(scans()).toBe(1)
    await status(main)
    expect(scans()).toBe(2)
    writeFileSync(join(main, '.git', 'config'), '[filter "x"]\n\tclean = sh plant.sh\n')
    await status(wt)
    expect(scans()).toBe(3)
  })

  it('the hex HEAD of a detached checkout, and a 64-digit one, are a repository too', async () => {
    const a = repo('a')
    writeFileSync(join(a, '.git', 'HEAD'), `${'a'.repeat(40)}\n`)
    const b = repo('b')
    writeFileSync(join(b, '.git', 'HEAD'), 'b'.repeat(64))
    expect(await scansOver3(a)).toBe(1)
    expect(await scansOver3(b)).toBe(1)
  })

  it('a config that names another file, in any spelling or layout, is scanned on every read', async () => {
    for (const [i, config] of [
      '[include]\n\tpath = ../other.cfg\n',
      '[core][include]path = ../other.cfg\n',
      '[includeIf "gitdir:/x/"]\n\tpath = ../other.cfg\n',
      '[core]\n\tbare = false\n[  INCLUDE ]\n\tpath = x\n',
    ].entries()) expect(await scansOver3(repo(`inc${i}`, config)), config).toBe(3)
    const wt = repo('wt')
    writeFileSync(join(wt, '.git', 'config.worktree'), '[Include]\npath = x\n')
    expect(await scansOver3(wt)).toBe(3)
  })

  it('a committed git folder inside a repository whose scan is kept is a different repository, scanned on its own every time', async () => {
    const outer = repo('outer')
    await status(outer)
    // The reviewer's case: a clone holding a committed folder that is itself a git folder (HEAD, objects, refs, config).
    const evil = join(outer, 'evil')
    gitFolder(evil)
    writeFileSync(join(evil, 'config'), '[filter "x"]\n\tclean = sh plant.sh\n')
    expect(await scansOver3(evil)).toBe(3)
    expect(await scansOver3(join(evil, 'refs'))).toBe(3)
    // Any one of the three is enough to make the folder uncertain.
    for (const part of ['HEAD', 'objects', 'refs']) {
      const one = join(outer, `one-${part}`)
      mkdirSync(one)
      if (part === 'HEAD') writeFileSync(join(one, part), 'ref: refs/heads/main\n')
      else mkdirSync(join(one, part))
      expect(await scansOver3(one), part).toBe(3)
    }
    // The outer repository's own folders still share its scan.
    expect(await scansOver3(join(outer, 'src', 'deep'))).toBe(0)
  })

  it('a .git that git would skip or refuse means the read is not kept: empty, half a repository, a bad HEAD, a bad .git file', async () => {
    const outer = repo('outer')
    await status(outer)
    const sub = (name: string): string => {
      const dir = join(outer, name)
      mkdirSync(dir, { recursive: true })
      return dir
    }
    // The reviewer's case: an empty .git folder inside a repository whose scan is kept.
    const empty = sub('empty')
    mkdirSync(join(empty, '.git'))
    expect(await scansOver3(empty)).toBe(3)
    const head = (g: string): void => writeFileSync(join(g, 'HEAD'), 'ref: refs/heads/main\n')
    const makers: Array<[string, (g: string) => void]> = [
      ['no-objects', (g) => { mkdirSync(join(g, 'refs'), { recursive: true }); head(g) }],
      ['no-refs', (g) => { mkdirSync(join(g, 'objects'), { recursive: true }); head(g) }],
      ['no-head', (g) => { mkdirSync(join(g, 'objects'), { recursive: true }); mkdirSync(join(g, 'refs')) }],
      ['bad-head', (g) => gitFolder(g, 'not a ref\n')],
      ['head-folder', (g) => { mkdirSync(join(g, 'objects'), { recursive: true }); mkdirSync(join(g, 'refs')); mkdirSync(join(g, 'HEAD')) }],
      ['objects-file', (g) => { mkdirSync(join(g, 'refs'), { recursive: true }); writeFileSync(join(g, 'objects'), ''); head(g) }],
      ['config-folder', (g) => { gitFolder(g); mkdirSync(join(g, 'config')) }],
      ['commondir-folder', (g) => { gitFolder(g); mkdirSync(join(g, 'commondir')) }],
    ]
    for (const [name, make] of makers) {
      const dir = sub(name)
      make(join(dir, '.git'))
      expect(await scansOver3(dir), name).toBe(3)
    }
    for (const [name, text] of [['bad-file', 'not a pointer\n'], ['two-lines', 'gitdir: ../x\nmore\n'], ['to-nothing', 'gitdir: ../nowhere\n'], ['empty-file', '']]) {
      const dir = sub(name)
      writeFileSync(join(dir, '.git'), text)
      expect(await scansOver3(dir), name).toBe(3)
    }
    expect(await scansOver3(join(tmp, 'nowhere'))).toBe(3)
    expect(await scansOver3(tmp)).toBe(3)
  })

  it('a folder whose files cannot be read the usual way is scanned on every read', async () => {
    const dir = repo('odd')
    for (const fn of ['stat', 'lstat', 'readFile', 'realpath'] as const) {
      const spy = vi.spyOn(fsPromises, fn).mockRejectedValue(new Error('stand-in fs'))
      try {
        expect(await scansOver3(dir), fn).toBe(3)
      } finally {
        spy.mockRestore()
      }
    }
    const spy = vi.spyOn(fsPromises, 'stat').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    try {
      expect(await scansOver3(dir)).toBe(3)
    } finally {
      spy.mockRestore()
    }
    expect(await scansOver3(dir)).toBe(1)
  })

  it('with an environment variable that moves git to another repository or changes where it stops looking, every read is scanned', async () => {
    const dir = repo('env')
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']) {
      vi.stubEnv(k, join(tmp, 'elsewhere'))
      try {
        expect(await scansOver3(dir), k).toBe(3)
      } finally {
        vi.unstubAllEnvs()
      }
    }
  })

  it('a slow scan that fails after a newer one replaced it does not drop the newer one', async () => {
    const dir = repo('slow')
    let late: Cb | undefined
    mockExecFile.mockImplementationOnce((_b: string, _a: string[], _o: unknown, cb: Cb) => { late = cb })
    const first = status(dir)
    await vi.waitFor(() => expect(late).toBeDefined())
    later(30_000)
    await status(dir)
    late?.(Object.assign(new Error('fatal: bad config'), { code: 128 }), '', '')
    await expect(first).rejects.toThrow(/bad config/)
    await status(dir)
    expect(scans()).toBe(2)
  })

  it('a --git-dir names the repository whose config is read', async () => {
    const a = repo('a')
    const b = repo('b')
    await status(tmp, ['--git-dir', join(a, '.git'), 'status'])
    await status(tmp, [`--git-dir=${join(a, '.git')}`, 'status'])
    expect(scans()).toBe(2)
    await status(tmp, ['--git-dir', join(a, '.git'), 'status'])
    expect(scans()).toBe(2)
    await status(tmp, ['--git-dir', join(b, '.git'), 'status'])
    expect(scans()).toBe(3)
    // A --git-dir git would not take as a repository is not kept.
    mkdirSync(join(tmp, 'half'))
    expect(await scansOver3(tmp, ['--git-dir', join(tmp, 'half'), 'status'])).toBe(3)
  })

  it('remembers at most 64 scans, dropping expired ones first, then the oldest', async () => {
    const first = repo('first')
    await status(first)
    for (let i = 0; i < 64; i++) await status(repo(`r${i}`))
    await status(first)
    expect(scans()).toBe(66)
    // Expired entries are cleared when the next scan is kept, so the map never holds a stale one past its window.
    later(30_000)
    await status(first)
    expect(scans()).toBe(67)
    await status(repo('r0'))
    expect(scans()).toBe(68)
  })
})

describe('safeGitAsync: a status writes each submodule\'s dirty state back in', () => {
  type Cb = (e: Error | null, out: string, err: string) => void
  let tmp = ''
  /** A folder holding `.git`, and with `subs`, a .gitmodules listing each with its own `.git`. */
  const repo = (name: string, subs: string[] = []): string => {
    const dir = join(tmp, name)
    mkdirSync(join(dir, '.git'), { recursive: true })
    if (subs.length > 0) {
      writeFileSync(join(dir, '.gitmodules'), subs.map((s) => `[submodule "${s}"]\n\tpath = ${s}\n`).join(''))
      for (const s of subs) mkdirSync(join(dir, s, '.git'), { recursive: true })
    }
    return dir
  }
  const subStatuses = (): string[] => mockExecFile.mock.calls
    .filter((c) => (c[1] as string[]).includes('status') && /[\\/]s$/.test((c[2] as { cwd: string }).cwd))
    .map((c) => (c[2] as { cwd: string }).cwd)
  beforeEach(() => {
    _resetGitBinForTests()
    tmp = mkdtempSync(join(tmpdir(), 'tp-gitcmd-sub-'))
    mockExecFile.mockImplementation((_b: string, a: string[], o: { cwd: string }, cb: Cb) => {
      if (a.includes('--show-scope')) return cb(Object.assign(new Error('none'), { code: 1 }), '', '')
      if (a.includes('ls-files')) return cb(null, '160000 a 0\ts\0', '')
      if (a.includes('status')) return cb(null, /[\\/]s$/.test(o.cwd) ? ' M f\0' : '', '')
      cb(null, '', '')
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('asks the submodule once for the cache window, then again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const dir = repo('one', ['s'])
    expect(await safeGitAsync(['status', '--porcelain', '-z'], { cwd: dir })).toBe(' M s\0')
    expect(await safeGitAsync(['status', '--porcelain', '-z'], { cwd: join(dir, 's', '..') })).toBe(' M s\0')
    expect(subStatuses()).toHaveLength(1)
    vi.setSystemTime(Date.now() + 1500)
    await safeGitAsync(['status', '--porcelain', '-z'], { cwd: dir })
    expect(subStatuses()).toHaveLength(2)
  })

  it('remembers at most 64 repositories, dropping the oldest', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const first = repo('first', ['s'])
    await safeGitAsync(['status', '--porcelain'], { cwd: first })
    for (let i = 0; i < 64; i++) await safeGitAsync(['status', '--porcelain'], { cwd: repo(`r${i}`) })
    expect(subStatuses()).toHaveLength(1)
    await safeGitAsync(['status', '--porcelain'], { cwd: first })
    expect(subStatuses()).toHaveLength(2)
  })

  it('the planted 8×3 tree on disk: one poll starts at most 64 git calls in its submodules, over every level, and at most 4 at once', async () => {
    const names = Array.from({ length: 8 }, (_, i) => `m${i}`)
    const plant = (dir: string, level: number): void => {
      mkdirSync(join(dir, '.git'), { recursive: true })
      if (level === 3) return
      writeFileSync(join(dir, '.gitmodules'), names.map((s) => `[submodule "${s}"]\n\tpath = ${s}\n`).join(''))
      for (const s of names) plant(join(dir, s), level + 1)
    }
    const top = join(tmp, 'planted')
    plant(top, 0)
    let running = 0
    let most = 0
    let inSubs = 0
    mockExecFile.mockImplementation((_b: string, a: string[], o: { cwd: string }, cb: Cb) => {
      if (a.includes('--show-scope')) return cb(Object.assign(new Error('none'), { code: 1 }), '', '')
      if (o.cwd !== top) inSubs++
      running++
      most = Math.max(most, running)
      setTimeout(() => {
        running--
        cb(null, a.includes('ls-files') ? names.map((s) => `160000 a 0\t${s}`).join('\0') : '', '')
      }, 1)
    })
    await safeGitAsync(['status', '--porcelain', '-z'], { cwd: top })
    // The superproject's own status and listing, then at most 63 more: the status every submodule asks of its own
    // submodules is not folded again.
    const ownStatuses = mockExecFile.mock.calls.filter((c) => (c[1] as string[]).includes('status') && (c[2] as { cwd: string }).cwd === top)
    expect(ownStatuses).toHaveLength(1)
    expect(inSubs).toBeLessThanOrEqual(63)
    expect(inSubs).toBeGreaterThan(8)
    expect(most).toBeLessThanOrEqual(4)
  })

  it('outside any repository, or with no .gitmodules, the status is as git wrote it', async () => {
    expect(await repoTopLevel(join(tmp, 'nowhere', 'deeper'))).toBeNull()
    const plain = repo('plain')
    expect(await repoTopLevel(join(plain, 'a', 'b'))).toBe(plain)
    expect(await safeGitAsync(['status', '--porcelain', '-z'], { cwd: plain })).toBe('')
    // Listed, but never checked out (no `s/.git`): not looked into.
    const unchecked = repo('unchecked', ['s'])
    rmSync(join(unchecked, 's', '.git'), { recursive: true })
    expect(await safeGitAsync(['status', '--porcelain', '-z'], { cwd: unchecked })).toBe('')
    expect(subStatuses()).toEqual([])
  })
})

describe('isValidGitRef — additional edge cases beyond security.test', () => {
  it('returns false for boolean true', () => {
    expect(isValidGitRef(true)).toBe(false)
  })

  it('returns false for plain object', () => {
    expect(isValidGitRef({})).toBe(false)
  })

  it('returns false for ref containing the range operator ".." anywhere', () => {
    expect(isValidGitRef('main..feature')).toBe(false)
    expect(isValidGitRef('feature..')).toBe(false)
    expect(isValidGitRef('..main')).toBe(false)
  })

  it('255 chars is the max accepted length', () => {
    expect(isValidGitRef('a'.repeat(255))).toBe(true)
    expect(isValidGitRef('a'.repeat(256))).toBe(false)
  })
})

describe('parseSafeCommand — defensive paths', () => {
  it('returns Empty error for null-ish input', () => {
    expect(parseSafeCommand('')).toEqual({ error: 'Empty command' })
  })

  it('returns Empty error for whitespace-only input', () => {
    expect(parseSafeCommand('   \t  ')).toEqual({ error: 'Empty command' })
  })

  it('preserves arg order including double-dash sentinels', () => {
    expect(parseSafeCommand('npm test -- --bail')).toEqual({
      bin: 'npm', args: ['test', '--', '--bail'],
    })
  })
})

// runSafeCommandAsync — the same platform split as the sync twin, one layer further out.
//
// v1.47.1 moved every spawn into the proc host, and this function kept the branch it has always had:
// a SHELL on win32, where npm/npx are `.cmd` shims a shell-less spawn cannot resolve at all, and
// plain argv everywhere else. A branch like that is INVISIBLE to a win32-only test run — which is
// precisely how v1.47.1 went green on Windows and red on macOS and Ubuntu, with three swarm
// run-command tests reporting a cheerful exit code 0 and no output. Both sides are pinned here so
// the next person to touch this line finds out on their own machine.
describe('runSafeCommandAsync', () => {
  const origPlatform = process.platform
  const setPlatform = (p: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true })
  }
  type Cb = (e: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void

  /** Arm the argv spawn (non-win32). */
  const argvAnswers = (e: NodeJS.ErrnoException | null, out = '', err = ''): void => {
    mockExecFile.mockImplementation((_b: string, _a: string[], _o: unknown, cb: Cb) => cb(e, out, err))
  }
  /** Arm the shell spawn (win32), and the interactive-PATH probe that shares it. */
  const shellAnswers = (e: NodeJS.ErrnoException | null, out = '', err = ''): void => {
    mockExec.mockImplementation((_c: string, _o: unknown, cb: Cb) => cb(e, out, err))
  }
  /** The shell calls that are the command under test, not the PATH probe. */
  const shellRuns = (): string[] => mockExec.mock.calls.map((c) => c[0] as string).filter((c) => c.startsWith('npm'))

  beforeEach(() => {
    setPlatform(origPlatform)
    argvAnswers(null)
    shellAnswers(null)
  })
  afterEach(() => setPlatform(origPlatform))

  it('spawns through a SHELL on win32, as one command line, so a .cmd shim resolves', async () => {
    setPlatform('win32')
    shellAnswers(null, 'ok')
    await expect(runSafeCommandAsync({ bin: 'npm', args: ['test'] }, { cwd: '/r' })).resolves.toEqual({
      output: 'ok',
      exitCode: 0,
    })
    expect(shellRuns()).toEqual(['npm test'])
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('spawns argv-style everywhere else, with the args kept apart and no shell', async () => {
    setPlatform('linux')
    argvAnswers(null, 'ok')
    await expect(runSafeCommandAsync({ bin: 'npm', args: ['test'] }, { cwd: '/r' })).resolves.toEqual({
      output: 'ok',
      exitCode: 0,
    })
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    expect(mockExecFile.mock.calls[0][0]).toBe('npm')
    expect(mockExecFile.mock.calls[0][1]).toEqual(['test'])
    expect((mockExecFile.mock.calls[0][2] as { shell: boolean }).shell).toBe(false)
    expect(shellRuns()).toEqual([])
  })

  it('reports the real exit code and everything the command printed — argv side', async () => {
    setPlatform('darwin')
    argvAnswers(Object.assign(new Error('Command failed'), { code: 2 }), 'on stdout', 'on stderr')
    await expect(runSafeCommandAsync({ bin: 'npm', args: ['test'] }, { cwd: '/r' })).resolves.toEqual({
      output: 'on stdouton stderr',
      exitCode: 2,
    })
  })

  it('reports the real exit code and everything the command printed — shell side', async () => {
    setPlatform('win32')
    shellAnswers(Object.assign(new Error('Command failed'), { code: 2 }), 'on stdout', 'on stderr')
    await expect(runSafeCommandAsync({ bin: 'npm', args: ['test'] }, { cwd: '/r' })).resolves.toEqual({
      output: 'on stdouton stderr',
      exitCode: 2,
    })
  })

  it('falls back to exit code 1 when the failure carries no numeric code', async () => {
    // ENOENT is a STRING code: the command never ran. Passing that through as the exit code would
    // hand the caller `exitCode: 'ENOENT'`, which every `=== 0` check upstream reads as failure of
    // an unknown kind. 1 is the honest answer.
    setPlatform('linux')
    argvAnswers(Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }), '', 'not found')
    await expect(runSafeCommandAsync({ bin: 'npm', args: ['test'] }, { cwd: '/r' })).resolves.toEqual({
      output: 'not found',
      exitCode: 1,
    })
  })

  it('honours the caller timeout and maxBuffer, and defaults them to 10min / 16MB', async () => {
    setPlatform('linux')
    await runSafeCommandAsync({ bin: 'npm', args: [] }, { cwd: '/r', timeout: 5000, maxBuffer: 8 })
    expect(mockExecFile.mock.calls[0][2]).toMatchObject({ cwd: '/r', timeout: 5000, maxBuffer: 8 })
    mockExecFile.mockClear()
    await runSafeCommandAsync({ bin: 'npm', args: [] }, { cwd: '/r' })
    expect(mockExecFile.mock.calls[0][2]).toMatchObject({ timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
  })
})
