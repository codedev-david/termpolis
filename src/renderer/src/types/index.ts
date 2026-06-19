export type ShellType = 'bash' | 'zsh' | 'cmd' | 'powershell' | 'gitbash'

export type ViewMode = 'tabs' | 'split'

export type PaneNode =
  | { type: 'terminal'; terminalId: string }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; ratio: number; children: [PaneNode, PaneNode] }

export interface ShellInfo {
  type: ShellType
  label: string
  executable: string
}

export interface TerminalSession {
  id: string
  name: string
  color: string
  shellType: ShellType
  cwd: string
  fontSize: number
  theme: string
  fontFamily: string
  agentCommand?: string
  isSwarm?: boolean
  hidden?: boolean
  isConductor?: boolean
  /** Set when the terminal was seeded with project memory at launch (e.g. Claude
   *  via --append-system-prompt-file), so useAutoPrimer skips the typed pointer. */
  launchPrimed?: boolean
}

export interface Workspace {
  id: string
  name: string
  terminals: Omit<TerminalSession, 'id'>[]
}

export interface AIProfile {
  id: string
  name: string
  icon: string
  iconImage?: string
  command: string
  shell: string
  color: string
  /** Optional Claude model alias (opus/sonnet/haiku), appended as --model on launch. */
  model?: string
}

export interface PromptTemplate {
  id: string
  name: string
  text: string
  icon: string
  isCustom?: boolean
}

/**
 * A user-defined keyboard shortcut that types a snippet (or runs a command)
 * into the active terminal. Distinct from the fixed KeybindingMap actions:
 * these are open-ended macros the user adds themselves.
 */
export interface CustomKeybinding {
  id: string
  /** Human label shown in Settings and used for conflict messages. */
  label: string
  /** Key combo string, e.g. "Ctrl+Alt+G" (same grammar as KeybindingMap values). */
  combo: string
  /** Text sent to the active terminal when the combo fires. */
  text: string
  /** When true, a carriage return is appended so the command executes. */
  runOnSend: boolean
}

export interface WorkflowTerminal {
  name: string
  command: string
  shell: string
  color: string
}

export type WorkflowLayout = 'vertical' | 'quad'

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  icon: string
  terminals: WorkflowTerminal[]
  layout: WorkflowLayout
  isCustom?: boolean
}

export interface SessionData {
  terminals: TerminalSession[]
  workspaces: Workspace[]
  defaultShell: ShellType
  viewMode: ViewMode
  keybindings?: Record<string, string>
  customKeybindings?: CustomKeybinding[]
  voiceSettings?: unknown // persisted blob; renderer sanitizes via sanitizeVoiceSettings on load
  aiProfiles?: AIProfile[]
  promptTemplates?: PromptTemplate[]
  userWorkflows?: WorkflowTemplate[]
  agentRatingOverrides?: Record<string, Record<string, number>>
}

export interface HistoryEntry {
  terminalId: string
  terminalName: string
  command: string
  timestamp: number
}

export interface IpcResponse<T = undefined> {
  success: boolean
  data?: T
  error?: string
}

export interface PlatformInfo {
  /** process.platform of the host (e.g. 'win32', 'darwin', 'linux'). */
  platform: string
  /** xterm.js `windowsPty` option on Windows (backend + OS build) so the
   *  emulator's reflow/scrollback match ConPTY; null off Windows. */
  windowsPty: { backend: 'conpty' | 'winpty'; buildNumber: number } | null
}

