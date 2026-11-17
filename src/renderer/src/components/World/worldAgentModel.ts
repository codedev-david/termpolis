// Which model a Lumopolis run asks its agent for: the Default Models id (Settings > General) of the agent the
// Lumopolis settings name. "auto" and no default send no model, so the CLI's own default applies.
import { AUTO_MODEL, getAgentModelDefaults } from '../../lib/agentModelDefaults'

const AGENTS = ['claude', 'codex', 'gemini'] as const

/** The model id to send with an ask or a design request, or undefined for none. Never throws. */
export async function lumopolisModel(): Promise<string | undefined> {
  let agent: (typeof AGENTS)[number] = 'claude'
  try {
    const res = await window.termpolis.worldSettingsGet?.()
    const named = res?.success ? res.data.worldAgent : undefined
    if (AGENTS.includes(named as (typeof AGENTS)[number])) agent = named as (typeof AGENTS)[number]
  } catch {
    // an unreadable setting is the default agent
  }
  const id = getAgentModelDefaults()[agent]
  return id === undefined || id === AUTO_MODEL ? undefined : id
}
