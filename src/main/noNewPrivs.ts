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
// exit and then starts Termpolis again keeps the new copy exactly as privileged as this one. It
// must be spawned from the main process itself: Chromium starts its own child processes with the
// bit set, so anything routed through a utility process (procHost) would carry it.

import { spawn, spawnSync } from 'child_process'
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

/** Waits for the process in $1 to exit, then runs the remaining arguments in its place. It gives
 *  up after about two minutes: while the old Termpolis runs it holds the single-instance lock, so
 *  a copy started then would only quit again. `sleep 1` covers a sleep that rejects fractions. */
export const RELAUNCH_SCRIPT = [
  'pid=$1; shift',
  'i=0',
  'while kill -0 "$pid" 2>/dev/null; do',
  '  i=$((i + 1)); [ "$i" -gt 600 ] && exit 1',
  '  sleep 0.2 2>/dev/null || sleep 1',
  'done',
  'exec "$@"',
].join('\n')

export interface RelaunchTarget {
  pid: number
  execPath: string
  /** process.argv: [execPath, ...arguments]. The arguments are passed on unchanged, as
   *  app.relaunch() does. */
  argv: readonly string[]
  env: NodeJS.ProcessEnv
}

export function currentTarget(): RelaunchTarget {
  return { pid: process.pid, execPath: process.execPath, argv: process.argv, env: process.env }
}

/** The command that starts Termpolis again once `pid` has exited. An AppImage restarts from its
 *  .AppImage file, because execPath is inside the image's mount, which goes away when it exits. */
export function relaunchCommand(t: RelaunchTarget): string[] {
  const program = t.env.APPIMAGE || t.execPath
  return ['/bin/sh', '-c', RELAUNCH_SCRIPT, 'termpolis-relaunch', String(t.pid), program, ...t.argv.slice(1)]
}

interface SpawnedChild {
  on(event: 'error', listener: (err: Error) => void): unknown
  unref(): void
}

type DetachedOpts = { detached: true; stdio: 'ignore' }

export interface RelaunchDeps {
  target: RelaunchTarget
  spawn: (cmd: string, args: string[], opts: DetachedOpts) => SpawnedChild
}

export function spawnDetached(cmd: string, args: string[], opts: DetachedOpts): SpawnedChild {
  return spawn(cmd, args, opts)
}

export function defaultRelaunchDeps(): RelaunchDeps {
  return { target: currentTarget(), spawn: spawnDetached }
}

/** Restart Termpolis without setting no_new_privs (see the header). Call it, then quit. */
export function relaunchWithoutNoNewPrivs(deps: RelaunchDeps): boolean {
  const [cmd, ...args] = relaunchCommand(deps.target)
  try {
    const child = deps.spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => { /* no /bin/sh: the app just doesn't come back, as if quit */ })
    child.unref()
    return true
  } catch {
    return false
  }
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
