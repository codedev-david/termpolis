import { describe, it, expect } from 'vitest'
import {
  relationPrior,
  supersededIds,
  isTemporallyValid,
  filterSuperseded,
  activeEdges,
  type Edge,
} from '../../src/main/mnemeGraphLogic'

// Small edge factory — only `from`/`to`/`relation` are ever load-bearing here; the
// optional temporal fields are supplied per-test.
const edge = (relation: string, extra: Partial<Edge> = {}): Edge => ({
  from: 'a',
  to: 'b',
  relation,
  ...extra,
})

describe('mnemeGraphLogic', () => {
  describe('relationPrior — per-relation scoring multiplier (causal edges pull neighbours up)', () => {
    it('boosts every causal/solution relation to 1.3', () => {
      expect(relationPrior('solves')).toBe(1.3)
      expect(relationPrior('solved-by')).toBe(1.3)
      expect(relationPrior('causes')).toBe(1.3)
      expect(relationPrior('caused-by')).toBe(1.3)
    })

    it('gives supersedes a smaller boost of 1.15', () => {
      expect(relationPrior('supersedes')).toBe(1.15)
    })

    it('treats structural relations (part-of / refers-to) as neutral 1.0', () => {
      expect(relationPrior('part-of')).toBe(1.0)
      expect(relationPrior('refers-to')).toBe(1.0)
    })

    it('damps a bare relates-to to 0.9', () => {
      expect(relationPrior('relates-to')).toBe(0.9)
    })

    it('damps any unknown relation to 0.9 (the default branch)', () => {
      expect(relationPrior('follows')).toBe(0.9)
      expect(relationPrior('duplicates')).toBe(0.9)
      expect(relationPrior('superseded-by')).toBe(0.9) // NOT in the boosted set — falls to default
      expect(relationPrior('')).toBe(0.9)
      expect(relationPrior('totally-made-up')).toBe(0.9)
    })

    it('orders the tiers causal > supersedes > structural > weak', () => {
      expect(relationPrior('solves')).toBeGreaterThan(relationPrior('supersedes'))
      expect(relationPrior('supersedes')).toBeGreaterThan(relationPrior('part-of'))
      expect(relationPrior('part-of')).toBeGreaterThan(relationPrior('relates-to'))
    })
  })

  describe('supersededIds — memories a newer memory has explicitly replaced (BOTH directions)', () => {
    it('marks the `from` of a superseded-by edge as stale', () => {
      const ids = supersededIds([{ from: 'old', to: 'new', relation: 'superseded-by' }])
      expect([...ids]).toEqual(['old'])
    })

    it('marks the `to` of a supersedes edge as stale', () => {
      const ids = supersededIds([{ from: 'new', to: 'old', relation: 'supersedes' }])
      expect([...ids]).toEqual(['old'])
    })

    it('collects staleness from both relation directions at once', () => {
      const ids = supersededIds([
        { from: 'old1', to: 'new1', relation: 'superseded-by' },
        { from: 'new2', to: 'old2', relation: 'supersedes' },
      ])
      expect(ids.has('old1')).toBe(true)
      expect(ids.has('old2')).toBe(true)
      expect(ids.size).toBe(2)
    })

    it('ignores unrelated relations (the neither-branch contributes nothing)', () => {
      const ids = supersededIds([
        edge('solves'),
        edge('relates-to'),
        edge('part-of'),
      ])
      expect(ids.size).toBe(0)
    })

    it('returns an empty set for no edges', () => {
      expect(supersededIds([]).size).toBe(0)
    })

    it('dedupes an id superseded via several edges', () => {
      const ids = supersededIds([
        { from: 'x', to: 'y', relation: 'superseded-by' },
        { from: 'z', to: 'x', relation: 'supersedes' }, // also marks x
      ])
      expect([...ids]).toEqual(['x'])
    })
  })

  describe('isTemporallyValid — respect the [validFrom, validTo] window on an edge', () => {
    it('is true for an open-ended edge (no bounds set) at any instant', () => {
      expect(isTemporallyValid(edge('relates-to'), 0)).toBe(true)
      expect(isTemporallyValid(edge('relates-to'), 9_999_999)).toBe(true)
    })

    it('is false BEFORE validFrom', () => {
      expect(isTemporallyValid(edge('causes', { validFrom: 100 }), 50)).toBe(false)
    })

    it('is true AT validFrom (inclusive lower bound) and after it (open-ended top)', () => {
      expect(isTemporallyValid(edge('causes', { validFrom: 100 }), 100)).toBe(true)
      expect(isTemporallyValid(edge('causes', { validFrom: 100 }), 150)).toBe(true)
    })

    it('is false AFTER validTo', () => {
      expect(isTemporallyValid(edge('causes', { validTo: 200 }), 250)).toBe(false)
    })

    it('is true AT validTo (inclusive upper bound) and before it (open-ended bottom)', () => {
      expect(isTemporallyValid(edge('causes', { validTo: 200 }), 200)).toBe(true)
      expect(isTemporallyValid(edge('causes', { validTo: 200 }), 150)).toBe(true)
    })

    it('is true strictly WITHIN a closed [validFrom, validTo] window', () => {
      const e = edge('causes', { validFrom: 100, validTo: 200 })
      expect(isTemporallyValid(e, 150)).toBe(true)
    })

    it('is false OUTSIDE a closed window on either side', () => {
      const e = edge('causes', { validFrom: 100, validTo: 200 })
      expect(isTemporallyValid(e, 50)).toBe(false)   // before validFrom (right operand of first &&)
      expect(isTemporallyValid(e, 250)).toBe(false)  // after validTo (right operand of second &&)
    })

    it('treats validFrom/validTo of 0 as a real bound, not "unset"', () => {
      // 0 !== undefined, so the bound is honored: now=-1 is before validFrom 0.
      expect(isTemporallyValid(edge('causes', { validFrom: 0 }), -1)).toBe(false)
      expect(isTemporallyValid(edge('causes', { validFrom: 0 }), 0)).toBe(true)
      // validTo 0: now=1 is after it.
      expect(isTemporallyValid(edge('causes', { validTo: 0 }), 1)).toBe(false)
      expect(isTemporallyValid(edge('causes', { validTo: 0 }), 0)).toBe(true)
    })
  })

  describe('filterSuperseded — retrieval stops surfacing replaced answers', () => {
    const hits = [{ id: 'keep' }, { id: 'stale' }, { id: 'also-keep' }]

    it('drops hits whose id is superseded, preserving order of the rest', () => {
      const edges: Edge[] = [{ from: 'stale', to: 'fresh', relation: 'superseded-by' }]
      expect(filterSuperseded(hits, edges).map((h) => h.id)).toEqual(['keep', 'also-keep'])
    })

    it('drops via the supersedes direction too', () => {
      const edges: Edge[] = [{ from: 'fresh', to: 'stale', relation: 'supersedes' }]
      expect(filterSuperseded(hits, edges).map((h) => h.id)).toEqual(['keep', 'also-keep'])
    })

    it('is a no-op when no hit is superseded (all pass the predicate)', () => {
      const edges: Edge[] = [{ from: 'unrelated', to: 'other', relation: 'supersedes' }]
      expect(filterSuperseded(hits, edges)).toHaveLength(3)
    })

    it('is a no-op with no edges', () => {
      expect(filterSuperseded(hits, [])).toHaveLength(3)
    })

    it('preserves the full hit object (generic T), not just the id', () => {
      type Hit = { id: string; score: number }
      const rich: Hit[] = [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }]
      const edges: Edge[] = [{ from: 'b', to: 'a', relation: 'superseded-by' }]
      expect(filterSuperseded(rich, edges)).toEqual([{ id: 'a', score: 0.9 }])
    })
  })

  describe('activeEdges — the edges a traversal is allowed to walk at `now`', () => {
    it('keeps only temporally-valid edges (drops the expired one)', () => {
      const edges: Edge[] = [
        edge('solves', { validTo: 200 }),          // expired at now=300 → dropped
        edge('causes', { validFrom: 100 }),         // in force at now=300 → kept
        edge('relates-to'),                          // open-ended → kept
      ]
      const active = activeEdges(edges, 300)
      expect(active.map((e) => e.relation)).toEqual(['causes', 'relates-to'])
    })

    it('drops a not-yet-valid edge (before its validFrom)', () => {
      const edges: Edge[] = [edge('causes', { validFrom: 500 })]
      expect(activeEdges(edges, 100)).toHaveLength(0)
    })

    it('keeps everything when all edges are open-ended', () => {
      const edges: Edge[] = [edge('solves'), edge('part-of'), edge('refers-to')]
      expect(activeEdges(edges, 12_345)).toHaveLength(3)
    })

    it('returns [] for no edges', () => {
      expect(activeEdges([], 1000)).toEqual([])
    })

    it('preserves the edge objects it keeps', () => {
      const withinWindow = edge('causes', { validFrom: 100, validTo: 200, weight: 0.5, ts: 150 })
      expect(activeEdges([withinWindow], 150)).toEqual([withinWindow])
    })
  })
})
