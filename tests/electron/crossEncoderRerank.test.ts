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
  setRerankEnabled,
  rerankEnabled,
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

  it('setRerankScorer(null) clears an injected scorer and resets the lazy loader', async () => {
    setRerankScorer(async () => 1)
    expect(await getRerankScorer()).not.toBeNull() // injected scorer returned
    setRerankScorer(null) // clears cached + loadAttempted
    _setRerankModelPresentForTests(false)
    expect(await getRerankScorer()).toBeNull() // no injected, no model → null
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

// ── The arms a happy three-document reorder never reaches ────────────────────────────────────────
// The suite above proves the mechanism end-to-end. What it never touches is the global gate, the
// ≤1-candidate short-circuit, and a scorer that rejects for exactly ONE pair — and each of those is
// a place where a regression is silent rather than loud.

describe('cross-encoder reranker — the global opt-in gate', () => {
  beforeEach(() => _resetRerankForTests())
  afterEach(() => _resetRerankForTests())

  it('setRerankEnabled flips the gate, and the reset seam puts it back OFF', () => {
    // OFF by default is the whole safety story: a cross-encoder re-reads every (query, doc) pair,
    // so a gate that defaulted ON would silently add per-pair model latency to every recall.
    expect(rerankEnabled()).toBe(false)
    setRerankEnabled(true)
    expect(rerankEnabled()).toBe(true)
    setRerankEnabled(false)
    expect(rerankEnabled()).toBe(false)

    setRerankEnabled(true)
    _resetRerankForTests()
    // The reset seam clears `enabled` too — otherwise a suite that opted in would leak the flag
    // into every later suite in the same worker and rerank searches nobody asked to rerank.
    expect(rerankEnabled()).toBe(false)
  })
})

describe('rerankByScorer — short-circuit and per-item failure', () => {
  it('scores nothing for 0 or 1 candidates, and hands back a COPY rather than the input array', async () => {
    const scorer = vi.fn(async () => 1)
    const empty: Array<{ id: string; content: string }> = []
    const one = [{ id: 'a', content: 'alpha' }]

    const outEmpty = await rerankByScorer('q', empty, scorer)
    const outOne = await rerankByScorer('q', one, scorer)

    expect(outEmpty).toEqual([])
    expect(outOne).toEqual([{ id: 'a', content: 'alpha' }])
    // `candidates.slice()`, not `candidates`: the result is sorted/spliced downstream, and returning
    // the caller's own array would make the single-hit case alias the caller's recall list.
    expect(outEmpty).not.toBe(empty)
    expect(outOne).not.toBe(one)
    // A list of one cannot be reordered, so a model round trip for it is pure latency.
    expect(scorer).not.toHaveBeenCalled()
  })

  it('a scorer that REJECTS on one document degrades that document to 0, not the whole rerank', async () => {
    const cands = [
      { id: 'poison', content: 'poison' },
      { id: 'low', content: 'low' },
      { id: 'high', content: 'high' },
    ]
    const scorer: RerankScorer = async (_q, doc) => {
      if (doc === 'poison') throw new Error('tokenizer blew up on this pair')
      return doc === 'high' ? 0.9 : 0.4
    }

    const out = await rerankByScorer('q', cands, scorer)

    // Without the per-item `.catch(() => 0)` a single bad pair rejects the Promise.all and sinks the
    // entire rerank — the caller loses the ordering for every OTHER candidate because of one doc.
    expect(out.map((c) => c.id)).toEqual(['high', 'low', 'poison'])
  })

  it('equal scores keep the first-stage bi-encoder order (the sort must be stable)', async () => {
    // A model that cannot separate the candidates must not shuffle them: the bi-encoder ranking is
    // the fallback signal, and an unstable sort would throw it away for no gain.
    const cands = ['a', 'b', 'c', 'd'].map((id) => ({ id, content: id }))
    const out = await rerankByScorer('q', cands, async () => 0.5)
    expect(out.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
