// crossEncoderRerank.ts — a local cross-encoder that re-reads the top recall candidates.
//
// The first stage is a bge bi-encoder: one dot product per memory, fast, and good at finding the
// right neighbourhood, but its scores bunch together (0.944–0.950 for the runners-up against 0.953
// for the right answer on the real brain), so everything after the top hit is close to a coin toss.
// A cross-encoder reads (query, memory) TOGETHER and scores how well that memory answers the query,
// which separates those runners-up. It costs one small forward pass per candidate, so it only ever
// sees the first stage's top few dozen.
//
// Runtime: the same onnxruntime-web WASM build and the same pure-TS BertTokenizer the embedder uses
// (localEmbedder.ts), so nothing native ships. The model is Xenova/ms-marco-MiniLM-L-6-v2 (q8,
// ~23 MB), bundled under resources/models by scripts/download-embedding-model.sh. With the model
// absent (a dev checkout that never fetched it) getRerankBatchScorer() answers null and recall keeps
// the first-stage order, byte for byte.
//
// Seams: setRerankScorer / setRerankBatchScorer inject a scorer with no model (tests, custom
// backends); _setRerankOrtForTests drives the real load path against a fake runtime.

import * as fs from 'fs'
import * as path from 'path'
import { BertTokenizer } from './bertTokenizer'

/** Relevance of one document to a query, higher = more relevant. */
export type RerankScorer = (query: string, doc: string) => Promise<number>
/** Relevance of each document to a query (same order, same length), higher = more relevant. */
export type RerankBatchScorer = (query: string, docs: string[]) => Promise<number[]>

const MODEL_DIR_NAME = 'ms-marco-MiniLM-L-6-v2'
const ONNX_MODEL_FILE = 'model_quantized.onnx'
const ORT_WEB_MODULE: string = 'onnxruntime-web'
/** Token budget per (query, memory) pair. ms-marco was trained on short passages; 256 keeps a batch
 *  of 30 well under a second on one WASM thread while still reading the opening of a long memory. */
export const RERANK_MAX_TOKENS = 256
// Characters are cut BEFORE tokenizing: a 40 KB transcript chunk would otherwise be fully
// WordPiece-split only to be truncated to 256 tokens. ~6 chars/token leaves ample headroom.
const DOC_CHAR_CAP = RERANK_MAX_TOKENS * 6
const QUERY_CHAR_CAP = 400
/** How many first-stage hits the cross-encoder re-reads per search (memorySearch widens to `limit`
 *  when a caller asks for more). Chosen on the recall benchmark: see RERANK_ALPHA. */
export const RERANK_POOL = 30
/** The cross-encoder's weight in the blend (0 = first stage only, 1 = cross-encoder only).
 *  Recall benchmark on a real brain (2026-11-14, 495 probes, pool 30): MRR@10 0.818 → 0.859 and R@1
 *  0.766 → 0.810 at 0.7, the best of 0 / 0.3 / 0.5 / 0.7 / 0.85 / 1; on 40 hand-written queries MRR@10
 *  0.459 → 0.528. The cost kept it off by default: p50 4.1 s / p95 8.7 s per search on one WASM
 *  thread (measured partly under a full test run), too slow to put in front of every recall. */
export const RERANK_ALPHA = 0.7
/** Pairs per forward pass. Bounds both the padded tensor and one run's time on the host thread. */
const BATCH = 16

interface OrtTensorData { data: Float32Array; dims: number[] }
interface OrtSession {
  inputNames: string[]
  outputNames: string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorData>>
}
interface OrtModule {
  env?: { wasm?: { numThreads?: number } }
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown
  InferenceSession: { create(model: string): Promise<OrtSession> }
}

let injected: RerankBatchScorer | null = null
let cached: RerankBatchScorer | null = null
let loadPromise: Promise<RerankBatchScorer | null> | null = null
let loadFailed = false
let enabled = false // off until the recall benchmark shows it helps (no unbenchmarked mechanism ships on)
let injectedOrt: OrtModule | null = null
let assetDirResolver: (() => string | undefined) | null = null

