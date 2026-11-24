// @vitest-environment node
import { EventEmitter } from 'events'
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SpawnOptions } from 'child_process'
import {
  endProcessTree,
  killProcessTree,
  signalProcessGroup,
  taskkillPath,
  TREE_KILL_GRACE_MS,
  SYNC_TASKKILL_TIMEOUT_MS,
  TASKKILL_TIMEOUT_MS,
} from '../../src/main/processTree'

// Every spawn and signal here is a fake. A real `taskkill /pid N /T /F` or kill(-N) aimed at an
// arbitrary number would end whatever process happens to own it. The real-process proof lives
// in secondOpinionDeliver.process.test.ts, where every pid belongs to a stand-in the test started.

function fakeTaskkill() {
  const proc = { on: vi.fn(), unref: vi.fn() }
  return { proc, spawn: vi.fn((_cmd: string, _args: string[], _opts: SpawnOptions) => proc) }
}

/** How one scripted taskkill ends: an exit (code, and the signal a timeout ends it with), a spawn
 *  error, a spawn error followed by an exit, or never. */
type Ending =
  | { exit: number | null; signal?: NodeJS.Signals | null }
  | { error: Error; thenExit?: boolean }
  | { hang: true }

/** A taskkill per call, each ending as scripted, on a microtask after the spawn returns. */
function scriptedTaskkill(...endings: Ending[]) {
  const procs: Array<EventEmitter & { unref: () => void }> = []
  const spawn = vi.fn((_cmd: string, _args: string[], _opts: SpawnOptions) => {
    const ending = endings[procs.length]
    const proc = Object.assign(new EventEmitter(), { unref: vi.fn() })
    procs.push(proc)
    queueMicrotask(() => {
      if ('hang' in ending) return
      if ('error' in ending) {
        proc.emit('error', ending.error)
        if (ending.thenExit) proc.emit('exit', 1, null)
      } else proc.emit('exit', ending.exit, ending.signal ?? null)
    })
    return proc
  })
  return { spawn, procs }
}

const errno = (code: string): Error => Object.assign(new Error(`failed ${code}`), { code })

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try { return fn() } finally { Object.defineProperty(process, 'platform', original) }
}

