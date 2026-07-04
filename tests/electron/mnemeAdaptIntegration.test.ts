import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initSwarmMemory,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _setAdaptForTests,
  memoryWrite,
  memoryFeedback,
  memorySearch,
} from '../../src/main/swarmMemory'

// A 384-dim unit vector with only the first two dims set (rest 0), so we can place
// memories at chosen angles: V(1,0) and V(0,1) are orthogonal; V(1,1) sits at 45°.
function V(x: number, y: number): number[] {
  const v = new Array(384).fill(0)
  const n = Math.hypot(x, y) || 1
  v[0] = x / n
  v[1] = y / n
  return v
}

describe('mnemeAdapt integration — taste boost reorders recall toward reinforced content', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-int-'))
    _resetForTests()
    initSwarmMemory(dir)
    _setEmbeddingsAvailable(true)
  })
  afterEach(() => {
    _setAdaptForTests(false)
    _resetForTests()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is a no-op when OFF (default) and lifts on-taste hits above equal-relevance off-taste hits when ON', async () => {
    // The reinforced "seed" and hit A both point at [1,0]; hit B is orthogonal [0,1].
    // The query sits at 45°, so A and B have EQUAL base relevance to it — the only thing
    // that can separate them is the taste boost toward the reinforced centroid.
    _setEmbedFnForTests(async (t: string) => {
      if (t.includes('seed')) return V(1, 0)
      if (t.includes('aligned')) return V(1, 0)
      if (t.includes('orthogonal')) return V(0, 1)
      return V(1, 1) // the query
    })
    // Explicit, distinct timestamps (B newest) so the recency tie-break in ranking is
    // deterministic. Without them, three sub-millisecond writes can share one Date.now()
    // value; the equal-relevance sort then falls back to insertion order and the
    // B-before-A baseline flakes across platforms (passed on Windows, failed on macOS CI).
    const t = Date.now()
    const seed = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'reinforced seed memory', ts: t - 20 })
    const A = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'aligned hit memory', ts: t - 10 })
    const B = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'orthogonal hit memory', ts: t })
    memoryFeedback({ id: seed.id, helpful: true }) // reinforce the seed → interest centroid ≈ [1,0]

    const idxOf = (hits: Array<{ id: string }>, id: string): number => hits.findIndex((h) => h.id === id)

    _setAdaptForTests(false)
    const off = await memorySearch({ query: 'q', limit: 10 })
    expect(idxOf(off, A.id)).toBeGreaterThanOrEqual(0)
    expect(idxOf(off, B.id)).toBeGreaterThanOrEqual(0)
    // Equal base relevance → the newer write (B) leads A purely on the recency tie-break.
    expect(idxOf(off, B.id)).toBeLessThan(idxOf(off, A.id))

    _setAdaptForTests(true)
    const on = await memorySearch({ query: 'q', limit: 10 })
    // A is on-taste (aligned with the reinforced centroid); B is off-taste → A now leads B.
    expect(idxOf(on, A.id)).toBeLessThan(idxOf(on, B.id))
  })
})
