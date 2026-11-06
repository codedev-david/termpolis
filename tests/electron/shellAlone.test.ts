// IMPORT ORDER: the counters first (they patch fs and child_process before the module under test loads).
import { arm, disarm, describeCounts, uninstall } from '../helpers/mainThreadCounters'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// shellAlone.ts: whether nothing runs in a terminal but its shell, from the OS. Windows reads the console's process
// list with a small helper script that the proc host runs (procClient, faked here: nothing is forked from main); Unix
// asks ps and pgrep (procClient, faked) for the terminal's foreground process group.

const h = vi.hoisted(() => ({ exec: vi.fn(), ensure: vi.fn() }))
const HELPER_PATH = 'C:\data\termpolis-console-list.cjs'
vi.mock('../../src/main/procClient', () => ({ execCaptureOffThread: h.exec }))
vi.mock('../../src/main/consoleListHelper', () => ({ ensureConsoleListHelper: h.ensure }))

import { shellAlone, ownConsoleProcesses, parseConsoleList, primeShellAlone, readConsoleProcessList, consoleListCounters, CONSOLE_LIST_TIMEOUT_MS, CONSOLE_LIST_SHARE_MS, _resetShellAloneForTests } from '../../src/main/shellAlone'

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const SHELL = 100
const HELPER = 900

beforeEach(() => {
  _resetShellAloneForTests() // answers are shared for 1.5 s: one test must not read another's
  h.exec.mockReset()
  h.ensure.mockReset()
  h.ensure.mockResolvedValue(HELPER_PATH)
})
afterAll(() => { uninstall() })

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

/** What the console helper prints for a console holding `list` (its own pid, HELPER, among them). */
const printed = (list: unknown, self: number = HELPER) => ({ stdout: JSON.stringify({ self, list }), stderr: '' })

describe('shellAlone on Windows', () => {
  it('reads the console with the helper script, run by the proc host, never forked from main', async () => {
    h.exec.mockResolvedValue(printed([HELPER, SHELL]))
    expect(await shellAlone(SHELL, POWERSHELL, 'win32')).toBe(true)
    expect(h.exec).toHaveBeenCalledTimes(1)
    const [bin, args, opts] = h.exec.mock.calls[0]
    expect(bin).toBe(process.execPath)
    expect(args[0]).toBe(HELPER_PATH)
    expect(args[1]).toBe(String(SHELL))
    // node-pty's own lib folder, from where the package keeps it on disk.
    expect(args[2]).toMatch(new RegExp(`${join('node-pty', 'lib').replace(/\\/g, '\\\\')}$`))
    expect(args).toHaveLength(3)
    // Termpolis run as Node, with the shell's console to read; and the 5 s a console may take.
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(opts.timeout).toBe(CONSOLE_LIST_TIMEOUT_MS)
  })

  it('does not import child_process any more: the Windows path cannot fork on the main thread', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'shellAlone.ts'), 'utf8')
    expect(source).not.toMatch(/child_process/)
    expect(source).not.toMatch(/\bfork\(/)
  })

  it.each([
    ['PowerShell with an agent running', POWERSHELL, [HELPER, 300, SHELL], false],
    ['Git Bash at its prompt', GIT_BASH, [HELPER, 101, SHELL], true],
    ['Git Bash running a program', GIT_BASH, [HELPER, 303, 302, 101, SHELL], false],
  ])('%s', async (_case, exe, list, alone) => {
    h.exec.mockResolvedValue(printed(list))
    expect(await shellAlone(SHELL, exe, 'win32')).toBe(alone)
  })

  it("can't tell for WSL, and asks nothing", async () => {
    expect(await shellAlone(SHELL, 'C:\\Windows\\System32\\wsl.exe', 'win32')).toBeNull()
    expect(h.exec).not.toHaveBeenCalled()
    expect(h.ensure).not.toHaveBeenCalled()
  })

  it.each([
    ['no list', JSON.stringify({ other: 1 })],
    ['a list of other things', JSON.stringify({ self: HELPER, list: ['100'] })],
    ['nothing at all', 'null'],
    ['text that is not JSON', 'Segmentation fault'],
    ['nothing printed', ''],
    ['a list without the shell', JSON.stringify({ self: HELPER, list: [HELPER, 300] })],
  ])("can't tell from a helper that printed %s", async (_case, stdout) => {
    h.exec.mockResolvedValue({ stdout, stderr: '' })
    expect(await shellAlone(SHELL, POWERSHELL, 'win32')).toBeNull()
  })

  it("can't tell when the helper failed or was stopped for taking too long (the host reports an error)", async () => {
    h.exec.mockResolvedValue({ stdout: '', stderr: 'boom', error: { message: 'Command failed', code: 1 } })
    expect(await shellAlone(SHELL, POWERSHELL, 'win32')).toBeNull()
    h.exec.mockResolvedValue({ stdout: '', stderr: '', error: { message: 'timed out', signal: 'SIGTERM', killed: true } })
    expect(await shellAlone(SHELL + 1, POWERSHELL, 'win32')).toBeNull()
  })

  it("can't tell when the proc host is gone (the call is rejected)", async () => {
    h.exec.mockRejectedValue(new Error('proc host exited (code 1) with the call in flight'))
    expect(await shellAlone(SHELL, POWERSHELL, 'win32')).toBeNull()
  })

  it("can't tell when the helper script cannot be written, and runs nothing", async () => {
    h.ensure.mockResolvedValue(null)
    expect(await shellAlone(SHELL, POWERSHELL, 'win32')).toBeNull()
    expect(h.exec).not.toHaveBeenCalled()
  })

  it('waits for the answer and never on a timer: no timer is armed while it waits', async () => {
    vi.useFakeTimers()
    try {
      let answer: (v: { stdout: string; stderr: string }) => void = () => {}
      h.exec.mockReturnValue(new Promise((r) => { answer = r }))
      const asked = shellAlone(SHELL, POWERSHELL, 'win32')
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000) // however long it takes, nothing resolves it but the answer
      let settled = false
      void asked.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      answer(printed([HELPER, SHELL]))
      expect(await asked).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the platform it runs on by default', async () => {
    // Neither platform knows an agent's binary for a shell, so neither asks anything.
    expect(await shellAlone(SHELL, 'claude')).toBeNull()
    expect(h.exec).not.toHaveBeenCalled()
  })
})

