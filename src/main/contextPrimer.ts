// Pre-context primer — the token-saver. Pulls the most relevant memories for a
// query (typically the user's first ask or the active project) and formats them
// as a shell-paste-safe block. Agents load it behind the scenes via the
// memory_primer MCP tool (the launch paste is just a one-line pointer); the
// Memory panel shows the same digest as a preview. The framing is deliberately
// passive: this is background the agent HOLDS, not a request — it must not
// start acting on it or resume past work until the user actually asks.
//
// When a `project` slug is given, context for THAT project takes precedence: a
// project-scoped search fills the slots first (the project's saved notes, then
// lessons the substance gate vouches for, then past conversations, then code),
// and remaining global hits are appended under a "may NOT apply" label so the
// agent weighs them correctly. Without `project` the legacy flat behavior is
// unchanged. The order spends the same lines as before: where a digest holds no
// saved note and no such lesson, the order is the one 1.54 used. (The text can still
// differ from 1.54's: a chunk and the fuller chunk that begins with it collapse into
// one line, the freshness lane leaves out what is superseded, suppressed or corrected,
// and a correction applies to every digest.)
//
// Decoupled from the store (search is injected) so it unit-tests cleanly. The
// formatting mirrors the cross-AI handoff prompt: no backticks (AI shells often
// treat them as command substitution), simple dividers, single-line snippets.

import { existsSync } from 'fs'
import { adaptiveGate, dedupeHits, diversifyHits, dropPrefixDuplicates, isStrictPrefix, truncateContent, summarizePrimerCost, type PrimerCost } from './memoryEconomy'
import { KEEP_SCORE, isCandidate, lessonSubstance, withoutCandidates } from './lessonSubstance'
import { isClaudeNote } from './claudeNotesParse'
import { projectKeyOf } from './projectKey'

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
  /** The stored memory's tags, when the caller has them. A lesson the substance gate holds back carries
   *  `candidate` (lessonSubstance.ts) and is never shown. */
  tags?: string[]
  /** Who wrote it, when the caller has it. The `candidate` tag only hides what the lesson writer stored. */
  agentId?: string
  /** The stable key of the project's full path, when the caller has it. Two repos can share a folder name; a saved
   *  note (claudeNotesIngest.ts) is shown only to the one whose key it carries. */
  projectKey?: string
  /** The memory's cognitive type, when the caller has it. `semantic` and `procedural` are what the lesson writer stores. */
  memoryType?: string
  /** How much the writer thought it mattered (0 to 1), when the caller has it. Carried for what reads a hit after the
   *  builder; the builder itself does not use it, because a lesson stored before 1.55 carries 0.5-0.95 whatever it says
   *  and is judged on its text (isGatedLesson). */
  importance?: number
  /** Set by the correction overlay (memoryCorrectionStore) when someone has demoted, amended or retracted this memory. */
  correction?: { kind: string }
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

/** How many saved notes may lead the project block, and how many lessons the substance gate vouches for. Past these a
 *  note or a lesson ranks with the conversations, on the relevance the search gave it: a crowd of either cannot fill
 *  the block. */
export const LEADING_NOTES = 3
export const LEADING_LESSONS = 2

/** A lesson the substance gate vouches for: a distilled memory (the lesson writer's semantic or procedural type) whose
 *  text scores at the keep bar and that nobody has demoted.
 *
 *  The text is judged, not the importance the lesson was stored with. A lesson written before 1.55 carries an importance
 *  of 0.5-0.95 whatever it says (a hand-label of 54 found it separates nothing), and one that sits in the gate's middle
 *  band is stored and not yet re-checked, so only its words can say. A demotion is a person or a failed outcome saying
 *  the lesson is unreliable: it stays where relevance puts it. */
const isGatedLesson = (h: PrimerHit): boolean =>
  (h.memoryType === 'semantic' || h.memoryType === 'procedural') &&
  h.correction?.kind !== 'demote' &&
  lessonSubstance(h.content).score >= KEEP_SCORE

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
/** Project slugs that are not projects. `cwd` is the literal a smoke test left behind (13 rows, every one opening with the
 *  same one-line "reply with" prompt); `tmp` and `temp` are the scratch folders an automated run starts in. An unscoped lane
 *  lists the newest chunks of every project, and these are always among the newest. */
