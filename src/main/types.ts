export type ShellType = 'bash' | 'zsh' | 'cmd' | 'powershell' | 'gitbash'

export type ViewMode = 'tabs' | 'split'

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
  appVersion?: string
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