export interface TermpolisAPI {
  createTerminal: (id: string, shellType: ShellType, cwd: string, extraPaths?: string[]) => Promise<IpcResponse>
  killTerminal: (id: string) => Promise<IpcResponse>
  writeToTerminal: (id: string, data: string) => void
  resizeTerminal: (id: string, cols: number, rows: number) => void
  onTerminalData: (cb: (id: string, data: string) => void) => () => void
  getAvailableShells: () => Promise<IpcResponse<ShellInfo[]>>
  readConfigFile: (filePath: string) => Promise<IpcResponse<string>>
  writeConfigFile: (filePath: string, content: string) => Promise<IpcResponse>
  appendHistory: (terminalId: string, terminalName: string, command: string) => void
  searchHistory: (query: string) => Promise<IpcResponse<HistoryEntry[]>>
  getHomedir: () => Promise<IpcResponse<string>>
  getMcpConfigPath: () => Promise<IpcResponse<string>>
  loadSession: () => Promise<IpcResponse<SessionData>>
  saveSession: (data: SessionData) => void
  completionPathEntries: (dirPath: string) => Promise<IpcResponse<{ name: string; isDir: boolean }[]>>
  completionPathCommands: () => Promise<IpcResponse<string[]>>
  completionEnvVars: () => Promise<IpcResponse<Record<string, string>>>
  exportTerminal: (opts: { content: string; defaultFilename: string }) => Promise<IpcResponse<{ filePath: string }>>
  detectAgents: () => Promise<IpcResponse<Record<string, boolean>>>
  pickDirectory: (defaultPath?: string) => Promise<IpcResponse<string | null>>
  openPath: (path: string) => Promise<IpcResponse>
  openExternal: (url: string) => Promise<IpcResponse>
  collectDiagnostics: () => Promise<IpcResponse<{
    appVersion: string
    platform: string
    osRelease: string
    arch: string
    electronVersion: string
    nodeVersion: string
    chromeVersion: string
  }>>
  getTerminalStatus: (terminalId: string, fallbackCwd: string) => Promise<IpcResponse<{ cwd: string; gitBranch: string }>>
  getGitInfo: (cwd: string) => Promise<IpcResponse<{ status: string; recentCommits: string }>>
  getGitDiff: (cwd: string) => Promise<IpcResponse<string>>
  readTerminalBuffer: (terminalId: string, fromOffset?: number) => Promise<IpcResponse<{ output: string; length: number }>>

  // Git operations
  gitFindRoot: (cwd: string) => Promise<IpcResponse<string | null>>
  gitStatusParsed: (cwd: string) => Promise<IpcResponse<{ branch: string; staged: { file: string; status: string }[]; unstaged: { file: string; status: string }[] }>>
  gitStage: (cwd: string, files: string[]) => Promise<IpcResponse>
  gitUnstage: (cwd: string, files: string[]) => Promise<IpcResponse>
  gitCommit: (cwd: string, message: string) => Promise<IpcResponse>
  gitPull: (cwd: string) => Promise<IpcResponse<string>>
  gitPush: (cwd: string) => Promise<IpcResponse<string>>
  gitFileDiff: (cwd: string, file: string) => Promise<IpcResponse<string>>

  // Swarm Review
  gitRevParseHead: (cwd: string) => Promise<IpcResponse<string | null>>
  gitDiffRange: (cwd: string, from: string, to?: string) => Promise<IpcResponse<string>>
  gitFilesInRange: (cwd: string, from: string, to?: string) => Promise<IpcResponse<{ file: string; status: string }[]>>
  gitApplyPatch: (cwd: string, patch: string, reverse?: boolean) => Promise<IpcResponse>
  gitCheckoutFile: (cwd: string, sha: string, files: string[]) => Promise<IpcResponse>
  gitResetHard: (cwd: string, sha: string) => Promise<IpcResponse>
  gitCommitAll: (cwd: string, message: string) => Promise<IpcResponse>
  swarmRunCommand: (cwd: string, command: string) => Promise<IpcResponse<{ output: string; exitCode: number }>>

  // Workspace trust
  workspaceIsTrusted: (cwd: string) => Promise<IpcResponse<boolean>>
  workspaceTrust: (cwd: string) => Promise<IpcResponse>
  workspaceRevokeTrust: (cwd: string) => Promise<IpcResponse>
  workspaceListTrusted: () => Promise<IpcResponse<string[]>>

