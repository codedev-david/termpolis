// procHost's `tree` mode with a fake child: a cancel or the timeout ends the whole tree (through an
// injected endTree), the request settles as cancelled with no output, and the host routes a cancel
// message to the request it names. It also tracks the process groups of POSIX tree runs, reports
// each to main, and ends them on its own way out. The real-process proofs are procHost.process.test.ts
// and procHost.exit.process.test.ts.
import { EventEmitter } from 'events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const H = vi.hoisted(() => ({
  execFile: vi.fn(),
  exec: vi.fn(),
  endProcessTree: vi.fn(async () => true),
  signalProcessGroup: vi.fn((_pid: number, _signal: string, _deps?: unknown) => 'sent'),
}))

vi.mock('child_process', () => ({ execFile: H.execFile, exec: H.exec }))
// The fake child's pid is made up: the real endProcessTree must never be handed it.
vi.mock('../../src/main/processTree', () => ({ endProcessTree: H.endProcessTree, signalProcessGroup: H.signalProcessGroup, TREE_KILL_GRACE_MS: 2_000 }))

import {
  runExec, handleProcMessage, installHostExitHandlers, treeGroupsInFlight, _resetProcHostForTests, TREE_STOP_SETTLE_MS, type RunOutcome,
} from '../../src/main/procHost'

type ExecFileCb = (e: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void

let nextPid: number | undefined = 4242

class FakeChild extends EventEmitter {
  readonly pid = nextPid
  stdin = null
}

let child: FakeChild
let done: ExecFileCb
let spawnOpts: Record<string, unknown>

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
})

afterEach(() => {
  vi.useRealTimers()
})

function track(p: Promise<RunOutcome>): { value: () => RunOutcome | undefined } {
  let v: RunOutcome | undefined
  void p.then((r) => { v = r })
  return { value: () => v }
}

const CANCELLED = { message: 'cancelled', code: 'ABORT_ERR' }

describe('runExec with tree', () => {
  it('on POSIX spawns the child detached, to lead its group, with the timeout its own', () => {
    void runExec('claude', ['-p'], { tree: true, timeout: 5_000 }, undefined, { platform: 'linux', endTree: vi.fn() })
    expect(spawnOpts).toMatchObject({ detached: true, timeout: 0, shell: false })
  })

  it('on Windows does not detach (that would give it its own console)', () => {
    void runExec('claude', ['-p'], { tree: true }, undefined, { platform: 'win32', endTree: vi.fn() })
    expect(spawnOpts).toMatchObject({ detached: false, timeout: 0 })
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
    expect(H.signalProcessGroup.mock.calls).toEqual([[4242, 'SIGTERM', deps], [4343, 'SIGTERM', deps]])
    // A second signal neither signals again nor arms a second exit.
    proc.emit('SIGTERM')
    proc.emit('SIGINT')
    expect(H.signalProcessGroup).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(49)
    expect(proc.exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(proc.exit.mock.calls).toEqual([[0]])
    proc.emit('exit')
    expect(H.signalProcessGroup.mock.calls.slice(2)).toEqual([[4242, 'SIGKILL', deps], [4343, 'SIGKILL', deps]])
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
    expect(H.signalProcessGroup.mock.calls.slice(3)).toEqual([[4242, 'SIGKILL', deps], [4343, 'SIGKILL', deps]])
  })

  it('exits at once with no group in flight, signalling nothing', () => {
    const proc = new FakeProc()
    installHostExitHandlers(proc)
    proc.emit('SIGTERM')
    expect(proc.exit.mock.calls).toEqual([[0]])
    proc.emit('exit')
    expect(H.signalProcessGroup).not.toHaveBeenCalled()
  })

  it('waits the default grace', () => {
    void group(4242)
    const proc = new FakeProc()
    installHostExitHandlers(proc)
    proc.emit('SIGTERM')
    vi.advanceTimersByTime(1_999)
    expect(proc.exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(proc.exit).toHaveBeenCalledTimes(1)
  })

  it('on an exit it did not ask for (an unhandled rejection), SIGKILLs every group still unanswered, and none already answered', async () => {
    const answered = group(4141)
    done(null, 'ok', '')
    await answered
    void group(4242)
    const proc = new FakeProc()
    installHostExitHandlers(proc, deps)
    proc.emit('exit')
    expect(H.signalProcessGroup.mock.calls).toEqual([[4242, 'SIGKILL', deps]])
  })
})
