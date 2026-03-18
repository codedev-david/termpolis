export type ShellType = 'bash' | 'zsh' | 'cmd' | 'powershell' | 'gitbash'

export type ViewMode = 'tabs' | 'grid'

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
}

export interface Workspace {
  id: string
  name: string
  terminals: Omit<TerminalSession, 'id' | 'cwd'>[]
}

export interface SessionData {
  terminals: TerminalSession[]
  workspaces: Workspace[]
  defaultShell: ShellType
  viewMode: ViewMode
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
