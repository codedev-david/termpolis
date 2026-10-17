// Auto-updater wiring for Termpolis.
//
// On startup (after the main window loads) we ask GitHub for the latest
// release metadata. If a newer version exists, electron-updater downloads
// it in the background and emits `update-downloaded`. The renderer is
// notified via IPC so it can show a toast; the user chooses when to
// restart to install.
//
// What a failure IS decides what happens next (updaterErrors.classifyUpdaterError), and only a
// genuine one is reported. Being offline or a briefly failing update host changes nothing the user
// sees — the next scheduled check retries. A full disk, or a macOS location Squirrel can't install
// to (the .dmg, App Translocation: see updaterLocation), is one plain hint, never a crash report.
//
// A Linux .deb is the exception to electron-updater installing the update: its install froze the
// window, so Restart hands the download to debUpdate.ts's runner and quits, and quitting by itself
// installs nothing.

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  DEB_NOT_STARTED_LEAD,
  debInstallerRunning,
  debManualInstallMessage,
  defaultDebInstallDeps,
  readDebInstallNotice,
  startDebInstall,
  type DebInstallStart,
} from './debUpdate'
import { hasNoNewPrivs, readPackageType, runsFromAppImage } from './noNewPrivs'
import { sudoAskpassPath } from './sudoAskpass'
import { recordUpdaterEvent } from './telemetry'
import { classifyUpdaterError, DISK_FULL_MESSAGE, scrubUpdaterText, updaterFailureMessage } from './updaterErrors'
import {
  bundlePathFromExe,
  detectUpdateBlocker,
  offerMoveToApplications,
  readOnlyBlockerFor,
  updateBlockerHint,
  type UpdaterDialog,
  type WriteProbe,
} from './updaterLocation'

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  releaseNotes?: string
  error?: string
  /**
   * Set on an 'error' that is something for the user to do rather than a failure, with `error` in
   * plain words. 'read-only-location': this copy can't install updates where it runs (macOS), so the
   * updater has stopped checking. 'disk-full': there wasn't room to save the update.
   * 'no-new-privs': this process can't run the administrator command a Linux install needs.
   * 'deb-install': Restart couldn't start installing a Linux .deb (debUpdate.ts): another install
   * is under way, or there is no way to ask for administrator rights here.
   */
  reason?: 'read-only-location' | 'disk-full' | 'no-new-privs' | 'deb-install'
  /**
   * What became of the last attempt to install a Linux .deb, as the launch after it read it
   * (debUpdate.ts). On every state until Restart is tried again; the banner shows it until the user
   * dismisses it. Never reported: it can name the user's home folder.
   */
  notice?: string
  downloadedBytes?: number
  totalBytes?: number
}

let currentState: UpdateState = { status: 'idle' }

/** Shown instead of installing when no_new_privs would make the install's pkexec or sudo fail. */
export const NO_NEW_PRIVS_UPDATE_MESSAGE =
  "This Termpolis window can't install the update: Linux has blocked it from asking for the administrator password. " +
  'Quit Termpolis and open it again from your applications menu, then install the update.'

/** Shown, before it quits, by a Termpolis opened while a .deb update is being installed. */
export const DEB_INSTALLING_DIALOG: UpdaterDialog = {
  type: 'warning',
  buttons: ['OK'],
  defaultId: 0,
  cancelId: 0,
  message: 'Termpolis is being updated',
  detail:
    'Termpolis closes now and opens again by itself once the update is installed. If your desktop is asking for ' +
    'your administrator password, answer it, or cancel it to keep the version you have.',
}

// Injectable resolver so unit tests can swap in a fake autoUpdater without
// vi.mock() intercepting our lazy require() (which it doesn't for ESM tests).
let updaterProvider: () => any = () => {
  try { return require('electron-updater').autoUpdater } catch { return null }
}

export function __setUpdaterProviderForTests(fn: () => any): void {
  updaterProvider = fn
}

// The benign-error predicates live in `./updaterErrors` — a pure module with no `electron` import,
// because `sentry.ts` needs them during early main init too. Re-exported here so the updater's
// public surface (and its tests) stay where they've always been.
export {
  isMissingUpdateConfigError,
  isTransientNetworkError,
  isTransientHttpServerError,
  isReadOnlyVolumeError,
  isDiskFullError,
  isBenignUpdaterError,
  classifyUpdaterError,
  DISK_FULL_MESSAGE,
  UPDATE_SERVER_UNREACHABLE_MESSAGE,
  NO_UPDATE_FEED_MESSAGE,
} from './updaterErrors'

