import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryRelated,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'

// Force keyword mode (embed → null) so scoring is deterministic and unrelated
// entries score exactly 0 (in vector mode everything gets a small positive cosine).
let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-related-cache-'))
  _resetForTests()
  _setEmbeddingsAvailable(false)
  _setEmbedFnForTests(async () => null)
  initSwarmMemory(tmp)
})
afterEach(() => {
  _resetForTests()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('memoryRelated — 1-hop traversal (connected memory)', () => {
  it('by id: returns entries connected to the source, never the source itself', async () => {
    const a = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'deploy pipeline uses docker and kubernetes' })
    await memoryWrite({ agentId: 'claude', kind: 'note', content: 'docker kubernetes deploy runbook notes' })
    await memoryWrite({ agentId: 'claude', kind: 'note', content: 'favorite lunch spot is downtown' })
    const related = await memoryRelated({ id: a.id, limit: 5 })
    expect(related.some(r => r.id === a.id)).toBe(false) // never returns itself
    expect(related.some(r => r.content.includes('runbook'))).toBe(true) // the connected neighbour
    expect(related.some(r => r.content.includes('lunch'))).toBe(false) // unrelated entry excluded
  })

  it('by query: behaves like a semantic search', async () => {
    await memoryWrite({ agentId: 'claude', kind: 'note', content: 'docker kubernetes deploy runbook' })
    const related = await memoryRelated({ query: 'kubernetes deploy', limit: 5 })
    expect(related.length).toBeGreaterThan(0)
  })

  it('returns [] for an unknown id or empty input', async () => {
    expect(await memoryRelated({ id: 'does-not-exist' })).toEqual([])
    expect(await memoryRelated({})).toEqual([])
  })
})

describe('memorySearch — result cache (fast repeated recall, never stale)', () => {
  it('returns the SAME result reference for an identical repeated search (cache hit)', async () => {
    await memoryWrite({ agentId: 'claude', kind: 'note', content: 'docker kubernetes deploy' })
    const r1 = await memorySearch({ query: 'docker' })
    const r2 = await memorySearch({ query: 'docker' })
    expect(r1).toBe(r2) // same array → served from cache, not recomputed
  })

  it('invalidates the cache on a new write (no stale results)', async () => {
    await memoryWrite({ agentId: 'claude', kind: 'note', content: 'docker one' })
    const r1 = await memorySearch({ query: 'docker' })
    expect(r1).toHaveLength(1)
    await memoryWrite({ agentId: 'claude', kind: 'note', content: 'docker two' })
    const r2 = await memorySearch({ query: 'docker' })
    expect(r2.length).toBeGreaterThan(r1.length) // sees the newly-written entry
    expect(r2).not.toBe(r1) // fresh array, not the cached one
  })
})
