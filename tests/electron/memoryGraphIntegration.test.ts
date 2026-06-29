import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory, memoryWrite, memoryLink, memoryGraphQuery,
  _resetForTests, _setEmbeddingsAvailable, _setEmbedFnForTests,
} from '../../src/main/swarmMemory'
import { graphStats } from '../../src/main/memoryGraph'
import { EMBED_DIM } from '../../src/main/localEmbedder'

let tmp: string

describe('knowledge graph — explicit links + traversal (keyword mode)', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-graph-int-'))
    _resetForTests()
    _setEmbeddingsAvailable(false)
    _setEmbedFnForTests(async () => null) // deterministic keyword scoring
    initSwarmMemory(tmp)
  })
  afterEach(() => { _resetForTests(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('memory_link records a typed edge and memory_graph follows the chain (bug → fix → detail)', async () => {
    const a = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'login returns 500 on an expired token' })
    const b = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'refresh the token before the API call' })
    const c = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'token refresh added to the auth interceptor' })
    memoryLink({ from: a.id, to: b.id, relation: 'solved-by' })
    memoryLink({ from: b.id, to: c.id, relation: 'part-of' })
    const chain = await memoryGraphQuery({ id: a.id, depth: 2 })
    expect(chain.map(r => r.content)).toEqual([
      'refresh the token before the API call',
      'token refresh added to the auth interceptor',
    ])
    expect(chain[0].relation).toBe('solved-by')
    expect(chain[0].distance).toBe(1)
    expect(chain[1].distance).toBe(2)
  })

  it('memory_graph can seed from a query instead of an id', async () => {
    const a = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'docker build is slow on CI' })
    const b = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'enable buildkit cache to speed it up' })
    memoryLink({ from: a.id, to: b.id, relation: 'solved-by' })
    const chain = await memoryGraphQuery({ query: 'docker build slow', depth: 1 })
    expect(chain.some(r => r.content.includes('buildkit'))).toBe(true)
  })

  it('returns [] for an unknown seed or empty input', async () => {
    expect(await memoryGraphQuery({ id: 'does-not-exist' })).toEqual([])
    expect(await memoryGraphQuery({})).toEqual([])
  })

  it('self-loops and missing endpoints are rejected by memory_link', () => {
    expect(memoryLink({ from: 'x', to: 'x' })).toBeNull()
    expect(memoryLink({ from: '', to: 'y' })).toBeNull()
  })

  it('QW5: a very stale edge decays below EDGE_EPSILON and drops out of traversal', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2020-01-01T00:00:00Z')) // link created far in the past
      const a = await memoryWrite({ agentId: 'a', kind: 'note', content: 'ancient cause node' })
      const b = await memoryWrite({ agentId: 'a', kind: 'note', content: 'ancient effect node' })
      memoryLink({ from: a.id, to: b.id, relation: 'causes' })
      // Fresh: the edge is brand-new, so it traverses normally.
      expect((await memoryGraphQuery({ id: a.id, depth: 1 })).map(r => r.content)).toEqual(['ancient effect node'])
      // Six years later the 90-day-half-life weight has decayed ~24 half-lives → ~0 → dropped.
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      expect(await memoryGraphQuery({ id: a.id, depth: 1 })).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('knowledge graph — auto-link grows the graph as you work (with embeddings)', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-graph-auto-'))
    _resetForTests()
    _setEmbeddingsAvailable(true)
    // A fixed unit vector for every entry → all are "neighbours" (deterministic).
    _setEmbedFnForTests(async () => new Array(EMBED_DIM).fill(1 / Math.sqrt(EMBED_DIM)))
    initSwarmMemory(tmp)
  })
  afterEach(() => { _resetForTests(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('auto-links curated writes (decision/fact/result) to their neighbours', async () => {
    await memoryWrite({ agentId: 'claude', kind: 'decision', content: 'we use HNSW for vector search' })
    await memoryWrite({ agentId: 'claude', kind: 'decision', content: 'we cap the hot window at 500k entries' })
    await memoryWrite({ agentId: 'claude', kind: 'fact', content: 'embeddings are 384-dim bge-small' })
    expect(graphStats().edges).toBeGreaterThan(0) // the graph grew on its own
  })

  it('does NOT auto-link low-signal kinds (note / message)', async () => {
    await memoryWrite({ agentId: 'claude', kind: 'note', content: 'a passing remark' })
    await memoryWrite({ agentId: 'claude', kind: 'message', content: 'a transcript line' })
    expect(graphStats().edges).toBe(0)
  })

  it('auto-links via the legacy (non-packed) embedding path too', async () => {
    _setEmbedFnForTests(async () => [1, 1, 0, 0]) // 4-dim → retained on the entry, never packed
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'first legacy fact' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'second legacy fact' })
    expect(graphStats().edges).toBeGreaterThan(0)
  })
})
