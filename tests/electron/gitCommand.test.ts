// Direct unit tests for gitCommand.ts. The IPC-layer security tests in
// security.test.ts cover argv-injection rejection paths, but they don't
// exercise safeGitAsync / runSafeCommandAsync defaults or the platform-specific
// exec vs execFile split — that's what this file is for.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockExec, mockExecFile, mockAccess } = vi.hoisted(() => ({
  // The callback flavours. With no proc host wired up, procClient runs the spawn in-process through
  // exactly these.
  mockExec: vi.fn(),
  mockExecFile: vi.fn(),
  // The thread-pool lookup of the git install locations.
  mockAccess: vi.fn(),
}))

vi.mock('child_process', () => ({
  default: { exec: mockExec, execFile: mockExecFile },
  exec: mockExec,
  execFile: mockExecFile,
}))
vi.mock('fs', () => ({ promises: { access: mockAccess }, default: { promises: { access: mockAccess } } }))

import { safeGitAsync, runSafeCommandAsync, parseSafeCommand, isValidGitRef, _resetGitBinForTests } from '../../src/main/gitCommand'

beforeEach(() => {
  mockExec.mockReset()
  mockExecFile.mockReset()
  mockAccess.mockReset()
  _resetGitBinForTests()
})

// safeGitAsync runs git in the proc host; with none wired up (here) procClient runs the same call in-process through
// execFile, which is what the mock below answers. There is no synchronous safeGit or runSafeCommand any more.
describe('safeGitAsync — git-not-on-PATH fallback', () => {
  const enoent = (): Error => Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
  type Cb = (e: Error | null, out: string, err: string) => void

  it('resolves git from a known install path when the PATH lookup ENOENTs, and caches it', async () => {
    mockExecFile.mockImplementation((bin: string, _a: string[], _o: unknown, cb: Cb) => {
      if (bin === 'git') return cb(enoent(), '', '') // `git` on PATH → not found
      cb(null, '/repo/root\n', '') // the resolved absolute git works
    })
    mockAccess.mockImplementation(async (p: string) => { if (!String(p).toLowerCase().includes('git')) throw enoent() }) // an install exists
    expect((await safeGitAsync(['rev-parse', '--show-toplevel'], { cwd: '/repo' })).trim()).toBe('/repo/root')
    // cached: a second call does NOT retry `git` on PATH (no more ENOENT path)
    mockExecFile.mockClear()
    expect((await safeGitAsync(['rev-parse', 'HEAD'], { cwd: '/repo' })).trim()).toBe('/repo/root')
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    expect(mockExecFile.mock.calls[0][0]).not.toBe('git')
  })

  it('looks for the install on the thread pool: it never calls a synchronous existence check', async () => {
    mockExecFile.mockImplementation((bin: string, _a: string[], _o: unknown, cb: Cb) => (bin === 'git' ? cb(enoent(), '', '') : cb(null, 'ok\n', '')))
    mockAccess.mockResolvedValue(undefined)
    await safeGitAsync(['status'], { cwd: '/repo' })
    expect(mockAccess).toHaveBeenCalled()
  })

  it('re-throws a genuine git error (not ENOENT) without falling back', async () => {
    const notRepo = Object.assign(new Error('not a git repository'), { code: 128 })
    mockExecFile.mockImplementation((_b: string, _a: string[], _o: unknown, cb: Cb) => cb(notRepo, '', 'fatal: not a git repository'))
    await expect(safeGitAsync(['rev-parse', '--show-toplevel'], { cwd: '/tmp' })).rejects.toThrow(/not a git repository/)
    expect(mockAccess).not.toHaveBeenCalled() // no fallback attempted
  })

  it('throws the ENOENT when no install exists anywhere', async () => {
    mockExecFile.mockImplementation((_b: string, _a: string[], _o: unknown, cb: Cb) => cb(enoent(), '', ''))
    mockAccess.mockRejectedValue(enoent())
    await expect(safeGitAsync(['status'], { cwd: '/repo' })).rejects.toMatchObject({ code: 'ENOENT' })
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
