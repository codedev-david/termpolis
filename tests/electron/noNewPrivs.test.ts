import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

// Nothing here may call relaunchWithoutNoNewPrivs or relaunchViaSystemd with their real deps: a
// real relaunch shell started from a test waits for the test runner to exit and then runs it
// again. (vi.mock does not reach Node built-ins in this suite, so a mocked child_process is no
// guard.) The real helpers are exercised only with commands that do nothing.

const {
  parseNoNewPrivs,
  hasNoNewPrivs,
  RELAUNCH_SCRIPT,
  relaunchCommand,
  relaunchWithoutNoNewPrivs,
  systemdRelaunchArgs,
  canRelaunchViaSystemd,
  relaunchViaSystemd,
  noticeNoNewPrivs,
  noticeStore,
  scheduleNoNewPrivsNotice,
  currentTarget,
  NOTICE_FILE,
  spawnDetached,
  defaultRelaunchDeps,
  runSync,
  defaultSystemdDeps,
} = await import('../../src/main/noNewPrivs')
type NoticeDeps = import('../../src/main/noNewPrivs').NoticeDeps
type RelaunchTarget = import('../../src/main/noNewPrivs').RelaunchTarget

const STATUS = (nnp: string) =>
  `Name:\ttermpolis\nUmask:\t0002\nState:\tS (sleeping)\nNoNewPrivs:\t${nnp}\nSeccomp:\t0\nSeccomp_filters:\t0\n`

const TARGET: RelaunchTarget = {
  pid: 4242,
  execPath: '/opt/Termpolis/termpolis',
  argv: ['/opt/Termpolis/termpolis', '--no-sandbox', '--disable-gpu'],
  env: { HOME: '/home/d', DISPLAY: ':0' },
}

describe('parseNoNewPrivs', () => {
  it('reads the flag from a /proc status text', () => {
    expect(parseNoNewPrivs(STATUS('1'))).toBe(true)
    expect(parseNoNewPrivs(STATUS('0'))).toBe(false)
  })

  it('says nothing when the line is missing (a kernel older than 4.10)', () => {
    expect(parseNoNewPrivs('Name:\tx\nSeccomp:\t0\n')).toBeNull()
    expect(parseNoNewPrivs('')).toBeNull()
  })
})

