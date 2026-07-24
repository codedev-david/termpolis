import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTerminalStore } from '../../store/terminalStore'
import type { Workflow } from '../../types'
import { STARTER_WORKFLOWS } from './starterWorkflows'

interface WorkflowSidebarSectionProps {
  /** Open an existing workflow (edit / run) by id. */
  onOpen: (id: string) => void
  /** Author a new workflow — no seed → blank; a seed → from a starter template. */
  onCreate: (seed?: Workflow) => void
}

/**
 * Permanent "WORKFLOWS (n)" section that lives under Workspaces in the sidebar
 * (Azure-Logic-Apps style). Lists saved workflows; a row whose workflow has a
 * currently-running run pulses a green dot. Purely presentational over the
 * store — no IPC of its own; parent wires open/create. The "+" opens a menu:
 * a blank workflow, or "New from template" seeded from a starter.
 */
export function WorkflowSidebarSection({ onOpen, onCreate }: WorkflowSidebarSectionProps) {
  const { workflows, activeRuns } = useTerminalStore(
    useShallow(s => ({ workflows: s.workflows, activeRuns: s.activeRuns }))
  )
  const [collapsed, setCollapsed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const isRunning = (id: string) =>
    Object.values(activeRuns).some(r => r.workflowId === id && r.status === 'running')

  return (
    <div className="border-b border-[#3c3c3c]">
      <div className="px-3 py-1.5 flex items-center justify-between">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-1.5 text-xs text-[#9ca3af] uppercase tracking-wider hover:text-[#d4d4d4]"
        >
          <i className={`fa-solid fa-chevron-${collapsed ? 'right' : 'down'} text-[9px]`}></i>
          Workflows
          <span className="text-[10px] normal-case tracking-normal">({workflows.length})</span>
        </button>
        <div className="relative">
          <button
            onClick={() => setMenuOpen(o => !o)}
            title="New Workflow"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="text-[#9ca3af] hover:text-white text-xs px-1"
          ><i className="fa-solid fa-plus"></i></button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 z-10 w-56 py-1 bg-[#252526] border border-[#3c3c3c] rounded shadow-lg"
            >
              <button
                role="menuitem"
                onClick={() => { setMenuOpen(false); onCreate() }}
                className="block w-full px-3 py-1.5 text-sm text-left text-[#d4d4d4] hover:bg-[#37373d]"
              >Blank workflow</button>
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[#6b7280]">New from template</div>
              {STARTER_WORKFLOWS.map(t => (
                <button
                  key={t.id}
                  role="menuitem"
                  title={t.description}
                  onClick={() => { setMenuOpen(false); onCreate(t) }}
                  className="block w-full px-3 py-1.5 text-sm text-left text-[#d4d4d4] hover:bg-[#37373d]"
                >{t.name}</button>
              ))}
            </div>
          )}
        </div>
      </div>
      {!collapsed && workflows.map(w => (
        <button
          key={w.id}
          onClick={() => onOpen(w.id)}
          className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left text-[#d4d4d4] hover:bg-[#37373d]"
        >
          <i className="fa-solid fa-diagram-project text-[#9ca3af] text-xs"></i>
          <span className="flex-1 truncate">{w.name}</span>
          {isRunning(w.id) && <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] animate-pulse shrink-0"></span>}
        </button>
      ))}
    </div>
  )
}