  // Shared swarm memory (RAG)
  memoryWrite: (input: MemoryWriteInput) => Promise<IpcResponse<MemoryEntry>>
  memorySearch: (opts: MemorySearchOptions) => Promise<IpcResponse<MemorySearchResult[]>>
  memoryList: (opts?: MemoryListOptions) => Promise<IpcResponse<MemoryEntry[]>>
  memoryCount: () => Promise<IpcResponse<number>>
  memoryClear: () => Promise<IpcResponse>
  memoryStats: () => Promise<IpcResponse<{ count: number; capacity: number }>>
  memoryIngestConversations: () => Promise<IpcResponse<{ filesScanned: number; chunksWritten: number; chunksSkipped: number }>>
  memoryIngestCode: (repoRoot: string) => Promise<IpcResponse<{ filesScanned: number; filesSkipped: number; chunksWritten: number; chunksSkipped: number }>>
  memoryBuildPrimer: (query: string, limit?: number, cwd?: string) => Promise<IpcResponse<string | null>>
  /** Claude launch primer: writes the recall instruction to a temp file (only
   *  when relevant memory exists) and returns its path for --append-system-prompt-file. */
  memoryPreparePrimerFile: (query: string, cwd?: string) => Promise<IpcResponse<string | null>>
  memorySyncStatus: () => Promise<IpcResponse<MemorySyncStatus>>
  memorySetSyncDir: (dir: string | null) => Promise<IpcResponse<MemorySyncStatus>>
  memoryChooseSyncDir: () => Promise<IpcResponse<MemorySyncStatus>>
  memorySetSyncPassphrase: (passphrase: string) => Promise<IpcResponse<MemorySyncStatus>>
  memoryDisableSyncEncryption: () => Promise<IpcResponse<MemorySyncStatus>>

  // Clipboard — native Electron clipboard (focus/permission-immune), used by the
  // terminal context menu where navigator.clipboard silently rejects.
  clipboardWriteText: (text: string) => Promise<IpcResponse>
  clipboardReadText: () => Promise<IpcResponse<string>>
  clipboardWriteRich: (text: string, html: string) => Promise<IpcResponse>
  clipboardWriteImage: (dataUrl: string) => Promise<IpcResponse>

  // Voice (Groq cloud STT). The API key lives only in main (OS keychain); the
  // renderer can validate/set/clear it and read a masked status, and send PCM to
  // be transcribed — it never holds the raw key.
  groqValidateKey: (key: string) => Promise<IpcResponse<{ ok: boolean; status?: number; error?: string }>>
  groqSetApiKey: (key: string) => Promise<IpcResponse<{ connected: boolean; hint: string }>>
  groqGetKeyStatus: () => Promise<IpcResponse<{ connected: boolean; hint: string }>>
  groqClearApiKey: () => Promise<IpcResponse<{ connected: boolean; hint: string }>>
  voiceTranscribe: (pcm: Float32Array, model?: string) => Promise<IpcResponse<{ text: string }>>

  // Test-only seams (inert in production — main handlers registered only under
  // NODE_ENV=test). Used by e2e/compaction-reprime.spec.ts.
  __testTerminalData?: (id: string, data: string) => Promise<IpcResponse<boolean>>
  __testTerminalWrites?: () => Promise<IpcResponse<Array<{ id: string; data: string }>>>

  // Telemetry — opt-in mirror to main process
  setTelemetryOptIn: (value: boolean) => Promise<IpcResponse<{ optIn: boolean }>>
  getTelemetryOptIn: () => Promise<IpcResponse<boolean>>
  recordTelemetryEvent: (name: string, props?: Record<string, unknown>) => Promise<IpcResponse>

  /** Static platform facts read synchronously at preload load. windowsPty tells
   *  xterm.js how the Windows ConPTY wraps/scrolls so a TUI's redraws don't
   *  overlap the prompt (null off Windows). */
  platformInfo: PlatformInfo
  getAppVersion: () => Promise<IpcResponse<{ version: string }>>

  listAISessions: () => Promise<IpcResponse<AISessionSummary[]>>
  digestAISession: (filePath: string) => Promise<IpcResponse<{ digest: AISessionDigest; prompt: string }>>
}

export interface AISessionSummary {
  id: string
  filePath: string
  projectFolder: string
  cwd: string
  gitBranch?: string
  version?: string
  firstUserMessage?: string
  startTime?: string
  lastModified: number
  sizeBytes: number
}

export interface AISessionDigest {
  id: string
  filePath: string
  cwd: string
  gitBranch?: string
  version?: string
  firstUserMessage?: string
  recentUserMessages: string[]
  lastAssistantText?: string
  totalUserTurns: number
  totalAssistantTurns: number
}

export interface MemoryEntry {
  id: string
  ts: number
  agentId: string
  kind: 'message' | 'result' | 'decision' | 'fact' | 'note'
  content: string
  tags?: string[]
  taskId?: string
  source?: string
  hash?: string
}

export interface MemorySearchResult extends MemoryEntry { score: number }

