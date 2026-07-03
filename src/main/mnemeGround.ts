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

import type { Episode, Lesson } from './mnemeReflect'

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
}

export type MemoryWriter = (input: LessonWriteInput) => Promise<{ id: string }>
export type EpisodeDistiller = (episode: Episode) => Promise<Lesson[]>

export interface GroundResult {
  written: string[]
  lessons: number
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
    source: 'mneme',
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
}

/**
 * Distill an episode and write each lesson to the store as a grounded typed
 * memory. When graph deps are provided, each written lesson also mints edges to
 * its resolved link targets and to entity nodes for the things it references.
 * Returns the ids written and the total lesson count.
 */
export async function groundEpisode(episode: Episode, deps: GroundDeps): Promise<GroundResult> {
  let lessons: Lesson[] = []
  try {
    lessons = await deps.distill(episode)
  } catch {
    lessons = [] // a flaky distiller never breaks the loop
  }

  const written: string[] = []
  for (const lesson of lessons) {
    let id: string | undefined
    try {
      const res = await deps.write(lessonToWriteInput(lesson, episode))
      if (res && res.id) { id = res.id; written.push(res.id) }
    } catch {
      continue // best effort — skip this lesson, keep the rest
    }
    if (!id) continue
    await connectLesson(id, lesson, episode, deps)
  }
  return { written, lessons: lessons.length }
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
  }
}
