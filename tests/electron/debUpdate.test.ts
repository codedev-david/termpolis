// @vitest-environment node
// debUpdate.ts: installing a downloaded .deb from outside Termpolis, so Restart never freezes it.
//
// Nothing here may start the real runner. startDebInstall is only ever given a fake spawn, and
// defaultDebInstallDeps is only inspected: a real runner waits for the test process to exit, asks
// for the administrator password, and then starts the test process again. The fake is handed in
// rather than child_process mocked: vi.mock reaches a Node built-in that a module imports, but
// never one it require()s, so a mock would be a guard a refactor could quietly undo. The script
// itself runs under a real sh, with stubs, in debUpdateRunner.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawnSync, type ChildProcess } from 'child_process'
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { join, posix } from 'path'
import {
  DEB_BUSY_MESSAGE,
  DEB_CANCELLED_MESSAGE,
  DEB_NOT_STARTED_LEAD,
  DEB_NO_RIGHTS_LEAD,
  DEB_INSTALL_COMMAND,
  DEB_INSTALL_SCRIPT,
  DEB_LOG_FILE,
  DEB_LOG_MAX_BYTES,
  DEB_RESULT_FILE,
  DEB_RESULT_MAX_AGE_MS,
  DEB_RUNNER_FILE,
  DEB_RUNNER_NAME,
  DEB_TAIL_BYTES,
  PKEXEC_DISMISSED,
  PKEXEC_NOT_AUTHORIZED,
  createFresh,
  debErrorDetail,
  debFailedMessage,
  debIncompleteMessage,
  debInstallCommand,
  debInstalledMessage,
  debInstallFiles,
  debInstallNotice,
  debInstallerRunning,
  debManualInstallMessage,
  debPendingDir,
  defaultDebInstallDeps,
  findDebTool,
  isExecutableFile,
  parseDebInstallResult,
  readDebInstallNotice,
  readDebInstallResult,
  readSmallFile,
  spawnRunner,
  startDebInstall,
  takeDebInstallResult,
  type DebInstallDeps,
  type DebInstallResult,
} from '../../src/main/debUpdate'
import { WAIT_FOR_EXIT, WAIT_GAVE_UP, currentTarget, type RelaunchTarget } from '../../src/main/noNewPrivs'

const posixOnly = process.platform !== 'win32'
const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex')

const TARGET: RelaunchTarget = {
  pid: 4242,
  execPath: '/opt/Termpolis/termpolis',
  argv: ['/opt/Termpolis/termpolis', '--no-sandbox', '--disable-gpu'],
  env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/d', DISPLAY: ':0' },
}
/** electron-updater's folder for a downloaded update, for the home folder of TARGET. */
const PENDING = '/home/d/.cache/termpolis-updater/pending'
const DEB = `${PENDING}/termpolis_1.54.1_amd64.deb`
const REQUEST = { deb: DEB, from: '1.54.0', target: '1.54.1' }
const FILES = {
  log: '/home/d/.config/termpolis/update-install.log',
  result: '/home/d/.config/termpolis/update-result.json',
  runner: '/home/d/.config/termpolis/update-install.pid',
}
const PKEXEC = { how: 'pkexec' as const, path: '/usr/bin/pkexec' }
const SUDO = { how: 'sudo' as const, path: '/usr/bin/sudo', askpass: '/home/d/.config/termpolis/askpass/sudo-askpass' }

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'deb-update-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('loading the module', () => {
  it('needs nothing of fs at load time, so a test that mocks fs without its constants can still load index.ts', async () => {
    // mainProcess.test.ts mocks fs with a handful of functions and no `constants`, then imports
    // index.ts, which imports autoUpdater.ts, which imports this module. A flag read when the
    // module loads made that whole file fail to load, its 240 tests with it.
    vi.resetModules()
    vi.doMock('fs', async () => {
      const { constants: _constants, ...fs } = await vi.importActual<typeof import('fs')>('fs')
      return { ...fs, default: fs }
    })
    try {
      const mod = await import('../../src/main/debUpdate')
      // Where the flags are wanted, their absence is a file that can't be read.
      expect(mod.readSmallFile(join(dir, 'missing'), 100)).toBeNull()
      expect(mod.isExecutableFile(dir)).toBe(false)
    } finally {
      vi.doUnmock('fs')
      vi.resetModules()
    }
  })
})

describe('what the runner runs', () => {
  it("is electron-updater's two install steps in one command, so they take one prompt", () => {
    // DebUpdater runs `dpkg -i <deb>` and, when that fails, a second privileged
    // `apt-get install -f -y`. Here $1 is the .deb, so its path is never read as shell.
    expect(DEB_INSTALL_COMMAND).toBe('dpkg -i "$1" || apt-get install -f -y --no-remove')
    expect(DEB_INSTALL_SCRIPT).toContain(`install='${DEB_INSTALL_COMMAND}'`)
  })

  it('never lets apt-get remove a package to settle what dpkg left unmet, Termpolis least of all', () => {
    // Where a dependency can't be had, apt-get install -f -y's answer is to remove whatever needs
    // it, without asking, and exit 0. --no-remove makes it fail instead, having touched nothing.
    expect(DEB_INSTALL_COMMAND.split('||')[1].trim().split(' ')).toEqual(['apt-get', 'install', '-f', '-y', '--no-remove'])
  })

  it('waits for the old Termpolis with the loop the relaunch uses, zombie check included', () => {
    expect(DEB_INSTALL_SCRIPT).toContain(WAIT_FOR_EXIT.join('\n'))
    expect(DEB_INSTALL_SCRIPT.startsWith('(\npid=$1;')).toBe(true)
  })

  it('says why when it gave up waiting, rather than leaving nothing behind', () => {
    // The old Termpolis still running two minutes on, stuck in native teardown say: nothing is
    // installed, and the result and the log say so, for the next launch to tell.
    expect(DEB_INSTALL_SCRIPT).toContain(
      `if ${WAIT_GAVE_UP}; then\n` +
        `  printf '${DEB_RUNNER_NAME}: error: Termpolis was still running two minutes after Restart, so nothing was installed\\n'\n` +
        '  code=1\n',
    )
  })

  it('works in a subshell, so the shell that starts Termpolis again has assigned nothing', () => {
    // In sh, assigning to a name the environment exports changes it for whatever is started
    // afterwards: a $log or $code of the user's own would reach the new Termpolis as the runner's.
    expect(DEB_INSTALL_SCRIPT.endsWith(')\nshift 9\nexec "$@" </dev/null >/dev/null 2>&1')).toBe(true)
    expect(DEB_INSTALL_SCRIPT.split('\n').filter((line) => line === ')')).toHaveLength(1)
  })

  it('asks through pkexec without its text agent, or through sudo -A, for that one command', () => {
    expect(DEB_INSTALL_SCRIPT).toContain('pkexec) LC_ALL=C "$tool" --disable-internal-agent /bin/sh -c "$install" sh "$deb" ;;')
    // SUDO_ASKPASS reaches sudo alone, never the Termpolis that is started afterwards.
    expect(DEB_INSTALL_SCRIPT).toContain('*) LC_ALL=C SUDO_ASKPASS=$askpass "$tool" -A /bin/sh -c "$install" sh "$deb" ;;')
    expect(DEB_INSTALL_SCRIPT).not.toMatch(/export/)
  })

  it('runs the tool in the C locale, so the log says what went wrong in the words the next launch looks for', () => {
    // pkexec and sudo both pass LC_ALL on to the command. It is set for those two commands (and
    // the tr that keeps the hex) alone: Termpolis itself is started with the locale it had.
    expect(DEB_INSTALL_SCRIPT.match(/LC_ALL=C "\$tool"|LC_ALL=C SUDO_ASKPASS/g)).toHaveLength(2)
    for (const line of DEB_INSTALL_SCRIPT.split('\n')) expect(line).not.toMatch(/^\s*(?:export\s+)?LC_ALL=\S*\s*$/)
  })

  it('writes the result by noclobber and rename, and starts Termpolis detached from the log', () => {
    // Readable by the user alone, like the log it quotes. The umask is the subshell's, not the
    // Termpolis it starts.
    expect(DEB_INSTALL_SCRIPT).toContain('if (\n  umask 077\n  set -C')
    expect(DEB_INSTALL_SCRIPT).toContain('set -C')
    expect(DEB_INSTALL_SCRIPT).toContain('mv -f "$tmp" "$result"')
    expect(DEB_INSTALL_SCRIPT).toContain(`tail -c ${DEB_TAIL_BYTES} "$log" | od -A n -v -t x1`)
    expect(DEB_INSTALL_SCRIPT.endsWith('exec "$@" </dev/null >/dev/null 2>&1')).toBe(true)
  })

  it('keeps its files in userData', () => {
    expect(debInstallFiles('/u')).toEqual({
      log: join('/u', DEB_LOG_FILE),
      result: join('/u', DEB_RESULT_FILE),
      runner: join('/u', DEB_RUNNER_FILE),
    })
    expect([DEB_LOG_FILE, DEB_RESULT_FILE, DEB_RUNNER_FILE]).toEqual(['update-install.log', 'update-result.json', 'update-install.pid'])
  })
})