export interface MemorySyncStatus {
  syncing: boolean
  dir: string | null
  deviceId: string
  devices: number // shard files in the sync folder (≈ machines sharing this brain)
  count: number
  encrypted: boolean // this device holds the key and writes ciphertext at rest
  locked: boolean    // encrypted shards present that we can't read yet (passphrase needed)
}

export interface MemoryWriteInput {
  agentId: string
  kind?: MemoryEntry['kind']
  content: string
  tags?: string[]
  taskId?: string
}

export interface MemorySearchOptions {
  query: string
  limit?: number
  agentId?: string
  kind?: MemoryEntry['kind']
  taskId?: string
}

export interface MemoryListOptions {
  limit?: number
  agentId?: string
  kind?: MemoryEntry['kind']
  since?: number
}

export interface SwarmMessage {
  id: string
  from: string
  to: string
  type: 'task' | 'result' | 'question' | 'info' | 'review'
  content: string
  timestamp: number
  read: boolean
}

export interface SwarmTask {
  id: string
  title: string
  description: string
  assignedTo: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  createdBy: string
  result?: string
  createdAt: number
  completedAt?: number
}

export interface SwarmAPI {
  getMessages: () => Promise<IpcResponse<SwarmMessage[]>>
  getTasks: () => Promise<IpcResponse<SwarmTask[]>>
  sendMessage: (from: string, to: string, type: string, content: string) => Promise<IpcResponse<SwarmMessage>>
  createTask: (title: string, description: string, createdBy: string, assignTo?: string) => Promise<IpcResponse<SwarmTask>>
  updateTask: (taskId: string, status: string, result?: string) => Promise<IpcResponse<SwarmTask>>
  clear: () => Promise<IpcResponse>
}

export type AgentActivityKind =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'token_update'
  | 'compaction'
  | 'error'
  | 'status_change'
  | 'mcp_audit'

export type AgentActivityType = 'claude' | 'codex' | 'gemini' | 'qwen-code' | 'unknown'

export interface AgentActivityEvent {
  id: string
  ts: number
  terminalId: string
  agentType: AgentActivityType
  kind: AgentActivityKind
  taskId?: string
  summary: string
  payload: Record<string, unknown>
}

export interface AgentActivityFilter {
  terminalId?: string
  agentType?: AgentActivityType
  kind?: AgentActivityKind | AgentActivityKind[]
  since?: number
  until?: number
  limit?: number
  search?: string
}

export interface ContextPin {
  id: string
  createdAt: number
  label: string
  body: string
  source?: string
  tags?: string[]
}

export interface ContextPinsAPI {
  list: (cwd: string) => Promise<IpcResponse<ContextPin[]>>
  add: (cwd: string, input: { label: string; body: string; source?: string; tags?: string[] }) => Promise<IpcResponse<ContextPin>>
  update: (cwd: string, id: string, patch: { label?: string; body?: string; source?: string; tags?: string[] }) => Promise<IpcResponse<ContextPin>>
  remove: (cwd: string, id: string) => Promise<IpcResponse<{ removed: boolean }>>
  clear: (cwd: string) => Promise<IpcResponse>
}

export interface AgentActivityAPI {
  query: (filter?: AgentActivityFilter) => Promise<IpcResponse<AgentActivityEvent[]>>
  stats: () => Promise<IpcResponse<{ ringSize: number; dropped: number }>>
  attachWatcher: (terminalId: string, cwd: string, agentType: string) => Promise<IpcResponse<{ attached: boolean }>>
  detachWatcher: (terminalId: string) => Promise<IpcResponse>
  onEvent: (cb: (event: AgentActivityEvent) => void) => () => void
}

declare global {
  interface Window {
    termpolis: TermpolisAPI
    swarmAPI: SwarmAPI
    agentActivity: AgentActivityAPI
    contextPins: ContextPinsAPI
    windowControls: {
      minimize: () => void
      maximize: () => void
      close: () => void
    }
    globalEvents: {
      onNewTerminal: (cb: () => void) => () => void
      onToggleSwarm: (cb: () => void) => () => void
      onConfirmClose: (cb: () => void) => () => void
    }
    mcpEvents: {
      onTerminalCreated: (cb: (data: { id: string; name: string; shell: string; cwd: string }) => void) => () => void
      onTerminalClosed: (cb: (terminalId: string) => void) => () => void
    }
  }
}
