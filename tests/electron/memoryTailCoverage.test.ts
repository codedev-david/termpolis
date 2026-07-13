// The memory stack's remaining defensive tail: the arms that only run when something has
// already gone wrong — a corrupt persisted graph, a shard line that is malformed rather than
// merely encrypted, a rename that loses to a Windows file lock, an embedding worker that hangs,
// a vector row that vanished out from under the HNSW graph, a tokenizer fed bytes no model
// should ever see.
//
// Every test here asserts OBSERVABLE behaviour — what is recalled, what reaches disk, what the
// API reports, what the graph still ranks first — never "the line executed". Where a branch has
// no observable consequence it is deliberately left alone (see the notes at the bottom).
//
// The embedder is ALWAYS injected (swarmMemory's `_setEmbedFnForTests` seam), so nothing here
// needs the bge model — which is how CI runs coverage.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const tele = vi.hoisted(() => ({ recordSwarmError: vi.fn() }))
vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: tele.recordSwarmError }))

// `fs` is a PASSTHROUGH mock: every call hits the real filesystem unless a test arms a hook.
// This is how we simulate the failures a memory store has to survive — a locked rename target,
// a read-only sync volume, an offline cloud-synced file, an unlistable network folder.
const failIO = vi.hoisted(() => ({
  appendFileSync: null as null | ((p: unknown) => boolean),
  readFileSync: null as null | ((p: unknown) => boolean),
  writeFileSync: null as null | ((p: unknown) => boolean),
  renameSync: null as null | ((from: unknown, to: unknown) => boolean),
  rmSync: null as null | ((p: unknown) => boolean),
  copyFileSync: false,
  readdirSync: false,
  hideExists: null as null | ((p: unknown) => boolean),
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const call = (fn: unknown, args: unknown[]): unknown => (fn as (...a: unknown[]) => unknown)(...args)
  const api = {
    ...actual,
    appendFileSync: (...args: unknown[]): unknown => {
      if (failIO.appendFileSync?.(args[0])) throw new Error('ENOSPC: no space left on device')
      return call(actual.appendFileSync, args)
    },
    readFileSync: (...args: unknown[]): unknown => {
      if (failIO.readFileSync?.(args[0])) throw new Error('EIO: file is offline / not materialized')
      return call(actual.readFileSync, args)
    },
    writeFileSync: (...args: unknown[]): unknown => {
      if (failIO.writeFileSync?.(args[0])) throw new Error('EROFS: read-only file system')
      return call(actual.writeFileSync, args)
    },
    renameSync: (...args: unknown[]): unknown => {
      if (failIO.renameSync?.(args[0], args[1])) throw new Error('EPERM: target is locked by another process')
      return call(actual.renameSync, args)
    },
    rmSync: (...args: unknown[]): unknown => {
      if (failIO.rmSync?.(args[0])) throw new Error('EPERM: cannot unlink on a read-only volume')
      return call(actual.rmSync, args)
    },
    copyFileSync: (...args: unknown[]): unknown => {
      if (failIO.copyFileSync) throw new Error('EIO: the legacy store could not be copied')
      return call(actual.copyFileSync, args)
    },
    readdirSync: (...args: unknown[]): unknown => {
      if (failIO.readdirSync) throw new Error('EIO: network drive vanished')
      return call(actual.readdirSync, args)
    },
    existsSync: (...args: unknown[]): unknown => {
      if (failIO.hideExists?.(args[0])) return false
      return call(actual.existsSync, args)
    },
  }
  return { ...api, default: api }
})

import {
  BertTokenizer,
  type BertTokenizerConfig,
} from '../../src/main/bertTokenizer'
import {
  HnswIndex,
  selectHeuristic,
  type SerializedHnsw,
} from '../../src/main/hnswIndex'
import {
  sampleGraph,
  graphNodeLabel,
  type RawEdge,
  type NodeMeta,
} from '../../src/main/memoryGraphSample'
import type { CognitiveType } from '../../src/main/mnemeTypeInfer'
import {
  embedText,
  embedBatch,
  bucketByTokens,
  setWorkerSpawner,
  _setBackendForTests,
  _setOrtForTests,
  _resetEmbedderForTests,
} from '../../src/main/localEmbedder'
import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryList,
  memoryCount,
  memoryStats,
  memoryLink,
  memoryArchive,
  searchArchive,
  memoryFeedback,
  memoryHasHash,
  memoryDashboardStats,
  consolidationCandidates,
  compactSelfShard,
  setSyncPassphrase,
  setVectorQuantization,
  getSyncStatus,
  warmProbeEmbeddings,
  embeddingsStatus,
  _resetForTests,
  _setEmbedFnForTests,
  _setMaxEntriesForTests,
  _setHnswThresholdForTests,
  _whenHnswSettledForTests,
  _isHnswReadyForTests,
} from '../../src/main/swarmMemory'
import { setSafeStorage } from '../../src/main/secureKeyStore'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Deterministic 384-dim token-hash bag of words. Shared tokens ⇒ high cosine, so recall is
 *  MEANINGFUL without the bge model (CI runs coverage without it). Lands in the packed store. */
async function bagEmbed(text: string): Promise<number[]> {
  const v = new Array<number>(384).fill(0)
  for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0
    v[h % 384] += 1
  }
  return v
}

let userDir: string
let syncDir: string
const storeFile = (): string => path.join(userDir, 'swarm-memory.jsonl')
const hnswFile = (): string => path.join(userDir, 'memory-hnsw.json')
const saltFile = (): string => path.join(syncDir, '.termpolis-salt')
const archiveFile = (): string => path.join(userDir, 'swarm-memory.archive.jsonl')
const contents = (): string[] => memoryList().map((e) => e.content)

/** Simulate a relaunch against the same data dir (fresh module state, same disk). */
const relaunch = (opts: { syncDir?: string | null; hnswThreshold?: number } = {}): void => {
  _resetForTests()
  _setEmbedFnForTests(bagEmbed)
  if (opts.hnswThreshold !== undefined) _setHnswThresholdForTests(opts.hnswThreshold)
  initSwarmMemory(userDir, opts.syncDir === undefined ? {} : { syncDir: opts.syncDir })
}

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-tail-u-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-tail-s-'))
  tele.recordSwarmError.mockClear()
  failIO.appendFileSync = null
  failIO.readFileSync = null
  failIO.writeFileSync = null
  failIO.renameSync = null
  failIO.rmSync = null
  failIO.copyFileSync = false
  failIO.readdirSync = false
  failIO.hideExists = null
  setSafeStorage(null) // no OS keychain → default-on local encryption stays off
  _resetForTests()
  _resetEmbedderForTests()
  _setEmbedFnForTests(bagEmbed)
})

