// procClient — main's side of the spawn host (src/main/procClient.ts).
//
// The transport is injected precisely so this file can exist: everything below is the orchestration
// around a child process, tested without forking one. Four behaviours here are load-bearing and all
// four are invisible in the happy path:
//
//   * correlation — replies arrive out of order, and answering call B with call A's stdout would put
//     one repo's git status on another repo's dot.
//   * settling — a call that never settles wedges its awaiter forever, which is strictly worse than
//     a call that fails. Timeout and host-exit both exist to guarantee settlement.
//   * the restart budget — the whole point of this module is to protect the thread that pumps every
//     PTY. A host that crashes on every message must not be re-forked on every message.
//   * the in-process fallback — when the host is gone, git still has to work. Degrading to "as slow
//     as before" is the goal; degrading to "git is broken" is not.
//   * the process groups a host reports (macOS and Linux) — a labelling run's detached group outlives
//     a host that dies, so main ends it, and only while the host has not answered that run.
//
// Every group signal is a mock: the pids here are made up, and a real kill(-pid) aimed at one would
// end whatever process group happens to own it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const H = vi.hoisted(() => ({
  runExec: vi.fn(),
  runShell: vi.fn(),
  treeGroupsInFlight: vi.fn((): number[] => []),
  signalProcessGroup: vi.fn((_pid: number, _signal: string): 'sent' | 'gone' | 'failed' => 'sent'),
}))

vi.mock('../../src/main/procHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/procHost')>()
  return { ...actual, runExec: H.runExec, runShell: H.runShell, treeGroupsInFlight: H.treeGroupsInFlight }
})
vi.mock('../../src/main/processTree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/processTree')>()
  return { ...actual, signalProcessGroup: H.signalProcessGroup }
})

import type { ProcRequest, ProcResult, ProcTreeMsg } from '../../src/main/procHost'
import { TREE_KILL_GRACE_MS } from '../../src/main/processTree'
import {
  setProcSpawner,
  _resetProcClientForTests,
  procHostActive,
  shutdownProcHost,
  endProcHostGroupsNow,
  _trackedGroupsForTests,
  execOffThread,
  execShellOffThread,
  execCaptureOffThread,
  execShellCaptureOffThread,
  ProcError,
  type ProcTransport,
} from '../../src/main/procClient'

interface FakeTransport extends ProcTransport {
  sent: ProcRequest[]
  killed: number
  /** Deliver a message from the "child". */
  reply(msg: Partial<ProcResult> & { id: number }): void
  /** Answer the most recent request. */
  answer(patch?: Partial<ProcResult>): void
  /** The host's report of the process group a tree run leads. */
  tree(id: unknown, pid: unknown): void
  exit(code: number): void
}

function makeTransport(): FakeTransport {
  let onMsg: ((m: ProcResult | ProcTreeMsg) => void) | null = null
  let onExit: ((c: number) => void) | null = null
  const t: FakeTransport = {
    sent: [],
    killed: 0,
    pid: 4242,
    postMessage: (msg) => { t.sent.push(msg) },
    onMessage: (cb) => { onMsg = cb },
    onExit: (cb) => { onExit = cb },
    kill: () => { t.killed++ },
    reply: (msg) => onMsg?.({ kind: 'result', ok: true, stdout: '', stderr: '', ...msg } as ProcResult),
    answer: (patch = {}) => {
      const last = t.sent.at(-1)!
      t.reply({ id: last.id, ...patch } as Partial<ProcResult> & { id: number })
    },
    tree: (id, pid) => onMsg?.({ kind: 'tree', id, pid } as ProcTreeMsg),
    exit: (code) => onExit?.(code),
  }
  return t
}

/** Install a spawner and hand back both the transports it makes and the spy. */
function install(): { transports: FakeTransport[]; spawn: ReturnType<typeof vi.fn> } {
  const transports: FakeTransport[] = []
  const spawn = vi.fn(() => {
    const t = makeTransport()
    transports.push(t)
    return t
  })
  setProcSpawner(spawn)
  return { transports, spawn }
}

