// Smart Ask in the exported page: the bge-small query embedding, computed in the browser with onnxruntime-web
// from bytes the page itself carries (the ORT wasm, the model and the tokenizer vocab blocks). Nothing is
// fetched: ORT gets the wasm as bytes (env.wasm.wasmBinary), runs on this thread (numThreads 1, so no worker
// pool) and is never proxied to a worker. The embedding is the main embedder's for a query (localEmbedder.ts):
// the bge query prefix, mean pooling over the tokens, then L2 normalisation, 384 floats.
import * as ortWasm from 'onnxruntime-web/wasm'
import { BertTokenizer, type RawTokenizerConfig, type RawTokenizerJson } from '../main/bertTokenizer'
import { BGE_QUERY_PREFIX } from '../shared/world/askIndex'

/** bge-small-en-v1.5's width; any other model is refused at start, so a wrong model cannot rank. */
export const SMART_DIM = 384

export interface SmartAsk { embed(q: string): Promise<Float32Array> }

interface OrtTensorLike { data: Float32Array; dims: readonly number[] }
interface OrtSessionLike {
  inputNames: readonly string[]
  outputNames: readonly string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>
}
/** The part of onnxruntime-web the page uses; tests hand in a fake. */
export interface OrtLike {
  env: { wasm: { numThreads?: number; proxy?: boolean; wasmBinary?: ArrayBufferLike | Uint8Array } }
  Tensor: new (type: 'int64', data: BigInt64Array, dims: readonly number[]) => unknown
  InferenceSession: { create(model: Uint8Array): Promise<OrtSessionLike> }
}

/** The tokenizer block: tokenizer.json and tokenizer_config.json of the model, as the export read them. */
interface VocabBlock { tokenizer: RawTokenizerJson; tokenizerConfig: RawTokenizerConfig }

/** Mean of the token rows (every token counts: one query has no padding), then scaled to length 1. */
function meanPoolNormalize(hidden: Float32Array, tokens: number, width: number): Float32Array {
  const sum = new Float64Array(width)
  for (let t = 0; t < tokens; t++) for (let h = 0; h < width; h++) sum[h] += hidden[t * width + h]
  let norm = 0
  for (let h = 0; h < width; h++) {
    sum[h] /= tokens
    norm += sum[h] * sum[h]
  }
  const scale = Math.sqrt(norm) || 1
  const out = new Float32Array(width)
  for (let h = 0; h < width; h++) out[h] = sum[h] / scale
  return out
}

async function need(load: (id: string) => Promise<Uint8Array | null>, id: string): Promise<Uint8Array> {
  const bytes = await load(id)
  if (bytes === null) throw new Error(`The page has no "${id}" block`)
  return bytes
}

/**
 * Starts ORT on the page's own bytes and checks the model answers 384 floats. Rejects when a block is missing,
 * ORT cannot start (an old browser, memory, the page's CSP) or the model is the wrong one.
 */
export async function startSmartAsk(load: (id: string) => Promise<Uint8Array | null>, ort: OrtLike = ortWasm as unknown as OrtLike): Promise<SmartAsk> {
  const vocab = JSON.parse(new TextDecoder().decode(await need(load, 'vocab'))) as VocabBlock
  const wasm = await need(load, 'ortwasm')
  const model = await need(load, 'model')
  const tokenizer = BertTokenizer.fromJSON(vocab.tokenizer, vocab.tokenizerConfig)
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ort.env.wasm.wasmBinary = wasm
  const session = await ort.InferenceSession.create(model)
  const typeIds = session.inputNames.includes('token_type_ids')

  const embed = async (q: string): Promise<Float32Array> => {
    // encode() adds [CLS] and [SEP] and truncates to the model's 512 tokens, so a long question cannot overflow it.
    const ids = tokenizer.encode(BGE_QUERY_PREFIX + q)
    const dims = [1, ids.length]
    const feeds: Record<string, unknown> = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), dims),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(ids.length).fill(BigInt(1)), dims),
    }
    if (typeIds) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(ids.length), dims)
    const result = await session.run(feeds)
    const hidden = result.last_hidden_state ?? result[session.outputNames[0]]
    const width = hidden.dims[hidden.dims.length - 1]
    if (width !== SMART_DIM) throw new Error(`The model answers ${width} values, not ${SMART_DIM}`)
    return meanPoolNormalize(hidden.data, ids.length, width)
  }
  // One question before the page says smart Ask is ready: a model that cannot answer fails here, not on the first real one.
  await embed('dimension check')
  return { embed }
}
