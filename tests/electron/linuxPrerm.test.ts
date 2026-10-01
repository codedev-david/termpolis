// @vitest-environment node
// build/linux/before-remove.sh, the .deb's prerm, run for real by a POSIX sh: /bin/sh (dash on
// Ubuntu), or the sh that Git for Windows ships. TERMPOLIS_PRERM_ROOT moves /etc/passwd and
// /opt/Termpolis into a temp folder, and the app binary, runuser, su and getent are stubs that log
// what they were asked to do. So nothing here switches users, starts Electron or touches a real
// home folder: the disconnect itself is covered by disconnectAgentsCli.test.ts and
// disconnectAgentsBundle.test.ts, and this file covers who it runs for, how and when.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, dirname, join } from 'path'

const repo = join(__dirname, '../..')
const SCRIPT = join(repo, 'build/linux/before-remove.sh')
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const win = process.platform === 'win32'

/** A POSIX sh: /bin/sh, or on Windows Git's, found next to the tools it needs (env, cat, timeout). */
function findSh(): string | null {
  if (!win) return existsSync('/bin/sh') ? '/bin/sh' : null
  for (const dir of ['C:\\Program Files\\Git\\usr\\bin', ...(process.env.PATH ?? '').split(';')]) {
    if (dir && existsSync(join(dir, 'sh.exe')) && existsSync(join(dir, 'env.exe'))) return join(dir, 'sh.exe')
  }
  return null
}

const SH = findSh()
/** On Windows, the folder of Git's POSIX tools, put first on PATH so its `timeout` wins over Windows' own. */
const TOOLS = SH && win ? dirname(SH) : null

