// modelCatalog.ts
//
// What models the pickers offer, per provider, kept current WITHOUT an API key.
//
// Termpolis never calls a model API — it launches CLI agents and passes `--model`. So
// the thing that goes stale is the LIST OF IDENTIFIERS the picker offers, and the only
// list that is ever right is the one the INSTALLED CLI will actually accept. Polling
// api.anthropic.com / api.openai.com would need a key Termpolis does not hold, and could
// offer a model the installed CLI rejects. Every agent already publishes its own list
// locally, so we read those instead:
//
//   claude — NOT discovered, deliberately. `fable|opus|sonnet|haiku` are ALIASES that
//            Claude Code itself resolves to the newest model in each family, so this
//            static list is always-latest BY CONSTRUCTION. Pinning `claude-opus-5-5`
//            here would make the picker staler, not fresher, and would eventually name
//            a model the installed Claude Code does not know.
//   codex  — ~/.codex/models_cache.json, which Codex's own models-manager fetches and
//            ETags for itself. Fields used: slug, display_name, visibility ('list' =
//            offer it, 'hide' = internal), priority (sort order).
//   gemini — `agy models`, a network-backed, account-scoped `id<TAB>Label` listing.
//
// Everything that PARSES those sources is pure, so it is unit-tested with no fs/spawn;
// all IO goes through one injected `CatalogIO` seam (same shape as secondOpinion's
// DeliverFn). Discovery never throws: a provider that can't be read keeps its previous
// entry, and a provider with nothing at all offers only the agent's own default.

export type ModelProvider = 'claude' | 'codex' | 'gemini'

export const MODEL_PROVIDERS: ModelProvider[] = ['claude', 'codex', 'gemini']

export interface CatalogModel {
  /** Exactly what gets passed as `--model <id>`. Shape-gated by isSafeModelId. */
  id: string
  label: string
  /** Optional picker annotation (e.g. 'most capable', '80% cheaper'). */
  note?: string
}

/** Where a provider's list came from — surfaced in the UI tooltip so a stale list is legible. */
export type CatalogSource = 'builtin' | 'cli' | 'cache'

export interface ProviderCatalog {
  provider: ModelProvider
  models: CatalogModel[]
  source: CatalogSource
  /** Epoch ms of the discovery that produced `models`. 0 for a pure builtin. */
  fetchedAt: number
}

export type ModelCatalog = Record<ModelProvider, ProviderCatalog>

/** Re-probe at most this often; a launch inside the window reuses the cached file. */
export const CATALOG_TTL_MS = 12 * 60 * 60_000
/** `agy models` hits the network — bounded so a hung probe can't wedge the refresh. */
export const AGY_PROBE_TIMEOUT_MS = 20_000

// Claude's picker rows. Order is most-capable → cheapest, matching the renderer's
// CLAUDE_MODEL_OPTIONS (which additionally computes "% cheaper" from the broker's cost
// tiers). Kept here too so the MAIN process can validate a `--model` without importing
// renderer code; tests/electron/modelCatalog.test.ts asserts the two never drift.
export const CLAUDE_BUILTIN_MODELS: CatalogModel[] = [
  { id: 'fable', label: 'Fable', note: 'most capable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
]

/** The alias set Claude Code's `--model` accepts. Mirrors agentCommandSanitizer.AGENT_MODEL_ALIASES.claude. */
export const CLAUDE_ALIASES: string[] = CLAUDE_BUILTIN_MODELS.map((m) => m.id)

/**
 * Strict shape gate for an id that will become a `--model <id>` argv token.
 *
 * The codex/gemini lists are DATA from a file and a CLI we do not control, so an id is
 * only eligible if it cannot be mistaken for a flag, a path, or anything a shell would
 * reinterpret: it must start alphanumeric and contain only [A-Za-z0-9._-]. That rules
 * out a leading '-', spaces, quotes, and every metacharacter, which is also why the
 * `agy models` header line ("Fetching available models...") drops out for free.
 */
export function isSafeModelId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)
}

/** First occurrence of each id wins — the sources are already in preference order. Pure. */
function dedupeById(models: CatalogModel[]): CatalogModel[] {
  const seen = new Set<string>()
  const out: CatalogModel[] = []
  for (const m of models) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out
}

/**
 * Parse `~/.codex/models_cache.json` (already JSON.parse'd) into picker rows. Pure.
 *
 * Only `visibility === 'list'` rows are offered — Codex marks its internal entries
 * ('gpt-reserve', 'codex-auto-review') as 'hide' and they are not user-selectable.
 * Sorted by Codex's own `priority`, so the picker matches the order Codex shows.
 */
export function parseCodexModelsCache(raw: unknown): CatalogModel[] {
  const models = (raw as { models?: unknown } | null)?.models
  if (!Array.isArray(models)) return []
  const rows = models
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .filter((m) => m.visibility === 'list' && isSafeModelId(m.slug))
    .map((m) => ({
      id: m.slug as string,
      label: typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim() : (m.slug as string),
      priority: typeof m.priority === 'number' ? m.priority : Number.MAX_SAFE_INTEGER,
    }))
  rows.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  return dedupeById(rows.map(({ id, label }) => ({ id, label })))
}

/**
 * Parse `agy models` stdout — one `id<TAB>Human Label` row per model. Pure.
 * Non-model chatter (the "Fetching available models..." banner, blank lines, any
 * stderr that got interleaved) fails isSafeModelId and is skipped.
 */
export function parseAgyModels(stdout: string): CatalogModel[] {
  const out: CatalogModel[] = []
  for (const line of (stdout || '').split(/\r?\n/)) {
    const [rawId, ...rest] = line.split('\t')
    const id = (rawId || '').trim()
    if (!isSafeModelId(id)) continue
    const label = rest.join(' ').trim()
    out.push({ id, label: label || id })
  }
  return dedupeById(out)
}

