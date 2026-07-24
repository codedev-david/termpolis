// mnemeSession.ts
//
// Mneme — solo-session episode assembly (extends Phase 1 learning to individual
// agent terminals; see docs/superpowers/specs/2026-07-01-solo-session-learning-design.md).
// A swarm task has an explicit completed/failed boundary + a result string; a solo
// Claude/Codex/Gemini session does not. This module turns a live transcript's
// turns into the SAME Episode contract mnemeReflex consumes, by (1) tracking a
// per-terminal cursor so each reflection pass only sees the turns appended since the
// last one, and (2) inferring a conservative outcome from the final assistant turn.
//
// PURE and injectable by design — no electron, no fs, no clock, no model — so it
// unit-tests model-free (mirrors mnemeEpisode.ts). Transcript *reading* is the
// caller's job (main's readActiveTranscript); this module only diffs, classifies,
// and normalizes what it is handed.

import type { RawTurn } from './mnemeEpisode'
import { assembleEpisode } from './mnemeEpisode'
import type { Episode, Outcome } from './mnemeReflect'

/** How far a terminal's transcript has already been reflected. */
export interface SessionCursor {
  /** Number of turns reflected so far. */
  count: number
  /** Hash of those reflected turns — detects a rewritten / switched session. */
  hash: string
}

/** The starting cursor for a terminal we have never reflected. */
export const EMPTY_CURSOR: SessionCursor = { count: 0, hash: '' }

export interface SessionDelta {
  /** Turns appended since the cursor (or all turns on a first pass / session switch). */
  fresh: RawTurn[]
  /** The advanced cursor to persist for the next pass. */
  cursor: SessionCursor
}

const turnText = (t: RawTurn): string => (t.text ?? t.content ?? '')

/**
 * FNV-1a over the turns' role+text. Deterministic and dependency-free — this is a
 * change-detector for the cursor, not a security hash (the content-addressed store
 * dedups any genuine overlap downstream, so a rare collision only costs a no-op pass).
 */
function hashTurns(turns: RawTurn[]): string {
  let h = 0x811c9dc5
  for (const t of turns) {
    const s = (t.role || '') + '\u0000' + turnText(t)
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
  }
  return (h >>> 0).toString(16)
}

/**
 * Diff a transcript against the last-reflected cursor. Returns the fresh turns to
 * reflect and the cursor to persist:
 *  - first pass (empty cursor) → every turn is fresh
 *  - normal growth (reflected prefix still matches) → only the appended turns
 *  - prefix mismatch (session rewritten / a different session now occupies the file)
 *    → treat all turns as fresh
 * Idempotent: re-diffing the same transcript yields an empty `fresh`.
 */
export function sessionDelta(turns: RawTurn[], prev: SessionCursor = EMPTY_CURSOR): SessionDelta {
  const cursor: SessionCursor = { count: turns.length, hash: hashTurns(turns) }
  let fresh: RawTurn[]
  if (prev.count <= 0) {
    fresh = turns.slice(0)
  } else if (hashTurns(turns.slice(0, prev.count)) === prev.hash) {
    fresh = turns.slice(prev.count)
  } else {
    fresh = turns.slice(0)
  }
  return { fresh, cursor }
}

// --- outcome inference ---------------------------------------------------------
// High precision over recall: only classify when the final assistant turn carries a
// clear, unambiguous signal; otherwise return undefined so no competence is recorded.

const SUCCESS_RE =
  /\b(fixed|resolved|works now|now works|passes now|tests? (?:pass|passing|passed|green)|all green|success(?:ful|fully)?|committed|pushed|done|completed|working now)\b/i
const FAILURE_RE =
  /\b(still (?:failing|broken|erroring|errors?)|unresolved|could ?n[’']?t (?:fix|resolve|solve)|couldn ?t (?:fix|resolve)|gave up|not working|does ?n[’']?t work|error persists|no luck)\b/i
const TEST_RE = /\btests?\b|\ball green\b/i
const COMMIT_RE = /\b(committed|git commit|pushed)\b/i

/**
 * Infer a reflection Outcome from a session's turns, reading the LAST assistant turn:
 *  - a clear failure signal → { kind: 'error', success: false }
 *  - a clear success signal → { kind: 'test' | 'commit' | 'manual', success: true }
 *  - both, neither, or no assistant turn → undefined (ambiguous → do not record)
 */
export function inferOutcome(turns: RawTurn[]): Outcome | undefined {
  let last = ''
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant') {
      last = turnText(turns[i])
      break
    }
  }
  if (!last) return undefined
  const hasFail = FAILURE_RE.test(last)
  const hasSuccess = SUCCESS_RE.test(last)
  if (hasFail && hasSuccess) return undefined
  if (hasFail) return { kind: 'error', success: false }
  if (hasSuccess) {
    const kind = COMMIT_RE.test(last) ? 'commit' : TEST_RE.test(last) ? 'test' : 'manual'
    return { kind, success: true }
  }
  return undefined
}

export interface BuildSessionEpisodeInput {
  id: string
  project?: string
  source?: string
  turns: RawTurn[]
}

/**
 * Assemble a solo-session Episode: normalize/bound the turns via assembleEpisode and
 * attach an inferred outcome when one can be classified with confidence. The outcome
 * is omitted for a neutral session so mnemeReflex records no competence for it.
 */
export function buildSessionEpisode(input: BuildSessionEpisodeInput): Episode {
  const outcome = inferOutcome(input.turns)
  return assembleEpisode({
    id: input.id,
    project: input.project,
    source: input.source,
    turns: input.turns,
    outcome,
  })
}

export interface SoloSessionInput {
  terminalId: string
  cwd: string
  agent: string
  project: string
}

export interface SoloReflexDeps {
  /** Read the agent's active transcript for a cwd into raw turns. */
  readTranscript: (cwd: string, agent: string) => Promise<RawTurn[]>
  /** Per-terminal reflection cursor lookup. */
  getCursor: (terminalId: string) => SessionCursor | undefined
  /** Persist the advanced cursor for a terminal. */
  setCursor: (terminalId: string, cursor: SessionCursor) => void
  /** Run the reflex on the assembled episode (distill + ground + competence). */
  reflect: (episode: Episode) => Promise<{ fired: boolean; lessons: number }>
}

/**
 * Orchestrate ONE solo-session reflection pass for a terminal: read the transcript,
 * diff it against the terminal's cursor, and — if new turns appeared — assemble a
 * session episode and run the reflex, advancing the cursor only after the reflex
 * resolves (so a failed pass re-processes those turns next time). A pass with no fresh
 * turns is a cheap no-op. Injectable deps keep it fully unit-testable.
 */
export async function reflectSoloSession(
  input: SoloSessionInput,
  deps: SoloReflexDeps,
): Promise<{ fired: boolean; lessons: number }> {
  const turns = await deps.readTranscript(input.cwd, input.agent)
  const prev = deps.getCursor(input.terminalId) ?? EMPTY_CURSOR
  const { fresh, cursor } = sessionDelta(turns, prev)

  if (fresh.length === 0) {
    deps.setCursor(input.terminalId, cursor)
    return { fired: false, lessons: 0 }
  }

  const episode = buildSessionEpisode({
    id: `${input.terminalId}:${cursor.count}`,
    project: input.project,
    source: input.agent,
    turns: fresh,
  })
  const res = await deps.reflect(episode)
  deps.setCursor(input.terminalId, cursor)
  return { fired: res.fired, lessons: res.lessons }
}
