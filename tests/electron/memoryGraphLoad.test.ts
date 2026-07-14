// initMemoryGraph — the load path, after the v1.25.17 rewrite that took it from 10.4 s to
// 110 ms on the real 23,587-line graph log (94x, provably identical output).
//
// The rewrite replaced two quadratics:
//   1. `removeIncidentInMemory` swept the ENTIRE adjacency map per {removeNode} marker (and the
//      real log has 1,625 of them). It now asks `reverseAdjacency` — an index that already
//      existed and answers "who points at this node?" in O(1) — instead.
//   2. `upsertEdge` re-sorted a node's whole list on every insert; the bulk load now defers the
//      sort and does it once at the end.
//
// Going from "sweep everything" to "trust the reverse index" is exactly the kind of change that
// is fast and subtly wrong: the sweep was robust to an inconsistent reverse index, and the new
// code is not. So these tests hammer the seams where an incomplete reverse index would show —
// self-loops, several relations between one pair, a source node appearing repeatedly, and
// undirected traversal (which READS the reverse index) after a load full of markers.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initMemoryGraph, getAllEdges, graphStats, edgesFrom, neighboursOf, traverseGraph, clearMemoryGraph,
} from '../../src/main/memoryGraph'

let tmp: string

/** Write a raw graph log and load it — exactly what launch does. */
function loadLog(lines: object[]): void {
  fs.writeFileSync(path.join(tmp, 'memory-graph.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  initMemoryGraph(tmp)
}

const edge = (from: string, to: string, relation = 'relates-to', weight = 0.5, ts = 1000): object =>
  ({ from, to, relation, weight, ts })

describe('initMemoryGraph — the load path (94x rewrite)', () => {
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-load-')) })
  afterEach(() => { clearMemoryGraph(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('applies {removeNode} in APPEND ORDER — edges re-added afterwards survive it', () => {
    loadLog([
      edge('a', 'x'),
      edge('b', 'x'),
      { removeNode: 'x' },   // prunes both of the above
      edge('c', 'x'),        // ...but this one came AFTER, so it lives
    ])
    const all = getAllEdges()
    expect(all).toHaveLength(1)
    expect(all[0].from).toBe('c')
    expect(graphStats().edges).toBe(1)
  })

  it('prunes edges pointing AT the removed node (the reverse-index path)', () => {
    loadLog([edge('a', 'target'), edge('b', 'target'), edge('c', 'other'), { removeNode: 'target' }])
    expect(getAllEdges()).toHaveLength(1)
    expect(edgesFrom('a')).toHaveLength(0)
    expect(edgesFrom('b')).toHaveLength(0)
    expect(edgesFrom('c')).toHaveLength(1) // untouched
  })

  it('prunes edges pointing FROM the removed node, and unmirrors them from the reverse index', () => {
    loadLog([edge('src', 'p'), edge('src', 'q'), { removeNode: 'src' }])
    expect(getAllEdges()).toHaveLength(0)
    expect(edgesFrom('src')).toHaveLength(0)
    // The reverse index is what an UNDIRECTED traversal reads. If `src`'s outgoing edges were
    // dropped from adjacency but left mirrored under p/q, traversing from p would resurrect a
    // neighbour that no longer exists — invisible to any forward-only assertion.
    expect(neighboursOf('p')).toHaveLength(0)
    expect(neighboursOf('q')).toHaveLength(0)
    expect(traverseGraph('p', { depth: 2, limit: 10 })).toHaveLength(0)
  })

  it('handles a node with BOTH incoming and outgoing edges', () => {
    loadLog([edge('in1', 'hub'), edge('in2', 'hub'), edge('hub', 'out1'), edge('hub', 'out2'), edge('keep', 'safe'), { removeNode: 'hub' }])
    expect(getAllEdges()).toHaveLength(1)
    expect(getAllEdges()[0].from).toBe('keep')
    expect(graphStats().edges).toBe(1)
    for (const n of ['in1', 'in2', 'hub', 'out1', 'out2']) expect(neighboursOf(n)).toHaveLength(0)
  })

  it('several RELATIONS between the same pair are all pruned, and edgeCount is not double-decremented', () => {
    // The reverse-index walk visits `from` once per incoming edge. With three relations from
    // `a` to `x`, it visits `a` three times — the first pass removes all three, and the later
    // passes must see an unchanged list and decrement NOTHING. Get this wrong and edgeCount
    // goes negative while the graph looks fine.
    loadLog([
      edge('a', 'x', 'solves'), edge('a', 'x', 'causes'), edge('a', 'x', 'follows'),
      edge('a', 'y', 'relates-to'),
      { removeNode: 'x' },
    ])
    expect(getAllEdges()).toHaveLength(1)
    expect(graphStats().edges).toBe(1) // NOT 3 - 3 - 2 = negative
    expect(edgesFrom('a')).toHaveLength(1)
    expect(edgesFrom('a')[0].to).toBe('y')
  })

  it('survives a self-loop in the log without corrupting edgeCount', () => {
    // A self-loop is in BOTH the outgoing list and the incoming list of the same node, so a
    // naive two-pass removal counts it twice. addMemoryEdge rejects self-loops, but a
    // hand-edited/corrupt/older log can carry one and the loader must not trust that.
    loadLog([edge('s', 's'), edge('s', 't'), edge('u', 's'), { removeNode: 's' }])
    expect(getAllEdges()).toHaveLength(0)
    expect(graphStats().edges).toBe(0) // not negative
    expect(edgesFrom('u')).toHaveLength(0)
  })

  it('a removeNode for a node that has no edges is a harmless no-op', () => {
    loadLog([edge('a', 'b'), { removeNode: 'ghost' }])
    expect(getAllEdges()).toHaveLength(1)
    expect(graphStats().edges).toBe(1)
  })

  it('back-to-back markers for the same node do not double-decrement', () => {
    loadLog([edge('a', 'x'), { removeNode: 'x' }, { removeNode: 'x' }, edge('b', 'c')])
    expect(graphStats().edges).toBe(1)
    expect(getAllEdges()[0].from).toBe('b')
  })

  it('adjacency lists come out sorted strongest-first, even though the bulk load defers the sort', () => {
    // The per-insert sort was removed from the bulk path for speed. The FINAL order still has to
    // be weight-descending, because traversals read the head of the list.
    loadLog([
      edge('hub', 'weak', 'relates-to', 0.1),
      edge('hub', 'strong', 'relates-to', 0.9),
      edge('hub', 'mid', 'relates-to', 0.5),
    ])
    expect(edgesFrom('hub').map((e) => e.to)).toEqual(['strong', 'mid', 'weak'])
    // ...and the reverse index is sorted too (undirected traversal reads it).
    loadLog([
      edge('w', 'target', 'relates-to', 0.2),
      edge('s', 'target', 'relates-to', 0.8),
    ])
    expect(neighboursOf('target').map((n) => n.id)).toEqual(['s', 'w'])
  })

  it('dedups a repeated edge, keeping the STRONGER weight and the LATER ts', () => {
    loadLog([
      edge('a', 'b', 'relates-to', 0.3, 100),
      edge('a', 'b', 'relates-to', 0.7, 500),
      edge('a', 'b', 'relates-to', 0.5, 200),
    ])
    const all = getAllEdges()
    expect(all).toHaveLength(1)
    expect(all[0].weight).toBe(0.7)
    expect(all[0].ts).toBe(500)
    expect(graphStats().edges).toBe(1)
  })

  it('an edge re-added after its node was removed is fully re-indexed in BOTH directions', () => {
    loadLog([edge('a', 'x'), { removeNode: 'x' }, edge('a', 'x', 'solves', 0.9)])
    expect(getAllEdges()).toHaveLength(1)
    expect(edgesFrom('a')[0].relation).toBe('solves')
    // the reverse index must have been rebuilt for x too, or undirected traversal misses it
    expect(neighboursOf('x').map((n) => n.id)).toEqual(['a'])
  })
})
