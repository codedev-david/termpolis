// mnemeReflect.ts
//
// Mneme — reflection / distillation core (Phase 1a of the learning architecture;
// see docs/learning-architecture.md). Turns a completed Episode (the turns of a
// task/session plus its outcome) into typed, reusable Lessons.
//
// This module is PURE and injectable by design: no electron, no fs, no memory
// store, no clock, no LLM of its own. The deterministic extractor runs with zero
// tokens and is fully unit-testable (mirrors contextPrimer.ts / memoryEconomy.ts).
// An optional injected `llm` distiller can enrich the result; the real headless
// `claude -p --model haiku` invocation that satisfies that seam lives in
// mnemeDistiller.ts, so this file stays deterministic and test-friendly.
//
// Design stance: HIGH PRECISION over recall. A confident-but-wrong "lesson" that
// gets recalled later is worse than no lesson, so the classifiers are conservative.

export type LessonMemoryType = 'semantic' | 'procedural'
export type LessonKind = 'decision' | 'fact' | 'note'

export interface EpisodeTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface Outcome {
  kind: 'test' | 'commit' | 'error' | 'manual'
  success: boolean
  detail?: string
}

export interface Episode {
  id: string
  project?: string
  source?: string
  turns: EpisodeTurn[]
  outcome?: Outcome
}

export interface LessonLink {
  /** Target memory id — filled in downstream by the writer/ground layer when known. */
  to?: string
  relation: string
}

export interface Lesson {
  memoryType: LessonMemoryType
  kind: LessonKind
  content: string
  problem?: string
  solution?: string
  gotcha?: string
  entities: string[]
  importance: number // 0..1
  links: LessonLink[]
}

/** Injected distiller seam — implemented headlessly in mnemeDistiller.ts. */
export type LlmDistiller = (prompt: string) => Promise<string | null>

/** v1.23 C7 — the value gate for OPTIONAL LLM enrichment. Only spend a headless model call on a
 *  substantive, grounded, SUCCESSFUL episode; the zero-token deterministic extractor covers
 *  everything else. Keeps the distiller net-positive on tokens and never enriches a failed or
 *  thin episode into a confident-but-wrong lesson. */
export function isHighValueEpisode(ep: Episode): boolean {
  return !!ep && ep.outcome?.success === true && (ep.turns?.length ?? 0) >= 2
}

export interface DistillOptions {
  llm?: LlmDistiller
  maxLessons?: number
}

// --- classification vocabulary -------------------------------------------------

// Problems get reported while they are still happening — "it keeps crashing", "the build is
// failing", "it's throwing a TypeError" — so every verb here carries its present participle. The
// forms were missing until v1.47 and the cost was not one skipped sentence: with the user's turn
// invisible, the only error-ish sentence left was the assistant's own fix, which cannot pair with
// itself, so the whole episode taught nothing. `breaking` is guarded because "breaking change" is
// ordinary changelog prose, not a failure.
const ERROR_RE =
  /\b(error(?:s|ing)?|exception|fail(?:s|ed|ing|ure|ures)?|traceback|stack ?trace|cannot|can['’]t|denied|not found|undefined|null is not|crash(?:ed|es|ing)?|throw(?:s|ing)?|hang(?:s|ing)|break(?:s|ing)(?!\s*-?\s*change)|ENOENT|E[A-Z]{3,})\b/i
// Same participle gap as ERROR_RE, on the other side of the pair — plus the ordinary repair verbs
// that were never here at all. Deliberately NOT widened to bare `added`/`changed`/`updated`: the
// pairing below is high-precision by design, and a wrong pair writes a recipe that will later be
// recommended for a problem it does not solve. "Added a note to the changelog" is not a fix.
const FIX_RE =
  /\b(fix(?:ed|es|ing)?|resolv(?:ed|es|ing)|solv(?:ed|es|ing)|patch(?:ed|es|ing)|correct(?:ed|ing)|switch(?:ed|ing) to|workaround|worked around|the fix (?:is|was)|now works|works now|passes now)\b/i
const DECISION_RE =
  /\b(decid(?:ed|e)|chose|choosing|going with|we['’]ll use|let['’]s use|opt(?:ed|ing) for|the plan is|the approach is|will use instead)\b/i
const GOTCHA_RE =
  /\b(gotcha|turns out|root cause|the (?:real )?(?:issue|bug|problem) (?:was|is)|caused by|beware|watch out|pitfall|footgun|note that)\b/i

// Harness/tool scaffolding that is never a lesson. These lines carry error-ish words
// ("failed", "exit code") but describe the *plumbing*, not the work — mining them for a
// problem statement yielded stored lessons like "Problem: <status>failed</status>".
const NOISE_RE =
  /<\/?(?:status|summary|task-notification|task-id|tool-use-id|output-file|system-reminder|command-name)\b|Background command|exit code \d|<\/?function_(?:calls|results)\b/i

// Words too common to signal that two sentences concern the same thing.
const TOPIC_STOPWORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'been', 'were', 'will', 'would', 'could', 'should',
  'there', 'their', 'then', 'than', 'when', 'what', 'which', 'while', 'where', 'because',
  'into', 'onto', 'over', 'under', 'after', 'before', 'about', 'also', 'just', 'only',
  'some', 'more', 'most', 'they', 'them', 'your', 'yours', 'here', 'does', 'done', 'like',
  'make', 'made', 'need', 'needs', 'want', 'take', 'used', 'using', 'still', 'even',
])