beforeEach(() => {
  H.runExec.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  H.runShell.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  H.treeGroupsInFlight.mockReset().mockReturnValue([])
  H.signalProcessGroup.mockReset().mockReturnValue('sent')
  _resetProcClientForTests()
})

afterEach(() => {
  _resetProcClientForTests()
  vi.useRealTimers()
})

describe('with no host — the in-process fallback', () => {
  it('runs the command here rather than reporting that git is unavailable', async () => {
    H.runExec.mockResolvedValue({ stdout: 'on branch main', stderr: '' })
    await expect(execOffThread('git', ['status'], { cwd: '/repo' })).resolves.toBe('on branch main')
    expect(H.runExec).toHaveBeenCalledWith('git', ['status'], { cwd: '/repo' }, undefined)
    expect(procHostActive()).toBe(false)
  })

  it('takes the shell path for shell calls', async () => {
    H.runShell.mockResolvedValue({ stdout: '/usr/bin/git', stderr: '' })
    await expect(execShellOffThread('which git', {})).resolves.toBe('/usr/bin/git')
    expect(H.runShell).toHaveBeenCalledWith('which git', {})
    expect(H.runExec).not.toHaveBeenCalled()
  })

  it('still throws a ProcError that has KEPT the error code', async () => {
    // The whole reason ProcError exists. gitCommand decides between "go hunt for git.exe in the
    // install locations" and "give up" on exactly this field, so the fallback path has to preserve
    // it as faithfully as the wire path does.
    H.runExec.mockResolvedValue({
      stdout: '', stderr: 'nope',
      error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
    })
    const err = await execOffThread('git', [], {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProcError)
    expect((err as ProcError).code).toBe('ENOENT')
    expect((err as ProcError).stderr).toBe('nope')
  })

  it('reports failure WITHOUT throwing through the capture variants', async () => {
    H.runShell.mockResolvedValue({ stdout: 'out', stderr: 'err', error: Object.assign(new Error('x'), { code: 1 }) })
    await expect(execShellCaptureOffThread('npm test', {})).resolves.toEqual({
      stdout: 'out', stderr: 'err', error: { message: 'x', code: 1 },
    })
  })

  it('reports success with no `error` key at all, not `error: undefined`', async () => {
    H.runExec.mockResolvedValue({ stdout: 'ok', stderr: '' })
    const r = await execCaptureOffThread('git', [], {})
    expect(r).toEqual({ stdout: 'ok', stderr: '' })
    expect('error' in r).toBe(false)
  })
})

describe('forwarding a request to the host', () => {
  it('sends an exec request carrying bin, args and options under a fresh id', async () => {
    const { transports } = install()
    const p = execOffThread('git', ['status', '--porcelain'], { cwd: '/repo' })
    expect(transports[0].sent).toEqual([
      { kind: 'exec', bin: 'git', args: ['status', '--porcelain'], opts: { cwd: '/repo' }, id: 1 },
    ])
    transports[0].answer({ stdout: ' M a.ts' })
    await expect(p).resolves.toBe(' M a.ts')
    expect(H.runExec).not.toHaveBeenCalled()
  })

  it('sends a shell request in its own shape', async () => {
    const { transports } = install()
    const p = execShellCaptureOffThread('where claude', { timeout: 3000 })
    expect(transports[0].sent[0]).toEqual({ kind: 'shell', cmd: 'where claude', opts: { timeout: 3000 }, id: 1 })
    transports[0].answer({ stdout: 'C:\\claude.cmd' })
    await expect(p).resolves.toMatchObject({ stdout: 'C:\\claude.cmd' })
  })

  it('forks exactly once for many calls, and reports the host as active', async () => {
    const { transports, spawn } = install()
    const a = execCaptureOffThread('git', ['a'], {})
    const b = execCaptureOffThread('git', ['b'], {})
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(procHostActive()).toBe(true)
    transports[0].reply({ id: 1 })
    transports[0].reply({ id: 2 })
    await Promise.all([a, b])
  })

  it('answers each caller with ITS OWN output when replies come back out of order', async () => {
    // The bug this prevents is silent and looks like a UI glitch: one repo's status painted on
    // another repo's dot, with nothing logged anywhere.
    const { transports } = install()
    const first = execOffThread('git', ['status'], { cwd: '/repo-a' })
    const second = execOffThread('git', ['status'], { cwd: '/repo-b' })
    const [idA, idB] = transports[0].sent.map((m) => m.id)
    expect(idA).not.toBe(idB)
    transports[0].reply({ id: idB, stdout: 'B' })
    transports[0].reply({ id: idA, stdout: 'A' })
    await expect(first).resolves.toBe('A')
    await expect(second).resolves.toBe('B')
  })

  it('ignores a reply for an id nobody is waiting on', async () => {
    const { transports } = install()
    const p = execCaptureOffThread('git', [], {})
    expect(() => transports[0].reply({ id: 999, stdout: 'stale' })).not.toThrow()
    transports[0].answer({ stdout: 'mine' })
    await expect(p).resolves.toMatchObject({ stdout: 'mine' })
  })

  it('ignores a message that is not a result', async () => {
    const { transports } = install()
    const p = execCaptureOffThread('git', [], {})
    transports[0].reply({ kind: 'log', id: 1 } as unknown as Partial<ProcResult> & { id: number })
    transports[0].reply(null as unknown as Partial<ProcResult> & { id: number })
    transports[0].answer({ stdout: 'real' })
    await expect(p).resolves.toMatchObject({ stdout: 'real' })
  })

  it('turns an ok:false reply into a ProcError with code, signal and stderr', async () => {
    const { transports } = install()
    const p = execOffThread('git', ['push'], {})
    transports[0].answer({
      ok: false, stdout: '', stderr: 'rejected: non-fast-forward',
      error: { message: 'Command failed', code: 1, signal: 'SIGTERM' },
    })
    const err = await p.catch((e: unknown) => e as ProcError)
    expect(err).toBeInstanceOf(ProcError)
    expect(err).toMatchObject({ name: 'ProcError', message: 'Command failed', code: 1, signal: 'SIGTERM' })
    expect((err as ProcError).stderr).toBe('rejected: non-fast-forward')
  })

  it('substitutes a message when the host says "failed" but sends no error', async () => {
    const { transports } = install()
    const p = execCaptureOffThread('git', [], {})
    transports[0].answer({ ok: false })
    await expect(p).resolves.toEqual({ stdout: '', stderr: '', error: { message: 'proc host failed with no error' } })
  })

  it('defaults missing streams to empty strings rather than undefined', async () => {
    const { transports } = install()
    const p = execCaptureOffThread('git', [], {})
    transports[0].reply({ id: 1, stdout: undefined, stderr: undefined })
    await expect(p).resolves.toEqual({ stdout: '', stderr: '' })
  })

  it('rejects — and cleans up — when postMessage itself throws', async () => {
    const transports: FakeTransport[] = []
    setProcSpawner(() => {
      const t = makeTransport()
      t.postMessage = () => { throw new Error('channel closed') }
      transports.push(t)
      return t
    })
    await expect(execCaptureOffThread('git', [], {})).rejects.toThrow('channel closed')
    // Nothing left pending: a later host exit must not find a ghost to reject a second time.
    expect(() => transports[0].exit(0)).not.toThrow()
  })
})

describe('settlement — a call always ends, one way or another', () => {
  it('times out with SLACK over the command timeout, so the child reports genuine timeouts', async () => {
    vi.useFakeTimers()
    const { transports } = install()
    const p = execOffThread('git', ['fetch'], { timeout: 10_000 })
    const caught = p.catch((e: Error) => e)
    let settled = false
    void caught.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(settled).toBe(false)
    expect(transports[0].sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2)
    expect((await caught).message).toBe('proc host call timed out after 15000ms')
  })

  it('uses the default timeout when the caller gave none', async () => {
    vi.useFakeTimers()
    install()
    const caught = execCaptureOffThread('git', [], {}).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(15_001)
    expect((await caught).message).toBe('proc host call timed out after 15000ms')
  })

  it('does not fire the timeout for a call that already came back', async () => {
    vi.useFakeTimers()
    const { transports } = install()
    const p = execOffThread('git', [], { timeout: 1000 })
    transports[0].answer({ stdout: 'fast' })
    await expect(p).resolves.toBe('fast')
    // If the timer survived resolution it would reject an already-settled promise here — harmless
    // in itself, but it means a leaked handle per call.
    await vi.advanceTimersByTimeAsync(60_000)
  })

  it('rejects everything in flight when the host dies, instead of leaving them hanging', async () => {
    const { transports } = install()
    const a = execOffThread('git', ['a'], {})
    const b = execCaptureOffThread('git', ['b'], {})
    transports[0].exit(9)
    await expect(a).rejects.toThrow('proc host exited (code 9) with the call in flight')
    await expect(b).rejects.toThrow(/exited \(code 9\)/)
    expect(procHostActive()).toBe(false)
  })

  it('rejects in-flight calls on reset and kills the transport', async () => {
    const { transports } = install()
    const p = execCaptureOffThread('git', [], {}).catch((e: Error) => e.message)
    _resetProcClientForTests()
    expect(await p).toBe('proc client reset')
    expect(transports[0].killed).toBe(1)
  })

  it('survives a transport whose kill() throws', () => {
    setProcSpawner(() => {
      const t = makeTransport()
      t.kill = () => { throw new Error('already gone') }
      return t
    })
    void execCaptureOffThread('git', [], {}).catch(() => {})
    expect(() => _resetProcClientForTests()).not.toThrow()
  })
})

describe('the restart budget', () => {
  it('re-forks after a crash, so one bad message does not disable the host forever', async () => {
    const { transports, spawn } = install()
    const died = execCaptureOffThread('git', ['a'], {})
    transports[0].exit(1)
    await expect(died).rejects.toThrow(/in flight/)

    const p = execCaptureOffThread('git', ['b'], {})
    expect(spawn).toHaveBeenCalledTimes(2)
    transports[1].answer({ stdout: 'back' })
    await expect(p).resolves.toMatchObject({ stdout: 'back' })
  })

  it('stops re-forking after a crash LOOP and degrades to running in-process', async () => {
    const { transports, spawn } = install()
    // Six exits: the first five are inside the budget and get a restart, the sixth is one too many.
    for (let i = 0; i < 6; i++) {
      const p = execCaptureOffThread('git', [], {}).catch(() => 'died')
      transports[i].exit(1)
      expect(await p).toBe('died')
    }
    expect(spawn).toHaveBeenCalledTimes(6)

    H.runExec.mockResolvedValue({ stdout: 'in-process', stderr: '' })
    await expect(execOffThread('git', ['status'], {})).resolves.toBe('in-process')
    // The point: NOT a seventh fork, and not a failure either.
    expect(spawn).toHaveBeenCalledTimes(6)
    expect(procHostActive()).toBe(false)
  })

  it('forgets crashes older than the window — a crash an hour ago is not a crash loop', async () => {
    vi.useFakeTimers()
    const { transports, spawn } = install()
    for (let i = 0; i < 5; i++) {
      const p = execCaptureOffThread('git', [], {}).catch(() => 'died')
      transports[i].exit(1)
      expect(await p).toBe('died')
    }
    // Long enough that every one of those five has aged out of the 60s window.
    await vi.advanceTimersByTimeAsync(61_000)
    const p = execCaptureOffThread('git', [], {})
    expect(spawn).toHaveBeenCalledTimes(6)
    transports[5].answer({ stdout: 'still here' })
    await expect(p).resolves.toMatchObject({ stdout: 'still here' })
  })

  it('gives up permanently when the fork itself cannot even start', async () => {
    const spawn = vi.fn(() => { throw new Error('utilityProcess unavailable') })
    setProcSpawner(spawn)
    H.runExec.mockResolvedValue({ stdout: 'fallback', stderr: '' })
    await expect(execOffThread('git', ['a'], {})).resolves.toBe('fallback')
    await expect(execOffThread('git', ['b'], {})).resolves.toBe('fallback')
    // Retrying a fork that throws, on every single git call, would cost more than the lag we are
    // removing.
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('keeps an already-forked host after the spawner is cleared, and only refuses the NEXT fork', async () => {
    const { transports } = install()
    const p = execCaptureOffThread('git', ['a'], {})
    setProcSpawner(null)
    expect(procHostActive()).toBe(true)
    transports[0].answer({ stdout: 'still served' })
    await expect(p).resolves.toMatchObject({ stdout: 'still served' })

    transports[0].exit(0)
    H.runExec.mockResolvedValue({ stdout: 'no host', stderr: '' })
    await expect(execOffThread('git', ['b'], {})).resolves.toBe('no host')
  })
})

describe('shutting the host down for a quit', () => {
  it('kills the child, so it cannot outlive the app that forked it', async () => {
    const { transports } = install()
    const p = execCaptureOffThread('git', ['status'], {}).catch(() => 'rejected')
    expect(procHostActive()).toBe(true)
    shutdownProcHost()
    expect(transports[0].killed).toBe(1)
    expect(procHostActive()).toBe(false)
    expect(await p).toBe('rejected')
  })

  it('rejects the calls in flight rather than leaving them to time out', async () => {
    // A quit has no event loop left to wait on. A promise that can only settle by firing its own
    // 15s timeout is a promise nothing can await, and the teardown that awaits it hangs.
    const { transports } = install()
    const a = execCaptureOffThread('git', ['a'], {})
    const b = execCaptureOffThread('git', ['b'], {})
    expect(transports[0].sent).toHaveLength(2)
    shutdownProcHost()
    await expect(a).rejects.toThrow('proc host shut down')
    await expect(b).rejects.toThrow('proc host shut down')
  })

  it('clears the per-call timer, so a settled call cannot fire one afterwards', async () => {
    vi.useFakeTimers()
    const { transports } = install()
    const p = execCaptureOffThread('git', ['a'], {}).catch((e: Error) => e.message)
    shutdownProcHost()
    expect(await p).toBe('proc host shut down')
    // If the timeout were still armed it would reject an already-settled promise here, which in
    // this process means an unhandled rejection at exit.
    await vi.advanceTimersByTimeAsync(600_000)
    expect(transports[0].killed).toBe(1)
  })

  it('refuses to fork a REPLACEMENT for a poll that lands mid-quit', async () => {
    // This is the load-bearing half. The git dot and the status bar are still polling while the
    // window goes, and a fork here leaves a fresh utility process orphaned by the exit.
    const { spawn } = install()
    const inFlight = execCaptureOffThread('git', ['a'], {}).catch(() => {})
    expect(spawn).toHaveBeenCalledTimes(1)
    shutdownProcHost()
    await inFlight

    H.runExec.mockResolvedValue({ stdout: 'in-process', stderr: '' })
    await expect(execOffThread('git', ['status'], {})).resolves.toBe('in-process')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(procHostActive()).toBe(false)
  })

  it('is safe to call twice, and with no host ever forked', () => {
    expect(() => shutdownProcHost()).not.toThrow()
    install()
    void execCaptureOffThread('git', [], {}).catch(() => {})
    shutdownProcHost()
    expect(() => shutdownProcHost()).not.toThrow()
  })

  it('survives a kill that throws — the child may already be gone', () => {
    setProcSpawner(() => {
      const t = makeTransport()
      t.kill = () => { throw new Error('already gone') }
      return t
    })
    void execCaptureOffThread('git', [], {}).catch(() => {})
    expect(() => shutdownProcHost()).not.toThrow()
    expect(procHostActive()).toBe(false)
  })
})

describe('cancelling a tree exec', () => {
  it('starts nothing when the signal is already aborted, and answers cancelled', async () => {
    const { spawn } = install()
    const ac = new AbortController()
    ac.abort()
    expect(await execCaptureOffThread('claude', ['-p'], { tree: true }, ac.signal)).toEqual({
      stdout: '', stderr: '', error: { message: 'cancelled', code: 'ABORT_ERR' },
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(H.runExec).not.toHaveBeenCalled()
  })

  it('tells the host to cancel that request by its id, and settles with the host\'s answer', async () => {
    const { transports } = install()
    const ac = new AbortController()
    const call = execCaptureOffThread('claude', ['-p'], { tree: true, timeout: 60_000 }, ac.signal)
    const [t] = transports
    const id = t.sent[0].id
    ac.abort()
    expect(t.sent[1]).toEqual({ kind: 'cancel', id })
    // The call waits for the host, which answers once the tree is stopped.
    t.reply({ id, ok: false, stdout: '', stderr: '', error: { message: 'cancelled', code: 'ABORT_ERR' } })
    expect(await call).toEqual({ stdout: '', stderr: '', error: { message: 'cancelled', code: 'ABORT_ERR' } })
    // Settled: a late abort posts nothing more.
    ac.abort()
    expect(t.sent).toHaveLength(2)
  })

  it('stops listening once the call settles, and never throws on a host that is gone', async () => {
    const { transports } = install()
    const ac = new AbortController()
    const call = execCaptureOffThread('claude', ['-p'], { tree: true }, ac.signal)
    const [t] = transports
    t.answer({ stdout: 'labels' })
    expect(await call).toEqual({ stdout: 'labels', stderr: '' })
    const again = new AbortController()
    const second = execCaptureOffThread('claude', ['-p'], { tree: true }, again.signal)
    t.postMessage = () => { throw new Error('host gone') }
    expect(() => again.abort()).not.toThrow()
    t.reply({ id: t.sent[1].id, ok: false, error: { message: 'cancelled', code: 'ABORT_ERR' } })
    expect((await second).error?.code).toBe('ABORT_ERR')
    ac.abort()
    expect(t.sent).toHaveLength(2)
  })

  it('adds no listener when the request could not be posted', async () => {
    const { transports } = install()
    const ac = new AbortController()
    const add = vi.spyOn(ac.signal, 'addEventListener')
    const call = execCaptureOffThread('git', ['status'], { tree: true }, ac.signal)
    void call.catch(() => undefined)
    // The first post happens inside the promise; make the transport refuse it for the next call.
    transports[0].postMessage = () => { throw new Error('closed') }
    const refused = execCaptureOffThread('git', ['status'], { tree: true }, ac.signal)
    await expect(refused).rejects.toThrow('closed')
    expect(add).toHaveBeenCalledTimes(1)
  })

  it('hands the signal to the in-process fallback, and ignores it without tree', async () => {
    const ac = new AbortController()
    await execCaptureOffThread('claude', ['-p'], { tree: true }, ac.signal)
    expect(H.runExec).toHaveBeenLastCalledWith('claude', ['-p'], { tree: true }, ac.signal)
    ac.abort()
    await execCaptureOffThread('git', ['status'], {}, ac.signal)
    expect(H.runExec).toHaveBeenLastCalledWith('git', ['status'], {}, undefined)
  })
})

describe('ProcError', () => {
  it('leaves code and signal unset when the error carried neither', () => {
    const e = new ProcError({ message: 'boom' })
    expect(e.code).toBeUndefined()
    expect(e.signal).toBeUndefined()
    expect(e.stderr).toBe('')
  })
})

describe('the process groups a host reports (macOS and Linux)', () => {
  // Made-up pids, above Linux's highest pid_max (2^22) and macOS's (99,999).
  const A = 4_194_305
  const B = 4_194_309

  /** A tree call to the current host, with the id it was sent under. */
  function treeCall(transports: FakeTransport[]): { call: Promise<unknown>; id: number; t: FakeTransport } {
    const call = execCaptureOffThread('claude', ['-p'], { tree: true, timeout: 60_000 })
    void call.catch(() => undefined)
    const t = transports.at(-1)!
    return { call, id: t.sent.at(-1)!.id, t }
  }

  it('keeps a reported group until the host answers that run, and never signals it after', async () => {
    const { transports } = install()
    const { call, id, t } = treeCall(transports)
    t.tree(id, A)
    expect(_trackedGroupsForTests()).toEqual([A])
    t.reply({ id, stdout: 'labels' })
    expect(await call).toEqual({ stdout: 'labels', stderr: '' })
    expect(_trackedGroupsForTests()).toEqual([])
    t.exit(1)
    endProcHostGroupsNow()
    expect(H.signalProcessGroup).not.toHaveBeenCalled()
  })

  it('a host that crashes mid-run: SIGTERM to its group at once, SIGKILL after the grace', async () => {
    vi.useFakeTimers()
    const { transports } = install()
    const { call, id, t } = treeCall(transports)
    t.tree(id, A)
    t.exit(9)
    await expect(call).rejects.toThrow('proc host exited (code 9)')
    expect(H.signalProcessGroup.mock.calls).toEqual([[A, 'SIGTERM']])
    vi.advanceTimersByTime(TREE_KILL_GRACE_MS - 1)
    expect(H.signalProcessGroup).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(H.signalProcessGroup.mock.calls).toEqual([[A, 'SIGTERM'], [A, 'SIGKILL']])
    expect(_trackedGroupsForTests()).toEqual([])
  })

  it('sends no SIGKILL to a group that was gone at the SIGTERM', () => {
    vi.useFakeTimers()
    H.signalProcessGroup.mockReturnValueOnce('gone')
    const { transports } = install()
    const { id, t } = treeCall(transports)
    t.tree(id, A)
    t.exit(9)
    expect(_trackedGroupsForTests()).toEqual([])
    vi.advanceTimersByTime(TREE_KILL_GRACE_MS * 2)
    expect(H.signalProcessGroup.mock.calls).toEqual([[A, 'SIGTERM']])
  })

  it('lets the SIGKILL timer hold nothing open', () => {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const { transports } = install()
    const { id, t } = treeCall(transports)
    t.tree(id, A)
    timers.mockClear()
    t.exit(9)
    const escalation = timers.mock.results[0].value as NodeJS.Timeout
    expect(escalation.hasRef()).toBe(false)
    timers.mockRestore()
  })

  it('a restarted host: the old host\'s groups are ended once, the new host\'s stay its own', () => {
    vi.useFakeTimers()
    const { transports } = install()
    const first = treeCall(transports)
    first.t.tree(first.id, A)
    first.t.exit(1)
    const second = treeCall(transports)
    expect(transports).toHaveLength(2)
    second.t.tree(second.id, B)
    expect(H.signalProcessGroup.mock.calls).toEqual([[A, 'SIGTERM']])
    expect(_trackedGroupsForTests()).toEqual([A, B])
    vi.advanceTimersByTime(TREE_KILL_GRACE_MS)
    expect(H.signalProcessGroup.mock.calls).toEqual([[A, 'SIGTERM'], [A, 'SIGKILL']])
    second.t.exit(1)
    expect(H.signalProcessGroup.mock.calls.slice(2)).toEqual([[B, 'SIGTERM']])
    vi.advanceTimersByTime(TREE_KILL_GRACE_MS)
    expect(H.signalProcessGroup.mock.calls.slice(2)).toEqual([[B, 'SIGTERM'], [B, 'SIGKILL']])
  })

  it('ignores a report with no usable id or pid', () => {
    const { transports } = install()
    const { id, t } = treeCall(transports)
    for (const pid of [0, 1, -5, 2.5, '77', undefined]) t.tree(id, pid)
    t.tree('7', A)
    expect(_trackedGroupsForTests()).toEqual([])
  })

  it('at quit: shutdownProcHost sends SIGTERM, a run the host still answers is forgotten, and will-quit SIGKILLs the rest', () => {
    vi.useFakeTimers()
    const { transports } = install()
    const a = treeCall(transports)
    a.t.tree(a.id, A)
    const b = treeCall(transports)
    b.t.tree(b.id, B)
    shutdownProcHost()
    expect(H.signalProcessGroup.mock.calls).toEqual([[A, 'SIGTERM'], [B, 'SIGTERM']])
    // The host, ending its own groups, answers B before it goes: B's pid is no longer ours to signal.
    a.t.reply({ id: b.id, ok: false, error: { message: 'cancelled', code: 'ABORT_ERR' } })
    a.t.exit(0)
    expect(H.signalProcessGroup).toHaveBeenCalledTimes(2)
    endProcHostGroupsNow()
    expect(H.signalProcessGroup.mock.calls.slice(2)).toEqual([[A, 'SIGKILL']])
    expect(_trackedGroupsForTests()).toEqual([])
    // The grace's timer went with it.
    vi.advanceTimersByTime(TREE_KILL_GRACE_MS * 2)
    expect(H.signalProcessGroup).toHaveBeenCalledTimes(3)
  })

  it('a shutdown after a crash does not signal the crashed host\'s group twice', () => {
    vi.useFakeTimers()
    const { transports } = install()
    const first = treeCall(transports)
    first.t.tree(first.id, A)
    first.t.exit(1)
    const second = treeCall(transports)
    second.t.tree(second.id, B)
    shutdownProcHost()
    expect(H.signalProcessGroup.mock.calls).toEqual([[A, 'SIGTERM'], [B, 'SIGTERM']])
  })

  it('a group reported by a host after its shutdown is still ended when that host goes', () => {
    vi.useFakeTimers()
    const { transports } = install()
    const { id, t } = treeCall(transports)
    shutdownProcHost()
    t.tree(id, A)
    expect(_trackedGroupsForTests()).toEqual([A])
    t.exit(0)
    expect(H.signalProcessGroup.mock.calls).toEqual([[A, 'SIGTERM']])
  })

  it('a group reported after its host\'s exit (the last message can trail the exit) is ended at once', () => {
    vi.useFakeTimers()
    const { transports } = install()
    const { call, id, t } = treeCall(transports)
    t.exit(9)
    void call.catch(() => undefined)
    expect(H.signalProcessGroup).not.toHaveBeenCalled()
    t.tree(id, A)
    expect(H.signalProcessGroup.mock.calls).toEqual([[A, 'SIGTERM']])
    vi.advanceTimersByTime(TREE_KILL_GRACE_MS)
    expect(H.signalProcessGroup.mock.calls).toEqual([[A, 'SIGTERM'], [A, 'SIGKILL']])
    expect(_trackedGroupsForTests()).toEqual([])
  })

  it('at quit also SIGKILLs the groups of runs main started itself while the host was down', () => {
    H.treeGroupsInFlight.mockReturnValue([A])
    endProcHostGroupsNow()
    expect(H.signalProcessGroup.mock.calls).toEqual([[A, 'SIGKILL']])
  })

  it('a reset forgets every group without signalling one', () => {
    vi.useFakeTimers()
    const { transports } = install()
    const { id, t } = treeCall(transports)
    t.tree(id, A)
    _resetProcClientForTests()
    expect(_trackedGroupsForTests()).toEqual([])
    vi.advanceTimersByTime(TREE_KILL_GRACE_MS * 2)
    expect(H.signalProcessGroup).not.toHaveBeenCalled()
  })
})
