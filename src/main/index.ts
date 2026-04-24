import { initMainSentry } from './sentry'
initMainSentry()

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, shell } from 'electron'

// Force a stable app name. When launched via `electron out/main/index.js`
// (dev, E2E tests) Electron defaults to "Electron" for app.getName() and
// therefore stores userData under ~/AppData/Roaming/Electron instead of
// ~/AppData/Roaming/termpolis. That mismatch causes external callers
// (MCP clients, tests) to read a stale mcp-token from the wrong dir and
// hit 401. Pinning the name keeps userData consistent across all launch
// modes (unpacked, packaged, CI).
app.setName('termpolis')

// Linux AppImage: the bundled chrome-sandbox lacks SUID root, which crashes on
// launch. Use Chromium's namespace sandbox instead (no root needed).
if (process.platform === 'linux' && (process.env.APPIMAGE || !process.env.CHROME_DEVEL_SANDBOX)) {
  app.commandLine.appendSwitch('no-sandbox')
}
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
import { startMcpServer, stopMcpServer, getMcpAuthToken, getMcpPort, awaitMcpPortBound, initAuditLog, type McpToolHandlers } from './mcpServer'
import {
  sendMessage, readMessages, getAllMessages,
  createTask, listTasks, updateTask, clearSwarm,
  type SwarmMessage, type SwarmTask,
} from './swarmManager'
import {
  initEventBus, query as queryEvents, subscribe as subscribeEvents,
  getRingSize, getDroppedCount, shutdownEventBus,
  type AgentEvent, type EventFilter,
} from './agentEventBus'
import {
  attachWatcher, detachWatchers, detachAll as detachAllWatchers,
  type DetectedAgent,
} from './transcriptWatchers'
import {
  initContextPinStore,
  listPins, addPin, removePin, updatePin, clearPins,
  type ContextPin,
} from './contextPinStore'
import {
  initSwarmMemory,
  memoryWrite, memorySearch, memoryList, memoryCount, memoryClear,
  type MemoryEntry,
} from './swarmMemory'
import { initAutoUpdater } from './autoUpdater'
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
import { safeGit, isValidGitRef, parseSafeCommand, runSafeCommand } from './gitCommand'
import { writeSecureFile } from './secureFile'
import {
  initWorkspaceTrust,
  isWorkspaceTrusted,
  trustWorkspace,
  revokeWorkspaceTrust,
  listTrustedWorkspaces,
  ensureWorkspaceTrust,
} from './workspaceTrust'
import {
  registerInClaudeSettings,
  registerInGlobalMcp,
  registerInCodex,
  registerInGemini,
} from './agentMcpRegistry'

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
  try {
    killTerminal(id)
    terminalOutputBuffers.delete(id)
    try { detachWatchers(id) } catch {}
    return ok()
  } catch (e: any) { return err(e.message) }
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

// The renderer (conductorManager) needs to pass --mcp-config <path> to
// `claude -p` so headless Claude Code sessions actually load the Termpolis
// MCP server. Without this, even though `claude mcp list` shows termpolis
// as connected, -p mode bypasses user-scope plugins and the swarm runs
// with zero tools. We write the config file at startup (see mcpConfigPath
// below); this handler just hands the resolved absolute path to the renderer.
ipcMain.handle('fs:mcp-config-path', () =>
  ok(join(app.getPath('userData'), 'claude-mcp-config.json')),
)

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

ipcMain.handle('diagnostics:collect', async () => {
  try {
    const { collectDiagnostics } = await import('./diagnostics')
    return ok(collectDiagnostics())
  } catch (e: any) { return err(e.message) }
})

