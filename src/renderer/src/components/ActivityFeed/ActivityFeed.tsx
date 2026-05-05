import { useMemo, useState } from 'react'
import { useActivityFeed } from '../../hooks/useActivityFeed'
import {
  applyFilters,
  formatEventTime,
  kindColor,
  shortLabel,
  type FeedFilters,
} from '../../lib/activityFeed'
import type { AgentActivityKind, AgentActivityType } from '../../types'
import { InterventionControls } from './InterventionControls'

interface Props {
  /** Scope to a specific terminal; omit for global feed */
  terminalId?: string
  onClose?: () => void
}

const KIND_OPTIONS: AgentActivityKind[] = [
  'message',
  'tool_call',
  'tool_result',
  'token_update',
  'compaction',
  'error',
  'status_change',
  'mcp_audit',
]

const AGENT_OPTIONS: AgentActivityType[] = ['claude', 'codex', 'gemini', 'qwen-code']

export function ActivityFeed({ terminalId, onClose }: Props) {
  const { events } = useActivityFeed()
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<AgentActivityKind | ''>('')
  const [agentFilter, setAgentFilter] = useState<AgentActivityType | ''>('')

  const filtered = useMemo(() => {
    const filters: FeedFilters = {
      terminalId: terminalId ?? null,
      agentType: agentFilter || null,
      kinds: kindFilter ? [kindFilter] : null,
      search,
    }
    // Show newest-first in the UI
    return [...applyFilters(events, filters)].reverse()
  }, [events, terminalId, agentFilter, kindFilter, search])

  return (
    <div
      className="flex flex-col h-full border-l border-[#3c3c3c] bg-[#252526] select-none"
      data-testid="activity-feed"
      style={{ minWidth: 320 }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#3c3c3c]">
        <div className="text-xs font-semibold text-[#cccccc] uppercase tracking-wide">
          Agent Activity {terminalId ? '(terminal)' : ''}
        </div>
        {onClose && (
          <button
            className="text-[#858585] hover:text-white text-xs px-2"
            onClick={onClose}
            aria-label="Close activity feed"
          >
            ×
          </button>
        )}
      </div>

      {terminalId && <InterventionControls terminalId={terminalId} />}

      <div className="px-3 py-2 border-b border-[#3c3c3c] space-y-2">
        <input
          type="text"
          placeholder="Search activity…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-[#1e1e1e] border border-[#3c3c3c] text-xs text-[#cccccc] px-2 py-1 rounded focus:outline-none focus:border-[#007acc]"
          aria-label="Search activity"
        />
        <div className="flex gap-2">
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter((e.target.value as AgentActivityKind) || '')}
            className="flex-1 bg-[#1e1e1e] border border-[#3c3c3c] text-xs text-[#cccccc] px-1 py-1 rounded"
            aria-label="Filter by kind"
          >
            <option value="">all kinds</option>
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter((e.target.value as AgentActivityType) || '')}
            className="flex-1 bg-[#1e1e1e] border border-[#3c3c3c] text-xs text-[#cccccc] px-1 py-1 rounded"
            aria-label="Filter by agent"
          >
            <option value="">all agents</option>
            {AGENT_OPTIONS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-1 py-1" role="list">
        {filtered.length === 0 && (
          <div className="text-[#6a6a6a] text-xs text-center py-6">
            No agent activity yet.
          </div>
        )}
        {filtered.map((e) => (
          <div
            key={e.id}
            role="listitem"
            className="px-2 py-1 border-b border-[#2d2d2d] text-xs hover:bg-[#2a2d2e]"
            data-testid="activity-item"
          >
            <div className="flex items-center gap-2">
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: kindColor(e.kind) }}
                aria-hidden="true"
              />
              <span className="text-[#569cd6] uppercase text-[10px]">{e.agentType}</span>
              <span className="text-[#858585] text-[10px]">{e.kind}</span>
              <span className="ml-auto text-[#6a6a6a] text-[10px]">
                {formatEventTime(e.ts)}
              </span>
            </div>
            <div className="text-[#cccccc] mt-0.5 truncate" title={e.summary}>
              {shortLabel(e)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default ActivityFeed
