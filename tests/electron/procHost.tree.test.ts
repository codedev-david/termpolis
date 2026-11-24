// procHost's `tree` mode with a fake child: a cancel or the timeout ends the whole tree (through an
// injected endTree), the request settles as cancelled with no output, and the host routes a cancel
// message to the request it names. It also tracks the process groups of POSIX tree runs, reports
// each to main, and ends them on its own way out. The real-process proofs are procHost.process.test.ts
// and procHost.exit.process.test.ts.
import { EventEmitter } from 'events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const H = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  exec: vi.fn(),
  endProcessTree: vi.fn(async () => true),
  signalProcessGroup: vi.fn((_pid: number, _signal: string, _deps?: unknown) => 'sent'),
}))

vi.mock('child_process', () => ({ execFile: H.execFile, exec: H.exec, spawn: H.spawn }))
// The fake child's pid is made up: the real endProcessTree must never be handed it.
vi.mock('../../src/main/processTree', () => ({ endProcessTree: H.endProcessTree, signalProcessGroup: H.signalProcessGroup, TREE_KILL_GRACE_MS: 2_000 }))

import {
  runExec, handleProcMessage, installHostExitHandlers, treeGroupsInFlight, hostGraceMs, HOST_GRACE_ENV, _resetProcHostForTests,
  TREE_STOP_SETTLE_MS, type RunOutcome,
} from '../../src/main/procHost'

