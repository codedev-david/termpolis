import type { AgentActivityEvent, AgentActivityType } from '../types'

export type RedundancyKind = 'file_edit' | 'file_read' | 'command' | 'tool_call'

export interface RedundancyParticipant {
  terminalId: string
  agentType: AgentActivityType
  ts: number
  eventId: string
}

export interface RedundancyFinding {
  id: string
  kind: RedundancyKind
  resource: string
  participants: RedundancyParticipant[]
  firstTs: number
  lastTs: number
  severity: 'low' | 'medium' | 'high'
  uniqueTerminals: number
}

export interface DetectRedundancyOptions {
  windowMs?: number
  minParticipants?: number
  ignoreTerminalIds?: string[]
  now?: number
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_MIN_PARTICIPANTS = 2

const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'patch_file',
])

const READ_TOOLS = new Set(['Read', 'read_file', 'view'])

const COMMAND_TOOLS = new Set(['Bash', 'PowerShell', 'shell', 'run_command'])

function extractString(input: unknown, keys: string[]): string | null {
  if (!input || typeof input !== 'object') return null
  const rec = input as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

export function normalizeCommand(cmd: string): string {
  return cmd
    .replace(/\s+/g, ' ')
    .replace(/\s*&&\s*/g, ' && ')
    .replace(/\s*(?<!\|)\|(?!\|)\s*/g, ' | ')
    .replace(/\s*\|\|\s*/g, ' || ')
    .trim()
    .toLowerCase()
}

function classify(event: AgentActivityEvent): { kind: RedundancyKind; resource: string } | null {
  if (event.kind !== 'tool_call') return null
  const toolRaw = (event.payload?.tool ?? event.payload?.name) as unknown
  const tool = typeof toolRaw === 'string' ? toolRaw : null
  if (!tool) return null

  const input = event.payload?.input

  if (EDIT_TOOLS.has(tool)) {
    const file = extractString(input, ['file_path', 'path', 'filename', 'notebook_path'])
    if (!file) return null
    return { kind: 'file_edit', resource: file }
  }

  if (READ_TOOLS.has(tool)) {
    const file = extractString(input, ['file_path', 'path', 'filename'])
    if (!file) return null
    return { kind: 'file_read', resource: file }
  }

  if (COMMAND_TOOLS.has(tool)) {
    const cmd = extractString(input, ['command', 'cmd'])
    if (!cmd) return null
    return { kind: 'command', resource: normalizeCommand(cmd) }
  }

  return null
}

function severityFor(kind: RedundancyKind, uniqueTerminals: number): 'low' | 'medium' | 'high' {
  if (kind === 'file_edit') {
    if (uniqueTerminals >= 3) return 'high'
    return 'medium'
  }
  if (kind === 'command') {
    if (uniqueTerminals >= 3) return 'medium'
    return 'low'
  }
  if (kind === 'file_read') {
    return 'low'
  }
  return 'low'
}

export function detectRedundancy(
  events: AgentActivityEvent[],
  opts: DetectRedundancyOptions = {},
): RedundancyFinding[] {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  const minParticipants = opts.minParticipants ?? DEFAULT_MIN_PARTICIPANTS
  const ignore = new Set(opts.ignoreTerminalIds ?? [])
  const now = opts.now ?? Date.now()
  const cutoff = now - windowMs

  type Bucket = { kind: RedundancyKind; resource: string; entries: RedundancyParticipant[] }
  const buckets = new Map<string, Bucket>()

  for (const ev of events) {
    if (!ev || ignore.has(ev.terminalId)) continue
    if (ev.ts < cutoff) continue
    const cls = classify(ev)
    if (!cls) continue
    const key = `${cls.kind}::${cls.resource}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { kind: cls.kind, resource: cls.resource, entries: [] }
      buckets.set(key, bucket)
    }
    bucket.entries.push({
      terminalId: ev.terminalId,
      agentType: ev.agentType,
      ts: ev.ts,
      eventId: ev.id,
    })
  }

  const findings: RedundancyFinding[] = []
  for (const [key, bucket] of buckets.entries()) {
    const uniqueTerminals = new Set(bucket.entries.map((p) => p.terminalId)).size
    if (uniqueTerminals < minParticipants) continue
    const sorted = [...bucket.entries].sort((a, b) => a.ts - b.ts)
    findings.push({
      id: key,
      kind: bucket.kind,
      resource: bucket.resource,
      participants: sorted,
      firstTs: sorted[0].ts,
      lastTs: sorted[sorted.length - 1].ts,
      severity: severityFor(bucket.kind, uniqueTerminals),
      uniqueTerminals,
    })
  }

  findings.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 } as const
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity]
    if (b.uniqueTerminals !== a.uniqueTerminals) return b.uniqueTerminals - a.uniqueTerminals
    return b.lastTs - a.lastTs
  })

  return findings
}

export function describeFinding(f: RedundancyFinding): string {
  const who = `${f.uniqueTerminals} terminals`
  if (f.kind === 'file_edit') return `${who} edited ${f.resource}`
  if (f.kind === 'file_read') return `${who} read ${f.resource}`
  if (f.kind === 'command') return `${who} ran \`${f.resource}\``
  return `${who} used the same tool on ${f.resource}`
}
