// mnemeConsolidateRun.ts
//
// Mneme — the consolidation "sleep" run (Phase 2). Applies mnemeConsolidate's
// plans to the store: merge near-duplicates (keep the best, forget the rest) and
// decay cold, low-value, edge-free episodic noise. Pure/injectable — the candidate
// snapshot and the forget primitive are passed in — so it's unit-testable with
// fakes and the store wiring stays thin. Best-effort: a single forget failure
// never aborts the pass. Summaries (hierarchical) are intentionally left to an
// on-demand/generative pass; the scheduled run is conservative by design.

import { planForget, planMerges, planSummaries, type ConsolEntry } from './mnemeConsolidate'

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

export interface SummarizeDeps {
  candidates: () => ConsolEntry[]
  simOf: (a: ConsolEntry, b: ConsolEntry) => number
  write: (input: { agentId: string; kind: 'note'; content: string; memoryType: 'summary'; importance: number }) => Promise<{ id: string }>
  link: (from: string, to: string, relation: string) => void
  summarize?: (members: ConsolEntry[]) => string
  now: number
}

/** Deterministic, zero-token digest of a cluster (an LLM summarizer can be injected). */
export function defaultSummarize(members: ConsolEntry[]): string {
  const head = `Summary of ${members.length} related memories:`
  const lines = members.slice(0, 6).map((m) => `- ${m.content.replace(/\s+/g, ' ').trim().slice(0, 140)}`)
  return [head, ...lines].join('\n')
}

/**
 * Cluster near-duplicates and write a higher-level `summary` memory that links its
 * members via `part-of`. ADDITIVE — members are kept and connected, never deleted;
 * the summary gives retrieval a cheap, high-level entry point into the cluster.
 * Best-effort: a write/link failure never aborts the pass.
 */
export async function runSummarization(deps: SummarizeDeps, opts?: { minSize?: number }): Promise<{ summarized: number }> {
  const entries = deps.candidates()
  const byId = new Map(entries.map((e) => [e.id, e]))
  const groups = planMerges(entries, deps.simOf).map((g) => ({
    key: g.keep,
    members: [byId.get(g.keep), ...g.drop.map((id) => byId.get(id))].filter((e): e is ConsolEntry => !!e),
  }))
  const specs = planSummaries(groups, { minSize: opts?.minSize })
  const summarize = deps.summarize ?? defaultSummarize

  let summarized = 0
  for (const spec of specs) {
    const members = spec.memberIds.map((id) => byId.get(id)).filter((e): e is ConsolEntry => !!e)
    if (members.length === 0) continue
    try {
      const res = await deps.write({ agentId: 'mneme', kind: 'note', content: summarize(members), memoryType: 'summary', importance: 0.5 })
      if (res && res.id) {
        for (const m of members) {
          try { deps.link(m.id, res.id, 'part-of') } catch { /* best effort */ }
        }
        summarized++
      }
    } catch {
      /* best effort — a summary write failure never aborts consolidation */
    }
  }
  return { summarized }
}
