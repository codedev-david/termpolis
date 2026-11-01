// Lending a note to another project. A project's notes are found by a search scoped to that project and by
// no other: the store filters on project, hard. Some of what Claude saves is about the person and how they
// like to work ("reference", "feedback", "user" notes), and is as true in the next project as in the one it
// was written in. When the user allows it (Settings > Memory & Learning, off by default, because the store may hold
// employer and personal projects side by side and a note that crosses over widens what goes into a prompt),
// a search scoped to a project is handed up to two such notes from other projects after its own results.
//
// Nothing here touches the store's search: it is one more ordinary search, by the notes' author, made by
// the caller of this module, and a filter over what it returns. A note about one project's own state
// (`type:project`) never travels, and each lent note keeps the `project` it came from, so the agent can
// see that it is borrowed.

import { NOTES_SOURCE, isClaudeNote, isPortableType, noteTypeOfTags } from './claudeNotesParse'

/** The most notes from other projects any one search is given. */
export const BORROW_MAX = 2
/** How many of the notes' best matches are looked at to find them. */
export const BORROW_FETCH = 6
/** A lent note has to match at least this well; a project's own results are not held to it. */
export const BORROW_MIN_SCORE = 0.5
/** What the store returns when a search names no limit. */
const SEARCH_DEFAULT_LIMIT = 10

/** What tells an imported note from any other stored row. Search hits, list rows and graph neighbours all carry it. */
export interface NoteRow {
  tags?: string[]
  source?: string
  agentId?: string
}

export interface LendableHit extends NoteRow {
  id: string
  score: number
  project?: string
}

/** The candidates that may be lent to a search scoped to `project`: notes of a portable type, from another
 *  project, that match well and are not already in the results; at most BORROW_MAX, and no more than `room`. */
export function pickBorrowed<T extends LendableHit>(
  candidates: readonly T[],
  o: { project: string; room: number; have: ReadonlySet<string> },
): T[] {
  const out: T[] = []
  const cap = Math.min(BORROW_MAX, o.room)
  for (const h of candidates) {
    if (out.length >= cap) break
    if (!isClaudeNote(h) || !isPortableType(noteTypeOfTags(h.tags))) continue
    if (!h.project || h.project === o.project || o.have.has(h.id) || !(h.score >= BORROW_MIN_SCORE)) continue
    out.push(h)
  }
  return out
}

/**
 * For a door that cannot tell which project is asking: the rows with every imported note taken out unless the user allows
 * notes to travel, and then only the general kinds. memory_anticipate searches all of memory for a task; a search or a listing
 * that names no project, and a walk of the graph (which starts from a memory and not from a project, and whose edges the store
 * draws between projects), are the same. Without it a note (importance 0.9, above the bar anticipate keeps) would be handed to
 * every project. Anything that is not a list comes back as it came: this sits on every agent-facing read and must never throw.
 */
export function withoutUnshareableNotes<T extends NoteRow>(rows: readonly T[], sharing: boolean): T[] {
  if (!Array.isArray(rows)) return rows as T[]
  return rows.filter((h) => !isClaudeNote(h) || (sharing && isPortableType(noteTypeOfTags(h.tags))))
}

export interface LendContext<T extends LendableHit> {
  /** The user allows general notes to help in other projects (Settings > Memory & Learning). */
  enabled: boolean
  /** The slug of the project the search is scoped to; empty for a search that names none (nothing is lent to those). */
  project: string
  query: string
  limit?: number
  /** An ordinary memory search, already corrected for retractions. */
  search: (opts: { query: string; limit: number; agentId: string }) => Promise<T[]>
}

/** `served` with the notes lent to it appended after its own results, never above the search's limit. */
export async function withBorrowedNotes<T extends LendableHit>(served: T[], ctx: LendContext<T>): Promise<T[]> {
  if (!ctx.enabled || !ctx.project || !ctx.query) return served
  // The limit comes from a model, as JSON. The store clamps it with Math.min(Math.max(limit ?? 10, 1), 100) and slices to it, so
  // a value it cannot read is NaN and gets nothing back, and a fraction is cut down: read it the same way, or a limit of
  // "abc" would count as no limit at all and a note would be lent to a search that was answered with nothing.
  const asked = Number(ctx.limit ?? SEARCH_DEFAULT_LIMIT)
  if (Number.isNaN(asked)) return served
  const limit = Math.min(Math.max(Math.floor(asked), 1), 100)
  const room = limit - served.length
  if (room <= 0) return served
  let found: T[]
  try {
    found = await ctx.search({ query: ctx.query, limit: BORROW_FETCH, agentId: NOTES_SOURCE })
  } catch {
    return served // lending is an extra: a search that fails never costs the project its own results
  }
  const picked = pickBorrowed(found, { project: ctx.project, room, have: new Set(served.map((h) => h.id)) })
  return picked.length > 0 ? [...served, ...picked] : served
}