describe('shellAlone shares one run of the helper between asks made together (key shellAlone:<pid>, 1.5 s)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('a submit and an auto-primer asking at once cost one host exec', async () => {
    h.exec.mockResolvedValue(printed([HELPER, SHELL]))
    const [a, b, c] = await Promise.all([shellAlone(SHELL, POWERSHELL, 'win32'), shellAlone(SHELL, POWERSHELL, 'win32'), shellAlone(SHELL, POWERSHELL, 'win32')])
    expect([a, b, c]).toEqual([true, true, true])
    expect(h.exec).toHaveBeenCalledTimes(1)
  })

  it('an answer is kept for 1.5 s, and the next ask after that is a fresh look', async () => {
    h.exec.mockResolvedValue(printed([HELPER, SHELL]))
    await shellAlone(SHELL, POWERSHELL, 'win32')
    await vi.advanceTimersByTimeAsync(CONSOLE_LIST_SHARE_MS - 1)
    await shellAlone(SHELL, POWERSHELL, 'win32')
    expect(h.exec).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await shellAlone(SHELL, POWERSHELL, 'win32')
    expect(h.exec).toHaveBeenCalledTimes(2)
  })

  it("keeps the auto-primer's own asks, 2 s apart, as separate looks", async () => {
    h.exec.mockResolvedValue(printed([HELPER, SHELL]))
    for (let i = 0; i < 3; i++) {
      await shellAlone(SHELL, POWERSHELL, 'win32')
      await vi.advanceTimersByTimeAsync(2000)
    }
    expect(h.exec).toHaveBeenCalledTimes(3)
  })

  it('never shares what it could not tell, nor an answer between two terminals', async () => {
    h.exec.mockResolvedValueOnce({ stdout: '', stderr: '', error: { message: 'failed' } })
    expect(await shellAlone(SHELL, POWERSHELL, 'win32')).toBeNull()
    h.exec.mockResolvedValueOnce(printed([HELPER, SHELL]))
    expect(await shellAlone(SHELL, POWERSHELL, 'win32')).toBe(true) // the failure was not replayed
    h.exec.mockResolvedValueOnce(printed([HELPER, SHELL + 5, 300]))
    expect(await shellAlone(SHELL + 5, POWERSHELL, 'win32')).toBe(false) // another terminal: its own look
    expect(h.exec).toHaveBeenCalledTimes(3)
  })
})

