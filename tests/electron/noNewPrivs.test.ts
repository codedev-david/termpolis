import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

// Nothing here may call relaunchViaSystemd with its real deps: a real relaunch shell started from
// a test waits for the test runner to exit and then runs it again. (A mocked child_process would
// be no guard: vi.mock reaches a Node built-in that a module imports, never one it require()s.)
// The real helpers are exercised only with commands that do nothing.

const {
  parseNoNewPrivs,
  hasNoNewPrivs,
  RELAUNCH_SCRIPT,
  WAIT_FOR_EXIT,
  WAIT_GAVE_UP,
  PACKAGE_TYPE_FILE,
  SYSTEM_PACKAGE_TYPES,
  readPackageType,
  runsFromAppImage,
  relaunchArgv,
  relaunchCommand,
  systemdRelaunchArgs,
  canRelaunchViaSystemd,
  relaunchViaSystemd,
  noticeNoNewPrivs,
  noticeStore,
  scheduleNoNewPrivsNotice,
  currentTarget,
  NOTICE_FILE,
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
    expect(relaunchCommand(TARGET).slice(5)).toEqual(relaunchArgv(TARGET))
  })

  it('waits with the loop it shares with the .deb update runner, in a subshell, and starts nothing once it gave up', () => {
    // In sh, assigning to a name the environment exports changes what a later exec passes on: the
    // shell that execs Termpolis must assign nothing.
    expect(RELAUNCH_SCRIPT).toBe(['(', 'pid=$1', ...WAIT_FOR_EXIT, `! ${WAIT_GAVE_UP}`, ') || exit 1', 'shift', 'exec "$@"'].join('\n'))
    expect(WAIT_FOR_EXIT.join('\n')).toContain('*Z*) break')
    expect(WAIT_FOR_EXIT.join('\n')).toContain(`[ "$i" -gt 600 ] && break`)
    expect(WAIT_GAVE_UP).toBe('[ "$i" -gt 600 ]')
  })

  it('restarts an AppImage from its file, not from the mount that disappears with it', () => {
    const appImage = '/home/d/Termpolis.AppImage'
    const cmd = relaunchCommand({ ...TARGET, execPath: '/tmp/.mount_TermpoXYZ/termpolis', env: { APPIMAGE: appImage }, appImage })
    expect(cmd[5]).toBe(appImage)
  })

  it('never restarts from an APPIMAGE that this Termpolis only inherited', () => {
    // A .deb Termpolis started from the terminal of an editor shipped as an AppImage has that
    // editor's APPIMAGE: restarting from it would start the editor instead.
    const cmd = relaunchCommand({ ...TARGET, env: { APPIMAGE: '/home/d/Applications/Cursor-1.7.0-x86_64.AppImage' } })
    expect(cmd[5]).toBe('/opt/Termpolis/termpolis')
  })

  it('describes this process by default', () => {
    // Outside Electron there is no resources folder, so no package-type: APPIMAGE alone decides.
    const appImage = process.env.APPIMAGE ? { appImage: process.env.APPIMAGE } : {}
    expect(currentTarget()).toEqual({ pid: process.pid, execPath: process.execPath, argv: process.argv, env: process.env, ...appImage })
  })
})

