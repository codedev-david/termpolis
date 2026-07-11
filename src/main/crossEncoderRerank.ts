// crossEncoderRerank.ts — an OPT-IN, model-backed relevance reranker for the top-k recall candidates.
//
// The retrieval first stage is a bge bi-encoder (one dot product per doc) that already scores
// recall@10 0.971 / nDCG@10 0.795 on the committed benchmark. A cross-encoder re-reads (query, doc)
// jointly per candidate — more accurate on hard cases, but ~orders of magnitude slower per pair,
// which cuts against the "fast lookups" guarantee. So this is:
//   - OFF by default (per-search opt-in via memorySearch({ rerank: true }), or setRerankEnabled).
//   - injectable (setRerankScorer) — tests and custom backends plug in a scorer with no model.
//   - best-effort + STRICTLY LOCAL — getRerankScorer() loads a relevance cross-encoder only if one
//     is present locally (remote models disabled). Nothing is bundled by default, so it returns null
//     and the caller falls back to the bi-encoder ranking unchanged.
//
// NOTE: this is deliberately NOT the nli-deberta model in nliContradict.ts — that scores
// entailment/CONTRADICTION between two statements, which is the wrong signal for query→doc relevance.

/** Relevance of a document to a query, higher = more relevant. */
export type RerankScorer = (query: string, doc: string) => Promise<number>

let injected: RerankScorer | null = null
let cached: RerankScorer | null = null
let loadAttempted = false
let enabled = false
let modelPresentForTests = true // test hook: when false, getRerankScorer() short-circuits to null

// A relevance cross-encoder (MS-MARCO MiniLM). Loaded ONLY if present locally; not bundled by default.
const RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2'

/** Enable/disable the reranker globally (default OFF). Per-search `rerank: true` also opts in. */
export function setRerankEnabled(v: boolean): void { enabled = v }
export function rerankEnabled(): boolean { return enabled }

/** Inject a scorer (tests / custom backends). null clears it and resets the lazy loader. */
export function setRerankScorer(s: RerankScorer | null): void {
  injected = s
  if (!s) { cached = null; loadAttempted = false }
}

/** The injected scorer, else a real relevance cross-encoder via the bundled transformers.js runtime
 *  (remote models disabled → strictly local). Best-effort: null when no model is present locally, so
 *  callers fall back to the bi-encoder ranking. */
export async function getRerankScorer(): Promise<RerankScorer | null> {
  if (injected) return injected
  if (!modelPresentForTests) return null
  if (cached) return cached
  if (loadAttempted) return null
  loadAttempted = true
  try {
    const mod = (await import('@huggingface/transformers')) as {
      pipeline: (task: string, model: string) => Promise<unknown>
      env?: { allowRemoteModels?: boolean; allowLocalModels?: boolean }
    }
    if (mod.env) {
      mod.env.allowRemoteModels = false // never hit the network — local model only
      mod.env.allowLocalModels = true
    }
    const clf = (await mod.pipeline('text-classification', RERANK_MODEL)) as (
      input: { text: string; text_pair: string },
    ) => Promise<Array<{ label: string; score: number }> | { label: string; score: number }>
    cached = async (query, doc) => {
      const out = await clf({ text: query, text_pair: doc })
      const o = Array.isArray(out) ? out[0] : out
      return o ? o.score : 0
    }
    return cached
  } catch {
    return null // no local reranker model → bi-encoder ranking stands
  }
}

/** Reorder candidates by cross-encoder relevance to the query, descending. Pure given the scorer;
 *  a per-item scorer failure degrades that item to 0 rather than sinking the whole rerank. */
export async function rerankByScorer<T extends { content: string }>(
  query: string,
  candidates: T[],
  scorer: RerankScorer,
): Promise<T[]> {
  if (candidates.length <= 1) return candidates.slice()
  const scores = await Promise.all(candidates.map((c) => scorer(query, c.content).catch(() => 0)))
  return candidates
    .map((c, i) => ({ c, s: scores[i] }))
    .sort((a, b) => b.s - a.s) // V8 Array.sort is stable → equal scores keep first-stage order
    .map((x) => x.c)
}

/** @internal test-only */
export function _resetRerankForTests(): void {
  injected = null
  cached = null
  loadAttempted = false
  enabled = false
  modelPresentForTests = true
}
/** @internal test-only — simulate a machine with (true) / without (false) a local reranker model. */
export function _setRerankModelPresentForTests(v: boolean): void { modelPresentForTests = v }