const AUTOMATION_SLUGS = new Set(['cwd', 'tmp', 'temp'])
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
  o: { slots: number; project?: string; ownProject: string; now: number; exclude: Set<string>; carried: PrimerHit[]; foreign: (h: PrimerHit) => boolean },
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
  const viable = hits.filter((h) => {
    if (typeof h?.content !== 'string') return false // not a passage: the lane looks at every row it is given, and never throws
    // Enforce the window here too — an injected lister may ignore `since`.
    if (typeof h.ts === 'number' && h.ts > 0 && h.ts < cutoff) return false
    if (isCandidate(h)) return false // a lesson the substance gate stores but holds back is never shown
    // A saved note belongs to the project it was written in. A lane that names no project lists the newest rows of every
    // project, a note edited this week among them: it is as foreign here as in a search (see foreignNote).
    if (o.foreign(h)) return false
    // A newest-first lane has no score to lower a correction with: what someone demoted or amended is not "where things
    // stand", and the same memory still reaches the digest through relevance, where the overlay already ranked it.
    if (h.correction) return false
    // An automated run's memory is the newest there is and says nothing about any project, unless the digest is about it.
    const slug = (h.project || '').toLowerCase()
    if (AUTOMATION_SLUGS.has(slug) && slug !== o.ownProject) return false
    return (h.content || '').replace(/\s+/g, ' ').trim().length >= MIN_RECENT_CHARS
  })
  const out: PrimerHit[] = []
  // The newest chunks are where a live session's partial chunk and the fuller one that begins with it pile up: the
  // lane counts them once, whichever the lister gave first, and not at all when relevance already carries the fuller one.
  for (const h of dropPrefixDuplicates(viable)) {
    if (out.length >= o.slots) break
    const key = hitKey(h)
    if (o.exclude.has(key)) continue
    if (o.carried.some((c) => isStrictPrefix(h.content, c.content))) continue
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
    : isClaudeNote(h) ? 'note' : isGatedLesson(h) ? 'lesson' : (h.source || h.kind || 'note') // a saved note says so (its age is its last edit), and so does a lesson
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
  // Claude Code's saved notes belong to the project they were written in. Another project's never enters a
  // primer, whatever the "share notes" switch says (that switch governs memory_search only): this digest is
  // injected without anyone asking. With no project there is none for a note to belong to.
  const projectKey = opts.projectPath && opts.projectPath.trim() ? projectKeyOf(opts.projectPath.trim()) : undefined
  const foreignNote = (h: PrimerHit): boolean =>
    isClaudeNote(h) && ((h.project || '').toLowerCase() !== project || (projectKey !== undefined && h.projectKey !== undefined && h.projectKey !== projectKey))
  const withoutForeignNotes = (hits: PrimerHit[]): PrimerHit[] => (hits.some(foreignNote) ? hits.filter((h) => !foreignNote(h)) : hits)
  const gate = (hits: PrimerHit[]): PrimerHit[] =>
    adaptiveGate(
      diversifyHits(dropPrefixDuplicates(dedupeHits(withoutForeignNotes(withoutCandidates(hits)))), { threshold: DIVERSITY_THRESHOLD }),
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

  // A line is rendered once however often it is asked for: the relevance block is worked out more than once below.
  const lines = new Map<PrimerHit, string | null>()
  const lineOf = (h: PrimerHit): string | null => {
    if (!lines.has(h)) lines.set(h, renderLine(h, maxSnip, fileExists, now))
    return lines.get(h) ?? null
  }

  // The relevance half of the digest: what it shows when the lane has taken `lane` and `room` lines are left. A part with
  // no title is the flat digest, byte for byte what it was before there was a lane.
  interface Part { title: string | null; lines: string[] }
  const relevance = (lane: PrimerHit[], room: number): { parts: Part[]; shown: PrimerHit[] } => {
    const shown: PrimerHit[] = []
    const parts: Part[] = []
    // The other direction: a relevance hit that is only the head of a chunk the lane shows is that chunk again, and
    // gives its slot to the next hit.
    const headOfLane = (h: PrimerHit): boolean => lane.some((r) => isStrictPrefix(h.content, r.content))
    const fromProject = lane.length > 0 ? projectHits.filter((h) => !headOfLane(h)) : projectHits
    const fromAnywhere = lane.length > 0 ? globalHits.filter((h) => !headOfLane(h)) : globalHits
    if (!project) {
      const globalLines: string[] = []
      for (const h of fromAnywhere) {
        if (globalLines.length >= room) break
        const line = lineOf(h)
        if (!line) continue
        globalLines.push(line)
        shown.push(h)
      }
      // Without a freshness lane the flat digest is byte-identical to before: bare lines,
      // no sub-header. With one, the relevance block needs a label to stay legible.
      parts.push({ title: lane.length > 0 ? 'Other relevant context:' : null, lines: globalLines })
      return { parts, shown }
    }
    const seen = new Set(fromProject.map(hitKey))
    // Legacy entries carry no project metadata — promote global hits that are
    // tagged for, or literally mention, this project into the project bucket.
    const promoted: PrimerHit[] = []
    const others: PrimerHit[] = []
    // F21: promote a global hit into THIS project only on an exact tag match, or a
    // WORD-BOUNDARY mention of a slug that is at least 4 chars — never a bare substring
    // (which made short slugs like 'app'/'api'/'go' match 'mapping'/'category'/'logo').
    const slugRe = project.length >= 4 ? new RegExp(`\\b${escapeRegExp(project)}\\b`, 'i') : null
    for (const h of fromAnywhere) {
      if (seen.has(hitKey(h))) continue
      seen.add(hitKey(h))
      if (h.project === project || (slugRe && slugRe.test(h.content || ''))) promoted.push(h)
      else others.push(h)
    }
    // The project bucket leads with what its author vouched for: saved notes (curated and verified), then lessons the
    // substance gate vouches for, then past conversations, then the rest (code and the like). The caps keep a crowd of
    // notes or lessons from filling the block; past them they rank with the conversations. The stable sort preserves the
    // score order the search already returned within each class, and the budget is the same one: this reorders, never adds.
    // The two searches rank the same corpus on different candidate sets, so a head can reach one list and the fuller chunk the
    // other: say it once here too, now that the lists are one.
    const pool = dropPrefixDuplicates([...fromProject, ...promoted], true)
    let leadingNotes = 0
    let leadingLessons = 0
    const tier = pool.map((h): number => {
      if (isClaudeNote(h)) return leadingNotes++ < LEADING_NOTES ? 0 : 2
      if (isGatedLesson(h)) return leadingLessons++ < LEADING_LESSONS ? 1 : 2
      return isConversation(h) ? 2 : 3
    })
    const bucket = pool
      .map((h, i) => ({ h, i }))
      .sort((a, b) => tier[a.i] - tier[b.i] || a.i - b.i)
      .map((x) => x.h)

    const projLines: string[] = []
    let notesShown = 0
    let lessonsShown = 0
    for (const h of bucket) {
      if (projLines.length >= room) break
      const line = lineOf(h)
      if (!line) continue
      projLines.push(line)
      shown.push(h)
      if (isClaudeNote(h)) notesShown++
      else if (isGatedLesson(h)) lessonsShown++
    }
    const otherLines: string[] = []
    for (const h of others) {
      if (projLines.length + otherLines.length >= room) break
      const line = lineOf(h)
      if (!line) continue
      otherLines.push(line)
      shown.push(h)
    }
    // The title says what leads the block, and only what is really there to lead it.
    const led = [notesShown > 0 ? 'saved notes' : '', lessonsShown > 0 ? 'lessons learned' : ''].filter(Boolean)
    parts.push({ title: `This project (${project}) — ${led.length > 0 ? `${led.join(', ')}, then past conversations` : 'past conversations first'}:`, lines: projLines })
    parts.push({ title: 'Other saved context (may NOT apply to this project):', lines: otherLines })
    return { parts, shown }
  }

  // Freshness lane: reserved slots filled newest-first, excluding whatever relevance
  // already picked. Scored ranking alone kept answering "most similar to the query" when
  // the question a session-start digest has to answer is "where did we leave off".
  const slots = recentSlotCount(limit)
  const excludeFromRecent = new Set<string>([...projectHits, ...globalHits].map(hitKey))
  // The lane spends from the SAME budget — the digest gets fresher, not bigger — so the relevance block has `limit` less the
  // lane's lines. A lane hit gives way to the fuller chunk that begins with it only if that chunk is certain to be shown,
  // which is what the block shows when the lane takes every slot it may: left out for a twin the budget then cuts, the
  // passage would be in the digest nowhere.
  const certain = opts.recent && slots > 0 ? relevance([], Math.max(0, limit - slots)).shown : []
  let recentHits = await collectRecent(opts.recent, {
    slots,
    project: searchScope || undefined,
    ownProject: project,
    now,
    exclude: excludeFromRecent,
    carried: certain,
    foreign: foreignNote,
  })
  const roomFor = (lane: PrimerHit[]): number => Math.max(0, limit - lane.length)
  let block = relevance(recentHits, roomFor(recentHits))
  // The lane may have had fewer entries than slots, and the block then had more room than "certain" allowed for: it can show
  // the fuller chunk of a head the lane kept. Say the passage once, and give the line back to relevance.
  for (;;) {
    const doubled = recentHits.filter((h) => block.shown.some((s) => isStrictPrefix(h.content, s.content)))
    if (doubled.length === 0) break
    recentHits = recentHits.filter((h) => !doubled.includes(h))
    block = relevance(recentHits, roomFor(recentHits))
  }
  const recentLines = recentHits.map(lineOf).filter((l): l is string => l !== null)

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
  for (const part of block.parts) {
    if (part.title === null) body.push(...part.lines)
    else section(part.title, part.lines)
  }
  if (body.length === 0) return null

  // F24: only the flat (score-sorted) path is truly "most relevant first"; the project
  // path leads with its notes, lessons and conversations under its own sub-headers, so
  // don't claim it up top.
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
    // Recall returns excerpts, and an agent that doesn't know the rest is reachable treats the cut
    // as the end of the record. Ingest links each excerpt to the next with a 'follows' edge.
    // Memory records what was said, on this computer only: it is not a picture of the machine now.
    'A memory_search hit from a past conversation is an excerpt: memory_graph with its id and relation "follows" reads on, "precedes" reads back. Memory holds what was said in past sessions on this computer, not what is true now: verify anything you rely on.',
  ].join('\n')
  lastPrimerCost = summarizePrimerCost(result)
  return result
}
