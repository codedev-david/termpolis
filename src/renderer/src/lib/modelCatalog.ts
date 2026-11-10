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
import { isResumeId, type ResumeTarget } from './agentResume'

import { LAUNCH_BIN, carriedLaunchArgs, codexProxyArg } from '../../../shared/launchCarry'
import type { LaunchProvider } from '../../../shared/launchCarry'

export type ModelProvider = LaunchProvider

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
export const PROVIDER_BIN: Record<ModelProvider, string> = LAUNCH_BIN

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

/**
 * The family a model id belongs to, whichever CLI lists it (v1.55.0). `agy models` lists the
 * account's Claude models next to Gemini's, so a menu that grouped by CLI put Claude under Gemini.
 */
export function modelFamily(id: string): 'claude' | 'gemini' | 'other' {
  const s = id.trim().toLowerCase()
  return s.startsWith('claude') ? 'claude' : s.startsWith('gemini') ? 'gemini' : 'other'
}

/** Is `id` offered for `provider`? The renderer's mirror of main's isAllowedModel. Pure. */
export function isOfferedModel(provider: ModelProvider | null, id: string, catalog: ModelCatalog | null | undefined): boolean {
  if (!provider || !id) return false
  return modelOptionsFor(provider, catalog).some((o) => o.alias === id)
}

// The reading of a launch command is shared with the account switch (src/shared/launchCarry.ts).
export { providerForCommand, launchFlag, commandPicksModelOrSession, carryLaunchArgs, carriedLaunchArgs } from '../../../shared/launchCarry'
export type { LaunchFlag, LaunchCarry } from '../../../shared/launchCarry'


/**
 * The shell command that relaunches `provider` on model `id`. Returns '' when the model isn't
 * offered, or a conversation id isn't a UUID, so nothing unvalidated can reach a PTY. Pure.
 *
 *   resume.kind 'id'     - exactly that conversation (`--resume <id>`, `resume <id>`, `--conversation=<id>`)
 *   resume.kind 'latest' - the agent's own "most recent" (`--continue`, `resume --last`); the default,
 *                          and what a relaunch does when it has nothing better
 *   resume.kind 'none'   - a new session
 *
 * `launchCommand`, when given, is what the terminal was started with: its flags other than the
 * model and the conversation are kept (see carriedLaunchArgs), placed before `--model` because
 * Codex wants its options ahead of the `resume` subcommand.
 */
export function relaunchCommandFor(
  provider: ModelProvider | null,
  id: string,
  catalog: ModelCatalog | null | undefined,
  launchCommand?: string | null,
  resume: ResumeTarget = { kind: 'latest' },
): string {
  if (!provider || !isOfferedModel(provider, id, catalog)) return ''
  if (resume.kind === 'id' && !isResumeId(resume.id)) return ''
  // A routed Codex keeps talking to the local proxy (same terminal, same account).
  const proxy = provider === 'codex' ? codexProxyArg(launchCommand) : null
  const head = [PROVIDER_BIN[provider], ...carriedLaunchArgs(provider, launchCommand), ...(proxy ? [proxy] : []), '--model', id].join(' ')
  switch (resume.kind) {
    case 'none':
      return head
    case 'latest':
      return provider === 'codex' ? `${head} resume --last` : `${head} --continue`
    case 'id':
      if (provider === 'codex') return `${head} resume ${resume.id}`
      return provider === 'gemini' ? `${head} --conversation=${resume.id}` : `${head} --resume ${resume.id}`
  }
}

/**
 * Sentinel value for the picker's "retry discovery" row, shown only when a provider's
 * list came back empty. Leading underscores fail isSafeModelId, so it can never collide
 * with a real model id and can never be mistaken for one on the way to an argv.
 */
export const REFRESH_MODELS_VALUE = '__refresh__'
