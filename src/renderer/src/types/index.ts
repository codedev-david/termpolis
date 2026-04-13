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
  command: string
  shell: string
  color: string
}

export interface PromptTemplate {
  id: string
  name: string
  text: string
  icon: string
  isCustom?: boolean
}

export interface SessionData {
  terminals: TerminalSession[]
  workspaces: Workspace[]
  defaultShell: ShellType
  viewMode: ViewMode
  keybindings?: Record<string, string>
  aiProfiles?: AIProfile[]
  promptTemplates?: PromptTemplate[]
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
  loadSession: () => Promise<IpcResponse<SessionData>>
  saveSession: (data: SessionData) => void
  completionPathEntries: (dirPath: string) => Promise<IpcResponse<{ name: string; isDir: boolean }[]>>
  completionPathCommands: () => Promise<IpcResponse<string[]>>
  completionEnvVars: () => Promise<IpcResponse<Record<string, string>>>
  exportTerminal: (opts: { content: string; defaultFilename: string }) => Promise<IpcResponse<{ filePath: string }>>
  detectAgents: () => Promise<IpcResponse<Record<string, boolean>>>
  getOllamaPath: () => Promise<IpcResponse<string | null>>
  pickDirectory: (defaultPath?: string) => Promise<IpcResponse<string | null>>
  getTerminalStatus: (terminalId: string, fallbackCwd: string) => Promise<IpcResponse<{ cwd: string; gitBranch: string }>>
  getGitInfo: (cwd: string) => Promise<IpcResponse<{ status: string; recentCommits: string }>>
  getGitDiff: (cwd: string) => Promise<IpcResponse<string>>
  readTerminalBuffer: (terminalId: string, fromOffset?: number) => Promise<IpcResponse<{ output: string; length: number }>>

  // Git operations
  gitStatusParsed: (cwd: string) => Promise<IpcResponse<{ branch: string; staged: { file: string; status: string }[]; unstaged: { file: string; status: string }[] }>>
  gitStage: (cwd: string, files: string[]) => Promise<IpcResponse>
  gitUnstage: (cwd: string, files: string[]) => Promise<IpcResponse>
  gitCommit: (cwd: string, message: string) => Promise<IpcResponse>
  gitPull: (cwd: string) => Promise<IpcResponse<string>>
  gitPush: (cwd: string) => Promise<IpcResponse<string>>
  gitFileDiff: (cwd: string, file: string) => Promise<IpcResponse<string>>
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

declare global {
  interface Window {
    termpolis: TermpolisAPI
    swarmAPI: SwarmAPI
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
