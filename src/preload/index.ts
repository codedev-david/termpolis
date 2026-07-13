import { contextBridge, ipcRenderer } from 'electron'
import type { TermpolisAPI, ShellType, PlatformInfo } from '../renderer/src/types'

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

  secondOpinion: (opts: { agent: string; model?: string; content: string }) =>
    ipcRenderer.invoke('agent:second-opinion', opts),

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
  memoryStats: () => ipcRenderer.invoke('memory:stats'),
  memoryMetrics: () => ipcRenderer.invoke('memory:metrics'),
  memoryGraphSample: (limit?: number) => ipcRenderer.invoke('memory:graph-sample', { limit }),
  memoryIngestConversations: () => ipcRenderer.invoke('memory:ingest-conversations'),
  memoryIngestCode: (repoRoot: string) => ipcRenderer.invoke('memory:ingest-code', { repoRoot }),
  // Native code graph (structural)
  codeGraphStats: () => ipcRenderer.invoke('code-graph:stats'),
  codeGraphSearch: (query: string, limit?: number) => ipcRenderer.invoke('code-graph:search', { query, limit }),
  codeGraphExplore: (query: string) => ipcRenderer.invoke('code-graph:explore', { query }),
  codeGraphImpact: (name: string) => ipcRenderer.invoke('code-graph:impact', { name }),
  codeGraphCallers: (name: string) => ipcRenderer.invoke('code-graph:callers', { name }),
  codeGraphBuild: (repoRoot: string) => ipcRenderer.invoke('code-graph:build', { repoRoot }),
  // Brain export / import (portable .zip)
  brainExport: () => ipcRenderer.invoke('brain:export'),
  brainImport: () => ipcRenderer.invoke('brain:import'),
  memoryBuildPrimer: (query: string, limit?: number, cwd?: string) => ipcRenderer.invoke('memory:build-primer', { query, limit, cwd }),
  memoryPreparePrimerFile: (query: string, cwd?: string) => ipcRenderer.invoke('memory:prepare-primer-file', { query, cwd }),
  /** Live vector RAM + main-thread health + a recommendation computed from THIS machine. */
  memoryGetVectorRam: () => ipcRenderer.invoke('memory:get-vector-ram'),
  /** Flip int8 quantization and rebuild the packed store. Lossless both ways — disk keeps floats. */
  memorySetVectorQuantize: (value: boolean) => ipcRenderer.invoke('memory:set-vector-quantize', { value }),
  memoryGetPrimerLimit: () => ipcRenderer.invoke('memory:get-primer-limit'),
  memorySetPrimerLimit: (value: number) => ipcRenderer.invoke('memory:set-primer-limit', { value }),
  memoryReflectSession: (terminalId: string, cwd: string, agent: string) => ipcRenderer.invoke('memory:reflect-session', { terminalId, cwd, agent }),
  memorySyncStatus: () => ipcRenderer.invoke('memory:sync-status'),
  memorySetSyncDir: (dir: string | null) => ipcRenderer.invoke('memory:set-sync-dir', { dir }),
  memoryChooseSyncDir: () => ipcRenderer.invoke('memory:choose-sync-dir'),
  memorySetSyncPassphrase: (passphrase: string) => ipcRenderer.invoke('memory:set-sync-passphrase', { passphrase }),
  memoryDisableSyncEncryption: () => ipcRenderer.invoke('memory:disable-sync-encryption'),
  memoryEnableLocalEncryption: () => ipcRenderer.invoke('memory:enable-local-encryption'), // WP-F
  memoryDisableEncryption: () => ipcRenderer.invoke('memory:disable-encryption'), // WP-F

  // Test-only (inert in production — handlers registered only under NODE_ENV=test):
  // feed synthetic terminal output and read back raw terminal writes, so e2e can
  // exercise the compaction re-prime end to end through onTerminalData.
  __testTerminalData: (id: string, data: string) => ipcRenderer.invoke('terminal:__test_data', { id, data }),
  __testTerminalWrites: () => ipcRenderer.invoke('terminal:__test_writes'),

  // Telemetry — push opt-in changes to main so Sentry/updater pings can gate.
  setTelemetryOptIn: (value: boolean) =>
    ipcRenderer.invoke('telemetry:set-opt-in', { value }),
  getTelemetryOptIn: () =>
    ipcRenderer.invoke('telemetry:get-opt-in'),
  recordTelemetryEvent: (name: string, props?: Record<string, unknown>) =>
    ipcRenderer.invoke('telemetry:record-event', { name, props }),

  getAppVersion: () => ipcRenderer.invoke('app:get-version'),

  // Static platform facts, read SYNCHRONOUSLY at preload load so the renderer has
  // windowsPty before it constructs the first xterm Terminal (the option must be
  // set at construction). Tiny one-shot payload from main; falls back to a safe
  // default when the channel is unavailable (e.g. unit tests with no sendSync).
  platformInfo: (ipcRenderer.sendSync?.('app:platform-info-sync') as PlatformInfo | undefined)
    ?? { platform: process.platform, windowsPty: null },

  listAISessions: () => ipcRenderer.invoke('aiSessions:list'),
  digestAISession: (filePath: string) => ipcRenderer.invoke('aiSessions:digest', filePath),
  readActiveConversation: (cwd: string, agentType: string) =>
    ipcRenderer.invoke('conversation:read-active', { cwd, agentType }),

  // Clipboard — native Electron clipboard via main, so the terminal context menu
  // works regardless of renderer focus. navigator.clipboard is focus/permission
  // gated and silently rejects when called from a menu-button click.
  clipboardWriteText: (text: string) => ipcRenderer.invoke('clipboard:write-text', { text }),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:read-text'),
  clipboardWriteRich: (text: string, html: string) => ipcRenderer.invoke('clipboard:write-rich', { text, html }),

  // Voice (Groq cloud STT). The API key stays in main (OS keychain) — these only
  // push the key one-way into main, read back a masked status, or send PCM out.
  groqValidateKey: (key: string) => ipcRenderer.invoke('groq:validate-key', { key }),
  groqSetApiKey: (key: string) => ipcRenderer.invoke('groq:set-api-key', { key }),
  groqGetKeyStatus: () => ipcRenderer.invoke('groq:get-key-status'),
  groqClearApiKey: () => ipcRenderer.invoke('groq:clear-api-key'),
  voiceTranscribe: (pcm: Float32Array, model?: string) => ipcRenderer.invoke('voice:transcribe', { pcm, model }),
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
  // Test-only: drive a synthetic event through the real bus. Inert in production —
  // the main-side handler is registered only under NODE_ENV=test.
  __testPublish: (event: unknown) => ipcRenderer.invoke('agentActivity:__test_publish', { event }),
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

