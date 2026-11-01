// mnemeGround.ts
//
// Mneme — the write-and-ground path (Phase 1b of the learning architecture).
// Turns distilled Lessons into typed, grounded memories in the store: each lesson
// becomes a memoryWrite carrying its cognitive type, importance, and a link back
// to the episode it was derived from (`originEpisode`).
//
// PURE / injectable: the distiller and the store writer are passed in, so this is
// fully unit-testable with fakes and never imports electron/fs. Best-effort by
// design — a flaky distiller or a single failed write never aborts the batch,
// because losing one lesson is far better than losing the whole reflection.

import { extractEntities, type Episode, type Lesson } from './mnemeReflect'
import type { CodeRef } from './codeGraph'
import { CANDIDATE_IMPORTANCE, CANDIDATE_TAG, importanceForScore, lessonSubstance, substanceBand } from './lessonSubstance'

/** Minimal write contract — satisfied structurally by swarmMemory.memoryWrite. */
export interface LessonWriteInput {
  agentId: string
  kind: 'decision' | 'fact' | 'note'
  content: string
  memoryType: 'semantic' | 'procedural'
  importance: number
  originEpisode: string
  project?: string
  source: string
  codeRefs?: CodeRef[] // v1.23 C2 — code anchors, resolved from the lesson's entities
  tags?: string[] // 1.55: `candidate` on a lesson the substance gate stores but never surfaces
}

export type MemoryWriter = (input: LessonWriteInput) => Promise<{ id: string }>
export type EpisodeDistiller = (episode: Episode) => Promise<Lesson[]>

export interface GroundResult {
  /** Ids stored: the keepers and the lessons held back as candidates. */
  written: string[]
  /** How many lessons the distiller produced. */
  lessons: number
  /** How many the substance gate refused to store at all (a write that failed is not counted here). */
  skipped: number
}

/** Map one distilled Lesson to a store write input, grounded to its episode. */
export function lessonToWriteInput(lesson: Lesson, episode: Episode): LessonWriteInput {
  return {
    agentId: 'mneme',
    kind: lesson.kind,
    content: lesson.content,
    memoryType: lesson.memoryType,
    importance: lesson.importance,
    originEpisode: episode.id,
    ...(episode.project ? { project: episode.project } : {}),
    // Wave2 (lessons-source-mneme-pooling-inert): carry the AUTHORING agent (episode.source)
    // instead of hardcoding 'mneme', so memory_pool's cross-agent corroboration (a distinct-
    // source count) actually fires when different agents independently learn the same lesson.
    source: episode.source || 'mneme',
  }
}

/** Create a typed graph edge (best-effort). Injected so mnemeGround stays pure. */
export type LessonLinker = (from: string, to: string, relation: string, weight?: number) => void
/** Upsert an entity node by name → its memory id (best-effort). Injected. */
export type EntityEnsurer = (name: string, project?: string) => Promise<string | null>

export interface GroundDeps {
  distill: EpisodeDistiller
  write: MemoryWriter
  /** When present, a lesson's RESOLVED links (with a target) and its referenced
   *  entities are minted as graph edges — this is what makes the knowledge graph's
   *  causal + entity connections real instead of only cosine 'relates-to' auto-links. */
  link?: LessonLinker
  /** Paired with `link`: upsert an `entity` node per referenced file/function/error
   *  and connect the lesson to it, so two lessons about the same thing share a node. */
  ensureEntity?: EntityEnsurer
  /** v1.23 C2: resolve a lesson's entity names to structured code anchors (via the code graph),
   *  stamped onto the written memory so recall can cross from a lesson to the code it's about. */
  resolveCode?: (names: string[], project?: string) => CodeRef[]
}

