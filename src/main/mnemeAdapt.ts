// mnemeAdapt.ts
//
// Training-free embedding adaptation (frontier lens). The adversarial review found
// full corpus-whitening's payoff uncertain for an already contrastively-tuned model
// like bge-small and its "transform only the query" shortcut mathematically broken —
// so this ships the review's ENDORSED, CRDT-clean form instead: a POSITIVE-ONLY
// "interest centroid" of the memories the fleet has reinforced, used to gently and
// capped-ly nudge recall toward the user's typical content.
//
// PURE + injectable — no store, no clock, no model. The boost is multiplicative
// around relevance and capped, so it can lift a memory's rank but can NEVER resurrect
// a zero-relevance hit past the gate (mirrors mnemeRetrieval.learnedUtility). Wired
// DEFAULT-OFF in the store; enabling is gated on a measured recall lift (per roadmap).

/** Cosine similarity of two vectors (does not assume unit length). 0 if either is zero. */
export function cosineSim(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d > 0 ? dot / d : 0
}

/** L2-normalized mean of the reinforced vectors — the fleet's "taste". Empty rows are
 *  ignored; returns null when there is nothing (or everything cancels to zero). */
export function interestCentroid(vecs: number[][]): number[] | null {
  const good = vecs.filter((v) => Array.isArray(v) && v.length > 0)
  if (good.length === 0) return null
  const dim = good[0].length
  const mean = new Array(dim).fill(0)
  for (const v of good) for (let i = 0; i < dim; i++) mean[i] += v[i] || 0
  let norm = 0
  for (let i = 0; i < dim; i++) { mean[i] /= good.length; norm += mean[i] * mean[i] }
  norm = Math.sqrt(norm)
  if (norm === 0) return null
  for (let i = 0; i < dim; i++) mean[i] /= norm
  return mean
}

export interface TasteOpts { weight?: number; cap?: number }

/** Capped, positive-only, multiplicative boost toward the interest centroid:
 *  `base * (1 + min(cap, weight*max(0, cosine)))`. Monotonic in cosine; a base of 0
 *  stays 0 (the relevance-gate contract); off-taste (cosine<=0) hits are untouched. */
export function tasteBoost(base: number, cosine: number, opts: TasteOpts = {}): number {
  const weight = opts.weight ?? 0.15
  const cap = opts.cap ?? 0.1
  const nudge = Math.min(cap, weight * Math.max(0, cosine))
  return base * (1 + nudge)
}
