import { useEffect, useRef, useState, lazy, Suspense } from 'react'
import { Sidebar } from './components/Sidebar/Sidebar'
import { TabView } from './components/TabView/TabView'
import { SplitView } from './components/SplitView/SplitView'
const SettingsPane = lazy(() => import('./components/SettingsPane/SettingsPane').then(m => ({ default: m.SettingsPane })))
const HistorySearchModal = lazy(() => import('./components/HistorySearch/HistorySearchModal').then(m => ({ default: m.HistorySearchModal })))
const PromptTemplates = lazy(() => import('./components/PromptTemplates/PromptTemplates').then(m => ({ default: m.PromptTemplates })))
const ContextPanel = lazy(() => import('./components/ContextPanel/ContextPanel').then(m => ({ default: m.ContextPanel })))
const Memory = lazy(() => import('./components/Memory/Memory').then(m => ({ default: m.Memory })))
const ActivityFeed = lazy(() => import('./components/ActivityFeed/ActivityFeed').then(m => ({ default: m.ActivityFeed })))
const ContextPinsPanel = lazy(() => import('./components/ContextPins/ContextPinsPanel').then(m => ({ default: m.ContextPinsPanel })))
const RedundancyPanel = lazy(() => import('./components/RedundancyPanel/RedundancyPanel').then(m => ({ default: m.RedundancyPanel })))
const EfficiencyPanel = lazy(() => import('./components/EfficiencyPanel/EfficiencyPanel').then(m => ({ default: m.EfficiencyPanel })))
const CommandPalette = lazy(() => import('./components/CommandPalette/CommandPalette').then(m => ({ default: m.CommandPalette })))
const ConversationSearch = lazy(() => import('./components/ConversationSearch/ConversationSearch').then(m => ({ default: m.ConversationSearch })))
const SwarmDashboard = lazy(() => import('./components/SwarmDashboard/SwarmDashboard').then(m => ({ default: m.SwarmDashboard })))
const SwarmCompleteDialog = lazy(() => import('./components/SwarmDashboard/SwarmCompleteDialog').then(m => ({ default: m.SwarmCompleteDialog })))
const AddTerminalModal = lazy(() => import('./components/Sidebar/AddTerminalModal').then(m => ({ default: m.AddTerminalModal })))
import { TitleBar } from './components/TitleBar/TitleBar'
import { StatusBar } from './components/StatusBar/StatusBar'
import { UpdateBanner } from './components/UpdateBanner/UpdateBanner'
import { SecretsRedactedBanner } from './components/SecretsRedactedBanner/SecretsRedactedBanner'
import { OnboardingModal, hasSeenOnboarding } from './components/Onboarding/OnboardingModal'
import { Welcome } from './components/Welcome/Welcome'
import { useTerminalStore, buildPaneTree } from './store/terminalStore'
import { matchesKeybinding, DEFAULT_KEYBINDINGS } from './lib/keybindings'
import { getHomedir } from './lib/homedir'
import { TERMINAL_DEFAULTS } from './lib/terminalDefaults'
import { v4 as uuid } from 'uuid'
import type { ShellInfo } from './types'
import { resolveAgentCommand, testDelay } from './lib/testAgents'
import { startBridgeForAgent, stopBridgeForAgent } from './lib/swarmBridgeManager'
import { detectAgentStatus } from './lib/agentStatusDetector'
import { detectDismissChar, tailSlice } from './lib/promptAutoDismiss'
import * as contextPressureLib from './lib/contextPressure'
import * as redundancyLib from './lib/redundancyDetector'
import * as efficiencyLib from './lib/efficiencyAnalyzer'