/** Turn the reranker on or off for every search. Default OFF, and nothing in the app turns it on: it
 *  ships enabled only once the recall benchmark shows it helps. A search can still pass `rerank: true` /
 *  `rerank: false` to override. */
export function setRerankEnabled(v: boolean): void { enabled = v }
export function rerankEnabled(): boolean { return enabled }

/** Wrap a per-pair scorer as a batch scorer. A pair that rejects scores 0 rather than sinking the batch. */
function batchOf(s: RerankScorer): RerankBatchScorer {
  return (q, docs) => Promise.all(docs.map((d) => s(q, d).catch(() => 0)))
}

/** Inject a per-pair scorer (tests / custom backends). null clears it and resets the lazy loader. */
export function setRerankScorer(s: RerankScorer | null): void {
  setRerankBatchScorer(s ? batchOf(s) : null)
}

/** Inject a batch scorer. null clears it and resets the lazy loader. */
export function setRerankBatchScorer(s: RerankBatchScorer | null): void {
  injected = s
  if (!s) { cached = null; loadPromise = null; loadFailed = false }
}

// The bundled model (packaged), else the repo copy the download script writes in dev and CI.
function resolveAssetDir(): string | undefined {
  const candidates: string[] = []
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'models', MODEL_DIR_NAME))
  candidates.push(path.join(process.cwd(), 'resources', 'models', MODEL_DIR_NAME))
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'tokenizer.json'))) return c } catch { /* ignore */ }
  }
  return undefined
}

function resolveOnnxModel(dir: string): string | undefined {
  for (const c of [path.join(dir, ONNX_MODEL_FILE), path.join(dir, 'onnx', ONNX_MODEL_FILE)]) {
    try { if (fs.existsSync(c)) return c } catch { /* ignore */ }
  }
  return undefined
}

async function loadModel(): Promise<RerankBatchScorer | null> {
  try {
    const dir = (assetDirResolver ?? resolveAssetDir)()
    const modelPath = dir ? resolveOnnxModel(dir) : undefined
    if (!dir || !modelPath) { loadFailed = true; return null }
    const tokJson = JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8'))
    const tokCfg = JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer_config.json'), 'utf8'))
    const tokenizer = BertTokenizer.fromJSON(tokJson, tokCfg)
    const ort: OrtModule = injectedOrt ?? (await import(/* @vite-ignore */ ORT_WEB_MODULE))
    if (ort.env?.wasm) ort.env.wasm.numThreads = 1 // never spawn ORT worker threads from the host
    const session = await ort.InferenceSession.create(modelPath)
    const wantTypeIds = session.inputNames.includes('token_type_ids')
    const toTensor = (rows: number[][], B: number, S: number): unknown =>
      new ort.Tensor('int64', BigInt64Array.from(rows.flat(), (x) => BigInt(x)), [B, S])

    const scoreChunk = async (query: string, docs: string[]): Promise<number[]> => {
      const enc = tokenizer.encodePairBatch(query, docs, RERANK_MAX_TOKENS)
      const B = enc.inputIds.length
      const S = enc.inputIds[0].length
      const feeds: Record<string, unknown> = {
        input_ids: toTensor(enc.inputIds, B, S),
        attention_mask: toTensor(enc.attentionMask, B, S),
      }
      if (wantTypeIds) feeds.token_type_ids = toTensor(enc.tokenTypeIds, B, S)
      const out = await session.run(feeds)
      const logits = out.logits ?? out[session.outputNames[0]]
      // [B, 1] relevance logits (ms-marco has a single output label). Read row-major so a model that
      // emits [B, k] still yields one number per row: its first column.
      const width = logits.dims[logits.dims.length - 1] || 1
      const scores: number[] = []
      for (let i = 0; i < B; i++) scores.push(logits.data[i * width])
      return scores
    }
    const fn: RerankBatchScorer = async (query, docs) => {
      const q = query.slice(0, QUERY_CHAR_CAP)
      const out: number[] = []
      for (let i = 0; i < docs.length; i += BATCH) {
        out.push(...(await scoreChunk(q, docs.slice(i, i + BATCH).map((d) => d.slice(0, DOC_CHAR_CAP)))))
      }
      return out
    }
    // Contract check: one real pair must give one finite number. A wrong file under the model's name
    // (an embedder, say, whose output is a hidden-state tensor) fails here instead of reordering recall
    // by garbage.
    const probe = await fn('contract check', ['contract check passage'])
    if (probe.length !== 1 || !Number.isFinite(probe[0])) { loadFailed = true; return null }
    cached = fn
    return fn
  } catch {
    loadFailed = true // no runtime / unreadable model → recall keeps the first-stage order
    return null
  } finally {
    loadPromise = null
  }
}

