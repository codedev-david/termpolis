// The brain export/import merge at the store level: a snapshot from brain A re-imports into a
// fresh brain B (full restore) and unions into an existing brain B (never clobbering).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  exportMemorySnapshot,
  importMemorySnapshot,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'
import { initMemoryGraph, addMemoryEdge, getAllEdges, exportGraphEdges, importGraphEdges, _resetGraphForTests } from '../../src/main/memoryGraph'

let dirA: string
let dirB: string
beforeEach(() => {
  dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-a-'))
  dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-b-'))
  _resetForTests()
  _resetGraphForTests()
  _setEmbedFnForTests(async () => null)
})
afterEach(() => {
  _resetForTests()
  _resetGraphForTests()
  vi.restoreAllMocks()
  for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

describe('memory snapshot export → import', () => {
  it('restores a full brain into a fresh machine', async () => {
    initSwarmMemory(dirA)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'x', kind: 'note', content: 'alpha memory', hash: 'ha' })
    await memoryWrite({ agentId: 'x', kind: 'note', content: 'bravo memory', hash: 'hb' })
    const snap = exportMemorySnapshot()
    expect(snap).toContain('alpha memory')

    _resetForTests()
    _setEmbedFnForTests(async () => null)
    initSwarmMemory(dirB) // fresh, empty
    _setEmbeddingsAvailable(false)
    const res = importMemorySnapshot(snap)
    expect(res.imported).toBe(2)
    expect(memoryList().map((e) => e.content).sort()).toEqual(['alpha memory', 'bravo memory'])
  })

  it('is ADDITIVE — unions into an existing brain, clobbering nothing', async () => {
    initSwarmMemory(dirA)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'x', kind: 'note', content: 'from A', hash: 'ha' })
    const snap = exportMemorySnapshot()

    _resetForTests()
    _setEmbedFnForTests(async () => null)
    initSwarmMemory(dirB)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'y', kind: 'note', content: 'from B', hash: 'hb' })
    importMemorySnapshot(snap)
    expect(memoryList().map((e) => e.content).sort()).toEqual(['from A', 'from B']) // both survive
  })

  it('dedups a re-import of the same snapshot (grow-only union)', async () => {
    initSwarmMemory(dirA)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'x', kind: 'note', content: 'once', hash: 'h1' })
    const snap = exportMemorySnapshot()
    importMemorySnapshot(snap) // re-import into the SAME brain
    expect(memoryList().filter((e) => e.content === 'once')).toHaveLength(1) // not duplicated
  })
})

describe('graph edge export → import', () => {
  it('round-trips + merges edges into another graph', () => {
    initMemoryGraph(dirA)
    addMemoryEdge({ from: 'a', to: 'b', relation: 'follows', weight: 1 })
    addMemoryEdge({ from: 'b', to: 'c', relation: 'solves' })
    const snap = exportGraphEdges()

    _resetGraphForTests()
    initMemoryGraph(dirB)
    expect(importGraphEdges(snap)).toBe(2)
    const edges = getAllEdges()
    expect(edges.some((e) => e.from === 'a' && e.to === 'b')).toBe(true)
    expect(edges.some((e) => e.from === 'b' && e.to === 'c')).toBe(true)
  })

  it('skips malformed edge lines without failing', () => {
    initMemoryGraph(dirB)
    expect(importGraphEdges('not json\n{"from":"a","to":"b"}\n{"from":"only-from"}')).toBe(1)
  })
})
