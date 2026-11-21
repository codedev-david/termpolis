// Smart Ask in the exported page, with a fake onnxruntime-web: how ORT is set up (one thread, no proxy, the
// wasm from the page), the bge query prefix, the 384-float unit vector, and a long question truncated.
import { describe, expect, it, vi } from 'vitest'
import { BGE_QUERY_PREFIX } from '../../../src/shared/world/askIndex'
import { SMART_DIM, startSmartAsk, type OrtLike } from '../../../src/world-export/smartAsk'

const { mockedOrt } = vi.hoisted(() => ({ mockedOrt: { current: null as unknown } }))
vi.mock('onnxruntime-web/wasm', () => ({
  get env() { return (mockedOrt.current as OrtLike).env },
  get Tensor() { return (mockedOrt.current as OrtLike).Tensor },
  get InferenceSession() { return (mockedOrt.current as OrtLike).InferenceSession },
}))

const VOCAB: Record<string, number> = { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, represent: 4, this: 5, sentence: 6, for: 7, searching: 8, relevant: 9, passages: 10, ':': 11, word: 12, dimension: 13, check: 14 }
const WASM = new Uint8Array([0, 97, 115, 109])
const MODEL = new Uint8Array([8, 1, 2, 3])

class FakeTensor {
  constructor(public type: string, public data: BigInt64Array, public dims: readonly number[]) {}
}

interface FakeOpts { width?: number; inputNames?: string[]; named?: boolean; zero?: boolean }

function fakeOrt(opts: FakeOpts = {}) {
  const width = opts.width ?? SMART_DIM
  const runs: Array<Record<string, FakeTensor>> = []
  const created: Uint8Array[] = []
  const ort = {
    env: { wasm: {} as { numThreads?: number; proxy?: boolean; wasmBinary?: Uint8Array } },
    Tensor: FakeTensor,
    InferenceSession: {
      create: async (model: Uint8Array) => {
        created.push(model)
        return {
          inputNames: opts.inputNames ?? ['input_ids', 'attention_mask', 'token_type_ids'],
          outputNames: ['out0'],
          run: async (feeds: Record<string, FakeTensor>) => {
            runs.push(feeds)
            const tokens = feeds.input_ids.dims[1]
            const data = new Float32Array(tokens * width).map((_, i) => (opts.zero ? 0 : ((i % width) + 1) * (1 + Math.floor(i / width))))
            const t = { data, dims: [1, tokens, width] }
            return opts.named === false ? { out0: t } : { last_hidden_state: t }
          },
        }
      },
    },
  }
  return { ort, runs, created }
}

const blocks = (over: Record<string, Uint8Array | null> = {}) => {
  const all: Record<string, Uint8Array | null> = {
    vocab: new TextEncoder().encode(JSON.stringify({ tokenizer: { model: { vocab: VOCAB } }, tokenizerConfig: { model_max_length: 512 } })),
    ortwasm: WASM,
    model: MODEL,
    ...over,
  }
  return vi.fn(async (id: string) => all[id] ?? null)
}

describe('startSmartAsk', () => {
  it('sets one thread, no proxy and the page wasm as wasmBinary, then opens the page model', async () => {
    const { ort, created } = fakeOrt()
    const load = blocks()
    await startSmartAsk(load, ort as unknown as OrtLike)
    expect(ort.env.wasm).toEqual({ numThreads: 1, proxy: false, wasmBinary: WASM })
    expect(created).toEqual([MODEL])
    expect(load.mock.calls.map((c) => c[0])).toEqual(['vocab', 'ortwasm', 'model'])
  })

  it('uses onnxruntime-web/wasm when no ORT is handed in', async () => {
    const { ort } = fakeOrt()
    mockedOrt.current = ort
    const smart = await startSmartAsk(blocks())
    expect(ort.env.wasm.numThreads).toBe(1)
    expect((await smart.embed('word')).length).toBe(SMART_DIM)
  })

  it('prefixes every query with the bge query prefix and feeds int64 ids, mask and type ids', async () => {
    const { ort, runs } = fakeOrt()
    const smart = await startSmartAsk(blocks(), ort as unknown as OrtLike)
    await smart.embed('word')
    const feeds = runs[runs.length - 1]
    const prefixIds = BGE_QUERY_PREFIX.toLowerCase().match(/[a-z]+|:/g)!.map((w) => VOCAB[w])
    expect(Array.from(feeds.input_ids.data, Number)).toEqual([2, ...prefixIds, 12, 3])
    expect(feeds.input_ids.type).toBe('int64')
    expect(feeds.input_ids.dims).toEqual([1, prefixIds.length + 3])
    expect(Array.from(feeds.attention_mask.data, Number).every((x) => x === 1)).toBe(true)
    expect(Array.from(feeds.token_type_ids.data, Number).every((x) => x === 0)).toBe(true)
  })

  it('leaves token_type_ids out when the model has no such input, and reads the first output by name', async () => {
    const { ort, runs } = fakeOrt({ inputNames: ['input_ids', 'attention_mask'], named: false })
    const smart = await startSmartAsk(blocks(), ort as unknown as OrtLike)
    expect((await smart.embed('word')).length).toBe(SMART_DIM)
    expect(Object.keys(runs[0])).toEqual(['input_ids', 'attention_mask'])
  })

  it('returns a unit vector of 384 floats', async () => {
    const { ort } = fakeOrt()
    const v = await (await startSmartAsk(blocks(), ort as unknown as OrtLike)).embed('word')
    expect(v).toBeInstanceOf(Float32Array)
    expect(v.length).toBe(384)
    expect(Math.hypot(...Array.from(v))).toBeCloseTo(1, 5)
  })

  it('keeps an all-zero output finite (no division by zero)', async () => {
    const { ort } = fakeOrt({ zero: true })
    const v = await (await startSmartAsk(blocks(), ort as unknown as OrtLike)).embed('word')
    expect(Array.from(v).every((x) => x === 0)).toBe(true)
  })

  it('truncates a 5,000-word question to 512 tokens without throwing', async () => {
    const { ort, runs } = fakeOrt()
    const smart = await startSmartAsk(blocks(), ort as unknown as OrtLike)
    await expect(smart.embed(Array(5000).fill('word').join(' '))).resolves.toHaveLength(384)
    const feeds = runs[runs.length - 1]
    expect(feeds.input_ids.dims).toEqual([1, 512])
    expect(Number(feeds.input_ids.data[511])).toBe(3)
  })

  it('refuses a model that does not answer 384 values', async () => {
    const { ort } = fakeOrt({ width: 768 })
    await expect(startSmartAsk(blocks(), ort as unknown as OrtLike)).rejects.toThrow('768 values, not 384')
  })

  it.each(['vocab', 'ortwasm', 'model'])('rejects when the page has no %s block', async (id) => {
    const { ort } = fakeOrt()
    await expect(startSmartAsk(blocks({ [id]: null }), ort as unknown as OrtLike)).rejects.toThrow(`no "${id}" block`)
  })
})