afterEach(() => {
  // Spies first: one wrapped around a fake setTimeout must not be put back after the real one.
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('killProcessTree refuses a pid that is not a real child', () => {
  // As a process GROUP, -0 is our own group and -1 is every process we may signal, and a
  // negative pid would flip into a positive one. None of them may ever reach a kill.
  it.each([undefined, 0, 1, -1, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s on every platform', async (pid) => {
    const { spawn } = fakeTaskkill()
    const spawnSync = vi.fn()
    const kill = vi.fn()
    const log = vi.fn()
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      for (const sync of [false, true]) {
        expect(killProcessTree(pid, { platform, sync }, { spawn, spawnSync, kill, env: {}, log })).toBe(false)
      }
      expect(await endProcessTree(pid, { platform }, { spawn, spawnSync, kill, env: {}, log })).toBe(false)
    }
    expect(spawn).not.toHaveBeenCalled()
    expect(spawnSync).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
})

describe('killProcessTree on Windows', () => {
  it('runs taskkill /pid <pid> /T /F by absolute path, hidden, without a shell', () => {
    const { spawn } = fakeTaskkill()
    const kill = vi.fn()
    expect(killProcessTree(4321, { platform: 'win32' }, { spawn, kill, env: { SystemRoot: 'D:\\Win' } })).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawn.mock.calls[0]
    expect(cmd).toBe('D:\\Win\\System32\\taskkill.exe')
    // /T is the whole point: the agent runs UNDER the PowerShell wrapper this pid names.
    expect(args).toEqual(['/pid', '4321', '/T', '/F'])
    // Bounded, so a taskkill that hangs still ends, and is logged and can be tried again.
    expect(opts).toEqual({ windowsHide: true, stdio: 'ignore', timeout: TASKKILL_TIMEOUT_MS })
    // Windows has no process groups to signal.
    expect(kill).not.toHaveBeenCalled()
  })

  it('listens for a taskkill that fails to start, and unrefs its child handle', () => {
    const { proc, spawn } = fakeTaskkill()
    killProcessTree(4321, { platform: 'win32' }, { spawn, env: {}, log: vi.fn() })
    // An 'error' with no listener would be thrown as an uncaught exception in the main process.
    expect(proc.on).toHaveBeenCalledWith('error', expect.any(Function))
    const onError = proc.on.mock.calls[0][1] as (e: Error) => void
    expect(() => onError(new Error('spawn taskkill.exe ENOENT'))).not.toThrow()
    expect(proc.on).toHaveBeenCalledWith('exit', expect.any(Function))
    expect(proc.unref).toHaveBeenCalledTimes(1)
  })

  it('never throws when taskkill cannot be spawned at all, and logs it', async () => {
    const log = vi.fn()
    const spawn = vi.fn(() => { throw new Error('spawn EPERM') })
    expect(killProcessTree(4321, { platform: 'win32' }, { spawn, env: {}, log })).toBe(true)
    const spawnSync = vi.fn(() => { throw errno('EPERM') })
    expect(killProcessTree(4321, { platform: 'win32', sync: true }, { spawnSync, env: {}, log })).toBe(true)
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2))
    // An error without a code is still one short line.
    expect(log.mock.calls).toEqual([
      ['[processTree] taskkill did not end pid 4321 (exit EPERM)'],
      ['[processTree] taskkill did not end pid 4321 (exit error)'],
    ])
  })

  it('at quit it waits for taskkill, bounded, since no timer fires again', () => {
    const { spawn } = fakeTaskkill()
    const log = vi.fn()
    const spawnSync = vi.fn((_cmd: string, _args: string[], _opts: object) => ({ status: 0, signal: null }))
    expect(killProcessTree(99, { platform: 'win32', sync: true }, { spawn, spawnSync, env: { windir: 'E:\\W' }, log })).toBe(true)
    expect(spawnSync).toHaveBeenCalledWith(
      'E:\\W\\System32\\taskkill.exe',
      ['/pid', '99', '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', timeout: SYNC_TASKKILL_TIMEOUT_MS },
    )
    expect(spawn).not.toHaveBeenCalled()
    // taskkill itself takes 1 to 2 s. A cap near that ends it before it reaches the agent, which
    // is what a 2 s cap did under load, so the cap has to leave it room.
    expect(SYNC_TASKKILL_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
    expect(TASKKILL_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
    // A taskkill that worked says nothing.
    expect(log).not.toHaveBeenCalled()
  })

  it.each([
    [{ status: 1, signal: null }, '1'],
    [{ status: 128, signal: null }, '128'],
    [{ status: null, signal: 'SIGTERM', error: errno('ETIMEDOUT') }, 'ETIMEDOUT'],
    [{ status: null, signal: 'SIGTERM' }, 'SIGTERM'],
    [{}, 'none'],
    [undefined, 'none'],
  ])('at quit it logs a taskkill that did not work (%o) once, by pid and code only', (result, code) => {
    const log = vi.fn()
    const canRetry = vi.fn(() => true)
    const spawnSync = vi.fn(() => result)
    expect(killProcessTree(99, { platform: 'win32', sync: true, canRetry }, { spawnSync, env: {}, log })).toBe(true)
    // No retry at quit: the child's exit event, the proof that the pid is still ours, can't come.
    expect(spawnSync).toHaveBeenCalledTimes(1)
    expect(canRetry).not.toHaveBeenCalled()
    expect(log.mock.calls).toEqual([[`[processTree] taskkill did not end pid 99 (exit ${code})`]])
  })

  it('finds taskkill through process.env when no env is given', () => {
    vi.stubEnv('SystemRoot', 'Q:\\Sys')
    const { spawn } = fakeTaskkill()
    killProcessTree(77, { platform: 'win32' }, { spawn, log: vi.fn() })
    expect(spawn.mock.calls[0][0]).toBe('Q:\\Sys\\System32\\taskkill.exe')
  })
})

describe('endProcessTree on Windows waits for taskkill, retries once, and logs a failure', () => {
  it('resolves true when taskkill exits 0, with one taskkill and no log', async () => {
    const { spawn } = scriptedTaskkill({ exit: 0 })
    const log = vi.fn()
    const canRetry = vi.fn(() => true)
    expect(await endProcessTree(4321, { platform: 'win32', canRetry }, { spawn, env: {}, log })).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(canRetry).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('is still pending while taskkill runs', async () => {
    const { spawn } = scriptedTaskkill({ hang: true })
    let settled = false
    void endProcessTree(4321, { platform: 'win32' }, { spawn, env: {}, log: vi.fn() }).then(() => { settled = true })
    await new Promise((r) => setImmediate(r))
    expect(settled).toBe(false)
  })

  it('tries a failed taskkill once more while the caller says the root is still its own', async () => {
    const { spawn } = scriptedTaskkill({ exit: 1 }, { exit: 0 })
    const log = vi.fn()
    const canRetry = vi.fn(() => true)
    expect(await endProcessTree(4321, { platform: 'win32', canRetry }, { spawn, env: {}, log })).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1][1]).toEqual(['/pid', '4321', '/T', '/F'])
    expect(canRetry).toHaveBeenCalledTimes(1)
    // The retry worked, so nothing is logged.
    expect(log).not.toHaveBeenCalled()
  })

  it('stops after one retry, and logs the failure once, naming only the pid and the code', async () => {
    const { spawn } = scriptedTaskkill({ exit: 1 }, { exit: 255 }, { exit: 0 })
    const log = vi.fn()
    const canRetry = vi.fn(() => true)
    expect(await endProcessTree(4321, { platform: 'win32', canRetry }, { spawn, env: {}, log })).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(canRetry).toHaveBeenCalledTimes(1)
    expect(log.mock.calls).toEqual([['[processTree] taskkill did not end pid 4321 (exit 255)']])
  })

  it('never retries once the root has exited, since its pid may already name a stranger', async () => {
    const { spawn } = scriptedTaskkill({ exit: 1 }, { exit: 0 })
    const log = vi.fn()
    expect(await endProcessTree(4321, { platform: 'win32', canRetry: () => false }, { spawn, env: {}, log })).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(log.mock.calls).toEqual([['[processTree] taskkill did not end pid 4321 (exit 1)']])
  })

  it('never retries a taskkill that found no such process, even while the caller would allow it', async () => {
    const { spawn } = scriptedTaskkill({ exit: 128 }, { exit: 0 })
    const log = vi.fn()
    const canRetry = vi.fn(() => true)
    expect(await endProcessTree(4321, { platform: 'win32', canRetry }, { spawn, env: {}, log })).toBe(false)
    // The root is gone, so /T has nothing to walk from, and a second taskkill could meet a reused pid.
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(canRetry).not.toHaveBeenCalled()
    expect(log.mock.calls).toEqual([['[processTree] taskkill did not end pid 4321 (exit 128)']])
  })

  it('never retries without a canRetry, or when it throws', async () => {
    for (const canRetry of [undefined, () => { throw new Error('no answer') }]) {
      const { spawn } = scriptedTaskkill({ exit: 1 }, { exit: 0 })
      const log = vi.fn()
      expect(await endProcessTree(4321, { platform: 'win32', canRetry }, { spawn, env: {}, log })).toBe(false)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(log).toHaveBeenCalledTimes(1)
    }
  })

  it('counts a taskkill that cannot start as a failure, once, even when it also exits', async () => {
    const { spawn } = scriptedTaskkill({ error: errno('ENOENT'), thenExit: true }, { error: new Error('no code') })
    const log = vi.fn()
    expect(await endProcessTree(4321, { platform: 'win32', canRetry: () => true }, { spawn, env: {}, log })).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(log.mock.calls).toEqual([['[processTree] taskkill did not end pid 4321 (exit error)']])
  })

  it('reports a taskkill its timeout ended by the signal, and one with no code at all as none', async () => {
    const log = vi.fn()
    const timedOut = scriptedTaskkill({ exit: null, signal: 'SIGTERM' })
    expect(await endProcessTree(5, { platform: 'win32' }, { spawn: timedOut.spawn, env: {}, log })).toBe(false)
    const bare = scriptedTaskkill({ exit: null })
    expect(await endProcessTree(5, { platform: 'win32' }, { spawn: bare.spawn, env: {}, log })).toBe(false)
    expect(log.mock.calls).toEqual([
      ['[processTree] taskkill did not end pid 5 (exit SIGTERM)'],
      ['[processTree] taskkill did not end pid 5 (exit none)'],
    ])
  })

  it('logs through console.warn by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { spawn } = scriptedTaskkill({ exit: 1 })
    expect(await endProcessTree(4321, { platform: 'win32' }, { spawn, env: {} })).toBe(false)
    expect(warn).toHaveBeenCalledWith('[processTree] taskkill did not end pid 4321 (exit 1)')
  })

  it('killProcessTree runs the same wait, retry and log in the background', async () => {
    const { spawn } = scriptedTaskkill({ exit: 1 }, { exit: 1 })
    const log = vi.fn()
    expect(killProcessTree(4321, { platform: 'win32', canRetry: () => true }, { spawn, env: {}, log })).toBe(true)
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1))
    expect(spawn).toHaveBeenCalledTimes(2)
  })
})

