// @vitest-environment node
// debUpdate.ts's runner (DEB_INSTALL_SCRIPT), run for real by a POSIX sh: /bin/sh (dash on
// Ubuntu), or the sh that Git for Windows ships. pkexec, sudo, dpkg and apt-get are stubs on PATH
// that log what they were asked to do, and "Termpolis" is a stub that writes down how it was
// started. So nothing here asks for a password, installs anything or starts Electron: the runner is
// given the command line debInstallCommand builds, and this file checks what it does with it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'child_process'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, dirname, join } from 'path'
import {
  DEB_CANCELLED_MESSAGE,
  DEB_LOG_FILE,
  DEB_RESULT_FILE,
  DEB_RUNNER_FILE,
  DEB_TAIL_BYTES,
  debFailedMessage,
  debIncompleteMessage,
  debInstallCommand,
  debInstallNotice,
  debManualInstallMessage,
  takeDebInstallResult,
  type DebTool,
} from '../../src/main/debUpdate'
import type { RelaunchTarget } from '../../src/main/noNewPrivs'

const win = process.platform === 'win32'

/** A POSIX sh: /bin/sh, or on Windows Git's, found next to the tools it needs (env, od, tail). */
function findSh(): string | null {
  if (!win) return existsSync('/bin/sh') ? '/bin/sh' : null
  for (const dir of ['C:\\Program Files\\Git\\usr\\bin', ...(process.env.PATH ?? '').split(';')]) {
    if (dir && existsSync(join(dir, 'sh.exe')) && existsSync(join(dir, 'env.exe'))) return join(dir, 'sh.exe')
  }
  return null
}

const SH = findSh()
/** On Windows, the folder of Git's POSIX tools, put first on PATH. */
const TOOLS = SH && win ? dirname(SH) : null

/** A path as the script sees it. On Windows that is /c/Users/... */
function shPath(p: string): string {
  return win ? p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`) : p
}

/** A word the stubs' shell reads back as itself. */
const q = (p: string) => `'${shPath(p).replace(/'/g, `'\\''`)}'`

