import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import { realBrainFs, buildBrainArchive, mergeBrainArchive } from '../../src/main/brainIpc'
import { readZip } from '../../src/main/zipArchive'
import { buildBrainZip } from '../../src/main/brainExport'
import { memoryWrite, _resetForTests, _setEmbeddingsAvailable, _setEmbedFnForTests } from '../../src/main/swarmMemory'
import { startMemoryHost, _resetMemoryClientForTests } from '../../src/main/memoryClient'
import { initMemoryGraph, addMemoryEdge, _resetGraphForTests } from '../../src/main/memoryGraph'

// v1.26: brainIpc reaches the store through memoryClient, not swarmMemory. `inProcess: true` brings
// the SAME in-process singleton up behind the proxy, so these tests keep exercising the real store —
// against an EMPTY one every assertion below would pass vacuously, which is the bug being prevented.
let dir: string
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainipc-'))
  _resetForTests()
  _resetGraphForTests()
  _resetMemoryClientForTests()
  _setEmbedFnForTests(async () => null)
  await startMemoryHost({ userDataPath: dir, inProcess: true })
  _setEmbeddingsAvailable(false)
})
afterEach(() => {
  _resetMemoryClientForTests()
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
    await memoryWrite({ agentId: 'x', kind: 'note', content: 'alpha', hash: 'ha' })
    initMemoryGraph(dir)
    addMemoryEdge({ from: 'a', to: 'b', relation: 'follows' })
    const bf = { read: vi.fn((p: string) => (p.includes('competence') ? Buffer.from('{"d":1}') : null)), sizeOrZero: vi.fn(), write: vi.fn() }
    const entries = readZip(await buildBrainArchive('/ud', '1.21.0', 123, bf))
    expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining(['memory.jsonl', 'memory-graph.jsonl', 'mneme-competence.jsonl']))
    expect(bf.read).toHaveBeenCalledWith(expect.stringContaining('competence'))
    // The snapshot is the REAL store's, not an empty in-main one — the whole point of the repoint.
    expect(entries.find((e) => e.name === 'memory.jsonl')!.data.toString('utf8')).toContain('alpha')
  })

  it('merges a zip, restoring an absent file via the injected fs', async () => {
    const zip = buildBrainZip({ memorySnapshot: () => ['{"id":"m"}'], graphSnapshot: () => '', readFile: (n) => (n === 'mneme-competence.jsonl' ? Buffer.from('C') : null), appVersion: 'x', now: 0 })
    initMemoryGraph(dir)
    const writes: string[] = []
    const bf = { read: vi.fn(), sizeOrZero: vi.fn((p: string) => (p.includes('competence') ? 0 : 9)), write: vi.fn((p: string) => { writes.push(p) }) }
    const res = await mergeBrainArchive(dir, zip, bf)
    expect(res.ok).toBe(true)
    expect(writes.some((p) => p.includes('competence'))).toBe(true) // absent → restored
  })

  it('does not restore a file that already has content', async () => {
    const zip = buildBrainZip({ memorySnapshot: () => ['{"id":"m"}'], graphSnapshot: () => '', readFile: (n) => (n === 'mneme-identity.jsonl' ? Buffer.from('I') : null), appVersion: 'x', now: 0 })
    initMemoryGraph(dir)
    const bf = { read: vi.fn(), sizeOrZero: vi.fn(() => 100), write: vi.fn() } // everything already present
    await mergeBrainArchive(dir, zip, bf)
    expect(bf.write).not.toHaveBeenCalled()
  })
})
