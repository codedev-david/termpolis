// Maximal Marginal Relevance (MMR) re-ranking — BB2. Picks results that are each
// relevant AND different from what's already picked, so a cluster of near-identical
// hits doesn't crowd out the diverse context an agent actually needs. Pure: the
// pairwise similarity is injected (cosine over packed vectors in the hot path; a
// token-Jaccard fallback when vectors are unavailable).

/**
 * Greedily re-rank `items` (assumed already sorted by relevance, with a numeric
 * `score`) into a diversified top-`k`: at each step pick the candidate maximizing
 * `lambda*score - (1-lambda)*maxSimilarityToAlreadyPicked`. `lambda` in [0,1] trades
 * relevance (1 = pure relevance, the input order) against diversity. `simFn(a,b)`
 * returns a 0..1 similarity. Stable for ties (keeps the higher-relevance item).
 */
export function mmrRerank<T extends { score: number }>(
  items: T[],
  simFn: (a: T, b: T) => number,
  opts: { lambda?: number; k?: number } = {},
): T[] {
  const lambda = opts.lambda ?? 0.7
  const k = Math.min(opts.k ?? items.length, items.length)
  if (k <= 0 || items.length === 0) return []
  const remaining = items.slice()
  const selected: T[] = []
  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0
    let bestVal = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]
      let maxSim = 0
      for (const s of selected) {
        const sim = simFn(cand, s)
        if (sim > maxSim) maxSim = sim
      }
      const mmr = lambda * cand.score - (1 - lambda) * maxSim
      // Strict `>` keeps the earlier (higher-relevance, since input is sorted) item on ties.
      if (mmr > bestVal) { bestVal = mmr; bestIdx = i }
    }
    selected.push(remaining.splice(bestIdx, 1)[0])
  }
  return selected
}
