// Tier-1 — int8 vector quantization (BB8) was fully built + unit-tested in vectorStore.ts but DEAD:
// swarmMemory always constructed a float store. This wires it end-to-end behind a gate. int8 is a
// pure IN-RAM representation (~4x less vector RAM) — disk keeps exact floats and re-packs on load —
// so enabling it must not change which memories recall returns (the two-stage int8 gather + float×int8
// rescore preserves top-1 ranking).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _setQuantizeForTests,
  _isVectorStoreQuantizedForTests,
} from '../../src/main/swarmMemory'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

// Deterministic, distinct, normalized 384-dim vector per text — no model needed.
const embed = async (text: string): Promise<number[]> => {
  let s = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) s = (Math.imul(s ^ text.charCodeAt(i), 16777619)) >>> 0
  const v = new Array(384)
  for (let i = 0; i < 384; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; v[i] = s / 0xffffffff - 0.5 }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1
  return v.map((x) => x / norm)
}

const CORPUS = [
  'the authentication module validates bearer tokens',
  'database connection pooling reduces query latency',
  'the renderer batches paint operations each frame',
  'websocket reconnection uses exponential backoff',
  'the parser builds an abstract syntax tree from source',
  'garbage collection runs on the main thread when idle',
  'the scheduler prioritizes tasks by deadline',
  'vector search returns the nearest neighbours by cosine',
  'the installer signs the inner executable on windows',
  'telemetry events are batched before egress',
]

describe('int8 vector quantization (Tier-1)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-'))
    _resetForTests()
    _setEmbeddingsAvailable(true)
    _setEmbedFnForTests(embed)
  })
  afterEach(() => {
    _setEmbedFnForTests(null)
    _setQuantizeForTests(false)
    _resetForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const build = async (): Promise<string[]> => {
    const ids: string[] = []
    for (const c of CORPUS) ids.push((await memoryWrite({ agentId: 'a', kind: 'fact', content: c })).id)
    return ids
  }

  it('builds a quantized store when enabled, and each memory is still its own best match', async () => {
    _setQuantizeForTests(true)
    initSwarmMemory(tmp)
    expect(_isVectorStoreQuantizedForTests()).toBe(true)
    const ids = await build()
    for (let i = 0; i < CORPUS.length; i++) {
      const hits = await memorySearch({ query: CORPUS[i], limit: 3 })
      expect(hits[0]?.id).toBe(ids[i]) // exact self-match ranks #1 even under int8
    }
  })

  it('default (float) is the baseline; int8 preserves the top-1 ranking vs float (recall parity)', async () => {
    // Float run
    _setQuantizeForTests(false)
    initSwarmMemory(tmp)
    expect(_isVectorStoreQuantizedForTests()).toBe(false)
    await build()
    const floatTop = []
    for (const c of CORPUS) floatTop.push((await memorySearch({ query: c, limit: 1 }))[0]?.content)

    // Int8 run over the same corpus
    _resetForTests()
    _setEmbeddingsAvailable(true)
    _setEmbedFnForTests(embed)
    _setQuantizeForTests(true)
    initSwarmMemory(tmp + '-q')
    await build()
    const quantTop = []
    for (const c of CORPUS) quantTop.push((await memorySearch({ query: c, limit: 1 }))[0]?.content)

    expect(quantTop).toEqual(floatTop)
    try { fs.rmSync(tmp + '-q', { recursive: true, force: true }) } catch { /* ignore */ }
  })
})