// With autoDownload on, a check that finds an update starts the download and returns it as
// `downloadPromise`. A failed download is reported to on('error') AND rejects that promise, so
// left unhandled it reaches Sentry a second time as an unhandled rejection — a full disk
// mid-download would re-file #29–#31. on('error') has already dealt with it.
function ignoreDownloadRejection(result: { downloadPromise?: Promise<unknown> | null } | null | undefined): void {
  result?.downloadPromise?.catch(() => {})
}

// electron-updater logs to the console by default, and Sentry keeps console output as breadcrumbs
// on every later report. It logs each failure whole — an HttpError with GitHub's cookies in its
// response headers (#28), Squirrel's cache path with the user's name (#29–#31) — so its log goes
// through the same scrub as the text we show and report. It logs strings and Error objects.
const scrubbingLogger = {
  info: (message?: unknown) => console.info(scrubLogMessage(message)),
  warn: (message?: unknown) => console.warn(scrubLogMessage(message)),
  error: (message?: unknown) => console.error(scrubLogMessage(message)),
  debug: (message: string) => console.debug(scrubLogMessage(message)),
}

function scrubLogMessage(message: unknown): string {
  return scrubUpdaterText(message instanceof Error ? message.stack || message.message : String(message ?? ''))
}

// Injectable so unit tests can simulate a present/absent app-update.yml without
// a real packaged resources dir. Defaults to the exact path electron-updater
// reads in a packaged app: process.resourcesPath/app-update.yml.
let updateConfigExists: () => boolean = () => {
  try {
    return existsSync(join(process.resourcesPath, 'app-update.yml'))
  } catch {
    return false
  }
}

export function __setUpdateConfigExistsForTests(fn: () => boolean): void {
  updateConfigExists = fn
}

/** What the macOS location check and the Move to Applications offer need from the platform. */
export interface UpdaterHost {
  platform: NodeJS.Platform
  exePath: string
  /** The location check's writability probe; updaterLocation's default is fs access(W_OK). */
  probe?: WriteProbe
  /** Where the Move offer's answer is kept. */
  prefsPath: () => string
  offerDelayMs: number
  /** app.isInApplicationsFolder — only where Electron has it (macOS). */
  isInApplicationsFolder?: () => boolean
  moveToApplicationsFolder: () => boolean
  showMessageBox: (parent: BrowserWindow | null, options: UpdaterDialog) => Promise<{ response: number }>
  /** Running from an AppImage, decided as electron-updater decides which updater to use: by the
   *  package-type of a .deb where there is one, since APPIMAGE can be inherited (noNewPrivs.ts). */
  appImage: boolean
  /** Whether this process has Linux's no_new_privs set (noNewPrivs.ts). */
  noNewPrivs: () => boolean | null
  /** A .deb: start installing the downloaded package from outside Termpolis (debUpdate.ts). */
  installDeb: (deb: string | undefined, version: string | undefined) => DebInstallStart
  /** A .deb: what became of the last install, read once (debUpdate.ts); null when nothing is news. */
  takeDebNotice: () => string | null
  /** A .deb: whether the install runner of an earlier Restart is still at work (debUpdate.ts). */
  debInstallerRunning: () => boolean
  /** Quit, once the .deb's install runner is waiting for this process to exit. */
  quit: () => void
}

function defaultHost(): UpdaterHost {
  return {
    platform: process.platform,
    exePath: process.execPath,
    prefsPath: () => join(app.getPath('userData'), 'updater-prefs.json'),
    // At launch, before the user can be typing: a dialog that pops up mid-command takes the Return
    // meant for the shell as "Move to Applications".
    offerDelayMs: 0,
    ...(typeof app.isInApplicationsFolder === 'function'
      ? { isInApplicationsFolder: () => app.isInApplicationsFolder() }
      : {}),
    moveToApplicationsFolder: () => app.moveToApplicationsFolder(),
    showMessageBox: (parent, options) =>
      parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options),
    appImage: runsFromAppImage(process.env, readPackageType()),
    noNewPrivs: () => hasNoNewPrivs(),
    installDeb: (deb, version) =>
      startDebInstall({ deb, from: app.getVersion(), target: version }, defaultDebInstallDeps(app.getPath('userData'), sudoAskpassPath())),
    takeDebNotice: () => readDebInstallNotice(app.getPath('userData'), app.getVersion())?.message ?? null,
    debInstallerRunning: () => debInstallerRunning(app.getPath('userData')),
    quit: () => app.quit(),
  }
}

let hostOverrides: Partial<UpdaterHost> = {}

