import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTerminalStore } from '../../store/terminalStore'
import { TerminalTab } from './TerminalTab'
import { AddTerminalModal } from './AddTerminalModal'
import { WorkspaceList } from './WorkspaceList'
import { AIProfiles } from './AIProfiles'
import { SwarmDashboard } from '../SwarmDashboard/SwarmDashboard'
import { GitPanel } from '../GitPanel/GitPanel'
import { WorkflowSidebarSection } from '../Workflow/WorkflowSidebarSection'
import { WorkflowOverlayBody, type WorkflowOverlayView } from '../Workflow/WorkflowOverlayBody'
import { getHomedir } from '../../lib/homedir'
import { v4 as uuid } from 'uuid'
import type { ShellInfo } from '../../types'
import { getTerminalDefaults } from '../../lib/terminalDefaults'

export function Sidebar() {
  // useShallow so the sidebar re-renders only when a field it actually reads changes — not on every
  // store write (conversations, notifications, cwd churn). Store actions are stable references, so
  // including them in the selection never causes an extra render.
  const {
    terminals, activeTerminalId, viewMode, showSettings, defaultShell,
    addTerminal, removeTerminal, updateTerminal,
    setActiveTerminal, toggleViewMode, setShowSettings,
    sidebarCollapsed, setSidebarCollapsed, swarmActive, setWorkflows,
  } = useTerminalStore(useShallow(s => ({
    terminals: s.terminals, activeTerminalId: s.activeTerminalId, viewMode: s.viewMode,
    showSettings: s.showSettings, defaultShell: s.defaultShell,
    addTerminal: s.addTerminal, removeTerminal: s.removeTerminal, updateTerminal: s.updateTerminal,
    setActiveTerminal: s.setActiveTerminal, toggleViewMode: s.toggleViewMode, setShowSettings: s.setShowSettings,
    sidebarCollapsed: s.sidebarCollapsed, setSidebarCollapsed: s.setSidebarCollapsed, swarmActive: s.swarmActive,
    setWorkflows: s.setWorkflows,
  })))

  const [showAddModal, setShowAddModal] = useState(false)
  const [showSwarm, setShowSwarm] = useState(false)
  const [showGit, setShowGit] = useState(false)
  // The workflow orchestrator overlay: null = closed, else authoring a new
  // workflow or opening an existing one by id. The Designer/Runner render
  // inside this frame (Tasks 13/14); the frame + open/close lives here.
  const [workflowView, setWorkflowView] = useState<WorkflowOverlayView | null>(null)
  // Bumped after a save so the sidebar list re-reads the persisted workflows.
  const [workflowNonce, setWorkflowNonce] = useState(0)
  const [homeCwd, setHomeCwd] = useState<string | null>(null)
  const [swarmCwd, setSwarmCwd] = useState<string | null>(null)
  const [terminalsCollapsed, setTerminalsCollapsed] = useState(false)
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([])

  useEffect(() => {
    window.termpolis.getAvailableShells().then(res => {
      if (res.success && res.data) setAvailableShells(res.data)
    })
  }, [])

  // Resolve the workflow project directory: the active terminal's cwd, else the
  // first terminal's, else the home directory. Workflows are stored per-project
  // under <cwd>/.termpolis/workflows, so the sidebar list + overlay are scoped
  // to whatever project the user is currently working in.
  useEffect(() => {
    getHomedir().then(setHomeCwd).catch(() => setHomeCwd('~'))
  }, [])
  const workflowCwd =
    terminals.find(t => t.id === activeTerminalId)?.cwd ?? terminals[0]?.cwd ?? homeCwd

  // Load the current project's saved workflows into the store so the sidebar
  // section lists them; re-runs when the project changes or after a save.
  useEffect(() => {
    if (!workflowCwd) return
    let alive = true
    // Register the project with main so its schedule/git/file triggers arm for
    // the directory the user is actually working in, not just the home store.
    window.termpolis.watchWorkflowProject?.(workflowCwd)
    window.termpolis.listWorkflows(workflowCwd).then(res => {
      if (alive && res.success && res.data) setWorkflows(res.data)
    })
    return () => {
      alive = false
    }
  }, [workflowCwd, workflowNonce, setWorkflows])

  const handleCreate = async (opts: { name: string; shellType: any; color: string; fontSize?: number; theme?: string; fontFamily?: string }) => {
    const id = uuid()
    const cwd = await getHomedir()
    const res = await window.termpolis.createTerminal(id, opts.shellType, cwd)
    if (!res.success) { alert(`Failed to open terminal: ${res.error}`); return }
    const defaults = getTerminalDefaults()
    addTerminal({
      id,
      name: opts.name,
      color: opts.color,
      shellType: opts.shellType,
      cwd,
      fontSize: opts.fontSize ?? defaults.fontSize,
      theme: opts.theme ?? defaults.theme,
      fontFamily: opts.fontFamily ?? defaults.fontFamily,
    })
    setShowAddModal(false)
  }

  const handleClose = (id: string) => {
    window.termpolis.killTerminal(id)
    removeTerminal(id)
  }

  if (sidebarCollapsed) {
    return (
      <aside className="w-10 shrink-0 flex flex-col items-center bg-[#252526] border-r border-[#3c3c3c] h-full py-2" style={{ transition: 'width 200ms ease' }}>
        <button
          onClick={() => setSidebarCollapsed(false)}
          className="text-[#9ca3af] hover:text-white px-2 py-3 rounded hover:bg-[#37373d]"
          title="Expand sidebar"
        ><i className="fa-solid fa-chevron-right text-lg"></i></button>
      </aside>
    )
  }

  return (
    <aside className="shrink-0 flex flex-col bg-[#252526] border-r border-[#3c3c3c] h-full" style={{ width: 240, transition: 'width 200ms ease' }}>
      <div className="flex items-center px-1.5 py-1.5 border-b border-[#3c3c3c] overflow-hidden">
        <button
          onClick={() => setShowSettings(!showSettings)}
          title="Settings"
          className={`px-2.5 py-2 rounded text-base text-[#999] hover:text-white hover:bg-[#37373d] ${showSettings ? 'bg-[#37373d] text-white' : ''}`}
        ><i className="fa-solid fa-gear"></i></button>
        <button
          onClick={() => {
            toggleViewMode()
            setShowSettings(false)
            if (!activeTerminalId && terminals.length > 0) {
              setActiveTerminal(terminals[0].id)
            }
          }}
          title={viewMode === 'tabs' ? 'Split View' : 'Tab View'}
          className="px-2.5 py-2 rounded text-base text-[#999] hover:text-white hover:bg-[#37373d]"
        ><i className={`fa-solid ${viewMode === 'tabs' ? 'fa-columns' : 'fa-bars'}`}></i></button>
        <button
          onClick={() => setShowGit(true)}
          title="Git Panel"
          className="px-2.5 py-2 rounded text-base text-[#999] hover:text-white hover:bg-[#37373d]"
        ><i className="fa-brands fa-git-alt"></i></button>
        <button
          onClick={async () => {
            const swarmActive = useTerminalStore.getState().swarmActive
            if (swarmActive) {
              setSwarmCwd(null)
              setShowSwarm(true)
            } else {
              const res = await window.termpolis.pickDirectory()
              if (res.success && res.data) {
                setSwarmCwd(res.data)
                setShowSwarm(true)
              }
            }
          }}
          title="Swarm Dashboard (Ctrl+Shift+S)"
          className={`relative px-2.5 py-2 rounded text-base hover:bg-[#37373d] transition-colors ${swarmActive ? 'text-[#22c55e] hover:text-[#4ade80]' : 'text-[#999] hover:text-white'}`}
        >
          <i className="fa-solid fa-network-wired"></i>
          {swarmActive && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[#22c55e] animate-pulse"></span>}
        </button>
        <div className="flex-1"></div>
        <button
          onClick={() => setSidebarCollapsed(true)}
          title="Collapse sidebar"
          className="px-2.5 py-2 rounded text-base text-[#999] hover:text-white hover:bg-[#37373d]"
        ><i className="fa-solid fa-chevron-left"></i></button>
      </div>
      <AIProfiles availableShells={availableShells} />
      <div className="border-t border-[#3c3c3c]"></div>
      <WorkspaceList />
      <div className="border-t border-[#3c3c3c]"></div>
      <WorkflowSidebarSection
        onCreate={seed => setWorkflowView({ mode: 'new', seed })}
        onOpen={id => setWorkflowView({ mode: 'edit', id })}
      />
      <div className="px-3 py-1.5 flex items-center justify-between">
        <button onClick={() => setTerminalsCollapsed(!terminalsCollapsed)} className="flex items-center gap-1.5 text-xs text-[#9ca3af] uppercase tracking-wider hover:text-[#d4d4d4]">
          <i className={`fa-solid fa-chevron-${terminalsCollapsed ? 'right' : 'down'} text-[9px]`}></i>
          Terminals
          <span className="text-[10px] normal-case tracking-normal">({terminals.filter(t => !t.hidden).length})</span>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {!terminalsCollapsed && terminals.filter(t => !t.hidden).map((t, i) => (
          <TerminalTab
            key={t.id}
            terminal={t}
            index={i}
            isActive={t.id === activeTerminalId && !showSettings}
            onClick={() => setActiveTerminal(t.id)}
            onClose={() => handleClose(t.id)}
            onUpdate={patch => updateTerminal(t.id, patch)}
          />
        ))}
      </div>
      <div className="p-2 border-t border-[#3c3c3c]">
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-3 py-2 rounded text-sm hover:bg-[#37373d] text-[#22D3EE] w-full"
        >+ Add Terminal</button>
      </div>
      {showAddModal && (
        <AddTerminalModal
          shells={availableShells}
          nextIndex={terminals.length + 1}
          defaultShell={defaultShell}
          onCreate={handleCreate}
          onCancel={() => setShowAddModal(false)}
        />
      )}
      {showSwarm && <SwarmDashboard onClose={() => { setShowSwarm(false); setSwarmCwd(null) }} initialCwd={swarmCwd} />}
      {showGit && <GitPanel onClose={() => setShowGit(false)} />}
      {workflowView && (
        <div
          role="dialog"
          aria-label="Workflow"
          className="fixed inset-0 z-50 flex flex-col bg-[#1e1e1e]"
        >
          <div className="flex items-center justify-between px-4 py-2 border-b border-[#3c3c3c]">
            <span className="text-sm text-[#d4d4d4]">
              <i className="fa-solid fa-diagram-project text-[#22D3EE] mr-2"></i>
              {workflowView.mode === 'new' ? 'New Workflow' : 'Edit Workflow'}
            </span>
            <button
              onClick={() => setWorkflowView(null)}
              title="Close workflow"
              aria-label="Close workflow"
              className="px-2 py-1 rounded text-[#999] hover:text-white hover:bg-[#37373d]"
            ><i className="fa-solid fa-xmark"></i></button>
          </div>
          {/* Designer (Task 13) / Runner (Task 14) render inside this frame. */}
          <div className="flex-1 overflow-auto">
            <WorkflowOverlayBody
              view={workflowView}
              cwd={workflowCwd}
              onSaved={() => setWorkflowNonce(n => n + 1)}
            />
          </div>
        </div>
      )}
    </aside>
  )
}
