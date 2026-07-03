// recallMetrics.ts
//
// Pure information-retrieval metrics for the recall benchmark that decides whether a
// retrieval option (graph fusion, taste boost, …) is worth enabling for everyone.
// All functions take a ranked list of ids and the set of ids that SHOULD have been
// recalled. No store, no model — just the arithmetic, so it's deterministic and
// unit-testable, and the benchmark's verdict is auditable.

export interface RankedQuery { rankedIds: string[]; relevant: Set<string> }

/** Fraction of the relevant set that appears in the top k (0 if nothing is relevant). */
export function recallAtK(rankedIds: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0
  const top = rankedIds.slice(0, Math.max(0, k))
  let hit = 0
  for (const id of top) if (relevant.has(id)) hit++
  return hit / relevant.size
}

/** Fraction of the top k that is relevant (0 when k <= 0). */
export function precisionAtK(rankedIds: string[], relevant: Set<string>, k: number): number {
  if (k <= 0) return 0
  const top = rankedIds.slice(0, k)
  let hit = 0
  for (const id of top) if (relevant.has(id)) hit++
  return hit / k
}

/** 1 / (rank of the first relevant hit); 0 if none present. */
export function reciprocalRank(rankedIds: string[], relevant: Set<string>): number {
  for (let i = 0; i < rankedIds.length; i++) if (relevant.has(rankedIds[i])) return 1 / (i + 1)
  return 0
}

/** Mean reciprocal rank across queries (0 for no queries). */
export function mrr(queries: RankedQuery[]): number {
  if (queries.length === 0) return 0
  let s = 0
  for (const q of queries) s += reciprocalRank(q.rankedIds, q.relevant)
  return s / queries.length
}

/** Mean recall@k across queries (0 for no queries). */
export function meanRecallAtK(queries: RankedQuery[], k: number): number {
  if (queries.length === 0) return 0
  let s = 0
  for (const q of queries) s += recallAtK(q.rankedIds, q.relevant, k)
  return s / queries.length
}