describe('hasNoNewPrivs', () => {
  it('is null off Linux, without reading anything', () => {
    const read = vi.fn()
    expect(hasNoNewPrivs('darwin', read)).toBeNull()
    expect(hasNoNewPrivs('win32', read)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it("reads this process's own status on Linux", () => {
    const read = vi.fn(() => STATUS('1'))
    expect(hasNoNewPrivs('linux', read)).toBe(true)
    expect(read).toHaveBeenCalledWith('/proc/self/status')
    expect(hasNoNewPrivs('linux', () => STATUS('0'))).toBe(false)
  })

  it('is null when /proc cannot be read', () => {
    expect(hasNoNewPrivs('linux', () => { throw new Error('ENOENT') })).toBeNull()
  })

  it('reads the real /proc by default', () => {
    const r = hasNoNewPrivs()
    if (process.platform === 'linux') expect(typeof r).toBe('boolean')
    else expect(r).toBeNull()
    // Where there is no /proc the default reader throws, which reads as "can't tell".
    const asLinux = hasNoNewPrivs('linux')
    if (process.platform === 'linux') expect(asLinux).toBe(r)
    else expect(asLinux).toBeNull()
  })
})

describe('relaunchCommand', () => {
  it('waits for this pid, then starts the same program with the same arguments', () => {
    expect(relaunchCommand(TARGET)).toEqual([
      '/bin/sh', '-c', RELAUNCH_SCRIPT, 'termpolis-relaunch', '4242',
      '/opt/Termpolis/termpolis', '--no-sandbox', '--disable-gpu',
    ])
  })

  it('restarts an AppImage from its file, not from the mount that disappears with it', () => {
    const cmd = relaunchCommand({ ...TARGET, execPath: '/tmp/.mount_TermpoXYZ/termpolis', env: { APPIMAGE: '/home/d/Termpolis.AppImage' } })
    expect(cmd[5]).toBe('/home/d/Termpolis.AppImage')
  })

  it('describes this process by default', () => {
    expect(currentTarget()).toEqual({ pid: process.pid, execPath: process.execPath, argv: process.argv, env: process.env })
  })
})

describe('relaunchWithoutNoNewPrivs', () => {
  it('starts the waiting shell detached from this process, and lets it outlive it', () => {
    const child = { on: vi.fn(), unref: vi.fn() }
    const spawn = vi.fn(() => child)
    expect(relaunchWithoutNoNewPrivs({ target: TARGET, spawn })).toBe(true)
    const [cmd, ...rest] = relaunchCommand(TARGET)
    expect(spawn).toHaveBeenCalledWith(cmd, rest, { detached: true, stdio: 'ignore' })
    expect(child.unref).toHaveBeenCalled()
    // A spawn failure arrives as an 'error' event; unheard, it would crash the main process.
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(() => (child.on.mock.calls[0] as unknown as [string, (e: Error) => void])[1](new Error('ENOENT'))).not.toThrow()
  })

  it('reports a spawn that throws', () => {
    expect(relaunchWithoutNoNewPrivs({ target: TARGET, spawn: () => { throw new Error('EAGAIN') } })).toBe(false)
  })

  it("restarts this process through child_process's spawn by default, never Electron's relauncher", () => {
    expect(defaultRelaunchDeps()).toEqual({ target: currentTarget(), spawn: spawnDetached })
  })

  it('spawnDetached starts a process that can outlive this one', async () => {
    const child = spawnDetached(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' })
    const code = await new Promise<number | null>((resolve) => (child as unknown as import('child_process').ChildProcess).on('exit', resolve))
    child.unref()
    expect(code).toBe(0)
  })
})

describe.runIf(process.platform !== 'win32')('RELAUNCH_SCRIPT, run by a real shell', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nnp-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('waits for the old process to exit before starting the new one, with its arguments intact', () => {
    const old = spawn('sleep', ['1'], { stdio: 'ignore' })
    const out = join(dir, 'out')
    const started = Date.now()
    const r = spawnSync('/bin/sh', [
      '-c', RELAUNCH_SCRIPT, 'termpolis-relaunch', String(old.pid),
      '/bin/sh', '-c', 'printf "%s|" "$@" > "$0"', out, 'a b', '--flag',
    ], { timeout: 20_000 })
    expect(r.status).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(700)
    expect(readFileSync(out, 'utf8')).toBe('a b|--flag|')
  })

  it('starts at once when the old process is already gone', () => {
    const out = join(dir, 'out')
    const r = spawnSync('/bin/sh', ['-c', RELAUNCH_SCRIPT, 'termpolis-relaunch', '999999999', '/bin/sh', '-c', ': > "$0"', out], { timeout: 10_000 })
    expect(r.status).toBe(0)
    expect(existsSync(out)).toBe(true)
  })
})

describe('systemdRelaunchArgs', () => {
  it("asks the user's systemd to start the relaunch shell, and copies the environment by name", () => {
    const args = systemdRelaunchArgs({
      ...TARGET,
      env: {
        DISPLAY: ':0',
        WAYLAND_DISPLAY: 'wayland-0',
        INVOCATION_ID: 'abc', // systemd's own, per service
        JOURNAL_STREAM: '8:1',
        ELECTRON_RUN_AS_NODE: '1',
        'BASH_FUNC_x%%': '() { :; }', // not a name systemd accepts
        UNSET: undefined,
      },
    })
    expect(args.slice(0, 4)).toEqual(['--user', '--collect', '--quiet', '--property=KillMode=process'])
    expect(args).toContain('--setenv=DISPLAY')
    expect(args).toContain('--setenv=WAYLAND_DISPLAY')
    for (const k of ['INVOCATION_ID', 'JOURNAL_STREAM', 'ELECTRON_RUN_AS_NODE', 'BASH_FUNC_x%%', 'UNSET']) {
      expect(args).not.toContain(`--setenv=${k}`)
    }
    // Values never travel through argv.
    expect(args.join(' ')).not.toContain('wayland-0')
    const sep = args.indexOf('--')
    expect(args.slice(sep + 1)).toEqual(relaunchCommand({ ...TARGET, env: {} }))
  })
})

describe('systemd-run', () => {
  const run = vi.fn()
  beforeEach(() => run.mockReset())

  it('is usable when `systemd-run --version` succeeds', () => {
    run.mockReturnValue({ status: 0 })
    expect(canRelaunchViaSystemd({ target: TARGET, run })).toBe(true)
    expect(run).toHaveBeenCalledWith('systemd-run', ['--version'], TARGET.env)
  })

  it('is not usable when it is missing, fails, or throws', () => {
    run.mockReturnValueOnce({ status: null, error: new Error('ENOENT') })
    expect(canRelaunchViaSystemd({ target: TARGET, run })).toBe(false)
    run.mockReturnValueOnce({ status: 1 })
    expect(canRelaunchViaSystemd({ target: TARGET, run })).toBe(false)
    run.mockImplementationOnce(() => { throw new Error('boom') })
    expect(canRelaunchViaSystemd({ target: TARGET, run })).toBe(false)
  })

  it('restarts through systemd-run and reports whether systemd took it', () => {
    run.mockReturnValueOnce({ status: 0 })
    expect(relaunchViaSystemd({ target: TARGET, run })).toBe(true)
    expect(run).toHaveBeenCalledWith('systemd-run', systemdRelaunchArgs(TARGET), TARGET.env)
    run.mockReturnValueOnce({ status: 1 })
    expect(relaunchViaSystemd({ target: TARGET, run })).toBe(false)
    run.mockReturnValueOnce({ status: null, error: new Error('ETIMEDOUT') })
    expect(relaunchViaSystemd({ target: TARGET, run })).toBe(false)
    run.mockImplementationOnce(() => { throw new Error('boom') })
    expect(relaunchViaSystemd({ target: TARGET, run })).toBe(false)
  })

  it('runs systemd-run with a bounded spawnSync by default', () => {
    expect(defaultSystemdDeps()).toEqual({ target: currentTarget(), run: runSync })
    expect(runSync(process.execPath, ['-e', 'process.exit(3)'], process.env).status).toBe(3)
    expect(runSync('termpolis-no-such-program', [], process.env).error).toBeInstanceOf(Error)
    // Only asks for the version: safe to run for real wherever the suite runs.
    expect(typeof canRelaunchViaSystemd(defaultSystemdDeps())).toBe('boolean')
  })
})

describe('noticeNoNewPrivs', () => {
  const deps = (over: Partial<NoticeDeps> = {}): NoticeDeps => ({
    noNewPrivs: () => true,
    dismissed: () => false,
    dismiss: vi.fn(),
    canRestart: () => true,
    restart: vi.fn(() => true),
    quit: vi.fn(),
    show: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
    ...over,
  })

  it('says nothing when the flag is clear, or when it cannot tell', async () => {
    for (const v of [false, null]) {
      const d = deps({ noNewPrivs: () => v })
      expect(await noticeNoNewPrivs(d)).toBe('clear')
      expect(d.show).not.toHaveBeenCalled()
    }
  })

  it('stays quiet once the user said not to show it again', async () => {
    const d = deps({ dismissed: () => true })
    expect(await noticeNoNewPrivs(d)).toBe('dismissed')
    expect(d.show).not.toHaveBeenCalled()
  })

  it('offers the restart, and restarts then quits when it is taken', async () => {
    const d = deps()
    expect(await noticeNoNewPrivs(d)).toBe('restarting')
    const dialog = vi.mocked(d.show).mock.calls[0][0]
    expect(dialog.message).toBe("sudo won't work in this window")
    expect(dialog.detail).toContain('sudo, su and pkexec')
    expect(dialog.detail).toContain('Restart Termpolis to clear it.')
    expect(dialog.buttons).toEqual(['Restart Termpolis', 'Not now'])
    expect(dialog.cancelId).toBe(1)
    expect(dialog.checkboxLabel).toBe("Don't show this again")
    expect(d.restart).toHaveBeenCalledTimes(1)
    expect(d.quit).toHaveBeenCalledTimes(1)
  })

  it('does nothing on "Not now", but remembers "don\'t show again"', async () => {
    const d = deps({ show: vi.fn(async () => ({ response: 1, checkboxChecked: true })) })
    expect(await noticeNoNewPrivs(d)).toBe('not-now')
    expect(d.dismiss).toHaveBeenCalledTimes(1)
    expect(d.restart).not.toHaveBeenCalled()
    expect(d.quit).not.toHaveBeenCalled()
  })

  it('explains the manual fix where systemd-run is missing', async () => {
    const d = deps({ canRestart: () => false })
    expect(await noticeNoNewPrivs(d)).toBe('not-now')
    const dialog = vi.mocked(d.show).mock.calls[0][0]
    expect(dialog.buttons).toEqual(['OK'])
    expect(dialog.cancelId).toBe(0)
    expect(dialog.detail).toContain('quit Termpolis and open it again from your applications menu')
    expect(d.restart).not.toHaveBeenCalled()
    expect(d.dismiss).not.toHaveBeenCalled()
  })

  it('keeps the window open and says so when the restart fails', async () => {
    const d = deps({ restart: vi.fn(() => false) })
    expect(await noticeNoNewPrivs(d)).toBe('restart-failed')
    expect(d.quit).not.toHaveBeenCalled()
    const second = vi.mocked(d.show).mock.calls[1][0]
    expect(second.type).toBe('error')
    expect(second.message).toBe("Termpolis couldn't restart itself")
  })
})

describe('noticeStore', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nnp-store-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('remembers "don\'t show again" across launches', () => {
    expect(noticeStore(dir).dismissed()).toBe(false)
    noticeStore(dir).dismiss()
    expect(JSON.parse(readFileSync(join(dir, NOTICE_FILE), 'utf8'))).toEqual({ dismissed: true })
    expect(noticeStore(dir).dismissed()).toBe(true)
  })

  it('treats a damaged answer as not dismissed', () => {
    writeFileSync(join(dir, NOTICE_FILE), '{nope')
    expect(noticeStore(dir).dismissed()).toBe(false)
    writeFileSync(join(dir, NOTICE_FILE), JSON.stringify({ dismissed: 'yes' }))
    expect(noticeStore(dir).dismissed()).toBe(false)
  })

  it('never throws when the answer cannot be saved', () => {
    expect(() => noticeStore(join(dir, 'missing', 'deeper')).dismiss()).not.toThrow()
  })
})

describe('scheduleNoNewPrivsNotice', () => {
  let dir: string
  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'nnp-sched-'))
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('schedules nothing where the flag is clear', () => {
    const show = vi.fn()
    expect(scheduleNoNewPrivsNotice(dir, show, vi.fn(), { probe: () => false })).toBe(false)
    vi.runAllTimers()
    expect(show).not.toHaveBeenCalled()
  })

  it('shows the notice once the window has had time to appear, and restarts through systemd', async () => {
    const run = vi.fn(() => ({ status: 0 }))
    const show = vi.fn(async () => ({ response: 0 }))
    const quit = vi.fn()
    expect(scheduleNoNewPrivsNotice(dir, show, quit, { probe: () => true, delayMs: 50, systemd: { target: TARGET, run } })).toBe(true)
    expect(show).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50)
    expect(show).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('systemd-run', systemdRelaunchArgs(TARGET), TARGET.env)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('swallows a dialog that fails to open', async () => {
    const show = vi.fn(async () => { throw new Error('no window') })
    expect(scheduleNoNewPrivsNotice(dir, show, vi.fn(), { probe: () => true, systemd: { target: TARGET, run: () => ({ status: 1 }) } })).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('probes the real /proc by default', () => {
    const scheduled = scheduleNoNewPrivsNotice(dir, vi.fn(async () => ({ response: 1 })), vi.fn())
    expect(typeof scheduled).toBe('boolean')
    if (process.platform !== 'linux') expect(scheduled).toBe(false)
  })

  it('checks for systemd-run for real when given none, and never restarts on "Not now"', async () => {
    // "Not now" is the only answer given here, so the real systemd deps are asked for the
    // version at most and nothing is ever restarted.
    const show = vi.fn(async () => ({ response: 1 }))
    const quit = vi.fn()
    expect(scheduleNoNewPrivsNotice(dir, show, quit, { probe: () => true, delayMs: 10 })).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(show).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
  })
})