describe('findDebTool', () => {
  const on = (...paths: string[]) => { const set = new Set(paths); return (p: string) => set.has(p) }

  it('takes pkexec first', () => {
    expect(findDebTool('/usr/bin', SUDO.askpass, on('/usr/bin/pkexec', '/usr/bin/sudo'))).toEqual(PKEXEC)
  })

  it('looks in the system folders before PATH, and in PATH after them', () => {
    // A pkexec of the user's own, early on PATH, is not the setuid one the distribution installed.
    expect(findDebTool('/home/d/bin:/usr/bin', null, on('/home/d/bin/pkexec', '/usr/bin/pkexec'))).toEqual(PKEXEC)
    expect(findDebTool('/opt/polkit/bin', null, on('/opt/polkit/bin/pkexec'))).toEqual({ how: 'pkexec', path: '/opt/polkit/bin/pkexec' })
    expect(findDebTool(undefined, null, on('/sbin/pkexec'))).toEqual({ how: 'pkexec', path: '/sbin/pkexec' })
  })

  it('ignores empty and relative PATH entries', () => {
    expect(findDebTool('bin::.', null, on('bin/pkexec', 'pkexec', './pkexec', '/pkexec'))).toBeNull()
  })

  it('falls back to sudo -A only where Termpolis has its askpass helper', () => {
    expect(findDebTool('/usr/bin', SUDO.askpass, on('/usr/bin/sudo'))).toEqual(SUDO)
    expect(findDebTool('/usr/bin', null, on('/usr/bin/sudo'))).toBeNull()
  })

  it('finds nothing where there is neither', () => {
    expect(findDebTool('/usr/bin', SUDO.askpass, on())).toBeNull()
  })

  it('checks real files by default', () => {
    // Whatever this machine has, without an askpass helper the answer is pkexec or nothing.
    const tool = findDebTool(process.env.PATH, null)
    expect(tool === null || tool.how === 'pkexec').toBe(true)
  })
})

describe('isExecutableFile', () => {
  it('is true for a file that can be run, and false for a folder or nothing', () => {
    const file = join(dir, 'tool')
    writeFileSync(file, '#!/bin/sh\n')
    chmodSync(file, 0o755)
    expect(isExecutableFile(file)).toBe(true)
    expect(isExecutableFile(dir)).toBe(false)
    expect(isExecutableFile(join(dir, 'missing'))).toBe(false)
  })

  it.runIf(posixOnly)('is false for a file without the execute bit', () => {
    const file = join(dir, 'plain')
    writeFileSync(file, 'x')
    chmodSync(file, 0o644)
    expect(isExecutableFile(file)).toBe(false)
  })
})

describe('debInstallCommand', () => {
  it('waits for this pid, installs the .deb, then starts the same program with the same arguments', () => {
    const cmd = debInstallCommand(TARGET, REQUEST, PKEXEC, FILES)
    expect(cmd).toEqual([
      '/bin/sh', '-c', DEB_INSTALL_SCRIPT, DEB_RUNNER_NAME,
      '4242', DEB, FILES.log, FILES.result, cmd[8], 'pkexec', '/usr/bin/pkexec', '', FILES.runner,
      '/opt/Termpolis/termpolis', '--no-sandbox', '--disable-gpu',
    ])
    // What the result file quotes back, JSON-encoded here rather than by the shell.
    expect(JSON.parse(cmd[8])).toEqual({ from: '1.54.0', target: '1.54.1', deb: DEB, how: 'pkexec' })
  })

  it('passes the askpass helper for sudo', () => {
    const cmd = debInstallCommand(TARGET, REQUEST, SUDO, FILES)
    expect(cmd.slice(9, 12)).toEqual(['sudo', '/usr/bin/sudo', SUDO.askpass])
    expect(JSON.parse(cmd[8]).how).toBe('sudo')
  })

  it('names how it asks in an argument of its own, rather than leaving the script to guess from the path', () => {
    // A pkexec found under another name or folder is still asked as pkexec.
    const cmd = debInstallCommand(TARGET, REQUEST, { how: 'pkexec', path: '/opt/polkit/bin/pkexec-1' }, FILES)
    expect(cmd.slice(9, 11)).toEqual(['pkexec', '/opt/polkit/bin/pkexec-1'])
    expect(DEB_INSTALL_SCRIPT).toContain('  case $how in\n')
  })

  it('hands a .deb path with spaces, quotes, $ and backticks over as one argument, never as shell', () => {
    const deb = "/home/o'neil \"x\"/$HOME/`id`/termpolis_1.54.1_amd64.deb"
    const cmd = debInstallCommand(TARGET, { ...REQUEST, deb }, PKEXEC, FILES)
    expect(cmd[5]).toBe(deb)
    expect(JSON.parse(cmd[8]).deb).toBe(deb)
  })

  it('restarts the program dpkg has replaced, never an AppImage that an inherited APPIMAGE names', () => {
    // Only a .deb gets here. Started from the terminal of an editor shipped as an AppImage, this
    // Termpolis has the editor's APPIMAGE, and restarting from that would start the editor.
    const leaked = '/home/d/Applications/Cursor-1.7.0-x86_64.AppImage'
    for (const target of [{ ...TARGET, env: { APPIMAGE: leaked } }, { ...TARGET, env: { APPIMAGE: leaked }, appImage: leaked }]) {
      expect(debInstallCommand(target, REQUEST, PKEXEC, FILES).slice(13)).toEqual(['/opt/Termpolis/termpolis', '--no-sandbox', '--disable-gpu'])
    }
  })
})

