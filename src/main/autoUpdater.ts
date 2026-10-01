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

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
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
   */
  reason?: 'read-only-location' | 'disk-full'
  downloadedBytes?: number
  totalBytes?: number
}

let currentState: UpdateState = { status: 'idle' }

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
     * Called right before this module quits the app: quitAndInstall, or a Move to Applications
     * (macOS), which quits from inside app.moveToApplicationsFolder. Either quit goes through the
     * main window's close event, where the "AI agents are running" guard would otherwise
     * preventDefault it and interject its confirm dialog — cancelling the quit. The caller uses this
     * to arm a bypass: the user already chose to restart. Called with `false` when a move didn't
     * happen after all, so the guard guards again.
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

  ipcMain.handle('updater:status', () => currentState)
  ipcMain.handle('updater:quit-and-install', () => {
    if (currentState.status !== 'downloaded') return { success: false, error: 'no update ready' }
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
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false

  // Where the updater last came to rest (not mid-check or mid-download). A check that fails through
  // nobody's fault goes back here: it neither buries an update that is ready to install nor invents
  // an answer the check never got. It is never a failure, though: a failure is news of the attempt
  // that hit it, and brought back it showed a full disk the user had since cleared, or a check that
  // failed hours ago, as if it were happening now.
  let lastSettled: UpdateState = { status: 'idle' }
  let interval: ReturnType<typeof setInterval> | undefined

  const setState = (s: UpdateState, { record = true }: { record?: boolean } = {}) => {
    currentState = s
    // A failure settles nothing, and may have taken a ready update with it (a failed download
    // empties electron-updater's cache; Squirrel.Mac failing to unpack stages nothing). Standing
    // down is the exception: it stays true for as long as this copy runs.
    if (s.status === 'error' && s.reason !== 'read-only-location') lastSettled = { status: 'idle' }
    else if (s.status !== 'checking' && s.status !== 'available' && s.status !== 'downloading') lastSettled = s
    const win = getMainWindow()
    win?.webContents.send('updater:state', s)
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
