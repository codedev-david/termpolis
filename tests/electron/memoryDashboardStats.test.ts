import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initSwarmMemory,
  _resetForTests,
  _setEmbeddingsAvailable,
  memoryWrite,
  memoryDashboardStats,
  memorySourceById,
} from '../../src/main/swarmMemory'

describe('memoryDashboardStats — store composition for the dashboard', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-dash-'))
    _resetForTests()
    _setEmbeddingsAvailable(false)
    initSwarmMemory(dir)
  })
  afterEach(() => {
    _resetForTests()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports zero on an empty store', () => {
    const s = memoryDashboardStats()
    expect(s.total).toBe(0)
    expect(s.lessons).toBe(0)
    expect(s.byType).toEqual({})
    expect(s.bySource).toEqual({})
    expect(s.capacity).toBeGreaterThan(0)
  })

  it('counts memories by cognitive type and source, and totals lessons', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'raw transcript chunk one', source: 'claude', memoryType: 'episodic' })
    await memoryWrite({ agentId: 'mneme', kind: 'fact', content: 'a distilled semantic fact', source: 'mneme', memoryType: 'semantic' })
    await memoryWrite({ agentId: 'mneme', kind: 'fact', content: 'a reusable procedural recipe', source: 'mneme', memoryType: 'procedural' })
    await memoryWrite({ agentId: 'b', kind: 'note', content: 'a codex note here', source: 'codex', memoryType: 'episodic' })
    const s = memoryDashboardStats()
    expect(s.total).toBe(4)
    expect(s.byType.episodic).toBe(2)
    expect(s.byType.semantic).toBe(1)
    expect(s.byType.procedural).toBe(1)
    expect(s.bySource.claude).toBe(1)
    expect(s.bySource.codex).toBe(1)
    expect(s.bySource.mneme).toBe(2)
    expect(s.lessons).toBe(2)
  })

  it('buckets untyped memories under "untyped" and falls back to agentId for source', async () => {
    await memoryWrite({ agentId: 'gizmo', kind: 'note', content: 'legacy chunk with no cognitive type' })
    const s = memoryDashboardStats()
    expect(s.byType.untyped).toBe(1)
    expect(s.bySource.gizmo).toBe(1)
  })

  it('memorySourceById returns the authoring source, preferring source over agentId', async () => {
    const e = await memoryWrite({ agentId: 'claude-term', kind: 'fact', content: 'a lesson authored by gemini', source: 'gemini' })
    expect(memorySourceById(e.id)).toBe('gemini')
  })

  it('memorySourceById falls back to the writer agentId when no source', async () => {
    const e = await memoryWrite({ agentId: 'codex', kind: 'note', content: 'a note with no provenance source' })
    expect(memorySourceById(e.id)).toBe('codex')
  })

  it('memorySourceById returns undefined for an unknown id', () => {
    expect(memorySourceById('mem-does-not-exist')).toBeUndefined()
  })
})
