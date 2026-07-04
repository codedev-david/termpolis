import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initSwarmMemory,
  _resetForTests,
  _setEmbeddingsAvailable,
  memoryWrite,
  memoryLink,
  memoryDashboardStats,
  memoryGraphSample,
  memoryRecentActivity,
  embeddingsReady,
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

  it('infers a cognitive type for untyped legacy memories (never "untyped") and falls back to agentId for source', async () => {
    // A code chunk (source 'code') → entity; a bare curated note → semantic; a
    // transcript message → episodic. Nothing lands in an "untyped" bucket anymore.
    await memoryWrite({ agentId: 'code-index', kind: 'note', content: 'C:\\x.ts:1-3\ncode', source: 'code' })
    await memoryWrite({ agentId: 'gizmo', kind: 'note', content: 'a curated convention with no cognitive type' })
    await memoryWrite({ agentId: 'claude-history', kind: 'message', content: 'user: hi', source: 'claude' })
    const s = memoryDashboardStats()
    expect(s.byType.untyped).toBeUndefined()
    expect(s.byType.entity).toBe(1)
    expect(s.byType.semantic).toBe(1)
    expect(s.byType.episodic).toBe(1)
    expect(s.bySource.gizmo).toBe(1) // no source → falls back to agentId
    expect(s.lessons).toBe(1) // the semantic note counts as a lesson; entity/episodic do not
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

  it('memoryGraphSample returns a labeled, type-colored subgraph of the real connections', async () => {
    const a = await memoryWrite({ agentId: 'code-index', kind: 'note', content: 'C:\\app\\index.ts:1-9\nconst x = 1', source: 'code' })
    const b = await memoryWrite({ agentId: 'claude-history', kind: 'message', content: 'user: how does recall work', source: 'claude' })
    memoryLink({ from: a.id, to: b.id, relation: 'relates-to' })
    const g = memoryGraphSample({ limit: 50 })
    expect(g.totalEdges).toBeGreaterThanOrEqual(1)
    expect(g.nodes.length).toBeGreaterThanOrEqual(2)
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]))
    expect(byId[a.id].type).toBe('entity') // code → entity
    expect(byId[a.id].label).toContain('index.ts:1-9')
    expect(byId[b.id].type).toBe('episodic') // message → episodic
    expect(g.edges).toEqual(expect.arrayContaining([{ from: a.id, to: b.id, relation: 'relates-to' }]))
  })

  it('memoryRecentActivity labels recent ops by provenance, newest first', async () => {
    await memoryWrite({ agentId: 'code-index', kind: 'note', content: 'C:\\a.ts:1-2\nx', source: 'code' })
    await memoryWrite({ agentId: 'claude-history', kind: 'message', content: 'user: hi', source: 'claude' })
    const rows = memoryRecentActivity(10)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.some((r) => r.op === 'index')).toBe(true) // code artifact
    expect(rows.some((r) => r.op === 'ingest')).toBe(true) // transcript message
    expect(rows[0].ts).toBeGreaterThanOrEqual(rows[rows.length - 1].ts)
  })

  it('embeddingsReady reflects embedder availability (unknown → assumed up)', () => {
    _setEmbeddingsAvailable(false)
    expect(embeddingsReady()).toBe(false)
    _setEmbeddingsAvailable(null)
    expect(embeddingsReady()).toBe(true)
  })
})
