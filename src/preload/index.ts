import { contextBridge, ipcRenderer } from 'electron'
import type { TermpolisAPI, ShellType } from '../renderer/src/types'

const api: TermpolisAPI = {
  createTerminal: (id, shellType, cwd, extraPaths) =>
    ipcRenderer.invoke('terminal:create', { id, shellType, cwd, extraPaths }),

  killTerminal: (id) =>
    ipcRenderer.invoke('terminal:kill', { id }),

  writeToTerminal: (id, data) =>
    ipcRenderer.send('terminal:write', { id, data }),

  resizeTerminal: (id, cols, rows) =>
    ipcRenderer.send('terminal:resize', { id, cols, rows }),

  onTerminalData: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, id: string, data: string) => cb(id, data)
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },

  getAvailableShells: () =>
    ipcRenderer.invoke('shell:available'),

  readConfigFile: (filePath) =>
    ipcRenderer.invoke('config:read', { filePath }),

  writeConfigFile: (filePath, content) =>
    ipcRenderer.invoke('config:write', { filePath, content }),

  appendHistory: (terminalId, terminalName, command) =>
    ipcRenderer.send('history:append', { terminalId, terminalName, command }),

  searchHistory: (query) =>
    ipcRenderer.invoke('history:search', { query }),

  getHomedir: () =>
    ipcRenderer.invoke('fs:homedir'),

  loadSession: () =>
    ipcRenderer.invoke('session:load'),

  saveSession: (data) =>
    ipcRenderer.send('session:save', data),

  exportTerminal: (opts) =>
    ipcRenderer.invoke('terminal:export', opts),

  detectAgents: () =>
    ipcRenderer.invoke('agents:detect'),

  getOllamaPath: () =>
    ipcRenderer.invoke('agents:ollama-path'),

  pickDirectory: (defaultPath?: string) =>
    ipcRenderer.invoke('dialog:pick-directory', { defaultPath }),

  completionPathEntries: (dirPath) =>
    ipcRenderer.invoke('completion:path-entries', { dirPath }),

  completionPathCommands: () =>
    ipcRenderer.invoke('completion:path-commands'),

  completionEnvVars: () =>
    ipcRenderer.invoke('completion:env-vars'),

  getTerminalStatus: (terminalId, fallbackCwd) =>
    ipcRenderer.invoke('terminal:status', { terminalId, fallbackCwd }),

  getGitInfo: (cwd) =>
    ipcRenderer.invoke('terminal:git-info', { cwd }),

  getGitDiff: (cwd) =>
    ipcRenderer.invoke('terminal:git-diff', { cwd }),

  readTerminalBuffer: (terminalId, fromOffset) =>
    ipcRenderer.invoke('terminal:read-buffer', { terminalId, fromOffset }),
}

contextBridge.exposeInMainWorld('termpolis', api)

contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
})

// Global hotkey listeners from main process
contextBridge.exposeInMainWorld('globalEvents', {
  onNewTerminal: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('global:new-terminal', handler)
    return () => ipcRenderer.removeListener('global:new-terminal', handler)
  },
})

// Swarm orchestration API
contextBridge.exposeInMainWorld('swarmAPI', {
  getMessages: () => ipcRenderer.invoke('swarm:messages'),
  getTasks: () => ipcRenderer.invoke('swarm:tasks'),
  sendMessage: (from: string, to: string, type: string, content: string) =>
    ipcRenderer.invoke('swarm:send-message', { from, to, type, content }),
  createTask: (title: string, description: string, createdBy: string, assignTo?: string) =>
    ipcRenderer.invoke('swarm:create-task', { title, description, createdBy, assignTo }),
  updateTask: (taskId: string, status: string, result?: string) =>
    ipcRenderer.invoke('swarm:update-task', { taskId, status, result }),
  clear: () => ipcRenderer.invoke('swarm:clear'),
})

// MCP server events — terminals created/closed by AI agents
contextBridge.exposeInMainWorld('mcpEvents', {
  onTerminalCreated: (cb: (data: { id: string; name: string; shell: string; cwd: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { id: string; name: string; shell: string; cwd: string }) => cb(data)
    ipcRenderer.on('mcp:terminal-created', handler)
    return () => ipcRenderer.removeListener('mcp:terminal-created', handler)
  },
  onTerminalClosed: (cb: (terminalId: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, terminalId: string) => cb(terminalId)
    ipcRenderer.on('mcp:terminal-closed', handler)
    return () => ipcRenderer.removeListener('mcp:terminal-closed', handler)
  },
})
