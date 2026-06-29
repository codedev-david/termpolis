import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryRelated,
  memoryLink,
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

  it('QW6: surfaces an explicitly-linked neighbour with zero content overlap, carrying its relation', async () => {
    const a = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'the auth bug repro steps' })
    const b = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'totally unrelated zebra giraffe content' })
    memoryLink({ from: a.id, to: b.id, relation: 'solved-by' })
    const related = await memoryRelated({ id: a.id, limit: 5 })
    const hit = related.find(r => r.id === b.id)
    expect(hit).toBeTruthy()                       // the edge surfaces it despite no keyword overlap
    expect(hit!.relation).toBe('solved-by')        // and the relation is surfaced
  })

  it('QW6: a default-weight link does not outrank a strong vector/keyword neighbour', async () => {
    const a = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'kubernetes docker deploy pipeline' })
    const strong = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'kubernetes docker deploy pipeline runbook' })
    const linked = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'unrelated xyzzy content' })
    memoryLink({ from: a.id, to: linked.id, relation: 'relates-to' }) // weight defaults to 1 → saturates to 0.5
    const related = await memoryRelated({ id: a.id, limit: 5 })
    const strongRank = related.findIndex(r => r.id === strong.id)
    const linkedRank = related.findIndex(r => r.id === linked.id)
    expect(strongRank).toBeGreaterThanOrEqual(0)
    expect(linkedRank).toBeGreaterThanOrEqual(0)
    expect(strongRank).toBeLessThan(linkedRank) // strong keyword hit (1.0) beats the default link (0.5)
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
