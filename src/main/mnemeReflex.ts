// mnemeReflex.ts
//
// Mneme — the reflex that fires when a task completes (Phase 1b wiring logic).
// On a task boundary it (1) grounds the outcome into self-competence and (2)
// reflects the episode into distilled lessons. Pure/injectable orchestrator: the
// store writer, distiller, competence recorder, and clock are all passed in, so
// this is fully unit-testable. index.ts wires the real dependencies and calls it
// fire-and-forget from the task-completion path.

import type { Episode, Lesson } from './mnemeReflect'
import {
  assembleEpisode,
  boundaryFromTaskStatus,
  outcomeFromTaskStatus,
  isReflectable,
  type RawTurn,
} from './mnemeEpisode'
import { groundEpisode, type MemoryWriter } from './mnemeGround'

export interface CompletedTask {
  id: string
  status: string
  title?: string
  description?: string
  result?: string
  project?: string
  source?: string
}

export interface ReflexDeps {
  distill: (ep: Episode) => Promise<Lesson[]>
  write: MemoryWriter
  recordOutcome: (domain: string, success: boolean, now: number) => void
  now: number
}

export interface ReflexResult {
  fired: boolean
  lessons: number
  written: string[]
}

/** Best-effort episode turns from a task's text fields. */
export function taskToTurns(task: CompletedTask): RawTurn[] {
  const turns: RawTurn[] = []
  const ask = [task.title, task.description].filter(Boolean).join('\n').trim()
  if (ask) turns.push({ role: 'user', content: ask })
  if (task.result && task.result.trim()) turns.push({ role: 'assistant', content: task.result })
  return turns
}

/**
 * Run the reflex for a task. Returns whether it fired (a real boundary), how many
 * lessons were distilled, and the memory ids written. Competence is always
 * recorded on a boundary; reflection only runs when the episode is substantive.
 */
export async function onTaskComplete(task: CompletedTask, deps: ReflexDeps): Promise<ReflexResult> {
  if (!task || !boundaryFromTaskStatus(task.status)) return { fired: false, lessons: 0, written: [] }

  const domain = (task.project || 'general').trim() || 'general'
  const success = task.status === 'completed'
  try {
    deps.recordOutcome(domain, success, deps.now)
  } catch {
    /* a competence-store failure must never break reflection */
  }

  const episode = assembleEpisode({
    id: task.id,
    project: task.project,
    source: task.source,
    turns: taskToTurns(task),
    outcome: outcomeFromTaskStatus(task.status, task.result),
  })
  if (!isReflectable(episode)) return { fired: true, lessons: 0, written: [] }

  const { written, lessons } = await groundEpisode(episode, { distill: deps.distill, write: deps.write })
  return { fired: true, lessons, written }
}
