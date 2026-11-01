// lessonSubstance.ts
//
// Is a distilled lesson worth keeping? A deterministic gate that scores what the lesson SAYS, from its
// text alone.
//
// A 2026-10 hand-label of 54 lessons stored by a real brain found 17% usable on their own. Neither of the
// two numbers the store carried told the good from the bad: the distiller's importance (median 0.80 for
// lessons with format residue, 0.77 for clean ones) and tidy formatting (21% usable among the clean ones,
// 17% among the flagged). What did was substance: whether the text names something a later reader can
// search for (a file, a function, an error code), whether it says WHY or WHEN (a rule or a mechanism),
// and whether it is narration instead (an announcement, a progress report, a time-bound status). This
// scores those, and says nothing about whether the lesson is TRUE: that stays with outcome grounding and
// memory_correct. The weights are provisional, fitted by hand on one rater's labels; they are a floor
// under what agents are shown, not a judge of quality.
//
// Three outcomes (David, 2026-10-31):
//   keep       score >= 2         written; its importance follows the score
//   candidate  1 <= score < 2     written with importance 0.45 and the tag `candidate`; never shown to an agent
//   drop       score < 1          not written; counted as `skipped` in the reflect metric
//
// PURE: no electron, no fs, no clock, no module state. A lesson is cut to its first ANALYZE_MAX
// characters before any pattern runs, so no input, however long, can make a call slow.

export interface Substance {
  /** An integer: identifiers (0..3) + connective (0|2) minus the penalties below. */
  score: number
  /** What moved the score, in a fixed order, e.g. `identifiers +2`, `progress -3`. Empty when nothing did. */
  reasons: string[]
}

export type SubstanceBand = 'keep' | 'candidate' | 'drop'

/** At or above this a lesson is written as it is and shown to agents. */
export const KEEP_SCORE = 2
/** At or above this (and below KEEP_SCORE) a lesson is stored but held back. Below it, it is not stored. */
export const CANDIDATE_SCORE = 1
/** The tag a held-back lesson carries. Read paths that hand memories to agents drop anything carrying it. */
export const CANDIDATE_TAG = 'candidate'
/** The agent id groundEpisode writes every lesson under. Only a row written under it can be a held-back lesson. */
export const LESSON_AGENT_ID = 'mneme'
/** Below the 0.6 bar memory_anticipate keeps lessons at, so a held-back lesson can never qualify on it. */
export const CANDIDATE_IMPORTANCE = 0.45

const ANALYZE_MAX = 1200 // characters read; the distiller itself cuts a lesson at 600
const SHORT_BELOW = 60 // a lesson under this cannot hold a cause and a fix
const LONG_FROM = 580 // the distiller cuts at 600: a lesson this long is usually a truncated blob
const PROGRESS_CAP = 4
const IDENTIFIER_CAP = 3

export function substanceBand(score: number): SubstanceBand {
  return score >= KEEP_SCORE ? 'keep' : score >= CANDIDATE_SCORE ? 'candidate' : 'drop'
}

/** A keeper's importance, from its score: 0.6 at the bar (where memory_anticipate starts to take a lesson
 *  without the procedural type), then +0.1 a point to 0.9. Today's distiller importance is 0.5-0.95
 *  whatever the lesson says, so it cannot tell a recipe from a status line. */
export function importanceForScore(score: number): number {
  const raw = Number.isFinite(score) ? 0.4 + 0.1 * score : 0.6
  return Math.round(Math.min(0.9, Math.max(0.6, raw)) * 1000) / 1000
}

/** Whether a stored row is a held-back lesson. Takes any row shape: search hits, list rows, primer hits.
 *
 *  `candidate` is an ordinary word that any agent or person may put on a note of their own, and hiding that note
 *  from every recall would be a silent loss. So the tag alone is not enough when the row says who wrote it: it must
 *  have been written under the lesson writer's agent id. A row that does not say (a primer hit, a consolidation
 *  entry) is judged by its tag. */
export function isCandidate(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false
  const { tags, agentId } = row as { tags?: unknown; agentId?: unknown }
  if (!Array.isArray(tags) || !tags.includes(CANDIDATE_TAG)) return false
  return agentId === undefined || agentId === LESSON_AGENT_ID
}

/** `rows` without the held-back lessons: the same array when there are none, so a read path that has
 *  nothing to hide pays one scan and no allocation. Anything that is not a list comes back as it came:
 *  this sits on every agent-facing read path and must never be the thing that throws. */
export function withoutCandidates<T>(rows: T[]): T[] {
  if (!Array.isArray(rows)) return rows
  let held = false
  for (const r of rows) {
    if (isCandidate(r)) { held = true; break }
  }
  return held ? rows.filter((r) => !isCandidate(r)) : rows
}

