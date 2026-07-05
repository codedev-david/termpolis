// Branch-coverage guards for the hardening's defensive/edge paths — these exercise
// error and boundary branches the behavioral suites don't, keeping the coverage gate
// comfortably above its floor (the hardening added many guarded branches).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryList,
  memoryCount,
  memoryDelete,
  memoryClear,
  memoryBackfillVectors,
  reloadMemoryFromSync,
  setSyncDir,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _setPrfForTests,
  _vectorStoreSizeForTests,
} from '../../src/main/swarmMemory'
import { buildContextPrimer, type PrimerHit } from '../../src/main/contextPrimer'
import { embedBatch, setWorkerSpawner, _setBackendForTests, _resetEmbedderForTests } from '../../src/main/localEmbedder'

let userDir: string
let syncDir: string
beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cov-user-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cov-sync-'))
  _resetForTests()
  _resetEmbedderForTests()
  _setEmbedFnForTests(async () => null)
})
afterEach(() => {
  _resetForTests()
  _resetEmbedderForTests()
  vi.restoreAllMocks()
  for (const d of [userDir, syncDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

describe('memoryBackfillVectors (F18 launch pass)', () => {
  it('embeds vector-less hot-window entries once the embedder is back', async () => {
    initSwarmMemory(userDir)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'captured during an outage' })
    expect(_vectorStoreSizeForTests()).toBe(0)
    const vec = new Array(384).fill(0); vec[3] = 1
    _setEmbedFnForTests(async () => vec)
    _setEmbeddingsAvailable(null)
    const n = await memoryBackfillVectors(50)
    expect(n).toBeGreaterThanOrEqual(1)
    expect(_vectorStoreSizeForTests()).toBeGreaterThanOrEqual(1)
  })

  it('is a no-op when embeddings are unavailable', async () => {
    initSwarmMemory(userDir)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'x' })
    expect(await memoryBackfillVectors()).toBe(0)
  })

  it('leaves an already-packed entry unchanged on a dedup-hit backfill', async () => {
    initSwarmMemory(userDir)
    const vec = new Array(384).fill(0); vec[1] = 1
    _setEmbedFnForTests(async () => vec)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a packed entry' })
    const before = _vectorStoreSizeForTests()
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a packed entry' }) // dedup hit → already packed → no-op
    expect(_vectorStoreSizeForTests()).toBe(before)
  })
})

describe('durability + control-line edge branches', () => {
  it('tolerates a corrupt device-local deletes floor file', async () => {
    fs.writeFileSync(path.join(userDir, 'swarm-memory.jsonl'), '')
    fs.writeFileSync(path.join(userDir, 'memory-deletes.json'), '{ this is : not json')
    _resetForTests()
    _setEmbedFnForTests(async () => null)
    expect(() => initSwarmMemory(userDir)).not.toThrow()
    _setEmbeddingsAvailable(false)
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'still works after corrupt floor' })
    expect(w.id).toBeTruthy()
  })

  it('serializes tombstones into the sync-off snapshot', async () => {
    initSwarmMemory(userDir, { syncDir })
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'to delete' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'to keep' })
    memoryDelete(w.id)
    setSyncDir(null)
    expect(memoryList().some((e) => e.content === 'to keep')).toBe(true)
    expect(memoryList().some((e) => e.content === 'to delete')).toBe(false)
  })

  it('ignores a malformed patch line and a patch for an absent hash', () => {
    initSwarmMemory(userDir, { syncDir })
    fs.writeFileSync(path.join(syncDir, 'p.jsonl'), [
      JSON.stringify({ patch: { hash: 'h' } }),                       // missing project → skip
      JSON.stringify({ patch: { hash: 'absent', project: 'foo' } }), // no matching entry → no-op
      JSON.stringify({ id: 'e1', ts: 1, agentId: 'x', kind: 'fact', content: 'survivor', hash: 'he1' }),
    ].join('\n') + '\n')
    reloadMemoryFromSync()
    expect(memoryList().some((e) => e.content === 'survivor')).toBe(true)
  })

  it('clears an empty synced store without emitting clearedIds', async () => {
    initSwarmMemory(userDir, { syncDir })
    memoryClear() // no live ids → skips the clearedIds append branch
    expect(memoryCount()).toBe(0)
  })
})

