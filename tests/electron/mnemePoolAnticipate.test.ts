import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executeTool, type McpToolHandlers } from '../../src/main/mcpServer'
import { poolLessons } from '../../src/main/mnemeSociety'
import { proactiveQuery } from '../../src/main/mnemeRetrieval'
import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryList,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

describe('memory_pool + memory_anticipate — MCP dispatch', () => {
  it('routes both tools through their handlers with the right args', async () => {
    const memoryPool = vi.fn().mockReturnValue([{ content: 'x', sources: ['a', 'b'], corroboration: 2, importance: 0.8 }])
    const memoryAnticipate = vi.fn().mockResolvedValue([{ id: 'm1' }])
    const handlers = { memoryPool, memoryAnticipate } as unknown as McpToolHandlers
    const pooled = await executeTool('memory_pool', { limit: 50 }, handlers)
    expect(pooled).toHaveLength(1)
    expect(memoryPool).toHaveBeenCalledWith({ limit: 50 })
    await executeTool('memory_anticipate', { task: 'fix the build', limit: 3 }, handlers)
    expect(memoryAnticipate).toHaveBeenCalledWith({ task: 'fix the build', limit: 3 })
  })
})

describe('society pooling + proactive recall over the real store', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-pool-'))
    _resetForTests()
    initSwarmMemory(tmp)
    _setEmbeddingsAvailable(false)
  })
  afterEach(() => {
    _resetForTests()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('corroborates a lesson two different agents independently learned', async () => {
    // Different exact wording (so they are not content-hash-deduped) but the same
    // normalized key → society pools them across sources.
    await memoryWrite({ agentId: 'claude', source: 'claude', kind: 'fact', content: 'Always guard nulls in store.ts', memoryType: 'procedural', importance: 0.7 })
    await memoryWrite({ agentId: 'codex', source: 'codex', kind: 'fact', content: 'always guard nulls in store.ts.', memoryType: 'procedural', importance: 0.6 })

    const lessons = memoryList({ limit: 200 })
      .filter((m) => m.memoryType === 'semantic' || m.memoryType === 'procedural')
      .map((m) => ({ source: m.source || m.agentId || 'unknown', content: m.content, memoryType: m.memoryType, importance: m.importance }))
    const pooled = poolLessons(lessons)
    const corroborated = pooled.find((p) => p.corroboration >= 2)
    expect(corroborated).toBeDefined()
    expect(corroborated!.sources).toEqual(expect.arrayContaining(['claude', 'codex']))
    expect(corroborated!.importance).toBeGreaterThan(0.7) // boosted for cross-agent agreement
  })

  it('anticipates a past solution from a new, differently-worded task', async () => {
    await memoryWrite({ agentId: 'm', kind: 'fact', content: 'Problem: Error ETIMEDOUT on request → Fix: added a retry in client.ts', memoryType: 'procedural', importance: 0.8 })
    const q = proactiveQuery('the request keeps failing with ETIMEDOUT, probably in client.ts')
    expect(q).not.toBe('')
    const hits = await memorySearch({ query: q, limit: 5 })
    const surfaced = hits.filter((h) => h.memoryType === 'procedural' || (h.importance ?? 0) >= 0.6)
    expect(surfaced.some((h) => h.content.includes('ETIMEDOUT'))).toBe(true)
  })
})
