import React, { useEffect, useRef, useState, lazy, Suspense } from 'react'
import { Sidebar } from './components/Sidebar/Sidebar'
import { TabView } from './components/TabView/TabView'
import { SplitView } from './components/SplitView/SplitView'
const SettingsPane = lazy(() => import('./components/SettingsPane/SettingsPane').then(m => ({ default: m.SettingsPane })))
import { HistorySearchModal } from './components/HistorySearch/HistorySearchModal'
import { PromptTemplates } from './components/PromptTemplates/PromptTemplates'
import { ContextPanel } from './components/ContextPanel/ContextPanel'
import { CommandPalette } from './components/CommandPalette/CommandPalette'
import { ConversationSearch } from './components/ConversationSearch/ConversationSearch'
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
    defaultShell, keybindings, aiProfiles, promptTemplates,
    addTerminal, removeTerminal, setActiveTerminal,
    toggleViewMode, setShowSettings, setSidebarCollapsed,
  } = useTerminalStore()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [showPrompts, setShowPrompts] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [showContextPanel, setShowContextPanel] = useState(false)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [showConversationSearch, setShowConversationSearch] = useState(false)
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([])
  const started = useRef(false)
  const loaded = useRef(false)

  // Restore session on mount (guard against StrictMode double-fire)
  useEffect(() => {
    if (started.current) return
    started.current = true
    window.termpolis.loadSession().then(res => {
      if (res.success && res.data) {
        const { terminals: saved, workspaces, defaultShell: ds, viewMode: vm, keybindings: kb, aiProfiles: ap, promptTemplates: pt } = res.data
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
          aiProfiles: ap ?? [],
          promptTemplates: pt ?? [],
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
      aiProfiles: state.aiProfiles,
      promptTemplates: state.promptTemplates,
    })
  }, [terminals, workspaces, keybindings, aiProfiles, promptTemplates])

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

      // Ctrl+K to toggle command palette
      if (e.ctrlKey && !e.shiftKey && e.key === 'k') {
        e.preventDefault()
        setShowCommandPalette(v => !v)
        return
      }

      // Ctrl+Shift+I to toggle conversation search
      if (e.ctrlKey && e.shiftKey && e.key === 'I') {
        e.preventDefault()
        setShowConversationSearch(v => !v)
        return
      }

      // Ctrl+Shift+E to toggle context panel
      if (e.ctrlKey && e.shiftKey && e.key === 'E') {
        e.preventDefault()
        setShowContextPanel(v => !v)
        return
      }

      // Ctrl+Shift+P to toggle prompt templates
      if (e.ctrlKey && e.shiftKey && e.key === 'P') {
        e.preventDefault()
        setShowPrompts(v => !v)
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

  // Listen for MCP server events (AI agent created/closed terminals)
  useEffect(() => {
    const TERMINAL_COLORS = ['#4FC3F7', '#81C784', '#FFB74D', '#E57373', '#BA68C8', '#4DB6AC', '#FF8A65']
    const unsubCreated = window.mcpEvents?.onTerminalCreated((data) => {
      const color = TERMINAL_COLORS[useTerminalStore.getState().terminals.length % TERMINAL_COLORS.length]
      addTerminal({
        id: data.id,
        name: data.name,
        color,
        shellType: data.shell as any,
        cwd: data.cwd,
        fontSize: TERMINAL_DEFAULTS.fontSize,
        theme: TERMINAL_DEFAULTS.theme,
        fontFamily: TERMINAL_DEFAULTS.fontFamily,
      })
    })
    const unsubClosed = window.mcpEvents?.onTerminalClosed((terminalId) => {
      removeTerminal(terminalId)
    })
    return () => {
      unsubCreated?.()
      unsubClosed?.()
    }
  }, [addTerminal, removeTerminal])

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

  const handleCommandPaletteAction = async (action: string, captured?: string) => {
    const state = useTerminalStore.getState()
    switch (action) {
      case 'create_terminal':
        setShowAddModal(true)
        break
      case 'split_right':
      case 'split_down':
        // These are handled at the SplitView level; toggle to split mode if in tabs
        if (state.viewMode === 'tabs') toggleViewMode()
        break
      case 'close_terminal':
        if (state.activeTerminalId) {
          window.termpolis.killTerminal(state.activeTerminalId)
          removeTerminal(state.activeTerminalId)
        }
        break
      case 'toggle_sidebar':
        setSidebarCollapsed(!state.sidebarCollapsed)
        break
      case 'toggle_split':
        toggleViewMode()
        setShowSettings(false)
        break
      case 'open_settings':
        setShowSettings(true)
        break
      case 'search_history':
        setHistoryOpen(true)
        break
      case 'save_workspace': {
        const name = `Workspace ${state.workspaces.length + 1}`
        useTerminalStore.getState().addWorkspace(name)
        break
      }
      case 'export_output':
        // Trigger export via context menu logic -- no direct hook, so just alert
        break
      case 'start_recording':
        // Recording is per-terminal, handled in TerminalPane context menu
        break
      case 'show_context':
        setShowContextPanel(v => !v)
        break
      case 'show_prompts':
        setShowPrompts(v => !v)
        break
      case 'launch_claude': {
        const claudeProfile = { id: 'claude', name: 'Claude Code', icon: 'fa-solid fa-robot', command: 'claude', shell: 'bash', color: '#D97706' }
        const cId = uuid()
        const cCwd = await getHomedir()
        const shellType = navigator.platform.startsWith('Win') ? 'powershell' as const : 'bash' as const
        const res = await window.termpolis.createTerminal(cId, shellType, cCwd)
        if (res.success) {
          addTerminal({ id: cId, name: claudeProfile.name, color: claudeProfile.color, shellType, cwd: cCwd, fontSize: 14, theme: 'defaultDark', fontFamily: "'Cascadia Code', 'Consolas', monospace" })
          setTimeout(() => window.termpolis.writeToTerminal(cId, claudeProfile.command + '\r'), 500)
        }
        break
      }
      case 'launch_codex': {
        const codexProfile = { id: 'codex', name: 'OpenAI Codex', icon: 'fa-solid fa-microchip', command: 'codex', shell: 'bash', color: '#10B981' }
        const xId = uuid()
        const xCwd = await getHomedir()
        const shellType = navigator.platform.startsWith('Win') ? 'powershell' as const : 'bash' as const
        const res = await window.termpolis.createTerminal(xId, shellType, xCwd)
        if (res.success) {
          addTerminal({ id: xId, name: codexProfile.name, color: codexProfile.color, shellType, cwd: xCwd, fontSize: 14, theme: 'defaultDark', fontFamily: "'Cascadia Code', 'Consolas', monospace" })
          setTimeout(() => window.termpolis.writeToTerminal(xId, codexProfile.command + '\r'), 500)
        }
        break
      }
      case 'launch_gemini': {
        const geminiProfile = { id: 'gemini', name: 'Gemini CLI', icon: 'fa-brands fa-google', command: 'gemini', shell: 'bash', color: '#4285F4' }
        const gId = uuid()
        const gCwd = await getHomedir()
        const gShellType = navigator.platform.startsWith('Win') ? 'powershell' as const : 'bash' as const
        const gRes = await window.termpolis.createTerminal(gId, gShellType, gCwd)
        if (gRes.success) {
          addTerminal({ id: gId, name: geminiProfile.name, color: geminiProfile.color, shellType: gShellType, cwd: gCwd, fontSize: 14, theme: 'dark', fontFamily: 'Consolas, "Courier New", monospace' })
          setTimeout(() => window.termpolis.writeToTerminal(gId, geminiProfile.command + '\r'), 500)
        }
        break
      }
      case 'run_command':
        if (captured && state.activeTerminalId) {
          window.termpolis.writeToTerminal(state.activeTerminalId, captured + '\r')
        }
        break
      case 'goto_terminal':
        if (captured) {
          const idx = parseInt(captured) - 1
          if (idx >= 0 && idx < state.terminals.length) {
            setActiveTerminal(state.terminals[idx].id)
          }
        }
        break
    }
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
        {showContextPanel && (
          <ContextPanel
            cwd={terminals.find(t => t.id === activeTerminalId)?.cwd ?? ''}
            onClose={() => setShowContextPanel(false)}
          />
        )}
      </div>
      <StatusBar />
      {historyOpen && <HistorySearchModal onClose={() => setHistoryOpen(false)} />}
      {showPrompts && <PromptTemplates onClose={() => setShowPrompts(false)} />}
      {showAddModal && (
        <AddTerminalModal
          shells={availableShells}
          nextIndex={terminals.length + 1}
          defaultShell={defaultShell}
          onCreate={handleCreateTerminal}
          onCancel={() => setShowAddModal(false)}
        />
      )}
      {showCommandPalette && (
        <CommandPalette
          onAction={handleCommandPaletteAction}
          onClose={() => setShowCommandPalette(false)}
        />
      )}
      {showConversationSearch && (
        <ConversationSearch
          onClose={() => setShowConversationSearch(false)}
        />
      )}
    </div>
  )
}
