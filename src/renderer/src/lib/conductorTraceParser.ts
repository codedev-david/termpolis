import type { AgentActivityEvent } from '../types'

export type TraceEntryKind =
  | 'message'
  | 'tool_call'
  | 'task_assigned'
  | 'task_completed'
  | 'error'
  | 'handoff'

export interface TraceEntry {
  id: string
  ts: number
  kind: TraceEntryKind
  title: string
  detail?: string
  tool?: string
  target?: string
}

const MAX_TITLE = 200
const MAX_DETAIL = 600

function clip(s: string, max: number): string {
  if (!s) return ''
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

function summarizeMessage(text: unknown): string {
  if (typeof text !== 'string') return ''
  return clip(text.replace(/\s+/g, ' ').trim(), MAX_TITLE)
}

function looksLikeTaskAssign(text: string): { target?: string } | null {
  const m =
    /assign(?:ing)?[^a-z]+task\s+(?:to\s+)?([a-z][a-z0-9_\- ]{2,40})/i.exec(text) ||
    /delegat(?:e|ing)\s+to\s+([a-z][a-z0-9_\- ]{2,40})/i.exec(text) ||
    /handing off to\s+([a-z][a-z0-9_\- ]{2,40})/i.exec(text)
  if (!m) return null
  return { target: m[1].trim() }
}

function looksLikeCompletion(text: string): boolean {
  return /\b(task|work)\s+(complete|done|finished)\b/i.test(text) || /\ball agents done\b/i.test(text)
}

function looksLikeError(text: string): boolean {
  return /\berror:|\bfailed\b|\bexception\b/i.test(text)
}

function toolTitle(tool: string, input: unknown): string {
  if (!input || typeof input !== 'object') return tool
  const rec = input as Record<string, unknown>
  for (const k of ['file_path', 'path', 'command', 'cmd', 'url', 'query']) {
    const v = rec[k]
    if (typeof v === 'string' && v.length > 0) {
      return clip(`${tool}: ${v}`, MAX_TITLE)
    }
  }
  return tool
}

export function parseEventToTrace(ev: AgentActivityEvent): TraceEntry | null {
  if (!ev) return null

  if (ev.kind === 'tool_call') {
    const tool = typeof ev.payload?.tool === 'string' ? (ev.payload.tool as string) : 'tool'
    return {
      id: ev.id,
      ts: ev.ts,
      kind: 'tool_call',
      title: toolTitle(tool, ev.payload?.input),
      tool,
    }
  }

  if (ev.kind === 'error') {
    return {
      id: ev.id,
      ts: ev.ts,
      kind: 'error',
      title: clip(ev.summary || 'error', MAX_TITLE),
      detail: clip(String((ev.payload as any)?.message ?? ev.summary ?? ''), MAX_DETAIL),
    }
  }

  if (ev.kind === 'message') {
    const text = (ev.payload as any)?.text ?? ev.summary ?? ''
    const textStr = typeof text === 'string' ? text : ''
    if (!textStr.trim()) return null

    const assign = looksLikeTaskAssign(textStr)
    if (assign) {
      return {
        id: ev.id,
        ts: ev.ts,
        kind: 'task_assigned',
        title: summarizeMessage(textStr),
        target: assign.target,
      }
    }

    if (looksLikeCompletion(textStr)) {
      return {
        id: ev.id,
        ts: ev.ts,
        kind: 'task_completed',
        title: summarizeMessage(textStr),
      }
    }

    if (looksLikeError(textStr)) {
      return {
        id: ev.id,
        ts: ev.ts,
        kind: 'error',
        title: summarizeMessage(textStr),
      }
    }

    return {
      id: ev.id,
      ts: ev.ts,
      kind: 'message',
      title: summarizeMessage(textStr),
    }
  }

  return null
}

export function parseEventsToTrace(events: AgentActivityEvent[]): TraceEntry[] {
  const out: TraceEntry[] = []
  for (const ev of events) {
    const t = parseEventToTrace(ev)
    if (t) out.push(t)
  }
  out.sort((a, b) => a.ts - b.ts)
  return out
}

export function detectHandoff(entries: TraceEntry[]): TraceEntry | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]
    if (e.kind === 'task_assigned' && e.target) return e
  }
  return null
}
