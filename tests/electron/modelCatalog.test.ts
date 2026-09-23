import { describe, it, expect, vi } from 'vitest'
import {
  AGY_PROBE_TIMEOUT_MS,
  CATALOG_TTL_MS,
  CLAUDE_ALIASES,
  CLAUDE_BUILTIN_MODELS,
  MODEL_PROVIDERS,
  builtinCatalog,
  catalogIsStale,
  emptyProvider,
  isAllowedModel,
  isSafeModelId,
  parseAgyModels,
  parseCodexModelsCache,
  parseStoredCatalog,
  refreshModelCatalog,
  type CatalogIO,
  type ModelCatalog,
} from '../../src/main/modelCatalog'
import { AGENT_MODEL_ALIASES } from '../../src/main/agentCommandSanitizer'
import { CLAUDE_MODEL_ALIASES } from '../../src/main/secondOpinion'
import { CLAUDE_MODEL_OPTIONS } from '../../src/renderer/src/lib/modelBroker'

// A trimmed copy of the real ~/.codex/models_cache.json shape, including the two
// entries Codex marks 'hide' (they must never reach the picker) and out-of-order
// priorities (the parser sorts by Codex's own order, not file order).
const CODEX_CACHE = JSON.stringify({
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 40 },
    { slug: 'gpt-reserve', display_name: 'Reserve', visibility: 'hide', priority: 1 },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 10 },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list', priority: 20 },
    { slug: 'codex-auto-review', display_name: 'Auto Review', visibility: 'hide', priority: 99 },
  ],
})

const AGY_STDOUT = [
  'Fetching available models...',
  '',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6',
].join('\n')

function io(over: Partial<CatalogIO> = {}): CatalogIO {
  return {
    readFile: vi.fn(async () => null),
    run: vi.fn(async () => null),
    codexCachePath: '/home/u/.codex/models_cache.json',
    installed: { claude: true, codex: true, agy: true },
    now: () => 1_000,
    ...over,
  }
}

describe('isSafeModelId', () => {
  it('accepts the real versioned ids the vendors publish', () => {
    for (const id of ['opus', 'gpt-5.6-sol', 'gemini-3.8-flash-high', 'gpt-oss-120b-medium', 'claude-opus-5-5']) {
      expect(isSafeModelId(id)).toBe(true)
    }
  })

  it('rejects anything that could be read as a flag, a path, or shell syntax', () => {
    for (const bad of ['-m', '--model', '/etc/passwd', 'a b', 'a;rm -rf /', 'a$(id)', 'a|b', "a'b", 'a`b`', '', '.hidden', '_x']) {
      expect(isSafeModelId(bad)).toBe(false)
    }
  })

  it('rejects non-strings and over-long ids', () => {
    expect(isSafeModelId(undefined)).toBe(false)
    expect(isSafeModelId(null)).toBe(false)
    expect(isSafeModelId(42)).toBe(false)
    expect(isSafeModelId('a'.repeat(64))).toBe(true) // 1 + 63 = the limit
    expect(isSafeModelId('a'.repeat(65))).toBe(false)
  })
})