describe('project + embed dimension branches', () => {
  it('a full-path search still matches a legacy slug-only entry', async () => {
    initSwarmMemory(userDir)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a legacy slug entry', project: 'foo' }) // bare slug, no key
    const hits = await memorySearch({ query: 'legacy slug entry', project: '/x/foo' }) // key set, entry has none → slug fallback
    expect(hits.some((h) => h.content.includes('legacy slug'))).toBe(true)
  })

  it('rejects a wrong-dimension vector from the real embed path (F29)', async () => {
    initSwarmMemory(userDir)
    _setEmbedFnForTests(null)
    _setEmbeddingsAvailable(null)
    _setBackendForTests(async (texts: string[]) => texts.map(() => new Array(768).fill(0.1))) // wrong dim
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a wrong-dimension write' })
    expect(w.embedding).toBeUndefined() // not accepted / not stored as a vector
  })
})

describe('primer error + age branches', () => {
  it('returns null when the project + global searches both throw', async () => {
    const search = async (): Promise<PrimerHit[]> => { throw new Error('boom') }
    expect(await buildContextPrimer(search, { query: 'x', project: 'foo' })).toBeNull()
  })

  it('returns null when the flat global search throws', async () => {
    const search = async (): Promise<PrimerHit[]> => { throw new Error('boom') }
    expect(await buildContextPrimer(search, { query: 'x' })).toBeNull()
  })

  it('renders every relative-age bucket (years/days/hours/minutes/just-now)', async () => {
    const now = Date.now()
    const day = 86_400_000
    const search = async (): Promise<PrimerHit[]> => [
      { id: 'y', kind: 'note', source: 'a', score: 0.90, content: 'a years-old note', ts: now - 800 * day },
      { id: 'd', kind: 'note', source: 'a', score: 0.86, content: 'a days-old note', ts: now - 3 * day },
      { id: 'h', kind: 'note', source: 'a', score: 0.82, content: 'an hours-old note', ts: now - 5 * 3_600_000 },
      { id: 'm', kind: 'note', source: 'a', score: 0.78, content: 'a minutes-old note', ts: now - 10 * 60_000 },
      { id: 'j', kind: 'note', source: 'a', score: 0.74, content: 'a just-now note', ts: now },
    ]
    const primer = await buildContextPrimer(search, { query: 'x', limit: 10 })
    expect(primer).toMatch(/y ago\]/)
    expect(primer).toMatch(/d ago\]/)
    expect(primer).toMatch(/h ago\]/)
    expect(primer).toMatch(/m ago\]/)
    expect(primer).toMatch(/just now\]/)
  })
})

describe('localEmbedder fallback branches', () => {
  it('falls back to in-process when the worker spawner throws', async () => {
    setWorkerSpawner(() => { throw new Error('spawn failed') })
    _setBackendForTests(async (texts: string[]) => texts.map(() => [1, 2, 3]))
    const out = await embedBatch(['abc'])
    expect(out).toEqual([[1, 2, 3]])
    setWorkerSpawner(null)
  })

  it('returns [] for an empty batch', async () => {
    expect(await embedBatch([])).toEqual([])
  })
})

describe('search feature-path branches (default-off, covered without the model)', () => {
  // 384-dim unit vectors with a controllable cosine, so these run on CI (model hidden).
  const q = (): number[] => { const v = new Array(384).fill(0); v[0] = 1; return v }
  const atCos = (c: number): number[] => { const v = new Array(384).fill(0); v[0] = c; v[1] = Math.sqrt(Math.max(0, 1 - c * c)); return v }

  it('pseudo-relevance feedback expands a thin, moderately-relevant result (F/BB3 path)', async () => {
    initSwarmMemory(userDir)
    // Query embeds to q; the single stored passage embeds at cosine 0.5 (in [0.3,0.65]) → PRF triggers.
    _setEmbedFnForTests(async (t: string) => (t.startsWith('QQ') ? q() : atCos(0.5)))
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a moderately relevant passage' })
    _setPrfForTests(true)
    try {
      const res = await memorySearch({ query: 'QQ find the passage', limit: 10 })
      expect(res.length).toBeGreaterThanOrEqual(1)
    } finally {
      _setPrfForTests(false)
    }
  })

  it('diversify path re-ranks over packed vectors with agent/kind/task filters', async () => {
    initSwarmMemory(userDir)
    _setEmbedFnForTests(async (t: string) => (t.startsWith('QQ') ? q() : atCos(0.9)))
    for (let i = 0; i < 4; i++) await memoryWrite({ agentId: 'a', kind: 'fact', taskId: 't1', content: `relevant passage ${i}` })
    const res = await memorySearch({ query: 'QQ passage', limit: 3, agentId: 'a', kind: 'fact', taskId: 't1', diversify: true })
    expect(res.length).toBeGreaterThanOrEqual(1)
    expect(res.every((r) => r.agentId === 'a' && r.kind === 'fact' && r.taskId === 't1')).toBe(true)
  })
})
