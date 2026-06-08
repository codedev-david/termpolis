// Local, offline text embeddings for the memory / RAG layer.
//
// Replaces the old Ollama (`nomic-embed-text` over HTTP :11434) dependency
// with an in-process model so semantic memory "just works" with no server and
// — critically — NO native binary to ship.
//
// Stack (all native-free, empirically validated):
//   • Tokenizer: BertTokenizer (pure TS, byte-exact vs transformers.js)
//   • Inference: onnxruntime-web (WASM) running bge-small-en-v1.5 q8 (384-dim,
//     MIT-licensed). We ship `.wasm` DATA + the ONNX model, never a native
//     `.node`/`.dll` — so the installer stays ABI-agnostic across Electron
//     versions and adds zero new unsigned-binary surface for Windows Defender's
//     cloud-ML to flag (the whole reason we avoided onnxruntime-node).
//
// transformers.js, by contrast, hard-routes to the native onnxruntime-node in
// Node, so it is intentionally a DEV-only dependency (model prep + tokenizer
// validation), never shipped.
//
// Everything is guarded: if the model fails to load we degrade to "no
// embeddings" (keyword search still works) instead of crashing the app.

import * as fs from 'fs'
import * as path from 'path'
import { BertTokenizer } from './bertTokenizer'

export const EMBED_DIM = 384

// bge retrieval models expect this instruction prefix on QUERY text only —
// stored passages are embedded verbatim. Mixing it up tanks recall.
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

const MODEL_DIR_NAME = 'bge-small-en-v1.5'
const ONNX_MODEL_FILE = 'model_quantized.onnx'
// Non-literal so bundlers/test runners don't statically resolve this
// runtime-only dependency. Resolved from node_modules at runtime.
const ORT_WEB_MODULE: string = 'onnxruntime-web'

// A backend turns prepared texts into row vectors. Swappable so the heavy
// inference path can be replaced with a worker or injected in tests.
export type EmbedBackend = (texts: string[]) => Promise<number[][]>

export interface EmbedOptions {
  /** Prefix with the bge query instruction. True for search queries, false for stored passages. */
  isQuery?: boolean
}

// Minimal shape of the onnxruntime-web runtime API we use (runtime-only dep,
// no imported types).
interface OrtTensorData {
  data: Float32Array
  dims: number[]
}
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

let injectedBackend: EmbedBackend | null = null
let backend: EmbedBackend | null = null
let loadPromise: Promise<EmbedBackend | null> | null = null
let loadFailed = false
// Test seams for exercising the real model-load path without a model/ort.
let injectedOrt: OrtModule | null = null
let assetDirResolver: (() => string | undefined) | null = null

/** Inject a deterministic backend (tests) — bypasses the real model load.
 *  Resolved lazily via getBackend on first use. */
export function _setBackendForTests(fn: EmbedBackend | null): void {
  injectedBackend = fn
  backend = null
  loadPromise = null
  loadFailed = false
}

/** Inject a fake onnxruntime-web module + asset-dir resolver so the real load
 *  path can be exercised in CI without a real model or native binary. */
export function _setOrtForTests(ort: unknown, assetDirFn?: (() => string | undefined) | null): void {
  injectedOrt = (ort as OrtModule | null) ?? null
  assetDirResolver = assetDirFn ?? null
}

/** Reset all module state between tests. */
export function _resetEmbedderForTests(): void {
  injectedBackend = null
  backend = null
  loadPromise = null
  loadFailed = false
  injectedOrt = null
  assetDirResolver = null
}

/** True once a backend has been loaded/injected and is usable. */
export function isEmbedderReady(): boolean {
  return backend !== null
}

async function getBackend(): Promise<EmbedBackend | null> {
  if (backend) return backend
  if (injectedBackend) {
    backend = injectedBackend
    return backend
  }
  if (loadFailed) return null
  if (!loadPromise) loadPromise = loadDefaultBackend()
  return loadPromise
}

function markFailed(): null {
  loadFailed = true
  loadPromise = null
  return null
}

// Locate the bundled model assets (packaged), falling back to the
// transformers.js download cache in dev. Returns a dir containing
// tokenizer.json or undefined.
function resolveAssetDir(): string | undefined {
  const candidates: string[] = []
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'models', MODEL_DIR_NAME))
  // The repo-relative bundling source (scripts/download-embedding-model.sh
  // target). Lets the REAL backend load without a packaged app — in dev and,
  // crucially, in CI's package-verify job where the model is downloaded here.
  candidates.push(path.join(process.cwd(), 'resources', 'models', MODEL_DIR_NAME))
  // transformers.js dev download cache (present on machines that ran model prep).
  candidates.push(
    path.join(process.cwd(), 'node_modules', '@huggingface', 'transformers', '.cache', 'Xenova', MODEL_DIR_NAME),
  )
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'tokenizer.json'))) return c
    } catch {
      /* ignore */
    }
  }
  return undefined
}