// Safe Import — bring in a third-party skill/plugin, PROVE it is safe and local-only
// (static scan for exfiltration / code-exec / injection), then wire it into the agents.
// The scan streams progress so the UI can show a real percentage, not a fake spinner.
contextBridge.exposeInMainWorld('safeImport', {
  scan: () => ipcRenderer.invoke('safeImport:scan'),
  approveInstall: (targets: string[]) => ipcRenderer.invoke('safeImport:approve-install', { targets }),
  list: () => ipcRenderer.invoke('safeImport:list'),
  revoke: (id: string) => ipcRenderer.invoke('safeImport:revoke', { id }),
  onProgress: (cb: (p: { pct: number; stage: string }) => void) => {
    const handler = (_e: unknown, p: { pct: number; stage: string }): void => cb(p)
    ipcRenderer.on('safeImport:progress', handler)
    return () => ipcRenderer.removeListener('safeImport:progress', handler)
  },
})

// AI Security Center — outbound-data controls (redaction, audit, agent facts).
contextBridge.exposeInMainWorld('aiSecurity', {
  getStatus: () => ipcRenderer.invoke('aiSecurity:get-status'),
  setAudit: (value: boolean) => ipcRenderer.invoke('aiSecurity:set-audit', { value }),
  setStrictGemini: (value: boolean) => ipcRenderer.invoke('aiSecurity:set-strict-gemini', { value }),
  setCommitShield: (value: boolean) => ipcRenderer.invoke('aiSecurity:set-commit-shield', { value }),
  // Commit Shield git hooks — what makes the shield cover git typed into a terminal, not
  // just the git ops Termpolis runs itself.
  gitHooksList: () => ipcRenderer.invoke('gitHooks:list'),
  gitHooksInstall: (cwd?: string) => ipcRenderer.invoke('gitHooks:install', { cwd }),
  gitHooksUninstall: (cwd: string) => ipcRenderer.invoke('gitHooks:uninstall', { cwd }),
  setEgressGuard: (value: boolean) => ipcRenderer.invoke('aiSecurity:set-egress-guard', { value }),
  setMemoryScrub: (value: boolean) => ipcRenderer.invoke('aiSecurity:set-memory-scrub', { value }),
  scan: (text: string) => ipcRenderer.invoke('aiSecurity:scan', { text }),
  /** True when the user has an un-submitted draft in this terminal's input line. Anything
   *  that writes to the terminal unprompted must check this — a write appends at the cursor. */
  inputPending: (id: string) => ipcRenderer.invoke('aiSecurity:input-pending', { id }),
  recentAudit: (limit?: number) => ipcRenderer.invoke('aiSecurity:recent-audit', { limit }),
  clearAudit: () => ipcRenderer.invoke('aiSecurity:clear-audit'),
  append: (entry: { agent: string; event: string; terminalId?: string; byteCount?: number; hitCount?: number; notes?: string }) =>
    ipcRenderer.invoke('aiSecurity:append', entry),
  // A secret WAS sent to a model. Nothing was redacted and nothing was withheld — by the time
  // this fires the bytes are already gone. There is no `sample` in the payload on purpose:
  // main strips it, because the renderer only ever needs to say WHAT leaked, not show it.
  onSecretSent: (
    cb: (data: { id: string; hits: { rule: string; label: string; name?: string }[]; agent: string | null }) => void,
  ) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      data: { id: string; hits: { rule: string; label: string; name?: string }[]; agent: string | null },
    ) => cb(data)
    ipcRenderer.on('terminal:secret-observed', handler)
    return () => ipcRenderer.removeListener('terminal:secret-observed', handler)
  },
  onCodeChunkDetected: (
    cb: (data: { id: string; agent: string | null; byteSize: number; lineCount: number; signals: string[] }) => void,
  ) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      data: { id: string; agent: string | null; byteSize: number; lineCount: number; signals: string[] },
    ) => cb(data)
    ipcRenderer.on('terminal:code-chunk-detected', handler)
    return () => ipcRenderer.removeListener('terminal:code-chunk-detected', handler)
  },
  onEnvDumpDetected: (
    cb: (data: { id: string; agent: string | null; varCount: number; variableNames: string[] }) => void,
  ) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      data: { id: string; agent: string | null; varCount: number; variableNames: string[] },
    ) => cb(data)
    ipcRenderer.on('terminal:env-dump-detected', handler)
    return () => ipcRenderer.removeListener('terminal:env-dump-detected', handler)
  },
  egress: (terminalId: string) => ipcRenderer.invoke('ai-security:egress', { terminalId }),
  sensitiveReads: (terminalId: string) => ipcRenderer.invoke('ai-security:sensitive-reads', { terminalId }),
  onSensitiveFileRead: (
    cb: (data: {
      id: string
      agent: string
      tool: string
      rule: string
      label: string
      filePath: string
      source: 'path' | 'command'
      ts: number
    }) => void,
  ) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      data: {
        id: string
        agent: string
        tool: string
        rule: string
        label: string
        filePath: string
        source: 'path' | 'command'
        ts: number
      },
    ) => cb(data)
    ipcRenderer.on('terminal:sensitive-file-read', handler)
    return () => ipcRenderer.removeListener('terminal:sensitive-file-read', handler)
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
