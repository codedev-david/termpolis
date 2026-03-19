import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { TerminalSession, Workspace, ViewMode, ShellType } from '../types'
import { DEFAULT_KEYBINDINGS, type KeybindingMap } from '../lib/keybindings'

interface TerminalStore {
  terminals: TerminalSession[]
  workspaces: Workspace[]
  activeTerminalId: string | null
  viewMode: ViewMode
  defaultShell: ShellType
  showSettings: boolean
  autocompleteEnabled: boolean
  sidebarCollapsed: boolean
  keybindings: KeybindingMap

  addTerminal: (t: TerminalSession) => void
  removeTerminal: (id: string) => void
  updateTerminal: (id: string, patch: Partial<Omit<TerminalSession, 'id'>>) => void
  setActiveTerminal: (id: string | null) => void
  toggleViewMode: () => void
  setShowSettings: (show: boolean) => void
  setDefaultShell: (shell: ShellType) => void
  addWorkspace: (name: string) => void
  renameWorkspace: (id: string, name: string) => void
  updateWorkspace: (id: string) => void
  removeWorkspace: (id: string) => void
  setAutocompleteEnabled: (enabled: boolean) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setKeybinding: (action: keyof KeybindingMap, binding: string) => void
  resetKeybindings: () => void
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  terminals: [],
  workspaces: [],
  activeTerminalId: null,
  viewMode: 'tabs',
  defaultShell: navigator.platform.startsWith('Win') ? 'powershell' : navigator.platform.startsWith('Mac') ? 'zsh' : 'bash',
  showSettings: false,
  autocompleteEnabled: true,
  sidebarCollapsed: false,
  keybindings: { ...DEFAULT_KEYBINDINGS },

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
      terminals: s.terminals.map(({ id, ...rest }) => rest),
    }],
  })),

  renameWorkspace: (id, name) => set(s => ({
    workspaces: s.workspaces.map(w => w.id === id ? { ...w, name } : w),
  })),

  updateWorkspace: (id) => set(s => ({
    workspaces: s.workspaces.map(w => w.id === id
      ? { ...w, terminals: s.terminals.map(({ id, ...rest }) => rest) }
      : w
    ),
  })),

  removeWorkspace: (id) => set(s => ({
    workspaces: s.workspaces.filter(w => w.id !== id),
  })),

  setAutocompleteEnabled: (enabled) => set({ autocompleteEnabled: enabled }),

  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  setKeybinding: (action, binding) => set(s => ({
    keybindings: { ...s.keybindings, [action]: binding },
  })),

  resetKeybindings: () => set({ keybindings: { ...DEFAULT_KEYBINDINGS } }),
}))