afterEach(() => {
  failIO.appendFileSync = null
  failIO.readFileSync = null
  failIO.writeFileSync = null
  failIO.renameSync = null
  failIO.rmSync = null
  failIO.copyFileSync = false
  failIO.readdirSync = false
  failIO.hideExists = null
  vi.useRealTimers()
  vi.restoreAllMocks()
  setSafeStorage(null)
  _resetForTests()
  _resetEmbedderForTests()
  for (const d of [userDir, syncDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// ===========================================================================
// localEmbedder
//
// ORDERING NOTE: `workerStatusLogged` in localEmbedder is a module-level ONE-SHOT latch that
// nothing resets (not even _resetEmbedderForTests). So the "which thread are we on?" diagnostic
// can only be observed by the FIRST embedBatch call in this file — which is why this block, and
// this test inside it, come first. Do not reorder.
// ===========================================================================
describe('localEmbedder — worker orchestration, timeouts and a latched load failure', () => {
  afterEach(() => setWorkerSpawner(null))

  it('announces ONCE, outside tests, whether embedding runs off the main thread', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => { /* silence */ })
    const env = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'development' // under NODE_ENV=test the diagnostic is silent by design
      setWorkerSpawner(() => ({ embed: async () => [1, 2, 3] }))
      _setBackendForTests(async (texts: string[]) => texts.map(() => [9, 9, 9]))

      expect(await embedBatch(['first'])).toEqual([[1, 2, 3]]) // served by the worker
      expect(log).toHaveBeenCalledWith(expect.stringContaining('worker_thread active'))

      log.mockClear()
      await embedBatch(['second'])
      expect(log).not.toHaveBeenCalled() // one-shot: it never becomes a per-embed spam source
    } finally {
      process.env.NODE_ENV = env
      log.mockRestore()
    }
  })

  it('a HUNG worker times out, is disposed, and the embed falls back in-process', async () => {
    vi.useFakeTimers()
    const dispose = vi.fn()
    const workerEmbed = vi.fn(() => new Promise<number[]>(() => { /* never settles */ }))
    setWorkerSpawner(() => ({ embed: workerEmbed, dispose }))
    _setBackendForTests(async (texts: string[]) => texts.map(() => [4, 5, 6]))

    const pending = embedBatch(['a hung worker must not take the embed down with it'])
    await vi.advanceTimersByTimeAsync(10_000) // WORKER_TIMEOUT_MS

    expect(await pending).toEqual([[4, 5, 6]]) // the in-process backend answered
    expect(dispose).toHaveBeenCalledTimes(1)   // the hung worker was torn down, not leaked

    // and the worker is DISABLED for the next call — we don't pay the 10s stall twice
    workerEmbed.mockClear()
    expect(await embedBatch(['again'])).toEqual([[4, 5, 6]])
    expect(workerEmbed).not.toHaveBeenCalled()
  })

  it('a worker whose dispose() throws does not break the embedder reset', async () => {
    const dispose = vi.fn(() => { throw new Error('worker refused to exit') })
    setWorkerSpawner(() => ({ embed: async () => [1], dispose }))
    _setBackendForTests(async (texts: string[]) => texts.map(() => [2]))
    await embedBatch(['x']) // spawns the transport

    expect(() => _resetEmbedderForTests()).not.toThrow()
    expect(dispose).toHaveBeenCalledTimes(1)

    // the reset really took: a fresh in-process backend is used, with no worker in play
    _setBackendForTests(async (texts: string[]) => texts.map(() => [3]))
    expect(await embedBatch(['y'])).toEqual([[3]])
  })

  it('a failed model load is LATCHED — it is never re-attempted on every embed', async () => {
    const resolveDir = vi.fn((): string | undefined => undefined) // no model on this machine
    _setOrtForTests(makeFakeOrt(), resolveDir)

    expect(await embedText('first')).toBeNull()
    expect(await embedText('second')).toBeNull()
    expect(await embedText('third')).toBeNull()
    expect(resolveDir).toHaveBeenCalledTimes(1) // one load attempt, not one per embed
  })

  it('names the MAIN thread when no worker is available (the typing-lag diagnostic)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => { /* silence */ })
    const env = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'development'
      // The announcement is a module-level ONE-SHOT, already spent by the worker case above — so
      // the in-process case needs a genuinely fresh module instance to observe.
      vi.resetModules()
      const fresh = await import('../../src/main/localEmbedder')
      fresh._setBackendForTests(async (texts: string[]) => texts.map(() => [7]))

      expect(await fresh.embedBatch(['x'])).toEqual([[7]])
      expect(log).toHaveBeenCalledWith(expect.stringContaining('in-process fallback'))
      expect(log).toHaveBeenCalledWith(expect.stringContaining('MAIN thread'))
    } finally {
      process.env.NODE_ENV = env
      log.mockRestore()
    }
  })

  it('degrades to keyword-only when there is no bge model anywhere on disk', async () => {
    // This is exactly how CI runs: the model is not downloaded. resolveAssetDir must come back
    // empty and the load must FAIL SOFT — never throw, never reach for onnxruntime-web.
    failIO.hideExists = (p) => typeof p === 'string' && p.includes('bge-small-en-v1.5')
    _setOrtForTests(null) // no injected ort and no asset-dir override → the REAL resolver runs

    expect(await embedText('anything at all')).toBeNull()
    expect(await embedBatch(['a', 'b'])).toEqual([null, null]) // one null slot per input, in order
    failIO.hideExists = null
  })

  it('an empty or non-array batch short-circuits without touching the backend', async () => {
    const backend = vi.fn(async (texts: string[]) => texts.map(() => [1]))
    _setBackendForTests(backend)
    expect(await embedBatch([])).toEqual([])
    expect(await embedBatch(null as unknown as string[])).toEqual([])
    expect(backend).not.toHaveBeenCalled()
  })

  it('bucketByTokens survives a nullish row rather than throwing on .length', () => {
    const buckets = bucketByTokens([undefined as unknown as string, 'abc'], 1024, 16)
    expect(buckets.flat().sort((a, b) => a - b)).toEqual([0, 1]) // both inputs still get a slot
  })
})

// A fake onnxruntime-web. `zeros` produces a degenerate all-zero hidden state; `outputName`
// renames the output so the `last_hidden_state ?? outputNames[0]` fallback is exercised.
function makeFakeOrt(opts: { zeros?: boolean; outputName?: string } = {}): unknown {
  const outputName = opts.outputName ?? 'last_hidden_state'
  class FakeTensor {
    constructor(public type: string, public data: unknown, public dims: number[]) {}
  }
  return {
    env: { wasm: { numThreads: 0 } },
    Tensor: FakeTensor,
    InferenceSession: {
      create: async () => ({
        inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
        outputNames: [outputName],
        run: async (feeds: Record<string, { dims: number[] }>) => {
          const [B, S] = feeds.input_ids.dims
          const H = 384
          const data = new Float32Array(B * S * H).fill(opts.zeros ? 0 : 1)
          return { [outputName]: { data, dims: [B, S, H] } }
        },
      }),
    },
  }
}

function writeModelFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-tail-model-'))
  fs.writeFileSync(path.join(dir, 'tokenizer.json'), JSON.stringify({
    model: { vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, hello: 4, world: 5 }, max_input_chars_per_word: 100, continuing_subword_prefix: '##' },
    normalizer: { lowercase: true, strip_accents: null, handle_chinese_chars: true },
  }))
  fs.writeFileSync(path.join(dir, 'tokenizer_config.json'), JSON.stringify({
    do_lower_case: true, unk_token: '[UNK]', cls_token: '[CLS]', sep_token: '[SEP]', pad_token: '[PAD]', model_max_length: 512,
  }))
  fs.mkdirSync(path.join(dir, 'onnx'))
  fs.writeFileSync(path.join(dir, 'onnx', 'model_quantized.onnx'), 'dummy')
  return dir
}

describe('localEmbedder — degenerate model output', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } } })

  it('reads a model whose output tensor is NOT named last_hidden_state', async () => {
    const dir = writeModelFixture()
    dirs.push(dir)
    _setOrtForTests(makeFakeOrt({ outputName: 'sentence_embedding' }), () => dir)
    const v = await embedText('hello world')
    expect(v).toHaveLength(384) // resolved via outputNames[0] instead of the conventional name
    expect(v!.every((x) => Math.abs(x - 1 / Math.sqrt(384)) < 1e-6)).toBe(true)
  })

  it('an all-zero hidden state pools to ZEROS, never NaN (a NaN vector would poison the index)', async () => {
    const dir = writeModelFixture()
    dirs.push(dir)
    _setOrtForTests(makeFakeOrt({ zeros: true }), () => dir)
    const v = await embedText('hello world')
    expect(v).toHaveLength(384)                          // still the contracted dimension...
    expect(v!.every((x) => x === 0)).toBe(true)          // ...divided by the ||1 norm guard, not by 0
    expect(v!.some((x) => Number.isNaN(x))).toBe(false)
  })
})

// ===========================================================================
// bertTokenizer — the bytes no model should ever see
// ===========================================================================
const VOCAB: Record<string, number> = {
  '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3,
  hello: 4, world: 5, ':': 6, '[': 7, '{': 8, cafe: 9, '<unk>': 10, CAFE: 11,
}
function makeTok(over: Partial<BertTokenizerConfig> = {}): BertTokenizer {
  return new BertTokenizer({
    vocab: VOCAB,
    unkToken: '[UNK]', clsToken: '[CLS]', sepToken: '[SEP]', padToken: '[PAD]',
    doLowerCase: true, stripAccents: true, tokenizeChineseChars: true,
    maxInputCharsPerWord: 100, continuingSubwordPrefix: '##', modelMaxLength: 512,
    ...over,
  })
}

describe('BertTokenizer — unicode edges', () => {
  it('isolates a CJK char from EVERY ideograph block, not just the common one', () => {
    const tok = makeTok()
    const blocks: Array<[string, string]> = [
      ['CJK Unified (U+4E2D)', '中'],
      ['CJK Ext A (U+3400)', '㐀'],
      ['CJK Compatibility (U+F900)', '豈'],
      ['CJK Ext B (U+20000)', String.fromCodePoint(0x20000)],
      ['CJK Ext C (U+2A700)', String.fromCodePoint(0x2a700)],
      ['CJK Ext D (U+2B740)', String.fromCodePoint(0x2b740)],
      ['CJK Ext E (U+2B820)', String.fromCodePoint(0x2b820)],
      ['CJK Compat Supplement (U+2F800)', String.fromCodePoint(0x2f800)],
    ]
    for (const [name, ch] of blocks) {
      // isolated ⇒ "hello" survives as its own token and only the ideograph is OOV
      expect(tok.encode('hello' + ch), name).toEqual([2, 4, 1, 3])
    }
    // control: a plain letter is NOT isolated, so the whole word falls to [UNK] — which is exactly
    // the recall damage an unhandled ideograph block would silently cause.
    expect(tok.encode('hellox')).toEqual([2, 1, 3])
  })

  it('isolates every ASCII punctuation band, not only !-/', () => {
    const tok = makeTok()
    expect(tok.encode('hello:')).toEqual([2, 4, 6, 3]) // U+003A — the 58..64 band
    expect(tok.encode('hello[')).toEqual([2, 4, 7, 3]) // U+005B — the 91..96 band
    expect(tok.encode('hello{')).toEqual([2, 4, 8, 3]) // U+007B — the 123..126 band
  })

  it('strips NUL and the replacement char, but treats CR as whitespace', () => {
    const tok = makeTok()
    expect(tok.encode('he\u0000llo')).toEqual([2, 4, 3])   // NUL vanishes; the word stays whole
    expect(tok.encode('he\uFFFDllo')).toEqual([2, 4, 3])   // U+FFFD is not a control char — it needs its own guard
    expect(tok.encode('hello\rworld')).toEqual([2, 4, 5, 3]) // CR splits words instead of being dropped
  })
})

describe('BertTokenizer.fromJSON — config fallbacks that change tokenization', () => {
  it('takes unk_token from the MODEL when tokenizer_config omits it', () => {
    const tok = BertTokenizer.fromJSON({ model: { vocab: VOCAB, unk_token: '<unk>' } }, {})
    expect(tok.encode('zzzz')).toEqual([2, 10, 3]) // <unk> (10), not the [UNK] (1) default
  })

  it('honours handle_chinese_chars:false — CJK is NOT isolated and the word goes OOV', () => {
    const off = BertTokenizer.fromJSON({ model: { vocab: VOCAB }, normalizer: { handle_chinese_chars: false } }, {})
    const on = BertTokenizer.fromJSON({ model: { vocab: VOCAB }, normalizer: { handle_chinese_chars: true } }, {})
    expect(off.encode('hello中')).toEqual([2, 1, 3])    // one un-splittable word → [UNK]
    expect(on.encode('hello中')).toEqual([2, 4, 1, 3])  // isolated → hello survives
  })

  it('honours do_lower_case:false with strip_accents:true — case kept, accents removed', () => {
    const tok = BertTokenizer.fromJSON({ model: { vocab: VOCAB } }, { do_lower_case: false, strip_accents: true })
    expect(tok.encode('CAFÉ')).toEqual([2, 11, 3]) // CAFE (11) — accent gone, case preserved
    expect(tok.encode('cafe')).toEqual([2, 9, 3])       // and the lowercase entry is still distinct
  })

  it('a model_max_length under 2 yields a body-less [CLS] [SEP] instead of a negative slice', () => {
    expect(makeTok({ modelMaxLength: 1 }).encode('hello world')).toEqual([2, 3])
  })

  it('encodeBatch of nothing is empty, not a pad-filled row', () => {
    expect(makeTok().encodeBatch([])).toEqual({ inputIds: [], attentionMask: [], tokenTypeIds: [] })
  })

  it('a tokenizer.json with no model block loads INERT rather than taking the embedder down', () => {
    // localEmbedder wraps fromJSON in the try/catch that decides "model up" vs "keyword-only for
    // the whole session". A corrupt tokenizer.json must therefore degrade to unusable ids, not to
    // an exception thrown at load time.
    const tok = BertTokenizer.fromJSON({}, {})
    expect(() => tok.encode('hello world')).not.toThrow()
    expect(tok.encode('hello world')).toEqual([undefined, undefined, undefined, undefined])
  })
})

