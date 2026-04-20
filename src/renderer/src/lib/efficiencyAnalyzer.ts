import type { AgentActivityEvent, AgentActivityType } from '../types'

export interface AgentEfficiencyStats {
  agentType: AgentActivityType
  totalEvents: number
  messages: number
  toolCalls: number
  toolResults: number
  errors: number
  tokensIn: number
  tokensOut: number
  uniqueFilesTouched: number
  toolMix: Record<string, number>
  errorRate: number
  toolCallsPerMessage: number
  firstTs: number | null
  lastTs: number | null
}

export interface EfficiencyReport {
  windowMs: number
  generatedAt: number
  perAgent: AgentEfficiencyStats[]
  totals: {
    events: number
    agents: number
    terminals: number
    errors: number
    tokensIn: number
    tokensOut: number
  }
  leaders: {
    lowestErrorRate: AgentActivityType | null
    fewestToolCallsPerMessage: AgentActivityType | null
    mostFilesTouched: AgentActivityType | null
  }
}

export interface EfficiencyOptions {
  windowMs?: number
  now?: number
  minEventsForLeader?: number
}

const DEFAULT_WINDOW_MS = 30 * 60 * 1000
const DEFAULT_MIN_EVENTS = 3

const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'patch_file',
])
const READ_TOOLS = new Set(['Read', 'read_file', 'view'])

function toolNameOf(ev: AgentActivityEvent): string | null {
  const raw = (ev.payload?.tool ?? ev.payload?.name) as unknown
  return typeof raw === 'string' ? raw : null
}

function extractFilePath(ev: AgentActivityEvent): string | null {
  const tool = toolNameOf(ev)
  if (!tool) return null
  if (!EDIT_TOOLS.has(tool) && !READ_TOOLS.has(tool)) return null
  const input = ev.payload?.input
  if (!input || typeof input !== 'object') return null
  const rec = input as Record<string, unknown>
  for (const k of ['file_path', 'path', 'filename', 'notebook_path']) {
    const v = rec[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

export function analyzeEfficiency(
  events: AgentActivityEvent[],
  opts: EfficiencyOptions = {},
): EfficiencyReport {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  const now = opts.now ?? Date.now()
  const cutoff = now - windowMs
  const minEventsForLeader = opts.minEventsForLeader ?? DEFAULT_MIN_EVENTS

  type Bucket = Omit<AgentEfficiencyStats, 'errorRate' | 'toolCallsPerMessage' | 'uniqueFilesTouched'> & {
    files: Set<string>
    latestTokenTs: number
  }
  const buckets = new Map<AgentActivityType, Bucket>()
  const terminals = new Set<string>()

  for (const ev of events) {
    if (!ev || ev.ts < cutoff) continue
    terminals.add(ev.terminalId)
    let bucket = buckets.get(ev.agentType)
    if (!bucket) {
      bucket = {
        agentType: ev.agentType,
        totalEvents: 0,
        messages: 0,
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
        tokensIn: 0,
        tokensOut: 0,
        toolMix: {},
        firstTs: null,
        lastTs: null,
        files: new Set<string>(),
        latestTokenTs: -1,
      }
      buckets.set(ev.agentType, bucket)
    }

    bucket.totalEvents += 1
    bucket.firstTs = bucket.firstTs === null ? ev.ts : Math.min(bucket.firstTs, ev.ts)
    bucket.lastTs = bucket.lastTs === null ? ev.ts : Math.max(bucket.lastTs, ev.ts)

    if (ev.kind === 'message') bucket.messages += 1

    if (ev.kind === 'tool_call') {
      bucket.toolCalls += 1
      const tn = toolNameOf(ev) ?? 'unknown'
      bucket.toolMix[tn] = (bucket.toolMix[tn] ?? 0) + 1
      const file = extractFilePath(ev)
      if (file) bucket.files.add(file)
    }
    if (ev.kind === 'tool_result') {
      bucket.toolResults += 1
      if (ev.payload?.isError === true || ev.payload?.is_error === true) bucket.errors += 1
    }
    if (ev.kind === 'error') bucket.errors += 1

    if (ev.kind === 'token_update' && ev.ts >= bucket.latestTokenTs) {
      bucket.latestTokenTs = ev.ts
      const tokensIn =
        (typeof ev.payload?.inputTokens === 'number' ? (ev.payload.inputTokens as number) : 0) +
        (typeof ev.payload?.cacheCreationTokens === 'number'
          ? (ev.payload.cacheCreationTokens as number)
          : 0) +
        (typeof ev.payload?.cacheReadTokens === 'number'
          ? (ev.payload.cacheReadTokens as number)
          : 0)
      const tokensOut =
        typeof ev.payload?.outputTokens === 'number' ? (ev.payload.outputTokens as number) : 0
      if (tokensIn > bucket.tokensIn) bucket.tokensIn = tokensIn
      if (tokensOut > bucket.tokensOut) bucket.tokensOut = tokensOut
    }
  }

  const perAgent: AgentEfficiencyStats[] = []
  for (const bucket of buckets.values()) {
    perAgent.push({
      agentType: bucket.agentType,
      totalEvents: bucket.totalEvents,
      messages: bucket.messages,
      toolCalls: bucket.toolCalls,
      toolResults: bucket.toolResults,
      errors: bucket.errors,
      tokensIn: bucket.tokensIn,
      tokensOut: bucket.tokensOut,
      uniqueFilesTouched: bucket.files.size,
      toolMix: { ...bucket.toolMix },
      errorRate: bucket.toolResults > 0 ? bucket.errors / bucket.toolResults : 0,
      toolCallsPerMessage: bucket.messages > 0 ? bucket.toolCalls / bucket.messages : bucket.toolCalls,
      firstTs: bucket.firstTs,
      lastTs: bucket.lastTs,
    })
  }

  perAgent.sort((a, b) => b.totalEvents - a.totalEvents)

  function leaderBy(
    score: (s: AgentEfficiencyStats) => number,
    preferLower = true,
  ): AgentActivityType | null {
    const eligible = perAgent.filter((s) => s.totalEvents >= minEventsForLeader)
    if (eligible.length === 0) return null
    let best: AgentEfficiencyStats = eligible[0]
    for (const s of eligible.slice(1)) {
      const sa = score(s)
      const sb = score(best)
      if (preferLower ? sa < sb : sa > sb) best = s
    }
    return best.agentType
  }

  let totalErrors = 0
  let totalTokensIn = 0
  let totalTokensOut = 0
  for (const s of perAgent) {
    totalErrors += s.errors
    totalTokensIn += s.tokensIn
    totalTokensOut += s.tokensOut
  }

  return {
    windowMs,
    generatedAt: now,
    perAgent,
    totals: {
      events: events.filter((e) => e.ts >= cutoff).length,
      agents: perAgent.length,
      terminals: terminals.size,
      errors: totalErrors,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
    },
    leaders: {
      lowestErrorRate: leaderBy((s) => s.errorRate, true),
      fewestToolCallsPerMessage: leaderBy((s) => s.toolCallsPerMessage, true),
      mostFilesTouched: leaderBy((s) => s.uniqueFilesTouched, false),
    },
  }
}

export function formatErrorRate(rate: number): string {
  if (!isFinite(rate) || rate < 0) return '0%'
  return `${Math.round(rate * 100)}%`
}

export function formatAvg(x: number): string {
  if (!isFinite(x)) return '0'
  if (x >= 10) return x.toFixed(0)
  return x.toFixed(1)
}
