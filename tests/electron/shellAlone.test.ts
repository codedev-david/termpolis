import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { join } from 'path'

// shellAlone.ts: whether nothing runs in a terminal but its shell, from the OS. Windows reads the
// console's process list through node-pty's helper (forked here as a fake); Unix asks ps and pgrep
// (procClient, faked) for the terminal's foreground process group.

const h = vi.hoisted(() => ({ fork: vi.fn(), exec: vi.fn() }))
vi.mock('child_process', () => ({ fork: h.fork, default: { fork: h.fork } }))
vi.mock('../../src/main/procClient', () => ({ execCaptureOffThread: h.exec }))

import { shellAlone, ownConsoleProcesses, CONSOLE_LIST_TIMEOUT_MS } from '../../src/main/shellAlone'

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const SHELL = 100
const HELPER = 900

/** node-pty's helper as fork returns it: it sends its list, or fails, as a test says. */
function helper(pid = HELPER) {
  const child = Object.assign(new EventEmitter(), { pid, kill: vi.fn() })
  h.fork.mockReturnValueOnce(child)
  return child
}

beforeEach(() => {
  h.fork.mockReset()
  h.exec.mockReset()
})

describe('ownConsoleProcesses', () => {
  it.each([
    [POWERSHELL, 1],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 1],
    ['C:\\Windows\\System32\\cmd.exe', 1],
    ['powershell.exe', 1],
    [GIT_BASH, 2],
    ['C:/Program Files/Git/bin/bash.exe', 2],
    ['C:\\Program Files\\Git\\usr\\bin\\bash.exe', 1],
    ['C:\\msys64\\usr\\bin\\zsh.exe', 1],
    // WSL's: the programs it runs are Linux processes, on no console.
    ['C:\\Windows\\System32\\bash.exe', null],
    ['C:\\Windows\\System32\\wsl.exe', null],
    // A bare bash is whichever PATH finds first, WSL's among them.
    ['bash', null],
    ['C:\\tools\\nu.exe', null],
    ['claude', null],
  ])('%s keeps %s', (exe, own) => {
    expect(ownConsoleProcesses(exe)).toBe(own)
  })
})

describe('shellAlone on Windows', () => {
  it('reads the console through node-pty\'s helper, forked quietly with the shell\'s pid', async () => {
    const child = helper()
    const alone = shellAlone(SHELL, POWERSHELL, 'win32')
    child.emit('message', { consoleProcessList: [HELPER, SHELL] })
    expect(await alone).toBe(true)
    const [script, args, opts] = h.fork.mock.calls[0]
    expect(script).toMatch(new RegExp(`${join('node-pty', 'lib', 'conpty_console_list_agent').replace(/\\/g, '\\\\')}$`))
    expect(args).toEqual([String(SHELL)])
    expect(opts).toEqual({ silent: true })
  })

  it.each([
    ['PowerShell with an agent running', POWERSHELL, [HELPER, 300, SHELL], false],
    ['Git Bash at its prompt', GIT_BASH, [HELPER, 101, SHELL], true],
    ['Git Bash running a program', GIT_BASH, [HELPER, 303, 302, 101, SHELL], false],
  ])('%s', async (_case, exe, list, alone) => {
    const child = helper()
    const answer = shellAlone(SHELL, exe, 'win32')
    child.emit('message', { consoleProcessList: list })
    expect(await answer).toBe(alone)
  })

  it("can't tell for WSL, and starts no helper", async () => {
    expect(await shellAlone(SHELL, 'C:\\Windows\\System32\\wsl.exe', 'win32')).toBeNull()
    expect(h.fork).not.toHaveBeenCalled()
  })

  it.each([
    ['no list', { other: 1 }],
    ['a list of other things', { consoleProcessList: ['100'] }],
    ['nothing at all', null],
    ['a list without the shell', { consoleProcessList: [HELPER, 300] }],
  ])("can't tell from a helper that sent %s", async (_case, message) => {
    const child = helper()
    const answer = shellAlone(SHELL, POWERSHELL, 'win32')
    child.emit('message', message)
    expect(await answer).toBeNull()
  })

  describe('with a helper that fails', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it("can't tell once it exits without its list", async () => {
      const child = helper()
      const answer = shellAlone(SHELL, POWERSHELL, 'win32')
      child.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(100)
      expect(await answer).toBeNull()
    })

    it('takes the list it sends just after it exits', async () => {
      const child = helper()
      const answer = shellAlone(SHELL, POWERSHELL, 'win32')
      child.emit('exit', 0)
      child.emit('message', { consoleProcessList: [HELPER, SHELL] })
      await vi.advanceTimersByTimeAsync(100)
      expect(await answer).toBe(true)
    })

    it("can't tell from one that couldn't start", async () => {
      const child = helper()
      const answer = shellAlone(SHELL, POWERSHELL, 'win32')
      child.emit('error', new Error('spawn EPERM'))
      expect(await answer).toBeNull()
    })

    it("can't tell from one that never answers, and stops it", async () => {
      const child = helper()
      const answer = shellAlone(SHELL, POWERSHELL, 'win32')
      await vi.advanceTimersByTimeAsync(CONSOLE_LIST_TIMEOUT_MS)
      expect(await answer).toBeNull()
      expect(child.kill).toHaveBeenCalled()
    })

    it("can't tell from one that never answers and is gone when stopped", async () => {
      const child = helper()
      child.kill.mockImplementation(() => { throw new Error('ESRCH') })
      const answer = shellAlone(SHELL, POWERSHELL, 'win32')
      await vi.advanceTimersByTimeAsync(CONSOLE_LIST_TIMEOUT_MS)
      expect(await answer).toBeNull()
    })
  })

  it("can't tell when the helper can't be forked", async () => {
    h.fork.mockImplementationOnce(() => { throw new Error('EAGAIN') })
    expect(await shellAlone(SHELL, POWERSHELL, 'win32')).toBeNull()
  })

  it('reads the platform it runs on by default', async () => {
    // Neither platform knows an agent's binary for a shell, so neither asks anything.
    expect(await shellAlone(SHELL, 'claude')).toBeNull()
    expect(h.fork).not.toHaveBeenCalled()
    expect(h.exec).not.toHaveBeenCalled()
  })
})