// ===========================================================================
// hnswIndex — the graph vs. a vector store that moved under it
// ===========================================================================
const HDIM = 8
/** An 8-dim one-hot unit vector — orthogonal to every other index. */
const u = (i: number): Float32Array => { const v = new Float32Array(HDIM); v[i % HDIM] = 1; return v }

describe('HnswIndex — a vector accessor that returns null', () => {
  it('refuses a row with no vector, and ranks an EVICTED row last instead of crashing', () => {
    const store = new Map<number, Float32Array>()
    for (let i = 0; i < 6; i++) store.set(i, u(i))
    const idx = new HnswIndex((r) => store.get(r) ?? null, { rng: () => 0.99 }) // rng ⇒ every node at level 0
    for (let i = 0; i < 6; i++) idx.add(i)
    expect(idx.size).toBe(6)

    idx.add(99)             // a row the store never had — no phantom node is minted
    expect(idx.size).toBe(6)

    store.delete(3)         // row 3's vector is gone from the store, but the graph still links it
    const hits = idx.search(u(0), 6)
    expect(hits).toHaveLength(6)
    expect(hits[0].row).toBe(0)                       // the exact match still wins
    expect(hits[0].score).toBeCloseTo(1, 5)
    expect(hits[hits.length - 1].row).toBe(3)         // the vector-less row is out-ranked, always last
    expect(Number.isNaN(hits[hits.length - 1].score)).toBe(false) // and never NaN-poisons the ranking
  })

  it('a persisted graph whose rows are mostly GONE still accepts + recalls a new insert', () => {
    // The on-disk graph is only valid against the store it was built from. If it is loaded against
    // a store that has lost rows, every insert has to survive neighbours with no vector at all.
    vi.spyOn(Math, 'random').mockReturnValue(0.99) // fromJSON takes no rng → pin the level to 0
    const live = new Map<number, Float32Array>([[0, u(0)], [5, u(5)]]) // rows 1..4 are gone
    const persisted: SerializedHnsw = {
      v: 2, M: 2, efC: 10, efS: 10, entry: 0, topLayer: 0,
      nodes: [
        [0, 0, [1, 2, 3, 4]], // node 0's 4 slots (M0 = 2*M) are FULL — the insert must prune
        [1, 0, [0, 2, 3, 4]],
        [2, 0, [0, 1, 3, 4]],
        [3, 0, [0, 1, 2, 4]],
        [4, 0, [0, 1, 2, 3]],
      ],
    }
    const idx = HnswIndex.fromJSON(persisted, (r) => live.get(r) ?? null)

    idx.add(5)
    expect(idx.size).toBe(6)

    const hits = idx.search(u(5), 1)
    expect(hits[0].row).toBe(5)               // the new row is wired in and exactly recalled
    expect(hits[0].score).toBeCloseTo(1, 5)

    // and every node stayed inside its neighbour capacity — the vector-less prune did not overfill
    for (const [, , packed] of idx.toJSON().nodes) {
      expect(packed.filter((x) => x >= 0).length).toBeLessThanOrEqual(4)
    }
  })

  it('the Alg-4 diversity selector tolerates a candidate whose vector disappeared', () => {
    const store = new Map<number, Float32Array>([[0, u(0)], [1, u(1)], [2, u(2)]])
    const idx = new HnswIndex((r) => store.get(r) ?? null, { M: 2, heuristic: true, rng: () => 0.99 })
    idx.add(0); idx.add(1); idx.add(2)

    store.delete(1)   // row 1 evicted — pairwise distance to it is now unknowable
    store.set(3, u(3))
    idx.add(3)        // heuristic selection must still pick a neighbour set

    expect(idx.size).toBe(4)
    expect(idx.search(u(3), 1)[0].row).toBe(3)
    expect(idx.search(u(0), 1)[0].row).toBe(0) // the surviving rows are still exactly recallable
  })

  it('a persisted graph with a DANGLING neighbour and an over-claimed topLayer still searches', () => {
    // A graph file can outlive the shape it describes (half-written, hand-edited, older format).
    // Here it claims three layers though node 0 only exists at layer 0; it links to row 9, which
    // has no node record at all; and it ALREADY lists row 5 — the row we are about to (re)insert,
    // as if the process died between wiring the back-link and writing row 5's own node.
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const live = new Map<number, Float32Array>([[0, u(0)], [9, u(9)], [5, u(5)]])
    const dangling: SerializedHnsw = {
      v: 2, M: 2, efC: 10, efS: 10,
      entry: 0,
      topLayer: 2,
      nodes: [[0, 0, [9, 5, -1, -1]]],
    }
    const idx = HnswIndex.fromJSON(dangling, (r) => live.get(r) ?? null)

    idx.add(5)
    expect(idx.size).toBe(2) // only rows with real node records — no phantom node for row 9

    const hits = idx.search(u(5), 2)
    expect(hits[0].row).toBe(5) // the re-inserted row is wired in and exactly recalled
    expect(hits[0].score).toBeCloseTo(1, 5)
    expect(idx.search(u(0), 1)[0].row).toBe(0)

    // and the pre-existing back-link was recognised, not duplicated into a second slot
    const node0 = idx.toJSON().nodes.find(([row]) => row === 0)!
    expect(node0[2].filter((x) => x === 5)).toHaveLength(1)
  })

  it('a k of zero returns nothing rather than an empty-heap walk', () => {
    const store = new Map<number, Float32Array>([[0, u(0)], [1, u(1)]])
    const idx = new HnswIndex((r) => store.get(r) ?? null)
    idx.add(0); idx.add(1)
    expect(idx.search(u(0), 0)).toEqual([])
    expect(idx.search(u(0), -1)).toEqual([])
  })

  it('a degenerate rng that always returns 0 still produces a finite, searchable graph', () => {
    // -Math.log(0) is Infinity, so without the `|| 1e-9` floor the level would be Infinity and
    // `new Int32Array(Infinity)` would throw — a hostile/exhausted rng must not brick the index.
    const store = new Map<number, Float32Array>()
    for (let i = 0; i < 5; i++) store.set(i, u(i))
    const idx = new HnswIndex((r) => store.get(r) ?? null, { rng: () => 0 })
    for (let i = 0; i < 5; i++) idx.add(i)

    expect(idx.size).toBe(5)
    expect(idx.toJSON().nodes.every(([, level]) => Number.isFinite(level))).toBe(true)
    expect(idx.search(u(2), 1)[0].row).toBe(2)
  })
})

