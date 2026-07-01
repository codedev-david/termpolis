// mnemeConsolidateRun.ts
//
// Mneme — the consolidation "sleep" run (Phase 2). Applies mnemeConsolidate's
// plans to the store: merge near-duplicates (keep the best, forget the rest) and
// decay cold, low-value, edge-free episodic noise. Pure/injectable — the candidate
// snapshot and the forget primitive are passed in — so it's unit-testable with
// fakes and the store wiring stays thin. Best-effort: a single forget failure
// never aborts the pass. Summaries (hierarchical) are intentionally left to an
// on-demand/generative pass; the scheduled run is conservative by design.

import { planForget, planMerges, type ConsolEntry } from './mnemeConsolidate'

export interface ConsolidateDeps {
  candidates: () => ConsolEntry[]
  simOf: (a: ConsolEntry, b: ConsolEntry) => number
  forget: (id: string) => void
  now: number
}

export interface ConsolidateResult {
  mergedDuplicates: number
  decayedCold: number
}

export function runConsolidation(deps: ConsolidateDeps, opts?: { forgetCap?: number }): ConsolidateResult {
  const entries = deps.candidates()
  const done = new Set<string>()

  // 1. Merge near-duplicates: keep the best of each group, forget the rest.
  let mergedDuplicates = 0
  for (const group of planMerges(entries, deps.simOf)) {
    for (const id of group.drop) {
      if (done.has(id)) continue
      try {
        deps.forget(id)
        done.add(id)
        mergedDuplicates++
      } catch {
        /* best effort — keep consolidating */
      }
    }
  }

  // 2. Decay: forget cold, low-value, edge-free episodic entries.
  let decayedCold = 0
  for (const id of planForget(entries, deps.now, { cap: opts?.forgetCap })) {
    if (done.has(id)) continue
    try {
      deps.forget(id)
      done.add(id)
      decayedCold++
    } catch {
      /* best effort */
    }
  }

  return { mergedDuplicates, decayedCold }
}
