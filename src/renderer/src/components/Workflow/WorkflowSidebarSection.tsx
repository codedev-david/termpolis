import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTerminalStore } from '../../store/terminalStore'
import type { WorkflowListItem, WorkflowScope } from '../../types'

interface WorkflowSidebarSectionProps {
  /** Open an existing workflow (edit / run). */
  onOpen: (id: string, scope: WorkflowScope) => void
  /** Author a new workflow. */
  onCreate: () => void
}

/** Rows with no category come first, then categories A-Z; names A-Z inside each. */
export function groupWorkflows(list: WorkflowListItem[]): { category: string; items: WorkflowListItem[] }[] {
  const byCategory = new Map<string, WorkflowListItem[]>()
  for (const w of list) {
    const key = (w.category || '').trim()
    const bucket = byCategory.get(key)
    if (bucket) bucket.push(w)
    else byCategory.set(key, [w])
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([category, items]) => ({ category, items: [...items].sort((x, y) => x.name.localeCompare(y.name)) }))
}

/**
 * Permanent "WORKFLOWS (n)" section that lives under Workspaces in the sidebar
 * (Azure-Logic-Apps style). Lists every saved workflow — the global ones, which
 * are offered in every project, and this project's own — grouped by category
 * within each. A row whose workflow has a currently-running run pulses a green
 * dot. Purely presentational over the store; the parent wires open/create.
 */
export function WorkflowSidebarSection({ onOpen, onCreate }: WorkflowSidebarSectionProps) {
  const { workflows, activeRuns } = useTerminalStore(
    useShallow(s => ({ workflows: s.workflows, activeRuns: s.activeRuns }))
  )
  const [collapsed, setCollapsed] = useState(false)
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({})

  const isRunning = (id: string) =>
    Object.values(activeRuns).some(r => r.workflowId === id && r.status === 'running')

  const toggleGroup = (key: string) => setClosedGroups(g => ({ ...g, [key]: !g[key] }))

  const scopes: { scope: WorkflowScope; label: string; hint: string }[] = [
    { scope: 'global', label: 'Global', hint: 'Available in every project' },
    { scope: 'project', label: 'This project', hint: 'Stored in this repo under .termpolis/workflows' },
  ]

  const rows = (items: WorkflowListItem[], scope: WorkflowScope, indent: string) => items.map(w => (
    <button
      key={`${scope}:${w.id}`}
      onClick={() => onOpen(w.id, scope)}
      className={`flex items-center gap-2 w-full ${indent} py-1.5 text-sm text-left text-[#d4d4d4] hover:bg-[#37373d]`}
      title={w.category ? `${w.category} — ${w.name}` : w.name}
    >
      <i className={`fa-solid ${scope === 'global' ? 'fa-earth-americas' : 'fa-diagram-project'} text-[#9ca3af] text-xs`}></i>
      <span className="flex-1 truncate">{w.name}</span>
      {isRunning(w.id) && <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] animate-pulse shrink-0"></span>}
    </button>
  ))

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
          title="Start Workflow"
          className="text-[#9ca3af] hover:text-white text-xs px-1"
        ><i className="fa-solid fa-plus"></i></button>
      </div>
      {!collapsed && scopes.map(({ scope, label, hint }) => {
        const mine = workflows.filter(w => (w.scope ?? 'project') === scope)
        if (!mine.length) return null
        const scopeClosed = closedGroups[scope]
        return (
          <div key={scope}>
            <button
              onClick={() => toggleGroup(scope)}
              title={hint}
              className="flex items-center gap-1.5 w-full px-3 py-1 text-[10px] uppercase tracking-wider text-[#6b7280] hover:text-[#9ca3af]"
            >
              <i className={`fa-solid fa-chevron-${scopeClosed ? 'right' : 'down'} text-[8px]`}></i>
              {label}
              <span className="normal-case tracking-normal">({mine.length})</span>
            </button>
            {!scopeClosed && groupWorkflows(mine).map(({ category, items }) => {
              if (!category) return <div key={`${scope}:__none__`}>{rows(items, scope, 'px-5')}</div>
              const key = `${scope}/${category}`
              const catClosed = closedGroups[key]
              return (
                <div key={key}>
                  <button
                    onClick={() => toggleGroup(key)}
                    className="flex items-center gap-1.5 w-full px-5 py-1 text-xs text-[#9ca3af] hover:text-[#d4d4d4]"
                  >
                    <i className={`fa-solid fa-folder${catClosed ? '' : '-open'} text-[10px]`}></i>
                    <span className="flex-1 truncate text-left">{category}</span>
                    <span className="text-[10px]">({items.length})</span>
                  </button>
                  {!catClosed && rows(items, scope, 'px-8')}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
