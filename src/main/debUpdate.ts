// debUpdate.ts
//
// Installing a downloaded .deb update without freezing Termpolis.
//
// electron-updater installs a .deb from inside the app. Its quitAndInstall runs
// `pkexec … /bin/bash -c 'dpkg -i <deb>'` through spawnSync on the main process, which is the
// thread that draws the window, so the window can't repaint for as long as the administrator
// prompt is up and dpkg runs, and GNOME offers to Force Quit it. When dpkg fails (a cancelled
// prompt among the reasons) it asks a second time, for `apt-get install -f -y`. And with
// autoInstallOnAppQuit, an ordinary quit runs the same install from Electron's quit event, with
// the prompt appearing after the window has gone. Checked against electron-updater 6.8.9
// (BaseUpdater, LinuxUpdater, DebUpdater).
//
// So for a .deb, Restart hands the install to a runner outside Termpolis and quits at once. The
// runner is a detached /bin/sh started from the main process through child_process, so it doesn't
// have no_new_privs (noNewPrivs.ts). It waits for this Termpolis to exit; asks once, through
// pkexec, or through sudo -A and Termpolis's askpass helper where there is no pkexec, for ONE
// command that runs both of electron-updater's steps; writes the outcome to update-result.json in
// userData; and starts Termpolis again with the same arguments: the new version, or this one when
// nothing was installed. The next launch reads the result once and says what happened. A
// Termpolis opened by hand meanwhile says an update is being installed and closes again
// (autoUpdater.ts), and Restart never starts a second install: not while the runner is at work,
// nor once it has installed the update.
//
// The .deb is the file electron-updater downloaded, which it checked against the sha512 in
// latest-linux.yml when the download finished. Nothing checks it again before dpkg reads it, so a
// program running as the user could replace it in between, as it could under electron-updater's
// own install. Its path reaches the runner, and dpkg, as an argument, never as shell text. The
// runner writes only the user's own files in userData (the result, and the log through a
// descriptor Termpolis opened); only the install command runs as root.

import { spawn } from 'child_process'
import { accessSync, closeSync, constants, fstatSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, posix } from 'path'
import { WAIT_FOR_EXIT, WAIT_GAVE_UP, currentTarget, type RelaunchTarget } from './noNewPrivs'

/** The runner's $0: how a second Termpolis recognizes it in /proc, and the prefix of its lines in
 *  the log. */
export const DEB_RUNNER_NAME = 'termpolis-deb-update'

/** In userData. The log takes the install command's output; the result is what the next launch
 *  reads; the runner file holds the runner's pid while it runs. */
export const DEB_LOG_FILE = 'update-install.log'
export const DEB_RESULT_FILE = 'update-result.json'
export const DEB_RUNNER_FILE = 'update-install.pid'

/** electron-updater's two steps, `dpkg -i` and, when that fails, `apt-get install -f -y` for any
 *  dependency it left unmet, as one command, so they take one prompt. The .deb is $1. With
 *  --no-remove apt-get removes nothing: where its only fix is to remove a package, the Termpolis
 *  dpkg has just unpacked among them, it fails instead of removing it unasked. The new version
 *  then starts, dpkg having unpacked it, and says what is left to fix. */
export const DEB_INSTALL_COMMAND = 'dpkg -i "$1" || apt-get install -f -y --no-remove'

/** How much of the end of the log the result keeps. */
export const DEB_TAIL_BYTES = 6000

/** pkexec's own exit codes: the user dismissed the prompt; not authorized, no authentication
 *  agent, or some other failure to get authorization. */
export const PKEXEC_DISMISSED = 126
export const PKEXEC_NOT_AUTHORIZED = 127

