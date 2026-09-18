// Direct unit tests for gitCommand.ts. The IPC-layer security tests in
// security.test.ts cover argv-injection rejection paths, but they don't
// exercise safeGit / runSafeCommand defaults or the platform-specific
// execFileSync vs execSync split — that's what this file is for.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockExecSync, mockExecFileSync, mockExistsSync, mockExec, mockExecFile } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  // The callback flavours. With no proc host wired up, procClient runs the spawn in-process through
  // exactly these, so they are what the ASYNC half of this module reaches.
  mockExec: vi.fn(),
  mockExecFile: vi.fn(),
}))

vi.mock('child_process', () => ({
  default: { execSync: mockExecSync, execFileSync: mockExecFileSync, exec: mockExec, execFile: mockExecFile },
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
  exec: mockExec,
  execFile: mockExecFile,
}))
vi.mock('fs', () => ({ existsSync: mockExistsSync, default: { existsSync: mockExistsSync } }))

import { safeGit, runSafeCommand, runSafeCommandAsync, parseSafeCommand, isValidGitRef, _resetGitBinForTests } from '../../src/main/gitCommand'

beforeEach(() => {
  mockExecSync.mockReset()
  mockExecFileSync.mockReset()
  mockExistsSync.mockReset()
  mockExec.mockReset()
  mockExecFile.mockReset()
  _resetGitBinForTests()
})

describe('safeGit — git-not-on-PATH fallback', () => {
  it('resolves git from a known install path when the PATH lookup ENOENTs, and caches it', () => {
    const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    mockExecFileSync.mockImplementationOnce(() => { throw enoent }) // `git` on PATH → not found
    mockExistsSync.mockImplementation((p: string) => String(p).toLowerCase().includes('git')) // an install exists
    mockExecFileSync.mockReturnValue(Buffer.from('/repo/root\n')) // the resolved absolute git works
    expect(safeGit(['rev-parse', '--show-toplevel'], { cwd: '/repo' }).trim()).toBe('/repo/root')
    // cached: a second call does NOT retry `git` on PATH (no more ENOENT path)
    mockExecFileSync.mockClear()
    expect(safeGit(['rev-parse', 'HEAD'], { cwd: '/repo' }).trim()).toBe('/repo/root')
    expect(mockExecFileSync).toHaveBeenCalledTimes(1)
  })

  it('re-throws a genuine git error (not ENOENT) without falling back', () => {
    const notRepo = Object.assign(new Error('not a git repository'), { status: 128 })
    mockExecFileSync.mockImplementation(() => { throw notRepo })
    expect(() => safeGit(['rev-parse', '--show-toplevel'], { cwd: '/tmp' })).toThrow(/not a git repository/)
    expect(mockExistsSync).not.toHaveBeenCalled() // no fallback attempted
  })
})

describe('safeGit', () => {
  it('uses 10000ms timeout default when opts.timeout is omitted', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('out'))
    safeGit(['status'], { cwd: '/r' })
    const callOpts = mockExecFileSync.mock.calls[0][2]
    expect(callOpts.timeout).toBe(10000)
  })

  it('honors caller-supplied timeout', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('out'))
    safeGit(['status'], { cwd: '/r', timeout: 5000 })
    expect(mockExecFileSync.mock.calls[0][2].timeout).toBe(5000)
  })

  it('uses 1MB maxBuffer default when omitted', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('out'))
    safeGit(['status'], { cwd: '/r' })
    expect(mockExecFileSync.mock.calls[0][2].maxBuffer).toBe(1024 * 1024)
  })

  it('honors caller-supplied maxBuffer', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('out'))
    safeGit(['status'], { cwd: '/r', maxBuffer: 2 * 1024 * 1024 })
    expect(mockExecFileSync.mock.calls[0][2].maxBuffer).toBe(2 * 1024 * 1024)
  })

  it('passes shell:false so metacharacters in argv are literal', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''))
    safeGit(['log', '--format=%H'], { cwd: '/r' })
    expect(mockExecFileSync.mock.calls[0][2].shell).toBe(false)
    expect(mockExecFileSync.mock.calls[0][2].windowsHide).toBe(true)
  })

  it('returns the buffer toString() output', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('hello world'))
    expect(safeGit(['status'], { cwd: '/r' })).toBe('hello world')
  })
})