// Open a URL in the user's default browser. Scoped to http(s) only —
// refuse file://, javascript:, chrome:, etc. so a misbehaving renderer
// cannot use this surface to launch local helpers or navigate to a
// dangerous scheme. The Report-a-Problem flow is the only current caller.
ipcMain.handle('shell:open-external', async (_, { url }: { url: string }) => {
  try {
    if (typeof url !== 'string') return err('url must be a string')
    let parsed: URL
    try { parsed = new URL(url) } catch { return err('invalid url') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return err(`disallowed protocol: ${parsed.protocol}`)
    }
    await shell.openExternal(url)
    return ok()
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('shell:open-path', async (_, { path: pathStr }) => {
  try {
    const errorMsg = await shell.openPath(pathStr)
    if (errorMsg) return err(errorMsg)
    return ok()
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('dialog:pick-directory', async (_, { defaultPath }) => {
  try {
    if (process.env.TERMPOLIS_TEST_PROJECT_CWD) {
      trustWorkspace(process.env.TERMPOLIS_TEST_PROJECT_CWD)
      return ok(process.env.TERMPOLIS_TEST_PROJECT_CWD)
    }
    const result = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: defaultPath || homedir(),
      properties: ['openDirectory'],
      title: 'Choose project directory',
    })
    if (result.canceled || !result.filePaths[0]) return ok(null)
    // Picking a folder through the native dialog is an explicit user
    // action — auto-trust so the user isn't double-prompted before the
    // first swarm run.
    trustWorkspace(result.filePaths[0])
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
    const diff = safeGit(['diff', '--stat'], { cwd, timeout: 5000 }).trim()
    return ok(diff)
  } catch { return ok('') }
})

// Git operations for the Git Panel
ipcMain.handle('git:stage', async (_, { cwd, files }: { cwd: string; files: string[] }) => {
  try {
    const args = files.length > 0 ? ['add', '--', ...files] : ['add', '.']
    safeGit(args, { cwd, timeout: 10000 })
    return ok()
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('git:unstage', async (_, { cwd, files }: { cwd: string; files: string[] }) => {
  try {
    const args = files.length > 0 ? ['reset', 'HEAD', '--', ...files] : ['reset', 'HEAD', '.']
    safeGit(args, { cwd, timeout: 10000 })
    return ok()
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('git:commit', async (_, { cwd, message }: { cwd: string; message: string }) => {
  try {
    if (!message.trim()) return err('Commit message cannot be empty')
    safeGit(['commit', '-m', message], { cwd, timeout: 30000 })
    return ok()
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('git:pull', async (_, { cwd }: { cwd: string }) => {
  try {
    const output = safeGit(['pull'], { cwd, timeout: 60000 }).trim()
    return ok(output)
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('git:push', async (_, { cwd }: { cwd: string }) => {
  try {
    const output = safeGit(['push'], { cwd, timeout: 60000 }).trim()
    return ok(output)
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('git:file-diff', async (_, { cwd, file }: { cwd: string; file: string }) => {
  try {
    const diff = safeGit(['diff', '--', file], { cwd, timeout: 5000 })
    return ok(diff)
  } catch { return ok('') }
})

ipcMain.handle('git:find-root', async (_, { cwd }: { cwd: string }) => {
  try {
    const root = safeGit(['rev-parse', '--show-toplevel'], { cwd, timeout: 3000 }).trim()
    return ok(root)
  } catch { return ok(null) }
})

// Swarm Review: capture the HEAD SHA at a point in time so we can diff the full
// swarm delta later. Returns null when outside a repo so the caller can skip
// review mode cleanly.
ipcMain.handle('git:rev-parse-head', async (_, { cwd }: { cwd: string }) => {
  try {
    const sha = safeGit(['rev-parse', 'HEAD'], { cwd, timeout: 3000 }).trim()
    return ok(sha)
  } catch { return ok(null) }
})

// Swarm Review: unified diff across a range. If `to` is omitted we diff against
// working tree + index so uncommitted swarm changes are included.
ipcMain.handle('git:diff-range', async (_, { cwd, from, to }: { cwd: string; from: string; to?: string }) => {
  try {
    if (!isValidGitRef(from)) return err('Invalid "from" ref')
    if (to !== undefined && !isValidGitRef(to)) return err('Invalid "to" ref')
    const range = to ? `${from}..${to}` : from
    const diff = safeGit(['diff', '--no-color', '--no-ext-diff', range], {
      cwd, timeout: 15000, maxBuffer: 16 * 1024 * 1024,
    })
    return ok(diff)
  } catch (e: any) { return err(e.message) }
})

// Swarm Review: list files changed between two refs (or from ref to working tree).
// Returns [{file, status}] where status is A/M/D/R100/etc.
ipcMain.handle('git:files-in-range', async (_, { cwd, from, to }: { cwd: string; from: string; to?: string }) => {
  try {
    if (!isValidGitRef(from)) return err('Invalid "from" ref')
    if (to !== undefined && !isValidGitRef(to)) return err('Invalid "to" ref')
    const range = to ? `${from}..${to}` : from
    const raw = safeGit(['diff', '--name-status', range], { cwd, timeout: 5000 }).trim()
    const files: { file: string; status: string }[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      const status = parts[0]
      // Renames look like "R100\told\tnew"; take the final name
      const file = parts[parts.length - 1]
      files.push({ file, status })
    }
    return ok(files)
  } catch (e: any) { return err(e.message) }
})

// Swarm Review: apply a patch string. Used to reverse-apply a single hunk to
// reject a change. reverse=true maps to `git apply -R`.
ipcMain.handle('git:apply-patch', async (_, { cwd, patch, reverse }: { cwd: string; patch: string; reverse?: boolean }) => {
  try {
    if (!patch || !patch.trim()) return err('Empty patch')
    const tmpPath = join(homedir(), `.termpolis-patch-${Date.now()}.diff`)
    writeFileSync(tmpPath, patch, 'utf8')
    try {
      const args = reverse
        ? ['apply', '-R', '--whitespace=nowarn', tmpPath]
        : ['apply', '--whitespace=nowarn', tmpPath]
      safeGit(args, { cwd, timeout: 10000 })
      return ok()
    } finally {
      try { require('fs').unlinkSync(tmpPath) } catch {}
    }
  } catch (e: any) { return err(e.message) }
})

// Swarm Review: restore one or more files to a specific SHA. Used for
// "reject this entire file" without touching other files.
ipcMain.handle('git:checkout-file', async (_, { cwd, sha, files }: { cwd: string; sha: string; files: string[] }) => {
  try {
    if (!files.length) return err('No files specified')
    if (!isValidGitRef(sha)) return err('Invalid SHA')
    safeGit(['checkout', sha, '--', ...files], { cwd, timeout: 10000 })
    return ok()
  } catch (e: any) { return err(e.message) }
})

// Swarm Review: hard reset back to pre-swarm SHA (revert-all). Destructive —
// UI must confirm before calling.
ipcMain.handle('git:reset-hard', async (_, { cwd, sha }: { cwd: string; sha: string }) => {
  try {
    if (!sha || !/^[a-f0-9]{7,40}$/i.test(sha)) return err('Invalid SHA')
    safeGit(['reset', '--hard', sha], { cwd, timeout: 10000 })
    return ok()
  } catch (e: any) { return err(e.message) }
})

// Swarm Review: stage everything then commit. Separate from git:commit because
// that one only commits already-staged changes.
ipcMain.handle('git:commit-all', async (_, { cwd, message }: { cwd: string; message: string }) => {
  try {
    if (!message.trim()) return err('Commit message cannot be empty')
    safeGit(['add', '-A'], { cwd, timeout: 15000 })
    safeGit(['commit', '-m', message], { cwd, timeout: 30000 })
    return ok()
  } catch (e: any) { return err(e.message) }
})

// Shared swarm memory — RAG layer so agents and the UI can write / retrieve
// facts across terminals without re-running expensive tools.
ipcMain.handle('memory:write', async (_, input: { agentId: string; kind: string; content: string; tags?: string[]; taskId?: string }) => {
  try {
    const entry = await memoryWrite({
      agentId: input.agentId,
      kind: (input.kind as MemoryEntry['kind']) || 'note',
      content: input.content,
      tags: input.tags,
      taskId: input.taskId,
    })
    return ok(entry)
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('memory:search', async (_, opts: { query: string; limit?: number; agentId?: string; kind?: string; taskId?: string }) => {
  try {
    const results = await memorySearch({
      query: opts.query,
      limit: opts.limit,
      agentId: opts.agentId,
      kind: opts.kind as MemoryEntry['kind'] | undefined,
      taskId: opts.taskId,
    })
    return ok(results)
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('memory:list', async (_, opts: { limit?: number; agentId?: string; kind?: string; since?: number } = {}) => {
  try {
    const list = memoryList({
      limit: opts.limit,
      agentId: opts.agentId,
      kind: opts.kind as MemoryEntry['kind'] | undefined,
      since: opts.since,
    })
    return ok(list)
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('memory:count', () => ok(memoryCount()))
ipcMain.handle('memory:clear', () => { memoryClear(); return ok() })

// Swarm Review: run the project's test runner and capture stdout/stderr/exitCode.
// Locked down to an allowlist of known test runners (npm/yarn/pytest/cargo/…)
// with zero shell metacharacters, so a compromised renderer or MCP client
// can't turn this into arbitrary RCE. 10 minute cap.
ipcMain.handle('workspace:is-trusted', async (_, { cwd }: { cwd: string }) => {
  try { return ok(isWorkspaceTrusted(cwd)) } catch (e: any) { return err(e.message) }
})

ipcMain.handle('workspace:trust', async (_, { cwd }: { cwd: string }) => {
  try { trustWorkspace(cwd); return ok() } catch (e: any) { return err(e.message) }
})

ipcMain.handle('workspace:revoke-trust', async (_, { cwd }: { cwd: string }) => {
  try { revokeWorkspaceTrust(cwd); return ok() } catch (e: any) { return err(e.message) }
})

ipcMain.handle('workspace:list-trusted', async () => {
  try { return ok(listTrustedWorkspaces()) } catch (e: any) { return err(e.message) }
})

ipcMain.handle('swarm:run-command', async (_, { cwd, command }: { cwd: string; command: string }) => {
  const parsed = parseSafeCommand(command)
  if ('error' in parsed) return err(parsed.error)
  // Workspace trust gate: repo-controlled scripts (e.g. npm test) run whatever
  // the package.json author put in the script, so an untrusted repo could
  // execute arbitrary code. Prompt once per folder; auto-trust on dialog pick.
  const trusted = await ensureWorkspaceTrust({
    cwd,
    reason: `Running "${command}"`,
    parentWindow: mainWindow,
  })
  if (!trusted) return err('Workspace not trusted — command cancelled')
  const result = runSafeCommand(parsed, { cwd, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
  return ok(result)
})

ipcMain.handle('git:status-parsed', async (_, { cwd }: { cwd: string }) => {
  try {
    let branch = ''
    try { branch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 2000 }).trim() } catch {}
    const statusRaw = safeGit(['status', '--porcelain'], { cwd, timeout: 5000 }).trim()
    const staged: { file: string; status: string }[] = []
    const unstaged: { file: string; status: string }[] = []
    for (const line of statusRaw.split('\n')) {
      if (!line.trim()) continue
      const indexStatus = line[0]
      const workTreeStatus = line[1]
      const file = line.slice(3).trim()
      if (indexStatus !== ' ' && indexStatus !== '?') staged.push({ file, status: indexStatus })
      if (workTreeStatus !== ' ' && workTreeStatus !== undefined) unstaged.push({ file, status: workTreeStatus === '?' ? 'U' : workTreeStatus })
    }
    return ok({ branch, staged, unstaged })
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('terminal:git-info', async (_, { cwd }) => {
  try {
    let status = ''
    let recentCommits = ''
    try {
      status = safeGit(['status', '--short'], { cwd, timeout: 3000 }).trim()
    } catch {}
    try {
      recentCommits = safeGit(['log', '--oneline', '-5'], { cwd, timeout: 3000 }).trim()
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
      gitBranch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 2000 }).trim()
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
  // Test hook: force a comma-separated list of agent ids to report as not installed,
  // so Playwright can deterministically open the InstallHint modal for that agent.
  const forceMissing = process.env.TERMPOLIS_FORCE_MISSING_AGENTS
  if (forceMissing) {
    for (const id of forceMissing.split(',').map((s) => s.trim()).filter(Boolean)) {
      results[id] = false
    }
  }
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

// ---- Agent Event Bus IPC ----
// Query the recent event ring (renderer drives pagination via `since`/`limit`)
ipcMain.handle('agentActivity:query', async (_, { filter }: { filter?: EventFilter } = {}) => {
  try { return ok(queryEvents(filter || {})) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('agentActivity:stats', async () => {
  try { return ok({ ringSize: getRingSize(), dropped: getDroppedCount() }) }
  catch (e: any) { return err(e.message) }
})

// ---- Context Pin IPC ----
ipcMain.handle('contextPins:list', async (_, { cwd }: { cwd: string }) => {
  try { return ok(listPins(cwd)) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('contextPins:add', async (_, { cwd, input }: { cwd: string; input: { label: string; body: string; source?: string; tags?: string[] } }) => {
  try { return ok(addPin(cwd, input)) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('contextPins:update', async (_, { cwd, id, patch }: { cwd: string; id: string; patch: Partial<ContextPin> }) => {
  try {
    const r = updatePin(cwd, id, patch)
    if (!r) return err('pin not found')
    return ok(r)
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('contextPins:remove', async (_, { cwd, id }: { cwd: string; id: string }) => {
  try { return ok({ removed: removePin(cwd, id) }) }
  catch (e: any) { return err(e.message) }
})

ipcMain.handle('contextPins:clear', async (_, { cwd }: { cwd: string }) => {
  try { clearPins(cwd); return ok() }
  catch (e: any) { return err(e.message) }
})

// ---- Transcript Watcher IPC ----
// Renderer calls these when an agent is detected / terminal closes
ipcMain.handle('agentWatcher:attach', async (_, { terminalId, cwd, agentType }: { terminalId: string; cwd: string; agentType: DetectedAgent }) => {
  try {
    const handle = attachWatcher(terminalId, cwd, agentType)
    return ok({ attached: handle !== null })
  } catch (e: any) { return err(e.message) }
})

ipcMain.handle('agentWatcher:detach', async (_, { terminalId }: { terminalId: string }) => {
  try { detachWatchers(terminalId); return ok() }
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

    // Check GitHub releases for updates, auto-download in background,
    // notify renderer when ready to install.
    initAutoUpdater(() => mainWindow)

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
        try { status = safeGit(['status', '--short'], { cwd, timeout: 3000 }).trim() } catch {}
        try { recentCommits = safeGit(['log', '--oneline', '-5'], { cwd, timeout: 3000 }).trim() } catch {}
        try { branch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 3000 }).trim() } catch {}
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
      memoryWrite: (input) => memoryWrite({
        agentId: input.agentId,
        kind: (input.kind as MemoryEntry['kind']) || 'note',
        content: input.content,
        tags: input.tags,
        taskId: input.taskId,
      }),
      memorySearch: (opts) => memorySearch({
        query: opts.query,
        limit: opts.limit,
        agentId: opts.agentId,
        kind: opts.kind as MemoryEntry['kind'] | undefined,
        taskId: opts.taskId,
      }),
      memoryList: (opts) => memoryList({
        limit: opts.limit,
        agentId: opts.agentId,
        kind: opts.kind as MemoryEntry['kind'] | undefined,
        since: opts.since,
      }),
    }

    initAuditLog(app.getPath('userData'))
    initEventBus(app.getPath('userData'))
    initContextPinStore(app.getPath('userData'))
    initSwarmMemory(app.getPath('userData'))
    initWorkspaceTrust()
    // Push events to the renderer (live feed)
    subscribeEvents((event: AgentEvent) => {
      try { mainWindow?.webContents.send('agentActivity:event', event) } catch {}
      // Auto-ingest swarm messages/results into shared memory so other agents
      // can RAG-retrieve context without re-running the same tools.
      try {
        if ((event.kind === 'message' || event.kind === 'tool-result') && event.summary) {
          memoryWrite({
            agentId: event.terminalId || event.agentType || 'unknown',
            kind: event.kind === 'message' ? 'message' : 'result',
            content: event.summary,
            tags: [event.agentType].filter(Boolean) as string[],
            ...(event.taskId && { taskId: event.taskId }),
          }).catch(() => { /* ignore */ })
        }
      } catch { /* ignore */ }
    })
    mcpServer = startMcpServer(mcpHandlers)
    console.log(`MCP auth token: ${getMcpAuthToken()}`)
    // Write token to a file so AI agents can discover it. On Windows the
    // 0o600 mode is a no-op, so writeSecureFile also applies an NTFS ACL
    // restricting the file to the current user.
    const tokenPath = join(app.getPath('userData'), 'mcp-token')
    const tokenWrite = writeSecureFile(tokenPath, getMcpAuthToken())
    if (!tokenWrite.aclApplied) {
      console.warn(`[mcp-token] ACL not applied on ${tokenPath}: ${tokenWrite.aclError}`)
    }
    console.log(`MCP token written to: ${tokenPath}`)
    // Write the actual port (may differ from 9315 if port was taken).
    // awaitMcpPortBound resolves when server.listen succeeds on any of the
    // 5 candidate ports — unlike the old setTimeout(500, ...) this can't race.
    const portPath = join(app.getPath('userData'), 'mcp-port')
    awaitMcpPortBound().then((boundPort) => {
      const portWrite = writeSecureFile(portPath, String(boundPort))
      if (!portWrite.aclApplied) {
        console.warn(`[mcp-port] ACL not applied on ${portPath}: ${portWrite.aclError}`)
      }
      console.log(`MCP port written to: ${portPath} (port ${boundPort})`)
    }).catch((err) => {
      console.error(`[mcp-port] Failed to bind MCP server, port file not written: ${err.message}`)
    })

    // Auto-register Termpolis as an MCP server in Claude Code's settings
    const adapterPath = app.isPackaged
      ? join(process.resourcesPath, 'mcp-adapter', 'stdio-adapter.cjs')
      : join(__dirname, '../../src/mcp-adapter/stdio-adapter.cjs')

    // Preflight — if the adapter file isn't on disk, EVERY Claude Code session
    // will silently fail to register the Termpolis MCP server, and the
    // conductor will bypass the swarm. Logging this loudly on startup turns
    // a silent packaging bug into a visible one.
    if (!require('fs').existsSync(adapterPath)) {
      const msg = `[FATAL] MCP stdio adapter not found at ${adapterPath} — the swarm conductor will have NO MCP tools. Check electron-builder extraResources config.`
      console.error(msg)
      try {
        const Sentry = require('@sentry/electron/main')
        Sentry.captureMessage?.(msg, 'error')
      } catch {}
    }

    // Also write standalone config for reference
    const mcpConfigPath = join(app.getPath('userData'), 'claude-mcp-config.json')
    const mcpConfig = { mcpServers: { termpolis: { command: 'node', args: [adapterPath] } } }
    require('fs').writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf-8')

    // Auto-inject into Claude Code's global settings (~/.claude/settings.json).
    // Registers MCP server + auto-trusts all Termpolis tools. All robustness
    // (corrupt JSON, missing file, wrong types, atomic write) lives in the helper.
    {
      const claudeSettingsPath = join(homedir(), '.claude', 'settings.json')
      const r = registerInClaudeSettings(claudeSettingsPath, adapterPath)
      if (r.changed) console.log('Auto-registered Termpolis MCP server and tool permissions in Claude Code settings')
      else if (r.error) console.log('Could not auto-register in Claude Code settings (non-fatal):', r.skipped, r.error)
    }

    // Also write to ~/.mcp.json (global MCP config that Claude Code actually loads).
    {
      const globalMcpPath = join(homedir(), '.mcp.json')
      const r = registerInGlobalMcp(globalMcpPath, adapterPath)
      if (r.changed) console.log('Auto-registered Termpolis in global ~/.mcp.json')
      else if (r.error) console.log('Could not write ~/.mcp.json (non-fatal):', r.skipped, r.error)
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

      // MCP config for the plugin — Claude Code expects the mcpServers wrapper;
      // without it the server silently fails to register and the conductor has
      // no MCP tool access (symptom: swarm posts "analyzing..." then nothing).
      const pluginMcp = join(pluginDir, '.mcp.json')
      const mcpContent = JSON.stringify({ mcpServers: { termpolis: { command: 'node', args: [adapterPath] } } }, null, 2)
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
    {
      const codexConfigPath = join(homedir(), '.codex', 'config.toml')
      const r = registerInCodex(codexConfigPath, adapterPath)
      if (r.changed) console.log('Auto-registered Termpolis MCP server in Codex CLI config')
      else if (r.error) console.log('Could not register in Codex config (non-fatal):', r.skipped, r.error)
    }

    // Auto-register in Gemini CLI (~/.gemini/settings.json)
    {
      const geminiSettingsPath = join(homedir(), '.gemini', 'settings.json')
      const r = registerInGemini(geminiSettingsPath, adapterPath)
      if (r.changed) console.log('Auto-registered Termpolis MCP server in Gemini CLI settings')
      else if (r.error) console.log('Could not register in Gemini settings (non-fatal):', r.skipped, r.error)
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
    try { detachAllWatchers() } catch {}
    try { shutdownEventBus() } catch {}
    if (mcpServer) { stopMcpServer(mcpServer); mcpServer = null }
  })
  app.on('window-all-closed', () => {
    killAll()
    try { detachAllWatchers() } catch {}
    try { shutdownEventBus() } catch {}
    if (mcpServer) { stopMcpServer(mcpServer); mcpServer = null }
    if (process.platform !== 'darwin') {
      app.quit()
      // Force exit — MCP server or PTY processes may keep event loop alive
      setTimeout(() => process.exit(0), 500)
    }
  })
  app.on('activate', () => { if (!mainWindow) createWindow() })
}
