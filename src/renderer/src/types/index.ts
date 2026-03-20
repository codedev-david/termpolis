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
  createTerminal: (id: string, shellType: ShellType, cwd: string) => Promise<IpcResponse>
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
  getTerminalStatus: (terminalId: string, fallbackCwd: string) => Promise<IpcResponse<{ cwd: string; gitBranch: string }>>
  getGitInfo: (cwd: string) => Promise<IpcResponse<{ status: string; recentCommits: string }>>
}

declare global {
  interface Window {
    termpolis: TermpolisAPI
    windowControls: {
      minimize: () => void
      maximize: () => void
      close: () => void
    }
    globalEvents: {
      onNewTerminal: (cb: () => void) => () => void
    }
  }
}
