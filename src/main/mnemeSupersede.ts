// mnemeSupersede.ts — decide when a newer memory replaces an older one.
//
// WHY: recall honours `supersedes` edges (a replaced memory never comes back from search), but on a
// real brain there were none: 611k edges, 0 supersedes. The only way one got drawn was an agent
// calling memory_link by hand, so a decision that was reversed a week later kept coming back as the
// top answer next to the decision that replaced it, both looking equally current.
//
// This planner draws them automatically, conservatively, and only between memories that state
// knowledge: an agent's own memory_write (decision / fact / note) and reflection's distilled lessons.
// Transcript chunks, code chunks, ingested notes, entity stubs and summaries are never touched:
// a transcript is a record of what was said at the time, and the notes ingester already replaces a
// note's chunks when the note is edited.
//
// A newer memory supersedes an older one in the same NAMED project (a memory with no project key never
// takes part: unscoped writes from every repo would otherwise land in one group) when one of these holds:
//   restated    — nearly the same text (cosine ≥ RESTATE_COS) about the same subject.
//   contradicts — the two texts differ ONLY by negation words ("use X" / "do not use X"), exactly one
//                 side is negated, and cosine ≥ CONTRADICT_COS. A changed verb or object ("runs after
//                 the gate" / "runs without the gate") is a different statement, not a contradiction.
//   explicit    — the newer one says it replaces something ("no longer", "instead of", "supersedes",
//                 "reverted", ...) and is close to the older one (cosine ≥ EXPLICIT_COS).
// Whatever the reason, two memories that carry different numbers (a version, ticket, PR, date) are two
// records ("ticket 68671 …" and "ticket 68672 …"), never one replacing the other.
// The newer side wins. It is undone by memory_correct on the newer memory (retract, amend or demote) or
// by writing the older memory again; either releases the pair for good (memoryGraph.releaseSupersedes).
//
// Pure: vectors and the clock are the caller's. The store wires it in swarmMemory.memorySupersedePass.

import { sameSubject } from './mnemeSociety'
import { CANDIDATE_TAG } from './lessonSubstance'

export interface SupersedeEntry {
  id: string
  ts: number
  kind: string
  content: string
  memoryType?: string
  source?: string
  projectKey?: string
  tags?: string[]
}

export type SupersedeReason = 'restated' | 'contradicts' | 'explicit'

export const RESTATE_COS = 0.95
export const CONTRADICT_COS = 0.8
export const EXPLICIT_COS = 0.85