describe('selectHeuristic — strict Alg-4 without the pruned backfill', () => {
  it('keepPruned:false DROPS the near-duplicate instead of back-filling the degree', () => {
    const candidates = [{ row: 1, d: 0.10 }, { row: 2, d: 0.11 }, { row: 3, d: 0.50 }]
    // rows 1 and 2 are near-identical to each other; row 3 is far from both
    const dist = (a: number, b: number): number => ((a === 1 && b === 2) || (a === 2 && b === 1) ? 0.01 : 0.9)

    expect(selectHeuristic(candidates, 3, dist, false)).toEqual([1, 3])    // 2 pruned and left out
    expect(selectHeuristic(candidates, 3, dist, true)).toEqual([1, 3, 2])  // ...unless the degree is back-filled
  })
})

// ===========================================================================
// memoryGraphSample — the dashboard's densest-subgraph picker
// ===========================================================================
const flatMeta: NodeMeta = (id) => ({ label: id, type: 'episodic' })

describe('sampleGraph — degenerate edges and an over-subscribed per-type floor', () => {
  it('ignores null, endpoint-less and self edges while still reporting the honest raw totals', () => {
    const edges: RawEdge[] = [
      null as unknown as RawEdge,             // a hole in the edge log
      { from: '', to: 'b', relation: 'r' },   // endpoint lost to a trimmed entry
      { from: 'a', to: '', relation: 'r' },
      { from: 'a', to: 'a', relation: 'self' },
      { from: 'a', to: 'b', relation: 'real' },
    ]
    const s = sampleGraph(edges, flatMeta, { limit: 10 })
    expect(s.totalNodes).toBe(2)                        // only a + b ever earn a degree
    expect(s.totalEdges).toBe(5)                        // ...but "showing N of M" stays honest about M
    expect(s.nodes.map((n) => n.id).sort()).toEqual(['a', 'b'])
    expect(s.edges).toEqual([{ from: 'a', to: 'b', relation: 'real' }])
  })

  it('with no options at all, samples up to the default 160 nodes / 600 edges', () => {
    const edges: RawEdge[] = []
    for (let i = 0; i < 200; i++) edges.push({ from: 'hub', to: `spoke-${i}`, relation: 'r' })

    const s = sampleGraph(edges, flatMeta) // the dashboard's default call shape

    expect(s.totalNodes).toBe(201)                    // the full graph is reported honestly...
    expect(s.nodes).toHaveLength(160)                 // ...while the canvas gets the default 160
    expect(s.nodes[0].id).toBe('hub')                 // the densest node always makes the cut
    expect(s.nodes[0].degree).toBe(200)
    expect(s.edges.length).toBeLessThanOrEqual(600)
  })

  it('an absurd limit of 0 clamps to 1 rather than sampling nothing at all', () => {
    const edges: RawEdge[] = [{ from: 'a', to: 'b', relation: 'r' }]
    const s = sampleGraph(edges, flatMeta, { limit: 0 })
    expect(s.totalNodes).toBe(2)
    expect(s.nodes.length).toBeLessThanOrEqual(1) // a lone node has no induced edge, so it drops out
    expect(s.edges).toEqual([])
  })

  it('when the per-type floor reserves MORE nodes than the limit, the densest reserved ones win', () => {
    // 4 cognitive types, limit 3 ⇒ the floor reserves one of each (4) and overshoots by one.
    const typeOf = (id: string): CognitiveType =>
      id.startsWith('e') ? 'episodic' : id === 's1' ? 'semantic' : id === 'n1' ? 'entity' : 'procedural'
    const meta: NodeMeta = (id) => ({ label: id, type: typeOf(id) })
    // degrees: e1=5, e2=4, s1=3, n1=2, p1=2
    const edges: RawEdge[] = [
      { from: 'e1', to: 'e2', relation: 'a' },
      { from: 'e1', to: 'e2', relation: 'b' },
      { from: 'e1', to: 's1', relation: 'c' },
      { from: 'e1', to: 'n1', relation: 'd' },
      { from: 'e1', to: 'p1', relation: 'e' },
      { from: 'e2', to: 's1', relation: 'f' },
      { from: 'e2', to: 'n1', relation: 'g' },
      { from: 's1', to: 'p1', relation: 'h' },
    ]
    const s = sampleGraph(edges, meta, { limit: 3 })

    expect(s.totalNodes).toBe(5)
    expect(s.totalEdges).toBe(8)
    expect(s.nodes.map((n) => n.id)).toEqual(['e1', 's1', 'n1'])                  // trimmed to the densest 3
    expect(s.nodes.map((n) => n.type)).toEqual(['episodic', 'semantic', 'entity']) // colour variety preserved
    // e2 out-ranks n1 on raw degree, but episodic's one reserved slot went to e1 — so the trim,
    // which only ever keeps RESERVED nodes, drops e2. That is the diversity trade, made visible.
    expect(s.nodes.some((n) => n.id === 'e2')).toBe(false)
    expect(s.edges).toEqual([
      { from: 'e1', to: 's1', relation: 'c' },
      { from: 'e1', to: 'n1', relation: 'd' },
    ])
  })
})

describe('graphNodeLabel — nothing usable to label with', () => {
  it('falls back through content → kind → a type default, and caps the length', () => {
    expect(graphNodeLabel(undefined as unknown as string, false)).toBe('memory')
    expect(graphNodeLabel('', true)).toBe('code')                      // code artifact, no kind either
    expect(graphNodeLabel('', true, 'note')).toBe('note')
    expect(graphNodeLabel('user:   ', false, 'message')).toBe('message') // a turn that is ONLY a speaker prefix
    expect(graphNodeLabel('x'.repeat(80), false)).toHaveLength(52)
    expect(graphNodeLabel('src/a/' + 'y'.repeat(60) + ':1-2', true)).toHaveLength(44)
  })
})

