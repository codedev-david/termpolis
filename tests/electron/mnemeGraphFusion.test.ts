import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initSwarmMemory,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  memoryWrite,
  memoryLink,
  memorySearch,
} from '../../src/main/swarmMemory'

// One-hot 384-dim unit vectors: vec384(1) and vec384(50) are orthogonal (cosine 0).
function vec384(seed: number): number[] {
  const v = new Array(384).fill(0)
  v[((seed % 384) + 384) % 384] = 1
  return v
}

describe('graph fusion in agent recall (fuseGraph)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuse-'))
    _resetForTests()
    initSwarmMemory(dir)
    _setEmbeddingsAvailable(true)
  })
  afterEach(() => {
    _resetForTests()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('surfaces a graph-connected neighbour that plain vector recall excludes', async () => {
    // A matches the query; B is orthogonal (plain recall drops it). A→B are linked, so
    // graph fusion should pull B in one hop — the connection reaching everyday recall.
    _setEmbedFnForTests(async (t: string) =>
      t.includes('apple') ? vec384(1) : t.includes('zebra') ? vec384(50) : vec384(1),
    )
    const A = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'apple pie recipe notes' })
    const B = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'zebra crossing safety notes' })
    memoryLink({ from: A.id, to: B.id, relation: 'relates-to', weight: 0.9 })

    const has = (hits: Array<{ id: string }>, id: string): boolean => hits.some((h) => h.id === id)

    const plain = await memorySearch({ query: 'apple query', limit: 10 })
    expect(has(plain, A.id)).toBe(true)
    expect(has(plain, B.id)).toBe(false) // orthogonal → gated out of plain recall

    const fused = await memorySearch({ query: 'apple query', limit: 10, fuseGraph: true })
    expect(has(fused, A.id)).toBe(true)
    expect(has(fused, B.id)).toBe(true) // pulled in one hop along the A→B edge
  })

  it('is byte-identical to plain recall when there are no edges', async () => {
    _setEmbedFnForTests(async () => vec384(1))
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'lonely memory' })
    const plain = await memorySearch({ query: 'q', limit: 10 })
    const fused = await memorySearch({ query: 'q', limit: 10, fuseGraph: true })
    expect(fused.map((h) => h.id)).toEqual(plain.map((h) => h.id))
  })
})