export function __setUpdaterHostForTests(overrides: Partial<UpdaterHost>): void {
  hostOverrides = overrides
}

export function initAutoUpdater(
  getMainWindow: () => BrowserWindow | null,
  opts?: {
    /**
     * Called right before this module quits the app: quitAndInstall, the quit that hands a Linux
     * .deb to its install runner, or a Move to Applications (macOS), which quits from inside
     * app.moveToApplicationsFolder. Each quit goes through the main window's close event, where the
     * "AI agents are running" guard would otherwise preventDefault it and interject its confirm
     * dialog — cancelling the quit. The caller uses this to arm a bypass: the user already chose to
     * restart. Called with `false` when a move didn't happen after all, so the guard guards again.
     */
    onBeforeQuitAndInstall?: (armed?: boolean) => void
  },
) {
  // Skip in dev / test runs — electron-updater can't verify unsigned builds
  // and would either no-op or error loudly. We still want the IPC surface
  // mounted so the renderer can render the banner in dev-test fixtures.
  const isDev = !app.isPackaged
  const skipUpdater = isDev || process.env.NODE_ENV === 'test' || process.env.TERMPOLIS_SKIP_UPDATER === '1'
  const host: UpdaterHost = { ...defaultHost(), ...hostOverrides }
  // Set once this copy is known to be unable to install an update where it runs (macOS): the hint
  // shown instead of checking again.
  let blockedHint: string | null = null
  // Squirrel's refusal says only "read-only volume"; where the app runs says which one.
  const readOnlyHint = () => updateBlockerHint(readOnlyBlockerFor(bundlePathFromExe(host.exePath)))
  const setQuitBypass = (armed: boolean) => {
    try { opts?.onBeforeQuitAndInstall?.(armed) } catch { /* never block the install, or the move */ }
  }
  // From "Restart" until the app quits. An updater error in between means that quit isn't coming
  // (Squirrel.Mac failing to unpack, an installer that won't start), so the guard must guard again.
  let restartRequested = false
  const cancelRestart = () => {
    if (!restartRequested) return
    restartRequested = false
    setQuitBypass(false)
  }
  // A Linux system package, which electron-updater would install with pkexec … dpkg through
  // spawnSync on this thread. The package-type the package carries says so, as it says to
  // electron-updater, and an APPIMAGE this Termpolis inherited doesn't change it (host.appImage).
  // Only the .deb is handed to debUpdate: Termpolis ships no .rpm or pacman package.
  const systemPackage = host.platform === 'linux' && !host.appImage
  // The .deb that update-downloaded named, and the outcome of the last install the launch read.
  let downloadedDeb: string | undefined
  let debNotice: string | null = null

  ipcMain.handle('updater:status', () => currentState)
  ipcMain.handle('updater:quit-and-install', () => {
    if (currentState.status !== 'downloaded') return { success: false, error: 'no update ready' }
    // A .deb/.rpm install runs pkexec or sudo, which fail outright under no_new_privs, and the app
    // would quit with nothing installed. An AppImage replaces its own file and needs no root.
    if (systemPackage && host.noNewPrivs() === true) {
      showHint(NO_NEW_PRIVS_UPDATE_MESSAGE, 'no-new-privs')
      return { success: false, error: NO_NEW_PRIVS_UPDATE_MESSAGE }
    }
    if (systemPackage) {
      // The runner waits for this process to exit, so it must quit; and nothing else is told to
      // install, so the quit installs nothing (autoInstallOnAppQuit is off).
      debNotice = null
      let start: DebInstallStart
      try {
        start = host.installDeb(downloadedDeb, currentState.version)
      } catch {
        start = { started: false, message: debManualInstallMessage(downloadedDeb, DEB_NOT_STARTED_LEAD) }
      }
      if (!start.started) {
        showHint(start.message, 'deb-install')
        return { success: false, error: start.message }
      }
      // Armed for good: no updater error stops this quit, since the runner is already waiting.
      setQuitBypass(true)
      // A tick later, so the renderer has its answer before the window goes.
      setImmediate(() => host.quit())
      return { success: true }
    }
    try {
      const au = updaterProvider()
      if (!au) return { success: false, error: 'electron-updater unavailable' }
      restartRequested = true
      setQuitBypass(true)
      au.quitAndInstall(false, true)
      return { success: true }
    } catch (e) {
      cancelRestart()
      return { success: false, error: String((e as Error).message || e) }
    }
  })
  ipcMain.handle('updater:check', async () => {
    if (skipUpdater) return { success: false, error: 'auto-update disabled in dev/test' }
    // A check would only download an update to be refused again: say why instead.
    if (blockedHint) return { success: false, error: blockedHint }
    try {
      const au = updaterProvider()
      if (!au) return { success: false, error: 'electron-updater unavailable' }
      ignoreDownloadRejection(await au.checkForUpdates())
      return { success: true }
    } catch (e) {
      return { success: false, error: updaterFailureMessage(e, readOnlyHint()) }
    }
  })

  if (skipUpdater) return

  const autoUpdater = updaterProvider()
  if (!autoUpdater) {
    // electron-updater not available in this environment — give up quietly.
    return
  }

  autoUpdater.logger = scrubbingLogger
  autoUpdater.autoDownload = true
  // A system package never installs on quit. electron-updater's install on quit runs pkexec … dpkg
  // from Electron's quit event, through spawnSync: the administrator prompt would appear after the
  // window had gone, with the will-quit watchdog unable to fire while it blocks. Restart is the
  // only way in, and the banner keeps offering it: electron-updater finds its cached download again
  // at the next check. Nor does electron-updater reopen the app, through app.relaunch(), which on
  // Linux leaves the new copy unable to run sudo in any of its terminals (noNewPrivs.ts): the
  // install runner starts Termpolis again itself. An AppImage is left alone: its updater needs no
  // root, and starts the new image through child_process, which doesn't cause it.
  autoUpdater.autoInstallOnAppQuit = !systemPackage
  if (systemPackage) autoUpdater.autoRunAppAfterInstall = false
  autoUpdater.allowPrerelease = false

  // Where the updater last came to rest (not mid-check or mid-download). A check that fails through
  // nobody's fault goes back here: it neither buries an update that is ready to install nor invents
  // an answer the check never got. It is never a failure, though: a failure is news of the attempt
  // that hit it, and brought back it showed a full disk the user had since cleared, or a check that
  // failed hours ago, as if it were happening now.
  let lastSettled: UpdateState = { status: 'idle' }
  let interval: ReturnType<typeof setInterval> | undefined

  const setState = (next: UpdateState, { record = true }: { record?: boolean } = {}) => {
    // What the last .deb install came to rides along on every state until Restart is tried again.
    const { notice: _notice, ...s } = next
    currentState = debNotice ? { ...s, notice: debNotice } : s
    // A failure settles nothing, and may have taken a ready update with it (a failed download
    // empties electron-updater's cache; Squirrel.Mac failing to unpack stages nothing). Standing
    // down is the exception: it stays true for as long as this copy runs.
    if (s.status === 'error' && s.reason !== 'read-only-location') lastSettled = { status: 'idle' }
    else if (s.status !== 'checking' && s.status !== 'available' && s.status !== 'downloading') lastSettled = s
    const win = getMainWindow()
    win?.webContents.send('updater:state', currentState)
    // Tier 2: forward to telemetry as a breadcrumb (or captureMessage on a
    // genuine error). Internally no-ops when the user hasn't opted in. What
    // must never be reported is simply not passed on.
    if (!record) return
    try {
      recordUpdaterEvent({
        status: s.status,
        ...(s.version ? { version: s.version } : {}),
        ...(s.error ? { error: s.error } : {}),
        ...(typeof s.downloadedBytes === 'number' ? { downloadedBytes: s.downloadedBytes } : {}),
        ...(typeof s.totalBytes === 'number' ? { totalBytes: s.totalBytes } : {}),
      })
    } catch { /* never let telemetry crash the updater */ }
  }
  // Restart's hints. A declaration, so the handler above can name it: nothing calls it before
  // setState exists, since until then no update can be 'downloaded'.
  function showHint(error: string, reason: 'no-new-privs' | 'deb-install'): void {
    setState({ status: 'error', error, reason }, { record: false })
  }

  // The launch after a .deb install: what became of it, read and removed once. Only a system
  // package's runner writes it, and never a dev or test run, which returned above. A Termpolis
  // opened while a runner is still at work reads nothing: that runner hasn't written its result.
  let installing = false
  if (systemPackage) {
    try {
      installing = host.debInstallerRunning()
    } catch { /* can't tell: carry on as usual */ }
    if (!installing) {
      try {
        debNotice = host.takeDebNotice()
      } catch { /* unreadable: there is nothing to say */ }
      if (debNotice) setState(currentState, { record: false })
    }
  }

  // This copy can't install an update where it runs. One plain hint, and no more checks: each one
  // would download the whole update only to be refused again, as every 4-hourly retry was (#21/#22).
  const standDown = (hint: string) => {
    blockedHint = hint
    clearInterval(interval)
    setState({ status: 'error', error: hint, reason: 'read-only-location' }, { record: false })
  }

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }))
  autoUpdater.on('update-available', (info: any) => {
    // A download starts, and one that fails takes the update that was ready with it (electron-updater
    // empties its cache): a failure from here on must not bring "Restart" back for it.
    lastSettled = { status: 'idle' }
    setState({
      status: 'available',
      version: info?.version,
      releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : undefined,
    })
  })
  autoUpdater.on('update-not-available', (info: any) => {
    setState({ status: 'not-available', version: info?.version })
  })
  autoUpdater.on('download-progress', (p: any) => {
    setState({
      status: 'downloading',
      version: currentState.version,
      downloadedBytes: p?.transferred,
      totalBytes: p?.total,
    })
  })
  autoUpdater.on('update-downloaded', (info: any) => {
    downloadedDeb = typeof info?.downloadedFile === 'string' ? info.downloadedFile : undefined
    setState({
      status: 'downloaded',
      version: info?.version,
      releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : undefined,
    })
  })
  autoUpdater.on('error', (err: Error) => {
    cancelRestart()
    // Only a genuine failure is reported; updaterErrors has each kind and the Sentry issues it filed.
    switch (classifyUpdaterError(err)) {
      case 'read-only':
        // Squirrel.Mac refused: the app runs from the .dmg or under App Translocation (#21/#22).
        standDown(readOnlyHint())
        return
      case 'disk-full':
        // The user's to fix, and an update IS pending — on macOS this fires right after
        // 'update-downloaded', when Squirrel fails to unpack it (#29–#31).
        setState({ status: 'error', error: DISK_FULL_MESSAGE, reason: 'disk-full' }, { record: false })
        return
      case 'transient':
      case 'missing-config':
        // Offline, a flaky connection, the update host briefly failing (#15, #19, #28), or no
        // app-update.yml (#14): nothing has changed, and the next scheduled check retries.
        setState(lastSettled, { record: false })
        return
      case 'genuine':
        setState({ status: 'error', error: scrubUpdaterText(err?.message || String(err)) })
    }
  })

  // Opened by hand while the runner of an earlier Restart is at work, at the password dialog or in
  // dpkg: this copy runs the version being replaced, and holds the single-instance lock that the
  // Termpolis the runner starts afterwards needs. It says so, checks for nothing, and quits.
  if (installing) {
    void host.showMessageBox(getMainWindow(), DEB_INSTALLING_DIALOG)
      .catch(() => null)
      .then(() => {
        setQuitBypass(true)
        host.quit()
      })
      .catch(() => {})
    return
  }

  // If the update config is absent, every checkForUpdates() would only re-emit
  // the benign ENOENT above. Skip scheduling the periodic checks entirely. The
  // 'error' listener stays registered so a manual updater:check (or any stray
  // emit) is still handled gracefully rather than crashing the main process
  // with an unhandled 'error' event.
  if (!updateConfigExists()) return

  const runCheck = () =>
    blockedHint ? undefined : autoUpdater.checkForUpdates().then(ignoreDownloadRejection).catch(() => {})
  // First check a few seconds after launch; then every 4 hours.
  const schedule = () => {
    setTimeout(runCheck, 10_000)
    interval = setInterval(runCheck, 4 * 60 * 60 * 1000)
  }

  const bundle = host.platform === 'darwin' ? bundlePathFromExe(host.exePath) : null
  if (!bundle) {
    schedule()
    return
  }
  // macOS. Squirrel only finds out it can't install over this bundle once the whole update has
  // downloaded, so find out first: it takes one access() call.
  void detectUpdateBlocker({ platform: host.platform, exePath: host.exePath, probe: host.probe })
    .catch(() => null)
    .then((blocker) => (blocker ? standDown(updateBlockerHint(blocker)) : schedule()))
    .catch(() => {})
  // And offer, once, to put Termpolis where it can update itself.
  const { isInApplicationsFolder } = host
  if (isInApplicationsFolder) {
    setTimeout(() => {
      void (async () =>
        offerMoveToApplications({
          platform: host.platform,
          prefsPath: host.prefsPath(),
          isInApplicationsFolder,
          moveToApplicationsFolder: host.moveToApplicationsFolder,
          showMessageBox: (options) => host.showMessageBox(getMainWindow(), options),
          setQuitBypass,
          log: (message) => console.warn(message),
        }))().catch(() => {})
    }, host.offerDelayMs)
  }
}
