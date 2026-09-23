// Second Opinion menu shaping. Pure — the picker's contents are a function of which
// agent CLIs are installed and what models the launch-time catalog discovered for each,
// so they are unit-tested with no DOM and no IPC.
//
// Every installed provider gets its own optgroup: a "default model" row (run the agent
// however it is configured) followed by one row per discovered model. Claude's rows are
// its four always-latest aliases; Codex's and Gemini's come from modelCatalog, which is
// the only place their fast-moving versioned ids exist. A provider with no discovered
// models still gets its group — just the default row.

import { PROVIDER_INSTALL_KEY, PROVIDER_LABEL, modelOptionsFor, type ModelCatalog, type ModelProvider } from './modelCatalog'

export type SecondOpinionAgent = 'claude' | 'codex' | 'gemini'

export interface SoOption { value: string; label: string }
export interface SoGroup {
  provider: SecondOpinionAgent
  label: string
  options: SoOption[]
}
export interface SoMenu {
  /** One group per INSTALLED provider, in Claude → Codex → Gemini order. */
  groups: SoGroup[]
  hasAny: boolean
}

const MENU_ORDER: ModelProvider[] = ['claude', 'codex', 'gemini']

/**
 * Build the Second Opinion menu from the install map and the model catalog.
 *
 * `installed` is the `agents:detect` map; Gemini is gated on its `agy` key (the
 * Antigravity CLI), not `gemini`, because that is the binary a review actually invokes.
 * A null/undefined map yields an empty menu — menus stay conservative while detection
 * is still in flight rather than offering an agent that may not exist.
 */
export function buildSecondOpinionMenu(
  installed: Record<string, boolean> | null | undefined,
  catalog: ModelCatalog | null | undefined,
): SoMenu {
  const inst = installed || {}
  const groups: SoGroup[] = []
  for (const provider of MENU_ORDER) {
    if (!inst[PROVIDER_INSTALL_KEY[provider]]) continue
    const label = PROVIDER_LABEL[provider]
    const options: SoOption[] = [{ value: provider, label: `${label} · default` }]
    for (const m of modelOptionsFor(provider, catalog)) {
      options.push({ value: `${provider}:${m.alias}`, label: m.label })
    }
    groups.push({ provider, label, options })
  }
  return { groups, hasAny: groups.length > 0 }
}

/**
 * Decode a picked menu value back into an agent + optional model. Accepts the bare
 * provider (run its default) or `<provider>:<model>`. The model is NOT validated here —
 * the main process gates it against the fetched catalog and a shape rule before it can
 * reach an argv. Returns null for anything unrecognized. Pure.
 */
export function parseSecondOpinion(value: string): { agent: SecondOpinionAgent; model?: string } | null {
  if (!value) return null
  const sep = value.indexOf(':')
  const agent = (sep === -1 ? value : value.slice(0, sep)) as SecondOpinionAgent
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'gemini') return null
  const model = sep === -1 ? '' : value.slice(sep + 1)
  return model ? { agent, model } : { agent }
}
