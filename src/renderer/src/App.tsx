import React, { useEffect, useRef, useState, lazy, Suspense } from 'react'
import { Sidebar } from './components/Sidebar/Sidebar'
import { TabView } from './components/TabView/TabView'
import { SplitView } from './components/SplitView/SplitView'
const SettingsPane = lazy(() => import('./components/SettingsPane/SettingsPane').then(m => ({ default: m.SettingsPane })))
import { HistorySearchModal } from './components/HistorySearch/HistorySearchModal'
import { TitleBar } from './components/TitleBar/TitleBar'
import { StatusBar } from './components/StatusBar/StatusBar'
import { AddTerminalModal } from './components/Sidebar/AddTerminalModal'
import { useTerminalStore, buildPaneTree } from './store/terminalStore'
import { matchesKeybinding, DEFAULT_KEYBINDINGS } from './lib/keybindings'
import { getHomedir } from './lib/homedir'
import { TERMINAL_DEFAULTS } from './lib/terminalDefaults'
import { v4 as uuid } from 'uuid'
import type { ShellInfo } from './types'

export default function App() {
  const {
    viewMode, showSettings, terminals, workspaces, activeTerminalId,
    defaultShell, keybindings,
    addTerminal, removeTerminal, setActiveTerminal,
    toggleViewMode, setShowSettings, setSidebarCollapsed,
  } = useTerminalStore()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([])
  const started = useRef(false)
  const loaded = useRef(false)

  // Restore session on mount (guard against StrictMode double-fire)
  useEffect(() => {
    if (started.current) return
    started.current = true
    window.termpolis.loadSession().then(res => {
      if (res.success && res.data) {
        const { terminals: saved, workspaces, defaultShell: ds, viewMode: vm, keybindings: kb } = res.data
        // Migration defaults already applied by sessionStore.loadSession in main process
        // Migrate old 'grid' viewMode to 'split'
        const resolvedVm = (vm as string) === 'grid' ? 'split' as const : vm
        useTerminalStore.setState({
          terminals: saved,
          workspaces,
          defaultShell: ds,
          viewMode: resolvedVm,
          activeTerminalId: saved[0]?.id ?? null,
          keybindings: { ...DEFAULT_KEYBINDINGS, ...(kb ?? {}) },
          paneTree: resolvedVm === 'split' ? buildPaneTree(saved.map(t => t.id)) : null,
        })
        // Spawn all terminals in parallel for faster startup
        Promise.all(saved.map(t => window.termpolis.createTerminal(t.id, t.shellType, t.cwd)))
      }
      loaded.current = true
    })

    // Load available shells in parallel with session restore
    window.termpolis.getAvailableShells().then(res => {
      if (res.success && res.data) setAvailableShells(res.data)
    })
  }, [])

  // Persist session on terminal or workspace changes (skip until restore completes)
  useEffect(() => {
    if (!loaded.current) return
    const state = useTerminalStore.getState()
    window.termpolis.saveSession({
      terminals: state.terminals,
      workspaces: state.workspaces,
      defaultShell: state.defaultShell,
      viewMode: state.viewMode,
      keybindings: state.keybindings,
    })
  }, [terminals, workspaces, keybindings])

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const kb = useTerminalStore.getState().keybindings

      if (matchesKeybinding(e, kb.historySearch)) {
        e.preventDefault()
        setHistoryOpen(v => !v)
        return
      }

      if (matchesKeybinding(e, kb.newTerminal)) {
        e.preventDefault()
        setShowAddModal(true)
        return
      }

      if (matchesKeybinding(e, kb.closeTerminal)) {
        e.preventDefault()
        const { activeTerminalId } = useTerminalStore.getState()
        if (activeTerminalId) {
          window.termpolis.killTerminal(activeTerminalId)
          removeTerminal(activeTerminalId)
        }
        return
      }

      if (matchesKeybinding(e, kb.nextTerminal)) {
        e.preventDefault()
        const { terminals, activeTerminalId } = useTerminalStore.getState()
        if (terminals.length === 0) return
        const idx = terminals.findIndex(t => t.id === activeTerminalId)
        const next = terminals[(idx + 1) % terminals.length]
        setActiveTerminal(next.id)
        return
      }

      if (matchesKeybinding(e, kb.prevTerminal)) {
        e.preventDefault()
        const { terminals, activeTerminalId } = useTerminalStore.getState()
        if (terminals.length === 0) return
        const idx = terminals.findIndex(t => t.id === activeTerminalId)
        const prev = terminals[(idx - 1 + terminals.length) % terminals.length]
        setActiveTerminal(prev.id)
        return
      }

      if (matchesKeybinding(e, kb.toggleSidebar)) {
        e.preventDefault()
        const { sidebarCollapsed } = useTerminalStore.getState()
        setSidebarCollapsed(!sidebarCollapsed)
        return
      }

      if (matchesKeybinding(e, kb.toggleGrid)) {
        e.preventDefault()
        const { activeTerminalId: aid, terminals: terms } = useTerminalStore.getState()
        toggleViewMode()
        setShowSettings(false)
        if (!aid && terms.length > 0) {
          setActiveTerminal(terms[0].id)
        }
        return
      }

      // Alt+1 through Alt+9 to jump to terminal by index
      if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const { terminals: terms } = useTerminalStore.getState()
        const idx = parseInt(e.key) - 1
        if (idx < terms.length) {
          setActiveTerminal(terms[idx].id)
        }
        return
      }
    }

    window.addEventListener('keydown', handler)

    // Listen for global Win+Shift+T hotkey from main process
    const unsubGlobal = window.globalEvents?.onNewTerminal(() => {
      setShowAddModal(true)
    })

    return () => {
      window.removeEventListener('keydown', handler)
      unsubGlobal?.()
    }
  }, [removeTerminal, setActiveTerminal, setSidebarCollapsed, toggleViewMode, setShowSettings])

  const handleCreateTerminal = async (opts: { name: string; shellType: any; color: string; fontSize?: number; theme?: string; fontFamily?: string }) => {
    const id = uuid()
    const cwd = await getHomedir()
    const res = await window.termpolis.createTerminal(id, opts.shellType, cwd)
    if (!res.success) { alert(`Failed to open terminal: ${res.error}`); return }
    addTerminal({
      id,
      name: opts.name,
      color: opts.color,
      shellType: opts.shellType,
      cwd,
      fontSize: opts.fontSize ?? TERMINAL_DEFAULTS.fontSize,
      theme: opts.theme ?? TERMINAL_DEFAULTS.theme,
      fontFamily: opts.fontFamily ?? TERMINAL_DEFAULTS.fontFamily,
    })
    setShowAddModal(false)
  }

  const renderMain = () => {
    if (showSettings) return <Suspense fallback={<div className="flex items-center justify-center h-full text-[#6b7280]">Loading settings...</div>}><SettingsPane /></Suspense>
    if (viewMode === 'split') return <SplitView />
    return <TabView />
  }

  return (
    <div className="flex flex-col h-screen bg-[#1e1e1e] text-[#d4d4d4] overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden">
          {renderMain()}
        </main>
      </div>
      <StatusBar />
      {historyOpen && <HistorySearchModal onClose={() => setHistoryOpen(false)} />}
      {showAddModal && (
        <AddTerminalModal
          shells={availableShells}
          nextIndex={terminals.length + 1}
          defaultShell={defaultShell}
          onCreate={handleCreateTerminal}
          onCancel={() => setShowAddModal(false)}
        />
      )}
    </div>
  )
}