/**
 * The runner. Its arguments: the pid to wait for, the .deb, the log, the result file, the result's
 * `info` (JSON, written as given), how it asks (pkexec, or sudo), the tool, the askpass helper
 * (sudo only), the runner file, and then the program and arguments that start Termpolis again.
 *
 * - Its work happens in a subshell. In sh, assigning to a name the environment exports changes it
 *   for whatever is started afterwards, so the shell that starts Termpolis again assigns nothing:
 *   a $log or $code of the user's own reaches Termpolis unchanged.
 * - It waits as the relaunch does (WAIT_FOR_EXIT). If the old Termpolis is still running two
 *   minutes on, it installs nothing and says so, in the log and the result, and still starts
 *   Termpolis, which hands over to the old copy through the single-instance lock if that is
 *   still running.
 * - The tool runs with LC_ALL=C, which pkexec and sudo pass on, so the log has dpkg's, apt-get's
 *   and their own errors in the words the next launch looks for, in any language. pkexec's prompt
 *   is the desktop's own, in the desktop's language.
 * - SUDO_ASKPASS goes to sudo alone, never into the Termpolis it starts.
 * - The result is written, readable by the user alone, to a temporary file it has just removed,
 *   under noclobber, then moved into place, which replaces whatever is at the result path rather
 *   than writing through it. noclobber refuses a regular file, or a dangling symlink, that appeared
 *   at the temporary name in between, though not a symlink to a FIFO or a device: only the user
 *   could plant one there, in their own folder, between the rm and the write. Not over a folder,
 *   or a symlink to one: mv would move the result into it. The log's tail goes in as hex, so no
 *   byte of it can break the JSON.
 * - Termpolis starts with no output to the log, as from the applications menu.
 */
export const DEB_INSTALL_SCRIPT = [
  '(',
  'pid=$1; deb=$2; log=$3; result=$4; info=$5; how=$6; tool=$7; askpass=$8; runner=$9',
  ...WAIT_FOR_EXIT,
  `install='${DEB_INSTALL_COMMAND}'`,
  `if ${WAIT_GAVE_UP}; then`,
  `  printf '${DEB_RUNNER_NAME}: error: Termpolis was still running two minutes after Restart, so nothing was installed\\n'`,
  '  code=1',
  'elif [ -f "$deb" ]; then',
  `  printf '${DEB_RUNNER_NAME}: installing %s\\n' "$deb"`,
  '  case $how in',
  '    pkexec) LC_ALL=C "$tool" --disable-internal-agent /bin/sh -c "$install" sh "$deb" ;;',
  '    *) LC_ALL=C SUDO_ASKPASS=$askpass "$tool" -A /bin/sh -c "$install" sh "$deb" ;;',
  '  esac',
  '  code=$?',
  'else',
  `  printf '${DEB_RUNNER_NAME}: error: The downloaded update is no longer there: %s\\n' "$deb"`,
  '  code=1',
  'fi',
  'tmp=$result.$$',
  'rm -f "$tmp"',
  'if (',
  '  umask 077',
  '  set -C',
  '  {',
  `    printf '{"info":%s,"code":%s,"tailHex":"' "$info" "$code"`,
  `    tail -c ${DEB_TAIL_BYTES} "$log" | od -A n -v -t x1 | LC_ALL=C tr -cd 0-9a-fA-F`,
  `    printf '"}\\n'`,
  '  } >"$tmp"',
  ') 2>/dev/null && [ ! -d "$result" ]; then',
  '  mv -f "$tmp" "$result"',
  'else',
  '  rm -f "$tmp"',
  'fi',
  'rm -f "$runner"',
  ')',
  'shift 9',
  'exec "$@" </dev/null >/dev/null 2>&1',
].join('\n')

export interface DebInstallFiles {
  log: string
  result: string
  runner: string
}

export function debInstallFiles(userDataPath: string): DebInstallFiles {
  return {
    log: join(userDataPath, DEB_LOG_FILE),
    result: join(userDataPath, DEB_RESULT_FILE),
    runner: join(userDataPath, DEB_RUNNER_FILE),
  }
}

// ---- Asking for administrator rights ------------------------------------------------------------