describe('parseCodexModelsCache', () => {
  it('offers only visibility:list rows, in Codex\'s own priority order', () => {
    const rows = parseCodexModelsCache(JSON.parse(CODEX_CACHE))
    expect(rows.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5'])
    expect(rows.map((m) => m.label)).toEqual(['GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.5'])
  })

  it('falls back to the slug when display_name is missing or blank', () => {
    const rows = parseCodexModelsCache({ models: [{ slug: 'gpt-x', display_name: '   ', visibility: 'list' }] })
    expect(rows).toEqual([{ id: 'gpt-x', label: 'gpt-x' }])
  })

  it('drops a row whose slug fails the shape gate', () => {
    const rows = parseCodexModelsCache({ models: [{ slug: '--oops', visibility: 'list' }, { slug: 'ok-1', visibility: 'list' }] })
    expect(rows.map((m) => m.id)).toEqual(['ok-1'])
  })

  it('sorts ties by id and de-duplicates a repeated slug', () => {
    const rows = parseCodexModelsCache({
      models: [
        { slug: 'b', visibility: 'list' },
        { slug: 'a', visibility: 'list' },
        { slug: 'a', display_name: 'dupe', visibility: 'list' },
      ],
    })
    expect(rows.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('returns nothing for a malformed or empty cache', () => {
    expect(parseCodexModelsCache(null)).toEqual([])
    expect(parseCodexModelsCache({})).toEqual([])
    expect(parseCodexModelsCache({ models: 'nope' })).toEqual([])
    expect(parseCodexModelsCache({ models: [null, 7, 'x'] })).toEqual([])
  })
})

describe('parseAgyModels', () => {
  it('keeps the id/label rows and drops the banner and blank lines', () => {
    const rows = parseAgyModels(AGY_STDOUT)
    expect(rows.map((m) => m.id)).toEqual(['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'claude-sonnet-4-6'])
    expect(rows[0].label).toBe('Gemini 3.8 Flash (High)')
  })

  it('handles CRLF and a row with no label', () => {
    const rows = parseAgyModels('a-1\tAlpha\r\nb-2\r\n')
    expect(rows).toEqual([{ id: 'a-1', label: 'Alpha' }, { id: 'b-2', label: 'b-2' }])
  })

  it('de-duplicates and tolerates empty stdout', () => {
    expect(parseAgyModels('x\tOne\nx\tTwo').map((m) => m.label)).toEqual(['One'])
    expect(parseAgyModels('')).toEqual([])
  })
})

describe('builtinCatalog / emptyProvider', () => {
  it('ships Claude\'s aliases and nothing else', () => {
    const c = builtinCatalog()
    expect(c.claude.models).toEqual(CLAUDE_BUILTIN_MODELS)
    expect(c.claude.source).toBe('builtin')
    expect(c.codex).toEqual(emptyProvider('codex'))
    expect(c.gemini.models).toEqual([])
  })
})

describe('catalogIsStale', () => {
  const fresh = (): ModelCatalog => ({ ...builtinCatalog(), codex: { provider: 'codex', models: [{ id: 'a', label: 'A' }], source: 'cli', fetchedAt: 1_000 } })

  it('treats a missing catalog as stale', () => {
    expect(catalogIsStale(null, 0)).toBe(true)
    expect(catalogIsStale(undefined, 0)).toBe(true)
  })

  it('treats a never-discovered (pure builtin) catalog as stale', () => {
    expect(catalogIsStale(builtinCatalog(), 0)).toBe(true)
  })

  it('measures from the newest DISCOVERED entry, ignoring Claude\'s fetchedAt 0', () => {
    expect(catalogIsStale(fresh(), 1_000 + CATALOG_TTL_MS - 1)).toBe(false)
    expect(catalogIsStale(fresh(), 1_000 + CATALOG_TTL_MS)).toBe(true)
  })
})

describe('parseStoredCatalog', () => {
  it('restores discovered codex/gemini rows', () => {
    const stored = JSON.stringify({
      codex: { models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }], fetchedAt: 500 },
      gemini: { models: [{ id: 'g-1', label: 'G1', note: 'fast' }], fetchedAt: 600 },
    })
    const c = parseStoredCatalog(stored)!
    expect(c.codex.models).toEqual([{ id: 'gpt-5.5', label: 'GPT-5.5' }])
    expect(c.codex.source).toBe('cache')
    expect(c.codex.fetchedAt).toBe(500)
    expect(c.gemini.models[0].note).toBe('fast')
  })

  it('never lets a stored file widen or replace Claude\'s builtin rows', () => {
    const stored = JSON.stringify({
      claude: { models: [{ id: 'evil', label: 'Evil' }], fetchedAt: 9 },
      codex: { models: [{ id: 'ok', label: 'OK' }], fetchedAt: 9 },
    })
    expect(parseStoredCatalog(stored)!.claude.models).toEqual(CLAUDE_BUILTIN_MODELS)
  })

  it('drops rows that fail the shape gate and falls back to the id for a blank label', () => {
    const stored = JSON.stringify({ codex: { models: [{ id: '--flag' }, { id: 'ok', label: '  ' }], fetchedAt: 1 } })
    expect(parseStoredCatalog(stored)!.codex.models).toEqual([{ id: 'ok', label: 'ok' }])
  })

  it('returns null for anything that is not a usable catalog', () => {
    expect(parseStoredCatalog(null)).toBeNull()
    expect(parseStoredCatalog('')).toBeNull()
    expect(parseStoredCatalog('{oops')).toBeNull()
    expect(parseStoredCatalog('"a string"')).toBeNull()
    expect(parseStoredCatalog('{}')).toBeNull()
    expect(parseStoredCatalog(JSON.stringify({ codex: { models: [] } }))).toBeNull()
    expect(parseStoredCatalog(JSON.stringify({ codex: { models: 'x' } }))).toBeNull()
    expect(parseStoredCatalog(JSON.stringify({ codex: 7 }))).toBeNull()
    // Claude-only is not "any discovery" — it is what we already have.
    expect(parseStoredCatalog(JSON.stringify({ claude: { models: [{ id: 'opus' }], fetchedAt: 5 } }))).toBeNull()
  })

  it('defaults a missing/invalid fetchedAt to 0 so the entry reads as stale', () => {
    const c = parseStoredCatalog(JSON.stringify({ codex: { models: [{ id: 'ok', label: 'OK' }] } }))!
    expect(c.codex.fetchedAt).toBe(0)
  })
})

describe('refreshModelCatalog', () => {
  it('reads the codex cache and probes agy, bounding the probe', async () => {
    const deps = io({
      readFile: vi.fn(async () => CODEX_CACHE),
      run: vi.fn(async () => AGY_STDOUT),
    })
    const c = await refreshModelCatalog(deps)
    expect(deps.readFile).toHaveBeenCalledWith('/home/u/.codex/models_cache.json')
    expect(deps.run).toHaveBeenCalledWith('agy', ['models'], AGY_PROBE_TIMEOUT_MS)
    expect(c.codex.models.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5'])
    expect(c.codex.source).toBe('cli')
    expect(c.codex.fetchedAt).toBe(1_000)
    expect(c.gemini.models).toHaveLength(3)
    expect(c.claude.models).toEqual(CLAUDE_BUILTIN_MODELS)
  })

  it('does not touch a provider that is not installed', async () => {
    const deps = io({ installed: { claude: true, codex: false, agy: false } })
    const c = await refreshModelCatalog(deps)
    expect(deps.readFile).not.toHaveBeenCalled()
    expect(deps.run).not.toHaveBeenCalled()
    expect(c.codex.models).toEqual([])
    expect(c.gemini.models).toEqual([])
  })

  it('keeps the previous rows when a source goes missing, and marks them cached', async () => {
    const previous: ModelCatalog = {
      ...builtinCatalog(),
      codex: { provider: 'codex', models: [{ id: 'old-1', label: 'Old' }], source: 'cli', fetchedAt: 10 },
    }
    const c = await refreshModelCatalog(io(), previous)
    expect(c.codex.models).toEqual([{ id: 'old-1', label: 'Old' }])
    expect(c.codex.source).toBe('cache')
    expect(c.codex.fetchedAt).toBe(10)
  })

  it('survives a half-written cache file without throwing', async () => {
    const c = await refreshModelCatalog(io({ readFile: vi.fn(async () => '{"models":[') }))
    expect(c.codex.models).toEqual([])
  })

  it('degrades to the agent default when there is no history either', async () => {
    const c = await refreshModelCatalog(io({ run: vi.fn(async () => '') }))
    expect(c.gemini).toEqual(emptyProvider('gemini'))
  })
})

describe('isAllowedModel', () => {
  const cat: ModelCatalog = {
    ...builtinCatalog(),
    codex: { provider: 'codex', models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }], source: 'cli', fetchedAt: 1 },
  }

  it('matches Claude against its exact alias enum, not the catalog', () => {
    expect(isAllowedModel('claude', 'opus', cat)).toBe(true)
    expect(isAllowedModel('claude', 'claude-opus-5-5', cat)).toBe(false)
    expect(isAllowedModel('claude', 'opus', null)).toBe(true)
  })

  it('requires a discovered codex/gemini id — an unpublished one never reaches an argv', () => {
    expect(isAllowedModel('codex', 'gpt-5.5', cat)).toBe(true)
    expect(isAllowedModel('codex', 'gpt-9-imaginary', cat)).toBe(false)
    expect(isAllowedModel('gemini', 'gpt-5.5', cat)).toBe(false)
    expect(isAllowedModel('codex', 'gpt-5.5', null)).toBe(false)
  })

  it('rejects a flag-shaped id even if it somehow appears in the catalog', () => {
    const poisoned: ModelCatalog = { ...cat, codex: { ...cat.codex, models: [{ id: '--dangerously', label: 'x' } as never] } }
    expect(isAllowedModel('codex', '--dangerously', poisoned)).toBe(false)
  })

  it('rejects an empty or missing id', () => {
    expect(isAllowedModel('claude', '', cat)).toBe(false)
    expect(isAllowedModel('codex', undefined, cat)).toBe(false)
    expect(isAllowedModel('codex', null, cat)).toBe(false)
  })
})

// Four places name Claude's aliases: the sanitizer's allowlist (the swarm-conductor
// security boundary), second-opinion's argv gate, this catalog's builtin rows, and the
// renderer's picker options. They are deliberately separate constants — main cannot
// import renderer code and the sanitizer must stay self-contained — so nothing but this
// test stops them drifting apart, which would silently offer a model one path rejects.
describe('Claude alias lists stay in sync across every copy', () => {
  it('sanitizer, second-opinion, catalog and picker all agree', () => {
    expect([...AGENT_MODEL_ALIASES.claude]).toEqual(CLAUDE_ALIASES)
    expect([...CLAUDE_MODEL_ALIASES]).toEqual(CLAUDE_ALIASES)
    expect(CLAUDE_MODEL_OPTIONS.map((m) => m.alias)).toEqual(CLAUDE_ALIASES)
  })

  it('every alias passes the shape gate that guards an argv token', () => {
    for (const a of CLAUDE_ALIASES) expect(isSafeModelId(a)).toBe(true)
  })

  it('covers every provider in MODEL_PROVIDERS', () => {
    expect(MODEL_PROVIDERS).toEqual(['claude', 'codex', 'gemini'])
    const c = builtinCatalog()
    for (const p of MODEL_PROVIDERS) expect(c[p].provider).toBe(p)
  })
})
