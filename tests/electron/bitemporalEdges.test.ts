// WP-D — wire the bitemporal edge-validity that shipped as DEAD CODE in v1.23. The pure predicate
// (isTemporallyValid / activeEdges, mnemeGraphLogic.ts) and its unit tests existed, but MemoryEdge
// had no validFrom/validTo fields, addMemoryEdge never set them, and traversal never checked them —
// so an edge with a validity window was never actually honored. These tests pin the real wiring:
// a settable window that persists on the edge and is EXCLUDED from traversal once out-of-force.
import { describe, it, expect, beforeEach } from 'vitest'
import { addMemoryEdge, traverseGraph, bfsTraverse, clearMemoryGraph, type MemoryEdge } from '../../src/main/memoryGraph'

describe('bitemporal edge validity (WP-D — wiring the dead code)', () => {
  beforeEach(() => clearMemoryGraph())

  it('bfsTraverse excludes edges outside their [validFrom, validTo] window at `now`', () => {
    const now = 1_000_000
    const expired: MemoryEdge = { from: 'a', to: 'b', relation: 'relates-to', weight: 1, ts: 0, validTo: now - 1 }
    const future: MemoryEdge = { from: 'a', to: 'c', relation: 'relates-to', weight: 1, ts: 0, validFrom: now + 1 }
    const openEnded: MemoryEdge = { from: 'a', to: 'd', relation: 'relates-to', weight: 1, ts: 0 } // no window → always valid
    const within: MemoryEdge = { from: 'a', to: 'e', relation: 'relates-to', weight: 1, ts: 0, validFrom: now - 10, validTo: now + 10 }
    const adjacency = new Map<string, MemoryEdge[]>([['a', [expired, future, openEnded, within]]])
    const ids = bfsTraverse(adjacency, 'a', { now }).map((h) => h.id)
    expect(ids).toContain('d') // open-ended edge always traversable
    expect(ids).toContain('e') // inside its window
    expect(ids).not.toContain('b') // expired (past validTo)
    expect(ids).not.toContain('c') // not yet in force (before validFrom)
  })

  it('applies NO validity filter when `now` is omitted (backward compatible)', () => {
    const expired: MemoryEdge = { from: 'a', to: 'b', relation: 'relates-to', weight: 1, ts: 0, validTo: 5 }
    const adjacency = new Map<string, MemoryEdge[]>([['a', [expired]]])
    expect(bfsTraverse(adjacency, 'a', {}).map((h) => h.id)).toContain('b') // no `now` → not filtered
  })

  it('addMemoryEdge persists the window and traverseGraph honors it end-to-end', () => {
    const now = 2_000_000
    addMemoryEdge({ from: 'x', to: 'y', relation: 'supersedes', validTo: now - 1 }) // already expired
    addMemoryEdge({ from: 'x', to: 'z', relation: 'supersedes', validFrom: now - 100, validTo: now + 100 }) // active
    const ids = traverseGraph('x', { now, depth: 1 }).map((h) => h.id)
    expect(ids).toContain('z')
    expect(ids).not.toContain('y')
  })
})
