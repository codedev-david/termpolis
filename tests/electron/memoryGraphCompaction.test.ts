import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initMemoryGraph,
  graphStats,
  compactGraphLog,
  GRAPH_COMPACT_MIN_BYTES,
  GRAPH_COMPACT_MIN_RATIO,
  _resetGraphForTests,
} from '../../src/main/memoryGraph'

// memory-graph.jsonl is a pure append-only log with NO compaction, rotation, size cap or
// dedup-on-load rewrite. The only thing that has ever truncated it is memoryClear(). Every
// re-link of the same pair appends another line, and the load path dedups them in memory — so the
// live graph is small while the file grows forever. On this machine it reached 115 MB.
//
// That is not just disk. It is on the launch path: every start streams and JSON.parses the whole
// log to rebuild an adjacency map that the file could have described in a fraction of the lines.
//
// The in-memory graph after load IS the truth — tombstones applied, duplicates collapsed, weights
// resolved — so compaction is just writing that back out.

const bigEnough = GRAPH_COMPACT_MIN_BYTES + 1024

function edgeLine(from: string, to: string, i: number): string {
  return JSON.stringify({ from, to, relation: 'relates-to', weight: 0.5, ts: 1_700_000_000_000 + i }) + '\n'
}

/** A log whose live edge count is tiny relative to its line count — the real shape of the problem. */
function writeRedundantLog(path: string, distinct: number): void {
  let out = ''
  let i = 0
  while (out.length < bigEnough) {
    for (let d = 0; d < distinct; d++) out += edgeLine(`a${d}`, `b${d}`, i++)
  }
  writeFileSync(path, out)
}

describe('memory-graph compaction — the log stops being unbounded', () => {
  let dir: string
  let graph: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graphcompact-'))
    graph = join(dir, 'memory-graph.jsonl')
    _resetGraphForTests()
  })

  afterEach(() => {
    _resetGraphForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rewrites a grossly redundant log down to its live edges', () => {
    writeRedundantLog(graph, 4)
    const before = statSync(graph).size
    initMemoryGraph(dir)
    expect(graphStats().edges).toBe(4)

    expect(compactGraphLog()).toBe(true)
    expect(statSync(graph).size).toBeLessThan(before / 10)
  })

  it('loses no edge — the whole point is that the graph is unchanged', () => {
    writeRedundantLog(graph, 4)
    initMemoryGraph(dir)
    const before = graphStats()

    compactGraphLog()
    _resetGraphForTests()
    initMemoryGraph(dir)

    expect(graphStats()).toEqual(before)
  })

  it('leaves a small log alone — rewriting it buys nothing and risks something', () => {
    writeFileSync(graph, edgeLine('a', 'b', 0) + edgeLine('a', 'b', 1))
    initMemoryGraph(dir)
    expect(compactGraphLog()).toBe(false)
    expect(readFileSync(graph, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('leaves a big log alone when it is already dense', () => {
    // Size is not the trigger — redundancy is. A large graph that genuinely holds a large number
    // of distinct edges has nothing to collapse, and rewriting it is pure risk.
    let out = ''
    let i = 0
    while (out.length < bigEnough) out += edgeLine(`n${i}`, `m${i}`, i++)
    writeFileSync(graph, out)
    initMemoryGraph(dir)
    expect(graphStats().edges).toBe(i)
    expect(compactGraphLog()).toBe(false)
  })

  it('aborts when the file changed under it — another process may have appended', () => {
    // initMemoryGraph runs in the memory utilityProcess AND in main. If one compacts from a
    // snapshot the other has since appended to, the rename drops those edges. Comparing the size
    // seen at load against the size at rewrite is the cheap guard that makes that impossible.
    writeRedundantLog(graph, 4)
    initMemoryGraph(dir)
    appendFileSync(graph, edgeLine('late', 'arrival', 9999))

    expect(compactGraphLog()).toBe(false)
    expect(readFileSync(graph, 'utf8')).toContain('"late"')
  })

  it('does nothing before a graph has been opened', () => {
    expect(compactGraphLog()).toBe(false)
  })

  it('survives an unwritable path rather than taking the launch down with it', () => {
    writeRedundantLog(graph, 4)
    initMemoryGraph(dir)
    rmSync(dir, { recursive: true, force: true })
    expect(() => compactGraphLog()).not.toThrow()
  })

  it('exposes a ratio worth honouring', () => {
    // Documented as a constant rather than a magic number: below this, the rewrite costs more
    // than it saves.
    expect(GRAPH_COMPACT_MIN_RATIO).toBeGreaterThanOrEqual(2)
  })
})