describe('shellAlone on Unix', () => {
  /** ps's answer for the shell, then pgrep's for the shell's process group. */
  function answers(ps: string, pgrep = '') {
    h.exec.mockImplementation(async (bin: string) => ({ stdout: bin === 'ps' ? ps : pgrep, stderr: '' }))
  }

  it("is the shell alone when the terminal's foreground group is the shell's, and holds only it", async () => {
    answers(`  ${SHELL} /bin/bash\n`, `${SHELL}\n`)
    expect(await shellAlone(SHELL, '/bin/bash', 'linux')).toBe(true)
    expect(h.exec).toHaveBeenCalledWith('ps', ['-o', 'tpgid=', '-o', 'comm=', '-p', String(SHELL)], { timeout: 3000 })
    expect(h.exec).toHaveBeenCalledWith('pgrep', ['-g', String(SHELL)], { timeout: 3000 })
  })

  it("reads macOS's name for a login shell", async () => {
    answers(`${SHELL} -zsh\n`, `${SHELL}\n`)
    expect(await shellAlone(SHELL, '/bin/zsh', 'darwin')).toBe(true)
  })

  it('is not, with a program in the foreground, and asks nothing more', async () => {
    answers(`  250 zsh\n`)
    expect(await shellAlone(SHELL, '/bin/zsh', 'darwin')).toBe(false)
    expect(h.exec).toHaveBeenCalledTimes(1)
  })

  it('is not, with a program in the shell\'s own group (job control off)', async () => {
    answers(`  ${SHELL} bash\n`, `${SHELL}\n250\n`)
    expect(await shellAlone(SHELL, '/usr/bin/bash', 'linux')).toBe(false)
  })

  it.each([
    ['the terminal\'s process is the agent now (exec)', `  ${SHELL} claude\n`, `${SHELL}\n`],
    ['ps found no such process', '', ''],
    ['the terminal has no foreground group', `  -1 bash\n`, ''],
    ['the shell is in no group of its own', `  ${SHELL} bash\n`, '250\n'],
  ])("can't tell where %s", async (_case, ps, pgrep) => {
    answers(ps, pgrep)
    expect(await shellAlone(SHELL, '/bin/bash', 'linux')).toBeNull()
  })

  it("can't tell where asking failed", async () => {
    h.exec.mockRejectedValue(new Error('no proc host'))
    expect(await shellAlone(SHELL, '/bin/bash', 'linux')).toBeNull()
  })

  it.each(['/usr/bin/pwsh', '/opt/homebrew/bin/nu'])("can't tell for %s, which keeps what it runs in its own group, and asks nothing", async (exe) => {
    expect(await shellAlone(SHELL, exe, 'darwin')).toBeNull()
    expect(h.exec).not.toHaveBeenCalled()
  })
})