export default function App() {
  const {
    viewMode, showSettings, terminals, workspaces, activeTerminalId,
    defaultShell, keybindings, aiProfiles, promptTemplates, userWorkflows, agentRatingOverrides,
    addTerminal, removeTerminal, setActiveTerminal,
    toggleViewMode, setShowSettings, setSidebarCollapsed,
  } = useTerminalStore()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [showPrompts, setShowPrompts] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [showContextPanel, setShowContextPanel] = useState(false)
  const [showActivityFeed, setShowActivityFeed] = useState(false)
  const [showContextPins, setShowContextPins] = useState(false)
  const [showRedundancyPanel, setShowRedundancyPanel] = useState(false)
  const [showEfficiencyPanel, setShowEfficiencyPanel] = useState(false)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [showConversationSearch, setShowConversationSearch] = useState(false)
  const [showSwarmDashboard, setShowSwarmDashboard] = useState(false)
  const [showMemory, setShowMemory] = useState(false)
  const launchingAgent = useTerminalStore(s => s.launchingAgent)
  const setLaunchingAgent = useTerminalStore(s => s.setLaunchingAgent)
  const swarmNotification = useTerminalStore(s => s.swarmNotification)
  const setSwarmNotification = useTerminalStore(s => s.setSwarmNotification)
  const swarmCompletionSummary = useTerminalStore(s => s.swarmCompletionSummary)
  const setSwarmCompletionSummary = useTerminalStore(s => s.setSwarmCompletionSummary)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(() => !hasSeenOnboarding())
  const [swarmStartCwd, setSwarmStartCwd] = useState<string | null>(null)
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
        const { terminals: saved, workspaces, defaultShell: ds, viewMode: vm, keybindings: kb, aiProfiles: ap, promptTemplates: pt, userWorkflows: uw, agentRatingOverrides: aro } = res.data
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
          userWorkflows: uw ?? [],
          agentRatingOverrides: aro ?? {},
          paneTree: resolvedVm === 'split' ? buildPaneTree(saved.filter(t => !t.hidden).map(t => t.id)) : null,
        })
        // Infer agent commands from terminal names for sessions saved before agentCommand existed
        const KNOWN_AGENTS: Record<string, string> = {
          'Claude Code': 'claude',
          'OpenAI Codex': 'codex',
          'Gemini CLI': 'gemini',
          'Qwen Code': 'qwen',
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
          // Send a no-op newline to flush shell init, then the real command
          if (agentTerminals.length > 0) {
            setTimeout(() => {
              for (const t of agentTerminals) {
                window.termpolis.writeToTerminal(t.id, '\r')
              }
              setTimeout(() => {
                for (const t of agentTerminals) {
                  window.termpolis.writeToTerminal(t.id, resolveAgentCommand(t.agentCommand!) + '\r')
                }
                setRestoring(false)
              }, 500)
            }, testDelay(4000))
            // Auto-trust for Claude/Codex terminals on restore (agent sent at 4.5s, trust prompt ~5s later)
            const claudeTerminals = agentTerminals.filter(t => t.agentCommand?.startsWith('claude'))
            for (const t of claudeTerminals) {
              setTimeout(() => window.termpolis.writeToTerminal(t.id, '\r'), testDelay(10000))
            }
            const codexTerminals = agentTerminals.filter(t => t.agentCommand?.startsWith('codex'))
            for (const t of codexTerminals) {
              setTimeout(() => window.termpolis.writeToTerminal(t.id, '1\r'), testDelay(10000))
            }
            const hasSlowAgent = agentTerminals.some(t => t.agentCommand === 'gemini' || t.agentCommand?.startsWith('qwen'))
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
    // Read-only test inspection hook — used by e2e swarm tests
    ;(window as any).__termpolis_test_state = () => {
      const s = useTerminalStore.getState()
      return {
        terminals: s.terminals,
        swarmActive: s.swarmActive,
        swarmAgents: s.swarmAgents,
        swarmCompletionSummary: s.swarmCompletionSummary,
        swarmNotification: s.swarmNotification,
      }
    }
    // Bundled observability libs, exposed for e2e tests so they exercise
    // the real renderer build instead of a re-imported source copy.
    ;(window as any).__termpolis_test_libs = {
      contextPressure: contextPressureLib,
      redundancy: redundancyLib,
      efficiency: efficiencyLib,
    }
    // Narrow, named test-only setters. The full store is intentionally NOT
    // exposed so tests can't mutate arbitrary fields and mask regressions
    // against the real code paths. These setters are used by
    // e2e/ui-screens-show-results.spec.ts to seed state that normally comes
    // from the conductor, so the dialog/banner render paths can be asserted
    // without running a full swarm.
    ;(window as any).__setSwarmCompletionSummary = (summary: any) =>
      useTerminalStore.getState().setSwarmCompletionSummary(summary)
    ;(window as any).__setSwarmNotification = (n: any) =>
      useTerminalStore.getState().setSwarmNotification(n)
    // Focus a terminal id — used by e2e/context-pressure.spec.ts to scope the
    // status-bar pressure indicator to a known terminal (narrow setter, not the
    // full store, per the convention above).
    ;(window as any).__setActiveTerminal = (id: string | null) =>
      useTerminalStore.getState().setActiveTerminal(id)
    ;(window as any).__setShowSettings = (show: boolean) =>
      useTerminalStore.getState().setShowSettings(show)
    // Inject a hidden "test terminal" with a chosen cwd and mark it active.
    // Used by e2e/ui-screens-show-results.spec.ts so panels that derive
    // state from the active terminal's cwd (e.g. ContextPinsPanel) can be
    // exercised without spawning a real pty.
    ;(window as any).__openCommandPalette = (show: boolean) =>
      setShowCommandPalette(show)
    ;(window as any).__seedTestTerminalCwd = (cwd: string) => {
      const store = useTerminalStore.getState()
      const id = `__e2e_seed_${Math.random().toString(36).slice(2, 10)}`
      store.addTerminal({
        id,
        name: 'e2e-seed',
        color: '#888',
        shellType: 'bash' as any,
        cwd,
        fontSize: 12,
        theme: 'default',
        fontFamily: 'monospace',
        hidden: true,
      })
      store.setActiveTerminal(id)
      return id
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
        terminals: state.terminals.filter(t => !t.isSwarm && !t.hidden),
        workspaces: state.workspaces,
        defaultShell: state.defaultShell,
        viewMode: state.viewMode,
        keybindings: { ...state.keybindings },
        aiProfiles: state.aiProfiles,
        promptTemplates: state.promptTemplates,
        userWorkflows: state.userWorkflows,
        agentRatingOverrides: state.agentRatingOverrides,
      })
    }, 1000) // debounce 1 second
  }, [terminals, workspaces, keybindings, aiProfiles, promptTemplates, userWorkflows, agentRatingOverrides])

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

      // Ctrl+Shift+A to toggle activity feed
      if (e.ctrlKey && e.shiftKey && e.key === 'A') {
        e.preventDefault()
        setShowActivityFeed(v => !v)
        return
      }

      // Ctrl+Shift+B to toggle context pins panel
      if (e.ctrlKey && e.shiftKey && e.key === 'B') {
        e.preventDefault()
        setShowContextPins(v => !v)
        return
      }

      // Ctrl+Shift+D to toggle duplicate-work / redundancy panel
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault()
        setShowRedundancyPanel(v => !v)
        return
      }

      // Ctrl+Shift+Y to toggle efficiency panel
      if (e.ctrlKey && e.shiftKey && e.key === 'Y') {
        e.preventDefault()
        setShowEfficiencyPanel(v => !v)
        return
      }

      // Ctrl+Shift+M to toggle the memory panel
      if (e.ctrlKey && e.shiftKey && e.key === 'M') {
        e.preventDefault()
        setShowMemory(v => !v)
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

      // Ctrl+/ opens the Keybindings/Shortcuts panel
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === '/' || e.key === '?')) {
        e.preventDefault()
        setShowSettings(true)
        window.dispatchEvent(new CustomEvent('termpolis:openShortcuts'))
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

    // Listen for global Win+Shift+S hotkey to toggle swarm dashboard
    const unsubSwarm = window.globalEvents?.onToggleSwarm(() => {
      setShowSwarmDashboard(v => !v)
    })

    const unsubClose = window.globalEvents?.onConfirmClose(() => {
      setShowCloseConfirm(true)
    })

    // Listen for request from status bar to open context pins panel
    const onOpenPins = () => setShowContextPins(true)
    window.addEventListener('termpolis:openContextPins', onOpenPins)

    // Listen for "Show tour again" from the Help modal
    const onReopenOnboarding = () => setShowOnboarding(true)
    window.addEventListener('termpolis:reopenOnboarding', onReopenOnboarding)

    // Listen for the Settings "Open the Memory panel" link (SettingsPane is
    // rendered propless, so a window event is the bridge — like openContextPins)
    const onOpenMemory = () => setShowMemory(true)
    window.addEventListener('termpolis:openMemory', onOpenMemory)

    return () => {
      window.removeEventListener('keydown', handler)
      window.removeEventListener('termpolis:openContextPins', onOpenPins)
      window.removeEventListener('termpolis:reopenOnboarding', onReopenOnboarding)
      window.removeEventListener('termpolis:openMemory', onOpenMemory)
      unsubGlobal?.()
      unsubSwarm?.()
      unsubClose?.()
    }
  }, [removeTerminal, setActiveTerminal, setSidebarCollapsed, toggleViewMode, setShowSettings])

  // Listen for MCP server events (AI agent created/closed terminals)
  useEffect(() => {
    const TERMINAL_COLORS = ['#22D3EE', '#81C784', '#FFB74D', '#E57373', '#BA68C8', '#4DB6AC', '#FF8A65']
    const unsubCreated = window.mcpEvents?.onTerminalCreated((data) => {
      const store = useTerminalStore.getState()
      const color = TERMINAL_COLORS[store.terminals.length % TERMINAL_COLORS.length]
      addTerminal({
        id: data.id,
        name: data.name,
        color,
        shellType: data.shell as any,
        cwd: data.cwd,
        fontSize: TERMINAL_DEFAULTS.fontSize,
        theme: TERMINAL_DEFAULTS.theme,
        fontFamily: TERMINAL_DEFAULTS.fontFamily,
        isSwarm: true,
        hidden: true,
      })

      // Extract agent name and role from terminal name (e.g. "Claude (Build UI)" → agent: "Claude", role: "Build UI")
      const nameMatch = data.name.match(/^(.+?)\s*\((.+)\)$/)
      const agentName = nameMatch ? nameMatch[1].trim() : data.name
      const role = nameMatch ? nameMatch[2].trim() : 'Agent'

      // Add to swarmAgents list so the dashboard shows them
      const updatedStore = useTerminalStore.getState()
      const newAgent = { terminalId: data.id, agentName, role, status: 'starting' as const }
      updatedStore.setSwarmAgents([...updatedStore.swarmAgents, newAgent])

      // Auto-trust is now handled by the polling loop below — it watches the
      // terminal buffer for the actual trust-prompt pattern and sends the
      // dismiss character as soon as it appears. The old timer-based approach
      // (fire at 10s + 15s) missed prompts that arrived early or late and sent
      // noise into agents that didn't need it.
      const isClaudeAgent = /claude/i.test(agentName)

      // Start bridge for non-MCP agents (output monitoring + signal detection)
      // Claude Code has native MCP, but others (Codex, Gemini, Qwen Code) need the bridge
      if (!isClaudeAgent) {
        startBridgeForAgent(data.id, agentName)
      }

      // Status detection is handled by the agent status polling effect below
    })
    const unsubClosed = window.mcpEvents?.onTerminalClosed((terminalId) => {
      stopBridgeForAgent(terminalId)
      // Remove from swarmAgents
      const store = useTerminalStore.getState()
      store.setSwarmAgents(store.swarmAgents.filter(a => a.terminalId !== terminalId))
      removeTerminal(terminalId)
    })
    return () => {
      unsubCreated?.()
      unsubClosed?.()
    }
  }, [addTerminal, removeTerminal])

  // Poll swarm agent terminals for real-time status detection
  useEffect(() => {
    // Remember the trust-prompt fingerprint we most recently dismissed for each
    // terminal, so we don't keep pounding Enter on the same prompt every tick.
    const lastDismissedPrompt = new Map<string, string>()
    // Clear the stale "needs input" notification once the agent has moved past
    // the trust prompt and back to actually working.
    const priorNotifKey = new Map<string, string>()

    const interval = setInterval(async () => {
      const store = useTerminalStore.getState()
      if (store.swarmAgents.length === 0) return

      for (const agent of store.swarmAgents) {
        // Don't re-detect completed or errored agents. We DO keep polling
        // blocked agents so we can clear the status if the user restarts
        // the CLI and it starts producing fresh output again.
        if (agent.status === 'completed' || agent.status === 'errored') continue

        try {
          const bufferRes = await window.termpolis.readTerminalBuffer(agent.terminalId)
          if (!bufferRes.success || !bufferRes.data) continue

          const output = bufferRes.data.output || ''
          const recent = output.slice(-3000)
          const tail = tailSlice(recent)

          // Pattern-based auto-dismiss for trust / onboarding / MCP prompts.
          // Keyed on the last ~200 chars of the buffer so we don't re-dismiss
          // after a prompt has scrolled off the visible region.
          const dismissKey = tail.slice(-200)
          const alreadyDismissed = lastDismissedPrompt.get(agent.terminalId) === dismissKey
          const dismissChar = detectDismissChar(tail, { agentName: agent.agentName })

          if (dismissChar && !alreadyDismissed) {
            lastDismissedPrompt.set(agent.terminalId, dismissKey)
            window.termpolis.writeToTerminal(agent.terminalId, dismissChar)
            // Give the agent a beat to register the input before the next poll
            // runs the status detector
            continue
          }

          const result = detectAgentStatus(recent, agent.agentName, agent.status)

          // Only update if status or summary actually changed
          if (result.status !== agent.status || (result.summary && result.summary !== agent.summary)) {
            store.updateSwarmAgentStatus(agent.terminalId, result.status, result.summary)

            // Notify user when agent needs input — but only once per prompt
            if (result.status === 'waiting_for_input' && agent.status !== 'waiting_for_input') {
              const notifKey = `${agent.terminalId}:${result.summary}`
              if (priorNotifKey.get(agent.terminalId) !== notifKey) {
                priorNotifKey.set(agent.terminalId, notifKey)
                store.setSwarmNotification({
                  message: `${agent.agentName} (${agent.role}) needs your input: ${result.summary}`,
                  type: 'error',
                })
              }
            }
            // Blocked agent — dead process, user needs to relaunch. Surface
            // once per transition; notifKey changes if the cause changes.
            if (result.status === 'blocked' && agent.status !== 'blocked') {
              const notifKey = `${agent.terminalId}:blocked:${result.summary}`
              if (priorNotifKey.get(agent.terminalId) !== notifKey) {
                priorNotifKey.set(agent.terminalId, notifKey)
                store.setSwarmNotification({
                  message: `${agent.agentName} (${agent.role}) is blocked: ${result.summary}`,
                  type: 'error',
                })
              }
            }
            // Clear any lingering "needs input" notification when the agent
            // moves back to working/thinking after we dismissed a prompt.
            if (result.status !== 'waiting_for_input' && agent.status === 'waiting_for_input') {
              priorNotifKey.delete(agent.terminalId)
              const n = store.swarmNotification
              if (n && n.message.includes(agent.agentName) && n.message.includes('needs your input')) {
                store.setSwarmNotification(null)
              }
            }
          }
        } catch {
          // Terminal may have been closed — skip
        }
      }
    }, testDelay(5000))

    return () => clearInterval(interval)
  }, [])

  // Prompt auto-dismiss for regular (non-swarm) AI agent terminals.
  // When a user launches Claude / Codex / Gemini / Qwen Code from the sidebar,
  // each tool shows first-run prompts (folder trust, MCP server trust,
  // "Press Enter to continue" splash). The swarm loop above handles this for
  // swarm-tracked agents; this loop covers everyone else. Two small loops
  // are simpler than merging them since the swarm loop also tracks status.
  useEffect(() => {
    const lastDismissedPrompt = new Map<string, string>()
    const interval = setInterval(async () => {
      const store = useTerminalStore.getState()
      const swarmIds = new Set(store.swarmAgents.map((a) => a.terminalId))
      const agentTerminals = store.terminals.filter(
        (t) => t.agentCommand && !swarmIds.has(t.id),
      )
      if (agentTerminals.length === 0) return

      for (const term of agentTerminals) {
        try {
          const bufferRes = await window.termpolis.readTerminalBuffer(term.id)
          if (!bufferRes.success || !bufferRes.data) continue
          const output = bufferRes.data.output || ''
          const tail = tailSlice(output.slice(-3000))
          const dismissKey = tail.slice(-200)
          if (lastDismissedPrompt.get(term.id) === dismissKey) continue
          const dismissChar = detectDismissChar(tail, { agentName: term.name })
          if (!dismissChar) continue
          lastDismissedPrompt.set(term.id, dismissKey)
          window.termpolis.writeToTerminal(term.id, dismissChar)
        } catch {
          // Terminal gone — skip
        }
      }
    }, testDelay(2000))

    return () => clearInterval(interval)
  }, [])

  // Auto-dismiss swarm notification after 15 seconds
  useEffect(() => {
    if (!swarmNotification) return
    const timer = setTimeout(() => setSwarmNotification(null), 15000)
    return () => clearTimeout(timer)
  }, [swarmNotification, setSwarmNotification])

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
      case 'show_memory':
        setShowMemory(v => !v)
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
          setTimeout(() => {
            window.termpolis.writeToTerminal(pId, '\r')
            setTimeout(() => window.termpolis.writeToTerminal(pId, resolveAgentCommand(prof.command) + '\r'), 500)
          }, testDelay(4000))
          if (prof.command === 'claude') {
            setTimeout(() => window.termpolis.writeToTerminal(pId, '\r'), testDelay(10000))
          }
          if (prof.command === 'codex') {
            setTimeout(() => window.termpolis.writeToTerminal(pId, '1\r'), testDelay(10000))
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
    'qwen-code': { name: 'Qwen Code', command: 'qwen', color: '#A855F7' },
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
      setTimeout(() => {
        window.termpolis.writeToTerminal(id, '\r')
        setTimeout(() => window.termpolis.writeToTerminal(id, resolveAgentCommand(config.command) + '\r'), 500)
      }, testDelay(4000))
      if (config.command.startsWith('claude')) {
        setTimeout(() => window.termpolis.writeToTerminal(id, '\r'), testDelay(10000))
      }
      if (config.command.startsWith('codex')) {
        setTimeout(() => window.termpolis.writeToTerminal(id, '1\r'), testDelay(10000))
      }
      const dismissMs = (agentId === 'gemini' || agentId === 'qwen-code') ? 15000 : 8000
      setTimeout(() => setLaunchingAgent(null), testDelay(dismissMs))
    } else {
      setLaunchingAgent(null)
    }
  }

  // Start swarm: pick directory first, then open dashboard with wizard
  const handleStartSwarm = async () => {
    const res = await window.termpolis.pickDirectory()
    if (res.success && res.data) {
      setSwarmStartCwd(res.data)
      setShowSwarmDashboard(true)
    }
  }

  const renderMain = () => {
    if (showSettings) return <Suspense fallback={<div className="flex items-center justify-center h-full text-[#6b7280]">Loading settings...</div>}><SettingsPane /></Suspense>
    if (terminals.length === 0 || restoring) {
      return (
        <Welcome
          onNewTerminal={() => setShowAddModal(true)}
          onLaunchAgent={handleWelcomeLaunchAgent}
          onStartSwarm={handleStartSwarm}
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
        <main className="flex-1 overflow-hidden relative flex flex-col">
          {swarmNotification && (
            <div className={`px-4 py-2.5 flex items-center justify-between text-sm ${
              swarmNotification.type === 'success'
                ? 'bg-green-900/30 border-b border-green-800/50 text-green-300'
                : 'bg-red-900/30 border-b border-red-800/50 text-red-300'
            }`}>
              <div className="flex items-center gap-2">
                <i className={`fa-solid ${swarmNotification.type === 'success' ? 'fa-check-circle' : 'fa-exclamation-triangle'}`}></i>
                <span>{swarmNotification.message}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowSwarmDashboard(true)}
                  className="text-xs px-2 py-1 rounded hover:bg-white/10"
                >
                  View Dashboard
                </button>
                <button
                  onClick={() => setSwarmNotification(null)}
                  className="text-xs px-1.5 py-1 rounded hover:bg-white/10"
                >
                  <i className="fa-solid fa-xmark"></i>
                </button>
              </div>
            </div>
          )}
          <div className="flex-1 overflow-hidden relative">
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
          </div>
        </main>
        <Suspense fallback={null}>
          {showContextPanel && (
            <ContextPanel
              cwd={terminals.find(t => t.id === activeTerminalId)?.cwd ?? ''}
              onClose={() => setShowContextPanel(false)}
            />
          )}
          {showActivityFeed && (
            <ActivityFeed
              terminalId={activeTerminalId ?? undefined}
              onClose={() => setShowActivityFeed(false)}
            />
          )}
          {showContextPins && (
            <ContextPinsPanel
              cwd={terminals.find(t => t.id === activeTerminalId)?.cwd ?? ''}
              onClose={() => setShowContextPins(false)}
            />
          )}
          {showRedundancyPanel && (
            <RedundancyPanel onClose={() => setShowRedundancyPanel(false)} />
          )}
          {showEfficiencyPanel && (
            <EfficiencyPanel onClose={() => setShowEfficiencyPanel(false)} />
          )}
          {showMemory && (
            <Memory
              activeTerminalId={activeTerminalId}
              activeCwd={terminals.find(t => t.id === activeTerminalId)?.cwd ?? ''}
              onClose={() => setShowMemory(false)}
            />
          )}
        </Suspense>
      </div>
      <UpdateBanner />
      <SecretsRedactedBanner />
      <StatusBar onSwarmClick={() => setShowSwarmDashboard(true)} />
      <Suspense fallback={null}>
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
            onClose={() => { setShowSwarmDashboard(false); setSwarmStartCwd(null) }}
            initialCwd={swarmStartCwd}
          />
        )}
        {swarmCompletionSummary && (
          <SwarmCompleteDialog
            message={swarmCompletionSummary.message}
            tasks={swarmCompletionSummary.tasks}
            projectCwd={swarmCompletionSummary.projectCwd ?? swarmStartCwd}
            preSwarmSha={swarmCompletionSummary.preSwarmSha}
            onViewDashboard={() => { setSwarmCompletionSummary(null); setShowSwarmDashboard(true) }}
            onReviewChanges={() => { setShowSwarmDashboard(true) }}
            onDismiss={() => setSwarmCompletionSummary(null)}
          />
        )}
      </Suspense>
      {showOnboarding && <OnboardingModal onDone={() => setShowOnboarding(false)} />}
      {showCloseConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70">
          <div className="bg-[#252526] border border-[#3c3c3c] rounded-xl shadow-2xl w-[420px] p-6 flex flex-col gap-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#D97706]/15 flex items-center justify-center">
                <i className="fa-solid fa-triangle-exclamation text-[#D97706]"></i>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-[#d4d4d4]">AI Agents Running</h3>
                <p className="text-xs text-[#6b7280]">Closing will stop all work in progress</p>
              </div>
            </div>
            <p className="text-xs text-[#999] leading-relaxed">
              AI agents are still running. Closing Termpolis will terminate all agents and any in-progress work will be lost.
            </p>
            <div className="flex items-center justify-end gap-2 mt-1">
              <button
                onClick={() => setShowCloseConfirm(false)}
                className="px-4 py-1.5 text-xs text-[#999] hover:text-white rounded hover:bg-[#37373d]"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowCloseConfirm(false); (window as any).globalEvents?.forceClose() }}
                className="px-4 py-1.5 text-xs rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 font-medium"
              >
                Close Anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
