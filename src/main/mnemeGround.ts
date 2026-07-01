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

/**
 * Distill an episode and write each lesson to the store as a grounded typed
 * memory. Returns the ids written and the total lesson count.
 */
export async function groundEpisode(
  episode: Episode,
  deps: { distill: EpisodeDistiller; write: MemoryWriter },
): Promise<GroundResult> {
  let lessons: Lesson[] = []
  try {
    lessons = await deps.distill(episode)
  } catch {
    lessons = [] // a flaky distiller never breaks the loop
  }

  const written: string[] = []
  for (const lesson of lessons) {
    try {
      const res = await deps.write(lessonToWriteInput(lesson, episode))
      if (res && res.id) written.push(res.id)
    } catch {
      /* best effort — skip this lesson, keep the rest */
    }
  }
  return { written, lessons: lessons.length }
}