describe('runSafeCommand', () => {
  const origPlatform = process.platform

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true })
  }

  beforeEach(() => setPlatform(origPlatform))

  it('uses execSync on Windows (.cmd shim resolution)', () => {
    setPlatform('win32')
    mockExecSync.mockReturnValue(Buffer.from('ok'))
    const r = runSafeCommand({ bin: 'npm', args: ['test'] }, { cwd: '/r' })
    expect(r).toEqual({ output: 'ok', exitCode: 0 })
    expect(mockExecSync).toHaveBeenCalledTimes(1)
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('uses execFileSync on Linux/macOS (shell:false)', () => {
    setPlatform('linux')
    mockExecFileSync.mockReturnValue(Buffer.from('ok'))
    const r = runSafeCommand({ bin: 'npm', args: ['test'] }, { cwd: '/r' })
    expect(r).toEqual({ output: 'ok', exitCode: 0 })
    expect(mockExecFileSync).toHaveBeenCalledTimes(1)
    expect(mockExecFileSync.mock.calls[0][2].shell).toBe(false)
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('default timeout is 10 minutes when opts.timeout is omitted (linux path)', () => {
    setPlatform('linux')
    mockExecFileSync.mockReturnValue(Buffer.from(''))
    runSafeCommand({ bin: 'npm', args: [] }, { cwd: '/r' })
    expect(mockExecFileSync.mock.calls[0][2].timeout).toBe(10 * 60 * 1000)
  })

  it('default timeout is 10 minutes when opts.timeout is omitted (win32 path)', () => {
    setPlatform('win32')
    mockExecSync.mockReturnValue(Buffer.from(''))
    runSafeCommand({ bin: 'npm', args: [] }, { cwd: '/r' })
    expect(mockExecSync.mock.calls[0][1].timeout).toBe(10 * 60 * 1000)
  })

  it('default maxBuffer is 16MB when omitted (linux)', () => {
    setPlatform('linux')
    mockExecFileSync.mockReturnValue(Buffer.from(''))
    runSafeCommand({ bin: 'npm', args: [] }, { cwd: '/r' })
    expect(mockExecFileSync.mock.calls[0][2].maxBuffer).toBe(16 * 1024 * 1024)
  })

  it('default maxBuffer is 16MB when omitted (win32)', () => {
    setPlatform('win32')
    mockExecSync.mockReturnValue(Buffer.from(''))
    runSafeCommand({ bin: 'npm', args: [] }, { cwd: '/r' })
    expect(mockExecSync.mock.calls[0][1].maxBuffer).toBe(16 * 1024 * 1024)
  })

  // The mac PATH fix: the child must run with an EXTENDED PATH, not the bare launchd PATH a
  // GUI-launched app inherits — otherwise npm/pnpm/pytest ENOENT and the swarm test-runner records a
  // fabricated failure into the competence store. getExtendedPath always appends the current PATH
  // last, so the child's PATH is a superset of the parent's.
  it('runs the child with an extended PATH env (linux/macOS path)', () => {
    setPlatform('linux')
    mockExecFileSync.mockReturnValue(Buffer.from(''))
    runSafeCommand({ bin: 'npm', args: ['test'] }, { cwd: '/r' })
    const env = mockExecFileSync.mock.calls[0][2].env
    expect(env).toBeDefined()
    expect(typeof env.PATH).toBe('string')
    if (process.env.PATH) expect(env.PATH).toContain(process.env.PATH) // superset of the parent PATH
  })

  it('also passes the extended PATH env on win32', () => {
    setPlatform('win32')
    mockExecSync.mockReturnValue(Buffer.from(''))
    runSafeCommand({ bin: 'npm', args: ['test'] }, { cwd: '/r' })
    const env = mockExecSync.mock.calls[0][1].env
    expect(env).toBeDefined()
    expect(typeof env.PATH).toBe('string')
  })

  it('honors caller-supplied timeout + maxBuffer (linux)', () => {
    setPlatform('linux')
    mockExecFileSync.mockReturnValue(Buffer.from(''))
    runSafeCommand({ bin: 'npm', args: [] }, { cwd: '/r', timeout: 5000, maxBuffer: 8 })
    expect(mockExecFileSync.mock.calls[0][2].timeout).toBe(5000)
    expect(mockExecFileSync.mock.calls[0][2].maxBuffer).toBe(8)
  })

  it('honors caller-supplied timeout + maxBuffer (win32)', () => {
    setPlatform('win32')
    mockExecSync.mockReturnValue(Buffer.from(''))
    runSafeCommand({ bin: 'npm', args: [] }, { cwd: '/r', timeout: 5000, maxBuffer: 8 })
    expect(mockExecSync.mock.calls[0][1].timeout).toBe(5000)
    expect(mockExecSync.mock.calls[0][1].maxBuffer).toBe(8)
  })

  it('captures e.stdout + e.stderr when child exits non-zero', () => {
    setPlatform('linux')
    const err: any = new Error('exit 1')
    err.stdout = Buffer.from('partial out\n')
    err.stderr = Buffer.from('error msg\n')
    err.status = 1
    mockExecFileSync.mockImplementation(() => { throw err })
    const r = runSafeCommand({ bin: 'npm', args: ['test'] }, { cwd: '/r' })
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain('partial out')
    expect(r.output).toContain('error msg')
  })

  it('falls back to exitCode=1 when e.status is missing', () => {
    setPlatform('linux')
    const err: any = new Error('killed')
    err.stdout = undefined
    err.stderr = undefined
    mockExecFileSync.mockImplementation(() => { throw err })
    const r = runSafeCommand({ bin: 'npm', args: [] }, { cwd: '/r' })
    expect(r.exitCode).toBe(1)
    expect(r.output).toBe('')
  })

  it('falls back to exitCode=1 when e.status is non-numeric', () => {
    setPlatform('linux')
    const err: any = new Error('killed')
    err.status = 'SIGKILL'
    mockExecFileSync.mockImplementation(() => { throw err })
    const r = runSafeCommand({ bin: 'npm', args: [] }, { cwd: '/r' })
    expect(r.exitCode).toBe(1)
  })

  it('handles missing stdout (only stderr present)', () => {
    setPlatform('linux')
    const err: any = new Error('boom')
    err.stderr = Buffer.from('only stderr')
    err.status = 2
    mockExecFileSync.mockImplementation(() => { throw err })
    const r = runSafeCommand({ bin: 'npm', args: [] }, { cwd: '/r' })
    expect(r.output).toBe('only stderr')
    expect(r.exitCode).toBe(2)
  })

  it('handles missing stderr (only stdout present)', () => {
    setPlatform('linux')
    const err: any = new Error('boom')
    err.stdout = Buffer.from('only stdout')
    err.status = 3
    mockExecFileSync.mockImplementation(() => { throw err })
    const r = runSafeCommand({ bin: 'npm', args: [] }, { cwd: '/r' })
    expect(r.output).toBe('only stdout')
    expect(r.exitCode).toBe(3)
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
