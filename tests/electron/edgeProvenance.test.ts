// Tier-2 / WP-E foundation — EVERY knowledge-graph edge must be attributable. The audit found that
// only cosine auto-links set createdBy:'auto'; reflection-, weave-, ingest-, consolidate-, and
// agent-minted edges dropped it, so the graph couldn't be audited by origin. Fix: addMemoryEdge
// defaults createdBy so no edge is ever un-sourced, and each mint site sets its real source.
import { describe, it, expect, beforeEach } from 'vitest'
import { addMemoryEdge, edgesFrom, clearMemoryGraph } from '../../src/main/memoryGraph'

describe('edge provenance (Tier-2 / WP-E — every edge is attributable)', () => {
  beforeEach(() => clearMemoryGraph())

  it('defaults createdBy so an edge is never un-sourced, and preserves an explicit source', () => {
    const e1 = addMemoryEdge({ from: 'a', to: 'b', relation: 'relates-to' })
    expect(e1?.createdBy).toBe('system') // invariant: never undefined
    const e2 = addMemoryEdge({ from: 'a', to: 'c', relation: 'solves', createdBy: 'weave' })
    expect(e2?.createdBy).toBe('weave') // explicit source preserved
    expect(edgesFrom('a')).toHaveLength(2)
    expect(edgesFrom('a').every((e) => typeof e.createdBy === 'string' && e.createdBy.length > 0)).toBe(true)
  })
})
