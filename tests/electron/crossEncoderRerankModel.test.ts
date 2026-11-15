// crossEncoderRerank's real load path: tokenizer.json + an ONNX session through onnxruntime-web, driven
// here by a FAKE runtime (no model, no WASM) so every arm runs in the plain unit job. The last suite runs
// the real ms-marco model where it has been fetched (dev, package-verify) and proves it separates a
// relevant passage from irrelevant ones.
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  getRerankBatchScorer,
  setRerankBatchScorer,
  sigmoid,
  RERANK_MAX_TOKENS,
  setRerankThreads,
  _setRerankOrtForTests,
  _setRerankModelPresentForTests,
  _resetRerankForTests,
} from '../../src/main/crossEncoderRerank'
import { hasRerankModel } from './_modelFixture'

const tmpDirs: string[] = []
const savedResources = process.resourcesPath
afterEach(() => {
  _resetRerankForTests()
  Object.defineProperty(process, 'resourcesPath', { value: savedResources, configurable: true, writable: true })
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

interface Feed { data: BigInt64Array; dims: number[] }
interface FakeOpts {
  typeIds?: boolean
  throwOnCreate?: boolean
  noEnv?: boolean
  /** The logit for one row; default = how many `hit` tokens (id 6) the row holds. */
  score?: (row: bigint[]) => number
  width?: number
  outputKey?: string
  /** How many rows run() answers for (contract arms). */
  rows?: (n: number) => number
}

function makeFakeOrt(opts: FakeOpts = {}) {
  const runs: Array<Record<string, Feed>> = []
  const env = { wasm: { numThreads: 4 } }
  let creates = 0
  class FakeTensor {
    constructor(public type: string, public data: BigInt64Array, public dims: number[]) {}
  }
  const key = opts.outputKey ?? 'logits'
  const ort = {
    ...(opts.noEnv ? {} : { env }),
    Tensor: FakeTensor,
    InferenceSession: {
      create: async () => {
        creates++
        if (opts.throwOnCreate) throw new Error('session boom')
        return {
          inputNames: opts.typeIds === false ? ['input_ids', 'attention_mask'] : ['input_ids', 'attention_mask', 'token_type_ids'],
          outputNames: [key],
          run: async (feeds: Record<string, Feed>) => {
            runs.push(feeds)
            const [B, S] = feeds.input_ids.dims
            const width = opts.width ?? 1
            const n = opts.rows ? opts.rows(B) : B
            const data = new Float32Array(n * width)
            for (let i = 0; i < n; i++) {
              const row = Array.from(feeds.input_ids.data.slice(i * S, (i + 1) * S))
              data[i * width] = opts.score ? opts.score(row) : row.filter((x) => x === 6n).length
              for (let k = 1; k < width; k++) data[i * width + k] = -99
            }
            return { [key]: { data, dims: [n, width] } }
          },
        }
      },
    },
  }
  return { ort, runs, env, creates: () => creates }
}

function writeFixture(where: 'root' | 'onnx' | 'none' = 'onnx', base?: string): string {
  const dir = base ?? fs.mkdtempSync(path.join(os.tmpdir(), 'rerank-fixture-'))
  if (!base) tmpDirs.push(dir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'tokenizer.json'), JSON.stringify({
    model: { vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, query: 4, word: 5, hit: 6 }, continuing_subword_prefix: '##' },
    normalizer: { lowercase: true },
  }))
  fs.writeFileSync(path.join(dir, 'tokenizer_config.json'), JSON.stringify({
    cls_token: '[CLS]', sep_token: '[SEP]', pad_token: '[PAD]', unk_token: '[UNK]', model_max_length: 512,
  }))
  if (where === 'onnx') {
    fs.mkdirSync(path.join(dir, 'onnx'))
    fs.writeFileSync(path.join(dir, 'onnx', 'model_quantized.onnx'), 'x')
  }
  if (where === 'root') fs.writeFileSync(path.join(dir, 'model_quantized.onnx'), 'x')
  return dir
}

