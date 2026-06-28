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

// electron-updater reads `resources/app-update.yml` at the start of every
// checkForUpdates(). When that file is absent — an interrupted/partial install,
// an antivirus quarantine, a manual delete — it emits an ENOENT 'error'. Auto-
// update genuinely cannot run without it and there is nothing the app can do
// about it at runtime, so this is a benign, unactionable environmental state,
// NOT a production crash. We detect it so it never gets reported to Sentry as an
// error (was Sentry issue ELECTRON-8 / GitHub #14).
export function isMissingUpdateConfigError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return /ENOENT/i.test(msg) && /app-update\.yml/i.test(msg)
}

// A transient network failure during an update check: the user is offline, on a
// flaky/captive-portal connection, or the update host is briefly unreachable.
// electron-updater surfaces these as Chromium net errors (net::ERR_*) or Node
// socket errnos. Auto-update simply can't reach the server — there's nothing to
// fix and the user did nothing wrong — so it must NEVER be reported to Sentry as
// a production error (was Sentry issue ELECTRON-9 / GitHub #15:
// "updater error: net::ERR_INTERNET_DISCONNECTED"). Matches only connectivity
// failures, so genuine errors (e.g. sha512 mismatch) still report.
export function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return (
    /net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED|CONNECTION_(RESET|REFUSED|CLOSED|TIMED_OUT)|TIMED_OUT|ADDRESS_UNREACHABLE|NETWORK_ACCESS_DENIED|PROXY_CONNECTION_FAILED)/i.test(
      msg,
    ) || /\b(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b/.test(msg)
  )
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
      await au.checkForUpdates()
      return { success: true }
    } catch (e) {
      return { success: false, error: String((e as Error).message || e) }
    }
  })

  if (skipUpdater) return

  const autoUpdater = updaterProvider()
  if (!autoUpdater) {
    // electron-updater not available in this environment — give up quietly.
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false

  const setState = (s: UpdateState) => {
    currentState = s
    const win = getMainWindow()
    win?.webContents.send('updater:state', s)
    // Tier 2: forward to telemetry as a breadcrumb (or captureMessage on
    // hard error). Internally no-ops when the user hasn't opted in.
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
    if (isMissingUpdateConfigError(err) || isTransientNetworkError(err)) {
      setState({ status: 'not-available' })
      return
    }
    setState({ status: 'error', error: err?.message || String(err) })
  })

  // If the update config is absent, every checkForUpdates() would only re-emit
  // the benign ENOENT above. Skip scheduling the periodic checks entirely. The
  // 'error' listener stays registered so a manual updater:check (or any stray
  // emit) is still handled gracefully rather than crashing the main process
  // with an unhandled 'error' event.
  if (!updateConfigExists()) return

  // First check a few seconds after launch; then every 4 hours.
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10_000)
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000)
}
