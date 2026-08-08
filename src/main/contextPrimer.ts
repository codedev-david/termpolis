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

// Default number of memories injected into a primer when the caller passes no
// explicit limit. User-tunable via the Memory panel (persisted in
// memorySettings.ts, which re-exports this as its own default); this literal is
// the fallback the pure builder uses in isolation (e.g. unit tests).
export const DEFAULT_PRIMER_LIMIT = 10

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

/**
 * Newest-first listing, NOT semantic search. Powers the freshness lane below: the one
 * thing pure relevance ranking can never guarantee is "and here is what we did last".
 */
export type PrimerRecent = (opts: { limit: number; project?: string; since?: number }) => Promise<PrimerHit[]>

export interface PrimerOptions {
  query: string
  limit?: number
  maxSnippetChars?: number
  /** Normalized project slug (e.g. derived from the terminal cwd). Enables current-project precedence. */
  project?: string
  /** F19: the FULL terminal cwd, used to SCOPE the search precisely (projectKey) so two repos
   *  with the same basename don't collide. `project` (slug) is still used for display/promotion. */
  projectPath?: string
  /** Injectable file-existence probe (defaults to fs.existsSync). Powers the
   *  staleness guard: a code memory whose source file is gone is flagged so the
   *  agent treats it as history, not a live path to recommend. */
  fileExists?: (path: string) => boolean
  /** Newest-first listing used for the freshness lane. Omit to disable the lane
   *  entirely (the digest then behaves exactly as it did before). */
  recent?: PrimerRecent
  /** Injectable clock, for deterministic tests. Defaults to Date.now(). */
  now?: number
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
// what trims the full inject set (e.g. 10 → 3-4) when results fall off a cliff.
const RELEVANCE_REL_FRAC = 0.6
// Token-Jaccard similarity above which two hits are near-duplicates — one is
// dropped so the same decision/paraphrase doesn't occupy several inject slots.
const DIVERSITY_THRESHOLD = 0.7

// ---- Freshness lane (the "why isn't today's work in here?" fix) ----
//
// The digest used to be ranked on fused relevance alone. Recency is only a nudge in that
// fusion — alpha 0.25 over a 30-day half-life — so an hour-old memory outranks a 22-day-old
// one by under 9%, which any wording difference against the generic primer query swamps.
// Measured on a live brain: a primer for this repo returned hits aged 12d–1mo and NOTHING
// from the same day, while the store held that day's work the whole time.
//
// Relevance ranking structurally cannot fix this — "most similar" and "most recent" are
// different questions. So a few slots are RESERVED and filled newest-first, independent of
// score, and labeled as such.

/** Fraction of the digest's slots reserved for newest-first hits. */
export const RECENT_SLOT_FRAC = 0.3
/** Never spend more than this many slots on the freshness lane, however big the digest. */
export const RECENT_MAX_SLOTS = 3
/** How far back the lane will reach. Older than this isn't "what we were just doing". */
export const RECENT_WINDOW_MS = 7 * 86_400_000
/** Skip trivially short chunks ("assistant: Now tests 8 and 9:") — they'd waste a slot. */
export const MIN_RECENT_CHARS = 120
/** Over-fetch factor: most recent chunks are too short to be worth a slot. */
const RECENT_CANDIDATE_FACTOR = 8

/** How many slots the freshness lane gets for a digest of `limit` memories. */
export function recentSlotCount(limit: number): number {
  if (limit <= 1) return 0 // a one-line digest belongs to relevance
  return Math.max(1, Math.min(RECENT_MAX_SLOTS, Math.round(limit * RECENT_SLOT_FRAC), limit - 1))
}

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

/**
 * Fill the reserved freshness slots newest-first, skipping anything already chosen by
 * relevance and anything too short to be worth a slot. Never throws: a brain that can't
 * list is a digest without a freshness lane, not a failed primer.
 */
async function collectRecent(
  recent: PrimerRecent | undefined,
  o: { slots: number; project?: string; now: number; exclude: Set<string> },
): Promise<PrimerHit[]> {
  if (!recent || o.slots <= 0) return []
  let hits: PrimerHit[]
  try {
    hits = (await recent({
      limit: Math.max(o.slots * RECENT_CANDIDATE_FACTOR, o.slots),
      project: o.project,
      since: o.now - RECENT_WINDOW_MS,
    })) || []
  } catch { return [] }
  // A lister that answers with something other than a list must not take the primer
  // down with it — the lane is an enhancement, never a dependency.
  if (!Array.isArray(hits)) return []

  const cutoff = o.now - RECENT_WINDOW_MS
  const out: PrimerHit[] = []
  for (const h of hits) {
    if (out.length >= o.slots) break
    // Enforce the window here too — an injected lister may ignore `since`.
    if (typeof h.ts === 'number' && h.ts > 0 && h.ts < cutoff) continue
    if ((h.content || '').replace(/\s+/g, ' ').trim().length < MIN_RECENT_CHARS) continue
    const key = hitKey(h)
    if (o.exclude.has(key)) continue
    o.exclude.add(key)
    out.push(h)
  }
  return out
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
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PRIMER_LIMIT, 1), 100)
  const maxSnip = opts.maxSnippetChars ?? 400
  const project = (opts.project || '').trim().toLowerCase()
  const fileExists = opts.fileExists ?? existsSync
  const now = opts.now ?? Date.now()

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

  // F19: scope the project-bucket search by the FULL cwd when available (precise projectKey),
  // falling back to the slug. Display/promotion still use the slug `project`.
  const searchScope = (opts.projectPath && opts.projectPath.trim()) ? opts.projectPath.trim() : project
  let projectHits: PrimerHit[] = []
  if (project) {
    try { projectHits = gate((await search({ query: opts.query, limit: candidateLimit, project: searchScope })) || []) } catch { projectHits = [] }
  }
  let globalHits: PrimerHit[] = []
  try {
    globalHits = gate((await search({ query: opts.query, limit: candidateLimit })) || [])
  } catch {
    if (projectHits.length === 0) return null
  }

  // Freshness lane: reserved slots filled newest-first, excluding whatever relevance
  // already picked. Scored ranking alone kept answering "most similar to the query" when
  // the question a session-start digest has to answer is "where did we leave off".
  const excludeFromRecent = new Set<string>([...projectHits, ...globalHits].map(hitKey))
  const recentHits = await collectRecent(opts.recent, {
    slots: recentSlotCount(limit),
    project: searchScope || undefined,
    now,
    exclude: excludeFromRecent,
  })
  const recentLines: string[] = []
  for (const h of recentHits) {
    const line = renderLine(h, maxSnip, fileExists, now)
    if (line) recentLines.push(line)
  }
  // The lane spends from the SAME budget — the digest gets fresher, not bigger.
  const relevanceBudget = Math.max(0, limit - recentLines.length)

  const body: string[] = []
  // Blank-line separator only between sections that actually have content.
  const section = (title: string, lines: string[]): void => {
    if (lines.length === 0) return
    if (body.length > 0) body.push('')
    body.push(title, ...lines)
  }
  // "here" only when the lane is actually scoped to a project — an unscoped lane spans
  // every repo and must not claim otherwise.
  section(
    project
      ? `Most recent activity here (${project}, newest first) — where things actually stand:`
      : 'Most recent activity (newest first) — where things actually stand:',
    recentLines,
  )
  if (!project) {
    const globalLines: string[] = []
    for (const h of globalHits) {
      if (globalLines.length >= relevanceBudget) break
      const line = renderLine(h, maxSnip, fileExists, now)
      if (line) globalLines.push(line)
    }
    // Without a freshness lane the flat digest is byte-identical to before: bare lines,
    // no sub-header. With one, the relevance block needs a label to stay legible.
    if (recentLines.length > 0) section('Other relevant context:', globalLines)
    else body.push(...globalLines)
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
      if (projLines.length >= relevanceBudget) break
      const line = renderLine(h, maxSnip, fileExists, now)
      if (line) projLines.push(line)
    }
    const otherLines: string[] = []
    for (const h of others) {
      if (projLines.length + otherLines.length >= relevanceBudget) break
      const line = renderLine(h, maxSnip, fileExists, now)
      if (line) otherLines.push(line)
    }
    section(`This project (${project}) — past conversations first:`, projLines)
    section('Other saved context (may NOT apply to this project):', otherLines)
  }
  if (body.length === 0) return null

  // F24: only the flat (score-sorted) path is truly "most relevant first"; the project
  // path leads with conversations under its own sub-headers, so don't claim it up top.
  const header = (project || recentLines.length > 0)
    ? 'Relevant context from your memory — background only:'
    : 'Relevant context from your memory (most relevant first) — background only:'
  const result = [
    header,
    '',
    ...body,
    '',
    'The above is background reference, NOT a request. Do not act on it, resume past work from it, or summarize it — hold it as context and wait for the user\'s actual instruction. Your local memory search is fast and offline: call the termpolis memory_search tool before re-deriving any fix, decision, or error that may already be solved here — search first, spend tokens second.',
    'For questions about code STRUCTURE — who calls a function, what a change would break (its blast radius), or where a symbol is defined — prefer the termpolis code_explore / code_callers / code_impact / code_search tools over grepping: they answer from a pre-indexed local code graph in one call.',
  ].join('\n')
  lastPrimerCost = summarizePrimerCost(result)
  return result
}
