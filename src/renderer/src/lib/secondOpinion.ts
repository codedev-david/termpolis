// Pure helpers for the terminal "Second Opinion" dropdown. The menu lists only INSTALLED
// agents (from window.termpolis.detectAgents()); Claude appears as a group with its models
// nested underneath. Kept pure so the option-building + value-parsing are unit-tested with
// zero React.

export type SecondOpinionAgent = 'claude' | 'codex' | 'gemini' | 'qwen'

export interface SoOption { value: string; label: string }
export interface SoMenu {
  flat: SoOption[] // top-level installed agents (Codex / Gemini / Qwen)
  claude: SoOption[] | null // nested Claude models, or null when Claude isn't installed
  hasAny: boolean
}

/**
 * Build the Second Opinion menu from the install map (keyed by: claude / codex / agy /
 * qwen-code) and the Claude model list. Non-Claude agents are top-level options; Claude's
 * models nest under it. Values: `codex` | `gemini` | `qwen` | `claude:<alias>`. Note the
 * Gemini option is gated on `agy` (the Antigravity CLI) since its review invokes `agy`, and
 * qwen's binary is `qwen` though its profile id is `qwen-code`. Pure.
 */
export function buildSecondOpinionMenu(
  installed: Record<string, boolean> | null | undefined,
  claudeModels: Array<{ alias: string; label: string }>,
): SoMenu {
  const inst = installed || {}
  const flat: SoOption[] = []
  if (inst.codex) flat.push({ value: 'codex', label: 'OpenAI Codex' })
  if (inst.agy) flat.push({ value: 'gemini', label: 'Gemini' }) // Gemini via the Antigravity CLI (agy)
  if (inst['qwen-code']) flat.push({ value: 'qwen', label: 'Qwen' })
  const claude = inst.claude ? claudeModels.map((m) => ({ value: `claude:${m.alias}`, label: m.label })) : null
  return { flat, claude, hasAny: flat.length > 0 || !!(claude && claude.length > 0) }
}

/** Parse a menu value back into { agent, model? }. Returns null for the placeholder or an
 *  unrecognized value (so a stray value can never launch something unexpected). Pure. */
export function parseSecondOpinion(value: string): { agent: SecondOpinionAgent; model?: string } | null {
  if (!value) return null
  if (value.startsWith('claude:')) {
    const model = value.slice('claude:'.length)
    return model ? { agent: 'claude', model } : { agent: 'claude' }
  }
  if (value === 'codex' || value === 'gemini' || value === 'qwen') return { agent: value }
  return null
}
