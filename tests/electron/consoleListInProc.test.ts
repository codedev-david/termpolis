// 1.54.5 (EDR2-3): TERMPOLIS_CONSOLE_LIST_INPROC=1 is the kill switch for the proc-host console helper. With it,
// shellAlone reads a Windows console the 1.54.4 way: node-pty's conpty_console_list_agent forked from main. Without
// it (the default), nothing is forked and the proc host runs the shipped helper (shellAlone.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

const h = vi.hoisted(() => ({ fork: vi.fn(), exec: vi.fn(), ensure: vi.fn() }))
vi.mock('child_process', () => ({ fork: h.fork, default: { fork: h.fork } }))
vi.mock('../../src/main/procClient', () => ({ execCaptureOffThread: h.exec }))
vi.mock('../../src/main/consoleListHelper', () => ({ ensureConsoleListHelper: h.ensure }))

import { shellAlone, consoleListCounters, _resetShellAloneForTests } from '../../src/main/shellAlone'
import { consoleListInProc, forkConsoleList } from '../../src/main/consoleListInProc'

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const SHELL = 100
const HELPER = 900

/** node-pty's helper as fork returns it: it sends its list, or fails, as a test says. */
function helper(pid = HELPER) {
  const child = Object.assign(new EventEmitter(), { pid, kill: vi.fn() })
  h.fork.mockReturnValueOnce(child)
  return child
}

beforeEach(() => {
  _resetShellAloneForTests()
  h.fork.mockReset()
  h.exec.mockReset()
  h.ensure.mockReset()
  h.ensure.mockResolvedValue('C:\\data\\termpolis-console-list.cjs')
  h.exec.mockResolvedValue({ stdout: JSON.stringify({ self: HELPER, list: [HELPER, SHELL] }), stderr: '' })
})
afterEach(() => {
  delete process.env.TERMPOLIS_CONSOLE_LIST_INPROC
  vi.useRealTimers()
})

describe('consoleListInProc reads the switch', () => {
  it.each([
    ['1', true],
    [' 1 ', true],
    ['', false],
    ['0', false],
    ['true', false],
    [undefined, false],
  ])('%j -> %s', (value, on) => {
    expect(consoleListInProc(value === undefined ? {} : { TERMPOLIS_CONSOLE_LIST_INPROC: value })).toBe(on)
  })

  it('reads process.env by default', () => {
    process.env.TERMPOLIS_CONSOLE_LIST_INPROC = '1'
    expect(consoleListInProc()).toBe(true)
  })
})

describe('shellAlone with TERMPOLIS_CONSOLE_LIST_INPROC=1 forks node-pty\'s helper from main (the 1.54.4 path)', () => {
  it('forks conpty_console_list_agent with the shell pid and never asks the proc host', async () => {
    process.env.TERMPOLIS_CONSOLE_LIST_INPROC = '1'
    const child = helper()
    const answer = shellAlone(SHELL, POWERSHELL, 'win32')
    await vi.waitFor(() => expect(h.fork).toHaveBeenCalledTimes(1))
    child.emit('message', { consoleProcessList: [HELPER, SHELL] })
    expect(await answer).toBe(true)
    expect(String(h.fork.mock.calls[0][0])).toMatch(/node-pty[\\/]lib[\\/]conpty_console_list_agent$/)
    expect(h.fork.mock.calls[0][1]).toEqual([String(SHELL)])
    expect(h.exec).not.toHaveBeenCalled()
    expect(h.ensure).not.toHaveBeenCalled()
    expect(consoleListCounters().runs).toBe(0) // the proc-host helper's counters stay the proc host's
  })

  it('an agent on the console is "not alone", as before', async () => {
    process.env.TERMPOLIS_CONSOLE_LIST_INPROC = '1'
    const child = helper()
    const answer = shellAlone(SHELL, POWERSHELL, 'win32')
    await vi.waitFor(() => expect(h.fork).toHaveBeenCalledTimes(1))
    child.emit('message', { consoleProcessList: [HELPER, 300, SHELL] })
    expect(await answer).toBe(false)
  })

  it('control: unset, nothing is forked and the proc host answers', async () => {
    expect(await shellAlone(SHELL, POWERSHELL, 'win32')).toBe(true)
    expect(h.fork).not.toHaveBeenCalled()
    expect(h.exec).toHaveBeenCalledTimes(1)
  })
})

describe('forkConsoleList (the 1.54.4 read, kept for the switch)', () => {
  it('cannot tell when the fork throws', async () => {
    h.fork.mockImplementationOnce(() => { throw new Error('EPERM') })
    expect(await forkConsoleList(SHELL, 5000)).toBeNull()
  })

  it('cannot tell from a message that is not a list', async () => {
    const child = helper()
    const answer = forkConsoleList(SHELL, 5000)
    child.emit('message', { consoleProcessList: ['x'] })
    expect(await answer).toBeNull()
  })

  it('cannot tell when the helper errors', async () => {
    const child = helper()
    const answer = forkConsoleList(SHELL, 5000)
    child.emit('error', new Error('spawn failed'))
    expect(await answer).toBeNull()
  })

  it('takes a list sent just before the exit, and cannot tell from an exit with no list', async () => {
    vi.useFakeTimers()
    const late = helper()
    const a = forkConsoleList(SHELL, 5000)
    late.emit('exit', 0)
    late.emit('message', { consoleProcessList: [HELPER, SHELL] })
    await vi.advanceTimersByTimeAsync(100)
    expect(await a).toEqual([SHELL])
    const silent = helper()
    const b = forkConsoleList(SHELL, 5000)
    silent.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(100)
    expect(await b).toBeNull()
  })

  it('kills a helper that takes longer than the timeout, and cannot tell', async () => {
    vi.useFakeTimers()
    const child = helper()
    const answer = forkConsoleList(SHELL, 5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await answer).toBeNull()
    expect(child.kill).toHaveBeenCalledTimes(1)
    const gone = helper()
    gone.kill.mockImplementation(() => { throw new Error('already gone') })
    const again = forkConsoleList(SHELL, 5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await again).toBeNull()
  })
})
