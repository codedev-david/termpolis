// Closing a terminal ends the process tree under its shell (terminalTreeKill.ts), not only the shell.
//
// Load-bearing:
//   * Windows: taskkill /T /F by absolute path, run through the proc host (never spawned on main), and it never rejects;
//   * POSIX: the shell's process GROUP (negative pid), SIGTERM then SIGKILL after the grace;
//   * pids 0, 1 and non-integers are never signalled;
//   * terminalManager: on Windows the tree goes BEFORE the shell (taskkill finds the tree only through a live root),
//     and the console list read before the tree is the one node-pty ends;
//   * off by default, and quit (killAll) never takes the tree step.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

const H = vi.hoisted(() => ({
  order: [] as string[],
  consoleList: vi.fn(async (_pid: number): Promise<number[] | null> => [9000, 9100]),
  agents: [] as any[],
  ptys: [] as any[],
}))

vi.mock('electron', () => ({ app: { getPath: () => require('os').tmpdir(), isPackaged: false } }))
vi.mock('node-pty', () => {
  const spawn = vi.fn(() => {
    const pid = 9000 + H.ptys.length
    const agent = { innerPid: pid, _getConsoleProcessList: vi.fn(() => Promise.resolve([pid])) }
    H.agents.push(agent)
    const p = {
      pid,
      _agent: agent,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => { H.order.push(`pty.kill:${pid}`) }),
    }
    H.ptys.push(p)
    return p
  })
  return { spawn, default: { spawn } }
})
vi.mock('../../src/main/procClient', () => ({
  execShellCaptureOffThread: vi.fn(async () => ({ stdout: '', stderr: '' })),
  execCaptureOffThread: vi.fn(async () => ({ stdout: '', stderr: '' })),
}))
vi.mock('../../src/main/shellAlone', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/shellAlone')>()),
  readConsoleProcessList: H.consoleList,
}))

type TM = typeof import('../../src/main/terminalManager')
type TK = typeof import('../../src/main/terminalTreeKill')
let tm: TM
let tk: TK
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
const setPlatform = (p: string): void => { Object.defineProperty(process, 'platform', { value: p, configurable: true }) }

beforeAll(async () => {
  tm = await import('../../src/main/terminalManager')
  tk = await import('../../src/main/terminalTreeKill')
  await tm.primeBundledToolsCheck()
})
beforeEach(() => {
  H.order.length = 0
  H.agents.length = 0
  H.ptys.length = 0
  H.consoleList.mockReset()
  H.consoleList.mockResolvedValue([9000, 9100])
  // The shell is ended with process.kill(pid) and these pids are made up: nothing real is ever signalled.
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string) => { H.order.push(`process.kill:${pid}${sig ? `:${sig}` : ''}`); return true }) as typeof process.kill)
})
afterEach(() => {
  tk.setTerminalTreeKiller(null)
  Object.defineProperty(process, 'platform', realPlatform)
  vi.mocked(process.kill).mockRestore()
  delete process.env.TERMPOLIS_CONSOLE_LIST_INPROC
})

