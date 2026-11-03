// Closing a terminal on Windows: node-pty's kill() lists the programs on the shell's console (to end them with it) by
// FORKING its helper script from the process it runs in, which is the main process: a fork on the thread that echoes
// every keystroke, on every close (0.1-0.3 s on a busy laptop; a swarm closes many terminals). spawnTerminal replaces
// that one method, per terminal, with the same question asked through the proc host. Counters only.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

const H = vi.hoisted(() => ({
  forks: 0,
  hostAsks: [] as Array<{ bin: string; args: string[]; env: Record<string, string | undefined> | undefined }>,
  hostReply: { stdout: '', stderr: '' } as { stdout: string; stderr: string; error?: { message: string } },
  agents: [] as any[],
  noAgent: false,
  noInner: false,
}))

vi.mock('electron', () => ({ app: { getPath: () => require('os').tmpdir(), isPackaged: false } }))
vi.mock('node-pty', () => {
  const spawn = vi.fn((file: string, args: string[], opts: any) => {
    const pid = 9000 + H.agents.length
    // What node-pty's WindowsTerminal looks like from outside: an agent that forks a helper to list the console.
    const agent = {
      innerPid: H.noInner ? undefined : pid,
      _getConsoleProcessList: vi.fn(() => { H.forks++; return Promise.resolve([pid]) }),
    }
    H.agents.push(agent)
    return { pid, ...(H.noAgent ? {} : { _agent: agent }), onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(), file, args, opts }
  })
  return { spawn, default: { spawn } }
})
vi.mock('../../src/main/procClient', () => ({
  execShellCaptureOffThread: vi.fn(async () => ({ stdout: '', stderr: '' })),
  execCaptureOffThread: vi.fn(async (bin: string, args: string[], opts: { env?: Record<string, string | undefined> }) => {
    H.hostAsks.push({ bin, args, env: opts?.env })
    return H.hostReply
  }),
}))
vi.mock('../../src/main/consoleListHelper', () => ({ ensureConsoleListHelper: vi.fn(async () => 'C:\\data\\termpolis-console-list.cjs') }))

type TM = typeof import('../../src/main/terminalManager')
let tm: TM
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
const setPlatform = (p: string): void => { Object.defineProperty(process, 'platform', { value: p, configurable: true }) }

beforeAll(async () => {
  tm = await import('../../src/main/terminalManager')
  await tm.primeBundledToolsCheck()
})
beforeEach(() => {
  H.forks = 0
  H.hostAsks.length = 0
  H.agents.length = 0
  H.noAgent = false
  H.noInner = false
  H.hostReply = { stdout: JSON.stringify({ self: 55, list: [55, 9000, 9101, 9102] }), stderr: '' }
})
afterEach(() => { Object.defineProperty(process, 'platform', realPlatform) })

describe('closing a terminal on Windows asks the proc host, never forks', () => {
  it('node-pty\'s console listing is answered by the proc host, with the helper left out and the shell in', async () => {
    setPlatform('win32')
    tm.spawnTerminal('k1', 'C:\\Windows\\System32\\cmd.exe', 'C:\\', () => {})
    const agent = H.agents[0]
    const list = await agent._getConsoleProcessList()
    expect(list).toEqual([9000, 9101, 9102]) // the shell and what runs in it: all of them are ended with the terminal
    expect(H.forks).toBe(0) // node-pty's own forking helper was never called
    expect(H.hostAsks).toHaveLength(1)
    expect(H.hostAsks[0].bin).toBe(process.execPath)
    expect(H.hostAsks[0].args[1]).toBe('9000') // the shell's pid
    expect(H.hostAsks[0].env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('reads the console at the moment of closing: two closes of one terminal are two looks, not a shared old answer', async () => {
    setPlatform('win32')
    tm.spawnTerminal('k2', 'C:\\Windows\\System32\\cmd.exe', 'C:\\', () => {})
    await H.agents[0]._getConsoleProcessList()
    H.hostReply = { stdout: JSON.stringify({ self: 56, list: [56, 9000] }), stderr: '' }
    expect(await H.agents[0]._getConsoleProcessList()).toEqual([9000])
    expect(H.hostAsks).toHaveLength(2)
  })

  it('when the host cannot say, it ends the shell alone, as node-pty does when its helper times out', async () => {
    setPlatform('win32')
    tm.spawnTerminal('k3', 'C:\\Windows\\System32\\cmd.exe', 'C:\\', () => {})
    H.hostReply = { stdout: '', stderr: 'boom', error: { message: 'Command failed' } }
    expect(await H.agents[0]._getConsoleProcessList()).toEqual([9000])
    H.hostReply = { stdout: 'not json', stderr: '' }
    expect(await H.agents[0]._getConsoleProcessList()).toEqual([9000])
  })

  it('leaves node-pty alone elsewhere (it lists nothing there) and when there is no agent to change', () => {
    setPlatform('linux')
    tm.spawnTerminal('k4', '/bin/bash', '/tmp', () => {})
    expect(H.agents[0]._getConsoleProcessList.mock).toBeDefined() // still node-pty's own
    setPlatform('win32')
    H.noAgent = true // a pty that is not node-pty's WindowsTerminal (a fake, a future version)
    expect(() => tm.spawnTerminal('k5', 'C:\\Windows\\System32\\cmd.exe', 'C:\\', () => {})).not.toThrow()
  })

  it('an agent that does not say its own shell pid (an older node-pty) is asked about the pty pid instead', async () => {
    setPlatform('win32')
    H.noInner = true
    tm.spawnTerminal('k7', 'C:\\Windows\\System32\\cmd.exe', 'C:\\', () => {})
    expect(await H.agents[0]._getConsoleProcessList()).toEqual([9000, 9101, 9102])
    expect(H.hostAsks[0].args[1]).toBe('9000') // the pty's own pid
    expect(H.forks).toBe(0)
  })

  it('closing the terminal still ends it (the pty is killed) and counts no fork', async () => {
    setPlatform('win32')
    tm.spawnTerminal('k6', 'C:\\Windows\\System32\\cmd.exe', 'C:\\', () => {})
    tm.killTerminal('k6')
    expect(H.forks).toBe(0)
  })
})