// ===========================================================================
// swarmMemory — corrupt state on disk
// ===========================================================================
describe('swarmMemory — a persisted HNSW graph that must NOT be trusted', () => {
  const CHUNKS = ['graph chunk alpha', 'graph chunk beta', 'graph chunk gamma', 'graph chunk delta', 'graph chunk epsilon']

  async function seedAndBuild(): Promise<string> {
    _setHnswThresholdForTests(3)
    initSwarmMemory(userDir)
    for (const c of CHUNKS) await memoryWrite({ agentId: 'a', kind: 'note', content: c })
    await memorySearch({ query: 'graph chunk beta', limit: 5 })
    await _whenHnswSettledForTests()
    expect(fs.existsSync(hnswFile())).toBe(true)
    return JSON.parse(fs.readFileSync(hnswFile(), 'utf8')).fp as string
  }

  it('rejects a corrupt, a stale-fingerprint and a wrong-version graph, then rebuilds a valid one', async () => {
    const fp = await seedAndBuild()
    const good = JSON.parse(fs.readFileSync(hnswFile(), 'utf8')) as { fp: string; graph: SerializedHnsw }

    const tampered: Array<[string, string]> = [
      ['torn / non-JSON bytes', 'this is not json at all {'],
      ['a graph built against a DIFFERENT entry set', JSON.stringify({ fp: 'fingerprint-of-another-store', graph: good.graph })],
      ['a legacy v1 adjacency format', JSON.stringify({ fp, graph: { ...good.graph, v: 1 } })],
    ]

    for (const [label, bytes] of tampered) {
      fs.writeFileSync(hnswFile(), bytes)
      relaunch({ hnswThreshold: 3 })                      // a launch that finds the tampered graph
      expect(_isHnswReadyForTests(), label).toBe(false)   // it was NOT adopted

      const hits = await memorySearch({ query: 'graph chunk beta', limit: 5 })
      await _whenHnswSettledForTests()

      // recall never depended on the graph — the exact scan answered while a fresh graph was built
      expect(hits[0].content, label).toBe('graph chunk beta')
      expect(_isHnswReadyForTests(), label).toBe(true)

      const rebuilt = JSON.parse(fs.readFileSync(hnswFile(), 'utf8')) as { fp: string; graph: SerializedHnsw }
      expect(rebuilt.graph.v, label).toBe(2)              // and the bad file was replaced, not left to rot
      expect(rebuilt.fp, label).toBe(fp)
      expect(rebuilt.graph.nodes.length, label).toBe(CHUNKS.length)
    }
  })

  it('backs a graph-served search with the exact scan when a project filter is selective', async () => {
    _setHnswThresholdForTests(3)
    initSwarmMemory(userDir)
    for (const c of ['postgres pool sizing for alpha one', 'postgres pool sizing for alpha two', 'postgres pool sizing for alpha three', 'postgres pool sizing for alpha four']) {
      await memoryWrite({ agentId: 'a', kind: 'note', content: c, project: 'C:/repos/alpha' })
    }
    for (const c of ['postgres pool sizing for beta one', 'postgres pool sizing for beta two']) {
      await memoryWrite({ agentId: 'a', kind: 'note', content: c, project: 'C:/repos/beta' })
    }
    await memorySearch({ query: 'postgres pool sizing' })
    await _whenHnswSettledForTests()
    expect(_isHnswReadyForTests()).toBe(true)

    // HNSW applies the `allow` filter only AFTER walking ~ef GLOBAL neighbours, so a selective
    // scope can leave in-scope memories unreturned. The filter-exhaustive scan has to back it up.
    const hits = await memorySearch({ query: 'postgres pool sizing', limit: 10, project: 'C:/repos/beta' })
    expect(hits.map((h) => h.content).sort()).toEqual([
      'postgres pool sizing for beta one',
      'postgres pool sizing for beta two',
    ])
  })
})

describe('swarmMemory — atomic whole-file rewrites vs. a hostile filesystem', () => {
  async function seedCompactable(): Promise<void> {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'keep me' })
    for (let i = 0; i < 4; i++) {
      const dead = await memoryWrite({ agentId: 'a', kind: 'note', content: `dead line ${i}` })
      memoryFeedback({ id: dead.id, helpful: true }) // more shard lines than live entries
    }
  }

  it('a rename that loses to a file lock is retried after unlinking the target (Windows)', async () => {
    await seedCompactable()
    const before = fs.readFileSync(storeFile(), 'utf8')

    let firstRenameFails = true
    failIO.renameSync = () => { const f = firstRenameFails; firstRenameFails = false; return f }
    const res = compactSelfShard({ force: true })
    failIO.renameSync = null

    expect(res.compacted).toBe(true)                            // the unlink-then-rename fallback recovered
    expect(fs.readFileSync(storeFile(), 'utf8')).not.toBe(before)
    expect(fs.existsSync(storeFile() + '.tmp')).toBe(false)     // no temp file left behind
    expect(contents()).toContain('keep me')                     // and nothing live was lost
  })

  it('a rewrite onto a read-only volume leaves the ORIGINAL shard byte-identical', async () => {
    await seedCompactable()
    const before = fs.readFileSync(storeFile(), 'utf8')
    const liveBefore = contents()

    failIO.renameSync = () => true                                                  // the rename never lands...
    failIO.rmSync = (p) => typeof p === 'string' && p === storeFile()               // ...and the target cannot be unlinked
    const res = compactSelfShard({ force: true })
    failIO.renameSync = null
    failIO.rmSync = null

    expect(res.compacted).toBe(false)
    expect(fs.readFileSync(storeFile(), 'utf8')).toBe(before)   // never truncated, never half-written
    expect(fs.existsSync(storeFile() + '.tmp')).toBe(false)     // the temp file was cleaned up
    expect(contents()).toEqual(liveBefore)                      // the hot window is untouched
    expect(tele.recordSwarmError).toHaveBeenCalledWith('swarmMemory.compact.failed', expect.anything(), expect.anything())
  })

  it('a LOCAL store that has already evicted entries is never compacted (on-disk overflow would be dropped)', async () => {
    initSwarmMemory(userDir)
    _setMaxEntriesForTests(2)
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'the oldest memory, evicted from the hot window' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'the second memory' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'the third memory' })
    expect(memoryCount()).toBe(2) // the first fell out of RAM — but it is STILL on disk

    const before = fs.readFileSync(storeFile(), 'utf8')
    expect(before).toContain('the oldest memory')

    expect(compactSelfShard({ force: true })).toEqual({ compacted: false, before: 0, after: 0 })
    expect(fs.readFileSync(storeFile(), 'utf8')).toBe(before) // compaction would have rewritten it away
  })
})

