// mnemeEpisode.ts
//
// Mneme — episode assembly (Phase 1a of the learning architecture; see
// docs/learning-architecture.md). Turns raw task-boundary materials (turns the
// caller has already parsed out of a transcript / swarm task, plus that task's
// status + result) into a clean Episode ready for mnemeReflect.distillEpisode.
//
// PURE and injectable by design: no electron, no fs, no clock, no model. Any
// transcript *parsing* is the caller's job (e.g. conversationIngest.parseClaude
// Transcript) — this module only normalizes, bounds, and classifies what it is
// handed, so it unit-tests model-free (mirrors contextPrimer.ts / mnemeReflect.ts).
//
// The Episode / EpisodeTurn / Outcome contracts live in mnemeReflect.ts and are
// imported (never redefined) so reflection input and episode output stay in lockstep.

import type { Episode, EpisodeTurn, Outcome } from './mnemeReflect'

/**
 * Tolerant raw turn. Different transcript shapes carry the message body under
 * different keys (`text` vs `content`) and use free-form role strings, so we
 * accept both and normalize downstream rather than force the caller to conform.
 */
export interface RawTurn {
  role: string
  text?: string
  content?: string
}

/** Input to assembleEpisode: task-boundary identity + the raw turns + optional outcome. */
export interface AssembleInput {
  id: string
  project?: string
  source?: string
  turns: RawTurn[]
  outcome?: Outcome
}

// Cap on retained turns. A long-running session can accumulate thousands of
// turns; reflection only needs the recent context, and an unbounded episode
// would bloat the distiller prompt (and memory). Keep the most-recent slice.
const MAX_TURNS = 200

// Minimum combined turn-text length for an episode to be worth reflecting on.
// Below this the "episode" is almost always a trivial exchange with nothing
// durable to distil — high-precision gate (see mnemeReflect's design stance).
const MIN_REFLECT_CHARS = 40

/**
 * Normalize tolerant raw turns into EpisodeTurns:
 *  - role: exactly 'assistant' stays 'assistant'; every other role collapses to 'user'
 *  - text: `text ?? content ?? ''`, then trimmed
 *  - turns that are empty after trimming are dropped (noise, tool acks, blanks)
 */
export function normalizeTurns(raw: RawTurn[]): EpisodeTurn[] {
  const out: EpisodeTurn[] = []
  for (const t of raw) {
    const text = (t.text ?? t.content ?? '').trim()
    if (!text) continue
    out.push({ role: t.role === 'assistant' ? 'assistant' : 'user', text })
  }
  return out
}

/**
 * Assemble an Episode from raw task-boundary materials: normalize the turns,
 * keep only the most-recent MAX_TURNS, and attach project / source / outcome
 * when provided. Pure — the caller supplies everything, including the outcome.
 */
export function assembleEpisode(input: AssembleInput): Episode {
  const turns = normalizeTurns(input.turns).slice(-MAX_TURNS)
  const ep: Episode = { id: input.id, turns }
  if (input.project !== undefined) ep.project = input.project
  if (input.source !== undefined) ep.source = input.source
  if (input.outcome !== undefined) ep.outcome = input.outcome
  return ep
}

/**
 * Is this episode worth reflecting on? High-precision gate: there must be at
 * least one assistant turn AND enough combined turn text (>= MIN_REFLECT_CHARS),
 * so trivial or empty episodes are skipped and we never distil noise into a lesson.
 */
export function isReflectable(ep: Episode): boolean {
  const hasAssistant = ep.turns.some((t) => t.role === 'assistant')
  const textLen = ep.turns.reduce((n, t) => n + t.text.length, 0)
  return hasAssistant && textLen >= MIN_REFLECT_CHARS
}

/**
 * A task status marks a reflection boundary only when the task actually finished
 * one way or the other — 'completed' or 'failed'. In-flight states (running,
 * queued, cancelled, …) are not boundaries and produce no episode.
 */
export function boundaryFromTaskStatus(status: string): boolean {
  return status === 'completed' || status === 'failed'
}

/**
 * Map a task status into a reflection Outcome:
 *  - 'completed' → a successful manual outcome (the user/flow accepted the result)
 *  - 'failed'    → a failed error outcome
 *  - anything else → undefined (not a terminal boundary; nothing to attach)
 * The optional `result` is carried through as the outcome detail.
 */
export function outcomeFromTaskStatus(status: string, result?: string): Outcome | undefined {
  if (status === 'completed') return { kind: 'manual', success: true, detail: result }
  if (status === 'failed') return { kind: 'error', success: false, detail: result }
  return undefined
}
