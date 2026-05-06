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

  getMcpConfigPath: () =>
    ipcRenderer.invoke('fs:mcp-config-path'),

  loadSession: () =>
    ipcRenderer.invoke('session:load'),

  saveSession: (data) =>
    ipcRenderer.send('session:save', data),

  exportTerminal: (opts) =>
    ipcRenderer.invoke('terminal:export', opts),

  detectAgents: () =>
    ipcRenderer.invoke('agents:detect'),

  pickDirectory: (defaultPath?: string) =>
    ipcRenderer.invoke('dialog:pick-directory', { defaultPath }),

  openPath: (path: string) =>
    ipcRenderer.invoke('shell:open-path', { path }),

  collectDiagnostics: () =>
    ipcRenderer.invoke('diagnostics:collect'),

  openExternal: (url: string) =>
    ipcRenderer.invoke('shell:open-external', { url }),

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

  // Git operations
  gitFindRoot: (cwd) =>
    ipcRenderer.invoke('git:find-root', { cwd }),
  gitStatusParsed: (cwd) =>
    ipcRenderer.invoke('git:status-parsed', { cwd }),
  gitStage: (cwd, files) =>
    ipcRenderer.invoke('git:stage', { cwd, files }),
  gitUnstage: (cwd, files) =>
    ipcRenderer.invoke('git:unstage', { cwd, files }),
  gitCommit: (cwd, message) =>
    ipcRenderer.invoke('git:commit', { cwd, message }),
  gitPull: (cwd) =>
    ipcRenderer.invoke('git:pull', { cwd }),
  gitPush: (cwd) =>
    ipcRenderer.invoke('git:push', { cwd }),
  gitFileDiff: (cwd, file) =>
    ipcRenderer.invoke('git:file-diff', { cwd, file }),

  // Swarm Review
  gitRevParseHead: (cwd) =>
    ipcRenderer.invoke('git:rev-parse-head', { cwd }),
  gitDiffRange: (cwd, from, to) =>
    ipcRenderer.invoke('git:diff-range', { cwd, from, to }),
  gitFilesInRange: (cwd, from, to) =>
    ipcRenderer.invoke('git:files-in-range', { cwd, from, to }),
  gitApplyPatch: (cwd, patch, reverse) =>
    ipcRenderer.invoke('git:apply-patch', { cwd, patch, reverse }),
  gitCheckoutFile: (cwd, sha, files) =>
    ipcRenderer.invoke('git:checkout-file', { cwd, sha, files }),
  gitResetHard: (cwd, sha) =>
    ipcRenderer.invoke('git:reset-hard', { cwd, sha }),
  gitCommitAll: (cwd, message) =>
    ipcRenderer.invoke('git:commit-all', { cwd, message }),
  swarmRunCommand: (cwd, command) =>
    ipcRenderer.invoke('swarm:run-command', { cwd, command }),

  // Workspace trust
  workspaceIsTrusted: (cwd) =>
    ipcRenderer.invoke('workspace:is-trusted', { cwd }),
  workspaceTrust: (cwd) =>
    ipcRenderer.invoke('workspace:trust', { cwd }),
  workspaceRevokeTrust: (cwd) =>
    ipcRenderer.invoke('workspace:revoke-trust', { cwd }),
  workspaceListTrusted: () =>
    ipcRenderer.invoke('workspace:list-trusted'),

  // Shared swarm memory (RAG)
  memoryWrite: (input) => ipcRenderer.invoke('memory:write', input),
  memorySearch: (opts) => ipcRenderer.invoke('memory:search', opts),
  memoryList: (opts) => ipcRenderer.invoke('memory:list', opts ?? {}),
  memoryCount: () => ipcRenderer.invoke('memory:count'),
  memoryClear: () => ipcRenderer.invoke('memory:clear'),

  // Telemetry — push opt-in changes to main so Sentry/updater pings can gate.
  setTelemetryOptIn: (value: boolean) =>
    ipcRenderer.invoke('telemetry:set-opt-in', { value }),
  getTelemetryOptIn: () =>
    ipcRenderer.invoke('telemetry:get-opt-in'),
  recordTelemetryEvent: (name: string, props?: Record<string, unknown>) =>
    ipcRenderer.invoke('telemetry:record-event', { name, props }),

  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
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
  onToggleSwarm: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('global:toggle-swarm', handler)
    return () => ipcRenderer.removeListener('global:toggle-swarm', handler)
  },
  onConfirmClose: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('app:confirm-close', handler)
    return () => ipcRenderer.removeListener('app:confirm-close', handler)
  },
  forceClose: () => ipcRenderer.send('app:force-close'),
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

