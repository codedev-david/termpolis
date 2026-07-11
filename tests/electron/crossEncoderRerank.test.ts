// Tier-1 — an OPT-IN relevance reranker. The first-stage bi-encoder (bge) already hits recall@10
// 0.971 on the benchmark and a cross-encoder adds per-pair latency, so this is OFF by default and
// no relevance model is bundled (best-effort STRICTLY-LOCAL load → null → no-op). This proves the
// mechanism: a supplied scorer reorders recall, and the absence of a scorer is a safe no-op.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  rerankByScorer,
  setRerankScorer,
  getRerankScorer,
  _resetRerankForTests,
  _setRerankModelPresentForTests,
  type RerankScorer,
} from '../../src/main/crossEncoderRerank'
import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

// All docs cluster near the all-ones direction → every mutual cosine is high+positive, so every doc
// clears into the rerank candidate pool and the reranker (not the bi-encoder) decides the order.
const embed = async (text: string): Promise<number[]> => {
  let s = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) s = (Math.imul(s ^ text.charCodeAt(i), 16777619)) >>> 0
  const v = new Array(384)
  for (let i = 0; i < 384; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; v[i] = 1 + (s / 0xffffffff - 0.5) * 0.05 }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1
  return v.map((x) => x / norm)
}

describe('cross-encoder reranker (Tier-1)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rerank-'))
    _resetForTests()
    _resetRerankForTests()
    _setEmbeddingsAvailable(true)
    _setEmbedFnForTests(embed)
    initSwarmMemory(tmp)
  })
  afterEach(() => {
    _resetRerankForTests()
    _setEmbedFnForTests(null)
    _resetForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('rerankByScorer orders candidates by the scorer, descending', async () => {
    const cands = [{ id: 'a', content: 'alpha' }, { id: 'b', content: 'bravo' }, { id: 'c', content: 'charlie' }]
    const scorer: RerankScorer = async (_q, doc) => (({ alpha: 0.2, bravo: 0.9, charlie: 0.5 }) as Record<string, number>)[doc] ?? 0
    const out = await rerankByScorer('q', cands, scorer)
    expect(out.map((c) => c.id)).toEqual(['b', 'c', 'a'])
  })

  it('reorders recall to put the scorer’s top pick first (opt-in, injected scorer)', async () => {
    const ids: string[] = []
    for (const c of ['note about caching layers', 'note about the parser', 'note about TARGET the deploy pipeline', 'note about telemetry', 'note about the scheduler']) {
      ids.push((await memoryWrite({ agentId: 'a', kind: 'fact', content: c })).id)
    }
    const targetId = ids[2]
    setRerankScorer(async (_q, doc) => (doc.includes('TARGET') ? 1.0 : 0.1))
    const hits = await memorySearch({ query: 'anything relevant here', limit: 5, rerank: true })
    expect(hits[0]?.id).toBe(targetId) // the reranker, not the bi-encoder, decides #1
  })

  it('is a no-op when no reranker model/scorer is available (production-safe fallback)', async () => {
    const ids: string[] = []
    for (const c of ['aaa first note', 'bbb second note', 'ccc third note', 'ddd fourth note']) {
      ids.push((await memoryWrite({ agentId: 'a', kind: 'fact', content: c })).id)
    }
    _setRerankModelPresentForTests(false) // no bundled relevance model → getRerankScorer() returns null
    expect(await getRerankScorer()).toBeNull()
    const off = await memorySearch({ query: 'aaa first note', limit: 4 })
    const on = await memorySearch({ query: 'aaa first note', limit: 4, rerank: true })
    expect(on.map((r) => r.id)).toEqual(off.map((r) => r.id))
    void ids
  })
})
