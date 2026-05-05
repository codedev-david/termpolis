import type { AgentActivityEvent } from '../types'

/**
 * Context pressure — how full is the agent's context window right now?
 *
 * We lean on token_update events from transcript watchers when available
 * (accurate). When no token_update is present we fall back to a heuristic
 * based on message count + average length so we still show *something*
 * meaningful. The heuristic is clearly labeled so the UI can indicate it.
 *
 * Model windows are approximate — providers change these frequently; we
 * prefer conservative caps and let users override via options.
 */

export interface ContextWindow {
  /** Token capacity of the model's context window */
  total: number
  /** Used tokens (prompt + output + cache) */
  used: number
  /** Whether the value came from real token_update events vs. a heuristic */
  source: 'transcript' | 'heuristic'
  /** Model the calculation assumes — for display */
  model: string
}

export interface PressureOptions {
  /** Override model window when known from the UI */
  model?: string
  /** Override max tokens — useful for providers with expanded windows */
  maxTokens?: number
  /** Average tokens per message used by the heuristic (default ~250) */
  avgTokensPerMessage?: number
}

// Conservative defaults per model family. Real windows vary; prefer transcript data.
const MODEL_WINDOWS: Array<{ match: RegExp; tokens: number; label: string }> = [
  { match: /claude-4|claude-opus-4|claude-sonnet-4|claude-haiku-4/i, tokens: 200_000, label: 'Claude 4' },
  { match: /claude-3-5|claude-3\.5/i, tokens: 200_000, label: 'Claude 3.5' },
  { match: /claude/i, tokens: 200_000, label: 'Claude' },
  { match: /gpt-4o|gpt-4-turbo|o1|o3/i, tokens: 128_000, label: 'OpenAI 128K' },
  { match: /gpt-4-32k/i, tokens: 32_000, label: 'GPT-4 32K' },
  { match: /gpt-4/i, tokens: 8_192, label: 'GPT-4' },
  { match: /gemini-1\.5|gemini-2/i, tokens: 1_000_000, label: 'Gemini 1M' },
  { match: /gemini/i, tokens: 128_000, label: 'Gemini' },
  { match: /qwen.*coder|qwen2\.5-coder/i, tokens: 32_768, label: 'Qwen Coder' },
  { match: /qwen/i, tokens: 32_768, label: 'Qwen' },
]

const FALLBACK_WINDOW = 128_000

export function resolveWindowSize(model: string): { tokens: number; label: string } {
  if (!model) return { tokens: FALLBACK_WINDOW, label: 'unknown' }
  for (const entry of MODEL_WINDOWS) {
    if (entry.match.test(model)) return { tokens: entry.tokens, label: entry.label }
  }
  return { tokens: FALLBACK_WINDOW, label: model }
}

/**
 * Extract tokens used from the most-recent token_update event. Returns 0
 * if none present.
 *
 * When events carry a taskId (Claude Code sessionId), we isolate the
 * latest session's events. Transcript watchers tail jsonl files from
 * offset 0 and replay all historical events — without this filter,
 * opening a fresh Claude session in a heavily-used project would show
 * the previous session's peak token count instead of the current 0.
 *
 * Within scope, we use max(total) since Claude emits cumulative counts.
 * For events without taskId we fall back to max across all events to
 * preserve prior behavior for non-Claude watchers.
 */
export function extractTokensFromEvents(events: AgentActivityEvent[]): number {
  if (!events || events.length === 0) return 0

  let latestTaskId: string | undefined
  let latestTaskTs = -Infinity
  for (const e of events) {
    if (e.kind !== 'token_update' || !e.taskId) continue
    if (e.ts > latestTaskTs) {
      latestTaskTs = e.ts
      latestTaskId = e.taskId
    }
  }

  let max = 0
  for (const e of events) {
    if (e.kind !== 'token_update') continue
    if (latestTaskId && e.taskId && e.taskId !== latestTaskId) continue
    const p = (e.payload ?? {}) as Record<string, unknown>
    const inTok = Number(p.inputTokens ?? p.input ?? p.prompt_tokens ?? 0)
    const outTok = Number(p.outputTokens ?? p.output ?? p.completion_tokens ?? 0)
    const cache = Number(p.cacheReadInputTokens ?? p.cache_read_input_tokens ?? 0)
    const creation = Number(p.cacheCreationInputTokens ?? p.cache_creation_input_tokens ?? 0)
    const total = inTok + outTok + cache + creation
    if (total > max) max = total
  }
  return max
}

/**
 * Heuristic fallback — count message events + multiply by avg tokens.
 * Coarse, but lets us render *some* pressure even when transcript tokens
 * aren't available (early Gemini versions, etc).
 */
export function heuristicTokensFromEvents(
  events: AgentActivityEvent[],
  avg: number,
): number {
  if (!events || events.length === 0) return 0
  let messages = 0
  let totalLen = 0
  for (const e of events) {
    if (e.kind !== 'message') continue
    messages++
    const p = (e.payload ?? {}) as Record<string, unknown>
    const len = Number(p.length ?? 0)
    if (Number.isFinite(len) && len > 0) totalLen += len
  }
  if (messages === 0) return 0
  // Approximate tokens: 1 token ≈ 4 chars, fallback to avg when lengths missing
  const fromLen = Math.floor(totalLen / 4)
  const fromAvg = messages * avg
  return Math.max(fromLen, fromAvg)
}

export function computePressure(
  events: AgentActivityEvent[],
  opts: PressureOptions = {},
): ContextWindow {
  const model = (opts.model || '').trim() || 'unknown'
  const window = opts.maxTokens && opts.maxTokens > 0
    ? { tokens: opts.maxTokens, label: model || 'custom' }
    : resolveWindowSize(model)

  const fromTranscript = extractTokensFromEvents(events)
  if (fromTranscript > 0) {
    return {
      total: window.tokens,
      used: Math.min(fromTranscript, window.tokens),
      source: 'transcript',
      model: window.label,
    }
  }

  const avg = opts.avgTokensPerMessage && opts.avgTokensPerMessage > 0
    ? opts.avgTokensPerMessage
    : 250
  const heur = heuristicTokensFromEvents(events, avg)
  return {
    total: window.tokens,
    used: Math.min(heur, window.tokens),
    source: 'heuristic',
    model: window.label,
  }
}

export function pressureRatio(w: ContextWindow): number {
  if (!w || !w.total || w.total <= 0) return 0
  const r = w.used / w.total
  if (!Number.isFinite(r) || r < 0) return 0
  if (r > 1) return 1
  return r
}

export type PressureLevel = 'ok' | 'warn' | 'danger' | 'critical'

export function pressureLevel(w: ContextWindow): PressureLevel {
  const r = pressureRatio(w)
  if (r >= 0.95) return 'critical'
  if (r >= 0.8) return 'danger'
  if (r >= 0.6) return 'warn'
  return 'ok'
}

export function formatPressure(w: ContextWindow): string {
  const r = Math.round(pressureRatio(w) * 100)
  return `${r}% (${formatTokens(w.used)} / ${formatTokens(w.total)})`
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.floor(n))
}
