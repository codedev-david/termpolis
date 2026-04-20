import type { AgentActivityEvent, AgentActivityKind, AgentActivityType } from '../types'

/**
 * Pure logic helpers for the Activity Feed — separated from the React
 * component so they can be unit-tested without jsdom + React rendering.
 */

export const MAX_FEED_EVENTS = 2000

export interface FeedFilters {
  terminalId?: string | null
  agentType?: AgentActivityType | null
  kinds?: AgentActivityKind[] | null
  search?: string
}

export function applyFilters(
  events: AgentActivityEvent[],
  filters: FeedFilters,
): AgentActivityEvent[] {
  if (!events || events.length === 0) return []
  const needle = filters.search?.trim().toLowerCase() ?? ''
  const kinds = filters.kinds && filters.kinds.length > 0 ? new Set(filters.kinds) : null
  return events.filter((e) => {
    if (filters.terminalId && e.terminalId !== filters.terminalId) return false
    if (filters.agentType && e.agentType !== filters.agentType) return false
    if (kinds && !kinds.has(e.kind)) return false
    if (needle) {
      const hay =
        `${e.summary} ${e.agentType} ${e.kind} ${e.terminalId}`.toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })
}

export function mergeEvents(
  existing: AgentActivityEvent[],
  incoming: AgentActivityEvent[],
): AgentActivityEvent[] {
  if (!incoming || incoming.length === 0) return existing
  // De-dup by id, keeping order stable (newest at end), then cap.
  const seen = new Set<string>()
  const out: AgentActivityEvent[] = []
  for (const e of existing) {
    if (!e || !e.id) continue
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  for (const e of incoming) {
    if (!e || !e.id) continue
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  // Sort by timestamp to handle out-of-order arrivals
  out.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  if (out.length > MAX_FEED_EVENTS) {
    return out.slice(out.length - MAX_FEED_EVENTS)
  }
  return out
}

export function formatEventTime(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const delta = Math.max(0, now - ts)
  if (delta < 1000) return 'just now'
  const s = Math.floor(delta / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

const KIND_COLORS: Record<AgentActivityKind, string> = {
  message: '#61afef',
  tool_call: '#c678dd',
  tool_result: '#98c379',
  token_update: '#e5c07b',
  compaction: '#d19a66',
  error: '#e06c75',
  status_change: '#56b6c2',
  mcp_audit: '#abb2bf',
}

export function kindColor(kind: AgentActivityKind): string {
  return KIND_COLORS[kind] ?? '#abb2bf'
}

export function shortLabel(event: AgentActivityEvent, maxLength = 80): string {
  const s = String(event.summary ?? '').trim()
  if (!s) {
    if (event.kind === 'tool_result') return 'tool result'
    return event.kind
  }
  if (s.length <= maxLength) return s
  return s.slice(0, maxLength - 1) + '…'
}