describe('startDebInstall', () => {
  function deps(over: Partial<DebInstallDeps> = {}) {
    const child = { on: vi.fn(), unref: vi.fn(), pid: 31337 as number | undefined }
    const spawn = vi.fn((_cmd: string, _args: string[], _opts: unknown) => child)
    const d: DebInstallDeps = {
      target: TARGET,
      userDataPath: dir,
      askpass: null,
      isExecutable: (p) => p === '/usr/bin/pkexec',
      running: () => false,
      spawn,
      ...over,
    }
    return { d, spawn, child }
  }

  it('starts the runner detached, its output going to a fresh log, with this environment', () => {
    const { d, spawn, child } = deps()
    expect(startDebInstall(REQUEST, d)).toEqual({ started: true })
    const files = debInstallFiles(dir)
    const [cmd, ...args] = debInstallCommand(TARGET, REQUEST, PKEXEC, files)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][0]).toBe(cmd)
    expect(spawn.mock.calls[0][1]).toEqual(args)
    const opts = spawn.mock.calls[0][2] as { detached: boolean; stdio: unknown[]; env: unknown }
    expect(opts.detached).toBe(true)
    expect(opts.stdio[0]).toBe('ignore')
    expect(typeof opts.stdio[1]).toBe('number')
    expect(opts.stdio[2]).toBe(opts.stdio[1])
    // The very environment this process has: the Termpolis it starts afterwards gets it too.
    expect(opts.env).toBe(TARGET.env)
    expect(child.unref).toHaveBeenCalled()
    // A spawn failure arrives as an 'error' event; unheard, it would crash the main process.
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(() => (child.on.mock.calls[0] as unknown as [string, (e: Error) => void])[1](new Error('ENOENT'))).not.toThrow()
    expect(readFileSync(files.log, 'utf8')).toBe('')
    expect(readFileSync(files.runner, 'utf8')).toBe('31337')
    if (posixOnly) expect(statSync(files.log).mode & 0o777).toBe(0o600)
  })

  it('replaces the log of an earlier attempt', () => {
    writeFileSync(join(dir, DEB_LOG_FILE), 'dpkg: error: the last time\n')
    expect(startDebInstall(REQUEST, deps().d)).toEqual({ started: true })
    expect(readFileSync(join(dir, DEB_LOG_FILE), 'utf8')).toBe('')
  })

  it("removes an earlier attempt's unread result, which would otherwise pass for this one's", () => {
    // Were this runner to give up waiting, the next launch would read the old result as its own.
    writeFileSync(join(dir, DEB_RESULT_FILE), JSON.stringify({ code: 126, tailHex: '' }))
    expect(startDebInstall(REQUEST, deps().d)).toEqual({ started: true })
    expect(existsSync(join(dir, DEB_RESULT_FILE))).toBe(false)
  })

  it('leaves a result alone when nothing starts', () => {
    writeFileSync(join(dir, DEB_RESULT_FILE), '{}')
    expect(startDebInstall(REQUEST, deps({ isExecutable: () => false }).d).started).toBe(false)
    expect(existsSync(join(dir, DEB_RESULT_FILE))).toBe(true)
  })

  it('still starts with a folder at the result path, which the runner then cannot replace', () => {
    mkdirSync(join(dir, DEB_RESULT_FILE))
    expect(startDebInstall(REQUEST, deps().d)).toEqual({ started: true })
  })

  it.runIf(posixOnly)('never writes through a symlink at the log or the runner file', () => {
    const keep = join(dir, 'keep')
    writeFileSync(keep, 'keep')
    symlinkSync(keep, join(dir, DEB_LOG_FILE))
    symlinkSync(keep, join(dir, DEB_RUNNER_FILE))
    expect(startDebInstall(REQUEST, deps().d)).toEqual({ started: true })
    expect(readFileSync(keep, 'utf8')).toBe('keep')
    expect(lstatSync(join(dir, DEB_LOG_FILE)).isFile()).toBe(true)
    expect(lstatSync(join(dir, DEB_RUNNER_FILE)).isFile()).toBe(true)
  })

  it('uses sudo -A with the askpass helper where there is no pkexec', () => {
    const { d, spawn } = deps({ askpass: SUDO.askpass, isExecutable: (p) => p === '/usr/bin/sudo' })
    expect(startDebInstall(REQUEST, d)).toEqual({ started: true })
    expect(spawn.mock.calls[0][1]).toEqual(debInstallCommand(TARGET, REQUEST, SUDO, debInstallFiles(dir)).slice(1))
  })

  it('refuses while the runner of an earlier Restart is still at work, so dpkg never runs twice', () => {
    const { d, spawn } = deps({ running: () => true })
    expect(startDebInstall(REQUEST, d)).toEqual({ started: false, busy: true, message: DEB_BUSY_MESSAGE })
    expect(spawn).not.toHaveBeenCalled()
  })

  /** What an earlier runner left in userData, nobody having read it yet. */
  const writeResult = (over: { code?: number; info?: Record<string, unknown>; tail?: string } = {}) =>
    writeFileSync(
      join(dir, DEB_RESULT_FILE),
      JSON.stringify({ info: { from: '1.54.0', target: '1.54.1', deb: DEB, how: 'pkexec', ...over.info }, code: over.code ?? 0, tailHex: hex(over.tail ?? 'Setting up termpolis (1.54.1) ...\n') }),
    )

  it('refuses to install again what the runner of an earlier Restart installed, its result unread', () => {
    // A Termpolis opened by hand while the password dialog was up still runs 1.54.0, and finds
    // 1.54.1 as new as ever; the copy the runner started found it holding the single-instance
    // lock and quit at once, so nobody read the result.
    writeResult()
    const { d, spawn } = deps()
    expect(startDebInstall(REQUEST, d)).toEqual({ started: false, message: debInstalledMessage('1.54.1') })
    expect(debInstalledMessage('1.54.1')).toBe('Termpolis 1.54.1 is installed. Quit Termpolis and open it again to start it.')
    expect(spawn).not.toHaveBeenCalled()
    // Left for the launch that runs 1.54.1, which has nothing to say about it.
    expect(existsSync(join(dir, DEB_RESULT_FILE))).toBe(true)
    expect(existsSync(join(dir, DEB_LOG_FILE))).toBe(false)
  })

  it("installs again when the earlier result isn't this update, installed", () => {
    const cases: [string, () => void, typeof REQUEST | { deb: string; from: string }][] = [
      ['the prompt was cancelled', () => writeResult({ code: PKEXEC_DISMISSED }), REQUEST],
      ['another version', () => writeResult({ info: { target: '1.54.2' } }), REQUEST],
      ['installed from another version', () => writeResult({ info: { from: '1.53.0' } }), REQUEST],
      ['dpkg failed and apt-get -f had nothing to fix', () => writeResult({ tail: `dpkg-deb: error: '${DEB}' is not a Debian format archive\n` }), REQUEST],
      ['a request with no version to tell it by', () => writeResult(), { deb: DEB, from: '1.54.0' }],
      ['a day old', () => {
        writeResult()
        const at = (Date.now() - DEB_RESULT_MAX_AGE_MS - 60_000) / 1000
        utimesSync(join(dir, DEB_RESULT_FILE), at, at)
      }, REQUEST],
      ["dpkg's error further back in the log than the result's tail", () => {
        writeResult()
        writeFileSync(join(dir, DEB_LOG_FILE), `dpkg: error processing archive ${DEB} (--install):\n failed to write (No space left on device)\n`)
      }, REQUEST],
    ]
    for (const [why, arrange, request] of cases) {
      rmSync(join(dir, DEB_RESULT_FILE), { force: true })
      rmSync(join(dir, DEB_LOG_FILE), { force: true })
      arrange()
      const { d, spawn } = deps()
      expect(startDebInstall(request, d), why).toEqual({ started: true })
      expect(spawn, why).toHaveBeenCalledTimes(1)
      // The new attempt's own result can't be mistaken for that one.
      expect(existsSync(join(dir, DEB_RESULT_FILE)), why).toBe(false)
    }
  })

  it('gives the command to run by hand, without starting anything, where there is neither pkexec nor sudo', () => {
    const { d, spawn } = deps({ isExecutable: () => false })
    expect(startDebInstall(REQUEST, d)).toEqual({ started: false, message: debManualInstallMessage(DEB) })
    expect(debManualInstallMessage(DEB).startsWith(DEB_NO_RIGHTS_LEAD)).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
    expect(existsSync(join(dir, DEB_LOG_FILE))).toBe(false)
  })

  it('points at the release page when update-downloaded named no usable .deb', () => {
    for (const deb of [null, undefined, '', 'termpolis_1.54.1_amd64.deb', '/home/d/termpolis.rpm', '/home/d/x\0.deb']) {
      const { d, spawn } = deps()
      expect(startDebInstall({ ...REQUEST, deb }, d), String(deb)).toEqual({
        started: false,
        message: debManualInstallMessage(undefined, DEB_NOT_STARTED_LEAD),
      })
      expect(spawn).not.toHaveBeenCalled()
    }
  })

  // Not a question of administrator rights: the installer never started.
  const notStarted = { started: false, message: debManualInstallMessage(DEB, DEB_NOT_STARTED_LEAD) }

  it("gives the command to run by hand when the runner can't be started", () => {
    const { d } = deps({ spawn: () => { throw new Error('EAGAIN') } })
    expect(startDebInstall(REQUEST, d)).toEqual(notStarted)
    expect(existsSync(join(dir, DEB_RUNNER_FILE))).toBe(false)
  })

  it('does not count a child without a pid as started: its error comes later, and nothing would install', () => {
    const { d, child } = deps()
    child.pid = undefined
    expect(startDebInstall(REQUEST, d)).toEqual(notStarted)
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(existsSync(join(dir, DEB_RUNNER_FILE))).toBe(false)
  })

  it("gives the command to run by hand when the log can't be created", () => {
    const file = join(dir, 'not-a-folder')
    writeFileSync(file, '')
    const { d, spawn } = deps({ userDataPath: file })
    expect(startDebInstall(REQUEST, d)).toEqual(notStarted)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('still starts when the runner file cannot be written', () => {
    mkdirSync(join(dir, DEB_RUNNER_FILE))
    writeFileSync(join(dir, DEB_RUNNER_FILE, 'x'), '')
    expect(startDebInstall(REQUEST, deps().d)).toEqual({ started: true })
  })

  it('checks for an earlier runner in userData, and looks for real tools, by default', () => {
    const { running: _r, isExecutable: _i, ...rest } = deps().d
    // Whether or not this machine has pkexec, nothing real is spawned: spawn is the fake.
    const start = startDebInstall(REQUEST, rest)
    expect(start.started || start.message === debManualInstallMessage(DEB)).toBe(true)
  })
})

