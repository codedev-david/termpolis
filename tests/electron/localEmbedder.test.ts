import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  EMBED_DIM,
  embedText,
  embedBatch,
  isEmbedderReady,
  _setBackendForTests,
  _setOrtForTests,
  _resetEmbedderForTests,
} from '../../src/main/localEmbedder'

beforeEach(() => {
  _resetEmbedderForTests()
})

const tmpDirs: string[] = []
afterEach(() => {
  _resetEmbedderForTests()
  vi.restoreAllMocks()
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// Fake onnxruntime-web: returns an all-ones hidden state so mean-pool +
// L2-normalize over H dims is deterministic (each component = 1/sqrt(H)).
function makeFakeOrt(opts: { typeIds?: boolean; throwOnCreate?: boolean; noEnv?: boolean } = {}): unknown {
  class FakeTensor {
    type: string
    data: unknown
    dims: number[]
    constructor(type: string, data: unknown, dims: number[]) {
      this.type = type
      this.data = data
      this.dims = dims
    }
  }
  return {
    ...(opts.noEnv ? {} : { env: { wasm: { numThreads: 0 } } }),
    Tensor: FakeTensor,
    InferenceSession: {
      create: async () => {
        if (opts.throwOnCreate) throw new Error('session boom')
        return {
          inputNames:
            opts.typeIds === false
              ? ['input_ids', 'attention_mask']
              : ['input_ids', 'attention_mask', 'token_type_ids'],
          outputNames: ['last_hidden_state'],
          run: async (feeds: Record<string, { dims: number[] }>) => {
            const [B, S] = feeds.input_ids.dims
            const H = 4
            return { last_hidden_state: { data: new Float32Array(B * S * H).fill(1), dims: [B, S, H] } }
          },
        }
      },
    },
  }
}

function writeModelFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-fixture-'))
  tmpDirs.push(dir)
  fs.writeFileSync(
    path.join(dir, 'tokenizer.json'),
    JSON.stringify({
      model: {
        vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, hello: 4, world: 5 },
        max_input_chars_per_word: 100,
        continuing_subword_prefix: '##',
      },
      normalizer: { lowercase: true, strip_accents: null, handle_chinese_chars: true },
    }),
  )
  fs.writeFileSync(
    path.join(dir, 'tokenizer_config.json'),
    JSON.stringify({
      do_lower_case: true,
      unk_token: '[UNK]',
      cls_token: '[CLS]',
      sep_token: '[SEP]',
      pad_token: '[PAD]',
      model_max_length: 512,
    }),
  )
  fs.mkdirSync(path.join(dir, 'onnx'))
  fs.writeFileSync(path.join(dir, 'onnx', 'model_quantized.onnx'), 'dummy')
  return dir
}

describe('localEmbedder', () => {
  it('exposes the bge-small dimension (384)', () => {
    expect(EMBED_DIM).toBe(384)
  })

  it('returns a vector from the injected backend', async () => {
    _setBackendForTests(async (texts) => texts.map(() => new Array(384).fill(0.5)))
    const v = await embedText('hello world')
    expect(v).not.toBeNull()
    expect(v).toHaveLength(384)
    expect(v![0]).toBe(0.5)
  })

  it('applies the bge query instruction prefix only for queries', async () => {
    const seen: string[] = []
    _setBackendForTests(async (texts) => {
      seen.push(...texts)
      return texts.map(() => [1])
    })
    await embedText('find the auth bug', { isQuery: true })
    await embedText('a stored passage', { isQuery: false })
    expect(seen[0]).toContain('Represent this sentence for searching relevant passages:')
    expect(seen[0]).toContain('find the auth bug')
    // passages are embedded verbatim — no instruction prefix
    expect(seen[1]).toBe('a stored passage')
  })

  it('does not prefix by default (passage mode)', async () => {
    const seen: string[] = []
    _setBackendForTests(async (texts) => {
      seen.push(...texts)
      return texts.map(() => [1])
    })
    await embedText('plain text')
    expect(seen[0]).toBe('plain text')
  })

  it('returns null on empty / whitespace text without calling the backend', async () => {
    const backend = vi.fn(async (texts: string[]) => texts.map(() => [1]))
    _setBackendForTests(backend)
    expect(await embedText('')).toBeNull()
    expect(await embedText('   ')).toBeNull()
    expect(backend).not.toHaveBeenCalled()
  })

  it('embedBatch returns one vector per input, preserving order', async () => {
    _setBackendForTests(async (texts) => texts.map((t, i) => [i, t.length]))
    const out = await embedBatch(['a', 'bb', 'ccc'])
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual([0, 1])
    expect(out[2]).toEqual([2, 3])
  })

  it('embedBatch applies the query prefix to every item when isQuery', async () => {
    const seen: string[] = []
    _setBackendForTests(async (texts) => {
      seen.push(...texts)
      return texts.map(() => [1])
    })
    await embedBatch(['one', 'two'], { isQuery: true })
    expect(seen.every((s) => s.startsWith('Represent this sentence for searching relevant passages:'))).toBe(true)
  })

  it('degrades to null when the backend throws (no crash)', async () => {
    _setBackendForTests(async () => {
      throw new Error('model failed to load')
    })
    expect(await embedText('x')).toBeNull()
  })

  it('degrades to null for items the backend did not return a vector for', async () => {
    // backend returns fewer rows than inputs
    _setBackendForTests(async () => [[1, 2, 3]])
    const out = await embedBatch(['a', 'b', 'c'])
    expect(out[0]).toEqual([1, 2, 3])
    expect(out[1]).toBeNull()
    expect(out[2]).toBeNull()
  })

  it('isEmbedderReady reflects a loaded backend', async () => {
    expect(isEmbedderReady()).toBe(false)
    _setBackendForTests(async (texts) => texts.map(() => new Array(384).fill(0)))
    await embedText('warm it up')
    expect(isEmbedderReady()).toBe(true)
  })

  it('reset clears the backend and ready state', async () => {
    _setBackendForTests(async (texts) => texts.map(() => [1]))
    await embedText('x')
    expect(isEmbedderReady()).toBe(true)
    _resetEmbedderForTests()
    expect(isEmbedderReady()).toBe(false)
  })
})