/** Split an identifier into the words a human would say it with: `TerminalManager.closeSession`
 *  → the whole token plus `terminalmanager`, `terminal`, `manager`, `closesession`, `close`,
 *  `session`. Without this, a stack frame naming `TerminalManager.closeSession` and a fix naming
 *  `closeSession` look like two unrelated atoms and the pair scores zero. */
function identifierParts(raw: string): string[] {
  const parts = [raw.toLowerCase()]
  for (const seg of raw.split(/[./\\_-]+/)) {
    if (!seg) continue
    parts.push(seg.toLowerCase())
    for (const w of seg.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/)) {
      if (w) parts.push(w.toLowerCase())
    }
  }
  return parts
}

/** Content words worth comparing between two sentences (≥4 chars, not a stopword), including
 *  the sub-words of every dotted/slashed/camelCase identifier. */
function topicTokens(s: string): Set<string> {
  const out = new Set<string>()
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_./\\-]{2,}/g)) {
    for (const part of identifierParts(m[0].replace(/[.\-/\\]+$/, ''))) {
      if (part.length >= 4 && !TOPIC_STOPWORDS.has(part)) out.add(part)
    }
  }
  return out
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared / Math.min(a.size, b.size)
}

/** How likely is it that `fix` actually addresses `problem`? A shared concrete entity
 *  (a backticked symbol, a path, a SCREAMING code) is decisive; otherwise fall back to
 *  content-word overlap. */
export function relatedness(problem: string, fix: string): number {
  const pe = new Set(extractEntities(problem))
  if (pe.size > 0) {
    for (const e of extractEntities(fix)) if (pe.has(e)) return 1
  }
  return overlapRatio(topicTokens(problem), topicTokens(fix))
}

/** Below this, a problem and a fix are treated as unrelated and NO procedural lesson is
 *  minted. High-precision by design: a recipe filed under the wrong problem is worse than
 *  no recipe, because memory_anticipate will later recommend it. */
export const RELATEDNESS_FLOOR = 0.18

const MAX_CONTENT = 600 // lessons should be dense; the store itself caps at 16KB
const MAX_ENTITIES = 12
const DEFAULT_MAX_LESSONS = 8