describe('an AppImage or a system package', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nnp-pkg-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** Runs `fn` with process.resourcesPath, which only Electron sets, and APPIMAGE as given. */
  function asPackaged(resourcesPath: string, appImage: string | undefined, fn: () => void): void {
    const saved = process.env.APPIMAGE
    Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true, writable: true })
    if (appImage === undefined) delete process.env.APPIMAGE
    else process.env.APPIMAGE = appImage
    try {
      fn()
    } finally {
      delete (process as { resourcesPath?: string }).resourcesPath
      if (saved === undefined) delete process.env.APPIMAGE
      else process.env.APPIMAGE = saved
    }
  }

  it('reads the package type electron-builder writes into the resources of a .deb', () => {
    writeFileSync(join(dir, PACKAGE_TYPE_FILE), 'deb\n')
    expect(readPackageType(dir)).toBe('deb')
    expect(PACKAGE_TYPE_FILE).toBe('package-type')
  })

  it('finds none in an AppImage, outside Electron, or where it cannot be read', () => {
    expect(readPackageType(dir)).toBeNull()
    expect(readPackageType(undefined)).toBeNull()
    expect(readPackageType(dir, () => { throw new Error('EACCES') })).toBeNull()
  })

  it("reads Electron's resources folder by default", () => {
    expect(readPackageType()).toBeNull()
    writeFileSync(join(dir, PACKAGE_TYPE_FILE), 'deb')
    asPackaged(dir, undefined, () => expect(readPackageType()).toBe('deb'))
  })

  it('is an AppImage only where APPIMAGE is set and no package type names a system package, as electron-updater decides', () => {
    // electron-updater picks DebUpdater, RpmUpdater or PacmanUpdater by package-type alone
    // (main.js), and its AppImage updater for anything else.
    const env = { APPIMAGE: '/home/d/Applications/Cursor-1.7.0-x86_64.AppImage' }
    expect(SYSTEM_PACKAGE_TYPES).toEqual(['deb', 'rpm', 'pacman'])
    for (const type of SYSTEM_PACKAGE_TYPES) expect(runsFromAppImage(env, type), type).toBe(false)
    expect(runsFromAppImage(env, null)).toBe(true)
    expect(runsFromAppImage(env, 'snap')).toBe(true)
    expect(runsFromAppImage({}, null)).toBe(false)
    expect(runsFromAppImage({ APPIMAGE: '' }, null)).toBe(false)
  })

  it("gives this process's target its AppImage, decided that way", () => {
    const appImage = '/home/d/Termpolis.AppImage'
    asPackaged(dir, appImage, () => {
      expect(currentTarget().appImage).toBe(appImage)
      expect(relaunchArgv(currentTarget())[0]).toBe(appImage)
      // The .deb, started from an AppImage's terminal.
      writeFileSync(join(dir, PACKAGE_TYPE_FILE), 'deb\n')
      expect(currentTarget().appImage).toBeUndefined()
      expect(relaunchArgv(currentTarget())[0]).toBe(process.execPath)
    })
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

  it('treats an exited process that nobody has reaped as gone', async () => {
    // `exec sleep 5` replaces the shell, so nothing ever reaps the backgrounded sleep: once it
    // exits it stays a zombie, which still answers kill -0, for the rest of the five seconds.
    const holder = spawn('/bin/sh', ['-c', 'sleep 0.2 & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const pid = await new Promise<string>((resolve) => holder.stdout!.once('data', (d) => resolve(String(d).trim())))
    try {
      const out = join(dir, 'out')
      const started = Date.now()
      const r = spawnSync('/bin/sh', ['-c', RELAUNCH_SCRIPT, 'termpolis-relaunch', pid, '/bin/sh', '-c', ': > "$0"', out], { timeout: 10_000 })
      expect(r.status).toBe(0)
      expect(Date.now() - started).toBeLessThan(4000)
      expect(existsSync(out)).toBe(true)
    } finally {
      holder.kill()
    }
  })

  it('starts at once when the old process is already gone', () => {
    const out = join(dir, 'out')
    const r = spawnSync('/bin/sh', ['-c', RELAUNCH_SCRIPT, 'termpolis-relaunch', '999999999', '/bin/sh', '-c', ': > "$0"', out], { timeout: 10_000 })
    expect(r.status).toBe(0)
    expect(existsSync(out)).toBe(true)
  })

  it('passes on an environment that already had the names it waits with, unchanged', () => {
    const out = join(dir, 'out')
    const r = spawnSync('/bin/sh', [
      '-c', RELAUNCH_SCRIPT, 'termpolis-relaunch', '999999999', '/bin/sh', '-c', 'printf "%s|%s" "$pid" "$i" > "$0"', out,
    ], { env: { ...process.env, pid: 'mine', i: 'also mine' }, timeout: 10_000 })
    expect(r.status).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe('mine|also mine')
  })

  it('starts nothing once it has given up waiting', () => {
    // Three looks instead of 600, so it gives up in about half a second instead of two minutes.
    const script = RELAUNCH_SCRIPT.split('-gt 600').join('-gt 3')
    expect(script.split('-gt 3')).toHaveLength(3)
    const old = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      const out = join(dir, 'out')
      const r = spawnSync('/bin/sh', ['-c', script, 'termpolis-relaunch', String(old.pid), '/bin/sh', '-c', ': > "$0"', out], { timeout: 20_000 })
      expect(r.status).toBe(1)
      expect(existsSync(out)).toBe(false)
    } finally {
      old.kill()
    }
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
