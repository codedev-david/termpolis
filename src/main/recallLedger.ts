// recallLedger.ts
//
// The join between "what the brain told an agent" and "how the work turned out".
//
// Termpolis has had both halves of outcome-grounded learning for several releases and they were
// never connected:
//
//   * outcome detection is live — a red test run, a landed commit and a session's end all reach
//     recordWorkOutcome, which folds the result into the per-domain competence record;
//   * memory demotion is live — memoryFeedback moves a memory's usage counter, learnedUtility
//     reads it, and recall suppresses anything at -3.
//
// Nothing joined them, because nothing remembered WHICH memories were recalled into the work that
// then failed. So feedback was entirely manual: an agent had to notice a memory was wrong and call
// memory_feedback on it, which in practice never happens. The brain could learn from being TOLD it
// was wrong, but never from being wrong.
//
// This ledger closes that loop. Deliberately session-scoped and in-memory: an outcome lands within
// minutes of the recall that informed it, and a durable store would invite attributing today's test
// failure to a recall from last Tuesday. Losing the ledger on quit costs one attribution, which is
// the right trade against mis-attributing an old one.

interface Note {
  ids: string[]
  ts: number
}

/** How long a recall can plausibly have informed the work that follows it. Matches the agent
 *  tool-pair window in learningSignals, for the same reason: past this, the association is a
 *  coincidence. */
export const RECALL_WINDOW_MS = 30 * 60_000
/** A primer injects tens of memories at launch. One red test run must not be evidence against
 *  every one of them — that is a blast radius, not a signal. */
export const MAX_ATTRIBUTED = 20
/** Per-project note cap, and total project cap. Both exist only to bound a long session. */
const MAX_NOTES_PER_PROJECT = 100
const MAX_PROJECTS = 200

const byProject = new Map<string, Note[]>()

/** Record that `ids` were served into `project`. Cheap enough for the recall hot path: one array
 *  push, no allocation per id. */
export function noteRecall(project: string, ids: string[], now: number): void {
  if (!project || !Array.isArray(ids) || ids.length === 0) return
  const clean = ids.filter((id) => typeof id === 'string' && id.length > 0)
  if (clean.length === 0) return

  // Re-insert so Map iteration order is least-recently-used first, which is the order eviction
  // wants.
  const notes = byProject.get(project) ?? []
  byProject.delete(project)
  notes.push({ ids: clean, ts: now })
  if (notes.length > MAX_NOTES_PER_PROJECT) notes.splice(0, notes.length - MAX_NOTES_PER_PROJECT)
  byProject.set(project, notes)

  while (byProject.size > MAX_PROJECTS) {
    const oldest = byProject.keys().next()
    if (oldest.done) break
    byProject.delete(oldest.value)
  }
}

/**
 * The memories an outcome at `now` should be attributed to — and CLEARS them, so one recall is
 * charged at most once however many outcomes follow it. Ten green test runs in a row must not bank
 * ten upvotes for a single recall; that would let one lucky memory drown out everything the
 * ranking knows.
 *
 * Only recalls that came BEFORE the outcome and inside the window count. When the cap bites, the
 * most recent recalls win: they are the ones most likely to have actually informed the work.
 */
export function claimRecalled(project: string, now: number): string[] {
  const notes = byProject.get(project)
  if (!notes || notes.length === 0) return []

  const keep: Note[] = []
  const claimed: string[] = []
  const seen = new Set<string>()

  // Walk newest-first so the cap keeps the freshest evidence.
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i]
    if (n.ts > now) { keep.unshift(n); continue }        // not yet — an outcome cannot be caused by a later recall
    if (now - n.ts > RECALL_WINDOW_MS) continue           // too old to have informed this outcome; drop it
    for (const id of n.ids) {
      if (seen.has(id) || claimed.length >= MAX_ATTRIBUTED) continue
      seen.add(id)
      claimed.push(id)
    }
  }

  if (keep.length > 0) byProject.set(project, keep)
  else byProject.delete(project)
  return claimed
}

/** Test seam, and the reset an import/clear of the brain needs. */
export function resetRecallLedger(): void {
  byProject.clear()
}