describe.skipIf(!SH)('the .deb update runner, run by sh', () => {
  let t: string
  let bin: string
  let ud: string
  let debFile: string
  let program: string

  /** Every stub's call, one line each: the stub's name, then each argument in brackets. */
  const calls = (): string[] => {
    const f = join(t, 'calls.txt')
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []
  }
  /** How the Termpolis stub was started: its arguments, and SUDO_ASKPASS. Null if it never was. */
  const started = (): string[] | null => {
    const f = join(t, 'out.txt')
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : null
  }
  const log = () => readFileSync(join(ud, DEB_LOG_FILE), 'utf8')

  function stub(file: string, lines: string[]): void {
    mkdirSync(dirname(file), { recursive: true })
    const body = lines.join('\n')
      .replace(/@CALLS@/g, q(join(t, 'calls.txt')))
      .replace(/@OUT@/g, q(join(t, 'out.txt')))
      .replace(/@ENV@/g, q(join(t, 'env.txt')))
    writeFileSync(file, `#!/bin/sh\n${body}\n`)
    chmodSync(file, 0o755)
  }

  /** Records `name [arg] [arg]…` to the calls file. */
  const record = (name: string) => [
    `printf '%s' '${name}' >>@CALLS@`,
    'for a in "$@"; do printf \' [%s]\' "$a" >>@CALLS@; done',
    'echo >>@CALLS@',
  ]

  /** This process's environment, less anything that would steer the stubs, with the stubs first on PATH. */
  function baseEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (!/^path$/i.test(k) && !/^TP_/.test(k) && k !== 'SUDO_ASKPASS') env[k] = v
    }
    env.PATH = [bin, TOOLS, process.env.PATH].filter(Boolean).join(delimiter)
    return env
  }

  beforeEach(() => {
    t = mkdtempSync(join(tmpdir(), 'deb-runner-'))
    bin = join(t, 'bin')
    ud = join(t, 'userData')
    mkdirSync(ud, { recursive: true })
    debFile = join(t, 'cache', 'termpolis_1.54.1_amd64.deb')
    mkdirSync(dirname(debFile), { recursive: true })
    writeFileSync(debFile, '!<arch>\n')
    program = join(t, 'app', 'termpolis')
    stub(join(bin, 'pkexec'), [
      ...record('pkexec'),
      '[ "$1" = --disable-internal-agent ] || exit 99',
      'shift',
      'case "$TP_PKEXEC" in',
      "  dismissed) echo 'Error executing command as another user: Request dismissed' >&2; exit 126 ;;",
      "  noagent) echo 'Error executing command as another user: No authentication agent found.' >&2; exit 127 ;;",
      'esac',
      'exec "$@"',
    ])
    stub(join(bin, 'sudo'), [
      'printf \'sudo askpass=%s\' "${SUDO_ASKPASS-unset}" >>@CALLS@',
      'for a in "$@"; do printf \' [%s]\' "$a" >>@CALLS@; done',
      'echo >>@CALLS@',
      '[ "$1" = -A ] || exit 99',
      'shift',
      'exec "$@"',
    ])
    stub(join(bin, 'dpkg'), [
      ...record('dpkg'),
      'case "$TP_DPKG" in',
      '  fail)',
      '    echo "dpkg: error processing archive $2 (--install):" >&2',
      "    echo ' dependency problems - leaving unconfigured' >&2",
      '    exit 1 ;;',
      '  noisy)',
      "    awk 'BEGIN { for (i = 1; i <= 10000; i++) print \"line \" i }'",
      String.raw`    printf '"quoted" back\\slash tab\there ctl\001\002 caf\303\251\n'`,
      "    echo 'dpkg: error: the last words' >&2",
      '    exit 1 ;;',
      'esac',
      "echo 'Unpacking termpolis (1.54.1) over (1.54.0) ...'",
    ])
    stub(join(bin, 'apt-get'), [
      ...record('apt-get'),
      // What apt-get install -f -y does when the only fix it finds is to remove what needs the
      // missing dependency: it removes it, without asking, and exits 0.
      'if [ "$TP_APT" = remove ]; then',
      '  case " $* " in',
      "    *' --no-remove '*) echo 'E: Packages need to be removed but remove is disabled.' >&2; exit 100 ;;",
      '  esac',
      "  echo 'The following packages will be REMOVED:'",
      `  rm -f ${q(program)}`,
      '  exit 0',
      'fi',
      'exit "${TP_APT:-0}"',
    ])
    stub(program, [
      '{',
      '  echo started',
      '  for a in "$@"; do printf \'[%s]\\n\' "$a"; done',
      '  printf \'askpass=%s\\n\' "${SUDO_ASKPASS-unset}"',
      '} >@OUT@',
      'env >@ENV@',
      "echo 'termpolis printed this'",
    ])
  })
  afterEach(() => rmSync(t, { recursive: true, force: true }))

  /** The runner, started with the command line Restart builds, its output going to the log as
   *  startDebInstall arranges. The old Termpolis is a pid that is already gone unless given.
   *  `targetEnv` is the environment debInstallCommand is given; `script` changes the script. */
  function run(over: {
    tool?: 'pkexec' | 'sudo'
    deb?: string
    env?: NodeJS.ProcessEnv
    pid?: number
    targetEnv?: NodeJS.ProcessEnv
    script?: (script: string) => string
  } = {}) {
    const tool: DebTool = over.tool === 'sudo'
      ? { how: 'sudo', path: shPath(join(bin, 'sudo')), askpass: '/opt/askpass helper' }
      : { how: 'pkexec', path: shPath(join(bin, 'pkexec')) }
    const files = { log: shPath(join(ud, DEB_LOG_FILE)), result: shPath(join(ud, DEB_RESULT_FILE)), runner: shPath(join(ud, DEB_RUNNER_FILE)) }
    writeFileSync(join(ud, DEB_RUNNER_FILE), '4242')
    const target: RelaunchTarget = { pid: over.pid ?? 999999999, execPath: shPath(program), argv: ['termpolis', 'a b', '--flag'], env: over.targetEnv ?? {} }
    const [cmd, ...args] = debInstallCommand(target, { deb: over.deb ?? shPath(debFile), from: '1.54.0', target: '1.54.1' }, tool, files)
    expect(cmd).toBe('/bin/sh')
    if (over.script) {
      const script = over.script(args[1])
      expect(script).not.toBe(args[1])
      args[1] = script
    }
    const fd = openSync(join(ud, DEB_LOG_FILE), 'w')
    try {
      return spawnSync(SH!, args, { env: { ...baseEnv(), ...over.env }, stdio: ['ignore', fd, fd], timeout: 60_000 })
    } finally {
      closeSync(fd)
    }
  }

  const INSTALL = '[/bin/sh] [-c] [dpkg -i "$1" || apt-get install -f -y --no-remove] [sh]'

  it('installs with one pkexec, then starts Termpolis with the same arguments, and leaves only its result', () => {
    expect(run().status).toBe(0)
    const deb = shPath(debFile)
    expect(calls()).toEqual([`pkexec [--disable-internal-agent] ${INSTALL} [${deb}]`, `dpkg [-i] [${deb}]`])
    expect(started()).toEqual(['started', '[a b]', '[--flag]', 'askpass=unset'])
    expect(takeDebInstallResult(ud)).toEqual({
      code: 0,
      tail: `termpolis-deb-update: installing ${deb}\nUnpacking termpolis (1.54.1) over (1.54.0) ...\n`,
      from: '1.54.0',
      target: '1.54.1',
      deb,
      how: 'pkexec',
    })
    // Termpolis's own output goes where a launch from the applications menu sends it, not the log.
    expect(log()).not.toContain('termpolis printed this')
    // The runner file is gone, and no temporary file was left behind.
    expect(readdirSync(ud).sort()).toEqual([DEB_LOG_FILE])
  })

  it('runs apt-get install -f -y inside the same command when dpkg fails, and reports its code', () => {
    expect(run({ env: { TP_DPKG: 'fail', TP_APT: '100' } }).status).toBe(0)
    const deb = shPath(debFile)
    expect(calls()).toEqual([
      `pkexec [--disable-internal-agent] ${INSTALL} [${deb}]`,
      `dpkg [-i] [${deb}]`,
      'apt-get [install] [-f] [-y] [--no-remove]',
    ])
    const result = takeDebInstallResult(ud)!
    expect(result.code).toBe(100)
    expect(started()).not.toBeNull()
    // What the next launch, still the old version, tells the user.
    expect(debInstallNotice(result, '1.54.0', '/log')).toEqual({
      kind: 'failed',
      message: debFailedMessage(`dpkg: error processing archive ${deb} (--install): dependency problems - leaving unconfigured`, 100, '/log'),
    })
  })

  it('reports 0 when apt-get -f completes what dpkg left unconfigured', () => {
    run({ env: { TP_DPKG: 'fail', TP_APT: '0' } })
    expect(calls()).toHaveLength(3)
    expect(takeDebInstallResult(ud)?.code).toBe(0)
  })

  it("leaves Termpolis installed when apt-get's only fix for what dpkg left unmet would remove it", () => {
    // dpkg has unpacked the new version and left it unconfigured, over a dependency nothing can
    // supply. apt-get install -f -y would remove Termpolis, without asking, and exit 0: nothing
    // would be left to start, or to say what happened.
    expect(run({ env: { TP_DPKG: 'fail', TP_APT: 'remove' } }).status).toBe(0)
    expect(calls()[2]).toBe('apt-get [install] [-f] [-y] [--no-remove]')
    expect(existsSync(program)).toBe(true)
    expect(started()).toEqual(['started', '[a b]', '[--flag]', 'askpass=unset'])
    const result = takeDebInstallResult(ud)!
    expect(result.code).toBe(100)
    // The new version starts, and says what is left to do.
    expect(debInstallNotice(result, '1.54.1', '/log')).toEqual({
      kind: 'incomplete',
      message: debIncompleteMessage(`dpkg: error processing archive ${shPath(debFile)} (--install): dependency problems - leaving unconfigured`, 100, '/log', '1.54.1'),
    })
  })

  it('installs nothing when the prompt is dismissed, and still starts Termpolis again', () => {
    expect(run({ env: { TP_PKEXEC: 'dismissed' } }).status).toBe(0)
    expect(calls()).toEqual([`pkexec [--disable-internal-agent] ${INSTALL} [${shPath(debFile)}]`])
    const result = takeDebInstallResult(ud)!
    expect(result.code).toBe(126)
    expect(result.tail).toContain('Request dismissed')
    expect(started()).toEqual(['started', '[a b]', '[--flag]', 'askpass=unset'])
    expect(debInstallNotice(result, '1.54.0', '/log')).toEqual({ kind: 'cancelled', message: DEB_CANCELLED_MESSAGE })
  })

  it('reports pkexec finding no authentication agent', () => {
    run({ env: { TP_PKEXEC: 'noagent' } })
    const result = takeDebInstallResult(ud)!
    expect(result.code).toBe(127)
    expect(result.tail).toContain('No authentication agent found.')
    expect(started()).not.toBeNull()
    expect(debInstallNotice(result, '1.54.0', '/log', shPath(join(t, 'cache')))).toEqual({ kind: 'manual', message: debManualInstallMessage(shPath(debFile)) })
  })

  it('asks through sudo -A with the askpass helper, which only sudo is given', () => {
    expect(run({ tool: 'sudo' }).status).toBe(0)
    const deb = shPath(debFile)
    expect(calls()).toEqual([`sudo askpass=/opt/askpass helper [-A] ${INSTALL} [${deb}]`, `dpkg [-i] [${deb}]`])
    expect(started()).toEqual(['started', '[a b]', '[--flag]', 'askpass=unset'])
    expect(takeDebInstallResult(ud)).toMatchObject({ code: 0, how: 'sudo' })
  })

  it('hands dpkg a .deb path with spaces, quotes, $, backticks and ; & as one argument', () => {
    // Windows forbids " in a file name; everywhere else it is in the name too.
    const name = `o'neil $HOME \`id\` (x);&${win ? '' : '"'}.deb`
    const deb = join(t, 'cache', name)
    writeFileSync(deb, '!<arch>\n')
    expect(run({ deb: shPath(deb) }).status).toBe(0)
    expect(calls()[1]).toBe(`dpkg [-i] [${shPath(deb)}]`)
    expect(takeDebInstallResult(ud)?.deb).toBe(shPath(deb))
  })

  it('asks for nothing when the downloaded .deb is gone, and says so', () => {
    const gone = shPath(join(t, 'cache', 'missing.deb'))
    expect(run({ deb: gone }).status).toBe(0)
    expect(calls()).toEqual([])
    const result = takeDebInstallResult(ud)!
    expect(result.code).toBe(1)
    expect(started()).not.toBeNull()
    expect(debInstallNotice(result, '1.54.0', '/log')?.message).toBe(
      debFailedMessage(`The downloaded update is no longer there: ${gone}`, 1, '/log'),
    )
  })

  it("keeps the end of the log, whatever bytes it holds, and the result stays small", () => {
    run({ env: { TP_DPKG: 'noisy', TP_APT: '100' } })
    const raw = readFileSync(join(ud, DEB_RESULT_FILE), 'utf8')
    expect(raw.length).toBeLessThan(2 * DEB_TAIL_BYTES + 1000)
    const result = takeDebInstallResult(ud)!
    expect(result.code).toBe(100)
    expect(Buffer.byteLength(result.tail)).toBe(DEB_TAIL_BYTES)
    expect(result.tail.endsWith('line 10000\n"quoted" back\\slash tab\there ctl\u0001\u0002 café\ndpkg: error: the last words\n')).toBe(true)
  })

  it.runIf(!win)('waits for the old Termpolis to exit before asking', () => {
    const old = spawn('sleep', ['1'], { stdio: 'ignore' })
    const at = Date.now()
    expect(run({ pid: old.pid }).status).toBe(0)
    expect(Date.now() - at).toBeGreaterThanOrEqual(700)
    expect(calls()).toHaveLength(2)
  })

  it.runIf(!win)('says so, installs nothing, and still starts Termpolis when the old one is still running two minutes on', () => {
    // Five looks instead of 600, so the wait gives up in about a second rather than two minutes.
    const old = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      expect(run({ pid: old.pid, script: (s) => s.split('-gt 600').join('-gt 5') }).status).toBe(0)
      expect(calls()).toEqual([])
      const result = takeDebInstallResult(ud)!
      expect(result.code).toBe(1)
      const why = 'Termpolis was still running two minutes after Restart, so nothing was installed'
      expect(result.tail).toBe(`termpolis-deb-update: error: ${why}\n`)
      expect(debInstallNotice(result, '1.54.0', '/log')?.message).toBe(debFailedMessage(why, 1, '/log'))
      // The runner file goes, so no later Restart takes this for an install still at work. The
      // Termpolis it starts hands over to the old one, through the single-instance lock, if that
      // is still running.
      expect(readdirSync(ud).sort()).toEqual([DEB_LOG_FILE])
      expect(started()).toEqual(['started', '[a b]', '[--flag]', 'askpass=unset'])
    } finally {
      old.kill()
    }
  })

  it('leaves the environment the new Termpolis inherits as it found it, the names the runner uses among it', () => {
    // In sh, assigning to a name the environment exports changes it for whatever is started
    // afterwards; the runner works in a subshell, so its names never reach Termpolis. (Windows
    // can't tell tmp from TMP, which the environment here already has.)
    const names = ['pid', 'deb', 'log', 'result', 'info', 'how', 'tool', 'askpass', 'runner', 'i', 'install', 'code', ...(win ? [] : ['tmp'])]
    expect(run({ env: Object.fromEntries(names.map((n) => [n, `the user's ${n}`])) }).status).toBe(0)
    expect(calls()).toHaveLength(2)
    expect(takeDebInstallResult(ud)?.code).toBe(0)
    const env = readFileSync(join(t, 'env.txt'), 'utf8').split('\n')
    for (const n of names) expect(env, n).toContain(`${n}=the user's ${n}`)
  })

  it('starts the program it installed, whatever APPIMAGE this Termpolis inherited', () => {
    // A .deb Termpolis started from the terminal of an editor shipped as an AppImage.
    expect(run({ targetEnv: { APPIMAGE: shPath(join(t, 'Editor.AppImage')) } }).status).toBe(0)
    expect(started()).toEqual(['started', '[a b]', '[--flag]', 'askpass=unset'])
  })

  it.runIf(!win)('replaces a symlink planted at the result path instead of writing through it', () => {
    const victim = join(t, 'victim')
    writeFileSync(victim, 'keep')
    symlinkSync(victim, join(ud, DEB_RESULT_FILE))
    run()
    expect(readFileSync(victim, 'utf8')).toBe('keep')
    expect(lstatSync(join(ud, DEB_RESULT_FILE)).isFile()).toBe(true)
    expect(takeDebInstallResult(ud)?.code).toBe(0)
  })

  it('moves nothing into a folder at the result path', () => {
    // mv would move the result INTO it, where no launch ever reads it.
    mkdirSync(join(ud, DEB_RESULT_FILE))
    expect(run().status).toBe(0)
    expect(readdirSync(join(ud, DEB_RESULT_FILE))).toEqual([])
    expect(readdirSync(ud).sort()).toEqual([DEB_LOG_FILE, DEB_RESULT_FILE])
    expect(started()).not.toBeNull()
  })

  it.runIf(!win)('moves nothing into the folder a symlink at the result path points to', () => {
    const elsewhere = join(t, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(ud, DEB_RESULT_FILE))
    expect(run().status).toBe(0)
    expect(readdirSync(elsewhere)).toEqual([])
    expect(lstatSync(join(ud, DEB_RESULT_FILE)).isSymbolicLink()).toBe(true)
    expect(started()).not.toBeNull()
  })
})