describe('crossEncoderRerank: load path with a fake runtime', () => {
  it('loads once, runs ORT on one thread, feeds int64 ids, mask and token types, and scores each passage', async () => {
    const dir = writeFixture('onnx')
    const f = makeFakeOrt()
    _setRerankOrtForTests(f.ort, () => dir)
    const [a, b] = await Promise.all([getRerankBatchScorer(), getRerankBatchScorer()])
    expect(a).not.toBeNull()
    expect(b).toBe(a) // concurrent callers share one load
    expect(f.creates()).toBe(1)
    expect(f.env.wasm.numThreads).toBe(1)
    expect(await a!('query', ['word', 'hit hit word', 'hit'])).toEqual([0, 2, 1])
    const feed = f.runs.at(-1)!
    expect(Object.keys(feed).sort()).toEqual(['attention_mask', 'input_ids', 'token_type_ids'])
    expect(feed.input_ids.dims).toEqual([3, 7]) // [CLS] query [SEP] hit hit word [SEP]
    expect(Array.from(feed.input_ids.data.slice(0, 7))).toEqual([2n, 4n, 3n, 5n, 3n, 0n, 0n])
    expect(Array.from(feed.attention_mask.data.slice(0, 7))).toEqual([1n, 1n, 1n, 1n, 1n, 0n, 0n])
    expect(Array.from(feed.token_type_ids.data.slice(7, 14))).toEqual([0n, 0n, 0n, 1n, 1n, 1n, 1n])
    expect(await getRerankBatchScorer()).toBe(a) // cached
    expect(f.creates()).toBe(1)
  })

  it('a model without token_type_ids is not fed them; a model file at the root of the folder is found', async () => {
    const dir = writeFixture('root')
    const f = makeFakeOrt({ typeIds: false, noEnv: true })
    _setRerankOrtForTests(f.ort, () => dir)
    const s = await getRerankBatchScorer()
    expect(await s!('query', ['hit'])).toEqual([1])
    expect(Object.keys(f.runs.at(-1)!).sort()).toEqual(['attention_mask', 'input_ids'])
  })

  it('reads the first column of a [B, k] output, and the first output name when it is not called logits', async () => {
    const dir = writeFixture()
    _setRerankOrtForTests(makeFakeOrt({ width: 3, outputKey: 'scores' }).ort, () => dir)
    expect(await (await getRerankBatchScorer())!('query', ['hit', 'word'])).toEqual([1, 0])
  })

  it('setRerankThreads sets the WASM threads for the load (the worker raises it); anything that is not a count is 1', async () => {
    const dir = writeFixture('onnx')
    for (const [n, want] of [[3, 3], [2.7, 2], [0, 1], [-4, 1], [Number.NaN, 1], [Number.POSITIVE_INFINITY, 1]] as const) {
      const f = makeFakeOrt()
      setRerankThreads(n)
      _setRerankOrtForTests(f.ort, () => dir)
      expect(await getRerankBatchScorer()).not.toBeNull()
      expect(f.env.wasm.numThreads, String(n)).toBe(want)
    }
  })

  it('splits a long list into forward passes of 16 and cuts each passage to the token budget', async () => {
    const dir = writeFixture()
    const f = makeFakeOrt()
    _setRerankOrtForTests(f.ort, () => dir)
    const s = (await getRerankBatchScorer())!
    f.runs.length = 0
    const docs = Array.from({ length: 33 }, (_, i) => (i === 32 ? 'hit '.repeat(2000) : 'word'))
    const out = await s('query '.repeat(500), docs)
    expect(out).toHaveLength(33)
    expect(f.runs.map((r) => r.input_ids.dims[0])).toEqual([16, 16, 1])
    expect(f.runs[2].input_ids.dims[1]).toBe(RERANK_MAX_TOKENS)
    // The query is cut to 400 chars (~67 tokens) and the passage to 1536 chars (384 hits) before
    // tokenizing; longest_first then trims the passage to what is left of the 256-token budget.
    // 400 chars = 66 × "query " + "quer" (an [UNK]), so the first segment is 67 tokens.
    const firstLen = Array.from(f.runs[2].token_type_ids.data).filter((x) => x === 0n).length - 2
    expect(firstLen).toBe(67)
    expect(Array.from(f.runs[2].input_ids.data).filter((x) => x === 4n)).toHaveLength(66)
    expect(out[32]).toBe(RERANK_MAX_TOKENS - 3 - firstLen)
  })

  it.each([
    ['a missing folder', 'missing', {}],
    ['a folder with no model file', 'none', {}],
    ['a runtime that cannot open the session', 'ok', { throwOnCreate: true }],
    ['a model whose probe is not finite', 'ok', { score: () => Number.NaN }],
    ['a model that answers no rows', 'ok', { rows: () => 0 }],
  ] as const)('%s gives no scorer, and the failure is remembered until reset', async (_name, where, o) => {
    const f = makeFakeOrt(o as FakeOpts)
    const dir = where === 'missing' ? undefined : writeFixture(where === 'none' ? 'none' : 'onnx')
    _setRerankOrtForTests(f.ort, () => dir)
    expect(await getRerankBatchScorer()).toBeNull()
    const before = f.creates()
    expect(await getRerankBatchScorer()).toBeNull()
    expect(f.creates()).toBe(before) // no second attempt
  })

  it('an injected scorer wins over the model, and clearing it lets the model load', async () => {
    const dir = writeFixture()
    _setRerankOrtForTests(makeFakeOrt().ort, () => dir)
    const inj = async (_q: string, d: string[]): Promise<number[]> => d.map(() => 7)
    setRerankBatchScorer(inj)
    expect(await getRerankBatchScorer()).toBe(inj)
    setRerankBatchScorer(null)
    const s = await getRerankBatchScorer()
    expect(s).not.toBe(inj)
    expect(await s!('query', ['hit'])).toEqual([1])
  })

  it('finds the bundled copy under resourcesPath (packaged), and none when the model is reported absent', async () => {
    const res = fs.mkdtempSync(path.join(os.tmpdir(), 'rerank-res-'))
    tmpDirs.push(res)
    writeFixture('onnx', path.join(res, 'models', 'ms-marco-MiniLM-L-6-v2'))
    Object.defineProperty(process, 'resourcesPath', { value: res, configurable: true, writable: true })
    _setRerankOrtForTests(makeFakeOrt().ort, null)
    expect(await getRerankBatchScorer()).not.toBeNull()
    _setRerankModelPresentForTests(false)
    expect(await getRerankBatchScorer()).toBeNull()
  })

  it('sigmoid squashes a logit to 0..1', () => {
    expect(sigmoid(0)).toBe(0.5)
    expect(sigmoid(10)).toBeGreaterThan(0.99)
    expect(sigmoid(-10)).toBeLessThan(0.01)
  })
})

describe.skipIf(!hasRerankModel)('crossEncoderRerank: the real ms-marco model', () => {
  it('scores the passage that answers the query above ones that do not', async () => {
    _resetRerankForTests()
    const s = await getRerankBatchScorer()
    expect(s).not.toBeNull()
    const [right, wrong, off] = await s!('how does the app check auth tokens?', [
      'The authentication middleware validates the JWT bearer token on every request and rejects expired ones.',
      'The settings panel stores the primer size in a JSON file under userData.',
      'My favourite pizza topping is fresh basil.',
    ])
    expect(right).toBeGreaterThan(wrong)
    expect(right).toBeGreaterThan(off)
  }, 60_000)
})
