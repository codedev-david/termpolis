import React, { useEffect, useState } from 'react'
import type { AgentActivityEvent } from '../../types'
import {
  parseEventsToTrace,
  type TraceEntry,
} from '../../lib/conductorTraceParser'

interface Props {
  conductorTerminalId: string | null
  limit?: number
}

const KIND_COLOR: Record<string, string> = {
  message: '#9cdcfe',
  tool_call: '#c586c0',
  task_assigned: '#22d3ee',
  task_completed: '#98c379',
  error: '#e06c75',
  handoff: '#d7a45a',
}

const KIND_LABEL: Record<string, string> = {
  message: 'THINK',
  tool_call: 'TOOL',
  task_assigned: 'ASSIGN',
  task_completed: 'DONE',
  error: 'ERR',
  handoff: 'HANDOFF',
}

function timeStr(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return ''
  }
}

export function ConductorTrace({ conductorTerminalId, limit = 100 }: Props) {
  const [entries, setEntries] = useState<TraceEntry[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!conductorTerminalId) {
      setEntries([])
      return
    }
    let disposed = false
    const api = window.agentActivity
    if (!api) return

    async function seed() {
      setLoading(true)
      try {
        const res = await api!.query({
          terminalId: conductorTerminalId!,
          limit,
        })
        if (disposed) return
        const events: AgentActivityEvent[] =
          res?.success && Array.isArray(res.data) ? res.data : []
        setEntries(parseEventsToTrace(events))
      } catch {
        if (!disposed) setEntries([])
      } finally {
        if (!disposed) setLoading(false)
      }
    }
    seed()

    const unsub = api.onEvent?.((ev) => {
      if (disposed) return
      if (ev.terminalId !== conductorTerminalId) return
      const parsed = parseEventsToTrace([ev])
      if (parsed.length === 0) return
      setEntries((prev) => {
        const next = [...prev, ...parsed].sort((a, b) => a.ts - b.ts)
        return next.slice(-limit)
      })
    })

    return () => {
      disposed = true
      try { unsub?.() } catch {}
    }
  }, [conductorTerminalId, limit])

  if (!conductorTerminalId) {
    return (
      <div className="text-[#6a6a6a] text-xs p-4" data-testid="conductor-trace">
        No swarm conductor running.
      </div>
    )
  }

  return (
    <div
      className="flex flex-col h-full overflow-auto text-xs bg-[#1e1e1e] border border-[#3c3c3c] rounded"
      data-testid="conductor-trace"
    >
      <div className="px-3 py-1.5 border-b border-[#3c3c3c] text-[10px] uppercase tracking-wide text-[#858585] flex justify-between">
        <span>Conductor trace</span>
        <span>{loading ? 'loading…' : `${entries.length} events`}</span>
      </div>
      {entries.length === 0 && !loading && (
        <div className="text-[#6a6a6a] text-xs p-4">No activity from the conductor yet.</div>
      )}
      {entries.map((e) => (
        <div
          key={e.id}
          data-testid="trace-entry"
          className="flex items-start gap-2 px-3 py-1 border-b border-[#2d2d2d]"
        >
          <span
            className="shrink-0 mt-0.5 text-[9px] font-mono rounded px-1 py-px"
            style={{
              color: KIND_COLOR[e.kind] ?? '#cccccc',
              borderColor: KIND_COLOR[e.kind] ?? '#cccccc',
              borderWidth: 1,
              borderStyle: 'solid',
            }}
          >
            {KIND_LABEL[e.kind] ?? e.kind}
          </span>
          <span className="shrink-0 text-[9px] text-[#858585] mt-0.5 w-[60px]">
            {timeStr(e.ts)}
          </span>
          <span className="flex-1 min-w-0 text-[#cccccc] break-words">
            {e.title}
            {e.target && (
              <span className="text-[#22d3ee]"> → {e.target}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

export default ConductorTrace
