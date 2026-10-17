// noNewPrivs.ts
//
// Linux's no_new_privs bit, and how Termpolis restarts itself without setting it.
//
// Once a process has no_new_privs, nothing it starts can gain privileges: setuid programs run
// without them, so sudo, su and pkexec all fail ("The 'no new privileges' flag is set"). Every
// child inherits the bit, and it can never be cleared.
//
// Electron sets it on Termpolis by accident. app.relaunch() starts a relauncher helper with
// Chromium's default launch options, and on Linux those set PR_SET_NO_NEW_PRIVS on the child
// (base/process/launch.h: "By default, child processes will have the PR_SET_NO_NEW_PRIVS bit
// set"). The helper asks for allow_new_privs when it starts the new Termpolis, but it already has
// the bit itself, so the new Termpolis inherits it, and so does every terminal it opens.
// electron-updater's .deb, .rpm and pacman installers call app.relaunch() after every update, so
// through 1.50.0 each in-app update left sudo broken in every Termpolis terminal until the app was
// quit and opened again. Checked against Electron 30.5.1 and Electron's main branch.
//
// Node's child_process never sets the bit, so a detached shell that waits for this process to
// exit and then starts Termpolis again keeps the new copy exactly as privileged as this one: what
// the .deb's install runner does (debUpdate.ts). It must be spawned from the main process itself:
// Chromium starts its own child processes with the bit set, so anything routed through a utility
// process (procHost) would carry it.

import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/** Whether a /proc/<pid>/status text says no_new_privs is set; null when it doesn't say. */
export function parseNoNewPrivs(status: string): boolean | null {
  const m = /^NoNewPrivs:\s*(\d+)\s*$/m.exec(status)
  return m ? m[1] !== '0' : null
}

/** Whether this process has no_new_privs set. Null off Linux, or when /proc can't be read. */
export function hasNoNewPrivs(
  platform: NodeJS.Platform = process.platform,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): boolean | null {
  if (platform !== 'linux') return null
  try {
    return parseNoNewPrivs(read('/proc/self/status'))
  } catch {
    return null
  }
}

/** Waits for the process in $pid to exit. A process that has exited but that its parent hasn't
 *  reaped yet still answers kill -0, so a zombie counts as gone. It gives up after about two
 *  minutes, leaving WAIT_GAVE_UP true: while the old Termpolis runs it holds the single-instance
 *  lock, so a copy started then would only quit again. `sleep 1` covers a sleep that rejects
 *  fractions. Shared with the .deb update runner (debUpdate.ts). Both run it in a subshell: in sh,
 *  assigning to a name the environment exports changes it for whatever is started afterwards, so
 *  the shell that starts Termpolis again must assign nothing, not even $i. */
export const WAIT_FOR_EXIT = [
  'i=0',
  'while kill -0 "$pid" 2>/dev/null; do',
  '  case "$(ps -o stat= -p "$pid" 2>/dev/null)" in *Z*) break ;; esac',
  '  i=$((i + 1)); [ "$i" -gt 600 ] && break',
  '  sleep 0.2 2>/dev/null || sleep 1',
  'done',
]

/** After WAIT_FOR_EXIT: true when it gave up, the process still running. */
export const WAIT_GAVE_UP = '[ "$i" -gt 600 ]'

/** Waits for the process in $1 to exit (WAIT_FOR_EXIT), then runs the remaining arguments in its
 *  place; once the wait has given up, nothing. */
export const RELAUNCH_SCRIPT = ['(', 'pid=$1', ...WAIT_FOR_EXIT, `! ${WAIT_GAVE_UP}`, ') || exit 1', 'shift', 'exec "$@"'].join('\n')

// ---- An AppImage, or a system package ---------------------------------------------------------

/** In the resources folder of a .deb, .rpm or pacman package, electron-builder writes which of the
 *  three it is ('deb' for the .deb); never in an AppImage. */
export const PACKAGE_TYPE_FILE = 'package-type'

/** The package types electron-updater installs through the system's package manager rather than by
 *  replacing an AppImage: DebUpdater, RpmUpdater and PacmanUpdater. */
export const SYSTEM_PACKAGE_TYPES: readonly string[] = ['deb', 'rpm', 'pacman']