describe('createTerminalTreeKiller', () => {
  it('Windows: taskkill /pid <pid> /T /F by absolute path, through the run seam', async () => {
    const run = vi.fn(async () => ({}))
    const kill = tk.createTerminalTreeKiller({ platform: 'win32', env: { SystemRoot: 'D:\\Win' }, run })
    await kill(4242)
    expect(run).toHaveBeenCalledWith('D:\\Win\\System32\\taskkill.exe', ['/pid', '4242', '/T', '/F'], { timeout: expect.any(Number) })
  })

  it('Windows: a taskkill that fails or throws still resolves', async () => {
    await expect(tk.createTerminalTreeKiller({ platform: 'win32', run: vi.fn(async () => { throw new Error('host down') }) })(77)).resolves.toEqual(new Set())
    await expect(tk.createTerminalTreeKiller({ platform: 'win32', run: vi.fn(() => { throw new Error('sync throw') }) })(77)).resolves.toEqual(new Set())
  })

  it('Windows: resolves with the pids taskkill reported, whatever the language of its words', async () => {
    const stdout = 'SUCCESS: The process with PID 9100 (child process of PID 9000) has been terminated.\r\n' +
      'ERFOLGREICH: Der Prozess mit PID 9000 (untergeordneter Prozess von PID 812) wurde beendet.\r\n'
    const run = vi.fn(async () => ({ stdout, stderr: '' }))
    expect(await tk.createTerminalTreeKiller({ platform: 'win32', run })(9000)).toEqual(new Set([9100, 9000, 812]))
    expect(tk.pidsInTaskkillReport(undefined)).toEqual(new Set())
    expect(tk.pidsInTaskkillReport('no pids, 0 and 99999999999999999999 are not pids')).toEqual(new Set())
    expect(tk.withoutEnded(null, new Set([1]))).toBeNull()
    expect(tk.withoutEnded([5, 6, 7], new Set([6]))).toEqual([5, 7])
  })

  it('Windows: defaults to the proc host', async () => {
    const { execCaptureOffThread } = await import('../../src/main/procClient')
    vi.mocked(execCaptureOffThread).mockClear()
    await tk.createTerminalTreeKiller({ platform: 'win32' })(31337)
    expect(vi.mocked(execCaptureOffThread).mock.calls[0][1]).toEqual(['/pid', '31337', '/T', '/F'])
  })

  it('POSIX: the process group, SIGTERM now and SIGKILL after the grace', async () => {
    vi.useFakeTimers()
    try {
      const kill = vi.fn()
      await tk.createTerminalTreeKiller({ platform: 'linux', kill, graceMs: 50 })(5000)
      expect(kill).toHaveBeenCalledWith(-5000, 'SIGTERM')
      expect(kill).not.toHaveBeenCalledWith(-5000, 'SIGKILL')
      vi.advanceTimersByTime(50)
      expect(kill).toHaveBeenCalledWith(-5000, 'SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('POSIX: without a grace option, processTree\'s default applies', async () => {
    vi.useFakeTimers()
    try {
      const kill = vi.fn()
      await tk.createTerminalTreeKiller({ platform: 'darwin', kill })(5001)
      vi.advanceTimersByTime(1)
      expect(kill).toHaveBeenCalledTimes(1)
      vi.runAllTimers()
      expect(kill).toHaveBeenCalledWith(-5001, 'SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('with no seams: the running platform, and process.kill on the group (spied here, nothing real is signalled)', async () => {
    vi.useFakeTimers()
    try {
      setPlatform('linux')
      await tk.createTerminalTreeKiller()(5002)
      expect(H.order).toEqual(['process.kill:-5002:SIGTERM'])
      vi.runAllTimers()
      expect(H.order).toEqual(['process.kill:-5002:SIGTERM', 'process.kill:-5002:SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('never signals pid 0, 1 or a non-integer', async () => {
    const run = vi.fn(async () => ({}))
    const kill = vi.fn()
    for (const pid of [0, 1, -3, 2.5, NaN]) {
      await tk.createTerminalTreeKiller({ platform: 'win32', run })(pid)
      await tk.createTerminalTreeKiller({ platform: 'linux', kill })(pid)
    }
    expect(run).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('is off until the app turns it on', () => {
    expect(tk.terminalTreeKiller()).toBeNull()
    const k = tk.createTerminalTreeKiller()
    tk.setTerminalTreeKiller(k)
    expect(tk.terminalTreeKiller()).toBe(k)
  })
})

describe('killTerminal with the tree killer on', () => {
  it('Windows: reads the console, ends the tree, THEN ends the shell with that list', async () => {
    setPlatform('win32')
    let release!: (ended: ReadonlySet<number>) => void
    const killer = vi.fn((pid: number) => { H.order.push(`tree:${pid}`); return new Promise<ReadonlySet<number>>((r) => { release = r }) })
    tk.setTerminalTreeKiller(killer)
    tm.spawnTerminal('w1', 'C:\\Windows\\System32\\cmd.exe', 'C:\\', () => {})
    tm.killTerminal('w1')
    expect(tm.getTerminalPid('w1')).toBeNull() // gone from the map at once
    await vi.waitFor(() => expect(killer).toHaveBeenCalledWith(9000))
    expect(H.consoleList).toHaveBeenCalledWith(9000)
    expect(H.order).toEqual(['tree:9000']) // the shell is still alive while taskkill walks the tree
    release(new Set())
    await vi.waitFor(() => expect(H.order).toEqual(['tree:9000', 'pty.kill:9000', 'process.kill:9000']))
    expect(await H.agents[0]._getConsoleProcessList()).toEqual([9000, 9100]) // the list read before the tree went
  })

  it('Windows: what taskkill ended leaves the list, so a pid reused meanwhile is never ended', async () => {
    setPlatform('win32')
    tk.setTerminalTreeKiller(vi.fn(async () => new Set([9000, 4])))
    tm.spawnTerminal('w9', 'C:\\Windows\\System32\\cmd.exe', 'C:\\', () => {})
    tm.killTerminal('w9')
    await vi.waitFor(() => expect(H.order).toContain('pty.kill:9000'))
    // 9100 left the shell's tree (its parent exited) but is still on the console: it goes with the shell.
    expect(await H.agents.at(-1)!._getConsoleProcessList()).toEqual([9100])
  })

  it('Windows: a console list that cannot be read pins the shell alone', async () => {
    setPlatform('win32')
    H.consoleList.mockRejectedValueOnce(new Error('no host'))
    tk.setTerminalTreeKiller(vi.fn(async () => new Set<number>()))
    tm.spawnTerminal('w2', 'C:\\Windows\\System32\\cmd.exe', 'C:\\', () => {})
    tm.killTerminal('w2')
    await vi.waitFor(() => expect(H.order).toContain('pty.kill:9000'))
    expect(await H.agents[0]._getConsoleProcessList()).toEqual([9000])
  })

  it('Windows: a tree killer that rejects anyway still ends the shell', async () => {
    setPlatform('win32')
    tk.setTerminalTreeKiller(vi.fn(async () => { throw new Error('broken killer') }))
    tm.spawnTerminal('w3', 'C:\\Windows\\System32\\cmd.exe', 'C:\\', () => {})
    tm.killTerminal('w3')
    await vi.waitFor(() => expect(H.order).toEqual(['pty.kill:9000', 'process.kill:9000']))
  })

  it('Windows with TERMPOLIS_CONSOLE_LIST_INPROC=1: no console read and no pin, node-pty lists it itself', async () => {
    setPlatform('win32')
    process.env.TERMPOLIS_CONSOLE_LIST_INPROC = '1'
    tk.setTerminalTreeKiller(vi.fn(async () => new Set<number>()))
    tm.spawnTerminal('w4', 'C:\\Windows\\System32\\cmd.exe', 'C:\\', () => {})
    const own = H.agents[0]._getConsoleProcessList
    tm.killTerminal('w4')
    await vi.waitFor(() => expect(H.order).toContain('pty.kill:9000'))
    expect(H.consoleList).not.toHaveBeenCalled()
    expect(H.agents[0]._getConsoleProcessList).toBe(own)
  })

  it('Windows: a pty that is not node-pty\'s WindowsTerminal is still ended', async () => {
    setPlatform('win32')
    tk.setTerminalTreeKiller(vi.fn(async () => new Set<number>()))
    tm.spawnTerminal('w5', 'C:\\Windows\\System32\\cmd.exe', 'C:\\', () => {})
    delete H.ptys[0]._agent
    tm.killTerminal('w5')
    await vi.waitFor(() => expect(H.order).toEqual(['pty.kill:9000', 'process.kill:9000']))
  })

  it('POSIX: the group goes and the shell is ended at once', () => {
    setPlatform('linux')
    const killer = vi.fn(async (pid: number) => { H.order.push(`tree:${pid}`) })
    tk.setTerminalTreeKiller(killer)
    tm.spawnTerminal('p1', '/bin/bash', '/tmp', () => {})
    tm.killTerminal('p1')
    expect(H.order).toEqual(['tree:9000', 'pty.kill:9000', 'process.kill:9000'])
  })

  it('quit (killAll) never takes the tree step', () => {
    setPlatform('linux')
    const killer = vi.fn(async () => new Set<number>())
    tk.setTerminalTreeKiller(killer)
    tm.spawnTerminal('q1', '/bin/bash', '/tmp', () => {})
    tm.killAll()
    expect(killer).not.toHaveBeenCalled()
    expect(H.order).toEqual(['pty.kill:9000', 'process.kill:9000'])
  })

  it('a late exit of a closed shell leaves a new terminal under the same id alone', () => {
    setPlatform('linux')
    tm.spawnTerminal('same', '/bin/bash', '/tmp', () => {})
    const firstExit = H.ptys[0].onExit.mock.calls[0][0]
    tm.killTerminal('same')
    tm.spawnTerminal('same', '/bin/bash', '/tmp', () => {})
    firstExit({ exitCode: 0 })
    expect(tm.getTerminalPid('same')).toBe(9001)
    tm.killAll()
  })
})
