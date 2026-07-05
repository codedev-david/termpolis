// Branch-coverage guards for the hardening's defensive paths (launch backfill pass,
// corrupt floor tolerance, tombstone snapshot, relative-age buckets). These exercise
// error/edge branches that the behavioral tests don't, keeping the coverage gate honest.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  memoryDelete,
  memoryBackfillVectors,
  setSyncDir,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _vectorStoreSizeForTests,
} from '../../src/main/swarmMemory'
import { buildContextPrimer, type PrimerHit } from '../../src/main/contextPrimer'

let userDir: string
let syncDir: string
beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cov-user-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cov-sync-'))
  _resetForTests()
  _setEmbedFnForTests(async () => null)
})
afterEach(() => {
  _resetForTests()
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
})

describe('durability edge branches', () => {
  it('tolerates a corrupt device-local deletes floor file', async () => {
    // Pre-seed a store file so init runs reloadFrom (→ loadDeletesFloor), and a corrupt floor.
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
    setSyncDir(null) // snapshot walks the tombstone set (the for-loop branch)
    expect(memoryList().some((e) => e.content === 'to keep')).toBe(true)
    expect(memoryList().some((e) => e.content === 'to delete')).toBe(false)
  })
})

describe('primer relative-age markers (F24) — all buckets', () => {
  it('renders years / days / hours / minutes / just-now', async () => {
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
