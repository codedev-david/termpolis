import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { detectAvailableShells } from './shellDetector'
import { spawnTerminal, killTerminal, writeToTerminal, resizeTerminal, killAll, getTerminalCwd } from './terminalManager'
import { loadSession, saveSession } from './sessionStore'
import { appendCommand, searchHistory } from './historyStore'
import { readConfigFile, writeConfigFile } from './configFileManager'
import { listPathEntries, listPathCommands, listEnvVars } from './completionService'
import type { SessionData } from './types'

function ok<T>(data?: T) { return { success: true, data } }
function err(error: string) { return { success: false, error } }

let mainWindow: BrowserWindow | null = null

function createWindow() {
  const iconPath = join(__dirname, '../../assets/logo-termpolis.png')
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'Termpolis',
    icon: nativeImage.createFromPath(iconPath),
    backgroundColor: '#1e1e1e',
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

// IPC Handlers
ipcMain.handle('terminal:create', async (_, { id, shellType, cwd }) => {
  try {
    const shells = await detectAvailableShells()
    const shell = shells.find(s => s.type === shellType) ?? shells[0]
    if (!shell) return err('No shell available')
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 5000)
      try {
        spawnTerminal(id, shell.executable, cwd, (data) => {
          mainWindow?.webContents.send('terminal:data', id, data)
        })
        clearTimeout(timeout)
        resolve()
      } catch (e) {
        clearTimeout(timeout)
        reject(e)
      }
    })
    return ok()
  } catch (e: any) {
    return err(e.message ?? 'Failed to create terminal')
  }
})

ipcMain.handle('terminal:kill', async (_, { id }) => {
  try { killTerminal(id); return ok() }
  catch (e: any) { return err(e.message) }
})

ipcMain.on('terminal:write', (_, { id, data }) => writeToTerminal(id, data))
ipcMain.on('terminal:resize', (_, { id, cols, rows }) => resizeTerminal(id, cols, rows))

ipcMain.handle('shell:available', async () => {
  try { return ok(await detectAvailableShells()) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('config:read', async (_, { filePath }) => {
  try { return ok(readConfigFile(filePath)) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('config:write', async (_, { filePath, content }) => {
  try { writeConfigFile(filePath, content); return ok() }
  catch (e: any) { return err(e.message) }
})

ipcMain.on('history:append', (_, { terminalId, terminalName, command }) => {
  try { appendCommand(terminalId, terminalName ?? terminalId, command) } catch {}
})

ipcMain.handle('history:search', async (_, { query }) => {
  try { return ok(searchHistory(query)) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('fs:homedir', () => ok(homedir()))

ipcMain.handle('session:load', async () => {
  try { return ok(loadSession()) }
  catch (e: any) { return err(e.message) }
})

ipcMain.on('session:save', (_, data: SessionData) => {
  try { saveSession(data) } catch {}
})

ipcMain.handle('terminal:export', async (_, { content, defaultFilename }) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: defaultFilename,
      filters: [{ name: 'Text Files', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return ok()
    writeFileSync(result.filePath, content, 'utf-8')
    return ok({ filePath: result.filePath })
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('completion:path-entries', async (_, { dirPath }) => {
  try { return ok(listPathEntries(dirPath)) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('completion:path-commands', async () => {
  try { return ok(listPathCommands()) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('completion:env-vars', async () => {
  try { return ok(listEnvVars()) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('terminal:git-info', async (_, { cwd }) => {
  try {
    let status = ''
    let recentCommits = ''
    try {
      status = execSync('git status --short', { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000, windowsHide: true }).toString().trim()
    } catch {}
    try {
      recentCommits = execSync('git log --oneline -5', { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000, windowsHide: true }).toString().trim()
    } catch {}
    return ok({ status, recentCommits })
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('terminal:status', async (_, { terminalId, fallbackCwd }) => {
  try {
    // Try to get the real CWD from the PTY process
    const liveCwd = getTerminalCwd(terminalId)
    const cwd = liveCwd || fallbackCwd
    let gitBranch = ''
    try {
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, windowsHide: true
      }).toString().trim()
    } catch {}
    return ok({ cwd, gitBranch })
  } catch (e: any) { return err(e.message) }
})

ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on('window:close', () => mainWindow?.close())

// Suppress node-pty async errors (e.g. resize on dead pty) that can't be try-caught
process.on('uncaughtException', (err) => {
  if (err.message?.includes('pty that has already exited')) return
  console.error('Uncaught exception:', err)
})

// Single instance lock — prevent multiple Termpolis windows from corrupting session data
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // Another instance is already running — quit immediately
  app.quit()
} else {
  // When a second instance tries to launch, focus the existing window
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    createWindow()

    // Global hotkey: Win+Shift+T to create a new terminal (works even when minimized)
    globalShortcut.register('Super+Shift+T', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
        mainWindow.webContents.send('global:new-terminal')
      }
    })
  })

  app.on('before-quit', () => { globalShortcut.unregisterAll(); killAll() })
  app.on('window-all-closed', () => {
    killAll()
    if (process.platform !== 'darwin') {
      app.quit()
      // Force exit if quit doesn't complete within 1 second
      setTimeout(() => process.exit(0), 1000)
    }
  })
  app.on('activate', () => { if (!mainWindow) createWindow() })
}