function clamp01(n: number): number {
  // Branchless clamp. NaN would propagate, but importance is never NaN here.
  return Math.min(1, Math.max(0, n))
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function truncate(s: string, max = MAX_CONTENT): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

const THIN_LESSON_CHARS = 55
/** A short trigger sentence ("Found the root cause.", "The plan is clear.") usually
 *  carries its real substance in the NEXT sentence, so pull it in rather than store a
 *  useless stub. Guarded against an identical adjacent sentence so exact-duplicate
 *  decisions still de-duplicate. */
function extendThin(s: string, next: string | undefined): string {
  return s.length < THIN_LESSON_CHARS && next && next !== s ? `${s} ${next}` : s
}

/** Split a turn's text into candidate lesson sentences (fragments are dropped). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)
}

/** Extract referenced entities: backtick spans, file-ish paths, SCREAMING codes. */
// Wave2 (junk-entity-hubs): common all-caps tokens that the SCREAMING-code rule would
// otherwise mint as entity nodes — every lesson naming them links to the same node, making
// them high-degree hubs that connect unrelated lessons and pollute graph traversal/fusion.
const ENTITY_STOPWORDS = new Set([
  'API', 'JSON', 'HTTP', 'HTTPS', 'TODO', 'FIXME', 'NULL', 'TRUE', 'FALSE', 'HTML', 'CSS', 'URL', 'URI',
  'SQL', 'XML', 'YAML', 'CLI', 'GUI', 'REST', 'GRPC', 'TCP', 'UDP', 'DNS', 'SSL', 'TLS', 'JWT', 'UUID',
  'ENV', 'CPU', 'GPU', 'RAM', 'PDF', 'CSV', 'UTF', 'ASCII', 'GET', 'POST', 'PUT', 'DELETE', 'OK', 'ERROR',
  'WARN', 'INFO', 'DEBUG', 'NPM', 'NODE', 'IDE', 'MCP', 'RAG',
])

export function extractEntities(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/`([^`\n]{1,60})`/g)) {
    const v = m[1].trim()
    if (v) out.add(v)
  }
  for (const m of text.matchAll(/\b[\w./\\-]+\.[A-Za-z]{2,5}\b/g)) {
    out.add(m[0])
  }
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
    if (ENTITY_STOPWORDS.has(m[0])) continue // Wave2: don't mint a hub node for common all-caps tokens
    out.add(m[0])
  }
  return Array.from(out).slice(0, MAX_ENTITIES)
}

function importanceFor(
  memoryType: LessonMemoryType,
  kind: LessonKind,
  outcome: Outcome | undefined,
  entityCount: number,
): number {
  let score = 0.5
  if (memoryType === 'procedural') score += 0.2 // a reusable recipe is high value
  else if (kind === 'decision') score += 0.15
  else score += 0.1 // semantic fact / gotcha
  if (outcome) score += outcome.success ? 0.15 : -0.25 // grounded good vs. failed
  score += Math.min(0.1, 0.02 * entityCount)
  return round3(clamp01(score))
}

function pushUnique(lessons: Lesson[], lesson: Lesson): void {
  const key = lesson.content.toLowerCase()
  if (lessons.some((l) => l.content.toLowerCase() === key)) return
  lessons.push(lesson)
}

/** Build the prompt an LLM distiller would use. Pure + exported so mnemeDistiller reuses it. */
export function buildDistillPrompt(episode: Episode): string {
  const transcript = episode.turns.map((t) => `${t.role.toUpperCase()}: ${t.text.trim()}`).join('\n')
  const outcome = episode.outcome
    ? `\nOUTCOME: ${episode.outcome.kind} ${episode.outcome.success ? 'succeeded' : 'FAILED'}${
        episode.outcome.detail ? ` (${episode.outcome.detail})` : ''
      }`
    : ''
  return [
    'You are the memory of a software team. Distill the single most reusable, durable lesson from this work episode.',
    'Return ONE short sentence stating the reusable knowledge (a fix, a decision + why, or a gotcha).',
    'Be specific — name files/functions/errors. If nothing durable was learned, return an empty line.',
    `\nPROJECT: ${episode.project ?? 'unknown'}${outcome}\n\nEPISODE:\n${transcript}`,
  ].join('\n')
}

/**
 * Distill an Episode into typed, reusable Lessons. Deterministic by default; if
 * `opts.llm` is supplied it is consulted for an enriched lesson (added, deduped,
 * and subject to the maxLessons cap). A failing llm never breaks reflection.
 */
export async function distillEpisode(episode: Episode, opts: DistillOptions = {}): Promise<Lesson[]> {
  const maxLessons = opts.maxLessons ?? DEFAULT_MAX_LESSONS
  const outcome = episode.outcome
  const lessons: Lesson[] = []

  // One flat, ordered sentence stream. Order matters for causal pairing below: a fix can only
  // address a problem that was already stated, and adjacency is itself evidence of relatedness.
  const stream = episode.turns.flatMap((t) =>
    splitSentences(t.text).map((text) => ({ text, assistant: t.role === 'assistant' })),
  )
  const assistantSentences = stream.filter((s) => s.assistant).map((s) => s.text)

  // Pair a problem with the fix that actually ADDRESSES it. Until v1.47 this took the first
  // error-ish sentence anywhere (the user's turns included) and the first fix-ish assistant
  // sentence and stapled them together, with nothing checking they shared a subject — which
  // is how a real store ends up holding "Problem: can we do everything but the APIM part?
  // → Fix: Merged PR 39863: Fixed date formatting". See mnemeReflectCausal.test.ts.
  const problemCandidates = stream
    .map((s, i) => ({ ...s, i }))
    .filter((s) => ERROR_RE.test(s.text) && !NOISE_RE.test(s.text))
  // When no turn states the problem, the episode's own recorded failure IS the problem. That is
  // grounded fact rather than a mined guess, so this pairing is exempt from the checks below —
  // there is no ambiguity about which problem the episode's one fix belongs to.
  let problemFromOutcome = false
  if (
    problemCandidates.length === 0 &&
    outcome?.kind === 'error' &&
    outcome.detail &&
    !NOISE_RE.test(outcome.detail)
  ) {
    problemCandidates.push({ text: outcome.detail, assistant: false, i: -1 })
    problemFromOutcome = true
  }
  const fixCandidates = stream
    .map((s, i) => ({ ...s, i }))
    .filter((s) => s.assistant && FIX_RE.test(s.text) && !NOISE_RE.test(s.text))

  // Two-stage selection, high-precision by design.
  //   Stage 1 — shared subject: score every ordered pair by `relatedness` and take the best.
  //   Stage 2 — adjacency: when NO pair shows any lexical overlap, a fix that immediately
  //     follows the problem is still almost certainly its fix ("cannot find module `foo.ts`" →
  //     "added the path alias in `tsconfig.json`" share no words but are obviously one pair).
  //     Requiring a zero-sentence gap is what keeps this from re-creating the stapling bug: in a
  //     long, topic-switching session the stray fix is always many sentences away.
  type Pair = { problem: string; fix: string }
  let related: Pair | undefined // best shared-subject pair
  let bestScore = -1
  let adjacent: Pair | undefined // closest pair, used only as the stage-2 fallback
  let bestGap = Number.MAX_SAFE_INTEGER
  for (const p of problemCandidates) {
    for (const f of fixCandidates) {
      if (p.text === f.text) continue // a single sentence naming both is not a problem→fix pair
      if (f.i < p.i) continue // a fix cannot precede the problem it addresses
      const pair = { problem: p.text, fix: f.text }
      const score = relatedness(p.text, f.text)
      if (score > bestScore) {
        bestScore = score
        related = pair
      }
      const gap = f.i - p.i - 1
      if (gap < bestGap) {
        bestGap = gap
        adjacent = pair
      }
    }
  }
  const chosen =
    problemFromOutcome || bestScore >= RELATEDNESS_FLOOR
      ? related
      : bestGap === 0
        ? adjacent
        : undefined
  const problem = chosen?.problem
  const fix = chosen?.fix
  // The LLM-enrichment branch below only asks "did this episode fix anything at all?", a
  // weaker question than "which fix goes with which problem" — keep its original signal.
  const anyFix = fixCandidates[0]

  // 1) Procedural lesson: a problem that got SOLVED. Wave2 (failed-fix-stored-as-solution):
  // never mint a 'solves' recipe from a FAILED episode — memory_anticipate keys on
  // memoryType:'procedural' regardless of importance, so it would later recommend a fix that
  // never worked, violating the module's "a confident-but-wrong lesson is worse than none".
  if (problem && fix && outcome?.success !== false) {
    const entities = extractEntities(`${problem} ${fix}`)
    pushUnique(lessons, {
      memoryType: 'procedural',
      kind: 'fact',
      content: truncate(`Problem: ${problem} → Fix: ${fix}`),
      problem: truncate(problem, 240),
      solution: truncate(fix, 240),
      entities,
      importance: importanceFor('procedural', 'fact', outcome, entities.length),
      links: [{ relation: 'solves' }],
    })
  }

  // 2+3) Decisions and gotchas/root-causes → semantic lessons. A short trigger
  // sentence often has its real substance in the NEXT sentence, so extend thin ones.
  for (let i = 0; i < assistantSentences.length; i++) {
    const s = assistantSentences[i]
    const next = assistantSentences[i + 1]
    if (DECISION_RE.test(s)) {
      const content = extendThin(s, next)
      const entities = extractEntities(content)
      pushUnique(lessons, {
        memoryType: 'semantic',
        kind: 'decision',
        content: truncate(content),
        entities,
        importance: importanceFor('semantic', 'decision', outcome, entities.length),
        links: [],
      })
    } else if (GOTCHA_RE.test(s) && !FIX_RE.test(s)) {
      const content = extendThin(s, next)
      const entities = extractEntities(content)
      pushUnique(lessons, {
        memoryType: 'semantic',
        kind: 'fact',
        content: truncate(content),
        gotcha: truncate(content, 240),
        entities,
        importance: importanceFor('semantic', 'fact', outcome, entities.length),
        links: [],
      })
    }
  }

  // 4) Optional LLM enrichment (cheap headless model, injected). Additive + deduped.
  if (opts.llm) {
    let enriched: string | null = null
    try {
      enriched = await opts.llm(buildDistillPrompt(episode))
    } catch {
      enriched = null // never let a flaky model break reflection
    }
    const text = (enriched || '').trim()
    if (text) {
      const entities = extractEntities(text)
      const memoryType: LessonMemoryType = anyFix ? 'procedural' : 'semantic'
      pushUnique(lessons, {
        memoryType,
        kind: 'fact',
        content: truncate(text),
        entities,
        importance: clamp01(round3(importanceFor(memoryType, 'fact', outcome, entities.length) + 0.1)),
        links: anyFix ? [{ relation: 'solves' }] : [],
      })
    }
  }

  // Rank: procedural first (highest reuse), then by importance desc; then cap.
  lessons.sort((a, b) => {
    if (a.memoryType !== b.memoryType) return a.memoryType === 'procedural' ? -1 : 1
    return b.importance - a.importance
  })
  return lessons.slice(0, maxLessons)
}