// Context pins — per-project user-pinned snippets
contextBridge.exposeInMainWorld('contextPins', {
  list: (cwd: string) => ipcRenderer.invoke('contextPins:list', { cwd }),
  add: (cwd: string, input: { label: string; body: string; source?: string; tags?: string[] }) =>
    ipcRenderer.invoke('contextPins:add', { cwd, input }),
  update: (cwd: string, id: string, patch: { label?: string; body?: string; source?: string; tags?: string[] }) =>
    ipcRenderer.invoke('contextPins:update', { cwd, id, patch }),
  remove: (cwd: string, id: string) =>
    ipcRenderer.invoke('contextPins:remove', { cwd, id }),
  clear: (cwd: string) => ipcRenderer.invoke('contextPins:clear', { cwd }),
})

// Agent activity event bus (live feed + query)
contextBridge.exposeInMainWorld('agentActivity', {
  query: (filter?: unknown) => ipcRenderer.invoke('agentActivity:query', { filter }),
  stats: () => ipcRenderer.invoke('agentActivity:stats'),
  attachWatcher: (terminalId: string, cwd: string, agentType: string) =>
    ipcRenderer.invoke('agentWatcher:attach', { terminalId, cwd, agentType }),
  detachWatcher: (terminalId: string) =>
    ipcRenderer.invoke('agentWatcher:detach', { terminalId }),
  onEvent: (cb: (event: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: unknown) => cb(event)
    ipcRenderer.on('agentActivity:event', handler)
    return () => ipcRenderer.removeListener('agentActivity:event', handler)
  },
})

// Auto-updater — status + install trigger for the update banner in the renderer.
contextBridge.exposeInMainWorld('updater', {
  getStatus: () => ipcRenderer.invoke('updater:status'),
  check: () => ipcRenderer.invoke('updater:check'),
  quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),
  onState: (cb: (state: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, state: unknown) => cb(state)
    ipcRenderer.on('updater:state', handler)
    return () => ipcRenderer.removeListener('updater:state', handler)
  },
})

// AI Security Center — outbound-data controls (redaction, audit, agent facts).
contextBridge.exposeInMainWorld('aiSecurity', {
  getStatus: () => ipcRenderer.invoke('aiSecurity:get-status'),
  setRedaction: (value: boolean) => ipcRenderer.invoke('aiSecurity:set-redaction', { value }),
  setAudit: (value: boolean) => ipcRenderer.invoke('aiSecurity:set-audit', { value }),
  setStrictGemini: (value: boolean) => ipcRenderer.invoke('aiSecurity:set-strict-gemini', { value }),
  scan: (text: string) => ipcRenderer.invoke('aiSecurity:scan', { text }),
  recentAudit: (limit?: number) => ipcRenderer.invoke('aiSecurity:recent-audit', { limit }),
  clearAudit: () => ipcRenderer.invoke('aiSecurity:clear-audit'),
  append: (entry: { agent: string; event: string; terminalId?: string; byteCount?: number; hitCount?: number; notes?: string }) =>
    ipcRenderer.invoke('aiSecurity:append', entry),
  onSecretsRedacted: (
    cb: (data: { id: string; hits: { rule: string; label: string; sample: string }[]; agent: string | null }) => void,
  ) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      data: { id: string; hits: { rule: string; label: string; sample: string }[]; agent: string | null },
    ) => cb(data)
    ipcRenderer.on('terminal:secrets-redacted', handler)
    return () => ipcRenderer.removeListener('terminal:secrets-redacted', handler)
  },
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