// EDR-2: the helper runs from the below-normal proc host. Whether that ever makes it run out of time is counted here,
// so a run can say how many asks it cost and how many came back "cannot tell" because the time ran out.
describe('EDR-2: the console helper\'s runs, failures and timeouts are counted', () => {
  it('counts a run that answered, one that failed, one stopped for taking too long, and one the host never answered', async () => {
    expect(consoleListCounters()).toEqual({ runs: 0, failures: 0, timeouts: 0 })
    h.exec.mockResolvedValueOnce(printed([HELPER, SHELL]))
    await shellAlone(SHELL, POWERSHELL, 'win32')
    expect(consoleListCounters()).toEqual({ runs: 1, failures: 0, timeouts: 0 })
    h.exec.mockResolvedValueOnce({ stdout: '', stderr: 'boom', error: { message: 'Command failed', code: 1 } })
    await shellAlone(SHELL + 1, POWERSHELL, 'win32')
    expect(consoleListCounters()).toEqual({ runs: 2, failures: 1, timeouts: 0 })
    h.exec.mockResolvedValueOnce({ stdout: '', stderr: '', error: { message: 'timed out', signal: 'SIGTERM', killed: true } })
    await shellAlone(SHELL + 2, POWERSHELL, 'win32')
    expect(consoleListCounters()).toEqual({ runs: 3, failures: 2, timeouts: 1 })
    h.exec.mockRejectedValueOnce(new Error('proc host call timed out after 6000ms'))
    await shellAlone(SHELL + 3, POWERSHELL, 'win32')
    expect(consoleListCounters()).toEqual({ runs: 4, failures: 3, timeouts: 2 })
  })

  it('control: no helper (nothing run) counts nothing, and an answer shared between two asks is one run', async () => {
    h.ensure.mockResolvedValueOnce(null)
    await shellAlone(SHELL, POWERSHELL, 'win32')
    h.ensure.mockRejectedValueOnce(new Error('no resources folder'))
    expect(await shellAlone(SHELL + 8, POWERSHELL, 'win32')).toBeNull()
    expect(consoleListCounters()).toEqual({ runs: 0, failures: 0, timeouts: 0 })
    h.exec.mockResolvedValue(printed([HELPER, SHELL + 9]))
    await Promise.all([shellAlone(SHELL + 9, POWERSHELL, 'win32'), shellAlone(SHELL + 9, POWERSHELL, 'win32')])
    expect(consoleListCounters().runs).toBe(1)
  })

  it('readConsoleProcessList (closing a terminal) is a fresh run each time, counted the same way', async () => {
    h.exec.mockResolvedValue(printed([HELPER, SHELL, 4242]))
    expect(await readConsoleProcessList(SHELL)).toEqual([SHELL, 4242])
    expect(await readConsoleProcessList(SHELL)).toEqual([SHELL, 4242])
    expect(h.exec).toHaveBeenCalledTimes(2)
    expect(consoleListCounters()).toEqual({ runs: 2, failures: 0, timeouts: 0 })
  })
})

describe('shellAlone costs the main thread no process creation (counted)', () => {
  it('ten asks make ten host execs and zero spawns, forks or execFiles of its own', async () => {
    h.exec.mockImplementation(async (_bin: string, args: string[]) => printed([HELPER, Number(args[1])]))
    arm()
    const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => shellAlone(1000 + i, POWERSHELL, 'win32')))
    const c = disarm()
    expect(answers.every((a) => a === true)).toBe(true)
    expect(h.exec).toHaveBeenCalledTimes(10)
    expect(describeCounts(c)).toBe('')
  })
})

describe('parseConsoleList', () => {
  it('takes the helper out of the list, and reads nothing else as a list', () => {
    expect(parseConsoleList(JSON.stringify({ self: 9, list: [9, 4, 5] }))).toEqual([4, 5])
    expect(parseConsoleList(JSON.stringify({ list: [4, 5] }))).toEqual([4, 5])
    expect(parseConsoleList(JSON.stringify({ self: 9, list: [4.5] }))).toBeNull()
    expect(parseConsoleList('[1,2]')).toBeNull()
    expect(parseConsoleList('')).toBeNull()
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

describe('primeShellAlone', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
  afterEach(() => { Object.defineProperty(process, 'platform', realPlatform) })

  it('on Windows it writes the helper at start-up, once, so the first submit makes no file call', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    await primeShellAlone()
    expect(h.ensure).toHaveBeenCalledTimes(1)
  })

  it('elsewhere it asks for nothing: there is no console to read', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    await primeShellAlone()
    expect(h.ensure).not.toHaveBeenCalled()
  })
})
