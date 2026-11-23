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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { safeGitAsync, runSafeCommandAsync, parseSafeCommand, isValidGitRef, repoTopLevel, _resetGitBinForTests } from '../../src/main/gitCommand'
import { guardGitArgs, UnsafeFilterError } from '../../src/main/gitSafety'

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
    const over = ['-c', 'filter.evil.clean=', '-c', 'filter.evil.smudge=', '-c', 'filter.evil.process=', '-c', 'filter.evil.required=false']
    expect(command()).toEqual(guardGitArgs(['-C', '/sub', 'status', '--porcelain'], isWin, over))
  })

  it('exit 1 from git config means no driver: the read runs with nothing to switch off', async () => {
    answer(Object.assign(new Error('no match'), { code: 1 }))
    expect(await safeGitAsync(['diff', '--numstat'], { cwd: '/repo' })).toBe('ok')
    expect(command()).toEqual(guardGitArgs(['diff', '--numstat'], isWin))
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

  it('one scan is shared for 1.5 s per folder and command, then read again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    answer('')
    await Promise.all([safeGitAsync(['status'], { cwd: '/repo' }), safeGitAsync(['diff'], { cwd: '/repo' })])
    expect(scans()).toBe(1)
    await safeGitAsync(['status'], { cwd: '/other' })
    expect(scans()).toBe(2)
    vi.setSystemTime(Date.now() + 1500)
    await safeGitAsync(['status'], { cwd: '/repo' })
    expect(scans()).toBe(3)
  })

  it('a slow scan that fails after a newer one replaced it does not drop the newer one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let late: Cb | undefined
    mockExecFile.mockImplementationOnce((_b: string, _a: string[], _o: unknown, cb: Cb) => { late = cb })
    const first = safeGitAsync(['status'], { cwd: '/repo' })
    await vi.waitFor(() => expect(late).toBeDefined())
    vi.setSystemTime(Date.now() + 1500)
    answer('')
    expect(await safeGitAsync(['status'], { cwd: '/repo' })).toBe('ok')
    late?.(Object.assign(new Error('fatal: bad config'), { code: 128 }), '', '')
    await expect(first).rejects.toThrow(/bad config/)
    await safeGitAsync(['status'], { cwd: '/repo' })
    expect(scans()).toBe(2)
  })

  it('a read that needs no scan starts one git, and an ENOENT from the scan forgets the git it found', async () => {
    answer('')
    await safeGitAsync(['log', '-1'], { cwd: '/repo' })
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
