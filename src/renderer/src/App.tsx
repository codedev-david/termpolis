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
import { SwarmDashboard } from './components/SwarmDashboard/SwarmDashboard'
import { TitleBar } from './components/TitleBar/TitleBar'
import { StatusBar } from './components/StatusBar/StatusBar'
import { Welcome } from './components/Welcome/Welcome'
import { AddTerminalModal } from './components/Sidebar/AddTerminalModal'
import { useTerminalStore, buildPaneTree } from './store/terminalStore'
import { matchesKeybinding, DEFAULT_KEYBINDINGS } from './lib/keybindings'
import { getHomedir } from './lib/homedir'
import { TERMINAL_DEFAULTS } from './lib/terminalDefaults'
import { v4 as uuid } from 'uuid'
import type { ShellInfo } from './types'
import { resolveAgentCommand, testDelay } from './lib/testAgents'

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
  const [showSwarmDashboard, setShowSwarmDashboard] = useState(false)
  const launchingAgent = useTerminalStore(s => s.launchingAgent)
  const setLaunchingAgent = useTerminalStore(s => s.setLaunchingAgent)
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([])
  const [restoring, setRestoring] = useState(true)
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
        // Infer agent commands from terminal names for sessions saved before agentCommand existed
        const KNOWN_AGENTS: Record<string, string> = {
          'Claude Code': 'claude',
          'OpenAI Codex': 'codex',
          'Gemini CLI': 'gemini',
          'Aider + Qwen3': 'aider --model ollama/qwen3-coder --no-show-model-warnings',
        }
        const resolvedSaved = saved.map(t => ({
          ...t,
          agentCommand: t.agentCommand || KNOWN_AGENTS[t.name] || undefined,
        }))
        // Update store with resolved agentCommands so they persist on next save
        useTerminalStore.setState({ terminals: resolvedSaved })

        // Spawn all terminals in parallel for faster startup
        const agentTerminals = resolvedSaved.filter(t => t.agentCommand)
        if (agentTerminals.length > 0) {
          setLaunchingAgent(agentTerminals[0].name)
        }
        Promise.all(resolvedSaved.map(t => window.termpolis.createTerminal(t.id, t.shellType, t.cwd))).then(() => {
          // Re-launch agent commands after shells initialize
          if (agentTerminals.length > 0) {
            setTimeout(() => {
              for (const t of agentTerminals) {
                window.termpolis.writeToTerminal(t.id, resolveAgentCommand(t.agentCommand!) + '\r')
              }
              setRestoring(false)
            }, testDelay(3000))
            // Auto-trust for Claude/Codex terminals on restore (agent sent at 3s, trust prompt ~5s later)
            const trustTerminals = agentTerminals.filter(t => t.agentCommand?.startsWith('claude') || t.agentCommand?.startsWith('codex'))
            for (const t of trustTerminals) {
              setTimeout(() => window.termpolis.writeToTerminal(t.id, '\r'), testDelay(9000))
            }
            const hasSlowAgent = agentTerminals.some(t => t.agentCommand === 'gemini' || t.agentCommand?.startsWith('aider'))
            setTimeout(() => setLaunchingAgent(null), testDelay(hasSlowAgent ? 15000 : 8000))
          } else {
            // No agent terminals — just show terminals after a brief shell init
            setTimeout(() => setRestoring(false), testDelay(1500))
          }
        })
      } else {
        setRestoring(false)
      }
      loaded.current = true
    })

    // Load available shells in parallel with session restore
    window.termpolis.getAvailableShells().then(res => {
      if (res.success && res.data) setAvailableShells(res.data)
    })
  }, [])

  // Expose agent check for close confirmation dialog in main process
  useEffect(() => {
    (window as any).__termpolis_has_agents = () => {
      return terminals.some(t => t.agentCommand)
    }
  }, [terminals])

  // Persist session on state changes (debounced to avoid excessive writes)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!loaded.current) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const state = useTerminalStore.getState()
      window.termpolis.saveSession({
        terminals: state.terminals.filter(t => !t.isSwarm),
        workspaces: state.workspaces,
        defaultShell: state.defaultShell,
        viewMode: state.viewMode,
        keybindings: state.keybindings,
        aiProfiles: state.aiProfiles,
        promptTemplates: state.promptTemplates,
      })
    }, 1000) // debounce 1 second
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

      // Ctrl+Shift+S to toggle swarm dashboard
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        e.preventDefault()
        setShowSwarmDashboard(v => !v)
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
    const TERMINAL_COLORS = ['#22D3EE', '#81C784', '#FFB74D', '#E57373', '#BA68C8', '#4DB6AC', '#FF8A65']
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
      case 'show_swarm':
        setShowSwarmDashboard(v => !v)
        break
      case 'launch_claude':
      case 'launch_codex':
      case 'launch_gemini': {
        const profiles: Record<string, typeof AGENT_CONFIGS[string]> = {
          launch_claude: { name: 'Claude Code', command: 'claude', color: '#D97706' },
          launch_codex: { name: 'OpenAI Codex', command: 'codex', color: '#10B981' },
          launch_gemini: { name: 'Gemini CLI', command: 'gemini', color: '#4285F4' },
        }
        const prof = profiles[action]
        const dirRes = await window.termpolis.pickDirectory()
        if (!dirRes.success || !dirRes.data) break
        const pCwd = dirRes.data
        const pId = uuid()
        const pShellType = navigator.platform.startsWith('Win') ? 'powershell' as const : 'bash' as const
        const pRes = await window.termpolis.createTerminal(pId, pShellType, pCwd)
        if (pRes.success) {
          addTerminal({ id: pId, name: prof.name, color: prof.color, shellType: pShellType, cwd: pCwd, fontSize: 14, theme: 'dark', fontFamily: 'Consolas, "Courier New", monospace', agentCommand: prof.command })
          setTimeout(() => window.termpolis.writeToTerminal(pId, resolveAgentCommand(prof.command) + '\r'), testDelay(3000))
          if (prof.command === 'claude' || prof.command === 'codex') {
            setTimeout(() => window.termpolis.writeToTerminal(pId, '\r'), testDelay(9000))
          }
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

  const AGENT_CONFIGS: Record<string, { name: string; command: string; color: string }> = {
    claude: { name: 'Claude Code', command: 'claude', color: '#D97706' },
    codex: { name: 'OpenAI Codex', command: 'codex', color: '#10B981' },
    gemini: { name: 'Gemini CLI', command: 'gemini', color: '#4285F4' },
    'aider-qwen': { name: 'Aider + Qwen3', command: 'aider --model ollama/qwen3-coder --no-show-model-warnings', color: '#06B6D4' },
  }

  const handleWelcomeLaunchAgent = async (agentId: string) => {
    const config = AGENT_CONFIGS[agentId]
    if (!config) return
    // Prompt user to pick a project directory
    const dirRes = await window.termpolis.pickDirectory()
    if (!dirRes.success || !dirRes.data) return  // user cancelled
    const cwd = dirRes.data
    setLaunchingAgent(config.name)
    const id = uuid()
    const shellType = navigator.platform.startsWith('Win') ? 'powershell' as const : 'bash' as const
    const res = await window.termpolis.createTerminal(id, shellType, cwd)
    if (res.success) {
      addTerminal({ id, name: config.name, color: config.color, shellType, cwd, fontSize: 14, theme: 'dark', fontFamily: 'Consolas, "Courier New", monospace', agentCommand: config.command })
      setTimeout(() => window.termpolis.writeToTerminal(id, resolveAgentCommand(config.command) + '\r'), testDelay(3000))
      if (config.command.startsWith('claude') || config.command.startsWith('codex')) {
        setTimeout(() => window.termpolis.writeToTerminal(id, '\r'), testDelay(9000))
      }
      const dismissMs = (agentId === 'gemini' || agentId === 'aider-qwen') ? 15000 : 8000
      setTimeout(() => setLaunchingAgent(null), testDelay(dismissMs))
    } else {
      setLaunchingAgent(null)
    }
  }

  // showSwarmFromWelcome triggers the existing swarm dashboard
  const handleStartSwarmFromWelcome = () => setShowSwarmDashboard(true)

  const renderMain = () => {
    if (showSettings) return <Suspense fallback={<div className="flex items-center justify-center h-full text-[#6b7280]">Loading settings...</div>}><SettingsPane /></Suspense>
    if (terminals.length === 0 || restoring) {
      return (
        <Welcome
          onNewTerminal={() => setShowAddModal(true)}
          onLaunchAgent={handleWelcomeLaunchAgent}
          onStartSwarm={handleStartSwarmFromWelcome}
        />
      )
    }
    if (viewMode === 'split') return <SplitView />
    return <TabView />
  }

  return (
    <div className="flex flex-col h-screen bg-[#1e1e1e] text-[#d4d4d4] overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden relative">
          {renderMain()}
          {launchingAgent && (
            <div
              className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-[#1e1e1e]/85 backdrop-blur-sm cursor-pointer"
              onClick={() => setLaunchingAgent(null)}
            >
              <div className="relative mb-6">
                <div className="w-16 h-16 rounded-full border-2 border-[#22D3EE]/30 border-t-[#22D3EE] animate-spin"></div>
                <i className="fa-solid fa-robot text-[#22D3EE] text-xl absolute inset-0 flex items-center justify-center"></i>
              </div>
              <h3 className="text-sm font-semibold text-[#d4d4d4] mb-1">Launching {launchingAgent}</h3>
              <p className="text-xs text-[#6b7280]">Waiting for agent to initialize...</p>
              <p className="text-[10px] text-[#555] mt-4">Click anywhere to dismiss</p>
            </div>
          )}
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
      {showSwarmDashboard && (
        <SwarmDashboard
          onClose={() => setShowSwarmDashboard(false)}
        />
      )}
    </div>
  )
}