// ---- Real load path exercised with a FAKE onnxruntime-web (runs in CI; no
// model or native binary needed) — covers loadDefaultBackend + pooling. ----
describe('localEmbedder real load path (fake ort)', () => {
  it('loads tokenizer + model and embeds via mean-pool/normalize (with padding)', async () => {
    const dir = writeModelFixture()
    _setOrtForTests(makeFakeOrt(), () => dir)
    const out = await embedBatch(['hello', 'hello world']) // different lengths → exercises padding skip
    expect(out).toHaveLength(2)
    expect(out[0]).toHaveLength(4)
    // all-ones hidden → mean-pooled + L2-normalized over H=4 → 0.5 each
    expect(out[0]!.every((x) => Math.abs(x - 0.5) < 1e-6)).toBe(true)
    expect(isEmbedderReady()).toBe(true)
  })

  it('handles a model with no token_type_ids input', async () => {
    const dir = writeModelFixture()
    _setOrtForTests(makeFakeOrt({ typeIds: false }), () => dir)
    expect(await embedText('hello world')).toHaveLength(4)
  })

  it('degrades to null when the asset dir is not found', async () => {
    _setOrtForTests(makeFakeOrt(), () => undefined)
    expect(await embedText('hello')).toBeNull()
  })

  it('degrades to null when the model file is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-nomodel-'))
    tmpDirs.push(dir)
    _setOrtForTests(makeFakeOrt(), () => dir)
    expect(await embedText('hello')).toBeNull()
  })

  it('degrades to null when ORT session creation throws', async () => {
    const dir = writeModelFixture()
    _setOrtForTests(makeFakeOrt({ throwOnCreate: true }), () => dir)
    expect(await embedText('hello')).toBeNull()
  })

  it('tolerates an ort module without env.wasm', async () => {
    const dir = writeModelFixture()
    _setOrtForTests(makeFakeOrt({ noEnv: true }), () => dir)
    expect(await embedText('hello world')).toHaveLength(4)
  })

  it('resolves the bundled model via process.resourcesPath (packaged path)', async () => {
    // Covers the real resolveAssetDir() production branch + first onnx candidate.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-res-'))
    tmpDirs.push(root)
    const modelDir = path.join(root, 'models', 'bge-small-en-v1.5')
    fs.mkdirSync(modelDir, { recursive: true })
    fs.writeFileSync(
      path.join(modelDir, 'tokenizer.json'),
      JSON.stringify({
        model: { vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, hello: 4 }, max_input_chars_per_word: 100, continuing_subword_prefix: '##' },
        normalizer: { lowercase: true, strip_accents: null, handle_chinese_chars: true },
      }),
    )
    fs.writeFileSync(path.join(modelDir, 'tokenizer_config.json'), JSON.stringify({ do_lower_case: true, model_max_length: 512 }))
    fs.writeFileSync(path.join(modelDir, 'model_quantized.onnx'), 'dummy') // first candidate (no onnx/ subdir)
    const proc = process as { resourcesPath?: string }
    const orig = proc.resourcesPath
    try {
      proc.resourcesPath = root
      _setOrtForTests(makeFakeOrt()) // no asset-dir override → real resolveAssetDir runs
      expect(await embedText('hello')).toHaveLength(4)
    } finally {
      proc.resourcesPath = orig
    }
  })
})

// ---- Real native-free backend (onnxruntime-web WASM + BertTokenizer).
// Runs where the bge model cache exists; skipped in offline CI. ----
const cacheDir = path.join(
  process.cwd(), 'node_modules', '@huggingface', 'transformers', '.cache', 'Xenova', 'bge-small-en-v1.5',
)
const hasModel = fs.existsSync(path.join(cacheDir, 'tokenizer.json'))

describe.skipIf(!hasModel)('localEmbedder real native-free backend', () => {
  it('embeds with the real model: 384-dim + correct semantic ranking', async () => {
    _resetEmbedderForTests() // no injected backend → loads the real model
    const auth = await embedText('the authentication middleware validates jwt tokens')
    const pizza = await embedText('my favorite pizza topping is fresh basil')
    const query = await embedText('how does the app check auth tokens?', { isQuery: true })
    expect(auth).not.toBeNull()
    expect(auth).toHaveLength(384)
    expect(isEmbedderReady()).toBe(true)
    const dot = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i], 0)
    // normalized vectors → dot product is cosine similarity
    expect(dot(query!, auth!)).toBeGreaterThan(dot(query!, pizza!))
  }, 60_000)
})
