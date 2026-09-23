// modelCatalog.ts (renderer)
//
// Renderer-side view of the per-provider model catalog that src/main/modelCatalog.ts
// discovers at launch. The shapes are mirrored rather than imported because
// tsconfig.web.json compiles only src/renderer/src/** — same arrangement as
// types/index.ts mirroring src/main/types.ts. The values arrive as plain JSON over the
// `models:catalog` IPC, already shape-validated in main.
//
// This module answers the two questions the terminal pane asks:
//   1. which provider is this terminal running?  (providerForAgent)
//   2. what models may I offer for it?           (modelOptionsFor)
//
// Claude keeps the broker's hand-authored rows because they carry the "% cheaper"
// economics the picker shows; codex/gemini rows come from the catalog, which is the
// only place their (fast-moving, versioned) ids exist.

import { CLAUDE_MODEL_OPTIONS, type ModelOption } from './modelBroker'

export type ModelProvider = 'claude' | 'codex' | 'gemini'

export interface CatalogModel {
  id: string
  label: string
  note?: string
}

export interface ProviderCatalog {
  provider: ModelProvider
  models: CatalogModel[]
  source: 'builtin' | 'cli' | 'cache'
  fetchedAt: number
}

export type ModelCatalog = Record<ModelProvider, ProviderCatalog>

/** The binary each provider's picker relaunches. Mirrors AGENT_COMMAND_ALLOWLIST's keys. */
export const PROVIDER_BIN: Record<ModelProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'agy',
}

export const PROVIDER_LABEL: Record<ModelProvider, string> = {
  claude: 'Claude',
  codex: 'OpenAI Codex',
  gemini: 'Gemini',
}

/** The `installedAgents` key that gates each provider (Gemini ships as the Antigravity CLI). */
export const PROVIDER_INSTALL_KEY: Record<ModelProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'agy',
}

/**
 * Map a detected agent identity to a provider. Accepts every display name the two
 * detectors produce — agentDetector's launch-command path says 'OpenAI Codex' while its
 * output-scrape path says plain 'Codex', and both must resolve here or a Codex terminal
 * silently loses its picker. Pure.
 */
export function providerForAgent(agentName: string | null | undefined): ModelProvider | null {
  const n = (agentName || '').toLowerCase()
  if (!n) return null
  if (n.includes('claude')) return 'claude'
  if (n.includes('codex')) return 'codex'
  if (n.includes('gemini') || n.includes('antigravity')) return 'gemini'
  return null
}

/**
 * The rows to render in the picker for one provider. Pure.
 *
 * Claude returns the broker's options unchanged: its aliases are always-latest by
 * construction (Claude Code resolves `opus` to the newest Opus itself), and they carry
 * the savings percentages the picker shows. Everyone else returns discovered rows —
 * an empty list means "this agent's own default only", which the caller renders as a
 * single disabled row rather than an empty dropdown.
 */
export function modelOptionsFor(provider: ModelProvider | null, catalog: ModelCatalog | null | undefined): ModelOption[] {
  if (!provider) return []
  if (provider === 'claude') return CLAUDE_MODEL_OPTIONS
  const models = catalog?.[provider]?.models ?? []
  return models.map((m) => ({
    alias: m.id,
    label: m.label,
    savingsPct: 0,
    ...(m.note ? { note: m.note } : {}),
  }))
}

/** Is `id` offered for `provider`? The renderer's mirror of main's isAllowedModel. Pure. */
export function isOfferedModel(provider: ModelProvider | null, id: string, catalog: ModelCatalog | null | undefined): boolean {
  if (!provider || !id) return false
  return modelOptionsFor(provider, catalog).some((o) => o.alias === id)
}

/**
 * The shell command that relaunches `provider` on `id`, resuming the conversation that
 * was just exited. Returns '' when the model isn't offered, so a bad id can never reach
 * a PTY. Pure.
 *
 *   claude — `--model` is documented session-only and `--continue` resumes the prior
 *            conversation in this directory.
 *   codex  — `resume --last` is Codex's own "continue the most recent session".
 *   gemini — `--continue` is the Antigravity CLI's equivalent.
 */
export function relaunchCommandFor(provider: ModelProvider | null, id: string, catalog: ModelCatalog | null | undefined): string {
  if (!provider || !isOfferedModel(provider, id, catalog)) return ''
  const bin = PROVIDER_BIN[provider]
  if (provider === 'codex') return `${bin} --model ${id} resume --last`
  return `${bin} --model ${id} --continue`
}

/**
 * How many Ctrl+D presses it takes to exit each agent's REPL.
 *
 * Claude Code needs TWO (the first shows an exit-confirmation hint, the second within
 * its documented 800ms window exits). Codex and the Antigravity CLI exit on the first.
 * Getting this too LOW is the safe direction: the relaunch command then lands in the
 * still-running agent's input box, where it is visible and clearable. Too HIGH and the
 * surplus Ctrl+D reaches the SHELL after the agent exits and closes the terminal.
 */
export const EXIT_CONFIRMS: Record<ModelProvider, number> = {
  claude: 2,
  codex: 1,
  gemini: 1,
}

/**
 * Sentinel value for the picker's "retry discovery" row, shown only when a provider's
 * list came back empty. Leading underscores fail isSafeModelId, so it can never collide
 * with a real model id and can never be mistaken for one on the way to an argv.
 */
export const REFRESH_MODELS_VALUE = '__refresh__'