/** What package-type says; null where there is none, as in an AppImage or outside Electron, or it
 *  can't be read. Read as electron-updater reads it: the whole file, trimmed. */
export function readPackageType(
  resourcesPath: string | undefined = process.resourcesPath,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | null {
  if (!resourcesPath) return null
  try {
    return read(join(resourcesPath, PACKAGE_TYPE_FILE)).trim()
  } catch {
    return null
  }
}

/**
 * Whether this Termpolis runs from an AppImage. Decided as electron-updater decides which updater
 * to use (main.js, doLoadAutoUpdater): a package type that names a system package says no,
 * whatever APPIMAGE says. APPIMAGE is inherited like any other variable, so a .deb Termpolis
 * started from the terminal of an AppImage, an editor say, has that one's. Only where there is no
 * package type does APPIMAGE decide.
 */
export function runsFromAppImage(env: NodeJS.ProcessEnv, packageType: string | null): boolean {
  return !!env.APPIMAGE && !SYSTEM_PACKAGE_TYPES.includes(packageType ?? '')
}

export interface RelaunchTarget {
  pid: number
  execPath: string
  /** process.argv: [execPath, ...arguments]. The arguments are passed on unchanged, as
   *  app.relaunch() does. */
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  /** The .AppImage file this Termpolis runs from, when it runs from one (runsFromAppImage). */
  appImage?: string
}

export function currentTarget(): RelaunchTarget {
  const target: RelaunchTarget = { pid: process.pid, execPath: process.execPath, argv: process.argv, env: process.env }
  if (runsFromAppImage(process.env, readPackageType())) target.appImage = process.env.APPIMAGE
  return target
}

/** The program and arguments that start Termpolis again. An AppImage restarts from its .AppImage
 *  file, because execPath is inside the image's mount, which goes away when it exits. */
export function relaunchArgv(t: RelaunchTarget): string[] {
  return [t.appImage || t.execPath, ...t.argv.slice(1)]
}

/** The command that starts Termpolis again once `pid` has exited. */
export function relaunchCommand(t: RelaunchTarget): string[] {
  return ['/bin/sh', '-c', RELAUNCH_SCRIPT, 'termpolis-relaunch', String(t.pid), ...relaunchArgv(t)]
}

// systemd sets these itself for every service it starts; copying this process's values would
// give the new Termpolis another unit's identity. ELECTRON_RUN_AS_NODE would start it as plain
// Node instead of the app.
const NOT_COPIED = new Set([
  'INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'MANAGERPID', 'LISTEN_PID', 'LISTEN_FDS',
  'LISTEN_FDNAMES', 'NOTIFY_SOCKET', 'WATCHDOG_PID', 'WATCHDOG_USEC', 'MEMORY_PRESSURE_WATCH',
  'MEMORY_PRESSURE_WRITE', 'ELECTRON_RUN_AS_NODE',
])

/** systemd-run arguments that start the relaunch shell as a service of the user's systemd. The
 *  service manager starts that process, not this one, so it does not inherit this process's
 *  no_new_privs: the only way back once the bit is set. `--setenv=NAME` copies each variable
 *  from systemd-run's own environment, so no value passes through argv. KillMode=process: closing
 *  that Termpolis must not also kill what its terminals left running, which a normal launch
 *  doesn't do either. */
export function systemdRelaunchArgs(t: RelaunchTarget): string[] {
  const names = Object.keys(t.env).filter(
    (k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !NOT_COPIED.has(k) && t.env[k] !== undefined,
  )
  return [
    '--user', '--collect', '--quiet', '--property=KillMode=process',
    ...names.map((k) => `--setenv=${k}`),
    '--', ...relaunchCommand(t),
  ]
}

export interface SystemdDeps {
  target: RelaunchTarget
  run: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => { status: number | null; error?: Error }
}

export function runSync(cmd: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; error?: Error } {
  return spawnSync(cmd, args, { env, stdio: 'ignore', timeout: 15_000 })
}

export function defaultSystemdDeps(): SystemdDeps {
  return { target: currentTarget(), run: runSync }
}

/** Whether systemd-run is there to restart through. */
export function canRelaunchViaSystemd(deps: SystemdDeps): boolean {
  try {
    const r = deps.run('systemd-run', ['--version'], deps.target.env)
    return !r.error && r.status === 0
  } catch {
    return false
  }
}

/** Start the relaunch shell through systemd-run; true once systemd has accepted it. */
export function relaunchViaSystemd(deps: SystemdDeps): boolean {
  try {
    const r = deps.run('systemd-run', systemdRelaunchArgs(deps.target), deps.target.env)
    return !r.error && r.status === 0
  } catch {
    return false
  }
}

// ---- The notice ---------------------------------------------------------------------------

export const NOTICE_FILE = 'no-new-privs-notice.json'

export interface NoticeChoice {
  response: number
  checkboxChecked?: boolean
}

export interface NoticeDialog {
  type: 'warning' | 'error'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  checkboxLabel?: string
  noLink: true
}

export interface NoticeDeps {
  noNewPrivs: () => boolean | null
  dismissed: () => boolean
  dismiss: () => void
  canRestart: () => boolean
  restart: () => boolean
  quit: () => void
  show: (dialog: NoticeDialog) => Promise<NoticeChoice>
}

export type NoticeOutcome = 'clear' | 'dismissed' | 'not-now' | 'restarting' | 'restart-failed'

const NOTICE_SUMMARY =
  'Linux has marked this Termpolis process "no new privileges", so sudo, su and pkexec fail in every ' +
  'terminal it opens. Updates from Termpolis 1.50.0 and earlier set it when they restarted the app.'

/** Tell the user when this Termpolis can't run sudo, and offer the restart that fixes it. */
export async function noticeNoNewPrivs(deps: NoticeDeps): Promise<NoticeOutcome> {
  if (deps.noNewPrivs() !== true) return 'clear'
  if (deps.dismissed()) return 'dismissed'
  const canRestart = deps.canRestart()
  const choice = await deps.show({
    type: 'warning',
    title: 'Termpolis',
    message: "sudo won't work in this window",
    detail: canRestart
      ? `${NOTICE_SUMMARY} Restart Termpolis to clear it.`
      : `${NOTICE_SUMMARY} To clear it, quit Termpolis and open it again from your applications menu.`,
    buttons: canRestart ? ['Restart Termpolis', 'Not now'] : ['OK'],
    defaultId: 0,
    cancelId: canRestart ? 1 : 0,
    checkboxLabel: "Don't show this again",
    noLink: true,
  })
  if (choice.checkboxChecked) deps.dismiss()
  if (!canRestart || choice.response !== 0) return 'not-now'
  if (deps.restart()) {
    deps.quit()
    return 'restarting'
  }
  await deps.show({
    type: 'error',
    title: 'Termpolis',
    message: "Termpolis couldn't restart itself",
    detail: 'Quit Termpolis and open it again from your applications menu.',
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  return 'restart-failed'
}

/** The "don't show this again" answer, kept in userData. Unreadable counts as not dismissed. */
export function noticeStore(userDataPath: string): Pick<NoticeDeps, 'dismissed' | 'dismiss'> {
  const file = join(userDataPath, NOTICE_FILE)
  return {
    dismissed: () => {
      try {
        return JSON.parse(readFileSync(file, 'utf8'))?.dismissed === true
      } catch {
        return false
      }
    },
    dismiss: () => {
      try {
        writeFileSync(file, JSON.stringify({ dismissed: true }))
      } catch { /* asked again next launch */ }
    },
  }
}

/** Show the notice a few seconds after launch, once the window has had time to appear. Where
 *  no_new_privs isn't set, which is nearly always, nothing is scheduled at all. */
export function scheduleNoNewPrivsNotice(
  userDataPath: string,
  show: NoticeDeps['show'],
  quit: () => void,
  opts: { delayMs?: number; probe?: () => boolean | null; systemd?: SystemdDeps } = {},
): boolean {
  const probe = opts.probe ?? (() => hasNoNewPrivs())
  if (probe() !== true) return false
  const systemd = opts.systemd ?? defaultSystemdDeps()
  setTimeout(() => {
    void noticeNoNewPrivs({
      noNewPrivs: probe,
      ...noticeStore(userDataPath),
      canRestart: () => canRelaunchViaSystemd(systemd),
      restart: () => relaunchViaSystemd(systemd),
      quit,
      show,
    }).catch(() => { /* a dialog that failed to open: the next launch asks again */ })
  }, opts.delayMs ?? 3000)
  return true
}
