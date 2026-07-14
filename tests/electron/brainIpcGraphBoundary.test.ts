// The exported brain must contain the REAL graph — the one in the memory process.
//
// brainIpc got half-ported in v1.26.0. The memories were repointed at memoryClient, under a comment
// spelling out exactly why ("importing them direct would export an EMPTY brain (and import into a
// store nothing reads). Silent, and the user would only find out when they restored it on the other
// machine"). The very next line then imported the GRAPH straight from './memoryGraph', which is the
// in-main singleton that initSwarmMemory — running in the CHILD — is the only thing that ever fills:
//
//     graphSnapshot: exportGraphEdges,   // "the graph is still in main — genuinely sync"
//
// It is not in main. So `buildBrainArchive` wrote a brain .zip with ZERO edges, and
// `mergeBrainArchive` fed a restored machine's edges into a graph nothing reads. Both silent, both
// exactly the failure the comment above them predicted, and the user finds out on the other machine.
//
// brainIpc.test.ts cannot catch this: it brings the client up `inProcess: true`, which collapses the
// two processes into one, so the ghost graph and the real graph are the SAME object and every
// assertion passes either way. Here both sides are mocked to be DISTINGUISHABLE — the client answers
// with the real edges, the in-main module answers with a ghost — so the zip's contents name which
// one brainIpc actually read.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

const client = vi.hoisted(() => ({
  exportMemorySnapshot: vi.fn(async () => '{"id":"m1","content":"real memory"}'),
  importMemorySnapshot: vi.fn(async () => ({ imported: 1 })),
  // Async: the graph is across a process boundary, exactly like the store.
  exportGraphEdges: vi.fn(async () => '{"from":"a","to":"b","relation":"explains"}'),
  importGraphEdges: vi.fn(async () => 7),
}))
vi.mock('../../src/main/memoryClient', () => client)

// The ghost. If brainIpc reads THIS, the edges it exports are whatever an uninitialised graph in the
// wrong process has to say — which in production is nothing at all.
const ghost = vi.hoisted(() => ({
  exportGraphEdges: vi.fn(() => '{"from":"GHOST","to":"GHOST","relation":"ghost"}'),
  importGraphEdges: vi.fn(() => 0),
}))
vi.mock('../../src/main/memoryGraph', () => ghost)

import { buildBrainArchive, mergeBrainArchive } from '../../src/main/brainIpc'
import { buildBrainZip } from '../../src/main/brainExport'
import { readZip } from '../../src/main/zipArchive'

const fsStub = { read: vi.fn(() => null), sizeOrZero: vi.fn(() => 0), write: vi.fn() }

beforeEach(() => { vi.clearAllMocks() })

describe('buildBrainArchive', () => {
  it('exports the graph from the MEMORY PROCESS, not the in-main ghost', async () => {
    const entries = readZip(await buildBrainArchive('/ud', '1.26.2', 123, fsStub))
    const graph = entries.find((e) => e.name === 'memory-graph.jsonl')!.data.toString('utf8')

    expect(client.exportGraphEdges).toHaveBeenCalled()
    expect(graph).toContain('explains')
    // The bug, stated as an assertion: a brain exported from the ghost carries no edges at all.
    expect(ghost.exportGraphEdges).not.toHaveBeenCalled()
    expect(graph).not.toContain('GHOST')
  })

  it('resolves the snapshot BEFORE zipping it — a Promise would serialize as "[object Promise]"', async () => {
    const entries = readZip(await buildBrainArchive('/ud', '1.26.2', 123, fsStub))
    const graph = entries.find((e) => e.name === 'memory-graph.jsonl')!.data.toString('utf8')
    expect(graph).not.toContain('[object Promise]')
    expect(graph).not.toContain('Promise')
  })
})

describe('mergeBrainArchive', () => {
  it('imports the edges INTO the memory process — a graph in main is a graph nothing reads', async () => {
    const zip = buildBrainZip({
      memorySnapshot: () => '{"id":"m9","content":"from the other machine"}',
      graphSnapshot: () => '{"from":"x","to":"y","relation":"follows"}',
      readFile: () => null,
      appVersion: '1.26.2',
      now: 123,
    })

    const res = await mergeBrainArchive('/ud', zip, fsStub)

    expect(client.importGraphEdges).toHaveBeenCalledWith(expect.stringContaining('follows'))
    expect(ghost.importGraphEdges).not.toHaveBeenCalled()
    // ...and the count the child reports is the count the user is shown. An un-awaited proxy would
    // put a Promise here and the restore would claim "[object Promise] edges imported".
    expect(res.edgesImported).toBe(7)
  })
})
