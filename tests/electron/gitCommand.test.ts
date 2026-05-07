// Direct unit tests for gitCommand.ts. The IPC-layer security tests in
// security.test.ts cover argv-injection rejection paths, but they don't
// exercise safeGit / runSafeCommand defaults or the platform-specific
// execFileSync vs execSync split — that's what this file is for.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockExecSync, mockExecFileSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockExecFileSync: vi.fn(),
}))

vi.mock('child_process', () => ({
  default: { execSync: mockExecSync, execFileSync: mockExecFileSync },
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
}))

import { safeGit, runSafeCommand, parseSafeCommand, isValidGitRef } from '../../src/main/gitCommand'

beforeEach(() => {
  mockExecSync.mockReset()
  mockExecFileSync.mockReset()
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