export type DebTool = { how: 'pkexec'; path: string } | { how: 'sudo'; path: string; askpass: string }

/** Where the distribution installs pkexec and sudo. Looked in before PATH, so a program of the
 *  same name earlier on the user's PATH isn't the one asked to run dpkg. */
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * pkexec, which polkit answers with its own dialog. Otherwise sudo -A, which asks through
 * Termpolis's askpass helper (sudoAskpass.ts), so only where Termpolis wrote one. Null when
 * there is neither: the user is given the command to run instead.
 */
export function findDebTool(
  pathEnv: string | undefined,
  askpass: string | null,
  isExecutable: (path: string) => boolean = isExecutableFile,
): DebTool | null {
  const dirs = [...new Set([...SYSTEM_DIRS, ...(pathEnv ?? '').split(':').filter((d) => posix.isAbsolute(d))])]
  const find = (name: string) => dirs.map((d) => posix.join(d, name)).find((p) => isExecutable(p))
  const pkexec = find('pkexec')
  if (pkexec) return { how: 'pkexec', path: pkexec }
  const sudo = askpass ? find('sudo') : undefined
  return sudo && askpass ? { how: 'sudo', path: sudo, askpass } : null
}

// ---- Starting the runner ------------------------------------------------------------------------

export interface DebInstallRequest {
  /** update-downloaded's `downloadedFile`. */
  deb: string | null | undefined
  /** The version running now. */
  from: string
  /** The version being installed. */
  target?: string
}

/** The runner's command line; see DEB_INSTALL_SCRIPT. Termpolis starts again from the program dpkg
 *  has replaced, with the same arguments, and never from an AppImage: only a .deb gets here, so an
 *  APPIMAGE it has was inherited, from the terminal of some other AppImage it was started in. */
export function debInstallCommand(
  target: RelaunchTarget,
  request: DebInstallRequest & { deb: string },
  tool: DebTool,
  files: DebInstallFiles,
): string[] {
  const info = JSON.stringify({ from: request.from, target: request.target, deb: request.deb, how: tool.how })
  return [
    '/bin/sh', '-c', DEB_INSTALL_SCRIPT, DEB_RUNNER_NAME,
    String(target.pid), request.deb, files.log, files.result, info,
    tool.how, tool.path, tool.how === 'sudo' ? tool.askpass : '', files.runner,
    target.execPath, ...target.argv.slice(1),
  ]
}

export interface RunnerSpawnOptions {
  detached: true
  stdio: ['ignore', number, number]
  env: NodeJS.ProcessEnv
}

export interface RunnerChild {
  pid?: number
  on(event: 'error', listener: (err: Error) => void): unknown
  unref(): void
}

export interface DebInstallDeps {
  target: RelaunchTarget
  userDataPath: string
  /** Termpolis's sudo -A helper (sudoAskpass.ts), or null where it has none. */
  askpass: string | null
  spawn: (cmd: string, args: string[], opts: RunnerSpawnOptions) => RunnerChild
  isExecutable?: (path: string) => boolean
  /** Whether a runner is already at work; by default, the one the runner file names. */
  running?: () => boolean
}

export type DebInstallStart = { started: true } | { started: false; message: string; busy?: true }

export function spawnRunner(cmd: string, args: string[], opts: RunnerSpawnOptions): RunnerChild {
  return spawn(cmd, args, opts)
}

export function defaultDebInstallDeps(userDataPath: string, askpass: string | null): DebInstallDeps {
  return { target: currentTarget(), userDataPath, askpass, spawn: spawnRunner }
}

/** An absolute path to a .deb, as electron-updater's cache names it. */
function isDebPath(deb: unknown): deb is string {
  return typeof deb === 'string' && posix.isAbsolute(deb) && deb.endsWith('.deb') && !deb.includes('\0')
}

/** Removes whatever is at `path` (a symlink is removed, never followed), then creates a new file
 *  there, failing if anything else got there first. */
