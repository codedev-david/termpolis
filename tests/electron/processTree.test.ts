// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SpawnOptions } from 'child_process'
import {
  killProcessTree,
  taskkillPath,
  TREE_KILL_GRACE_MS,
  SYNC_TASKKILL_TIMEOUT_MS,
} from '../../src/main/processTree'

// Every spawn and signal here is a fake. A real `taskkill /pid N /T /F` or kill(-N) aimed at an
// arbitrary number would end whatever process happens to own it. The real-process proof lives
// in secondOpinionDeliver.process.test.ts, where every pid belongs to a stand-in the test started.

function fakeTaskkill() {
  const proc = { on: vi.fn(), unref: vi.fn() }
  return { proc, spawn: vi.fn((_cmd: string, _args: string[], _opts: SpawnOptions) => proc) }
}

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
  it.each([undefined, 0, 1, -1, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s on every platform', (pid) => {
    const { spawn } = fakeTaskkill()
    const spawnSync = vi.fn()
    const kill = vi.fn()
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      for (const sync of [false, true]) {
        expect(killProcessTree(pid, { platform, sync }, { spawn, spawnSync, kill, env: {} })).toBe(false)
      }
    }
    expect(spawn).not.toHaveBeenCalled()
    expect(spawnSync).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
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
    expect(opts).toEqual({ windowsHide: true, stdio: 'ignore' })
    // Windows has no process groups to signal.
    expect(kill).not.toHaveBeenCalled()
  })

  it('swallows a taskkill that fails to start, and never waits on it', () => {
    const { proc, spawn } = fakeTaskkill()
    killProcessTree(4321, { platform: 'win32' }, { spawn, env: {} })
    // An 'error' with no listener would be thrown as an uncaught exception in the main process.
    expect(proc.on).toHaveBeenCalledWith('error', expect.any(Function))
    const onError = proc.on.mock.calls[0][1] as (e: Error) => void
    expect(() => onError(new Error('spawn taskkill.exe ENOENT'))).not.toThrow()
    expect(proc.unref).toHaveBeenCalledTimes(1)
  })

  it('never throws when taskkill cannot be spawned at all', () => {
    const spawn = vi.fn(() => { throw new Error('spawn EPERM') })
    expect(killProcessTree(4321, { platform: 'win32' }, { spawn, env: {} })).toBe(true)
    const spawnSync = vi.fn(() => { throw new Error('spawnSync EPERM') })
    expect(killProcessTree(4321, { platform: 'win32', sync: true }, { spawnSync, env: {} })).toBe(true)
  })

  it('at quit it waits for taskkill, bounded, since no timer fires again', () => {
    const { spawn } = fakeTaskkill()
    const spawnSync = vi.fn((_cmd: string, _args: string[], _opts: object) => undefined)
    expect(killProcessTree(99, { platform: 'win32', sync: true }, { spawn, spawnSync, env: { windir: 'E:\\W' } })).toBe(true)
    expect(spawnSync).toHaveBeenCalledWith(
      'E:\\W\\System32\\taskkill.exe',
      ['/pid', '99', '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', timeout: SYNC_TASKKILL_TIMEOUT_MS },
    )
    expect(spawn).not.toHaveBeenCalled()
    // taskkill itself takes 1 to 2 s. A cap near that ends it before it reaches the agent, which
    // is what a 2 s cap did under load, so the cap has to leave it room.
    expect(SYNC_TASKKILL_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
  })

  it('finds taskkill through process.env when no env is given', () => {
    vi.stubEnv('SystemRoot', 'Q:\\Sys')
    const { spawn } = fakeTaskkill()
    killProcessTree(77, { platform: 'win32' }, { spawn })
    expect(spawn.mock.calls[0][0]).toBe('Q:\\Sys\\System32\\taskkill.exe')
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

  it('swallows ESRCH from a group that is already gone', () => {
    vi.useFakeTimers()
    const kill = vi.fn(() => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }) })
    expect(killProcessTree(700, { platform: 'linux' }, { kill })).toBe(true)
    expect(() => vi.runAllTimers()).not.toThrow()
    expect(kill).toHaveBeenCalledTimes(2)
  })

  it('at quit it goes straight to SIGKILL and leaves no timer behind', () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    expect(killProcessTree(700, { platform: 'linux', sync: true }, { kill })).toBe(true)
    expect(kill.mock.calls).toEqual([[-700, 'SIGKILL']])
    expect(vi.getTimerCount()).toBe(0)
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
})