describe('swarmMemory — malformed control lines are not corruption', () => {
  it('drops junk deltas/patches, honours the well-formed ones, and reports zero corrupt lines', async () => {
    initSwarmMemory(userDir)
    const a = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'the memory a reinforce delta targets' })
    const b = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'the memory a ts-less delta targets' })
    const c = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'the memory a mixed-type clearedIds line kills' })

    fs.appendFileSync(storeFile(), [
      JSON.stringify({ codeRefsPatch: 42 }),                                 // not an object at all
      JSON.stringify({ codeRefsPatch: { id: 7, codeRefs: [] } }),            // id is not a string
      JSON.stringify({ codeRefsPatch: { id: a.id, codeRefs: 'nope' } }),     // codeRefs is not an array
      JSON.stringify({ reinforce: [null, { id: 5, used: 1 }, { id: a.id, used: 'x' }, { id: a.id, used: 4, ts: Date.now() }] }),
      JSON.stringify({ reinforce: [{ id: b.id, used: 9 }] }),                // no ts ⇒ pinned to epoch 0
      JSON.stringify({ clearedIds: [c.id, 42, null] }),                      // non-string members
    ].join('\n') + '\n')

    relaunch()

    expect(memoryStats().corruptLinesSkipped).toBe(0)  // a malformed CONTROL line is not bit-rot — don't cry wolf
    expect(contents().sort()).toEqual([
      'the memory a reinforce delta targets',
      'the memory a ts-less delta targets',
    ]) // the one valid cleared id was honoured; the 42/null members were filtered out
    expect(memoryList().find((e) => e.id === a.id)?.codeRefs).toBeUndefined() // no bogus anchor was stamped on

    expect(memoryFeedback({ id: a.id, helpful: true }).used).toBe(5) // only the well-formed +4 delta replayed
    expect(memoryFeedback({ id: b.id, helpful: true }).used).toBe(1) // the ts-less delta sits at/below the epoch → dropped
  })

  it('a corrupt forgot-set and a wrong-typed deletes floor load as EMPTY, never as garbage', async () => {
    initSwarmMemory(userDir)
    const a = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'the memory the floor tombstoned by hash' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'the memory that must survive a corrupt floor' })

    fs.writeFileSync(path.join(userDir, 'memory-forgot.json'), '{ this is not json')
    fs.writeFileSync(path.join(userDir, 'memory-deletes.json'), JSON.stringify({
      clearEpoch: -5,                            // a negative epoch is refused outright
      tombstones: 'not-an-array',                // wrong type → no ids are tombstoned
      tombstonedHashes: [42, a.hash],            // the junk member is filtered, the real one is kept
    }))

    relaunch()

    expect(contents()).toEqual(['the memory that must survive a corrupt floor'])
    expect(memoryHasHash(a.hash as string)).toBe(true)              // the valid hash tombstone still holds
    expect(memoryHasHash('a-hash-nobody-ever-forgot')).toBe(false)  // the corrupt forgot-set loaded empty
  })

  it('a mis-clocked peer entry is clamped to the skew cap so it cannot own the top of the list forever', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a normal, correctly-clocked memory' })

    const tenYears = Date.now() + 10 * 365 * 86_400_000
    fs.appendFileSync(storeFile(), JSON.stringify({
      id: 'peer-from-the-future', ts: tenYears, agentId: 'peer', kind: 'fact',
      content: 'a memory from a machine with a dead CMOS battery', hash: 'h-future',
    }) + '\n')

    relaunch()

    const future = memoryList().find((e) => e.id === 'peer-from-the-future')
    expect(future).toBeDefined()                                        // it is NOT dropped...
    expect(future!.ts).toBeLessThan(Date.now() + 3 * 86_400_000)        // ...but it is clamped to ~2 days out
    expect(future!.ts).toBeLessThan(tenYears)
  })

  it('an entry with neither source nor agentId is counted as "unknown", not dropped from the dashboard', async () => {
    initSwarmMemory(userDir)
    fs.appendFileSync(storeFile(), JSON.stringify({
      id: 'anon-1', ts: Date.now(), kind: 'message', content: 'an anonymous legacy chunk', hash: 'h-anon',
    }) + '\n')

    relaunch()

    const stats = memoryDashboardStats()
    expect(stats.total).toBe(1)
    expect(stats.bySource.unknown).toBe(1)
  })
})

describe('swarmMemory — init and archive degrade instead of dying', () => {
  it('a legacy store that cannot be copied into the new shard leaves a WRITABLE empty shard', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a legacy memory that fails to migrate' })

    _resetForTests()
    _setEmbedFnForTests(bagEmbed)
    failIO.copyFileSync = true
    initSwarmMemory(userDir, { syncDir }) // enabling sync tries to seed the shard from the legacy store
    failIO.copyFileSync = false

    const st = getSyncStatus()
    expect(st.syncing).toBe(true)
    expect(st.degraded).toBe(false)            // init still SUCCEEDED — the copy is best-effort
    expect(memoryCount()).toBe(0)              // the legacy content did not migrate...

    const shard = path.join(syncDir, `${st.deviceId}.jsonl`)
    expect(fs.existsSync(shard)).toBe(true)
    // ...and the session is still fully usable, which is the point: a failed migration must not brick it
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a write after the failed migration' })
    expect(w.durable).toBeUndefined()
    expect(fs.readFileSync(shard, 'utf8')).toContain('a write after the failed migration')
  })

  it('an unlistable sync folder reports zero devices instead of throwing', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a synced memory' })

    failIO.readdirSync = true
    const st = getSyncStatus()
    failIO.readdirSync = false

    expect(st.syncing).toBe(true)
    expect(st.devices).toBe(0)
  })

  it('an archive append that fails still evicts the entry, and reports the lost write', async () => {
    initSwarmMemory(userDir)
    const a = await memoryWrite({ agentId: 'a', kind: 'note', content: 'a memory whose archive append fails' })

    failIO.appendFileSync = () => true
    memoryArchive(a.id)
    failIO.appendFileSync = null

    expect(memoryCount()).toBe(0)                                     // it left the hot window regardless
    expect(searchArchive('archive append fails')).toEqual([])         // nothing was archived...
    expect(tele.recordSwarmError).toHaveBeenCalledWith(               // ...and the failure was surfaced
      'swarmMemory.persist.failed', expect.anything(), expect.objectContaining({ entryId: 'archive' }),
    )
  })

  it('deep archive recall returns [] when the archive file cannot be READ', async () => {
    initSwarmMemory(userDir)
    const a = await memoryWrite({ agentId: 'a', kind: 'note', content: 'a cold memory about rollback gateways' })
    memoryArchive(a.id)
    expect(searchArchive('rollback gateways').map((e) => e.content)).toEqual(['a cold memory about rollback gateways'])

    // the archive is now an offline cloud-synced file — deep recall degrades, it does not throw
    _resetForTests()
    _setEmbedFnForTests(bagEmbed)
    initSwarmMemory(userDir)
    failIO.readFileSync = (p) => typeof p === 'string' && p === archiveFile()
    expect(searchArchive('rollback gateways')).toEqual([])
    failIO.readFileSync = null
  })
})