describe('taskkillPath', () => {
  it('prefers SystemRoot, then windir, then C:\\Windows', () => {
    expect(taskkillPath({ SystemRoot: 'C:\\WINDOWS', windir: 'X:\\no' })).toBe('C:\\WINDOWS\\System32\\taskkill.exe')
    expect(taskkillPath({ windir: 'X:\\Win' })).toBe('X:\\Win\\System32\\taskkill.exe')
    expect(taskkillPath({})).toBe('C:\\Windows\\System32\\taskkill.exe')
    // An empty value is no directory at all, so it falls through too.
    expect(taskkillPath({ SystemRoot: '', windir: '' })).toBe('C:\\Windows\\System32\\taskkill.exe')
  })

  it('reads process.env by default', () => {
    vi.stubEnv('SystemRoot', 'R:\\Root')
    expect(taskkillPath()).toBe('R:\\Root\\System32\\taskkill.exe')
  })
})

describe('killProcessTree on macOS and Linux', () => {
  it('SIGTERMs the whole group, then SIGKILLs what is left after the grace period', () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    const { spawn } = fakeTaskkill()
    expect(killProcessTree(700, { platform: 'linux' }, { kill, spawn })).toBe(true)
    // The NEGATIVE pid: the group the detached agent leads, not just the agent.
    expect(kill.mock.calls).toEqual([[-700, 'SIGTERM']])
    vi.advanceTimersByTime(TREE_KILL_GRACE_MS - 1)
    expect(kill).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(kill.mock.calls).toEqual([[-700, 'SIGTERM'], [-700, 'SIGKILL']])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('honours a custom grace period', () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    killProcessTree(700, { platform: 'darwin', graceMs: 50 }, { kill })
    vi.advanceTimersByTime(49)
    expect(kill).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(kill).toHaveBeenLastCalledWith(-700, 'SIGKILL')
  })

  it('does not let the SIGKILL timer hold the process open', () => {
    // Real timers, so this is Node's own Timeout and not a fake's idea of one.
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const kill = vi.fn()
    killProcessTree(700, { platform: 'linux' }, { kill })
    const escalation = timers.mock.results[0].value as NodeJS.Timeout
    expect(escalation.hasRef()).toBe(false)
    clearTimeout(escalation)
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('swallows ESRCH from a group that is already gone, without a log, and sends it no SIGKILL', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const kill = vi.fn(() => { throw errno('ESRCH') })
    expect(killProcessTree(700, { platform: 'linux' }, { kill, log })).toBe(true)
    // No member holds the group ID any more, so it may be reused: a SIGKILL 2 s later could reach a
    // stranger's group. Nothing is armed.
    expect(vi.getTimerCount()).toBe(0)
    vi.runAllTimers()
    expect(kill.mock.calls).toEqual([[-700, 'SIGTERM']])
    // A group already gone is what a kill wants, so it counts as delivered.
    expect(await endProcessTree(700, { platform: 'linux' }, { kill, log })).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(log).not.toHaveBeenCalled()
  })

  it('logs any other failure once per kill, by pid and error code only', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const kill = vi.fn(() => { throw errno('EPERM') })
    expect(await endProcessTree(700, { platform: 'linux' }, { kill, log })).toBe(false)
    vi.runAllTimers()
    // SIGTERM and SIGKILL both failed, and that is one line.
    expect(kill).toHaveBeenCalledTimes(2)
    expect(log.mock.calls).toEqual([['[processTree] SIGTERM did not reach process group 700 (EPERM)']])
  })

  it('logs a SIGKILL that fails after a SIGTERM that worked', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => { if (signal === 'SIGKILL') throw new Error('odd') })
    expect(await endProcessTree(700, { platform: 'darwin' }, { kill, log })).toBe(true)
    expect(log).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(log.mock.calls).toEqual([['[processTree] SIGKILL did not reach process group 700 (error)']])
  })

  it('at quit it goes straight to SIGKILL and leaves no timer behind', () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    expect(killProcessTree(700, { platform: 'linux', sync: true }, { kill })).toBe(true)
    expect(kill.mock.calls).toEqual([[-700, 'SIGKILL']])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('at quit it logs a SIGKILL that failed for a reason other than ESRCH', () => {
    const log = vi.fn()
    expect(killProcessTree(700, { platform: 'linux', sync: true }, { kill: () => { throw errno('ESRCH') }, log })).toBe(true)
    expect(log).not.toHaveBeenCalled()
    expect(killProcessTree(700, { platform: 'linux', sync: true }, { kill: () => { throw errno('EPERM') }, log })).toBe(true)
    expect(log.mock.calls).toEqual([['[processTree] SIGKILL did not reach process group 700 (EPERM)']])
  })

  it('signals through process.kill by default', () => {
    vi.useFakeTimers()
    // Mocked, so no real signal is sent.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    killProcessTree(700, { platform: 'linux' })
    expect(kill).toHaveBeenCalledWith(-700, 'SIGTERM')
    vi.advanceTimersByTime(TREE_KILL_GRACE_MS)
    expect(kill).toHaveBeenCalledWith(-700, 'SIGKILL')
  })
})

