// Default model per AI agent — Settings → General → Default Models.
//
// Chosen once, applied every time Termpolis starts a NEW terminal for that agent: the sidebar
// click and launch shortcuts, the Welcome screen, the command palette and a restored workspace.
// "No default" (the empty choice) adds nothing to the command, so the agent's own setting
// decides — which is exactly what every launch did before this existed.
//
// What it never touches:
//   - a terminal that is already running (the Model picker in its header switches that one live);
//   - a command that already names a model, or resumes an earlier conversation: a session you
//     are picking back up keeps the model it was on;
//   - swarm agents, which are launched with models the conductor picks for each subtask.
//
// Storage mirrors terminalDefaults.ts: localStorage, because this is a launch-time preference
// of the app and not session state. The value ends up on a shell command line, so it is shape-
// checked on the way in AND again on the way out, and a model the agent's own list no longer
// offers is dropped at launch rather than typed into a CLI that would refuse it.

import { claudeModelArg } from './modelBroker'
import { commandPicksModelOrSession, providerForCommand, type ModelCatalog, type ModelProvider } from './modelCatalog'

// The one rule for which agent a command starts lives with the other launch-command rules.
export { providerForCommand }

export type AgentModelDefaults = Partial<Record<ModelProvider, string>>

/** The providers that can have a default, in the order Settings lists them. */
export const DEFAULT_MODEL_PROVIDERS: readonly ModelProvider[] = ['claude', 'codex', 'gemini']

const STORAGE_KEY = 'termpolis.agent.modelDefaults'

/**
 * Shape gate for an id that will become a `--model <id>` argv token. Mirrors main's
 * isSafeModelId (src/main/modelCatalog.ts), which the renderer cannot import — tsconfig.web.json
 * compiles only the renderer; tests/renderer/agentModelDefaults.test.ts keeps the two in step.
 * Starts alphanumeric and holds only [A-Za-z0-9._-], so it cannot be mistaken for a flag, a path,
 * or anything a shell would reinterpret.
 */
export function isSafeModelId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)
}

/** The saved defaults. Anything unreadable, unknown or unsafe is dropped, never trusted. */
export function getAgentModelDefaults(): AgentModelDefaults {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const saved = JSON.parse(raw) as Record<string, unknown> | null
    const out: AgentModelDefaults = {}
    for (const provider of DEFAULT_MODEL_PROVIDERS) {
      const id = saved?.[provider]
      if (isSafeModelId(id)) out[provider] = id
    }
    return out
  } catch {
    return {}
  }
}

/** Set (or, for an empty/unsafe id, clear) one agent's default; returns the saved defaults. */
export function setAgentModelDefault(provider: ModelProvider, id: string | null | undefined): AgentModelDefaults {
  const next = { ...getAgentModelDefaults() }
  if (isSafeModelId(id)) next[provider] = id
  else delete next[provider]
  try {
    if (Object.keys(next).length === 0) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* ignore — storage can be unavailable; the choice just does not stick */
  }
  return next
}

/**
 * Whether a saved default may be typed into a launch. Claude's four aliases are a fixed list;
 * for the others the agent's own list is the authority — but an empty list means nothing was
 * discovered (never run, offline), not that nothing is allowed, so a shape-checked id passes.
 */
export function isUsableDefault(provider: ModelProvider, id: string, catalog: ModelCatalog | null | undefined): boolean {
  if (provider === 'claude') return claudeModelArg(id) !== ''
  if (!isSafeModelId(id)) return false
  const rows = catalog?.[provider]?.models ?? []
  return rows.length === 0 || rows.some((m) => m.id === id)
}

export interface LaunchModel {
  /** ` --model <id>` to append to the launch command, or '' to add nothing. */
  arg: string
  /** A saved default that was NOT applied because the agent no longer offers it. */
  dropped?: string
}

/**
 * The default model for a launch command, as the text to append. '' when the command is not one
 * of the three agents, already names a model or resumes a conversation, or there is no default.
 */
export function defaultModelFor(command: string, catalog: ModelCatalog | null | undefined): LaunchModel {
  const provider = providerForCommand(command)
  if (!provider || commandPicksModelOrSession(provider, command)) return { arg: '' }
  const id = getAgentModelDefaults()[provider]
  if (!id) return { arg: '' }
  return isUsableDefault(provider, id, catalog) ? { arg: ` --model ${id}` } : { arg: '', dropped: id }
}

/** The catalog a launch needs to check a Codex or Antigravity default against — fetched only when
 *  one is saved, so a launch with no such default makes no IPC call at all. Never throws. */
export async function catalogForLaunch(): Promise<ModelCatalog | null> {
  const saved = getAgentModelDefaults()
  if (!saved.codex && !saved.gemini) return null
  try {
    const res = await window.termpolis?.getModelCatalog?.()
    return res?.success ? res.data : null
  } catch {
    return null
  }
}

/** Human line for the notice shown when a saved default had to be skipped at launch. */
export function droppedDefaultNotice(command: string, dropped: string): string {
  const provider = providerForCommand(command)
  const who = provider === 'codex' ? 'Codex' : provider === 'gemini' ? 'The Antigravity CLI' : 'Claude Code'
  return `⚠️ ${who} no longer offers your default model "${dropped}", so this terminal started on its own default. Pick another in Settings › General › Default Models.`
}
