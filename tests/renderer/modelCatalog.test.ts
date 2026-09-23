import { describe, it, expect } from 'vitest'
import {
  EXIT_CONFIRMS,
  PROVIDER_BIN,
  PROVIDER_INSTALL_KEY,
  PROVIDER_LABEL,
  REFRESH_MODELS_VALUE,
  isOfferedModel,
  modelOptionsFor,
  providerForAgent,
  relaunchCommandFor,
  type CatalogModel,
  type ModelCatalog,
  type ModelProvider,
} from '../../src/renderer/src/lib/modelCatalog'
import { CLAUDE_MODEL_OPTIONS } from '../../src/renderer/src/lib/modelBroker'
import { isSafeModelId } from '../../src/main/modelCatalog'

function catalog(over: Partial<Record<ModelProvider, CatalogModel[]>> = {}): ModelCatalog {
  const one = (provider: ModelProvider): ModelCatalog[ModelProvider] => ({
    provider, models: over[provider] ?? [], source: 'cli', fetchedAt: 1,
  })
  return { claude: one('claude'), codex: one('codex'), gemini: one('gemini') }
}

const CAT = catalog({
  codex: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
  gemini: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', note: 'fastest' }],
})

describe('providerForAgent', () => {
  it('resolves BOTH detector vocabularies for Codex', () => {
    // agentDetector's launch-command path says 'OpenAI Codex'; its output-scrape path
    // says plain 'Codex'. Miss either and a Codex terminal silently loses its picker.
    expect(providerForAgent('OpenAI Codex')).toBe('codex')
    expect(providerForAgent('Codex')).toBe('codex')
  })

  it('resolves Claude and both Gemini names', () => {
    expect(providerForAgent('Claude Code')).toBe('claude')
    expect(providerForAgent('Gemini CLI')).toBe('gemini')
    expect(providerForAgent('Antigravity')).toBe('gemini')
  })

  it('is case-insensitive', () => {
    expect(providerForAgent('claude code')).toBe('claude')
    expect(providerForAgent('ANTIGRAVITY')).toBe('gemini')
  })

  it('returns null for an unknown, empty or absent name', () => {
    expect(providerForAgent('Aider')).toBeNull()
    expect(providerForAgent('')).toBeNull()
    expect(providerForAgent(null)).toBeNull()
    expect(providerForAgent(undefined)).toBeNull()
  })
})

describe('modelOptionsFor', () => {
  it('returns the broker\'s hand-authored rows for Claude, catalog or not', () => {
    expect(modelOptionsFor('claude', CAT)).toBe(CLAUDE_MODEL_OPTIONS)
    expect(modelOptionsFor('claude', null)).toBe(CLAUDE_MODEL_OPTIONS)
  })

  it('maps discovered rows for the other providers, carrying any note', () => {
    expect(modelOptionsFor('codex', CAT)).toEqual([{ alias: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', savingsPct: 0 }])
    expect(modelOptionsFor('gemini', CAT)[0].note).toBe('fastest')
  })

  it('is empty when nothing was discovered or no provider applies', () => {
    expect(modelOptionsFor('codex', catalog())).toEqual([])
    expect(modelOptionsFor('codex', null)).toEqual([])
    expect(modelOptionsFor(null, CAT)).toEqual([])
  })
})

describe('isOfferedModel', () => {
  it('accepts an offered id and rejects everything else', () => {
    expect(isOfferedModel('claude', 'opus', null)).toBe(true)
    expect(isOfferedModel('codex', 'gpt-5.6-sol', CAT)).toBe(true)
    expect(isOfferedModel('codex', 'gpt-9-imaginary', CAT)).toBe(false)
    expect(isOfferedModel('codex', 'opus', CAT)).toBe(false)
    expect(isOfferedModel(null, 'opus', CAT)).toBe(false)
    expect(isOfferedModel('codex', '', CAT)).toBe(false)
  })
})

describe('relaunchCommandFor', () => {
  it('uses each CLI\'s own resume flag', () => {
    expect(relaunchCommandFor('claude', 'opus', CAT)).toBe('claude --model opus --continue')
    expect(relaunchCommandFor('codex', 'gpt-5.6-sol', CAT)).toBe('codex --model gpt-5.6-sol resume --last')
    expect(relaunchCommandFor('gemini', 'gemini-3.8-flash-high', CAT)).toBe('agy --model gemini-3.8-flash-high --continue')
  })

  it('returns an empty command for anything not offered, so nothing reaches the PTY', () => {
    expect(relaunchCommandFor('codex', 'gpt-9-imaginary', CAT)).toBe('')
    expect(relaunchCommandFor('codex', 'gpt-5.6-sol', null)).toBe('')
    expect(relaunchCommandFor('claude', 'claude-opus-5-5', CAT)).toBe('')
    expect(relaunchCommandFor(null, 'opus', CAT)).toBe('')
  })
})

describe('provider tables', () => {
  it('name the binary, label and install key for every provider', () => {
    const providers: ModelProvider[] = ['claude', 'codex', 'gemini']
    for (const p of providers) {
      expect(PROVIDER_BIN[p]).toBeTruthy()
      expect(PROVIDER_LABEL[p]).toBeTruthy()
      expect(PROVIDER_INSTALL_KEY[p]).toBeTruthy()
    }
    // Gemini ships as the Antigravity CLI — both the binary and the detect-map key.
    expect(PROVIDER_BIN.gemini).toBe('agy')
    expect(PROVIDER_INSTALL_KEY.gemini).toBe('agy')
  })

  it('needs two Ctrl+D for Claude and one for the others', () => {
    expect(EXIT_CONFIRMS).toEqual({ claude: 2, codex: 1, gemini: 1 })
  })
})

describe('REFRESH_MODELS_VALUE', () => {
  it('can never be mistaken for a model id, at either gate', () => {
    // The picker's retry row rides in the same <select> as real ids, so the sentinel has
    // to be unrepresentable as one — belt (shape rule) and braces (catalog membership).
    expect(isSafeModelId(REFRESH_MODELS_VALUE)).toBe(false)
    expect(isOfferedModel('codex', REFRESH_MODELS_VALUE, CAT)).toBe(false)
    expect(relaunchCommandFor('codex', REFRESH_MODELS_VALUE, CAT)).toBe('')
  })
})
