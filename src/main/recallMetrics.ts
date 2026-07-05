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

/** Discounted cumulative gain at k (binary relevance). Rewards relevant hits, discounted by
 *  log2 of their rank — so ranking a relevant memory 1st beats ranking it 10th. */
export function dcgAtK(rankedIds: string[], relevant: Set<string>, k: number): number {
  const top = rankedIds.slice(0, Math.max(0, k))
  let dcg = 0
  for (let i = 0; i < top.length; i++) if (relevant.has(top[i])) dcg += 1 / Math.log2(i + 2)
  return dcg
}

/** Normalized DCG at k — dcg / ideal-dcg — so 1.0 means the relevant items are ranked as high
 *  as possible. 0 when nothing is relevant. The order-sensitive companion to recall@k. */
export function ndcgAtK(rankedIds: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0
  const dcg = dcgAtK(rankedIds, relevant, k)
  const ideal = Math.min(relevant.size, Math.max(0, k))
  let idcg = 0
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2)
  return idcg === 0 ? 0 : dcg / idcg
}

/** Mean nDCG@k across queries (0 for no queries). */
export function meanNdcgAtK(queries: RankedQuery[], k: number): number {
  if (queries.length === 0) return 0
  let s = 0
  for (const q of queries) s += ndcgAtK(q.rankedIds, q.relevant, k)
  return s / queries.length
}

export interface EvalSummary {
  n: number
  mrr: number
  recallAtK: Record<number, number>
  ndcgAtK: Record<number, number>
}

/** Full retrieval-quality summary across queries for the given cutoffs — the number the
 *  recall benchmark compares before/after a change to decide if it's net-positive. */
export function evaluate(queries: RankedQuery[], ks: number[] = [1, 5, 10]): EvalSummary {
  const recall: Record<number, number> = {}
  const ndcg: Record<number, number> = {}
  for (const k of ks) {
    recall[k] = meanRecallAtK(queries, k)
    ndcg[k] = meanNdcgAtK(queries, k)
  }
  return { n: queries.length, mrr: mrr(queries), recallAtK: recall, ndcgAtK: ndcg }
}

export interface TaggedQuery extends RankedQuery {
  scenario: string
}

/** Per-scenario slice summaries. A single averaged number hides regressions — a change that
 *  lifts cross-project recall but wrecks superseded-filtering nets out flat. Slicing surfaces it. */
export function evaluateSlices(queries: TaggedQuery[], ks: number[] = [1, 5, 10]): Record<string, EvalSummary> {
  const bySlice = new Map<string, RankedQuery[]>()
  for (const q of queries) {
    const list = bySlice.get(q.scenario) ?? []
    list.push({ rankedIds: q.rankedIds, relevant: q.relevant })
    bySlice.set(q.scenario, list)
  }
  const out: Record<string, EvalSummary> = {}
  for (const [scenario, qs] of bySlice) out[scenario] = evaluate(qs, ks)
  return out
}
