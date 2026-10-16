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
    const body = lines.join('\n').replace(/@CALLS@/g, q(join(t, 'calls.txt'))).replace(/@OUT@/g, q(join(t, 'out.txt')))
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
    stub(join(bin, 'apt-get'), [...record('apt-get'), 'exit "${TP_APT:-0}"'])
    stub(program, [
      '{',
      '  echo started',
      '  for a in "$@"; do printf \'[%s]\\n\' "$a"; done',
      '  printf \'askpass=%s\\n\' "${SUDO_ASKPASS-unset}"',
      '} >@OUT@',
      "echo 'termpolis printed this'",
    ])
  })
  afterEach(() => rmSync(t, { recursive: true, force: true }))

  /** The runner, started with the command line Restart builds, its output going to the log as
   *  startDebInstall arranges. The old Termpolis is a pid that is already gone unless given. */
  function run(over: { tool?: 'pkexec' | 'sudo'; deb?: string; env?: NodeJS.ProcessEnv; pid?: number } = {}) {
    const tool: DebTool = over.tool === 'sudo'
      ? { how: 'sudo', path: shPath(join(bin, 'sudo')), askpass: '/opt/askpass helper' }
      : { how: 'pkexec', path: shPath(join(bin, 'pkexec')) }
    const files = { log: shPath(join(ud, DEB_LOG_FILE)), result: shPath(join(ud, DEB_RESULT_FILE)), runner: shPath(join(ud, DEB_RUNNER_FILE)) }
    writeFileSync(join(ud, DEB_RUNNER_FILE), '4242')
    const target: RelaunchTarget = { pid: over.pid ?? 999999999, execPath: shPath(program), argv: ['termpolis', 'a b', '--flag'], env: {} }
    const [cmd, ...args] = debInstallCommand(target, { deb: over.deb ?? shPath(debFile), from: '1.54.0', target: '1.54.1' }, tool, files)
    expect(cmd).toBe('/bin/sh')
    const fd = openSync(join(ud, DEB_LOG_FILE), 'w')
    try {
      return spawnSync(SH!, args, { env: { ...baseEnv(), ...over.env }, stdio: ['ignore', fd, fd], timeout: 60_000 })
    } finally {
      closeSync(fd)
    }
  }

  const INSTALL = '[/bin/sh] [-c] [dpkg -i "$1" || apt-get install -f -y] [sh]'

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
      'apt-get [install] [-f] [-y]',
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
    expect(debInstallNotice(result, '1.54.0', '/log')).toEqual({ kind: 'manual', message: debManualInstallMessage(shPath(debFile)) })
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