/** The injected scorer, else the bundled cross-encoder (loaded once, lazily). null when neither is
 *  available, so callers keep the first-stage ranking. */
export async function getRerankBatchScorer(): Promise<RerankBatchScorer | null> {
  if (injected) return injected
  if (cached) return cached
  if (loadFailed) return null
  if (!loadPromise) loadPromise = loadModel()
  return loadPromise
}

/** Logistic squash of a relevance logit to 0..1. */
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/**
 * Blend cross-encoder relevance with the first-stage score and return candidates best-first with
 * that blended `score`. Both signals are min-max normalised over THIS candidate pool before mixing,
 * because their scales are unrelated (a logit vs a fused cosine). `alpha` is the cross-encoder's
 * weight: 1 trusts it alone, 0 keeps the first-stage order. A scorer that throws, or answers with
 * the wrong length or a non-finite score, leaves the first-stage order untouched.
 */
export async function blendRerank<T extends { content: string; score: number }>(
  query: string,
  candidates: T[],
  scorer: RerankBatchScorer,
  alpha: number,
): Promise<Array<T & { rerankScore: number; blended: number }>> {
  const keep = (): Array<T & { rerankScore: number; blended: number }> =>
    candidates.map((c) => ({ ...c, rerankScore: 0, blended: c.score }))
  if (candidates.length <= 1) return keep()
  let ce: number[]
  try { ce = await scorer(query, candidates.map((c) => c.content)) } catch { return keep() }
  if (ce.length !== candidates.length || ce.some((x) => !Number.isFinite(x))) return keep()
  const norm = (xs: number[]): number[] => {
    let lo = Infinity, hi = -Infinity
    for (const x of xs) { if (x < lo) lo = x; if (x > hi) hi = x }
    const span = hi - lo
    return xs.map((x) => (span > 0 ? (x - lo) / span : 0.5))
  }
  const nCe = norm(ce)
  const nFs = norm(candidates.map((c) => c.score))
  return candidates
    .map((c, i) => ({ ...c, rerankScore: ce[i], blended: alpha * nCe[i] + (1 - alpha) * nFs[i] }))
    .sort((a, b) => b.blended - a.blended) // stable: ties keep the first-stage order
}

/** @internal test-only — drive the real load path with a fake onnxruntime-web and asset dir. */
export function _setRerankOrtForTests(ort: unknown, assetDirFn?: (() => string | undefined) | null): void {
  injectedOrt = (ort as OrtModule | null) ?? null
  assetDirResolver = assetDirFn ?? null
  cached = null
  loadPromise = null
  loadFailed = false
}

/** @internal test-only */
export function _resetRerankForTests(): void {
  injected = null
  cached = null
  loadPromise = null
  loadFailed = false
  enabled = false
  injectedOrt = null
  assetDirResolver = null
}
/** @internal test-only — simulate a machine without (false) the bundled model; true restores the
 *  normal lookup. */
export function _setRerankModelPresentForTests(v: boolean): void {
  assetDirResolver = v ? null : () => undefined
  cached = null
  loadPromise = null
  loadFailed = false
}
