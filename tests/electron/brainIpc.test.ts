import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import { realBrainFs, buildBrainArchive, mergeBrainArchive } from '../../src/main/brainIpc'
import { readZip } from '../../src/main/zipArchive'
import { buildBrainZip } from '../../src/main/brainExport'
import { initSwarmMemory, memoryWrite, _resetForTests, _setEmbeddingsAvailable, _setEmbedFnForTests } from '../../src/main/swarmMemory'
import { initMemoryGraph, addMemoryEdge, _resetGraphForTests } from '../../src/main/memoryGraph'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainipc-'))
  _resetForTests()
  _resetGraphForTests()
  _setEmbedFnForTests(async () => null)
})
afterEach(() => {
  _resetForTests()
  _resetGraphForTests()
  vi.restoreAllMocks()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('realBrainFs', () => {
  it('reads/writes real files, reports size, and null/0 when absent', () => {
    const bf = realBrainFs()
    const p = path.join(dir, 'x.json')
    expect(bf.read(p)).toBeNull()
    expect(bf.sizeOrZero(p)).toBe(0)
    bf.write(p, Buffer.from('hello'))
    expect(bf.read(p)?.toString()).toBe('hello')
    expect(bf.sizeOrZero(p)).toBe(5)
  })
})

describe('buildBrainArchive / mergeBrainArchive', () => {
  it('builds a zip from the live stores + userData files read via the injected fs', async () => {
    initSwarmMemory(dir)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'x', kind: 'note', content: 'alpha', hash: 'ha' })
    initMemoryGraph(dir)
    addMemoryEdge({ from: 'a', to: 'b', relation: 'follows' })
    const bf = { read: vi.fn((p: string) => (p.includes('competence') ? Buffer.from('{"d":1}') : null)), sizeOrZero: vi.fn(), write: vi.fn() }
    const names = readZip(buildBrainArchive('/ud', '1.21.0', 123, bf)).map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['memory.jsonl', 'memory-graph.jsonl', 'mneme-competence.jsonl']))
    expect(bf.read).toHaveBeenCalledWith(expect.stringContaining('competence'))
  })

  it('merges a zip, restoring an absent file via the injected fs', () => {
    const zip = buildBrainZip({ memorySnapshot: () => '{"id":"m"}\n', graphSnapshot: () => '', readFile: (n) => (n === 'mneme-competence.jsonl' ? Buffer.from('C') : null), appVersion: 'x', now: 0 })
    initSwarmMemory(dir)
    _setEmbeddingsAvailable(false)
    initMemoryGraph(dir)
    const writes: string[] = []
    const bf = { read: vi.fn(), sizeOrZero: vi.fn((p: string) => (p.includes('competence') ? 0 : 9)), write: vi.fn((p: string) => { writes.push(p) }) }
    const res = mergeBrainArchive(dir, zip, bf)
    expect(res.ok).toBe(true)
    expect(writes.some((p) => p.includes('competence'))).toBe(true) // absent → restored
  })

  it('does not restore a file that already has content', () => {
    const zip = buildBrainZip({ memorySnapshot: () => '{"id":"m"}\n', graphSnapshot: () => '', readFile: (n) => (n === 'mneme-identity.jsonl' ? Buffer.from('I') : null), appVersion: 'x', now: 0 })
    initSwarmMemory(dir)
    _setEmbeddingsAvailable(false)
    initMemoryGraph(dir)
    const bf = { read: vi.fn(), sizeOrZero: vi.fn(() => 100), write: vi.fn() } // everything already present
    mergeBrainArchive(dir, zip, bf)
    expect(bf.write).not.toHaveBeenCalled()
  })
})