function createFresh(path: string): number {
  try { unlinkSync(path) } catch { /* nothing there */ }
  return openSync(path, 'wx', 0o600)
}

/**
 * Start the runner. On { started: true } the caller quits at once, with the quit guard bypassed:
 * the runner waits for this process to exit. Otherwise nothing has changed, and `message` says
 * what to do instead: another Termpolis is already installing an update (`busy`), an earlier
 * Restart has installed this one already, there is no way to ask for administrator rights, or
 * the runner couldn't be started.
 */
export function startDebInstall(request: DebInstallRequest, deps: DebInstallDeps): DebInstallStart {
  const { deb } = request
  if (!isDebPath(deb)) return { started: false, message: debManualInstallMessage(undefined, DEB_NOT_STARTED_LEAD) }
  // dpkg must never run twice: a Termpolis opened while an earlier runner waits at its prompt
  // offers Restart too.
  const running = deps.running ?? (() => debInstallerRunning(deps.userDataPath))
  if (running()) return { started: false, message: DEB_BUSY_MESSAGE, busy: true }
  // Nor install again what an earlier runner has installed. Its result is still unread when the
  // Termpolis it started found this one, opened by hand meanwhile, holding the single-instance
  // lock and quit: this one still runs the version it started as, and finds the update as new as
  // ever.
  const installed = installedBefore(deps.userDataPath, request)
  if (installed) return { started: false, message: debInstalledMessage(installed) }
  const tool = findDebTool(deps.target.env.PATH, deps.askpass, deps.isExecutable)
  if (!tool) return { started: false, message: debManualInstallMessage(deb) }
  const notStarted = { started: false, message: debManualInstallMessage(deb, DEB_NOT_STARTED_LEAD) } as const
  const files = debInstallFiles(deps.userDataPath)
  const [cmd, ...args] = debInstallCommand(deps.target, { ...request, deb }, tool, files)
  let log: number
  try {
    log = createFresh(files.log)
  } catch {
    return notStarted
  }
  // An earlier attempt's result, never read, would otherwise be taken for this one's should this
  // runner fail to write its own.
  try { unlinkSync(files.result) } catch { /* none, or a folder, which the runner leaves alone too */ }
  let child: RunnerChild
  try {
    child = deps.spawn(cmd, args, { detached: true, stdio: ['ignore', log, log], env: deps.target.env })
  } catch {
    return notStarted
  } finally {
    closeSync(log)
  }
  // A process that couldn't be started has no pid, and says why in an 'error' event, which must be
  // heard or it would crash the main process. Termpolis doesn't quit into that.
  child.on('error', () => {})
  if (typeof child.pid !== 'number') return notStarted
  child.unref()
  try {
    createFreshText(files.runner, String(child.pid))
  } catch { /* only another Termpolis's busy check misses it */ }
  return { started: true }
}

/** The version an earlier runner installed for this same request, as its unread result says: a 0
 *  from the version running now to the one asked for, with no error in its output. Null for
 *  anything else, a result the next launch should hear about among it. */
function installedBefore(userDataPath: string, request: DebInstallRequest): string | null {
  const { from, target } = request
  if (!target) return null
  const found = readDebInstallResult(userDataPath)
  if (!found || found.code !== 0 || found.target !== target || found.from !== from) return null
  return debErrorDetail(withWholeLog(found, debInstallFiles(userDataPath).log).tail, false) ? null : target
}

function createFreshText(path: string, text: string): void {
  const fd = createFresh(path)
  try {
    writeFileSync(fd, text)
  } finally {
    closeSync(fd)
  }
}

/** Whether the runner the runner file names is still at work: its pid still runs the runner, by
 *  the name it runs under. Once it starts Termpolis, the same pid is Termpolis. */
