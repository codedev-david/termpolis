import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'

// Verifies the Mneme typed-memory schema (memoryType / importance / originEpisode)
// added to the append-only store — that it persists, clamps, stays backward
// compatible, and round-trips through a JSONL reload (simulated restart).
describe('Mneme typed-memory schema on the store', () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-schema-'))
    _resetForTests()
    initSwarmMemory(tmpDir)
    _setEmbeddingsAvailable(false)
  })
  afterEach(() => {
    _resetForTests()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('persists memoryType / importance / originEpisode on write', async () => {
    const e = await memoryWrite({
      agentId: 'mneme',
      kind: 'fact',
      content: 'Lesson: guard nulls in store.ts',
      memoryType: 'procedural',
      importance: 0.9,
      originEpisode: 'task-42',
    })
    expect(e.memoryType).toBe('procedural')
    expect(e.importance).toBe(0.9)
    expect(e.originEpisode).toBe('task-42')
  })

  it('clamps importance into [0,1] and preserves 0', async () => {
    const hi = await memoryWrite({ agentId: 'm', kind: 'fact', content: 'too hot', importance: 1.5 })
    const lo = await memoryWrite({ agentId: 'm', kind: 'fact', content: 'too cold', importance: -0.2 })
    const zero = await memoryWrite({ agentId: 'm', kind: 'fact', content: 'exactly zero', importance: 0 })
    expect(hi.importance).toBe(1)
    expect(lo.importance).toBe(0)
    expect(zero.importance).toBe(0)
  })

  it('leaves the new fields undefined when not supplied (backward compatible)', async () => {
    const e = await memoryWrite({ agentId: 'm', kind: 'note', content: 'plain memory' })
    expect(e.memoryType).toBeUndefined()
    expect(e.importance).toBeUndefined()
    expect(e.originEpisode).toBeUndefined()
  })

  it('round-trips the new fields through a JSONL reload', async () => {
    await memoryWrite({
      agentId: 'mneme',
      kind: 'decision',
      content: 'Chose HNSW over brute force',
      memoryType: 'semantic',
      importance: 0.75,
      originEpisode: 'task-7',
    })
    // Simulate a restart: drop in-memory state, reload from the same on-disk shard.
    _resetForTests()
    initSwarmMemory(tmpDir)
    _setEmbeddingsAvailable(false)
    const reloaded = memoryList({ limit: 100 }).find((m) => m.content === 'Chose HNSW over brute force')
    expect(reloaded).toBeDefined()
    expect(reloaded!.memoryType).toBe('semantic')
    expect(reloaded!.importance).toBe(0.75)
    expect(reloaded!.originEpisode).toBe('task-7')
  })
})
