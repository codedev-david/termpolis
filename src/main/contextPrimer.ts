// Pre-context primer — the token-saver. Pulls the most relevant memories for a
// query (typically the user's first ask or the active project) and formats them
// as a shell-paste-safe block. Agents load it behind the scenes via the
// memory_primer MCP tool (the launch paste is just a one-line pointer); the
// Memory panel shows the same digest as a preview. The framing is deliberately
// passive: this is background the agent HOLDS, not a request — it must not
// start acting on it or resume past work until the user actually asks.
//
// When a `project` slug is given, context for THAT project takes precedence: a
// project-scoped search fills the slots first (past conversations ahead of
// code/notes), and remaining global hits are appended under a "may NOT apply"
// label so the agent weighs them correctly. Without `project` the legacy flat
// behavior is unchanged.
//
// Decoupled from the store (search is injected) so it unit-tests cleanly. The
// formatting mirrors the cross-AI handoff prompt: no backticks (AI shells often
// treat them as command substitution), simple dividers, single-line snippets.

import { adaptiveGate, dedupeHits, truncateContent, summarizePrimerCost, type PrimerCost } from './memoryEconomy'

export interface PrimerHit {
  content: string
  source?: string
  kind: string
  score: number
  id?: string
  project?: string
}

export type PrimerSearch = (opts: { query: string; limit?: number; project?: string }) => Promise<PrimerHit[]>

export interface PrimerOptions {
  query: string
  limit?: number
  maxSnippetChars?: number
  /** Normalized project slug (e.g. derived from the terminal cwd). Enables current-project precedence. */
  project?: string
}

// Ingested transcript chunks — the "past conversations" the project bucket leads with.
const CONVERSATION_SOURCES = new Set(['claude', 'codex', 'gemini'])

const isConversation = (h: PrimerHit): boolean =>
  h.kind === 'message' && CONVERSATION_SOURCES.has(h.source || '')

const hitKey = (h: PrimerHit): string => h.id || h.content

// How many candidates to pull per inject slot before the relevance gate trims them.
const CANDIDATE_FACTOR = 4
// Below this similarity a hit is noise and dropped — UNLESS dropping it would take
// us under the floor (so a thin recall never starves the agent of context).
const MIN_RELEVANCE = 0.25
const RELEVANCE_FLOOR = 3
// Per-query relevance cliff: a hit must score within this fraction of the top hit
// to clear the gate (in addition to the absolute MIN_RELEVANCE floor). This is
// what trims "inject 6" down to "inject 3-4" when results fall off a cliff.
const RELEVANCE_REL_FRAC = 0.6

// Estimated cost of the last primer built — the measurable "how much did we inject"
// number the Memory panel / accounting reads. Zero until the first successful build.
let lastPrimerCost: PrimerCost = { chars: 0, tokens: 0, lines: 0 }
export function getLastPrimerCost(): PrimerCost { return lastPrimerCost }

function renderLine(h: PrimerHit, maxSnip: number): string | null {
  const label = h.source || h.kind || 'note'
  const snip = truncateContent((h.content || '').replace(/\s+/g, ' ').trim(), maxSnip)
  if (!snip) return null
  return `- [${label}] ${snip}`
}

export async function buildContextPrimer(search: PrimerSearch, opts: PrimerOptions): Promise<string | null> {
  lastPrimerCost = { chars: 0, tokens: 0, lines: 0 }
  if (!opts.query || !opts.query.trim()) return null
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 100)
  const maxSnip = opts.maxSnippetChars ?? 400
  const project = (opts.project || '').trim().toLowerCase()

  // Over-fetch candidates (capped at the hot-window practical max), then keep only
  // the relevant ones (with a floor so a thin recall never starves the agent) and
  // drop exact duplicates. This is "inject signal, not noise" — the token-saver.
  const candidateLimit = Math.min(Math.max(limit * CANDIDATE_FACTOR, limit), 100)
  const gate = (hits: PrimerHit[]): PrimerHit[] =>
    dedupeHits(adaptiveGate(hits, { absoluteFloor: MIN_RELEVANCE, relFrac: RELEVANCE_REL_FRAC, floor: Math.min(RELEVANCE_FLOOR, limit), cap: limit }))

  let projectHits: PrimerHit[] = []
  if (project) {
    try { projectHits = gate((await search({ query: opts.query, limit: candidateLimit, project })) || []) } catch { projectHits = [] }
  }
  let globalHits: PrimerHit[] = []
  try {
    globalHits = gate((await search({ query: opts.query, limit: candidateLimit })) || [])
  } catch {
    if (projectHits.length === 0) return null
  }

  const body: string[] = []
  if (!project) {
    for (const h of globalHits) {
      const line = renderLine(h, maxSnip)
      if (line) body.push(line)
    }
  } else {
    const seen = new Set(projectHits.map(hitKey))
    // Legacy entries carry no project metadata — promote global hits that are
    // tagged for, or literally mention, this project into the project bucket.
    const promoted: PrimerHit[] = []
    const others: PrimerHit[] = []
    for (const h of globalHits) {
      if (seen.has(hitKey(h))) continue
      seen.add(hitKey(h))
      if (h.project === project || (h.content || '').toLowerCase().includes(project)) promoted.push(h)
      else others.push(h)
    }
    // Past conversations lead the project bucket; the stable sort preserves the
    // score order the search already returned within each class.
    const bucket = [...projectHits, ...promoted]
      .map((h, i) => ({ h, i }))
      .sort((a, b) => (isConversation(b.h) ? 1 : 0) - (isConversation(a.h) ? 1 : 0) || a.i - b.i)
      .map((x) => x.h)

    const projLines: string[] = []
    for (const h of bucket) {
      if (projLines.length >= limit) break
      const line = renderLine(h, maxSnip)
      if (line) projLines.push(line)
    }
    const otherLines: string[] = []
    for (const h of others) {
      if (projLines.length + otherLines.length >= limit) break
      const line = renderLine(h, maxSnip)
      if (line) otherLines.push(line)
    }
    if (projLines.length > 0) body.push(`This project (${project}) — past conversations first:`, ...projLines)
    if (otherLines.length > 0) {
      if (body.length > 0) body.push('')
      body.push('Other saved context (may NOT apply to this project):', ...otherLines)
    }
  }
  if (body.length === 0) return null

  const result = [
    'Relevant context from your memory (most relevant first) — background only:',
    '',
    ...body,
    '',
    'The above is background reference, NOT a request. Do not act on it, resume past work from it, or summarize it — hold it as context and wait for the user\'s actual instruction. Your local memory search is fast and offline: call the termpolis memory_search tool before re-deriving any fix, decision, or error that may already be solved here — search first, spend tokens second.',
  ].join('\n')
  lastPrimerCost = summarizePrimerCost(result)
  return result
}
