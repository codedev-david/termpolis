import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { TerminalSession, Workspace, ViewMode, ShellType } from '../types'

interface TerminalStore {
  terminals: TerminalSession[]
  workspaces: Workspace[]
  activeTerminalId: string | null
  viewMode: ViewMode
  defaultShell: ShellType
  showSettings: boolean

  addTerminal: (t: TerminalSession) => void
  removeTerminal: (id: string) => void
  updateTerminal: (id: string, patch: Partial<Pick<TerminalSession, 'name' | 'color'>>) => void
  setActiveTerminal: (id: string | null) => void
  toggleViewMode: () => void
  setShowSettings: (show: boolean) => void
  setDefaultShell: (shell: ShellType) => void
  addWorkspace: (name: string) => void
  removeWorkspace: (id: string) => void
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  terminals: [],
  workspaces: [],
  activeTerminalId: null,
  viewMode: 'tabs',
  defaultShell: navigator.platform.startsWith('Win') ? 'powershell' : navigator.platform.startsWith('Mac') ? 'zsh' : 'bash',
  showSettings: false,

  addTerminal: (t) => set(s => ({
    terminals: [...s.terminals, t],
    activeTerminalId: t.id,
    showSettings: false,
  })),

  removeTerminal: (id) => set(s => {
    const remaining = s.terminals.filter(t => t.id !== id)
    const nextActive = s.activeTerminalId === id
      ? (remaining[remaining.length - 1]?.id ?? null)
      : s.activeTerminalId
    return { terminals: remaining, activeTerminalId: nextActive }
  }),

  updateTerminal: (id, patch) => set(s => ({
    terminals: s.terminals.map(t => t.id === id ? { ...t, ...patch } : t),
  })),

  setActiveTerminal: (id) => set({ activeTerminalId: id, showSettings: false }),

  toggleViewMode: () => set(s => ({ viewMode: s.viewMode === 'tabs' ? 'grid' : 'tabs' })),

  setShowSettings: (show) => set(s => ({
    showSettings: show,
    activeTerminalId: show ? null : s.activeTerminalId,
  })),

  setDefaultShell: (shell) => set({ defaultShell: shell }),

  addWorkspace: (name) => set(s => ({
    workspaces: [...s.workspaces, {
      id: uuid(),
      name,
      terminals: s.terminals.map(({ name, color, shellType }) => ({ name, color, shellType })),
    }],
  })),

  removeWorkspace: (id) => set(s => ({
    workspaces: s.workspaces.filter(w => w.id !== id),
  })),
}))