export function debInstallerRunning(
  userDataPath: string,
  readProc: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): boolean {
  const file = readSmallFile(debInstallFiles(userDataPath).runner, 32)
  const pid = file ? /^\s*([1-9]\d{0,9})\s*$/.exec(file.text)?.[1] : undefined
  if (!pid || Number(pid) > 0x7fffffff) return false
  try {
    return readProc(`/proc/${pid}/cmdline`).split('\0').includes(DEB_RUNNER_NAME)
  } catch {
    return false
  }
}

// ---- The result ---------------------------------------------------------------------------------

/** Read whole, or not at all. */
export const DEB_RESULT_MAX_BYTES = 64 * 1024
/** Older than this, a result isn't news any more. */
export const DEB_RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** How much of the log is read for the error, beyond the tail the result keeps. */
export const DEB_LOG_MAX_BYTES = 1024 * 1024

/** A regular file of at most `maxBytes`, and when it was last written; null for anything else.
 *  Never follows a symlink, and never waits on a FIFO. */
export function readSmallFile(path: string, maxBytes: number): { text: string; mtimeMs: number } | null {
  let fd: number
  try {
    // The flags are read here, not when the module loads: a test that mocks fs without its
    // constants (mainProcess.test.ts, through index.ts) must still be able to load it.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch {
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > maxBytes) return null
    const buf = Buffer.alloc(st.size)
    const n = readSync(fd, buf, 0, st.size, 0)
    return { text: buf.toString('utf8', 0, n), mtimeMs: st.mtimeMs }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

export interface DebInstallResult {
  /** The install command's exit code, or the runner's own 1 when the .deb was gone. */
  code: number
  /** The end of the log. */
  tail: string
  from?: string
  target?: string
  deb?: string
  how?: 'pkexec' | 'sudo'
}

const HEX = /^(?:[0-9a-fA-F]{2})*$/

/** What the runner wrote; null for anything that isn't a result. Details of the wrong shape are
 *  left out. */
export function parseDebInstallResult(text: string): DebInstallResult | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { code, tailHex, info } = raw as Record<string, unknown>
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 255) return null
  const tail = typeof tailHex === 'string' && HEX.test(tailHex) ? Buffer.from(tailHex, 'hex').toString('utf8') : ''
  const result: DebInstallResult = { code, tail }
  const details = info && typeof info === 'object' ? (info as Record<string, unknown>) : {}
  for (const key of ['from', 'target', 'deb'] as const) {
    const value = details[key]
    if (typeof value === 'string' && value) result[key] = value
  }
  if (details.how === 'pkexec' || details.how === 'sudo') result.how = details.how
  return result
}

/** The result of the last install, left where it is. Null when there is none, or it is
 *  unreadable, too big, or more than a day old (or a day ahead). */
export function readDebInstallResult(userDataPath: string, now: number = Date.now()): DebInstallResult | null {
  const read = readSmallFile(debInstallFiles(userDataPath).result, DEB_RESULT_MAX_BYTES)
  if (!read || Math.abs(now - read.mtimeMs) > DEB_RESULT_MAX_AGE_MS) return null
  return parseDebInstallResult(read.text)
}

/** readDebInstallResult, once: the result is gone afterwards, whatever it held. */
export function takeDebInstallResult(userDataPath: string, now: number = Date.now()): DebInstallResult | null {
  const result = readDebInstallResult(userDataPath, now)
  try { unlinkSync(debInstallFiles(userDataPath).result) } catch { /* nothing there, or a folder: nothing to take */ }
  return result
}

/** The result with the whole log in place of its tail, where the log can be read: past a long
 *  apt-get listing, dpkg's own error can be further back than the tail reaches. The log is the
 *  user's own file beside the result, and a new attempt replaces the two together. */
function withWholeLog(result: DebInstallResult, logPath: string): DebInstallResult {
  const log = readSmallFile(logPath, DEB_LOG_MAX_BYTES)?.text
  return log ? { ...result, tail: log } : result
}

// The runner's own error lines start with this; the user is shown what follows it.
const RUNNER_ERROR = `${DEB_RUNNER_NAME}: error: `