/**
 * Distill an episode and write each lesson to the store as a grounded typed
 * memory. When graph deps are provided, each written lesson also mints edges to
 * its resolved link targets and to entity nodes for the things it references.
 *
 * Every lesson first passes the substance gate (lessonSubstance.ts): a keeper is written with an importance
 * that follows its score; one just under the bar is written at CANDIDATE_IMPORTANCE under the `candidate` tag,
 * which every read path that hands memories to an agent hides. It is given no code anchors and none of the
 * entity or typed edges below, so nothing is built on it (the store's own automatic relates-to links still
 * form, and are harmless: a graph read drops the tagged row). One below that is not written, and counted.
 * Returns the ids written, how many lessons the distiller produced and how many the gate refused.
 */
export async function groundEpisode(episode: Episode, deps: GroundDeps): Promise<GroundResult> {
  let lessons: Lesson[] = []
  try {
    lessons = await deps.distill(episode)
  } catch {
    lessons = [] // a flaky distiller never breaks the loop
  }

  const written: string[] = []
  let skipped = 0
  for (const lesson of lessons) {
    const verdict = lessonSubstance(lesson.content)
    const band = substanceBand(verdict.score)
    if (band === 'drop') { skipped++; continue }
    const held = band === 'candidate'
    let id: string | undefined
    try {
      const input = lessonToWriteInput(lesson, episode)
      if (held) {
        input.importance = CANDIDATE_IMPORTANCE
        input.tags = [CANDIDATE_TAG]
      } else {
        input.importance = importanceForScore(verdict.score)
        // v1.23 C2: stamp the lesson with structured code anchors resolved from its entities,
        // so the stored memory knows WHERE it lives (symbolHistory reads these back).
        if (deps.resolveCode && lesson.entities && lesson.entities.length) {
          try {
            const refs = deps.resolveCode(lesson.entities, episode.project)
            if (refs.length) input.codeRefs = refs
          } catch { /* best effort — a resolver hiccup never costs the lesson */ }
        }
      }
      const res = await deps.write(input)
      if (res && res.id) { id = res.id; written.push(res.id) }
    } catch {
      continue // best effort — skip this lesson, keep the rest
    }
    if (!id || held) continue
    await connectLesson(id, lesson, episode, deps)
  }
  return { written, lessons: lessons.length, skipped }
}

/** Turn a written lesson's typed links + referenced entities into graph edges.
 *  Fully guarded: a graph failure never costs us the lesson that was already stored. */
async function connectLesson(id: string, lesson: Lesson, episode: Episode, deps: GroundDeps): Promise<void> {
  const link = deps.link
  if (!link) return
  // Resolved typed links (solves / caused-by / supersedes …). A link with no target
  // is just a relation label the extractor couldn't resolve — skip it, don't guess.
  for (const lk of lesson.links || []) {
    if (lk && lk.to && lk.relation) {
      try { link(id, lk.to, lk.relation) } catch { /* best effort */ }
    }
  }
  // Entity layer: connect the lesson to each file/function/error it names, so two
  // lessons about the same entity become reachable through the shared entity node.
  if (deps.ensureEntity) {
    for (const name of lesson.entities || []) {
      try {
        const eid = await deps.ensureEntity(name, episode.project)
        if (eid) { try { link(id, eid, 'refers-to') } catch { /* best effort */ } }
      } catch { /* best effort */ }
    }
    // v1.23 C3 — revive the automatic CAUSAL layer. A procedural fix lesson carries a
    // targetless {relation:'solves'} because the distiller can't resolve the target; we
    // resolve it HERE by minting a `solves` edge from the lesson to each entity that
    // names the PROBLEM it fixed (an error code / file / symbol). Traversing that error
    // entity via the inverse `solved-by` then surfaces the fix automatically — bug→fix is
    // finally traversable without an agent hand-calling memory_link. (The one automatic
    // path the distiller intended shipped as dead code before this.)
    const solvesSomething = (lesson.links || []).some((lk) => lk && lk.relation === 'solves')
    if (solvesSomething && lesson.problem) {
      for (const name of extractEntities(lesson.problem)) {
        try {
          const eid = await deps.ensureEntity(name, episode.project)
          if (eid) { try { link(id, eid, 'solves') } catch { /* best effort */ } }
        } catch { /* best effort */ }
      }
    }
  }
}
