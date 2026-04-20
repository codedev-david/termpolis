// Auto-updater wiring for Termpolis.
//
// On startup (after the main window loads) we ask GitHub for the latest
// release metadata. If a newer version exists, electron-updater downloads
// it in the background and emits `update-downloaded`. The renderer is
// notified via IPC so it can show a toast; the user chooses when to
// restart to install.

import { app, BrowserWindow, ipcMain } from 'electron'

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  releaseNotes?: string
  error?: string
  downloadedBytes?: number
  totalBytes?: number
}

let currentState: UpdateState = { status: 'idle' }

export function initAutoUpdater(getMainWindow: () => BrowserWindow | null) {
  // Skip in dev / test runs — electron-updater can't verify unsigned builds
  // and would either no-op or error loudly. We still want the IPC surface
  // mounted so the renderer can render the banner in dev-test fixtures.
  const isDev = !app.isPackaged
  const skipUpdater = isDev || process.env.NODE_ENV === 'test' || process.env.TERMPOLIS_SKIP_UPDATER === '1'

  ipcMain.handle('updater:status', () => currentState)
  ipcMain.handle('updater:quit-and-install', () => {
    if (currentState.status !== 'downloaded') return { success: false, error: 'no update ready' }
    // Dynamically require to avoid bundling in dev.
    try {
      const { autoUpdater } = require('electron-updater')
      autoUpdater.quitAndInstall(false, true)
      return { success: true }
    } catch (e) {
      return { success: false, error: String((e as Error).message || e) }
    }
  })
  ipcMain.handle('updater:check', async () => {
    if (skipUpdater) return { success: false, error: 'auto-update disabled in dev/test' }
    try {
      const { autoUpdater } = require('electron-updater')
      await autoUpdater.checkForUpdates()
      return { success: true }
    } catch (e) {
      return { success: false, error: String((e as Error).message || e) }
    }
  })

  if (skipUpdater) return

  let autoUpdater: any
  try {
    autoUpdater = require('electron-updater').autoUpdater
  } catch {
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
    setState({ status: 'error', error: err?.message || String(err) })
  })

  // First check a few seconds after launch; then every 4 hours.
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10_000)
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000)
}