// The first line that says why, in the words of dpkg, apt-get, sudo, Termpolis's askpass helper,
// pkexec, the shell, or the runner. dpkg's error comes before apt-get's consequences of it.
const ERROR_LINE = new RegExp(
  '^(?:dpkg(?:-deb|-split)?: (?:error|dependency problems)|E: |sudo(?:-rs)?: |termpolis-askpass: |' +
    `Error executing command as another user: |pkexec: |sh: |${RUNNER_ERROR})`,
)

const DETAIL_MAX = 300

/** The error to show from the log's tail: the first error line and the indented lines that
 *  continue it, else, unless `lastLine` is false, the last line that says anything. */
export function debErrorDetail(tail: string, lastLine = true): string {
  const lines = tail.split(/\r?\n/)
  const at = lines.findIndex((line) => ERROR_LINE.test(line))
  let text: string
  if (at >= 0) {
    const parts = [lines[at]]
    for (let i = at + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) parts.push(lines[i])
    text = parts.join(' ')
  } else {
    text = lastLine ? ([...lines].reverse().find((line) => line.trim()) ?? '') : ''
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (text.startsWith(RUNNER_ERROR)) text = text.slice(RUNNER_ERROR.length)
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text
}

export const DEB_CANCELLED_MESSAGE = 'Update not installed: the administrator prompt was cancelled.'

export const DEB_BUSY_MESSAGE =
  'An update is already being installed. Once it has finished, quit Termpolis and open it again.'

/** Restart in a Termpolis that still runs the version an earlier Restart has since replaced. */
export function debInstalledMessage(version: string): string {
  return `Termpolis ${version} is installed. Quit Termpolis and open it again to start it.`
}

const RELEASES_URL = 'https://github.com/codedev-david/termpolis/releases/latest'

/** A word the shell reads back as itself. */
function shellQuote(word: string): string {
  return /^[\w./:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** Why the user is given a command to run: the administrator prompt couldn't be shown or said no
 *  (pkexec's 127, no authentication agent), or there is no pkexec nor sudo -A to ask through. */
export const DEB_NO_RIGHTS_LEAD = "Update not installed: Termpolis couldn't get administrator rights to install it."
/** Or the runner itself couldn't be started, or update-downloaded named no usable .deb. */
export const DEB_NOT_STARTED_LEAD = "Update not installed: Termpolis couldn't start the installer."

export function debManualInstallMessage(deb: string | undefined, lead: string = DEB_NO_RIGHTS_LEAD): string {
  return deb
    ? `${lead} To install it, run this in a terminal, then restart Termpolis: sudo apt install ${shellQuote(deb)}`
    : `${lead} To install it, download the .deb from ${RELEASES_URL}, install it with sudo apt install, then restart Termpolis.`
}

export function debFailedMessage(detail: string, code: number, logPath: string): string {
  if (detail) return `Update not installed. ${detail} (full output: ${logPath})`
  if (code === 0) return `Update not installed: the installer finished without installing it (full output: ${logPath}).`
  return `Update not installed: the installer exited with code ${code} (full output: ${logPath}).`
}

/** The new version runs, but dpkg or apt-get failed on the way: the package may be left
 *  half-configured, which the error usually says how to finish. */
export function debIncompleteMessage(detail: string, code: number, logPath: string, version: string): string {
  const lead = `Termpolis ${version} is installed, but the installer`
  return detail
    ? `${lead} reported a problem. ${detail} (full output: ${logPath})`
    : `${lead} exited with code ${code} (full output: ${logPath}).`
}

export interface DebInstallNotice {
  /** 'cancelled': Restart can be tried again. 'manual': it can't work here, so the user is given
   *  the command to run. 'failed': dpkg's own error. 'incomplete': installed, with an error on the
   *  way. */
  kind: 'cancelled' | 'manual' | 'failed' | 'incomplete'
  message: string
}

/** Where electron-updater keeps a downloaded update: its cache folder (XDG_CACHE_HOME, else
 *  ~/.cache: getAppCacheDir), the updaterCacheDirName that app-update.yml names, then pending. */
export function debPendingDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return posix.join(env.XDG_CACHE_HOME || posix.join(home, '.cache'), 'termpolis-updater', 'pending')
}

/** The .deb a result names, when it is one electron-updater could have downloaded: a
 *  termpolis_….deb right in its pending folder, with no control character in the path. Any
 *  program running as the user can write the result, and this goes into a command the user is
 *  told to run as root. */
function downloadedDeb(deb: string | undefined, pendingDir: string): string | undefined {
  if (!deb || [...deb].some((c) => c < ' ' || c === '\u007f')) return undefined
  return posix.dirname(deb) === pendingDir && /^termpolis_.+\.deb$/.test(posix.basename(deb)) ? deb : undefined
}

const NO_AGENT = /No authentication agent found/
// sudo's words when the askpass dialog was cancelled, which hands it an empty answer; and
// Termpolis's helper (sudoAskpass.ts) finding no dialog program to ask through.
const NO_ANSWER = /\bno password was provided\b/
const NO_DIALOG = /^termpolis-askpass: no password dialog is installed\b/m

/** Why the install command never ran, when that is what a failed result says: the prompt was
 *  cancelled, or there was no way to ask. pkexec's 126 and 127 are its own codes; through sudo
 *  they would be the command's, like any other, so there only sudo's words tell. */
function notRun(result: DebInstallResult): 'cancelled' | 'manual' | null {
  if (result.how === 'sudo') {
    if (NO_DIALOG.test(result.tail)) return 'manual'
    return NO_ANSWER.test(result.tail) ? 'cancelled' : null
  }
  if (result.code === PKEXEC_DISMISSED) return 'cancelled'
  return result.code === PKEXEC_NOT_AUTHORIZED || NO_AGENT.test(result.tail) ? 'manual' : null
}

/**
 * What the launch after an install tells the user, or null when there is nothing to say. Nothing
 * when the version running is neither the one that ran the install nor the one it installed:
 * Termpolis has changed some other way since. Running the new version, only an error from the
 * install itself is news. The command to run by hand names the result's .deb only when it is in
 * electron-updater's `pendingDir`; a 0 that installed nothing shows only a line that says why.
 */
export function debInstallNotice(
  result: DebInstallResult,
  currentVersion: string,
  logPath: string,
  pendingDir: string = debPendingDir(),
): DebInstallNotice | null {
  const installed = !!result.target && currentVersion === result.target
  if (!installed && result.from && currentVersion !== result.from) return null
  const why = result.code === 0 ? null : notRun(result)
  if (installed) {
    // Installed some other way, when the command never ran.
    if (result.code === 0 || why) return null
    return { kind: 'incomplete', message: debIncompleteMessage(debErrorDetail(result.tail), result.code, logPath, currentVersion) }
  }
  if (why === 'cancelled') return { kind: 'cancelled', message: DEB_CANCELLED_MESSAGE }
  if (why === 'manual') return { kind: 'manual', message: debManualInstallMessage(downloadedDeb(result.deb, pendingDir)) }
  // Success, and no version to tell it by: believe it.
  if (result.code === 0 && !result.target) return null
  // Anything else, a 0 among it: dpkg can fail and leave apt-get -f nothing to fix. After a 0,
  // dpkg's last words are a trigger it ran, never a reason, should the version be unchanged.
  return { kind: 'failed', message: debFailedMessage(debErrorDetail(result.tail, result.code !== 0), result.code, logPath) }
}

/** takeDebInstallResult and debInstallNotice, for the launch, the error looked for in the whole log. */
export function readDebInstallNotice(userDataPath: string, currentVersion: string, now?: number): DebInstallNotice | null {
  const result = takeDebInstallResult(userDataPath, now)
  const { log } = debInstallFiles(userDataPath)
  return result ? debInstallNotice(withWholeLog(result, log), currentVersion, log) : null
}
