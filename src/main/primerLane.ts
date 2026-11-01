// primerLane.ts
//
// The newest-first listing behind the primer's freshness lane (contextPrimer.ts), with the exclusions every search
// already makes.
//
// Relevance ranking answers "most similar to the query"; the lane answers "where did we leave off", and only a time-ordered
// read can. But a plain listing is the one read that skipped every filter a search applies, so the lane could hand an agent
// exactly what a search is built not to: a memory a person had retracted, one a later memory supersedes, one the outcomes
// had pushed under the suppression bar. A correction binds to the MEMORY, not to the tool that happened to serve it.
//
// Two of the exclusions can only be made where the facts live:
//   - superseded and suppressed: the memory process alone holds the graph and the feedback counts, so the listing asks it
//     (ListOptions.active, the same two filters memorySearch applies to its results);
//   - corrected: the overlay lives here in main, so the rows go through it: a retraction drops the row, an amendment
//     swaps in the replacement text, a demotion marks it. A newest-first lane has no score to lower a demotion with, so
//     the builder drops what is marked.
//
// Decoupled from the store (both reads are injected) so it unit-tests cleanly and runs unchanged on the real one.

import type { PrimerRecent } from './contextPrimer'
import type { CorrectedCandidate, CorrectableEntry } from './memoryCorrection'
import type { ListOptions, MemoryEntry } from './swarmMemory'

export interface PrimerLaneDeps {
  /** The store's listing (memoryList). */
  list: (opts: ListOptions) => Promise<MemoryEntry[]>
  /** The correction overlay on stored rows (memoryCorrectionStore.applyEntryCorrections). */
  correct: <T extends CorrectableEntry>(rows: T[]) => Array<T & Pick<CorrectedCandidate, 'correction'>>
}

/** The lister `buildContextPrimer` takes as `recent`. A failing store rejects: the builder treats a broken lane as no lane. */
export function createPrimerRecent(deps: PrimerLaneDeps): PrimerRecent {
  return async (o) =>
    deps.correct(await deps.list({ limit: o.limit, project: o.project, since: o.since, active: true })).map((e) => ({
      content: e.content,
      source: e.source,
      kind: e.kind,
      score: 0, // not a scored hit: the lane is ordered by time, on purpose
      id: e.id,
      project: e.project,
      projectKey: e.projectKey, // a saved note is shown only to the project it came from, told apart by key (contextPrimer)
      ts: e.ts,
      tags: e.tags, // the primer drops a lesson the substance gate holds back (`candidate`),
      agentId: e.agentId, // ...but only one the lesson writer stored, not a note that merely carries the tag
      memoryType: e.memoryType, // and tells a lesson from a chunk
      correction: e.correction, // and drops what someone has demoted or amended
    }))
}
