// Auto-updater wiring for Termpolis.
//
// On startup (after the main window loads) we ask GitHub for the latest
// release metadata. If a newer version exists, electron-updater downloads
// it in the background and emits `update-downloaded`. The renderer is
// notified via IPC so it can show a toast; the user chooses when to
// restart to install.

import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { recordUpdaterEvent } from './telemetry'
import { isBenignUpdaterError, isDiskFullError, scrubUpdaterText } from './updaterErrors'

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  releaseNotes?: string
  error?: string
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
} from './updaterErrors'

// Shown instead of the raw failure when the disk is too full to stage an update (isDiskFullError).
// Squirrel's text names a cache path the user never chose and says nothing about what to do.
export const DISK_FULL_MESSAGE =
  'Not enough free disk space to install the update. Free up some space and Termpolis will try again automatically.'

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

export function initAutoUpdater(
  getMainWindow: () => BrowserWindow | null,
  opts?: {
    /**
     * Called right before quitAndInstall fires. The restart-to-install quit
     * goes through the main window's close event, where the "AI agents are
     * running" guard would otherwise preventDefault it and interject its
     * confirm dialog — cancelling the update restart. The caller uses this to
     * arm a one-way bypass: the user already chose to restart.
     */
    onBeforeQuitAndInstall?: () => void
  },
) {
  // Skip in dev / test runs — electron-updater can't verify unsigned builds
  // and would either no-op or error loudly. We still want the IPC surface
  // mounted so the renderer can render the banner in dev-test fixtures.
  const isDev = !app.isPackaged
  const skipUpdater = isDev || process.env.NODE_ENV === 'test' || process.env.TERMPOLIS_SKIP_UPDATER === '1'

  ipcMain.handle('updater:status', () => currentState)
  ipcMain.handle('updater:quit-and-install', () => {
    if (currentState.status !== 'downloaded') return { success: false, error: 'no update ready' }
    try {
      const au = updaterProvider()
      if (!au) return { success: false, error: 'electron-updater unavailable' }
      try { opts?.onBeforeQuitAndInstall?.() } catch { /* never block the install */ }
      au.quitAndInstall(false, true)
      return { success: true }
    } catch (e) {
      return { success: false, error: String((e as Error).message || e) }
    }
  })
  ipcMain.handle('updater:check', async () => {
    if (skipUpdater) return { success: false, error: 'auto-update disabled in dev/test' }
    try {
      const au = updaterProvider()
      if (!au) return { success: false, error: 'electron-updater unavailable' }
      ignoreDownloadRejection(await au.checkForUpdates())
      return { success: true }
    } catch (e) {
      return { success: false, error: scrubUpdaterText(String((e as Error).message || e)) }
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

  const setState = (s: UpdateState, opts: { report?: boolean } = {}) => {
    currentState = s
    const win = getMainWindow()
    win?.webContents.send('updater:state', s)
    // Tier 2: forward to telemetry as a breadcrumb (or captureMessage on
    // hard error, unless `report: false`). Internally no-ops when the user
    // hasn't opted in.
    try {
      recordUpdaterEvent({
        status: s.status,
        ...(s.version ? { version: s.version } : {}),
        ...(s.error ? { error: s.error } : {}),
        ...(typeof s.downloadedBytes === 'number' ? { downloadedBytes: s.downloadedBytes } : {}),
        ...(typeof s.totalBytes === 'number' ? { totalBytes: s.totalBytes } : {}),
        ...(opts.report === false ? { report: false } : {}),
      })
    } catch { /* never let telemetry crash the updater */ }
  }

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }))
  autoUpdater.on('update-available', (info: any) => {
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
    // Benign, unactionable environmental errors must surface as "no update
    // available" and stay OUT of Sentry instead of reporting a phantom crash:
    //   - a missing app-update.yml (isMissingUpdateConfigError; ELECTRON-8 / #14)
    //   - a transient network failure / offline (isTransientNetworkError;
    //     ELECTRON-9 / #15)
    //   - a transient 5xx / 429 from the update host (isTransientHttpServerError;
    //     ELECTRON-Y / #28)
    //   - the app running from a read-only volume / the .dmg on macOS
    //     (isReadOnlyVolumeError; ELECTRON-E+F / #21+#22)
    if (isBenignUpdaterError(err)) {
      setState({ status: 'not-available' })
      return
    }
    // A full disk is the user's to fix, and an update IS pending — on macOS
    // this fires right after 'update-downloaded', when Squirrel fails to
    // unpack it. Tell them plainly, but don't file it as a crash
    // (isDiskFullError; ELECTRON-Z/10/11 / #29-#31).
    if (isDiskFullError(err)) {
      setState({ status: 'error', error: DISK_FULL_MESSAGE }, { report: false })
      return
    }
    setState({ status: 'error', error: scrubUpdaterText(err?.message || String(err)) })
  })

  // If the update config is absent, every checkForUpdates() would only re-emit
  // the benign ENOENT above. Skip scheduling the periodic checks entirely. The
  // 'error' listener stays registered so a manual updater:check (or any stray
  // emit) is still handled gracefully rather than crashing the main process
  // with an unhandled 'error' event.
  if (!updateConfigExists()) return

  // First check a few seconds after launch; then every 4 hours.
  setTimeout(() => autoUpdater.checkForUpdates().then(ignoreDownloadRejection).catch(() => {}), 10_000)
  setInterval(() => autoUpdater.checkForUpdates().then(ignoreDownloadRejection).catch(() => {}), 4 * 60 * 60 * 1000)
}