describe('killProcessTree defaults to the platform it runs on', () => {
  it('uses taskkill on Windows', () => {
    const { spawn } = fakeTaskkill()
    const kill = vi.fn()
    withPlatform('win32', () => killProcessTree(55, {}, { spawn, kill, env: {} }))
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(kill).not.toHaveBeenCalled()
  })

  it('signals the group elsewhere', () => {
    vi.useFakeTimers()
    const { spawn } = fakeTaskkill()
    const kill = vi.fn()
    withPlatform('linux', () => killProcessTree(55, {}, { spawn, kill, env: {} }))
    expect(kill).toHaveBeenCalledWith(-55, 'SIGTERM')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('at quit as well', () => {
    const spawnSync = vi.fn(() => ({ status: 0 }))
    const kill = vi.fn()
    withPlatform('win32', () => killProcessTree(55, { sync: true }, { spawnSync, kill, env: {} }))
    expect(spawnSync).toHaveBeenCalledTimes(1)
    withPlatform('linux', () => killProcessTree(55, { sync: true }, { spawnSync, kill, env: {} }))
    expect(kill).toHaveBeenCalledWith(-55, 'SIGKILL')
  })

  it('and for endProcessTree', async () => {
    const { spawn } = scriptedTaskkill({ exit: 0 })
    expect(await withPlatform('win32', () => endProcessTree(55, {}, { spawn, env: {} }))).toBe(true)
    vi.useFakeTimers()
    const kill = vi.fn()
    expect(await withPlatform('linux', () => endProcessTree(55, {}, { kill }))).toBe(true)
    expect(kill).toHaveBeenCalledWith(-55, 'SIGTERM')
  })
})

describe('signalProcessGroup', () => {
  it('sends one signal to the group the pid leads, with no spawn and no timer', () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    const spawn = vi.fn()
    expect(signalProcessGroup(700, 'SIGTERM', { kill, spawn })).toBe('sent')
    vi.advanceTimersByTime(TREE_KILL_GRACE_MS * 2)
    expect(kill.mock.calls).toEqual([[-700, 'SIGTERM']])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('says a group that is gone is gone, without a log', () => {
    const log = vi.fn()
    expect(signalProcessGroup(700, 'SIGKILL', { kill: () => { throw errno('ESRCH') }, log })).toBe('gone')
    expect(log).not.toHaveBeenCalled()
  })

  it('logs any other failure, naming only the pid and the code', () => {
    const log = vi.fn()
    expect(signalProcessGroup(700, 'SIGKILL', { kill: () => { throw errno('EPERM') }, log })).toBe('failed')
    expect(log.mock.calls).toEqual([['[processTree] SIGKILL did not reach process group 700 (EPERM)']])
  })

  it('never signals a pid that is not a real child', () => {
    const kill = vi.fn()
    for (const pid of [undefined, 0, 1, -5, 2.5]) expect(signalProcessGroup(pid, 'SIGKILL', { kill })).toBe('failed')
    expect(kill).not.toHaveBeenCalled()
  })
})