/** A path as the script sees it. On Windows that is /c/Users/..., since a home in passwd cannot hold a colon. */
function shPath(p: string): string {
  return win ? p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`) : p
}

/** This process's environment, less anything that would steer the script, with `binDir` first on PATH. */
function baseEnv(binDir: string | null): NodeJS.ProcessEnv {
  const steer = new Set(['SUDO_USER', 'PKEXEC_UID', 'DPKG_ROOT', 'TERMPOLIS_PRERM_ROOT', 'TERMPOLIS_PRERM_TIMEOUT'])
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^path$/i.test(k) && !steer.has(k)) env[k] = v
  }
  env.PATH = [binDir, TOOLS, process.env.PATH].filter(Boolean).join(delimiter)
  return env
}

/** Whether the script would find `name` on this machine without the stubs, on the PATH it builds. */
function onSystem(name: string): boolean {
  if (!SH) return false
  const probe = spawnSync(SH, ['-c', `PATH=$PATH:/usr/sbin:/usr/bin:/sbin:/bin; command -v ${name}`], { env: baseEnv(null) })
  return probe.status === 0
}

const HAS_RUNUSER = onSystem('runuser')
const HAS_SU = onSystem('su')
const HAS_TIMEOUT = onSystem('timeout')

describe('the .deb prerm, as packaged', () => {
  const text = readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n')

  it('is wired in through fpm as the package\'s prerm', () => {
    expect(pkg.build.deb.fpm).toEqual(['--before-remove', 'build/linux/before-remove.sh'])
    // electron-builder keeps its own after-remove script, so the prerm must not replace it.
    expect(pkg.build.deb.afterRemove).toBeUndefined()
  })

  it('looks for the app where electron-builder installs the .deb', () => {
    const exe = pkg.build.linux.executableName ?? pkg.build.executableName ?? pkg.name.toLowerCase()
    expect(text).toContain(`\napp=$root/opt/${pkg.build.productName}\n`)
    expect(text).toContain(`\nbin=$app/${exe}\n`)
  })

  it('runs the bundle that build.linux.extraResources ships next to the app', () => {
    expect(pkg.build.linux.extraResources).toContainEqual({ from: 'out/linux/disconnect-agents.cjs', to: 'disconnect-agents.cjs' })
    expect(text).toContain('\nscript=$app/resources/disconnect-agents.cjs\n')
  })

  it('is a /bin/sh script with LF line endings', () => {
    const raw = readFileSync(SCRIPT, 'utf8')
    expect(text.startsWith('#!/bin/sh\n')).toBe(true)
    // A Windows checkout may convert it to CRLF. The .deb is built on Linux, from an LF checkout,
    // and a CR there would reach the shebang and every line of the prerm.
    if (!win) expect(raw).not.toContain('\r')
  })
})

describe.skipIf(!SH)('the .deb prerm, run by sh', () => {
  let t: string
  let script: string

  const log = (): string[] => {
    const f = join(t, 'log.txt')
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []
  }
  /** Each run of the app as [USER, LOGNAME, HOME, ELECTRON_RUN_AS_NODE, TP_CANARY, args]. */
  const runs = (): string[][] => log().filter((l) => l.startsWith('run ')).map((l) => l.slice(4).split('|'))
  const users = (): string[] => runs().map((r) => r[0])
  const run = (user: string, home: string): string[] => [user, user, home, '1', 'unset', `${script} ${home}/.config/termpolis`]

  function stub(file: string, body: string): void {
    mkdirSync(dirname(file), { recursive: true })
    const text = body
      .replace(/@LOG@/g, `'${shPath(join(t, 'log.txt'))}'`)
      .replace(/@DAVE@/g, shPath(join(t, 'home', 'dave')))
    writeFileSync(file, `#!/bin/sh\n${text}`)
    chmodSync(file, 0o755)
  }

  /** A home folder in the fake root; with Termpolis's userData folder unless `userData` is false. */
  function home(user: string, userData = true): string {
    const dir = join(t, 'home', user)
    mkdirSync(userData ? join(dir, '.config', 'termpolis') : dir, { recursive: true })
    return shPath(dir)
  }

  function passwd(lines: string[], finalNewline = true): void {
    writeFileSync(join(t, 'root', 'etc', 'passwd'), lines.join('\n') + (finalNewline ? '\n' : ''))
  }

  /** Run the prerm as dpkg would, with `bin` (stubs) first on PATH. TP_CANARY stands for dpkg's environment. */
  function prerm(args: string[], extra: Record<string, string> = {}, bin = 'bin'): { status: number | null; stdout: string; stderr: string } {
    const env = { ...baseEnv(join(t, bin)), TP_CANARY: 'from-dpkg', TERMPOLIS_PRERM_ROOT: shPath(join(t, 'root')), ...extra }
    const r = spawnSync(SH as string, [shPath(join(t, 'prerm.sh')), ...args], { env, encoding: 'utf8', timeout: 50_000 })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  const stderrLines = (r: { stderr: string }): string[] => r.stderr.split('\n').filter(Boolean)

  beforeEach(() => {
    t = realpathSync.native(mkdtempSync(join(tmpdir(), 'termpolis-prerm-')))
    // The script as the .deb carries it: a Windows checkout may have given it CRLF.
    writeFileSync(join(t, 'prerm.sh'), readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n'))
    const app = join(t, 'root', 'opt', 'Termpolis')
    mkdirSync(join(app, 'resources'), { recursive: true })
    mkdirSync(join(t, 'root', 'etc'), { recursive: true })
    writeFileSync(join(app, 'resources', 'disconnect-agents.cjs'), '// stands in for the bundle\n')
    script = shPath(join(app, 'resources', 'disconnect-agents.cjs'))
    // The app. Its stdout must end up on the prerm's stderr, and `cat` would swallow the rest of
    // /etc/passwd if the prerm let it read the loop's stdin.
    stub(join(app, 'termpolis'), [
      `printf 'run %s|%s|%s|%s|%s|%s\\n' "\${USER-}" "\${LOGNAME-}" "\${HOME-}" "\${ELECTRON_RUN_AS_NODE-}" "\${TP_CANARY-unset}" "$*" >>@LOG@`,
      'echo "output of the run for ${USER-}"',
      'cat >/dev/null',
      'case ${USER-} in',
      '    carol) exit 3 ;;',
      '    slow) exec sleep 20 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'))
    const runuser = [
      '# runuser -u NAME -- COMMAND...: a test cannot switch users, so this logs and runs the command.',
      'if [ "$#" -lt 4 ] || [ "$1" != -u ] || [ "$3" != -- ]; then echo "runuser stub: $*" >&2; exit 98; fi',
      'printf \'runuser %s\\n\' "$2" >>@LOG@',
      'shift 3',
      'exec "$@"',
      '',
    ].join('\n')
    const su = [
      '# su -s SHELL -c COMMAND -- NAME ARG...: util-linux su runs SHELL -c COMMAND ARG... as NAME.',
      'if [ "$#" -lt 7 ] || [ "$1" != -s ] || [ "$3" != -c ] || [ "$5" != -- ]; then echo "su stub: $*" >&2; exit 97; fi',
      'printf \'su %s %s\\n\' "$6" "$2" >>@LOG@',
      'shell=$2',
      'cmd=$4',
      'shift 6',
      'exec "$shell" -c "$cmd" "$@"',
      '',
    ].join('\n')
    const getent = [
      '# dave is not in the fake /etc/passwd, like an LDAP account; 1234 is his uid.',
      '[ "$1" = passwd ] || exit 2',
      'case $2 in',
      "    dave|1234) echo 'dave:x:1234:1234:Dave:@DAVE@:/bin/sh' ;;",
      '    *) exit 2 ;;',
      'esac',
      '',
    ].join('\n')
    stub(join(t, 'bin', 'runuser'), runuser)
    stub(join(t, 'bin', 'su'), su)
    stub(join(t, 'bin', 'getent'), getent)
    stub(join(t, 'bin-su', 'su'), su)
    stub(join(t, 'bin-su', 'getent'), getent)
    stub(join(t, 'bin-none', 'getent'), getent)
  })

  afterEach(() => {
    // On Windows a timed-out run's `sleep` can outlive the test for a few seconds. A temp folder
    // left behind then is harmless, and failing the test over it would not be.
    try {
      rmSync(t, { recursive: true, force: true })
    } catch { /* still in use */ }
  })

  it('on `remove`, runs the disconnect as each user with a userData folder, and for no one else', { timeout: 60_000 }, () => {
    const alice = home('alice')
    const carol = home('carol')
    const frank = home('frank')
    passwd([
      `root:x:0:0:root:${home('root', false)}:/bin/bash`,
      `alice:x:1000:1000:Alice,,,:${alice}:/bin/bash`,
      `bob:x:1001:1001::${home('bob', false)}:/bin/bash`,
      `carol:x:1002:1002::${carol}:/bin/bash`,
      '+nisuser::::::',
      'erin:x:1003:1003::relative/erin:/bin/sh',
      // Each account, and each home folder, is done once.
      `alice:x:1000:1000:Alice,,,:${alice}:/bin/bash`,
      `alias:x:1000:1000::${alice}:/bin/bash`,
      // The last line has no newline after it, and a shell that cannot log in is no obstacle.
      `frank:x:1004:1004::${frank}:/usr/sbin/nologin`,
    ], false)

    const r = prerm(['remove'])

    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    // As that user, with a clean environment: nothing from dpkg's (TP_CANARY) gets through.
    expect(runs()).toEqual([run('alice', alice), run('carol', carol), run('frank', frank)])
    expect(log().filter((l) => l.startsWith('runuser '))).toEqual(['runuser alice', 'runuser carol', 'runuser frank'])
    // carol's run failed, and the removal went on regardless.
    expect(stderrLines(r)).toEqual([
      'termpolis prerm: disconnecting agents for alice',
      'output of the run for alice',
      'termpolis prerm: disconnecting agents for carol',
      'output of the run for carol',
      'termpolis prerm: disconnecting agents for carol failed (exit 3)',
      'termpolis prerm: disconnecting agents for frank',
      'output of the run for frank',
    ])
  })

  it('does nothing on an upgrade, the in-app updater included, or any other call', { timeout: 60_000 }, () => {
    passwd([`alice:x:1000:1000::${home('alice')}:/bin/sh`])
    for (const args of [
      ['upgrade', '1.50.0'],
      ['failed-upgrade', '1.49.0', '1.50.0'],
      ['deconfigure', 'in-favour', 'other', '1.0', 'removing', 'termpolis', '1.49.0'],
      [],
    ]) {
      expect(prerm(args)).toEqual({ status: 0, stdout: '', stderr: '' })
    }
    expect(log()).toEqual([])
  })

  it('disconnects on `remove in-favour`, when another package replaces this one', { timeout: 60_000 }, () => {
    const alice = home('alice')
    passwd([`alice:x:1000:1000::${alice}:/bin/sh`])
    expect(prerm(['remove', 'in-favour', 'termpolis-beta', '2.0.0']).status).toBe(0)
    expect(runs()).toEqual([run('alice', alice)])
  })

  it('also disconnects the account that ran sudo or pkexec, which may not be in /etc/passwd', { timeout: 60_000 }, () => {
    const alice = home('alice')
    const dave = home('dave')
    passwd([`alice:x:1000:1000::${alice}:/bin/sh`])
    // pkexec names dave by uid, and he is not done twice.
    expect(prerm(['remove'], { SUDO_USER: 'dave', PKEXEC_UID: '1234' }).status).toBe(0)
    expect(runs()).toEqual([run('alice', alice), run('dave', dave)])

    // An account getent does not know is passed over without a word.
    rmSync(join(t, 'log.txt'))
    passwd([])
    expect(prerm(['remove'], { SUDO_USER: 'ghost', PKEXEC_UID: '' })).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(log()).toEqual([])
  })

  it('leaves a chrootless dpkg (DPKG_ROOT) alone', { timeout: 60_000 }, () => {
    passwd([`alice:x:1000:1000::${home('alice')}:/bin/sh`])
    expect(prerm(['remove'], { DPKG_ROOT: '/target' })).toEqual({
      status: 0,
      stdout: '',
      stderr: 'termpolis prerm: DPKG_ROOT is set, so agents are not disconnected\n',
    })
    expect(log()).toEqual([])
  })

  it('says so, and still succeeds, when the app or its disconnect script is already gone', { timeout: 60_000 }, () => {
    passwd([`alice:x:1000:1000::${home('alice')}:/bin/sh`])
    const app = join(t, 'root', 'opt', 'Termpolis')

    rmSync(join(app, 'resources', 'disconnect-agents.cjs'))
    let r = prerm(['remove'])
    expect(r).toEqual({ status: 0, stdout: '', stderr: `termpolis prerm: ${script} is missing, so agents are not disconnected\n` })

    writeFileSync(join(app, 'resources', 'disconnect-agents.cjs'), '// back\n')
    rmSync(join(app, 'termpolis'))
    r = prerm(['remove'])
    expect(r).toEqual({
      status: 0,
      stdout: '',
      stderr: `termpolis prerm: ${shPath(join(app, 'termpolis'))} cannot be run, so agents are not disconnected\n`,
    })
    expect(log()).toEqual([])
  })

  // Only where the machine has no runuser of its own: the script appends /usr/sbin and /sbin to
  // PATH, so on Linux it finds util-linux's and never gets to su. Git's sh on Windows has neither.
  it.skipIf(HAS_RUNUSER)('falls back to su when there is no runuser', { timeout: 60_000 }, () => {
    const alice = home('alice')
    passwd([`alice:x:1000:1000::${alice}:/bin/bash`])
    expect(prerm(['remove'], {}, 'bin-su').status).toBe(0)
    expect(log().filter((l) => /^(su|runuser) /.test(l))).toEqual(['su alice /bin/sh'])
    expect(runs()).toEqual([run('alice', alice)])
  })

  it.skipIf(HAS_RUNUSER || HAS_SU)('skips a user, and says why, when there is neither runuser nor su', { timeout: 60_000 }, () => {
    passwd([`alice:x:1000:1000::${home('alice')}:/bin/sh`])
    const r = prerm(['remove'], {}, 'bin-none')
    expect(r.status).toBe(0)
    expect(stderrLines(r)).toEqual([
      'termpolis prerm: disconnecting agents for alice',
      'termpolis prerm: neither runuser nor su was found, so agents are not disconnected for alice',
    ])
    expect(log()).toEqual([])
  })

  // Not with Git's tools on Windows: there SIGTERM does not reach a process that an MSYS `exec`
  // started, so every run would sit out timeout's -k grace period, and that says nothing about Linux.
  it.skipIf(win || !HAS_TIMEOUT)('gives up on a disconnect that hangs, and goes on to the next user', { timeout: 60_000 }, () => {
    const alice = home('alice')
    passwd([`slow:x:1005:1005::${home('slow')}:/bin/sh`, `alice:x:1000:1000::${alice}:/bin/sh`])
    const r = prerm(['remove'], { TERMPOLIS_PRERM_TIMEOUT: '1' })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('termpolis prerm: disconnecting agents for slow timed out after 1s\n')
    expect(users()).toEqual(['slow', 'alice'])
  })
})