const KNOWLEDGE_KINDS = new Set(['decision', 'fact', 'note'])
const EXPLICIT_RE = /\b(supersedes?|superseded|replaces?|replaced by|no longer|instead of|reverts?|reverted|now uses|switched (?:to|from)|was wrong|correction|deprecated in favou?r of)\b/i
// Words that only flip polarity. Two texts whose word sets differ by these alone say the same thing
// with opposite polarity. Auxiliaries are in so "use X" / "do not use X" qualifies.
const NEGATORS = new Set(['not', 'no', 'never', 'dont', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt', 'werent', 'cannot', 'cant', 'wont', 'shouldnt', 'mustnt'])
const POLARITY_FILLER = new Set(['do', 'does', 'did', 'always', 'is', 'are', 'was', 'were', 'should', 'must', 'will', 'can'])

/**
 * Whether a memory states knowledge the planner may supersede or be superseded by: a distilled lesson
 * (semantic / procedural, not a held-back candidate) or an agent's own memory_write, which carries no
 * source and no cognitive type. Everything ingested has a source; entity stubs and summaries have a type.
 */
export function isSupersedable(e: SupersedeEntry): boolean {
  if (!KNOWLEDGE_KINDS.has(e.kind)) return false
  if (e.tags?.includes(CANDIDATE_TAG)) return false
  if (e.memoryType === 'semantic' || e.memoryType === 'procedural') return true
  return e.memoryType === undefined && !e.source
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/n['’]t\b/g, 'nt').replace(/['’]/g, '').match(/[a-z0-9]+(?:[.\-/:][a-z0-9]+)*/g) ?? []
}

/** Every token that holds a digit: versions, tickets, PRs, dates, counts. A leading `v` on a version goes. */
function numbers(text: string): Set<string> {
  return new Set(words(text).filter((w) => /\d/.test(w)).map((w) => w.replace(/^v(?=\d)/, '')))
}

/** Both carry numbers and the numbers differ: two records, not one replacing the other. */
function differentNumbers(a: string, b: string): boolean {
  const na = numbers(a)
  const nb = numbers(b)
  if (na.size === 0 || nb.size === 0) return false
  if (na.size !== nb.size) return true
  for (const n of na) if (!nb.has(n)) return true
  return false
}

/** The two differ only by polarity words, and exactly one side carries a negator. */
function negationOnly(a: string, b: string): boolean {
  const wa = new Set(words(a))
  const wb = new Set(words(b))
  const diff: string[] = []
  for (const w of wa) if (!wb.has(w)) diff.push(w)
  for (const w of wb) if (!wa.has(w)) diff.push(w)
  if (diff.length === 0 || !diff.every((w) => NEGATORS.has(w) || POLARITY_FILLER.has(w))) return false
  const negA = [...wa].some((w) => NEGATORS.has(w))
  const negB = [...wb].some((w) => NEGATORS.has(w))
  return negA !== negB
}

/** Why `newer` replaces `older` (cosine `cos` between them), or null when it doesn't. */
export function supersedeReason(newer: SupersedeEntry, older: SupersedeEntry, cos: number): SupersedeReason | null {
  if (newer.id === older.id || newer.ts <= older.ts) return null
  if (!newer.projectKey || newer.projectKey !== older.projectKey) return null
  if (!isSupersedable(newer) || !isSupersedable(older)) return null
  if (differentNumbers(newer.content, older.content)) return null
  if (cos >= CONTRADICT_COS && negationOnly(newer.content, older.content)) return 'contradicts'
  if (cos >= EXPLICIT_COS && EXPLICIT_RE.test(newer.content)) return 'explicit'
  if (cos >= RESTATE_COS && sameSubject({ source: '', content: newer.content }, { source: '', content: older.content }, 0.5)) return 'restated'
  return null
}

export interface SupersedeEdge { from: string; to: string; reason: SupersedeReason }

/**
 * Plan the supersedes edges for `fresh` (the memories not yet checked) against `pool` (every eligible
 * memory, `fresh` included). `cosine` answers for any two ids in the pool, null when either has no
 * vector. `alreadySuperseded` skips an older memory that something newer already replaced; `released`
 * skips a pair whose supersession was undone. Memories without a project key are never compared.
 * At most `max` edges, newest `fresh` first.
 */
export function planSupersessions(
  fresh: SupersedeEntry[],
  pool: SupersedeEntry[],
  cosine: (a: string, b: string) => number | null,
  opts: { max?: number; alreadySuperseded?: (id: string) => boolean; released?: (newer: string, older: string) => boolean } = {},
): SupersedeEdge[] {
  const max = opts.max ?? 200
  const out: SupersedeEdge[] = []
  const byProject = new Map<string, SupersedeEntry[]>()
  for (const e of pool) {
    if (!isSupersedable(e) || !e.projectKey) continue
    const k = e.projectKey
    const list = byProject.get(k)
    if (list) list.push(e)
    else byProject.set(k, [e])
  }
  const newestFirst = fresh.filter(isSupersedable).sort((a, b) => b.ts - a.ts)
  for (const n of newestFirst) {
    for (const o of (n.projectKey && byProject.get(n.projectKey)) || []) {
      if (out.length >= max) return out
      if (o.ts >= n.ts || opts.alreadySuperseded?.(o.id) || opts.released?.(n.id, o.id)) continue
      const cos = cosine(n.id, o.id)
      if (cos === null) continue
      const reason = supersedeReason(n, o, cos)
      if (reason) out.push({ from: n.id, to: o.id, reason })
    }
  }
  return out
}
