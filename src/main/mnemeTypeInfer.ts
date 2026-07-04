// mnemeTypeInfer.ts
//
// Deterministic cognitive-type classifier for the Memory & Learning dashboard.
//
// The store holds ~80k memories but almost none carry an explicit `memoryType`:
// only the Mneme reflection layer sets it (distilled lessons → semantic/procedural,
// entity stubs → entity, consolidation rollups → summary). The bulk code + transcript
// indexers — which authored the vast majority of entries — leave it undefined. So the
// dashboard's "by cognitive type" panel showed 100% "untyped" and "lessons" = 0.
//
// This maps the REAL signals every entry already carries (kind, source, agentId,
// content) onto the five cognitive facets, so the composition panel and lesson count
// reflect what's actually in the brain. It is a read-time projection — pure, and never
// mutates the append-only store. An entry that DID get an explicit type keeps it.

export type CognitiveType = 'episodic' | 'semantic' | 'procedural' | 'entity' | 'summary'

/** The minimal shape needed to classify — structurally satisfied by a MemoryEntry. */
export interface TypeInferInput {
  kind?: string
  source?: string
  agentId?: string
  content?: string
  memoryType?: CognitiveType
}

// A `result` memory is only a "how-to" (procedural) when it reads like an error paired
// with a resolution. Most result entries are bare tool-result/-error stubs with no fix
// text, so this deliberately under-fires (they fall through to episodic) rather than
// inflating the lesson count.
const ERROR_RE = /\b(error|exception|failed|failure|traceback|enoent|cannot|denied|reject)\b/i
const FIX_RE = /\b(fix|fixed|resolv\w*|solution|workaround|prepend|instead|should|must|add\b|run\b|use\b)\b/i

function looksProcedural(content: string): boolean {
  return ERROR_RE.test(content) && FIX_RE.test(content)
}

/**
 * Classify a memory into a cognitive facet. Precedence-ordered; every rule keys off a
 * field value that actually occurs in the store. Pure — no I/O, no store access.
 *
 *  1. explicit memoryType wins (reflection/mneme already typed it)
 *  2. code artifacts (source 'code' / agent 'code-index') → entity — canonical files/units
 *  3. mneme rollup notes → summary
 *  4. decision / fact → semantic — distilled knowledge
 *  5. result → procedural when it reads error→fix, else episodic (raw outcome)
 *  6. message → episodic — raw ingested transcript/turn ("what happened")
 *  7. note → semantic — a curated note (MCP memory_write defaults kind='note')
 *  8. default → episodic
 */
export function inferMemoryType(e: TypeInferInput): CognitiveType {
  if (e.memoryType) return e.memoryType
  if (e.source === 'code' || e.agentId === 'code-index') return 'entity'
  if (e.source === 'mneme' && e.kind === 'note') return 'summary'
  switch (e.kind) {
    case 'decision':
    case 'fact':
      return 'semantic'
    case 'result':
      return looksProcedural(e.content || '') ? 'procedural' : 'episodic'
    case 'message':
      return 'episodic'
    case 'note':
      return 'semantic'
    default:
      return 'episodic'
  }
}

/** The lesson facets — distilled, reusable knowledge (vs raw episodic/entity material). */
export function isLessonType(t: CognitiveType): boolean {
  return t === 'semantic' || t === 'procedural'
}