// ---- identifiers a later reader can search for --------------------------------------------------------

const TICK_RE = /`[^`\n]{2,60}`/g
const FILE_RE = /\b[\w./\\-]+\.[A-Za-z]{2,5}\b/g // a name with an extension; "v1.54.4" and "e.g." do not match
const CAMEL_RE = /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g // groundEpisode
const PASCAL_RE = /\b(?:[A-Z][a-z0-9]+){2,}\b/g // TerminalManager: two humps, so ordinary capitalised words miss
const SNAKE_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g // memory_search
const SCREAM_RE = /\b[A-Z][A-Z0-9_]{2,}\b/g // ENOENT, NODE_OPTIONS
// Acronyms every text uses and words typed in capitals for emphasis: neither is something to search for.
const NOT_AN_IDENTIFIER = new Set([
  'API', 'JSON', 'HTTP', 'HTTPS', 'HTML', 'CSS', 'URL', 'URI', 'SQL', 'XML', 'YAML', 'CLI', 'GUI', 'REST', 'TCP',
  'UDP', 'DNS', 'SSL', 'TLS', 'CPU', 'GPU', 'RAM', 'PDF', 'CSV', 'UTF', 'ASCII', 'TODO', 'FIXME', 'NULL', 'TRUE',
  'FALSE', 'OK', 'GET', 'POST', 'PUT', 'DELETE', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'NPM', 'IDE', 'MCP', 'RAG',
  'NOT', 'NEVER', 'ALWAYS', 'MUST', 'ONLY', 'THE', 'AND', 'FOR', 'BUT', 'ALL', 'ANY', 'WARNING', 'NOTE', 'IMPORTANT',
])

const SHAPE_RES = [FILE_RE, CAMEL_RE, SNAKE_RE, PASCAL_RE]

/** Distinct identifiers, 1 point each to IDENTIFIER_CAP. Distinct by lower-case spelling, so `memoryWrite` and
 *  a bare memoryWrite are one. Each character belongs to at most one identifier: a backticked span is claimed
 *  first and blanked, then file names, then the code-case shapes, so `app.quit()` is one thing and a file
 *  whose name is also camelCase (swarmMemory.ts) is one thing, not two. */
function identifierPoints(head: string): number {
  const found = new Set<string>()
  let rest = head.replace(TICK_RE, (span) => {
    const v = span.slice(1, -1).trim()
    if (v.length >= 2) found.add(v.toLowerCase())
    return ' '
  })
  for (const re of SHAPE_RES) {
    if (found.size >= IDENTIFIER_CAP) return IDENTIFIER_CAP
    rest = rest.replace(re, (hit) => {
      found.add(hit.toLowerCase())
      return ' '
    })
  }
  const screaming = rest.match(SCREAM_RE)
  if (screaming) {
    for (const s of screaming) {
      if (!NOT_AN_IDENTIFIER.has(s)) found.add(s.toLowerCase())
    }
  }
  return Math.min(IDENTIFIER_CAP, found.size)
}

// ---- a rule or a mechanism ----------------------------------------------------------------------------

// Words that turn a statement into a reason or a rule. Deliberately NOT a bare "so" or "since": both are as
// common in narration ("so I can put them back", "since this morning") as in explanation.
const CONNECTIVE_RE = new RegExp(
  '\\b(?:because|so that|in order to|only (?:when|if|after|before|once)|never|always|must|instead of|rather than|' +
    'means|which is why|that(?:\'s| is) why|otherwise|unless|requires?|required|due to|caused by|as a result|' +
    'therefore|whenever|as long as|turns out|the reason|don[\'’]?t|do not|avoid)\\b',
  'i',
)

// ---- narration ----------------------------------------------------------------------------------------

// An announcement says that something happened and not what: "Root cause found.", "Next:", "Memory updated".
// It only counts when almost nothing follows it, so the distiller's own "Root cause found. <the cause>"
// (a thin trigger extended by the next sentence) is judged on the cause.
const LEAD_MARKUP_RE = /^(?:\s|[-*•>#]|\d+[.)]|__)+/
const ANNOUNCE_RE = new RegExp(
  '^(?:' +
    '(?:the\\s+)?(?:root\\s+cause|cause|culprit|bug|issue|problem|answer|fix|solution)\\s+(?:is\\s+|was\\s+)?' +
      '(?:found|identified|located|clear|confirmed|known|understood)\\b' +
    '|found\\s+(?:it|the\\s+(?:root\\s+cause|cause|culprit|bug|issue|problem|answer|fix))\\b' +
    '|next(?:\\s+(?:steps?|up|actions?))?\\b\\s*[:.!\\-–—]?' +
    '|(?:memory|notes?|plan|summary|todo|status)\\s+(?:updated|saved|written|added|recorded|noted)\\b' +
    '|(?:done|finished|complete|completed|fixed|merged|pushed|committed|shipped|resolved)\\b' +
    '|all\\s+(?:done|set|good)\\b' +
    '|(?:ok|okay|got\\s+it|understood|noted|thanks|thank\\s+you|will\\s+do|sounds\\s+good|on\\s+it)\\b' +
    '|here(?:[\'’]s|\\s+is|\\s+are)\\b' +
    '|see\\s+(?:above|below)\\b' +
    '|(?:the\\s+)?rest\\s*:' +
    '|as\\s+follows\\b' +
  ')',
  'i',
)
const ANNOUNCE_REST_WORDS = 4 // this many words after the opener and it was the lead-in to something

// First-person progress ("I'll", "let me", "we're") and time-bound status ("today", "in progress", "so far"):
// what someone was doing, not what is true. 1 each, to PROGRESS_CAP.
const PROGRESS_RE = new RegExp(
  '\\b(?:i[\'’]ll|i will|i[\'’]m|i am|i[\'’]ve|i have|i[\'’]d|i can|i could|i should|i need to|i want to|let me|' +
    'let[\'’]s|let us|we[\'’]ll|we will|we[\'’]re|we are|we[\'’]ve|now i|next i|then i|going to|gonna|' +
    'today|yesterday|tomorrow|tonight|this (?:morning|afternoon|evening|week|session|sprint)|just now|right now|' +
    'at the moment|currently|for now|so far|later today|earlier today|last night|in progress|pending|awaiting|' +
    'waiting (?:for|on)|to-?do|ongoing|upcoming|next (?:week|sprint|release|steps?)|' +
    'still (?:open|running|failing|broken|pending))\\b',
  'gi',
)

// A bare commit hash: 7-40 hex characters with a digit AND a letter, so "deadbeef", "facade" and a ticket
// number are not mistaken for one.
const HASH_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi
const HASHES_FOR_PENALTY = 3

// JSON left in a lesson by a stringified tool result: the text opens with an object or array, or carries
// three key/value pairs, or two escapes that only exist inside a JSON string. One inline setting such as
// `"strict": true` and a Windows path with backslashes are ordinary lessons.
const JSON_OPEN_RE = /^\s*[{[]\s*["{[]/
const JSON_PAIR_RE = /"[\w$-]{1,40}"\s*:/g
const JSON_ESCAPE_RE = /\\"|\\u[0-9a-fA-F]{4}/g

function count(head: string, re: RegExp): number {
  return head.match(re)?.length ?? 0
}

/** Words in `s`, counted only up to `stopAt`; a non-ASCII character counts as a word character. */
function wordsUpTo(s: string, stopAt: number): number {
  let words = 0
  let inWord = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const w = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127
    if (w && !inWord && ++words >= stopAt) return words
    inWord = w
  }
  return words
}

function isBareAnnouncement(head: string): boolean {
  const lead = head.replace(LEAD_MARKUP_RE, '')
  const m = ANNOUNCE_RE.exec(lead)
  return !!m && wordsUpTo(lead.slice(m[0].length), ANNOUNCE_REST_WORDS) < ANNOUNCE_REST_WORDS
}

/** Score a lesson. Never throws; any input that is not a string scores as the empty string. */
export function lessonSubstance(content: string): Substance {
  const text = typeof content === 'string' ? content.trim() : ''
  const head = text.length > ANALYZE_MAX ? text.slice(0, ANALYZE_MAX) : text
  const reasons: string[] = []
  let score = 0
  const add = (points: number, what: string): void => {
    score += points
    reasons.push(`${what} ${points > 0 ? '+' : ''}${points}`)
  }

  const ids = identifierPoints(head)
  if (ids > 0) add(ids, 'identifiers')
  if (CONNECTIVE_RE.test(head)) add(2, 'connective')
  if (isBareAnnouncement(head)) add(-3, 'announcement')
  const progress = Math.min(PROGRESS_CAP, count(head, PROGRESS_RE))
  if (progress > 0) add(-progress, 'progress')
  if (text.length < SHORT_BELOW) add(-2, 'short')
  else if (text.length >= LONG_FROM) add(-1, 'long')
  if (count(head, HASH_RE) >= HASHES_FOR_PENALTY) add(-2, 'hashes')
  if (JSON_OPEN_RE.test(head) || count(head, JSON_PAIR_RE) >= 3 || count(head, JSON_ESCAPE_RE) >= 2) add(-2, 'json')
  return { score, reasons }
}
