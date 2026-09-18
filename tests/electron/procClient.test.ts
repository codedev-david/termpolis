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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const H = vi.hoisted(() => ({
  runExec: vi.fn(),
  runShell: vi.fn(),
}))

vi.mock('../../src/main/procHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/procHost')>()
  return { ...actual, runExec: H.runExec, runShell: H.runShell }
})

import type { ProcRequest, ProcResult } from '../../src/main/procHost'
import {
  setProcSpawner,
  _resetProcClientForTests,
  procHostActive,
  shutdownProcHost,
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
  exit(code: number): void
}

function makeTransport(): FakeTransport {
  let onMsg: ((m: ProcResult) => void) | null = null
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
    expect(H.runExec).toHaveBeenCalledWith('git', ['status'], { cwd: '/repo' })
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
