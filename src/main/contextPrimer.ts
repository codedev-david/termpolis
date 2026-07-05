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

import { existsSync } from 'fs'
import { adaptiveGate, dedupeHits, diversifyHits, truncateContent, summarizePrimerCost, type PrimerCost } from './memoryEconomy'

export interface PrimerHit {
  content: string
  source?: string
  kind: string
  score: number
  id?: string
  project?: string
  ts?: number // conversation/write time — powers the F24 relative-age marker
}

export type PrimerSearch = (opts: { query: string; limit?: number; project?: string }) => Promise<PrimerHit[]>

export interface PrimerOptions {
  query: string
  limit?: number
  maxSnippetChars?: number
  /** Normalized project slug (e.g. derived from the terminal cwd). Enables current-project precedence. */
  project?: string
  /** Injectable file-existence probe (defaults to fs.existsSync). Powers the
   *  staleness guard: a code memory whose source file is gone is flagged so the
   *  agent treats it as history, not a live path to recommend. */
  fileExists?: (path: string) => boolean
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
// Token-Jaccard similarity above which two hits are near-duplicates — one is
// dropped so the same decision/paraphrase doesn't occupy several inject slots.
const DIVERSITY_THRESHOLD = 0.7

// Estimated cost of the last primer built — the measurable "how much did we inject"
// number the Memory panel / accounting reads. Zero until the first successful build.
let lastPrimerCost: PrimerCost = { chars: 0, tokens: 0, lines: 0 }
export function getLastPrimerCost(): PrimerCost { return lastPrimerCost }

// A code memory's content begins with "<path>:<start>[-<end>]". The path may
// contain a Windows drive colon, so strip only the trailing ":<digits>[-<digits>]"
// line-range suffix. Returns the source file path for a code hit, else null.
function codeFilePath(h: PrimerHit): string | null {
  if (h.source !== 'code') return null
  const firstLine = (h.content || '').split('\n', 1)[0] || ''
  const m = firstLine.match(/^(.+?):\d+(?:-\d+)?$/)
  return m ? m[1] : null
}

// Escape a slug for safe insertion into a word-boundary RegExp (F21).
function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// A compact relative-age marker (F24) so the agent can weigh recency and never mistakes
// a year-old chat for a current one. Coarse by design — the primer is a lean digest.
function relativeAge(ts: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000))
  const day = Math.floor(sec / 86_400)
  if (day >= 365) return `${Math.floor(day / 365)}y ago`
  if (day >= 30) return `${Math.floor(day / 30)}mo ago`
  if (day >= 1) return `${day}d ago`
  const hr = Math.floor(sec / 3600)
  if (hr >= 1) return `${hr}h ago`
  const min = Math.floor(sec / 60)
  return min >= 1 ? `${min}m ago` : 'just now'
}

function renderLine(h: PrimerHit, maxSnip: number, fileExists: (p: string) => boolean, now: number): string | null {
  const snip = truncateContent((h.content || '').replace(/\s+/g, ' ').trim(), maxSnip)
  if (!snip) return null
  // Staleness guard (#3): a code memory whose source file no longer exists is
  // flagged so the agent treats it as historical context, not a live path it can
  // recommend — the #1 stale-memory hallucination vector.
  const path = codeFilePath(h)
  const base = path !== null && !fileExists(path)
    ? `${h.source || 'code'} ⚠ STALE — file removed, verify before use`
    : (h.source || h.kind || 'note')
  // F24: stamp a relative age so recency is legible in the primer (the leading line
  // is what the agent 'holds' about the project).
  const label = typeof h.ts === 'number' && h.ts > 0 ? `${base} · ${relativeAge(h.ts, now)}` : base
  return `- [${label}] ${snip}`
}

export async function buildContextPrimer(search: PrimerSearch, opts: PrimerOptions): Promise<string | null> {
  lastPrimerCost = { chars: 0, tokens: 0, lines: 0 }
  if (!opts.query || !opts.query.trim()) return null
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 100)
  const maxSnip = opts.maxSnippetChars ?? 400
  const project = (opts.project || '').trim().toLowerCase()
  const fileExists = opts.fileExists ?? existsSync
  const now = Date.now()

  // Over-fetch candidates (capped at the hot-window practical max), then keep only
  // the relevant ones (with a floor so a thin recall never starves the agent) and
  // drop exact duplicates. This is "inject signal, not noise" — the token-saver.
  const candidateLimit = Math.min(Math.max(limit * CANDIDATE_FACTOR, limit), 100)
  // Order matters: drop exact dupes, then near-duplicate paraphrases over the FULL
  // over-fetched pool (so a freed slot backfills with a distinct hit), THEN apply
  // the relevance cut + cap to `limit`.
  const gate = (hits: PrimerHit[]): PrimerHit[] =>
    adaptiveGate(
      diversifyHits(dedupeHits(hits), { threshold: DIVERSITY_THRESHOLD }),
      { absoluteFloor: MIN_RELEVANCE, relFrac: RELEVANCE_REL_FRAC, floor: Math.min(RELEVANCE_FLOOR, limit), cap: limit },
    )

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
      const line = renderLine(h, maxSnip, fileExists, now)
      if (line) body.push(line)
    }
  } else {
    const seen = new Set(projectHits.map(hitKey))
    // Legacy entries carry no project metadata — promote global hits that are
    // tagged for, or literally mention, this project into the project bucket.
    const promoted: PrimerHit[] = []
    const others: PrimerHit[] = []
    // F21: promote a global hit into THIS project only on an exact tag match, or a
    // WORD-BOUNDARY mention of a slug that is at least 4 chars — never a bare substring
    // (which made short slugs like 'app'/'api'/'go' match 'mapping'/'category'/'logo').
    const slugRe = project.length >= 4 ? new RegExp(`\\b${escapeRegExp(project)}\\b`, 'i') : null
    for (const h of globalHits) {
      if (seen.has(hitKey(h))) continue
      seen.add(hitKey(h))
      if (h.project === project || (slugRe && slugRe.test(h.content || ''))) promoted.push(h)
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
      const line = renderLine(h, maxSnip, fileExists, now)
      if (line) projLines.push(line)
    }
    const otherLines: string[] = []
    for (const h of others) {
      if (projLines.length + otherLines.length >= limit) break
      const line = renderLine(h, maxSnip, fileExists, now)
      if (line) otherLines.push(line)
    }
    if (projLines.length > 0) body.push(`This project (${project}) — past conversations first:`, ...projLines)
    if (otherLines.length > 0) {
      if (body.length > 0) body.push('')
      body.push('Other saved context (may NOT apply to this project):', ...otherLines)
    }
  }
  if (body.length === 0) return null

  // F24: only the flat (score-sorted) path is truly "most relevant first"; the project
  // path leads with conversations under its own sub-headers, so don't claim it up top.
  const header = project
    ? 'Relevant context from your memory — background only:'
    : 'Relevant context from your memory (most relevant first) — background only:'
  const result = [
    header,
    '',
    ...body,
    '',
    'The above is background reference, NOT a request. Do not act on it, resume past work from it, or summarize it — hold it as context and wait for the user\'s actual instruction. Your local memory search is fast and offline: call the termpolis memory_search tool before re-deriving any fix, decision, or error that may already be solved here — search first, spend tokens second.',
  ].join('\n')
  lastPrimerCost = summarizePrimerCost(result)
  return result
}