/** A provider entry offering only the agent's own default model. Pure. */
export function emptyProvider(provider: ModelProvider): ProviderCatalog {
  return { provider, models: [], source: 'builtin', fetchedAt: 0 }
}

/** The zero-discovery catalog: Claude's always-latest aliases, nothing else yet. Pure. */
export function builtinCatalog(): ModelCatalog {
  return {
    claude: { provider: 'claude', models: CLAUDE_BUILTIN_MODELS, source: 'builtin', fetchedAt: 0 },
    codex: emptyProvider('codex'),
    gemini: emptyProvider('gemini'),
  }
}

/** True when `catalog` is missing, malformed, or older than the TTL. Pure. */
export function catalogIsStale(catalog: ModelCatalog | null | undefined, now: number, ttlMs = CATALOG_TTL_MS): boolean {
  if (!catalog) return true
  // Claude never expires (it is a builtin), so freshness is the newest DISCOVERED entry.
  const discovered = MODEL_PROVIDERS.map((p) => catalog[p]?.fetchedAt ?? 0).filter((t) => t > 0)
  if (discovered.length === 0) return true
  return now - Math.max(...discovered) >= ttlMs
}

/**
 * Validate a catalog read back off disk. Returns null for anything that isn't a
 * well-formed catalog, so a hand-edited or truncated file degrades to a re-probe
 * rather than feeding unchecked strings into an argv. Pure.
 */
export function parseStoredCatalog(text: string | null | undefined): ModelCatalog | null {
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const out = builtinCatalog()
  let sawAny = false
  for (const provider of MODEL_PROVIDERS) {
    const entry = (raw as Record<string, unknown>)[provider]
    if (!entry || typeof entry !== 'object') continue
    const { models, fetchedAt } = entry as { models?: unknown; fetchedAt?: unknown }
    if (!Array.isArray(models)) continue
    const clean = dedupeById(
      models
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
        .filter((m) => isSafeModelId(m.id))
        .map((m) => ({
          id: m.id as string,
          label: typeof m.label === 'string' && m.label.trim() ? m.label.trim() : (m.id as string),
          ...(typeof m.note === 'string' && m.note.trim() ? { note: m.note.trim() } : {}),
        })),
    )
    // Claude's rows are a builtin — never let a stored file widen or replace them.
    if (provider === 'claude') continue
    if (clean.length === 0) continue
    out[provider] = {
      provider,
      models: clean,
      source: 'cache',
      fetchedAt: typeof fetchedAt === 'number' && fetchedAt > 0 ? fetchedAt : 0,
    }
    sawAny = true
  }
  return sawAny ? out : null
}

export interface CatalogIO {
  /** Read a UTF-8 file; resolve null when absent/unreadable. Never throws. */
  readFile: (path: string) => Promise<string | null>
  /** Run a binary off-thread; resolve its stdout, or null on any failure. Never throws. */
  run: (bin: string, args: string[], timeoutMs: number) => Promise<string | null>
  /** Absolute path of the user's ~/.codex/models_cache.json. */
  codexCachePath: string
  /** Which agent CLIs are on PATH — we only probe what is actually installed. */
  installed: Record<string, boolean>
  now: () => number
}

/** Keep the freshly-discovered rows, or fall back to what we already had. Pure. */
function pick(provider: ModelProvider, discovered: CatalogModel[], source: CatalogSource, now: number, previous?: ProviderCatalog): ProviderCatalog {
  if (discovered.length > 0) return { provider, models: discovered, source, fetchedAt: now }
  if (previous && previous.models.length > 0) return { ...previous, provider, source: 'cache' }
  return emptyProvider(provider)
}

/**
 * Re-read every installed agent's own model list. Resolves (never rejects) with a full
 * catalog: a provider whose source is missing, unreadable, or empty keeps its previous
 * entry, and a provider with no history at all offers only the agent's default.
 */
export async function refreshModelCatalog(io: CatalogIO, previous?: ModelCatalog | null): Promise<ModelCatalog> {
  const now = io.now()

  let codex: CatalogModel[] = []
  if (io.installed.codex) {
    const text = await io.readFile(io.codexCachePath)
    if (text) {
      try {
        codex = parseCodexModelsCache(JSON.parse(text))
      } catch {
        codex = [] // a half-written cache is not an error — just nothing to offer yet
      }
    }
  }

  let gemini: CatalogModel[] = []
  if (io.installed.agy) {
    const stdout = await io.run('agy', ['models'], AGY_PROBE_TIMEOUT_MS)
    if (stdout) gemini = parseAgyModels(stdout)
  }

  return {
    claude: { provider: 'claude', models: CLAUDE_BUILTIN_MODELS, source: 'builtin', fetchedAt: 0 },
    codex: pick('codex', codex, 'cli', now, previous?.codex),
    gemini: pick('gemini', gemini, 'cli', now, previous?.gemini),
  }
}

/**
 * Is `id` an allowed `--model` value for `provider`? Claude matches its exact alias
 * enum; codex/gemini ids are discovered at runtime, so they are gated on the catalog
 * we actually fetched PLUS the shape rule — an id nobody published never reaches an argv.
 */
export function isAllowedModel(provider: ModelProvider, id: string | undefined | null, catalog: ModelCatalog | null | undefined): boolean {
  if (!id) return false
  if (provider === 'claude') return CLAUDE_ALIASES.includes(id)
  if (!isSafeModelId(id)) return false
  return !!catalog?.[provider]?.models.some((m) => m.id === id)
}
