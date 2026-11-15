// crossEncoderRerank.ts — a local cross-encoder that re-reads the top recall candidates.
//
// The first stage is a bge bi-encoder: one dot product per memory, fast, and good at finding the
// right neighbourhood, but its scores bunch together (0.944–0.950 for the runners-up against 0.953
// for the right answer on the real brain), so everything after the top hit is close to a coin toss.
// A cross-encoder reads (query, memory) TOGETHER and scores how well that memory answers the query,
// which separates those runners-up. It costs one small forward pass per candidate, so it only ever
// sees the first stage's top eight (RERANK_POOL).
//
// Runtime: the same onnxruntime-web WASM build and the same pure-TS BertTokenizer the embedder uses
// (localEmbedder.ts), so nothing native ships. The model is Xenova/ms-marco-MiniLM-L-6-v2 (q8,
// ~23 MB), bundled under resources/models by scripts/download-embedding-model.sh. With the model
// absent (a dev checkout that never fetched it) getRerankBatchScorer() answers null and recall keeps
// the first-stage order, byte for byte.
//
// Where it runs: the app hands this module a worker spawner (setRerankWorkerSpawner, rerankWorker.ts),
// so the model loads and every forward pass runs on a worker_thread with WASM threads of its own
// (half the machine's cores, at most 8: rerankThreadsFor). The memory host's thread, which serves writes, the primer and every other memory call, only
// posts the texts and waits for the scores. A worker that cannot load the model, dies, or keeps
// timing out turns reranking off for the session: recall goes back to the first-stage order. Without
// a spawner (the worker itself, the unit suite) the model loads in this thread, on one WASM thread.
//
// Seams: setRerankScorer / setRerankBatchScorer inject a scorer with no model (tests, custom
// backends); _setRerankOrtForTests drives the real load path against a fake runtime;
// setRerankWorkerSpawner takes a fake transport in tests.

import * as fs from 'fs'
import * as path from 'path'
import { BertTokenizer } from './bertTokenizer'

/** Relevance of one document to a query, higher = more relevant. */
export type RerankScorer = (query: string, doc: string) => Promise<number>
/** Relevance of each document to a query (same order, same length), higher = more relevant. */
export type RerankBatchScorer = (query: string, docs: string[]) => Promise<number[]>
/** The cross-encoder on another thread (rerankWorker.ts). `score` answers null, and never throws,
 *  when that thread cannot score: no model, a failed load, a crash. */
export interface RerankWorkerTransport {
  score(query: string, docs: string[]): Promise<number[] | null>
  dispose(): void
}

const MODEL_DIR_NAME = 'ms-marco-MiniLM-L-6-v2'
const ONNX_MODEL_FILE = 'model_quantized.onnx'
const ORT_WEB_MODULE: string = 'onnxruntime-web'
/** Token budget per (query, memory) pair: the query plus the opening of the memory. Shorter budgets
 *  are faster but read too little of a memory to judge it: at 192 tokens the gain over the first stage
 *  shrinks (MRR@10 0.844 against 0.847 at 256, pool 10), and at 128 or fewer it never gained more
 *  than 0.015 in any pool or blend. Scoring windows over the whole memory and keeping the best was
 *  worse than the opening alone. */
export const RERANK_MAX_TOKENS = 256
// Characters are cut BEFORE tokenizing: a 40 KB transcript chunk would otherwise be fully
// WordPiece-split only to be truncated to 256 tokens. ~6 chars/token leaves ample headroom.
const DOC_CHAR_CAP = RERANK_MAX_TOKENS * 6
const QUERY_CHAR_CAP = 400
/** How many first-stage hits the cross-encoder re-reads per search: the best by score among the hits
 *  that pass the 0.25 relevance gate (memorySearch), whatever `limit` the caller asks for. Recall
 *  benchmark on a real brain (2026-11-14, 495 probes, 256 tokens, alpha 0.7), MRR@10 against the first
 *  stage's 0.818: 0.837 at 5, 0.842 at 6, 0.846 at 8, 0.847 at 10, 0.853 at 20, 0.858 at 30. The time
 *  grows with the pool (p50 per search on 8 WASM threads: 239 ms at 6, about 285 at 8, 383 at 10, 572
 *  at 15, 786 at 20). Eight is the smallest pool that keeps most of the gain; 30 (1.62.0) took several
 *  seconds per search on one thread. */
export const RERANK_POOL = 8
/** The cross-encoder's weight in the blend (0 = first stage only, 1 = cross-encoder only). 0.7 was the
 *  best of 0 / 0.3 / 0.5 / 0.7 / 0.85 / 1 at pool 30 and is within 0.002 MRR@10 of the best at every
 *  pool from 8 to 30, so it was not re-tuned for the smaller pool. Recall benchmark (2026-11-14, 495
 *  probes, pool 8, 256 tokens): MRR@10 0.818 → 0.846 and R@1 0.766 → 0.804; on 40 hand-written queries
 *  MRR@10 0.459 → 0.511. */
export const RERANK_ALPHA = 0.7
/** Pairs per forward pass. At or above RERANK_POOL, so a search is one forward pass; the cap bounds the
 *  padded tensor for a caller that scores a longer list. */
const BATCH = 16
/** Model load through the worker: spawn, WASM compile, session, contract check. About a second on a
 *  quiet machine; the leash is for a machine that is busy at start-up. */
const WORKER_LOAD_TIMEOUT_MS = 60_000
/** One search's rerank through the worker. Well past the slowest search measured (about 1.3 s for eight
 *  pairs on one WASM thread); a search that hits it keeps the first-stage order. */
