// Tier-2 — HNSW delete-repair under churn. Deletes are excluded from results immediately by the
// search-time `allow` filter, so the OLD behavior (rebuild the whole graph on EVERY delete) was
// wasteful under churn. Now: cheap deletes stay filter-only; the graph is rebuilt to drop dead nodes
// only once >15% of indexed rows are deleted. Uses an injected embedder + a low threshold so HNSW
// engages at small scale without the real model.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory,
  memoryWrite,
  memoryDelete,
  memorySearch,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _setHnswThresholdForTests,
  _setHnswYieldMsForTests,
  _whenHnswSettledForTests,
  _isHnswReadyForTests,
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

describe('HNSW delete-repair under churn (Tier-2)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hnsw-'))
    _resetForTests()
    _setEmbeddingsAvailable(true)
    _setEmbedFnForTests(embed)
    _setHnswThresholdForTests(5) // engage HNSW at 5 vectors
    _setHnswYieldMsForTests(0)
    initSwarmMemory(tmp)
  })
  afterEach(() => {
    _setEmbedFnForTests(null)
    _resetForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('keeps the graph on light delete-churn (allow-filter), rebuilds only past the 15% threshold', async () => {
    const ids: string[] = []
    for (let i = 0; i < 20; i++) ids.push((await memoryWrite({ agentId: 'a', kind: 'fact', content: `memory number ${i} about topic ${i}` })).id)
    await memorySearch({ query: 'memory number 0 about topic 0', limit: 5 }) // kick the background build
    await _whenHnswSettledForTests()
    expect(_isHnswReadyForTests()).toBe(true)

    // 3 deletes of 20 = 15% — NOT over the threshold → graph stays fresh (allow-filter handles them).
    memoryDelete(ids[0]); memoryDelete(ids[1]); memoryDelete(ids[2])
    expect(_isHnswReadyForTests()).toBe(true)
    const afterLight = (await memorySearch({ query: 'memory number 0 about topic 0', limit: 10 })).map((h) => h.id)
    expect(afterLight).not.toContain(ids[0]) // deleted rows still excluded via the allow-filter

    // A 4th delete crosses >15% → the graph is marked stale for a repair rebuild.
    memoryDelete(ids[3])
    expect(_isHnswReadyForTests()).toBe(false)

    // Next search rebuilds it from the live rows (dead nodes gone) and results stay correct.
    await memorySearch({ query: 'memory number 5 about topic 5', limit: 5 })
    await _whenHnswSettledForTests()
    expect(_isHnswReadyForTests()).toBe(true)
    const afterRebuild = (await memorySearch({ query: 'memory number 0 about topic 0', limit: 10 })).map((h) => h.id)
    for (const d of [ids[0], ids[1], ids[2], ids[3]]) expect(afterRebuild).not.toContain(d)
  })
})
