import { describe, it, expect } from 'vitest'
import { buildSecondOpinionMenu, parseSecondOpinion } from '../../src/renderer/src/lib/secondOpinion'
import { CLAUDE_MODEL_OPTIONS } from '../../src/renderer/src/lib/modelBroker'
import type { CatalogModel, ModelCatalog, ModelProvider } from '../../src/renderer/src/lib/modelCatalog'

/** Minimal catalog fixture. Claude's rows are ignored by the menu (it always uses the
 *  broker's hand-authored options, which carry the savings %), so only codex/gemini
 *  rows need populating here. */
function catalog(over: Partial<Record<ModelProvider, CatalogModel[]>> = {}): ModelCatalog {
  const one = (provider: ModelProvider): ModelCatalog[ModelProvider] => ({
    provider, models: over[provider] ?? [], source: 'cli', fetchedAt: 0,
  })
  return { claude: one('claude'), codex: one('codex'), gemini: one('gemini') }
}

const CAT = catalog({
  codex: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }, { id: 'gpt-5.5', label: 'GPT-5.5' }],
  gemini: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }],
})

const CLAUDE_VALUES = CLAUDE_MODEL_OPTIONS.map((m) => `claude:${m.alias}`)

describe('buildSecondOpinionMenu', () => {
  it('gives every installed provider its own group, in Claude → Codex → Gemini order', () => {
    const menu = buildSecondOpinionMenu({ claude: true, codex: true, agy: true }, CAT)
    expect(menu.groups.map((g) => g.provider)).toEqual(['claude', 'codex', 'gemini'])
    expect(menu.hasAny).toBe(true)
  })

  it('starts each group with a bare-provider default row, then that vendor\'s models', () => {
    const menu = buildSecondOpinionMenu({ claude: true, codex: true, agy: true }, CAT)
    const byProvider = Object.fromEntries(menu.groups.map((g) => [g.provider, g.options.map((o) => o.value)]))
    expect(byProvider.claude).toEqual(['claude', ...CLAUDE_VALUES])
    expect(byProvider.codex).toEqual(['codex', 'codex:gpt-5.6-sol', 'codex:gpt-5.5'])
    expect(byProvider.gemini).toEqual(['gemini', 'gemini:gemini-3.8-flash-high'])
    expect(menu.groups[0].options[0].label).toBe('Claude · default')
    expect(menu.groups[1].options[0].label).toBe('OpenAI Codex · default')
  })

  it('still offers a provider with no discovered models — just its default row', () => {
    const menu = buildSecondOpinionMenu({ codex: true }, catalog())
    expect(menu.groups).toHaveLength(1)
    expect(menu.groups[0].options.map((o) => o.value)).toEqual(['codex'])
    expect(menu.hasAny).toBe(true)
  })

  it('falls back to Claude\'s builtin aliases when no catalog has arrived yet', () => {
    const menu = buildSecondOpinionMenu({ claude: true }, null)
    expect(menu.groups[0].options.map((o) => o.value)).toEqual(['claude', ...CLAUDE_VALUES])
  })

  it('shows Gemini only when agy (the Antigravity CLI) is installed — not the deprecated gemini binary', () => {
    expect(buildSecondOpinionMenu({ agy: true }, CAT).groups.map((g) => g.provider)).toContain('gemini')
    expect(buildSecondOpinionMenu({ gemini: true }, CAT).groups.map((g) => g.provider)).not.toContain('gemini')
  })

  it('omits a provider that is not installed', () => {
    const menu = buildSecondOpinionMenu({ claude: false, codex: true, agy: false }, CAT)
    expect(menu.groups.map((g) => g.provider)).toEqual(['codex'])
  })

  it('hasAny is false when nothing is installed', () => {
    const menu = buildSecondOpinionMenu({ claude: false, codex: false, gemini: false }, CAT)
    expect(menu.hasAny).toBe(false)
    expect(menu.groups).toEqual([])
  })

  it('tolerates a null install map', () => {
    expect(buildSecondOpinionMenu(null, CAT).hasAny).toBe(false)
    expect(buildSecondOpinionMenu(undefined, CAT).hasAny).toBe(false)
  })
})

describe('parseSecondOpinion', () => {
  it('parses a nested Claude model value', () => {
    expect(parseSecondOpinion('claude:fable')).toEqual({ agent: 'claude', model: 'fable' })
  })

  it('parses a versioned Codex/Gemini id, dots and dashes intact', () => {
    expect(parseSecondOpinion('codex:gpt-5.6-sol')).toEqual({ agent: 'codex', model: 'gpt-5.6-sol' })
    expect(parseSecondOpinion('gemini:gemini-3.8-flash-high')).toEqual({ agent: 'gemini', model: 'gemini-3.8-flash-high' })
  })

  it('splits on the FIRST colon so a colon inside an id survives', () => {
    expect(parseSecondOpinion('codex:a:b')).toEqual({ agent: 'codex', model: 'a:b' })
  })

  it('parses a top-level agent value', () => {
    expect(parseSecondOpinion('codex')).toEqual({ agent: 'codex' })
    expect(parseSecondOpinion('gemini')).toEqual({ agent: 'gemini' })
  })

  it('returns null for the placeholder or an unknown value', () => {
    expect(parseSecondOpinion('')).toBeNull()
    expect(parseSecondOpinion('bogus')).toBeNull()
    expect(parseSecondOpinion('bogus:opus')).toBeNull()
    expect(parseSecondOpinion('claude:')).toEqual({ agent: 'claude' })
  })
})