describe('swarmMemory — the encryption salt is authoritative', () => {
  it('surfaces a failure rather than deriving a key from a salt it could not persist', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a memory that must stay readable' })

    // The sync volume is read-only, so the brand-new salt cannot be written. Deriving a key from an
    // in-memory salt nobody else will ever see would permanently orphan every peer's ciphertext.
    failIO.writeFileSync = (p) => typeof p === 'string' && p === saltFile()
    expect(() => setSyncPassphrase('a-good-passphrase')).toThrow(/salt unavailable/)
    failIO.writeFileSync = null

    expect(fs.existsSync(saltFile())).toBe(false)
    expect(getSyncStatus().encrypted).toBe(false) // encryption did NOT silently half-turn-on
    expect(contents()).toEqual(['a memory that must stay readable'])
  })

  it('adopts the winner when a peer creates the salt between our existsSync and our write', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a memory encrypted under the peer salt' })

    const peerSalt = Buffer.alloc(16, 3).toString('base64')
    fs.writeFileSync(saltFile(), peerSalt)                                  // a peer wins the race...
    failIO.hideExists = (p) => p === saltFile()                             // ...just after our existsSync said "no"
    failIO.writeFileSync = (p) => typeof p === 'string' && p === saltFile() // ...so our exclusive create loses

    const st = setSyncPassphrase('shared-passphrase')                       // must ADOPT, not clobber or throw
    failIO.hideExists = null
    failIO.writeFileSync = null

    expect(st.encrypted).toBe(true)
    expect(fs.readFileSync(saltFile(), 'utf8')).toBe(peerSalt) // the same passphrase still derives the same key everywhere
    expect(contents()).toEqual(['a memory encrypted under the peer salt'])
  })

  it('an unreadable peer shard does not blind the wrong-passphrase check', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'ciphertext-at-rest memory' })
    setSyncPassphrase('the-right-passphrase') // this device's shard is now ciphertext

    const peer = path.join(syncDir, 'ffffffffffffffff.jsonl')
    fs.writeFileSync(peer, '{"id":"peer-1","ts":1,"agentId":"p","kind":"fact","content":"peer memory"}\n')
    failIO.readFileSync = (p) => typeof p === 'string' && p === peer // the peer shard is offline/unreadable

    // The validator scans shards for ANY ciphertext to test the passphrase against. If an unreadable
    // shard aborted that scan, a wrong passphrase would be silently accepted and re-encrypt the store.
    expect(() => setSyncPassphrase('the-WRONG-passphrase')).toThrow(/Incorrect passphrase/)
    failIO.readFileSync = null
  })
})

describe('swarmMemory — small guards on the agent-facing API', () => {
  it('refuses a self-edge and an endpoint-less link', async () => {
    initSwarmMemory(userDir)
    const a = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a linkable memory' })

    expect(memoryLink({ from: a.id, to: a.id })).toBeNull() // a memory cannot relate to itself
    expect(memoryLink({ from: '', to: a.id })).toBeNull()
    expect(memoryLink({ from: a.id, to: '' })).toBeNull()
    expect(memoryLink({ from: a.id, to: 'some-other-id', relation: 'solves' })?.relation).toBe('solves')
  })

  it('an embedder that hands back an EMPTY vector is not reported as healthy', async () => {
    initSwarmMemory(userDir)
    _setEmbedFnForTests(async () => [])

    expect(embeddingsStatus()).toBe('unprobed')
    expect(await warmProbeEmbeddings()).toBe(false)
    expect(embeddingsStatus()).toBe('unprobed') // still unprobed — never a misleading "ready"
  })

  it('a negative consolidation limit yields no candidates instead of a reversed slice', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'a consolidation candidate' })

    expect(consolidationCandidates(-5)).toEqual([])
    expect(consolidationCandidates(1).map((c) => c.content)).toEqual(['a consolidation candidate'])
  })

  it('the quantization toggle is safe before the brain is initialised (IPC can beat init)', () => {
    _resetForTests()
    const stats = setVectorQuantization(true)
    expect(stats.vectors).toBe(0)
    expect(stats.ramBytes).toBe(0)
    expect(stats.quantized).toBe(false) // honest: there is no store to convert yet
  })
})

// ---------------------------------------------------------------------------
// Deliberately NOT covered. Each of these is either UNREACHABLE from the public API or has no
// observable consequence, so a test would only be buying a number — which is worse than leaving
// the branch red, because it guarantees nobody ever writes the real test.
//
//  UNREACHABLE (defensive guards with no caller that can trigger them):
//   • hnswIndex Heap.pop()'s empty-heap return — both call sites are guarded by `size > 0`.
//   • hnswIndex add()'s `cand.length ? … : cur` else-arm — searchLayer always seeds `kept` from
//     its entry rows, so it can never return an empty candidate list.
//   • hnswIndex toJSON()'s `links.get(row) ?? []` — add() and fromJSON() always set nodeLevel and
//     links together, so a node with a level but no adjacency cannot exist.
//   • localEmbedder meanPoolNormalize's `cnt || 1` — every encoded row carries at least the
//     [CLS]/[SEP] mask positions, so cnt is never 0.
//   • localEmbedder's `B > 0 ? … : 0` and tryWorkerEmbed's `if (!w)` — embedBatch returns early on
//     an empty batch and only calls tryWorkerEmbed after ensureWorker returned a transport.
//   • memoryGraphSample's `degree.get(id) || 0` — an id only reaches that map because an edge
//     gave it a degree.
//   • swarmMemory serializeEntry's vector-less arm and ensureHnsw's grew-during-build arm — every
//     mutation that could produce them bumps buildGen or clears the row map first.
//
//  NO OBSERVABLE DIFFERENCE:
//   • bertTokenizer isWhitespace's \p{Zs} arm — every Zs code point is also matched by JS's `\s`,
//     which is what basicTokenize splits on, so normalizing it to ' ' in cleanText changes nothing
//     an encode() caller can see.
// ---------------------------------------------------------------------------