describe('the real spawn and the default deps', () => {
  it('spawnRunner starts a process that can outlive this one, its output going where it is told', async () => {
    const out = join(dir, 'out.log')
    const fd = openSync(out, 'w')
    const child = spawnRunner(process.execPath, ['-e', 'process.stdout.write("ok")'], { detached: true, stdio: ['ignore', fd, fd], env: process.env })
    const code = await new Promise<number | null>((resolve) => (child as unknown as ChildProcess).on('exit', resolve))
    closeSync(fd)
    child.unref()
    expect(code).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe('ok')
  })

  it('installs for this process, through child_process, with the askpass helper it is given', () => {
    // Inspected only: never passed to startDebInstall, which would start the real runner.
    const d = defaultDebInstallDeps('/u', '/u/askpass/sudo-askpass')
    expect(d.target).toEqual(currentTarget())
    expect(d.spawn).toBe(spawnRunner)
    expect(d.userDataPath).toBe('/u')
    expect(d.askpass).toBe('/u/askpass/sudo-askpass')
  })
})

describe('debInstallerRunning', () => {
  const pidFile = () => join(dir, DEB_RUNNER_FILE)

  it('is false with no runner file, without looking any further', () => {
    const readProc = vi.fn()
    expect(debInstallerRunning(dir, readProc)).toBe(false)
    expect(readProc).not.toHaveBeenCalled()
  })

  it('is true while that pid is still the runner, by the name it runs under', () => {
    writeFileSync(pidFile(), '31337')
    const readProc = vi.fn(() => ['/bin/sh', '-c', DEB_INSTALL_SCRIPT, DEB_RUNNER_NAME, '123', ''].join('\0'))
    expect(debInstallerRunning(dir, readProc)).toBe(true)
    expect(readProc).toHaveBeenCalledWith('/proc/31337/cmdline')
  })

  it('is false once the pid is gone or belongs to something else', () => {
    writeFileSync(pidFile(), '31337\n')
    expect(debInstallerRunning(dir, () => { throw new Error('ENOENT') })).toBe(false)
    expect(debInstallerRunning(dir, () => '/usr/bin/vim\0notes.txt\0')).toBe(false)
    // The name has to be a whole argument.
    expect(debInstallerRunning(dir, () => `/bin/sh\0-c\0echo ${DEB_RUNNER_NAME}x\0`)).toBe(false)
  })

  it('is false for a runner file that holds no pid', () => {
    for (const text of ['', 'abc', '0', '-5', '1.5', '3000000000', '9'.repeat(40)]) {
      writeFileSync(pidFile(), text)
      expect(debInstallerRunning(dir, () => DEB_RUNNER_NAME), text).toBe(false)
    }
  })

  it('reads the real /proc by default', () => {
    writeFileSync(pidFile(), String(process.pid))
    // This process is not the runner, on Linux; elsewhere there is no /proc to read.
    expect(debInstallerRunning(dir)).toBe(false)
  })
})