function resolveOnnxModel(dir: string): string | undefined {
  for (const c of [path.join(dir, ONNX_MODEL_FILE), path.join(dir, 'onnx', ONNX_MODEL_FILE)]) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return undefined
}

function meanPoolNormalize(
  hidden: Float32Array,
  mask: number[][],
  B: number,
  S: number,
  H: number,
): number[][] {
  const out: number[][] = []
  for (let b = 0; b < B; b++) {
    const v = new Float64Array(H)
    let cnt = 0
    for (let s = 0; s < S; s++) {
      if (!mask[b][s]) continue
      cnt++
      const base = (b * S + s) * H
      for (let h = 0; h < H; h++) v[h] += hidden[base + h]
    }
    let norm = 0
    for (let h = 0; h < H; h++) {
      v[h] /= cnt || 1
      norm += v[h] * v[h]
    }
    norm = Math.sqrt(norm) || 1
    const row = new Array<number>(H)
    for (let h = 0; h < H; h++) row[h] = v[h] / norm
    out.push(row)
  }
  return out
}

async function loadDefaultBackend(): Promise<EmbedBackend | null> {
  try {
    const dir = (assetDirResolver ?? resolveAssetDir)()
    if (!dir) return markFailed()
    const modelPath = resolveOnnxModel(dir)
    if (!modelPath) return markFailed()

    const tokJson = JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8'))
    const tokCfg = JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer_config.json'), 'utf8'))
    const tokenizer = BertTokenizer.fromJSON(tokJson, tokCfg)

    const ort: OrtModule = injectedOrt ?? (await import(/* @vite-ignore */ ORT_WEB_MODULE))
    if (ort.env?.wasm) ort.env.wasm.numThreads = 1 // no extra worker spawn from main
    const session = await ort.InferenceSession.create(modelPath)
    const wantTypeIds = session.inputNames.includes('token_type_ids')

    const fn: EmbedBackend = async (texts) => {
      const enc = tokenizer.encodeBatch(texts)
      const B = enc.inputIds.length
      const S = B > 0 ? enc.inputIds[0].length : 0
      const ids = BigInt64Array.from(enc.inputIds.flat(), (x) => BigInt(x))
      const attn = BigInt64Array.from(enc.attentionMask.flat(), (x) => BigInt(x))
      const feeds: Record<string, unknown> = {
        input_ids: new ort.Tensor('int64', ids, [B, S]),
        attention_mask: new ort.Tensor('int64', attn, [B, S]),
      }
      if (wantTypeIds) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(B * S), [B, S])
      const result = await session.run(feeds)
      const hidden = result.last_hidden_state ?? result[session.outputNames[0]]
      const H = hidden.dims[hidden.dims.length - 1]
      return meanPoolNormalize(hidden.data as Float32Array, enc.attentionMask, B, S, H)
    }
    backend = fn
    return fn
  } catch {
    // Load failure degrades to keyword-only search. Once the model is bundled
    // a failure here is worth surfacing; for now we stay silent so a missing
    // dev model doesn't spam telemetry.
    return markFailed()
  }
}

/** Embed a single text. Returns null on empty input or any backend failure. */
export async function embedText(text: string, opts?: EmbedOptions): Promise<number[] | null> {
  if (!text || !text.trim()) return null
  const out = await embedBatch([text], opts)
  return out[0] ?? null
}

/**
 * Embed many texts at once (efficient for indexing). Returns one slot per
 * input in order; failed/missing rows are null.
 */
export async function embedBatch(texts: string[], opts?: EmbedOptions): Promise<(number[] | null)[]> {
  if (!Array.isArray(texts) || texts.length === 0) return []
  const prepared = opts?.isQuery ? texts.map((t) => QUERY_PREFIX + t) : texts
  const be = await getBackend()
  if (!be) return texts.map(() => null)
  try {
    const vecs = await be(prepared)
    return texts.map((_, i) => (Array.isArray(vecs?.[i]) ? vecs[i] : null))
  } catch {
    return texts.map(() => null)
  }
}
