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

export interface DistillOptions {
  llm?: LlmDistiller
  maxLessons?: number
}

// --- classification vocabulary -------------------------------------------------

const ERROR_RE =
  /\b(error|exception|failed|failure|traceback|stack ?trace|cannot|can['’]t|denied|not found|undefined|null is not|crash(?:ed|es)?|throws?|ENOENT|E[A-Z]{3,})\b/i
const FIX_RE =
  /\b(fix(?:ed|es)?|resolv(?:ed|es)|solv(?:ed|es)|workaround|the fix (?:is|was)|now works|works now|passes now)\b/i
const DECISION_RE =
  /\b(decid(?:ed|e)|chose|choosing|going with|we['’]ll use|let['’]s use|opt(?:ed|ing) for|the plan is|the approach is|will use instead)\b/i
const GOTCHA_RE =
  /\b(gotcha|turns out|root cause|the (?:real )?(?:issue|bug|problem) (?:was|is)|caused by|beware|watch out|pitfall|footgun|note that)\b/i

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

/** Split a turn's text into candidate lesson sentences (fragments are dropped). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)
}

/** Extract referenced entities: backtick spans, file-ish paths, SCREAMING codes. */
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

  const assistantSentences = episode.turns
    .filter((t) => t.role === 'assistant')
    .flatMap((t) => splitSentences(t.text))
  const allSentences = episode.turns.flatMap((t) => splitSentences(t.text))

  const problem =
    allSentences.find((s) => ERROR_RE.test(s)) ||
    (outcome?.kind === 'error' ? outcome.detail : undefined)
  const fix = assistantSentences.find((s) => FIX_RE.test(s))

  // 1) Procedural lesson: a problem that got solved.
  if (problem && fix) {
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

  // 2) Decisions → semantic decision lessons.
  for (const s of assistantSentences.filter((x) => DECISION_RE.test(x))) {
    const entities = extractEntities(s)
    pushUnique(lessons, {
      memoryType: 'semantic',
      kind: 'decision',
      content: truncate(s),
      entities,
      importance: importanceFor('semantic', 'decision', outcome, entities.length),
      links: [],
    })
  }

  // 3) Gotchas / root causes → semantic fact lessons (skip if the sentence is really a fix).
  for (const s of assistantSentences.filter((x) => GOTCHA_RE.test(x) && !FIX_RE.test(x))) {
    const entities = extractEntities(s)
    pushUnique(lessons, {
      memoryType: 'semantic',
      kind: 'fact',
      content: truncate(s),
      gotcha: truncate(s, 240),
      entities,
      importance: importanceFor('semantic', 'fact', outcome, entities.length),
      links: [],
    })
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
      const memoryType: LessonMemoryType = fix ? 'procedural' : 'semantic'
      pushUnique(lessons, {
        memoryType,
        kind: 'fact',
        content: truncate(text),
        entities,
        importance: clamp01(round3(importanceFor(memoryType, 'fact', outcome, entities.length) + 0.1)),
        links: fix ? [{ relation: 'solves' }] : [],
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