describe('createFresh', () => {
  /** The error code createFresh throws, with an unlink that leaves whatever is at the path, which
   *  stands in for something put there between the removal and the open. */
  function codeAfterPlant(path: string): string | undefined {
    try {
      closeSync(createFresh(path, () => {}))
    } catch (err) {
      return (err as NodeJS.ErrnoException).code
    }
    return undefined
  }

  it('creates the file when nothing is there', () => {
    const file = join(dir, 'log')
    closeSync(createFresh(file))
    expect(lstatSync(file).isFile()).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  it('fails, and leaves it alone, when a file is put at the path after the removal', () => {
    const file = join(dir, 'log')
    writeFileSync(file, 'planted')
    expect(codeAfterPlant(file)).toBe('EEXIST')
    expect(readFileSync(file, 'utf8')).toBe('planted')
  })

  it.runIf(posixOnly)('never opens through a symlink put at the path after the removal', () => {
    const keep = join(dir, 'keep')
    writeFileSync(keep, 'keep')
    symlinkSync(keep, join(dir, 'log'))
    expect(codeAfterPlant(join(dir, 'log'))).toBe('EEXIST')
    expect(readFileSync(keep, 'utf8')).toBe('keep')
  })
})

describe('readSmallFile', () => {
  it("returns a small regular file's text and when it was written", () => {
    const file = join(dir, 'f')
    writeFileSync(file, 'héllo')
    const read = readSmallFile(file, 100)
    expect(read?.text).toBe('héllo')
    expect(read?.mtimeMs).toBe(statSync(file).mtimeMs)
    writeFileSync(file, '')
    expect(readSmallFile(file, 100)?.text).toBe('')
  })

  it('returns null for nothing, a folder, or a file over the limit', () => {
    writeFileSync(join(dir, 'big'), 'x'.repeat(101))
    expect(readSmallFile(join(dir, 'missing'), 100)).toBeNull()
    expect(readSmallFile(dir, 100)).toBeNull()
    expect(readSmallFile(join(dir, 'big'), 100)).toBeNull()
  })

  it.runIf(posixOnly)('never follows a symlink', () => {
    writeFileSync(join(dir, 'real'), 'secret')
    symlinkSync(join(dir, 'real'), join(dir, 'link'))
    expect(readSmallFile(join(dir, 'link'), 100)).toBeNull()
  })

  const hasMkfifo = posixOnly && spawnSync('sh', ['-c', 'command -v mkfifo']).status === 0
  it.runIf(hasMkfifo)('never waits on a FIFO', () => {
    const fifo = join(dir, 'fifo')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    expect(readSmallFile(fifo, 100)).toBeNull()
  })
})

describe('parseDebInstallResult', () => {
  const info = { from: '1.54.0', target: '1.54.1', deb: DEB, how: 'pkexec' }

  it('reads what the runner wrote, the log tail out of its hex', () => {
    const tail = 'Error executing command as another user: Request dismissed\n"quoted" \\ é\t\u0001'
    expect(parseDebInstallResult(JSON.stringify({ info, code: 126, tailHex: hex(tail) }))).toEqual({
      code: 126, tail, from: '1.54.0', target: '1.54.1', deb: DEB, how: 'pkexec',
    })
    expect(parseDebInstallResult(JSON.stringify({ info: { ...info, how: 'sudo' }, code: 0, tailHex: '' }))?.how).toBe('sudo')
    expect(parseDebInstallResult(`{"info":${JSON.stringify(info)},"code":0,"tailHex":"ABCD"}\n`)?.tail).toBe(Buffer.from([0xab, 0xcd]).toString('utf8'))
  })

  it('is null for anything that is not a result', () => {
    for (const text of ['', '{', 'null', '42', '"x"', '[]', JSON.stringify({ info })]) {
      expect(parseDebInstallResult(text), text).toBeNull()
    }
    for (const code of [-1, 256, 1.5, '0', null]) {
      expect(parseDebInstallResult(JSON.stringify({ info, code, tailHex: '' })), String(code)).toBeNull()
    }
  })

  it('keeps a result whose details are missing or the wrong shape, without them', () => {
    expect(parseDebInstallResult(JSON.stringify({ code: 1 }))).toEqual({ code: 1, tail: '' })
    expect(parseDebInstallResult(JSON.stringify({ code: 1, tailHex: 7, info: 'x' }))).toEqual({ code: 1, tail: '' })
    // Not hex, or half a byte: no tail rather than a wrong one.
    expect(parseDebInstallResult(JSON.stringify({ code: 1, tailHex: 'zz' }))).toEqual({ code: 1, tail: '' })
    expect(parseDebInstallResult(JSON.stringify({ code: 1, tailHex: 'abc' }))).toEqual({ code: 1, tail: '' })
    expect(parseDebInstallResult(JSON.stringify({ code: 1, info: { from: 3, target: '', deb: null, how: 'su' } }))).toEqual({ code: 1, tail: '' })
  })
})

describe('readDebInstallResult', () => {
  it('reads the result and leaves it where it is', () => {
    writeFileSync(join(dir, DEB_RESULT_FILE), JSON.stringify({ info: { from: '1.54.0', target: '1.54.1' }, code: 0, tailHex: '' }))
    expect(readDebInstallResult(dir)).toEqual({ code: 0, tail: '', from: '1.54.0', target: '1.54.1' })
    expect(readDebInstallResult(dir)).toEqual({ code: 0, tail: '', from: '1.54.0', target: '1.54.1' })
    expect(existsSync(join(dir, DEB_RESULT_FILE))).toBe(true)
  })

  it('is null for no result, or one more than a day old', () => {
    expect(readDebInstallResult(dir)).toBeNull()
    writeFileSync(join(dir, DEB_RESULT_FILE), JSON.stringify({ code: 0, tailHex: '' }))
    expect(readDebInstallResult(dir, Date.now() + DEB_RESULT_MAX_AGE_MS + 60_000)).toBeNull()
  })
})

describe('takeDebInstallResult', () => {
  const file = () => join(dir, DEB_RESULT_FILE)
  const write = (body: unknown) => writeFileSync(file(), typeof body === 'string' ? body : JSON.stringify(body))
  const NOW = Date.now()

  it('reads the result once: it is gone afterwards', () => {
    write({ info: { from: '1.54.0', target: '1.54.1' }, code: 126, tailHex: '' })
    expect(takeDebInstallResult(dir, NOW)).toEqual({ code: 126, tail: '', from: '1.54.0', target: '1.54.1' })
    expect(existsSync(file())).toBe(false)
    expect(takeDebInstallResult(dir, NOW)).toBeNull()
  })

  it('throws away a corrupt or huge result', () => {
    write('{"code":12')
    expect(takeDebInstallResult(dir, NOW)).toBeNull()
    expect(existsSync(file())).toBe(false)
    write({ code: 1, tailHex: 'ab'.repeat(40 * 1024) })
    expect(takeDebInstallResult(dir, NOW)).toBeNull()
    expect(existsSync(file())).toBe(false)
  })

  it('throws away a result from more than a day ago, or dated more than a day ahead', () => {
    for (const offset of [-DEB_RESULT_MAX_AGE_MS - 60_000, DEB_RESULT_MAX_AGE_MS + 60_000]) {
      write({ code: 126, tailHex: '' })
      const at = (NOW + offset) / 1000
      utimesSync(file(), at, at)
      expect(takeDebInstallResult(dir, NOW), String(offset)).toBeNull()
      expect(existsSync(file())).toBe(false)
    }
    write({ code: 126, tailHex: '' })
    const recent = (NOW - DEB_RESULT_MAX_AGE_MS + 60_000) / 1000
    utimesSync(file(), recent, recent)
    expect(takeDebInstallResult(dir, NOW)?.code).toBe(126)
  })

  it('reads the clock by default', () => {
    write({ code: 0, tailHex: '' })
    expect(takeDebInstallResult(dir)?.code).toBe(0)
  })

  it('leaves a folder at the result path alone', () => {
    mkdirSync(file())
    expect(takeDebInstallResult(dir, NOW)).toBeNull()
    expect(statSync(file()).isDirectory()).toBe(true)
  })

  it.runIf(posixOnly)('removes a symlink at the result path without reading or touching its target', () => {
    writeFileSync(join(dir, 'other'), JSON.stringify({ code: 126, tailHex: '' }))
    symlinkSync(join(dir, 'other'), file())
    expect(takeDebInstallResult(dir, NOW)).toBeNull()
    expect(existsSync(file())).toBe(false)
    expect(readFileSync(join(dir, 'other'), 'utf8')).toContain('126')
  })
})

describe('debErrorDetail', () => {
  it("picks dpkg's own error out of the log tail, continuation lines and all", () => {
    const tail = [
      `termpolis-deb-update: installing ${DEB}`,
      '(Reading database ... 198004 files and directories currently installed.)',
      `dpkg: error processing archive ${DEB} (--install):`,
      ` cannot access archive '${DEB}': No such file or directory`,
      'Errors were encountered while processing:',
      ` ${DEB}`,
      'Reading package lists...',
      '0 upgraded, 0 newly installed, 0 to remove and 4 not upgraded.',
    ].join('\n')
    expect(debErrorDetail(tail)).toBe(
      `dpkg: error processing archive ${DEB} (--install): cannot access archive '${DEB}': No such file or directory`,
    )
  })

  it('takes the first error, the cause, over what apt-get then says about it', () => {
    const tail = [
      "dpkg-deb: error: 'x.deb' is not a Debian format archive",
      'dpkg: error processing archive x.deb (--install):',
      ' dpkg-deb --control subprocess returned error exit status 2',
      'E: Unable to correct problems, you have held broken packages.',
      '',
    ].join('\r\n')
    expect(debErrorDetail(tail)).toBe("dpkg-deb: error: 'x.deb' is not a Debian format archive")
  })

  it("knows apt's, sudo's, the askpass helper's, pkexec's and the shell's words too", () => {
    expect(debErrorDetail('N: x\nE: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4321 (unattended-upgr)\n'))
      .toBe('E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4321 (unattended-upgr)')
    expect(debErrorDetail('sudo: no password was provided\n')).toBe('sudo: no password was provided')
    expect(debErrorDetail('termpolis-askpass: no password dialog is installed (zenity, kdialog or ssh-askpass).\nRun the command yourself.'))
      .toBe('termpolis-askpass: no password dialog is installed (zenity, kdialog or ssh-askpass).')
    expect(debErrorDetail('Error executing command as another user: Not authorized\n')).toBe('Error executing command as another user: Not authorized')
    expect(debErrorDetail('sh: 1: dpkg: not found\n')).toBe('sh: 1: dpkg: not found')
    expect(debErrorDetail('dpkg: dependency problems prevent configuration of termpolis:\n termpolis depends on libnss3.\n'))
      .toBe('dpkg: dependency problems prevent configuration of termpolis: termpolis depends on libnss3.')
  })

  it("shows the runner's own error without its prefix", () => {
    expect(debErrorDetail(`${DEB_RUNNER_NAME}: error: The downloaded update is no longer there: ${DEB}\n`))
      .toBe(`The downloaded update is no longer there: ${DEB}`)
  })

  it('falls back to the last line that says anything, and to nothing', () => {
    expect(debErrorDetail('first\nsomething went wrong  \n\n  \n')).toBe('something went wrong')
    expect(debErrorDetail('')).toBe('')
    expect(debErrorDetail('\n \n')).toBe('')
  })

  it('can be held to a line that says why, with no last line in its place', () => {
    // After a clean dpkg run, the last line is a trigger, not a reason.
    const clean = 'Setting up termpolis (1.54.1~test) ...\nProcessing triggers for desktop-file-utils (0.27-2build1) ...\n'
    expect(debErrorDetail(clean, false)).toBe('')
    expect(debErrorDetail(`${clean}E: boom\n`, false)).toBe('E: boom')
  })

  it('collapses whitespace and cuts a long error short', () => {
    expect(debErrorDetail('E:   a\t\tb')).toBe('E: a b')
    const long = debErrorDetail(`E: ${'x'.repeat(1000)}`)
    expect(long.length).toBe(300)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('debInstallNotice', () => {
  const LOG = '/home/d/.config/termpolis/update-install.log'
  const result = (over: Partial<DebInstallResult> = {}): DebInstallResult => ({
    code: 0, tail: '', from: '1.54.0', target: '1.54.1', deb: DEB, how: 'pkexec', ...over,
  })

  it('says nothing once the new version is the one running', () => {
    expect(debInstallNotice(result(), '1.54.1', LOG)).toBeNull()
    // pkexec's own refusals: the install never ran, so it went in some other way.
    expect(debInstallNotice(result({ code: PKEXEC_DISMISSED }), '1.54.1', LOG)).toBeNull()
    expect(debInstallNotice(result({ code: PKEXEC_NOT_AUTHORIZED }), '1.54.1', LOG)).toBeNull()
  })

  it('says the update went in but the installer reported a problem, when the new version runs after an error', () => {
    // dpkg unpacked the new files, then left the package half-configured, and apt-get -f couldn't
    // finish it: Termpolis 1.54.1 starts, and the package system still needs fixing.
    const tail = [
      'Setting up termpolis (1.54.1) ...',
      'dpkg: error processing package termpolis (--configure):',
      ' installed termpolis package post-installation script subprocess returned error exit status 1',
      'E: Sub-process /usr/bin/dpkg returned an error code (1)',
    ].join('\n')
    expect(debInstallNotice(result({ code: 100, tail }), '1.54.1', LOG)).toEqual({
      kind: 'incomplete',
      message: debIncompleteMessage(
        'dpkg: error processing package termpolis (--configure): installed termpolis package post-installation script subprocess returned error exit status 1',
        100, LOG, '1.54.1',
      ),
    })
  })

  it('says nothing about a result from an older run: Termpolis has changed since', () => {
    expect(debInstallNotice(result({ code: 126 }), '1.55.0', LOG)).toBeNull()
  })

  it('says nothing for a success it has no version to check against', () => {
    expect(debInstallNotice(result({ target: undefined }), '1.54.0', LOG)).toBeNull()
  })

  it('says the prompt was cancelled for pkexec 126, which Restart can try again', () => {
    expect(debInstallNotice(result({ code: PKEXEC_DISMISSED }), '1.54.0', LOG)).toEqual({ kind: 'cancelled', message: DEB_CANCELLED_MESSAGE })
    expect(DEB_CANCELLED_MESSAGE).toBe('Update not installed: the administrator prompt was cancelled.')
  })

  it('gives the command to run by hand for pkexec 127, or when there was no authentication agent', () => {
    const manual = { kind: 'manual', message: debManualInstallMessage(DEB) }
    expect(debInstallNotice(result({ code: PKEXEC_NOT_AUTHORIZED }), '1.54.0', LOG, PENDING)).toEqual(manual)
    const noAgent = result({ code: 1, tail: 'Error executing command as another user: No authentication agent found.\n' })
    expect(debInstallNotice(noAgent, '1.54.0', LOG, PENDING)).toEqual(manual)
  })

  it('names in that command only a .deb that electron-updater could have downloaded', () => {
    // Any program running as the user can write the result: the banner must not become its way to
    // have the user run sudo apt install on a package of its choosing.
    for (const deb of [
      '/tmp/.x/termpolis_1.54.1_amd64.deb',
      `${PENDING}/evil.deb`,
      `${PENDING}/termpolis_1.54.1_amd64.rpm`,
      `${PENDING}/sub/termpolis_1.54.1_amd64.deb`,
      `${PENDING}/../termpolis_1.54.1_amd64.deb`,
      `${PENDING}/termpolis_1.54.1\n_amd64.deb`,
      `${PENDING}/termpolis_1.54.1\u001b[2K_amd64.deb`,
      `${PENDING}/termpolis_1.54.1\u007f_amd64.deb`,
    ]) {
      expect(debInstallNotice(result({ code: PKEXEC_NOT_AUTHORIZED, deb }), '1.54.0', LOG, PENDING), JSON.stringify(deb)).toEqual({
        kind: 'manual',
        message: debManualInstallMessage(undefined),
      })
    }
  })

  it("looks for electron-updater's download folder where electron-updater puts it", () => {
    // getAppCacheDir: XDG_CACHE_HOME, else ~/.cache; then app-update.yml's updaterCacheDirName.
    expect(debPendingDir({}, '/home/d')).toBe(PENDING)
    expect(debPendingDir({ XDG_CACHE_HOME: '/var/cache/d' }, '/home/d')).toBe('/var/cache/d/termpolis-updater/pending')
    expect(debPendingDir()).toBe(posix.join(process.env.XDG_CACHE_HOME || posix.join(homedir(), '.cache'), 'termpolis-updater', 'pending'))
    // By default, this process's: a result naming a .deb elsewhere gives the release page.
    const elsewhere = '/nowhere/termpolis-updater/pending/termpolis_1.54.1_amd64.deb'
    expect(debInstallNotice(result({ code: PKEXEC_NOT_AUTHORIZED, deb: elsewhere }), '1.54.0', LOG)?.message).toBe(debManualInstallMessage(undefined))
  })

  it("gives dpkg's error for anything else", () => {
    const tail = 'dpkg: error: dpkg frontend lock was locked by another process with pid 4321\nNote: removing the lock file is always wrong\n'
    expect(debInstallNotice(result({ code: 100, tail }), '1.54.0', LOG)).toEqual({
      kind: 'failed',
      message: debFailedMessage('dpkg: error: dpkg frontend lock was locked by another process with pid 4321', 100, LOG),
    })
  })

  it('reports a 0 that installed nothing: dpkg failed and apt-get -f had nothing to fix', () => {
    const tail = `dpkg-deb: error: '${DEB}' is not a Debian format archive\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n`
    expect(debInstallNotice(result({ code: 0, tail }), '1.54.0', LOG)?.message).toBe(
      debFailedMessage(`dpkg-deb: error: '${DEB}' is not a Debian format archive`, 0, LOG),
    )
  })

  it("never takes a clean dpkg run's last line for the error of a 0 that left the version as it was", () => {
    // A package that installed cleanly but still says 1.54.0: dpkg's last words are a trigger.
    const tail = 'Setting up termpolis (1.54.1~test) ...\nProcessing triggers for desktop-file-utils (0.27-2build1) ...\n'
    expect(debInstallNotice(result({ code: 0, target: '1.54.1-test', tail }), '1.54.0', LOG)).toEqual({
      kind: 'failed',
      message: 'Update not installed: the installer finished without installing it (full output: /home/d/.config/termpolis/update-install.log).',
    })
  })

  it("reads sudo's 126 and 127 as any other failure: only pkexec's are its own", () => {
    for (const code of [126, 127]) {
      const notice = debInstallNotice(result({ code, how: 'sudo', tail: 'sudo: 3 incorrect password attempts' }), '1.54.0', LOG)
      expect(notice).toEqual({ kind: 'failed', message: debFailedMessage('sudo: 3 incorrect password attempts', code, LOG) })
    }
  })

  it('reads a sudo -A prompt that was cancelled, and one with no dialog to ask through, by what they said', () => {
    // Cancelling the askpass dialog gives sudo an empty answer; sudo exits 1.
    const cancelled = result({ code: 1, how: 'sudo', tail: 'sudo: no password was provided\nsudo: a password is required\n' })
    expect(debInstallNotice(cancelled, '1.54.0', LOG)).toEqual({ kind: 'cancelled', message: DEB_CANCELLED_MESSAGE })
    // Termpolis's helper found no zenity, kdialog or ssh-askpass: Restart can't work here.
    const noDialog = result({
      code: 1,
      how: 'sudo',
      tail: 'termpolis-askpass: no password dialog is installed (zenity, kdialog or ssh-askpass).\nRun the command yourself in a Termpolis terminal instead.\nsudo: no password was provided\n',
    })
    expect(debInstallNotice(noDialog, '1.54.0', LOG, PENDING)).toEqual({ kind: 'manual', message: debManualInstallMessage(DEB) })
    // The same words from pkexec's command, or after a success, mean nothing of the kind.
    expect(debInstallNotice(result({ code: 1, tail: cancelled.tail }), '1.54.0', LOG)?.kind).toBe('failed')
    expect(debInstallNotice(result({ code: 0, how: 'sudo', tail: cancelled.tail }), '1.54.1', LOG)).toBeNull()
  })

  it('works without the details an older or damaged result lacks', () => {
    expect(debInstallNotice({ code: 126, tail: '' }, '1.54.0', LOG)).toEqual({ kind: 'cancelled', message: DEB_CANCELLED_MESSAGE })
    expect(debInstallNotice({ code: 127, tail: '' }, '1.54.0', LOG)?.message).toBe(debManualInstallMessage(undefined))
  })
})

describe('readDebInstallNotice', () => {
  it("takes the result and says what became of the install, naming the log in userData", () => {
    writeFileSync(join(dir, DEB_RESULT_FILE), JSON.stringify({ info: { from: '1.54.0', target: '1.54.1' }, code: 100, tailHex: hex('E: boom\n') }))
    expect(readDebInstallNotice(dir, '1.54.0')).toEqual({ kind: 'failed', message: debFailedMessage('E: boom', 100, join(dir, DEB_LOG_FILE)) })
    expect(existsSync(join(dir, DEB_RESULT_FILE))).toBe(false)
    expect(readDebInstallNotice(dir, '1.54.0')).toBeNull()
  })

  /** A log whose first error, dpkg's, comes before 400 lines of apt-get: more than the tail keeps. */
  const longLog = () => [
    `termpolis-deb-update: installing ${DEB}`,
    `dpkg: error processing archive ${DEB} (--install):`,
    ' failed to write (No space left on device)',
    'The following packages were automatically installed and are no longer required:',
    ...Array.from({ length: 400 }, (_, i) => `  libno-longer-needed-${i}`),
    'Use \'sudo apt autoremove\' to remove them.',
    '0 upgraded, 0 newly installed, 0 to remove and 57 not upgraded.',
    '',
  ].join('\n')

  it("finds dpkg's error in the whole log when apt-get's output pushed it out of the result's tail", () => {
    const log = longLog()
    const tail = Buffer.from(log).subarray(-DEB_TAIL_BYTES).toString('utf8')
    expect(tail).not.toContain('dpkg: error')
    writeFileSync(join(dir, DEB_LOG_FILE), log)
    writeFileSync(join(dir, DEB_RESULT_FILE), JSON.stringify({ info: { from: '1.54.0', target: '1.54.1' }, code: 100, tailHex: hex(tail) }))
    expect(readDebInstallNotice(dir, '1.54.0')).toEqual({
      kind: 'failed',
      message: debFailedMessage(`dpkg: error processing archive ${DEB} (--install): failed to write (No space left on device)`, 100, join(dir, DEB_LOG_FILE)),
    })
  })

  it('falls back to the tail when the log is gone, empty, or too big to read', () => {
    const tail = 'E: from the tail\n'
    const expected = { kind: 'failed', message: debFailedMessage('E: from the tail', 100, join(dir, DEB_LOG_FILE)) }
    for (const log of [null, '', `E: from the log\n${'x'.repeat(DEB_LOG_MAX_BYTES)}`]) {
      rmSync(join(dir, DEB_LOG_FILE), { force: true })
      if (log !== null) writeFileSync(join(dir, DEB_LOG_FILE), log)
      writeFileSync(join(dir, DEB_RESULT_FILE), JSON.stringify({ info: { from: '1.54.0', target: '1.54.1' }, code: 100, tailHex: hex(tail) }))
      expect(readDebInstallNotice(dir, '1.54.0'), String(log?.length)).toEqual(expected)
    }
  })
})

describe('the messages', () => {
  it('quotes the .deb for the shell only when it has to', () => {
    expect(debManualInstallMessage(DEB)).toBe(
      "Update not installed: Termpolis couldn't get administrator rights to install it. " +
        `To install it, run this in a terminal, then restart Termpolis: sudo apt install ${DEB}`,
    )
    expect(debManualInstallMessage("/home/o'neil/my files/t.deb")).toContain(`sudo apt install '/home/o'\\''neil/my files/t.deb'`)
    expect(debManualInstallMessage('/tmp/$x`id`.deb')).toContain("sudo apt install '/tmp/$x`id`.deb'")
  })

  it('points at the release page when it has no .deb to name', () => {
    expect(debManualInstallMessage(undefined)).toContain('https://github.com/codedev-david/termpolis/releases/latest')
    expect(debManualInstallMessage(undefined)).toContain('sudo apt install')
  })

  it('says why the user is given a command: no administrator rights, or an installer that never started', () => {
    expect(debManualInstallMessage(DEB)).toBe(`${DEB_NO_RIGHTS_LEAD} To install it, run this in a terminal, then restart Termpolis: sudo apt install ${DEB}`)
    expect(debManualInstallMessage(DEB, DEB_NOT_STARTED_LEAD)).toBe(
      "Update not installed: Termpolis couldn't start the installer. " +
        `To install it, run this in a terminal, then restart Termpolis: sudo apt install ${DEB}`,
    )
  })

  it("names dpkg's error and where the full output is", () => {
    expect(debFailedMessage('E: broken', 100, '/l')).toBe('Update not installed. E: broken (full output: /l)')
    expect(debFailedMessage('', 100, '/l')).toBe('Update not installed: the installer exited with code 100 (full output: /l).')
    expect(debFailedMessage('', 0, '/l')).toBe('Update not installed: the installer finished without installing it (full output: /l).')
  })

  it('says an update that went in with an error went in, and what the error was', () => {
    expect(debIncompleteMessage('E: broken', 100, '/l', '1.54.1')).toBe(
      'Termpolis 1.54.1 is installed, but the installer reported a problem. E: broken (full output: /l)',
    )
    expect(debIncompleteMessage('', 100, '/l', '1.54.1')).toBe(
      'Termpolis 1.54.1 is installed, but the installer exited with code 100 (full output: /l).',
    )
  })

  it('says an update is already being installed, and what to do once it has', () => {
    expect(DEB_BUSY_MESSAGE).toMatch(/already being installed.*quit Termpolis and open it again/)
  })
})