const WORKER_CALL_TIMEOUT_MS = 3_000
/** Timeouts in a row before the worker counts as stuck and reranking is turned off for the session. */
const WORKER_MAX_TIMEOUTS = 3

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
let enabled = false // off until told: the app turns it on from MemorySettings.rerankSearch (ON by default)
let injectedOrt: OrtModule | null = null
let assetDirResolver: (() => string | undefined) | null = null
let workerSpawner: (() => RerankWorkerTransport | null) | null = null
let workerTransport: RerankWorkerTransport | null = null
let ortThreads = 1

/** Turn the reranker on or off for every search. OFF until something says otherwise, so no suite and
 *  no process that was never told pays for a model it did not ask for. The app sets it from the
 *  "Re-read search results" setting (MemorySettings.rerankSearch, ON unless the user turned it off).
 *  A search can still pass `rerank: true` / `rerank: false` to override. */
export function setRerankEnabled(v: boolean): void { enabled = v }
export function rerankEnabled(): boolean { return enabled }

/** Run the model on another thread (the app passes rerankWorker.ts's createRerankWorkerTransport).
 *  With a spawner set the worker is the only backend: a worker that cannot score turns reranking off
 *  rather than loading the model on this thread. null goes back to the in-thread model. */
export function setRerankWorkerSpawner(fn: (() => RerankWorkerTransport | null) | null): void {
  dropWorker()
  workerSpawner = fn
  cached = null
  loadPromise = null
  loadFailed = false
}

/** WASM threads for an in-thread load. Only the worker raises it: every ORT instance in a process
 *  shares one thread setting, and the memory host's own instance is the embedder's, which stays on 1. */
export function setRerankThreads(n: number): void {
  ortThreads = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
}

/** The worker's WASM thread count for a machine with `cores` logical cores: half of them, at most 8,
 *  at least 1. Half leaves the rest of the machine to the user and the agents. Measured on a 22-core
 *  machine, ten pairs at 256 tokens: p50 588 ms on 4 threads, 437 on 6, 383 on 8, so the gain is
 *  still real at 8 but shrinking. The threads wait, not spin, between searches. */
export function rerankThreadsFor(cores: number): number {
  return Math.max(1, Math.min(8, Math.floor((Number.isFinite(cores) ? cores : 1) / 2)))
}

/** Start loading the model now (on the worker, when one is wired) so the first search does not wait
 *  for it. Safe to call repeatedly: the load happens once. */
export function prewarmRerank(): void {
  void getRerankBatchScorer()
}

function dropWorker(): void {
  try { workerTransport?.dispose() } catch { /* already gone */ }
  workerTransport = null
}

type TimedOut = { timedOut: true }
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | TimedOut> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<TimedOut>((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms) }),
  ]).finally(() => clearTimeout(timer))
}
const isTimedOut = (x: unknown): x is TimedOut => typeof x === 'object' && x !== null && (x as TimedOut).timedOut === true

async function loadViaWorker(spawn: () => RerankWorkerTransport | null): Promise<RerankBatchScorer | null> {
  try {
    const t = spawn()
    if (!t) { loadFailed = true; return null }
    workerTransport = t
    // The worker loads the model on its first message, so the contract check is also the load.
    const probe = await withTimeout(t.score('contract check', ['contract check passage']).catch(() => null), WORKER_LOAD_TIMEOUT_MS)
    if (isTimedOut(probe) || !probe || probe.length !== 1 || !Number.isFinite(probe[0])) {
      dropWorker()
      loadFailed = true
      return null
    }
    let timeouts = 0
    const disable = (): void => {
      if (cached === fn) { cached = null; loadFailed = true }
      if (workerTransport === t) dropWorker()
    }
    const fn: RerankBatchScorer = async (query, docs) => {
      const out = await withTimeout(t.score(query, docs).catch(() => null), WORKER_CALL_TIMEOUT_MS)
      if (isTimedOut(out)) {
        // Busy is not broken: this search keeps the first-stage order. Several in a row is a stuck worker.
        if (++timeouts >= WORKER_MAX_TIMEOUTS) disable()
        throw new Error('rerank worker timed out')
      }
      timeouts = 0
      if (!out) { disable(); throw new Error('rerank worker could not score') }
      return out
    }
    cached = fn
    return fn
  } catch {
    dropWorker() // the spawner threw
    loadFailed = true
    return null
  } finally {
    loadPromise = null
  }
}

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
    if (ort.env?.wasm) ort.env.wasm.numThreads = ortThreads // 1 unless this is the rerank worker (setRerankThreads)
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
  if (!loadPromise) loadPromise = workerSpawner ? loadViaWorker(workerSpawner) : loadModel()
  return loadPromise
}

/** getRerankBatchScorer for a search: a model that is still loading (up to WORKER_LOAD_TIMEOUT_MS on a
 *  busy start-up) is waited for at most `ms`, then this search keeps the first-stage order and the load
 *  carries on for the next one. A search never waits on the load longer than on a rerank itself. */
export async function getRerankBatchScorerWithin(ms = WORKER_CALL_TIMEOUT_MS): Promise<RerankBatchScorer | null> {
  if (injected) return injected
  if (cached) return cached
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
    ;(timer as { unref?: () => void }).unref?.()
  })
  try {
    return await Promise.race([getRerankBatchScorer(), late])
  } finally {
    clearTimeout(timer)
  }
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
  dropWorker()
  workerSpawner = null
  ortThreads = 1
}
/** @internal test-only — simulate a machine without (false) the bundled model; true restores the
 *  normal lookup. */
export function _setRerankModelPresentForTests(v: boolean): void {
  assetDirResolver = v ? null : () => undefined
  cached = null
  loadPromise = null
  loadFailed = false
}
