import type { ContextPin } from '../types'

/**
 * Context re-injection — compose a structured prompt from pinned context
 * that users can send to a fresh agent session.
 *
 * Design:
 * - Output is pure text that can be pasted into any agent (Claude, Codex,
 *   Gemini, Aider, Qwen). No tool-specific syntax.
 * - Respects a max character budget so we never blow out the next session's
 *   context window on the first turn.
 * - Dedupe by id in case callers pass duplicates.
 * - Preserves human ordering when provided; otherwise sorts by createdAt.
 */

export interface InjectionOptions {
  /** Soft max characters for the built prompt (default 8000). */
  maxChars?: number
  /** Optional header (e.g., "Resuming work on auth module"). */
  header?: string
  /** Keep pins in the order given instead of sorting by createdAt. */
  preserveOrder?: boolean
  /** Include per-pin source/tags metadata (default true). */
  includeMetadata?: boolean
}

export interface InjectionResult {
  prompt: string
  includedPinIds: string[]
  omittedPinIds: string[]
  totalChars: number
}

const DEFAULT_MAX = 8000
const PIN_SEPARATOR = '\n\n---\n\n'

export function buildInjectionPrompt(
  pins: ContextPin[],
  opts: InjectionOptions = {},
): InjectionResult {
  if (!Array.isArray(pins)) {
    return { prompt: '', includedPinIds: [], omittedPinIds: [], totalChars: 0 }
  }
  const max = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : DEFAULT_MAX
  const includeMeta = opts.includeMetadata !== false

  // De-dupe by id; ignore invalid entries
  const seen = new Set<string>()
  const valid: ContextPin[] = []
  for (const p of pins) {
    if (!p || typeof p !== 'object') continue
    if (typeof p.id !== 'string' || typeof p.label !== 'string' || typeof p.body !== 'string') continue
    if (seen.has(p.id)) continue
    seen.add(p.id)
    valid.push(p)
  }

  if (!opts.preserveOrder) {
    valid.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  }

  const header = (opts.header || '').trim()
  const parts: string[] = []
  let used = 0
  if (header) {
    parts.push(header)
    used += header.length
  }

  const preface = 'Pinned context from previous session(s):'
  parts.push(preface)
  used += preface.length + PIN_SEPARATOR.length

  const included: string[] = []
  const omitted: string[] = []

  for (const pin of valid) {
    const rendered = renderPin(pin, includeMeta)
    const cost = rendered.length + PIN_SEPARATOR.length
    if (used + cost > max && included.length > 0) {
      omitted.push(pin.id)
      continue
    }
    if (used + cost > max && included.length === 0) {
      // Even the first pin is too big — truncate it so we still produce *something*
      const slack = Math.max(0, max - used - 20)
      const truncated = rendered.slice(0, slack) + '\n…[truncated]'
      parts.push(truncated)
      used += truncated.length + PIN_SEPARATOR.length
      included.push(pin.id)
      continue
    }
    parts.push(rendered)
    used += cost
    included.push(pin.id)
  }

  const prompt = parts.filter(Boolean).join(PIN_SEPARATOR).trim()
  return {
    prompt,
    includedPinIds: included,
    omittedPinIds: omitted,
    totalChars: prompt.length,
  }
}

function renderPin(pin: ContextPin, includeMetadata: boolean): string {
  const label = (pin.label || '').trim() || '(untitled)'
  const lines: string[] = [`### ${label}`]
  if (includeMetadata) {
    const meta: string[] = []
    if (pin.source) meta.push(`source: ${pin.source}`)
    if (pin.tags && pin.tags.length > 0) meta.push(`tags: ${pin.tags.join(', ')}`)
    if (meta.length) lines.push(`*${meta.join(' · ')}*`)
  }
  lines.push('')
  lines.push(pin.body)
  return lines.join('\n')
}

/**
 * Given a list of pins, estimate how many tokens the prompt will take.
 * Rough heuristic: 4 chars ≈ 1 token, so divide char count by 4.
 */
export function estimateTokens(result: InjectionResult): number {
  if (!result || !result.totalChars) return 0
  return Math.ceil(result.totalChars / 4)
}
