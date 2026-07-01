// mnemeIdentity.ts
//
// Mneme — continuous identity (Phase 5 of the learning architecture; see
// docs/learning-architecture.md §P5). The agent's model is a *rented cortex* that
// forgets everything between sessions; this small store gives it a persistent sense
// of self across them: a short list of long-horizon GOALS it is pursuing and the
// MILESTONES it has reached. `identitySummary` renders both into a compact block for
// the memory primer so a fresh session opens already knowing what it is working
// toward and what it has already accomplished.
//
// Persistence MIRRORS mnemeCompetence.ts: real fs, a JSONL sidecar written with the
// store's append-and-replay discipline (every set/record appends one line; reload
// replays them in order), and best-effort throughout — a persistence failure never
// breaks the caller. `now` is injected by the caller (never Date.now() here) so the
// stored timestamps stay deterministic under test.

import fs from 'node:fs'
import path from 'node:path'

type IdentityKind = 'goal' | 'milestone'

interface IdentityRecord {
  type: IdentityKind
  text: string
  ts: number
}

// Bounded, latest-wins: a persistent identity is a handful of standing intentions
// and a rolling tail of achievements, not an ever-growing ledger. The sidecar is
// still append-only (CRDT discipline); these caps only bound the REPLAYED in-memory
// view so it can't grow without limit no matter how long the file gets.
const MAX_GOALS = 10
const MAX_MILESTONES = 20
const DEFAULT_SUMMARY_LIMIT = 3

let goals: IdentityRecord[] = []
let milestones: IdentityRecord[] = []
let filePath: string | null = null

/** Newest-last push with a hard cap on retained history (drops the oldest). */
function pushCapped(list: IdentityRecord[], rec: IdentityRecord, cap: number): IdentityRecord[] {
  list.push(rec)
  return list.length > cap ? list.slice(-cap) : list
}

/** The `n` most-recent items, newest first (n ≤ 0 → none — guards slice(-0)). */
function mostRecent(list: IdentityRecord[], n: number): IdentityRecord[] {
  if (n <= 0) return []
  return list.slice(-n).reverse()
}

/** Best-effort append of one record to the sidecar (no-op when uninitialized). */
function append(rec: IdentityRecord): void {
  if (!filePath) return
  try {
    fs.appendFileSync(filePath, JSON.stringify(rec) + '\n')
  } catch {
    /* best effort — the in-memory state is still updated */
  }
}

/** Load the identity sidecar from `dir` (idempotent; safe to call on startup). */
export function initIdentity(dir: string): void {
  goals = []
  milestones = []
  filePath = path.join(dir, 'mneme-identity.jsonl')
  try {
    if (fs.existsSync(filePath)) {
      for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const r = JSON.parse(t) as IdentityRecord
          if (!r || typeof r.text !== 'string') continue // skip malformed
          if (r.type === 'goal') goals = pushCapped(goals, r, MAX_GOALS)
          else if (r.type === 'milestone') milestones = pushCapped(milestones, r, MAX_MILESTONES)
        } catch {
          /* skip a corrupt line */
        }
      }
    }
  } catch {
    /* best effort — start empty if the sidecar can't be read */
  }
}

/** Set a long-horizon goal (append + retain only the latest {@link MAX_GOALS}). */
export function setGoal(goal: string, now: number): void {
  const rec: IdentityRecord = { type: 'goal', text: goal, ts: now }
  goals = pushCapped(goals, rec, MAX_GOALS)
  append(rec)
}

/** Record an achievement the agent should remember it reached. */
export function recordMilestone(text: string, now: number): void {
  const rec: IdentityRecord = { type: 'milestone', text, ts: now }
  milestones = pushCapped(milestones, rec, MAX_MILESTONES)
  append(rec)
}

/**
 * Compact identity digest for the memory primer: up to `limit` (default 3) most-recent
 * active goals, then up to `limit` most-recent milestones, each newest first. Emits
 * only the sections that have content, and '' when there is neither goal nor milestone
 * (nothing to say about who we are yet).
 */
export function identitySummary(limit: number = DEFAULT_SUMMARY_LIMIT): string {
  const g = mostRecent(goals, limit)
  const m = mostRecent(milestones, limit)
  const lines: string[] = []
  if (g.length) lines.push('Active goals: ' + g.map((r) => r.text).join('; '))
  if (m.length) lines.push('Recent milestones: ' + m.map((r) => r.text).join('; '))
  return lines.join('\n')
}

// --- test seam ---
export function _resetIdentityForTests(): void {
  goals = []
  milestones = []
  filePath = null
}
