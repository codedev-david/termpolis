import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTerminalStore } from '../../store/terminalStore'

interface WorkflowSidebarSectionProps {
  /** Open an existing workflow (edit / run) by id. */
  onOpen: (id: string) => void
  /** Start authoring a brand-new workflow. */
  onCreate: () => void
}

/**
 * Permanent "WORKFLOWS (n)" section that lives under Workspaces in the sidebar
 * (Azure-Logic-Apps style). Lists saved workflows; a row whose workflow has a
 * currently-running run pulses a green dot. Purely presentational over the
 * store — no IPC of its own; parent wires open/create.
 */
export function WorkflowSidebarSection({ onOpen, onCreate }: WorkflowSidebarSectionProps) {
  const { workflows, activeRuns } = useTerminalStore(
    useShallow(s => ({ workflows: s.workflows, activeRuns: s.activeRuns }))
  )
  const [collapsed, setCollapsed] = useState(false)

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
        <button
          onClick={onCreate}
          title="New Workflow"
          className="text-[#9ca3af] hover:text-white text-xs px-1"
        ><i className="fa-solid fa-plus"></i></button>
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
