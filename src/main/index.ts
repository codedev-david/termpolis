import { initMainSentry } from './sentry'
initMainSentry()

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
import { startMcpServer, stopMcpServer, getMcpAuthToken, initAuditLog, type McpToolHandlers } from './mcpServer'
import {
  sendMessage, readMessages, getAllMessages,
  createTask, listTasks, updateTask, clearSwarm,
  type SwarmMessage, type SwarmTask,
} from './swarmManager'
import type { SessionData } from './types'
import { v4 as uuidv4 } from 'uuid'

function ok<T>(data?: T) { return { success: true, data } }
function err(error: string) { return { success: false, error } }

let mainWindow: BrowserWindow | null = null

// Buffer terminal output for MCP read_output (capped at 32KB per terminal)
const terminalOutputBuffers = new Map<string, string>()

// Track terminals created via MCP (swarm) so we can enforce agent commands
const mcpCreatedTerminals = new Set<string>()
const MAX_MCP_TERMINALS = 8 // Cap concurrent swarm agent terminals to limit memory

import { sanitizeAgentCommand } from './agentCommandSanitizer'

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

  // Confirm close when AI agents are running (skip in test mode)
  let forceClose = false
  mainWindow.on('close', (e) => {
    if (forceClose || process.env.NODE_ENV === 'test') return
    // Ask renderer if agents are running, show in-app dialog if so
    const hasAgents = mainWindow?.webContents.executeJavaScript(
      `(() => { try { return window.__termpolis_has_agents?.() ?? false } catch { return false } })()`
    )
    hasAgents?.then((running: boolean) => {
      if (running) {
        // Send event to renderer to show in-app close confirmation dialog
        mainWindow?.webContents.send('app:confirm-close')
      } else {
        forceClose = true
        mainWindow?.close()
      }
    }).catch(() => {
      forceClose = true
      mainWindow?.close()
    })
    e.preventDefault()
  })

  // Renderer confirmed force close
  ipcMain.on('app:force-close', () => {
    forceClose = true
    mainWindow?.close()
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

// IPC Handlers
ipcMain.handle('terminal:create', async (_, { id, shellType, cwd, extraPaths }) => {
  try {
    const shells = await detectAvailableShells()
    const shell = shells.find(s => s.type === shellType) ?? shells[0]
    if (!shell) return err('No shell available')
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 5000)
      try {
        const agentPaths = getAgentExtraPaths()
        const allExtraPaths = [...agentPaths, ...(extraPaths || [])]
        spawnTerminal(id, shell.executable, cwd, (data) => {
          mainWindow?.webContents.send('terminal:data', id, data)
          // Buffer output for MCP read_output
          const existing = terminalOutputBuffers.get(id) || ''
          const updated = existing + data
          terminalOutputBuffers.set(id, updated.length > 32768 ? updated.slice(-32768) : updated)
        }, allExtraPaths)
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
  try { killTerminal(id); terminalOutputBuffers.delete(id); return ok() }
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

ipcMain.handle('dialog:pick-directory', async (_, { defaultPath }) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: defaultPath || homedir(),
      properties: ['openDirectory'],
      title: 'Choose project directory',
    })
    if (result.canceled || !result.filePaths[0]) return ok(null)
    return ok(result.filePaths[0])
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

ipcMain.handle('terminal:git-diff', async (_, { cwd }) => {
  try {
    const diff = execSync('git diff --stat', { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, windowsHide: true }).toString().trim()
    return ok(diff)
  } catch { return ok('') }
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

// Check which AI agent commands are installed on the system
// Find Ollama executable — checks PATH first, then common install locations on Windows
function findOllamaPath(): string | null {
  const execOpts = { stdio: 'ignore' as const, timeout: 3000, windowsHide: true, shell: true }
  try {
    execSync(process.platform === 'win32' ? 'where ollama' : 'which ollama', execOpts)
    return 'ollama' // found in PATH
  } catch {
    // Not in PATH — check common Windows install locations
    if (process.platform === 'win32') {
      const { existsSync } = require('fs')
      const { join } = require('path')
      const home = require('os').homedir()
      const candidates = [
        join(home, 'AppData', 'Local', 'Programs', 'Ollama'),
        'C:\\Program Files\\Ollama',
        join(home, 'AppData', 'Local', 'Ollama'),
      ]
      for (const dir of candidates) {
        if (existsSync(join(dir, 'ollama.exe'))) return dir
      }
    }
    return null
  }
}

// Check common pip/Python install locations for aider on Windows
function findAiderInstalled(): boolean {
  const execOpts = { stdio: 'ignore' as const, timeout: 3000, windowsHide: true, shell: true }
  try {
    execSync(process.platform === 'win32' ? 'where aider' : 'which aider', execOpts)
    return true
  } catch {
    if (process.platform === 'win32') {
      const { existsSync } = require('fs')
      const { join } = require('path')
      const home = require('os').homedir()
      const localPackages = join(home, 'AppData', 'Local', 'Packages')
      // Check Microsoft Store Python installs
      try {
        const { readdirSync } = require('fs')
        const packages = readdirSync(localPackages).filter((d: string) => d.startsWith('PythonSoftwareFoundation'))
        for (const pkg of packages) {
          const scriptsDir = join(localPackages, pkg, 'LocalCache', 'local-packages')
          // Check Python 3.x Scripts directories
          try {
            const subDirs = readdirSync(scriptsDir).filter((d: string) => d.startsWith('Python'))
            for (const sub of subDirs) {
              if (existsSync(join(scriptsDir, sub, 'Scripts', 'aider.exe'))) return true
            }
          } catch {}
        }
      } catch {}
      // Check standard pip install locations
      const candidates = [
        join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'Scripts', 'aider.exe'),
        join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'Scripts', 'aider.exe'),
        join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'Scripts', 'aider.exe'),
        join(home, 'AppData', 'Roaming', 'Python', 'Python311', 'Scripts', 'aider.exe'),
        join(home, 'AppData', 'Roaming', 'Python', 'Python312', 'Scripts', 'aider.exe'),
        join(home, 'AppData', 'Roaming', 'Python', 'Python313', 'Scripts', 'aider.exe'),
      ]
      for (const p of candidates) {
        if (existsSync(p)) return true
      }
    }
    return false
  }
}

// Common agent install locations that GUI apps may not have in PATH
// Terminals spawned from Start Menu/desktop don't inherit user shell PATH
function getAgentExtraPaths(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Roaming', 'npm'),                    // npm global (claude, codex)
      join(home, 'AppData', 'Local', 'pnpm'),                     // pnpm global
      join(home, 'AppData', 'Local', 'Google', 'Cloud SDK', 'bin'), // gemini via gcloud
    ]
  }
  return [
    join(home, '.local', 'bin'),       // Linux/macOS pip, cargo
    '/usr/local/bin',                  // macOS Homebrew
    '/opt/homebrew/bin',               // macOS Apple Silicon Homebrew
  ]
}

// Build a complete PATH for agent detection (extends process.env.PATH)
function getExtendedPath(): string {
  const currentPath = process.env.PATH || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  return [...getAgentExtraPaths(), currentPath].join(sep)
}

// Check if a command exists — tries `where`/`which` first, then scans known install dirs
function findAgentInstalled(command: string): boolean {
  const execOpts = { stdio: 'ignore' as const, timeout: 3000, windowsHide: true, shell: true }
  // Try system where/which first (works when launched from terminal)
  try {
    execSync(process.platform === 'win32' ? `where ${command}` : `which ${command}`, execOpts)
    return true
  } catch {}

  // Fallback: check known install locations directly (works for installed GUI apps)
  const { existsSync } = require('fs')
  const home = homedir()
  const ext = process.platform === 'win32' ? '.cmd' : ''
  const candidates = process.platform === 'win32'
    ? [
        join(home, 'AppData', 'Roaming', 'npm', `${command}${ext}`),
        join(home, 'AppData', 'Roaming', 'npm', `${command}.exe`),
        join(home, 'AppData', 'Local', 'pnpm', `${command}${ext}`),
        join(home, 'AppData', 'Local', 'pnpm', `${command}.exe`),
        join(home, 'AppData', 'Local', 'Google', 'Cloud SDK', 'bin', `${command}${ext}`),
        join(home, 'AppData', 'Local', 'Google', 'Cloud SDK', 'bin', `${command}.exe`),
        join(home, 'AppData', 'Local', 'Programs', command, `${command}.exe`),
      ]
    : [
        join(home, '.local', 'bin', command),
        `/usr/local/bin/${command}`,
        `/opt/homebrew/bin/${command}`,
      ]
  for (const p of candidates) {
    if (existsSync(p)) return true
  }
  return false
}

ipcMain.handle('agents:detect', async () => {
  const agents = ['claude', 'codex', 'gemini']
  const results: Record<string, boolean> = {}
  for (const agent of agents) {
    results[agent] = findAgentInstalled(agent)
  }
  // Aider detection with fallback to common pip install paths
  results['aider'] = findAiderInstalled()
  // Aider+Qwen needs both aider AND ollama
  results['aider-qwen'] = results['aider'] && findOllamaPath() !== null
  return ok(results)
})

// Expose Ollama path for terminal environment injection
ipcMain.handle('agents:ollama-path', async () => {
  return ok(findOllamaPath())
})

// Swarm IPC handlers for the dashboard
// Read terminal output buffer from renderer (used by swarm bridge for non-MCP agents)
ipcMain.handle('terminal:read-buffer', async (_, { terminalId, fromOffset }) => {
  const buffer = terminalOutputBuffers.get(terminalId) || ''
  const sliced = buffer.slice(fromOffset || 0)
  return ok({ output: sliced, length: sliced.length })
})

ipcMain.handle('swarm:messages', async () => ok(getAllMessages()))
ipcMain.handle('swarm:tasks', async () => ok(listTasks()))
ipcMain.handle('swarm:send-message', async (_, { from, to, type, content }) => {
  try { return ok(sendMessage(from, to, type, content)) }
  catch (e: any) { return err(e.message) }
})
ipcMain.handle('swarm:create-task', async (_, { title, description, createdBy, assignTo }) => {
  try { return ok(createTask(title, description, createdBy, assignTo)) }
  catch (e: any) { return err(e.message) }
})
ipcMain.handle('swarm:update-task', async (_, { taskId, status, result }) => {
  try {
    const task = updateTask(taskId, status, result)
    if (!task) return err('Task not found')
    return ok(task)
  } catch (e: any) { return err(e.message) }
})
ipcMain.handle('swarm:clear', async () => {
  try { clearSwarm(); return ok() }
  catch (e: any) { return err(e.message) }
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

  let mcpServer: ReturnType<typeof startMcpServer> | null = null

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    createWindow()

    // Start MCP server for AI agent integration
    const mcpHandlers: McpToolHandlers = {
      listTerminals: () => {
        const session = loadSession()
        return session.terminals.map(t => ({ id: t.id, name: t.name, shellType: t.shellType, cwd: t.cwd }))
      },
      createTerminal: async (name, shell, cwd) => {
        if (mcpCreatedTerminals.size >= MAX_MCP_TERMINALS) {
          throw new Error(`Agent terminal limit reached (${MAX_MCP_TERMINALS}). Close existing agent terminals before creating more.`)
        }
        const id = uuidv4()
        const resolvedCwd = cwd || homedir()
        const shells = await detectAvailableShells()
        const shellInfo = shells.find(s => s.type === shell) || shells[0]
        if (shellInfo) {
          spawnTerminal(id, shellInfo.executable, resolvedCwd, (data) => {
            mainWindow?.webContents.send('terminal:data', id, data)
            // Buffer output for MCP read_output
            const existing = terminalOutputBuffers.get(id) || ''
            const updated = existing + data
            terminalOutputBuffers.set(id, updated.length > 32768 ? updated.slice(-32768) : updated)
          }, getAgentExtraPaths())
        }
        // Track as MCP-created (swarm) terminal for command enforcement
        mcpCreatedTerminals.add(id)
        // Notify renderer to add the terminal to the store
        mainWindow?.webContents.send('mcp:terminal-created', { id, name, shell: shellInfo?.type || shell, cwd: resolvedCwd })
        return id
      },
      runCommand: (terminalId, command) => {
        // Enforce correct agent commands on swarm terminals
        const safeCommand = mcpCreatedTerminals.has(terminalId)
          ? sanitizeAgentCommand(command)
          : command
        writeToTerminal(terminalId, safeCommand + '\r')
      },
      readOutput: (terminalId, lines) => {
        const buffer = terminalOutputBuffers.get(terminalId) || ''
        const allLines = buffer.split('\n')
        const clampedLines = Math.max(1, Math.min(Math.floor(lines) || 50, 1000))
        return allLines.slice(-clampedLines).join('\n')
      },
      closeTerminal: (terminalId) => {
        killTerminal(terminalId)
        terminalOutputBuffers.delete(terminalId)
        mcpCreatedTerminals.delete(terminalId)
        mainWindow?.webContents.send('mcp:terminal-closed', terminalId)
      },
      writeToTerminal: (terminalId, text) => {
        writeToTerminal(terminalId, text)
      },
      getFileTree: (path) => {
        return listPathEntries(path)
      },
      getGitStatus: (cwd) => {
        let status = '', recentCommits = '', branch = ''
        try { status = execSync('git status --short', { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000, windowsHide: true }).toString().trim() } catch {}
        try { recentCommits = execSync('git log --oneline -5', { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000, windowsHide: true }).toString().trim() } catch {}
        try { branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000, windowsHide: true }).toString().trim() } catch {}
        return { status, recentCommits, branch }
      },
      swarmSendMessage: (from, to, type, content) => {
        const validTypes = ['task', 'result', 'question', 'info', 'review'] as const
        if (!validTypes.includes(type as any)) throw new Error(`Invalid message type: ${type}`)
        return sendMessage(from, to, type as typeof validTypes[number], content)
      },
      swarmReadMessages: (terminalId) => {
        return readMessages(terminalId)
      },
      swarmCreateTask: (title, description, createdBy, assignTo) => {
        return createTask(title, description, createdBy, assignTo)
      },
      swarmListTasks: () => {
        return listTasks()
      },
      swarmUpdateTask: (taskId, status, result) => {
        const validStatuses = ['pending', 'in_progress', 'completed', 'failed'] as const
        if (!validStatuses.includes(status as any)) throw new Error(`Invalid task status: ${status}`)
        return updateTask(taskId, status as typeof validStatuses[number], result)
      },
      swarmListAgents: () => {
        const session = loadSession()
        return session.terminals.map(t => ({ id: t.id, name: t.name, shellType: t.shellType, cwd: t.cwd }))
      },
    }

    initAuditLog(app.getPath('userData'))
    mcpServer = startMcpServer(mcpHandlers)
    console.log(`MCP auth token: ${getMcpAuthToken()}`)
    // Write token to a file so AI agents can discover it
    const tokenPath = join(app.getPath('userData'), 'mcp-token')
    require('fs').writeFileSync(tokenPath, getMcpAuthToken(), { encoding: 'utf-8', mode: 0o600 })
    console.log(`MCP token written to: ${tokenPath}`)

    // Auto-register Termpolis as an MCP server in Claude Code's settings
    const adapterPath = app.isPackaged
      ? join(process.resourcesPath, 'mcp-adapter', 'stdio-adapter.cjs')
      : join(__dirname, '../../src/mcp-adapter/stdio-adapter.cjs')

    // Also write standalone config for reference
    const mcpConfigPath = join(app.getPath('userData'), 'claude-mcp-config.json')
    const mcpConfig = { mcpServers: { termpolis: { command: 'node', args: [adapterPath] } } }
    require('fs').writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf-8')

    // Auto-inject into Claude Code's global settings (~/.claude/settings.json)
    // Registers MCP server + auto-trusts all Termpolis tools
    // Uses atomic write (write to temp, then rename) to avoid race conditions
    try {
      const claudeSettingsPath = join(homedir(), '.claude', 'settings.json')
      if (require('fs').existsSync(claudeSettingsPath)) {
        const settings = JSON.parse(require('fs').readFileSync(claudeSettingsPath, 'utf-8'))
        let changed = false

        // Register MCP server
        if (!settings.mcpServers) settings.mcpServers = {}
        const existing = settings.mcpServers.termpolis
        if (!existing || existing.args?.[0] !== adapterPath) {
          settings.mcpServers.termpolis = { command: 'node', args: [adapterPath] }
          changed = true
        }

        // Auto-trust all Termpolis MCP tools so Claude doesn't prompt every time
        if (!settings.permissions) settings.permissions = {}
        if (!settings.permissions.allow) settings.permissions.allow = []
        const termpolisTools = [
          'mcp__termpolis__list_terminals',
          'mcp__termpolis__create_terminal',
          'mcp__termpolis__run_command',
          'mcp__termpolis__read_output',
          'mcp__termpolis__close_terminal',
          'mcp__termpolis__write_to_terminal',
          'mcp__termpolis__get_file_tree',
          'mcp__termpolis__get_git_status',
          'mcp__termpolis__swarm_send_message',
          'mcp__termpolis__swarm_read_messages',
          'mcp__termpolis__swarm_create_task',
          'mcp__termpolis__swarm_list_tasks',
          'mcp__termpolis__swarm_update_task',
          'mcp__termpolis__swarm_list_agents',
        ]
        // Remove old (*) style entries (no longer valid in Claude Code)
        const oldEntries = settings.permissions.allow.filter((p: string) => p.startsWith('mcp__termpolis__') && p.endsWith('(*)'))
        if (oldEntries.length > 0) {
          settings.permissions.allow = settings.permissions.allow.filter((p: string) => !oldEntries.includes(p))
          changed = true
        }

        // Use wildcard rule — covers all current and future termpolis tools
        if (!settings.permissions.allow.includes('mcp__termpolis__*')) {
          settings.permissions.allow.push('mcp__termpolis__*')
          changed = true
        }

        if (changed) {
          const tmpPath = claudeSettingsPath + '.tmp'
          require('fs').writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8')
          require('fs').renameSync(tmpPath, claudeSettingsPath)
          console.log('Auto-registered Termpolis MCP server and tool permissions in Claude Code settings')
        }
      }
    } catch (e) {
      console.log('Could not auto-register in Claude Code settings (non-fatal):', (e as any).message)
    }

    // Also write to ~/.mcp.json (global MCP config that Claude Code actually loads)
    try {
      const globalMcpPath = join(homedir(), '.mcp.json')
      let globalMcp: any = {}
      if (require('fs').existsSync(globalMcpPath)) {
        try { globalMcp = JSON.parse(require('fs').readFileSync(globalMcpPath, 'utf-8')) } catch {}
      }
      const existingGlobal = globalMcp.termpolis
      if (!existingGlobal || existingGlobal.args?.[0] !== adapterPath) {
        globalMcp.termpolis = { command: 'node', args: [adapterPath] }
        const tmpPath = globalMcpPath + '.tmp'
        require('fs').writeFileSync(tmpPath, JSON.stringify(globalMcp, null, 2), 'utf-8')
        require('fs').renameSync(tmpPath, globalMcpPath)
        console.log('Auto-registered Termpolis in global ~/.mcp.json')
      }
    } catch (e) {
      console.log('Could not write ~/.mcp.json (non-fatal):', (e as any).message)
    }

    // Register as a Claude Code local plugin (this is how Claude actually loads MCP servers)
    // Write to BOTH the marketplace source AND the cache (Claude reads from cache at startup)
    try {
      const localMarketplace = join(homedir(), '.claude', 'local-marketplace')
      const pluginDir = join(localMarketplace, 'plugins', 'termpolis')
      const pluginMetaDir = join(pluginDir, '.claude-plugin')
      require('fs').mkdirSync(pluginMetaDir, { recursive: true })

      // Plugin manifest
      const pluginJson = join(pluginMetaDir, 'plugin.json')
      if (!require('fs').existsSync(pluginJson)) {
        require('fs').writeFileSync(pluginJson, JSON.stringify({
          name: 'termpolis',
          description: 'AI-native terminal manager MCP server. Create terminals, run commands, read output, and coordinate multi-agent swarms.',
          author: { name: 'Termpolis' }
        }, null, 2))
      }

      // MCP config for the plugin
      const pluginMcp = join(pluginDir, '.mcp.json')
      const mcpContent = JSON.stringify({ termpolis: { command: 'node', args: [adapterPath] } }, null, 2)
      const existingMcp = require('fs').existsSync(pluginMcp) ? require('fs').readFileSync(pluginMcp, 'utf-8') : ''
      if (existingMcp !== mcpContent) {
        require('fs').writeFileSync(pluginMcp, mcpContent)
      }

      // Enable the plugin in Claude Code settings
      let marketplaceName = 'local-plugins'
      if (require('fs').existsSync(join(homedir(), '.claude', 'settings.json'))) {
        const settings = JSON.parse(require('fs').readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf-8'))
        if (!settings.enabledPlugins) settings.enabledPlugins = {}

        // Detect local marketplace name from settings
        if (settings.extraKnownMarketplaces) {
          for (const [name, config] of Object.entries(settings.extraKnownMarketplaces as Record<string, any>)) {
            if (config?.source?.path?.includes('local-marketplace')) {
              marketplaceName = name
              break
            }
          }
        }

        const pluginKey = `termpolis@${marketplaceName}`
        if (!settings.enabledPlugins[pluginKey]) {
          settings.enabledPlugins[pluginKey] = true
          const tmpPath = join(homedir(), '.claude', 'settings.json.tmp')
          require('fs').writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8')
          require('fs').renameSync(tmpPath, join(homedir(), '.claude', 'settings.json'))
          console.log(`Enabled Termpolis plugin as ${pluginKey}`)
        }
      }
      // Also write directly to the plugin cache (Claude reads from cache at startup)
      const cacheDir = join(homedir(), '.claude', 'plugins', 'cache', marketplaceName, 'termpolis', '1.0.0')
      const cacheMetaDir = join(cacheDir, '.claude-plugin')
      require('fs').mkdirSync(cacheMetaDir, { recursive: true })
      require('fs').writeFileSync(join(cacheMetaDir, 'plugin.json'), JSON.stringify({
        name: 'termpolis',
        description: 'AI-native terminal manager MCP server. Create terminals, run commands, read output, and coordinate multi-agent swarms.',
        author: { name: 'Termpolis' }
      }, null, 2))
      require('fs').writeFileSync(join(cacheDir, '.mcp.json'), mcpContent)
      console.log('Termpolis plugin cached at:', cacheDir)

      // Register in marketplace.json manifest (required for Claude to discover the plugin)
      const marketplaceJsonPath = join(localMarketplace, '.claude-plugin', 'marketplace.json')
      if (require('fs').existsSync(marketplaceJsonPath)) {
        const manifest = JSON.parse(require('fs').readFileSync(marketplaceJsonPath, 'utf-8'))
        if (manifest.plugins && !manifest.plugins.some((p: any) => p.name === 'termpolis')) {
          manifest.plugins.push({
            name: 'termpolis',
            description: 'AI-native terminal manager MCP server. Create terminals, run commands, read output, manage split panes, and coordinate multi-agent swarms.',
            version: '1.0.0',
            author: { name: 'Termpolis' },
            source: './plugins/termpolis',
            category: 'development',
            strict: false,
          })
          const tmpManifest = marketplaceJsonPath + '.tmp'
          require('fs').writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2), 'utf-8')
          require('fs').renameSync(tmpManifest, marketplaceJsonPath)
          console.log('Registered Termpolis in marketplace.json manifest')
        }
      }
    } catch (e) {
      console.log('Could not register Claude Code plugin (non-fatal):', (e as any).message)
    }

    // Auto-register in Codex CLI (~/.codex/config.toml)
    try {
      const codexConfigPath = join(homedir(), '.codex', 'config.toml')
      if (require('fs').existsSync(codexConfigPath)) {
        const content = require('fs').readFileSync(codexConfigPath, 'utf-8')
        if (!content.includes('[mcp_servers.termpolis]')) {
          const tomlEntry = `\n[mcp_servers.termpolis]\ncommand = "node"\nargs = ["${adapterPath.replace(/\\/g, '\\\\')}"]\n`
          require('fs').appendFileSync(codexConfigPath, tomlEntry, 'utf-8')
          console.log('Auto-registered Termpolis MCP server in Codex CLI config')
        }
      }
    } catch (e) {
      console.log('Could not register in Codex config (non-fatal):', (e as any).message)
    }

    // Auto-register in Gemini CLI (~/.gemini/settings.json)
    try {
      const geminiSettingsPath = join(homedir(), '.gemini', 'settings.json')
      if (require('fs').existsSync(geminiSettingsPath)) {
        const settings = JSON.parse(require('fs').readFileSync(geminiSettingsPath, 'utf-8'))
        if (!settings.mcpServers) settings.mcpServers = {}
        if (!settings.mcpServers.termpolis) {
          settings.mcpServers.termpolis = {
            command: 'node',
            args: [adapterPath],
          }
          const tmpPath = geminiSettingsPath + '.tmp'
          require('fs').writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8')
          require('fs').renameSync(tmpPath, geminiSettingsPath)
          console.log('Auto-registered Termpolis MCP server in Gemini CLI settings')
        }
      }
    } catch (e) {
      console.log('Could not register in Gemini settings (non-fatal):', (e as any).message)
    }

    // Global hotkey: Win+Shift+T to create a new terminal (works even when minimized)
    globalShortcut.register('Super+Shift+T', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
        mainWindow.webContents.send('global:new-terminal')
      }
    })

    // Global hotkey: Win+Shift+S to open/close swarm dashboard
    globalShortcut.register('Super+Shift+S', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
        mainWindow.webContents.send('global:toggle-swarm')
      }
    })
  })

  app.on('before-quit', () => {
    globalShortcut.unregisterAll()
    killAll()
    if (mcpServer) { stopMcpServer(mcpServer); mcpServer = null }
  })
  app.on('window-all-closed', () => {
    killAll()
    if (mcpServer) { stopMcpServer(mcpServer); mcpServer = null }
    if (process.platform !== 'darwin') {
      app.quit()
      // Force exit — MCP server or PTY processes may keep event loop alive
      setTimeout(() => process.exit(0), 500)
    }
  })
  app.on('activate', () => { if (!mainWindow) createWindow() })
}
