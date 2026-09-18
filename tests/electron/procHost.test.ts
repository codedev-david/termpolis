// procHost — the utilityProcess that owns every spawn (src/main/procHost.ts).
//
// What matters here is not that a command runs; it is the SHAPE of what comes back. This module is
// a wire boundary: results cross a postMessage, so an Error object cannot, and the fields callers
// branch on have to survive as plain data. Two of those fields decide real behaviour upstream —
// `code === 'ENOENT'` is what makes gitCommand go looking for git in the install locations, and a
// numeric `code` is what makes it give up instead. Getting that distinction wrong would turn "git
// is not on PATH" into "your repo is broken", silently.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const H = vi.hoisted(() => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}))

vi.mock('child_process', () => ({
  default: { execFile: H.execFile, exec: H.exec },
  execFile: H.execFile,
  exec: H.exec,
}))

import {
  runExec,
  runShell,
  serializeProcError,
  handleProcMessage,
  type ProcRequest,
} from '../../src/main/procHost'

type ExecFileCb = (e: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void
type ExecOpts = { cwd?: string; timeout: number; maxBuffer: number; windowsHide: true; env?: unknown; shell?: false }

/** Arm execFile to answer one way for every call. */
function execFileAnswers(err: NodeJS.ErrnoException | null, stdout = '', stderr = ''): void {
  H.execFile.mockImplementation((_bin: string, _args: string[], _o: unknown, cb: ExecFileCb) => cb(err, stdout, stderr))
}
function execAnswers(err: NodeJS.ErrnoException | null, stdout = '', stderr = ''): void {
  H.exec.mockImplementation((_cmd: string, _o: unknown, cb: ExecFileCb) => cb(err, stdout, stderr))
}
const lastExecFileOpts = (): ExecOpts => H.execFile.mock.calls.at(-1)![2] as ExecOpts
const lastExecOpts = (): ExecOpts => H.exec.mock.calls.at(-1)![1] as ExecOpts

beforeEach(() => {
  H.execFile.mockReset()
  H.exec.mockReset()
  execFileAnswers(null)
  execAnswers(null)
})

describe('serializeProcError — an Error cannot cross postMessage, so this is what does', () => {
  it('keeps the string code that means "no such binary"', () => {
    const e: NodeJS.ErrnoException = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    expect(serializeProcError(e)).toEqual({ message: 'spawn git ENOENT', code: 'ENOENT' })
  })

  it('keeps a NUMERIC code as a number — "ran and exited 1" is not "could not run"', () => {
    const e: NodeJS.ErrnoException = Object.assign(new Error('Command failed'), { code: 1 })
    const out = serializeProcError(e)
    expect(out.code).toBe(1)
    expect(typeof out.code).toBe('number')
  })

  it('carries signal and killed, which is how a caller tells slow from broken', () => {
    const e = Object.assign(new Error('timed out'), { signal: 'SIGTERM', killed: true })
    expect(serializeProcError(e)).toEqual({ message: 'timed out', signal: 'SIGTERM', killed: true })
  })

  it('omits the optional fields entirely rather than sending undefined across the wire', () => {
    expect(Object.keys(serializeProcError(new Error('plain')))).toEqual(['message'])
  })

  it('does not invent a `killed: false`, which would read as a deliberate statement', () => {
    const e = Object.assign(new Error('x'), { killed: false })
    expect('killed' in serializeProcError(e)).toBe(false)
  })

  it('stringifies a non-Error throw rather than reporting "undefined"', () => {
    expect(serializeProcError('just a string')).toEqual({ message: 'just a string' })
    expect(serializeProcError(null)).toEqual({ message: 'null' })
  })
})

describe('runExec — argv form', () => {
  it('resolves with the output and NO error on success', async () => {
    execFileAnswers(null, 'on stdout', 'on stderr')
    await expect(runExec('git', ['status'], {})).resolves.toEqual({ stdout: 'on stdout', stderr: 'on stderr' })
  })

  it('never rejects: a failed command still hands back everything it printed', async () => {
    const boom: NodeJS.ErrnoException = Object.assign(new Error('Command failed'), { code: 1 })
    execFileAnswers(boom, 'partial output', 'the actual reason')
    const r = await runExec('npm', ['test'], {})
    expect(r.error).toBe(boom)
    // The one caller that runs arbitrary commands REPORTS this text to the user. Rejecting with
    // only a message would throw away the entire reason the command failed.
    expect(r.stdout).toBe('partial output')
    expect(r.stderr).toBe('the actual reason')
  })

  it('passes shell:false so a filename full of metacharacters stays one literal argument', () => {
    void runExec('git', ['add', 'a;rm -rf /.ts'], {})
    expect(lastExecFileOpts().shell).toBe(false)
    expect(H.execFile.mock.calls.at(-1)![1]).toEqual(['add', 'a;rm -rf /.ts'])
  })

  it('defaults the timeout and buffer, and hides the console window on Windows', () => {
    void runExec('git', [], {})
    expect(lastExecFileOpts()).toMatchObject({ timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true })
  })

  it('lets the caller override the timeout and buffer', () => {
    void runExec('git', [], { timeout: 120_000, maxBuffer: 512 * 1024 * 1024 })
    expect(lastExecFileOpts()).toMatchObject({ timeout: 120_000, maxBuffer: 512 * 1024 * 1024 })
  })

  it('omits cwd and env when they were not asked for, rather than sending undefined', () => {
    void runExec('git', [], {})
    expect('cwd' in lastExecFileOpts()).toBe(false)
    expect('env' in lastExecFileOpts()).toBe(false)
  })

  it('forwards cwd and env when they were', () => {
    void runExec('git', [], { cwd: '/repo', env: { PATH: '/usr/bin' } })
    expect(lastExecFileOpts()).toMatchObject({ cwd: '/repo', env: { PATH: '/usr/bin' } })
  })

  it('coerces a null/undefined stream to the empty string, so callers never see null', async () => {
    H.execFile.mockImplementation((_b: string, _a: string[], _o: unknown, cb: ExecFileCb) =>
      cb(null, null as unknown as string, undefined as unknown as string))
    await expect(runExec('git', [], {})).resolves.toEqual({ stdout: '', stderr: '' })
  })
})

describe('runShell — the flavour that needs a shell', () => {
  it('runs the command line as given and resolves with its output', async () => {
    execAnswers(null, 'C:\\bin\\claude.cmd\n')
    await expect(runShell('where claude', {})).resolves.toEqual({ stdout: 'C:\\bin\\claude.cmd\n', stderr: '' })
    expect(H.exec.mock.calls.at(-1)![0]).toBe('where claude')
  })

  it('never rejects either', async () => {
    const boom = Object.assign(new Error('not found'), { code: 1 })
    execAnswers(boom, '', 'INFO: Could not find files')
    const r = await runShell('where nope', {})
    expect(r.error).toBe(boom)
    expect(r.stderr).toBe('INFO: Could not find files')
  })

  it('coerces null streams to empty strings, as the argv form does', async () => {
    H.exec.mockImplementation((_c: string, _o: unknown, cb: ExecFileCb) =>
      cb(null, null as unknown as string, undefined as unknown as string))
    await expect(runShell('where git', {})).resolves.toEqual({ stdout: '', stderr: '' })
  })

  it('takes the same option defaults as the argv form', () => {
    void runShell('where git', { cwd: '/repo' })
    expect(lastExecOpts()).toMatchObject({ cwd: '/repo', timeout: 10_000, windowsHide: true })
  })
})

describe('handleProcMessage — the request/response contract', () => {
  it('answers an exec request with ok:true and the id it was asked under', async () => {
    execFileAnswers(null, 'M src/a.ts\n')
    const res = await handleProcMessage({ kind: 'exec', id: 7, bin: 'git', args: ['status'], opts: {} })
    expect(res).toEqual({ kind: 'result', id: 7, ok: true, stdout: 'M src/a.ts\n', stderr: '' })
  })

  it('answers a shell request the same way', async () => {
    execAnswers(null, '/usr/bin/git\n')
    const res = await handleProcMessage({ kind: 'shell', id: 8, cmd: 'which git', opts: {} })
    expect(res).toMatchObject({ kind: 'result', id: 8, ok: true, stdout: '/usr/bin/git\n' })
    expect(H.execFile).not.toHaveBeenCalled()
  })

  it('reports failure as ok:false WITH the output, not as a thrown error', async () => {
    execFileAnswers(Object.assign(new Error('Command failed'), { code: 128 }), 'some', 'fatal: not a git repository')
    const res = await handleProcMessage({ kind: 'exec', id: 9, bin: 'git', args: ['status'], opts: {} })
    expect(res).toEqual({
      kind: 'result', id: 9, ok: false,
      stdout: 'some', stderr: 'fatal: not a git repository',
      error: { message: 'Command failed', code: 128 },
    })
  })

  it('preserves ENOENT so the caller can go looking for the binary elsewhere', async () => {
    execFileAnswers(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
    const res = await handleProcMessage({ kind: 'exec', id: 1, bin: 'git', args: [], opts: {} })
    expect(res!.error).toEqual({ message: 'spawn git ENOENT', code: 'ENOENT' })
  })

  it('ignores a message that is not a request instead of answering something made up', async () => {
    await expect(handleProcMessage(null as unknown as ProcRequest)).resolves.toBeNull()
    await expect(handleProcMessage({ kind: 'nonsense' } as unknown as ProcRequest)).resolves.toBeNull()
    expect(H.execFile).not.toHaveBeenCalled()
    expect(H.exec).not.toHaveBeenCalled()
  })
})
