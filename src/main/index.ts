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
import { startMcpServer, stopMcpServer, getMcpAuthToken, type McpToolHandlers } from './mcpServer'
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
          // Buffer output for MCP read_output
          const existing = terminalOutputBuffers.get(id) || ''
          const updated = existing + data
          terminalOutputBuffers.set(id, updated.length > 32768 ? updated.slice(-32768) : updated)
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
ipcMain.handle('agents:detect', async () => {
  const agents = [
    { id: 'claude', command: 'claude' },
    { id: 'codex', command: 'codex' },
    { id: 'gemini', command: 'gemini' },
    { id: 'aider', command: 'aider' },
  ]
  const results: Record<string, boolean> = {}
  for (const agent of agents) {
    try {
      execSync(process.platform === 'win32' ? `where ${agent.command}` : `which ${agent.command}`, { stdio: 'ignore', timeout: 3000, windowsHide: true })
      results[agent.id] = true
    } catch {
      results[agent.id] = false
    }
  }
  // Aider+Qwen needs both aider AND ollama
  results['aider-qwen'] = results['aider'] && (() => {
    try {
      execSync(process.platform === 'win32' ? 'where ollama' : 'which ollama', { stdio: 'ignore', timeout: 3000, windowsHide: true })
      return true
    } catch { return false }
  })()
  return ok(results)
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
          })
        }
        // Notify renderer to add the terminal to the store
        mainWindow?.webContents.send('mcp:terminal-created', { id, name, shell: shellInfo?.type || shell, cwd: resolvedCwd })
        return id
      },
      runCommand: (terminalId, command) => {
        writeToTerminal(terminalId, command + '\r')
      },
      readOutput: (terminalId, lines) => {
        const buffer = terminalOutputBuffers.get(terminalId) || ''
        const allLines = buffer.split('\n')
        return allLines.slice(-lines).join('\n')
      },
      closeTerminal: (terminalId) => {
        killTerminal(terminalId)
        terminalOutputBuffers.delete(terminalId)
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
        return sendMessage(from, to, type as any, content)
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
        return updateTask(taskId, status as any, result)
      },
      swarmListAgents: () => {
        const session = loadSession()
        return session.terminals.map(t => ({ id: t.id, name: t.name, shellType: t.shellType, cwd: t.cwd }))
      },
    }

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
        for (const tool of termpolisTools) {
          const permission = `${tool}(*)`
          if (!settings.permissions.allow.includes(permission)) {
            settings.permissions.allow.push(permission)
            changed = true
          }
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