type ExecFileCb = (e: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void

let nextPid: number | undefined = 4242

class FakeStream extends EventEmitter {
  encoding: string | undefined
  destroyed = false
  setEncoding(e: string): this { this.encoding = e; return this }
  destroy(): this { this.destroyed = true; return this }
}

class FakeChild extends EventEmitter {
  readonly pid = nextPid
  stdin = null
  stdout = new FakeStream()
  stderr = new FakeStream()
  killed = false
  kill = vi.fn((_signal?: string): boolean => true)
}

let child: FakeChild
let done: ExecFileCb
let spawnOpts: Record<string, unknown>

/** A tree run's child (spawnTree) as execFile's callback: print what it was given, then close the pipes. */
function closeWith(c: FakeChild): ExecFileCb {
  return (e, stdout, stderr) => {
    if (stdout) c.stdout.emit('data', stdout)
    if (stderr) c.stderr.emit('data', stderr)
    c.emit('close', e ? (typeof e.code === 'number' ? e.code : null) : 0, e ? ((e as { signal?: string }).signal ?? null) : null)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  _resetProcHostForTests()
  nextPid = 4242
  H.signalProcessGroup.mockReset().mockReturnValue('sent')
  H.execFile.mockReset().mockImplementation((_bin: string, _args: string[], o: Record<string, unknown>, cb: ExecFileCb) => {
    spawnOpts = o
    done = cb
    child = new FakeChild()
    return child
  })
  H.spawn.mockReset().mockImplementation((_bin: string, _args: string[], o: Record<string, unknown>) => {
    spawnOpts = o
    child = new FakeChild()
    done = closeWith(child)
    return child
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

function track(p: Promise<RunOutcome>): { value: () => RunOutcome | undefined } {
  let v: RunOutcome | undefined
  void p.then((r) => { v = r })
  return { value: () => v }
}

const CANCELLED = { message: 'cancelled', code: 'ABORT_ERR' }
/** The run's own handle on its child, handed to processTree with each POSIX group (KillTreeOptions.leader). */
const LEADER = expect.any(Function)

describe('runExec with tree', () => {
  // spawn, not execFile: execFile hands spawn only the options it knows and drops `detached`. The rest
  // is what execFile hands spawn for the same call (no timeout: runExec's own ends the tree).
  it('on POSIX spawns the child detached, to lead its group, with the timeout its own', () => {
    void runExec('claude', ['-p'], { tree: true, timeout: 5_000, cwd: '/w', env: { A: '1' } }, undefined, { platform: 'linux', endTree: vi.fn() })
    expect(H.execFile).not.toHaveBeenCalled()
    expect(H.spawn.mock.calls[0].slice(0, 2)).toEqual(['claude', ['-p']])
    expect(spawnOpts).toEqual({ cwd: '/w', env: expect.objectContaining({ A: '1' }), shell: false, windowsHide: true, windowsVerbatimArguments: false, detached: true })
  })

  it('on Windows does not detach (that would give it its own console)', () => {
    void runExec('claude', ['-p'], { tree: true }, undefined, { platform: 'win32', endTree: vi.fn() })
    expect(spawnOpts).toEqual({ cwd: undefined, env: undefined, shell: false, windowsHide: true, windowsVerbatimArguments: false, detached: false })
  })

  it('without tree keeps execFile as it was and ignores the signal', async () => {
    const ac = new AbortController()
    const endTree = vi.fn()
    const run = runExec('git', ['status'], { timeout: 5_000 }, ac.signal, { endTree })
    expect(spawnOpts).toEqual({ timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false })
    ac.abort()
    expect(endTree).not.toHaveBeenCalled()
    done(null, 'ok', '')
    expect(await run).toEqual({ stdout: 'ok', stderr: '' })
  })

  it('starts nothing when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runExec('claude', ['-p'], { tree: true }, ac.signal)
    expect(H.execFile).not.toHaveBeenCalled()
    expect(H.spawn).not.toHaveBeenCalled()
    expect(r.stdout).toBe('')
    expect(r.error).toMatchObject(CANCELLED)
  })

  it('a cancel ends the tree while the child lives, and settles as cancelled with no output once its pipes close', async () => {
    const ac = new AbortController()
    const endTree = vi.fn(async () => true)
    const run = track(runExec('claude', ['-p'], { tree: true }, ac.signal, { platform: 'win32', endTree }))
    ac.abort()
    expect(endTree).toHaveBeenCalledWith(4242, { platform: 'win32', canRetry: expect.any(Function) })
    const { canRetry } = (endTree.mock.calls[0] as unknown as [number, { canRetry: () => boolean }])[1]
    expect(canRetry()).toBe(true)
    child.emit('exit', 1)
    expect(canRetry()).toBe(false)
    // Whatever the CLI printed before it was stopped is not an answer.
    done(Object.assign(new Error('Command failed'), { code: 1 }), 'half a label', 'err text')
    await vi.advanceTimersByTimeAsync(0)
    expect(run.value()).toMatchObject({ stdout: '', stderr: 'err text', error: CANCELLED })
    // A second abort, or the backstop, changes nothing.
    ac.abort()
    await vi.advanceTimersByTimeAsync(TREE_STOP_SETTLE_MS)
    expect(endTree).toHaveBeenCalledTimes(1)
  })

  it('is answered by the backstop when a process outside the tree keeps the pipes open', async () => {
    const ac = new AbortController()
    const run = track(runExec('claude', ['-p'], { tree: true }, ac.signal, { platform: 'linux', endTree: vi.fn() }))
    ac.abort()
    await vi.advanceTimersByTimeAsync(TREE_STOP_SETTLE_MS - 1)
    expect(run.value()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(run.value()).toMatchObject({ stdout: '', stderr: '', error: CANCELLED })
    // The pipes closing later answers nothing a second time.
    done(null, undefined as unknown as string, undefined as unknown as string)
    await vi.advanceTimersByTimeAsync(0)
    expect(run.value()).toMatchObject({ stdout: '', stderr: '', error: CANCELLED })
  })

  it('on Windows never ends a tree whose root has exited, since its pid may name a stranger', async () => {
    const ac = new AbortController()
    const endTree = vi.fn()
    const run = track(runExec('claude', ['-p'], { tree: true }, ac.signal, { platform: 'win32', endTree }))
    child.emit('exit', 0)
    ac.abort()
    expect(endTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(TREE_STOP_SETTLE_MS)
    expect(run.value()?.error).toMatchObject(CANCELLED)
  })

  it('on POSIX still signals the group after the leader exited: the group outlives it', () => {
    const ac = new AbortController()
    const endTree = vi.fn()
    void runExec('claude', ['-p'], { tree: true }, ac.signal, { platform: 'darwin', endTree })
    child.emit('exit', 0)
    ac.abort()
    expect(endTree).toHaveBeenCalledWith(4242, expect.objectContaining({ platform: 'darwin' }))
  })

  it('on POSIX hands processTree the handle on its child, which signals it only until it exits', () => {
    const ac = new AbortController()
    const endTree = vi.fn()
    void runExec('claude', ['-p'], { tree: true }, ac.signal, { platform: 'linux', endTree })
    ac.abort()
    expect(endTree).toHaveBeenCalledWith(4242, { platform: 'linux', canRetry: expect.any(Function), leader: LEADER })
    const { leader } = (endTree.mock.calls[0] as unknown as [number, { leader: (s: NodeJS.Signals) => boolean }])[1]
    expect(leader('SIGTERM')).toBe(true)
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    child.kill.mockReturnValue(false)
    expect(leader('SIGKILL')).toBe(false)
    // Once the child has exited its pid is not asked about at all.
    child.emit('exit', null, 'SIGTERM')
    expect(leader('SIGKILL')).toBe(false)
    expect(child.kill).toHaveBeenCalledTimes(2)
  })

  it('the timeout ends the tree too, keeps what it printed, and reads as a timeout; a later cancel joins it', async () => {
    const ac = new AbortController()
    const endTree = vi.fn()
    const run = track(runExec('claude', ['-p'], { tree: true, timeout: 1_000 }, ac.signal, { platform: 'linux', endTree }))
    await vi.advanceTimersByTimeAsync(999)
    expect(endTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(endTree).toHaveBeenCalledTimes(1)
    ac.abort()
    expect(endTree).toHaveBeenCalledTimes(1)
    done(Object.assign(new Error('killed'), { signal: 'SIGTERM' }), 'partial', '')
    await vi.advanceTimersByTimeAsync(0)
    const r = run.value()!
    expect(r.stdout).toBe('partial')
    expect(r.error).toMatchObject({ message: 'timed out after 1000ms', killed: true, signal: 'SIGTERM' })
  })

  it('a run that finishes on its own is answered as usual, and its timers and listener are gone', async () => {
    const ac = new AbortController()
    const endTree = vi.fn()
    const run = runExec('claude', ['-p'], { tree: true, timeout: 1_000 }, ac.signal, { platform: 'linux', endTree })
    done(null, 'labels', '')
    expect(await run).toEqual({ stdout: 'labels', stderr: '' })
    expect(vi.getTimerCount()).toBe(0)
    ac.abort()
    expect(endTree).not.toHaveBeenCalled()
  })

  it('with a timeout of 0 arms no timer of its own', () => {
    void runExec('claude', ['-p'], { tree: true, timeout: 0 }, undefined, { platform: 'linux', endTree: vi.fn() })
    expect(vi.getTimerCount()).toBe(0)
  })
})

// spawnTree collects output the way execFile does (the real-process comparison against execFile itself
// is in procHost.process.test.ts); these pin the paths a real child cannot be made to take on demand.
describe('a tree run collects its output as execFile does', () => {
  const run = (opts: Record<string, unknown> = {}, args: string[] = ['-p']): Promise<RunOutcome> =>
    runExec('claude', args, { tree: true, ...opts }, undefined, { platform: 'linux', endTree: vi.fn() })

  it('reads both pipes as utf8 and answers a clean exit with no error', async () => {
    const r = run()
    expect([child.stdout.encoding, child.stderr.encoding]).toEqual(['utf8', 'utf8'])
    child.stdout.emit('data', 'la')
    child.stdout.emit('data', 'bels')
    child.stderr.emit('data', 'warn')
    child.emit('close', 0, null)
    expect(await r).toEqual({ stdout: 'labels', stderr: 'warn' })
  })

  it('answers a failed exit with execFile\'s error: the command, its stderr, code, killed and signal', async () => {
    const r = run({}, ['-p', 'x'])
    child.stderr.emit('data', 'bad')
    child.emit('close', 2, null)
    const { error } = await r
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ message: 'Command failed: claude -p x\nbad', code: 2, killed: false, signal: null, cmd: 'claude -p x' })
  })

  it('names a negative status as the system error it is, and a signal with a null code; no args, no trailing space', async () => {
    const neg = run({}, [])
    child.emit('close', -4058, null)
    expect((await neg).error).toMatchObject({ message: 'Command failed: claude\n', code: 'ENOENT', cmd: 'claude' })
    const sig = run()
    child.killed = true
    child.emit('close', null, 'SIGKILL')
    expect((await sig).error).toMatchObject({ code: null, killed: true, signal: 'SIGKILL' })
  })

  it('answers a spawn error with that error, cmd added, its pipes destroyed, and only once', async () => {
    const r = run()
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT', errno: -4058, syscall: 'spawn claude', path: 'claude', spawnargs: ['-p'] })
    child.emit('error', enoent)
    child.emit('close', -4058, null)
    const { error } = await r
    expect(error).toBe(enoent)
    expect(error).toMatchObject({ code: 'ENOENT', errno: -4058, syscall: 'spawn claude', path: 'claude', spawnargs: ['-p'], cmd: 'claude -p' })
    expect([child.stdout.destroyed, child.stderr.destroyed]).toEqual([true, true])
  })

  it('cuts stdout at maxBuffer bytes, mid-chunk, and ends the child with SIGTERM as execFile does', async () => {
    const r = run({ maxBuffer: 6 })
    child.stdout.emit('data', 'ab')
    // 'é' is two bytes, so 2 + 6 > 6 and the chunk is cut to 6 - 2 = 4 characters: execFile counts bytes but slices characters.
    child.stdout.emit('data', 'cdéfg')
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    expect([child.stdout.destroyed, child.stderr.destroyed]).toEqual([true, true])
    child.emit('close', null, 'SIGTERM')
    const out = await r
    expect(out.stdout).toBe('abcdéf')
    expect(out.error).toBeInstanceOf(RangeError)
    expect(out.error).toMatchObject({ message: 'stdout maxBuffer length exceeded', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', cmd: 'claude -p' })
  })

  it('cuts stderr at maxBuffer on its own count', async () => {
    const r = run({ maxBuffer: 3 })
    child.stdout.emit('data', 'abc')
    child.stderr.emit('data', 'wxyz')
    child.emit('close', null, 'SIGTERM')
    const out = await r
    expect(out).toMatchObject({ stdout: 'abc', stderr: 'wxy' })
    expect(out.error).toMatchObject({ message: 'stderr maxBuffer length exceeded', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  })

  it('counts nothing with an infinite maxBuffer', async () => {
    const r = run({ maxBuffer: Infinity })
    child.stdout.emit('data', 'x'.repeat(2 * 1024 * 1024))
    child.stderr.emit('data', 'y')
    child.emit('close', 0, null)
    const out = await r
    expect([out.stdout.length, out.stderr, out.error]).toEqual([2 * 1024 * 1024, 'y', undefined])
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('answers with the kill\'s own error when SIGTERM throws, and ignores the close after', async () => {
    const r = run({ maxBuffer: 1 })
    const eperm = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    child.kill.mockImplementation(() => { throw eperm })
    child.stdout.emit('data', 'ab')
    child.emit('close', 0, null)
    const out = await r
    expect(out.stdout).toBe('a')
    expect(out.error).toBe(eperm)
    expect(out.error).toMatchObject({ cmd: 'claude -p' })
  })
})

describe('the host routes a cancel to the request it names', () => {
  it('cancels an exec in flight by id, and ignores an id it does not hold', async () => {
    H.endProcessTree.mockClear()
    const answer = handleProcMessage({ kind: 'exec', id: 7, bin: 'claude', args: ['-p'], opts: { tree: true } })
    // Another id leaves run 7 alone.
    expect(await handleProcMessage({ kind: 'cancel', id: 99 })).toBeNull()
    expect(H.endProcessTree).not.toHaveBeenCalled()
    let answered = false
    void answer.then(() => { answered = true })
    await vi.advanceTimersByTimeAsync(TREE_STOP_SETTLE_MS)
    expect(answered).toBe(false)
    expect(await handleProcMessage({ kind: 'cancel', id: 7 })).toBeNull()
    expect(H.endProcessTree).toHaveBeenCalledTimes(1)
    expect(H.endProcessTree).toHaveBeenCalledWith(4242, expect.objectContaining({ canRetry: expect.any(Function) }))
    await vi.advanceTimersByTimeAsync(TREE_STOP_SETTLE_MS)
    expect(await answer).toMatchObject({ kind: 'result', id: 7, ok: false, stdout: '', error: CANCELLED })
    // Answered: the id is forgotten, so a late cancel reaches nothing.
    expect(await handleProcMessage({ kind: 'cancel', id: 7 })).toBeNull()
    expect(H.endProcessTree).toHaveBeenCalledTimes(1)
  })
})

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try { return fn() } finally { Object.defineProperty(process, 'platform', original) }
}

describe('the process group a POSIX tree run leads', () => {
  it('is tracked and reported once spawned, and forgotten once the run is answered', async () => {
    const onGroup = vi.fn()
    const run = runExec('claude', ['-p'], { tree: true }, undefined, { platform: 'linux', endTree: vi.fn(), onGroup })
    expect(onGroup.mock.calls).toEqual([[4242]])
    expect(treeGroupsInFlight()).toEqual([4242])
    done(null, 'ok', '')
    await run
    expect(treeGroupsInFlight()).toEqual([])
  })

  it('is neither tracked nor reported on Windows, without tree, or when nothing was spawned', () => {
    const onGroup = vi.fn()
    void runExec('claude', ['-p'], { tree: true }, undefined, { platform: 'win32', endTree: vi.fn(), onGroup })
    void runExec('git', ['status'], {}, undefined, { platform: 'linux', onGroup })
    nextPid = undefined
    void runExec('claude', ['-p'], { tree: true }, undefined, { platform: 'linux', endTree: vi.fn(), onGroup })
    expect(onGroup).not.toHaveBeenCalled()
    expect(treeGroupsInFlight()).toEqual([])
  })

  it('is posted to main by request id, before the result', async () => {
    const post = vi.fn()
    const answer = withPlatform('linux', () => handleProcMessage({ kind: 'exec', id: 7, bin: 'claude', args: ['-p'], opts: { tree: true } }, post))
    expect(post.mock.calls).toEqual([[{ kind: 'tree', id: 7, pid: 4242 }]])
    done(null, 'labels', '')
    expect(await answer).toMatchObject({ kind: 'result', id: 7, ok: true, stdout: 'labels' })
    expect(treeGroupsInFlight()).toEqual([])
  })

  it('is still tracked by a host given nowhere to post it', () => {
    void withPlatform('linux', () => handleProcMessage({ kind: 'exec', id: 8, bin: 'claude', args: ['-p'], opts: { tree: true } }))
    expect(treeGroupsInFlight()).toEqual([4242])
  })
})

describe('the host ends its groups on its way out', () => {
  class FakeProc extends EventEmitter {
    exit = vi.fn((_code?: number) => undefined)
  }
  const deps = { graceMs: 50 }
  function group(pid: number): Promise<RunOutcome> {
    nextPid = pid
    return runExec('claude', ['-p'], { tree: true }, undefined, { platform: 'linux', endTree: vi.fn() })
  }

  it.each(['SIGTERM', 'SIGINT'] as const)('on %s: SIGTERM to every group, exit after the grace, and SIGKILL to what is left on exit', (event) => {
    void group(4242)
    void group(4343)
    const proc = new FakeProc()
    installHostExitHandlers(proc, deps)
    proc.emit(event)
    expect(H.signalProcessGroup.mock.calls).toEqual([[4242, 'SIGTERM', deps, LEADER], [4343, 'SIGTERM', deps, LEADER]])
    // A second signal neither signals again nor arms a second exit.
    proc.emit('SIGTERM')
    proc.emit('SIGINT')
    expect(H.signalProcessGroup).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(49)
    expect(proc.exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(proc.exit.mock.calls).toEqual([[0]])
    proc.emit('exit')
    expect(H.signalProcessGroup.mock.calls.slice(2)).toEqual([[4242, 'SIGKILL', deps, LEADER], [4343, 'SIGKILL', deps, LEADER]])
    expect(treeGroupsInFlight()).toEqual([])
  })

  it('SIGKILLs at the exit every group it sent SIGTERM, a run answered in the grace included, but not one gone at the SIGTERM', async () => {
    const killed = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }) as NodeJS.ErrnoException
    const answeredA = group(4242)
    const answerA = done
    void group(4343)
    const answeredC = group(4444)
    const answerC = done
    H.signalProcessGroup.mockImplementation((pid: number) => (pid === 4444 ? 'gone' : 'sent'))
    const proc = new FakeProc()
    installHostExitHandlers(proc, deps)
    proc.emit('SIGTERM')
    // Both answer in the grace, which only means their pipes closed. 4242 got the SIGTERM, so a member
    // that ignores it and let go of the pipes may still be there; 4444 had no one left to get it.
    answerA(killed, '', '')
    answerC(killed, '', '')
    await Promise.all([answeredA, answeredC])
    expect(treeGroupsInFlight()).toEqual([4343])
    vi.advanceTimersByTime(50)
    proc.emit('exit')
    expect(H.signalProcessGroup.mock.calls.slice(3)).toEqual([[4242, 'SIGKILL', deps, LEADER], [4343, 'SIGKILL', deps, LEADER]])
  })

  it('hands each group the handle of the run that leads it', () => {
    void group(4242)
    const first = child
    void group(4343)
    const second = child
    const proc = new FakeProc()
    installHostExitHandlers(proc, deps)
    proc.emit('SIGTERM')
    const leaders = H.signalProcessGroup.mock.calls.map((c) => (c as unknown as [number, string, unknown, (s: NodeJS.Signals) => boolean])[3])
    leaders[0]('SIGTERM')
    leaders[1]('SIGINT' as NodeJS.Signals)
    expect([first.kill.mock.calls, second.kill.mock.calls]).toEqual([[['SIGTERM']], [['SIGINT']]])
  })

  it('exits at once with no group in flight, signalling nothing', () => {
    const proc = new FakeProc()
    installHostExitHandlers(proc)
    proc.emit('SIGTERM')
    expect(proc.exit.mock.calls).toEqual([[0]])
    proc.emit('exit')
    expect(H.signalProcessGroup).not.toHaveBeenCalled()
  })

  it('waits the default grace: 2 s, with the test-only variable unset as it is in the app', () => {
    expect(process.env[HOST_GRACE_ENV]).toBeUndefined()
    void group(4242)
    const proc = new FakeProc()
    installHostExitHandlers(proc)
    proc.emit('SIGTERM')
    vi.advanceTimersByTime(1_999)
    expect(proc.exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(proc.exit).toHaveBeenCalledTimes(1)
  })

  it('takes the grace from the test-only variable under NODE_ENV=test, read once when the handlers are installed', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv(HOST_GRACE_ENV, '10000')
    void group(4242)
    const proc = new FakeProc()
    installHostExitHandlers(proc)
    vi.stubEnv(HOST_GRACE_ENV, '50')
    proc.emit('SIGTERM')
    vi.advanceTimersByTime(9_999)
    expect(proc.exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(proc.exit).toHaveBeenCalledTimes(1)
  })

  it('keeps the 2 s grace when the variable is set but NODE_ENV is not test, as in the app', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv(HOST_GRACE_ENV, '10000')
    void group(4242)
    const proc = new FakeProc()
    installHostExitHandlers(proc)
    proc.emit('SIGTERM')
    vi.advanceTimersByTime(1_999)
    expect(proc.exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(proc.exit).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, 'production', 'development', 'TEST'])('hostGraceMs ignores the variable under NODE_ENV %j', (nodeEnv) => {
    expect(hostGraceMs({ ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }), [HOST_GRACE_ENV]: '10000' })).toBe(2_000)
  })

  it.each([undefined, '', 'abc', '0', '-5', '1.5', '60001'])('hostGraceMs keeps the 2 s default for %j', (v) => {
    expect(hostGraceMs(v === undefined ? { NODE_ENV: 'test' } : { NODE_ENV: 'test', [HOST_GRACE_ENV]: v })).toBe(2_000)
  })

  it.each([['1', 1], ['10000', 10_000], ['60000', 60_000]])('hostGraceMs takes %s', (v, ms) => {
    expect(hostGraceMs({ NODE_ENV: 'test', [HOST_GRACE_ENV]: v })).toBe(ms)
  })

  it('on an exit it did not ask for (an unhandled rejection), SIGKILLs every group still unanswered, and none already answered', async () => {
    const answered = group(4141)
    done(null, 'ok', '')
    await answered
    void group(4242)
    const proc = new FakeProc()
    installHostExitHandlers(proc, deps)
    proc.emit('exit')
    expect(H.signalProcessGroup.mock.calls).toEqual([[4242, 'SIGKILL', deps, LEADER]])
  })
})
