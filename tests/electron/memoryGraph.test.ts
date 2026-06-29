import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  normalizeRelation, upsertEdge, bfsTraverse,
  initMemoryGraph, addMemoryEdge, traverseGraph, edgesFrom, graphStats, _resetGraphForTests,
  effectiveWeight, EDGE_HALF_LIFE, invertRelation, neighboursOf,
  type MemoryEdge,
} from '../../src/main/memoryGraph'

const edge = (from: string, to: string, relation = 'relates-to', weight = 1): MemoryEdge => ({ from, to, relation, weight, ts: 0 })

describe('memoryGraph — pure helpers', () => {
  describe('normalizeRelation', () => {
    it('kebab-cases, strips junk, defaults to relates-to', () => {
      expect(normalizeRelation('Solved By')).toBe('solved-by')
      expect(normalizeRelation('caused_by')).toBe('caused-by')
      expect(normalizeRelation('')).toBe('relates-to')
      expect(normalizeRelation(undefined)).toBe('relates-to')
      expect(normalizeRelation('weird!!chars$$')).toBe('weirdchars')
    })
  })

  describe('upsertEdge', () => {
    it('adds new edges, dedups by from+to+relation keeping the stronger weight, sorts by weight', () => {
      const list: MemoryEdge[] = []
      upsertEdge(list, edge('a', 'b', 'solves', 0.5))
      upsertEdge(list, edge('a', 'c', 'relates-to', 0.9))
      upsertEdge(list, edge('a', 'b', 'solves', 0.8)) // dedup → stronger weight
      expect(list).toHaveLength(2)
      expect(list.find(e => e.to === 'b')!.weight).toBe(0.8)
      expect(list[0].to).toBe('c') // weight-desc sort puts 0.9 first
    })
  })

  describe('bfsTraverse', () => {
    const adj = new Map<string, MemoryEdge[]>([
      ['bug', [edge('bug', 'fix', 'solved-by')]],
      ['fix', [edge('fix', 'decision', 'follows'), edge('fix', 'bug', 'solves')]],
      ['decision', [edge('decision', 'file', 'part-of')]],
    ])
    it('follows one hop', () => {
      expect(bfsTraverse(adj, 'bug', { depth: 1 }).map(h => h.id)).toEqual(['fix'])
    })
    it('follows multiple hops up to depth, recording distance', () => {
      const hits = bfsTraverse(adj, 'bug', { depth: 3 })
      expect(hits.map(h => h.id)).toEqual(['fix', 'decision', 'file'])
      expect(hits.find(h => h.id === 'decision')!.distance).toBe(2)
    })
    it('is cycle-safe (fix → bug back-edge never re-adds the start)', () => {
      expect(bfsTraverse(adj, 'bug', { depth: 5 }).some(h => h.id === 'bug')).toBe(false)
    })
    it('filters by relation', () => {
      expect(bfsTraverse(adj, 'fix', { depth: 1, relation: 'solves' }).map(h => h.id)).toEqual(['bug'])
    })
    it('respects the limit', () => {
      expect(bfsTraverse(adj, 'bug', { depth: 5, limit: 2 })).toHaveLength(2)
    })
    it('is forward-only by default — a target-only node returns [] (BB4 legacy path)', () => {
      // 'fix' has an incoming edge (bug -> fix) but no outgoing one in `adj`.
      const fwd = new Map<string, MemoryEdge[]>([['bug', [edge('bug', 'fix', 'solved-by')]]])
      expect(bfsTraverse(fwd, 'fix', { depth: 3 })).toEqual([])
    })
    it('undirected walks incoming edges with the relation inverted (BB4)', () => {
      const fwd = new Map<string, MemoryEdge[]>([['bug', [edge('bug', 'fix', 'solved-by')]]])
      const rev = new Map<string, MemoryEdge[]>([['fix', [edge('bug', 'fix', 'solved-by')]]])
      const hits = bfsTraverse(fwd, 'fix', { depth: 2, directed: false, reverse: rev })
      expect(hits.map(h => h.id)).toEqual(['bug'])
      expect(hits[0].relation).toBe('solves') // solved-by, inverted from fix's perspective
      expect(hits[0].from).toBe('fix')
    })
    it('filters reverse edges against the INVERTED relation (BB4)', () => {
      const fwd = new Map<string, MemoryEdge[]>([['bug', [edge('bug', 'fix', 'solved-by')]]])
      const rev = new Map<string, MemoryEdge[]>([['fix', [edge('bug', 'fix', 'solved-by')]]])
      expect(bfsTraverse(fwd, 'fix', { depth: 2, directed: false, reverse: rev, relation: 'solves' }).map(h => h.id)).toEqual(['bug'])
      expect(bfsTraverse(fwd, 'fix', { depth: 2, directed: false, reverse: rev, relation: 'solved-by' })).toEqual([])
    })
    it('carries the traversed edge weight + ts onto each hit (QW5 inputs)', () => {
      const adj2 = new Map<string, MemoryEdge[]>([['x', [{ from: 'x', to: 'y', relation: 'relates-to', weight: 0.42, ts: 12345 }]]])
      const [hit] = bfsTraverse(adj2, 'x', { depth: 1 })
      expect(hit.weight).toBe(0.42)
      expect(hit.ts).toBe(12345)
    })
    it('accumulates the path-weight product, clamping each edge weight to <=1 (BB5)', () => {
      const w = (from: string, to: string, weight: number): MemoryEdge => ({ from, to, relation: 'relates-to', weight, ts: 0 })
      const adj2 = new Map<string, MemoryEdge[]>([
        ['a', [w('a', 'b', 0.5)]],
        ['b', [w('b', 'c', 0.4), w('b', 'd', 5)]], // weight 5 is out of range → clamps to 1
      ])
      const pw = Object.fromEntries(bfsTraverse(adj2, 'a', { depth: 2 }).map(h => [h.id, h.pathWeight]))
      expect(pw['b']).toBeCloseTo(0.5, 10)        // 1 * 0.5
      expect(pw['c']).toBeCloseTo(0.5 * 0.4, 10)  // 0.5 * 0.4
      expect(pw['d']).toBeCloseTo(0.5, 10)        // 0.5 * clamp01(5)=1 — stray weight can't dominate
    })
  })

  describe('effectiveWeight — edge forgetting curve (QW5)', () => {
    it('returns the full stored weight for a brand-new edge', () => {
      expect(effectiveWeight(0.8, 1000, 1000)).toBeCloseTo(0.8, 10)
    })
    it('halves the weight at exactly one half-life', () => {
      expect(effectiveWeight(1, 0, EDGE_HALF_LIFE)).toBeCloseTo(0.5, 10)
    })
    it('clamps future-dated edges so they never score above the stored weight', () => {
      expect(effectiveWeight(0.7, 5000, 1000)).toBeCloseTo(0.7, 10) // ts > now → deltaT 0
    })
    it('decays toward zero for very old edges', () => {
      expect(effectiveWeight(1, 0, 100 * EDGE_HALF_LIFE)).toBeLessThan(1e-6)
    })
    it('honors a custom half-life', () => {
      expect(effectiveWeight(1, 0, 10, 10)).toBeCloseTo(0.5, 10)
    })
  })

  describe('invertRelation (BB4)', () => {
    it('inverts directional pairs and leaves symmetric / unknown relations unchanged', () => {
      expect(invertRelation('solves')).toBe('solved-by')
      expect(invertRelation('solved-by')).toBe('solves')
      expect(invertRelation('supersedes')).toBe('superseded-by')
      expect(invertRelation('caused-by')).toBe('causes')
      expect(invertRelation('part-of')).toBe('has-part')
      expect(invertRelation('refers-to')).toBe('referred-by')
      expect(invertRelation('relates-to')).toBe('relates-to') // symmetric
      expect(invertRelation('duplicates')).toBe('duplicates')  // symmetric
      expect(invertRelation('some-custom-relation')).toBe('some-custom-relation') // unknown → itself
    })
  })
})

describe('memoryGraph — stateful store + persistence', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-graph-')); _resetGraphForTests(); initMemoryGraph(tmp) })
  afterEach(() => { _resetGraphForTests(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('adds edges, traverses, and rejects self-loops / empty endpoints', () => {
    expect(addMemoryEdge({ from: 'a', to: 'a' })).toBeNull()
    expect(addMemoryEdge({ from: '', to: 'b' })).toBeNull()
    addMemoryEdge({ from: 'a', to: 'b', relation: 'solves' })
    addMemoryEdge({ from: 'b', to: 'c', relation: 'follows' })
    expect(traverseGraph('a', { depth: 2 }).map(h => h.id)).toEqual(['b', 'c'])
    expect(edgesFrom('a')).toHaveLength(1)
    expect(graphStats()).toEqual({ edges: 2, nodes: 2 })
  })

  it('traverseGraph is undirected by default — a target-only node returns its inbound nodes (BB4)', () => {
    addMemoryEdge({ from: 'q1', to: 'answer', relation: 'refers-to' })
    addMemoryEdge({ from: 'q2', to: 'answer', relation: 'refers-to' })
    // Forward-only (legacy) from the canonical "answer" returns nothing...
    expect(traverseGraph('answer', { depth: 1, directed: true })).toEqual([])
    // ...but the new undirected default surfaces the inbound nodes (relation inverted).
    const hits = traverseGraph('answer', { depth: 1 })
    expect(hits.map(h => h.id).sort()).toEqual(['q1', 'q2'])
    expect(hits[0].relation).toBe('referred-by')
  })

  it('neighboursOf merges outgoing + incoming neighbours, inverting inbound relations (BB4)', () => {
    addMemoryEdge({ from: 'a', to: 'b', relation: 'solves' })   // outgoing from a
    addMemoryEdge({ from: 'c', to: 'a', relation: 'refers-to' }) // incoming to a
    const ns = neighboursOf('a')
    const rel = Object.fromEntries(ns.map(n => [n.id, n.relation]))
    expect(ns).toHaveLength(2)
    expect(rel['b']).toBe('solves')        // outgoing, as stored
    expect(rel['c']).toBe('referred-by')   // incoming, inverted
  })

  it('persists to JSONL and reloads on init — the graph survives a restart', () => {
    addMemoryEdge({ from: 'bug', to: 'fix', relation: 'solved-by', weight: 0.9 })
    addMemoryEdge({ from: 'fix', to: 'note', relation: 'relates-to' })
    _resetGraphForTests()   // simulate process exit
    initMemoryGraph(tmp)    // ...and restart from the same dir
    expect(graphStats().edges).toBe(2)
    expect(traverseGraph('bug', { depth: 2 }).map(h => h.id)).toEqual(['fix', 'note'])
  })

  it('dedups repeated edges across reloads, keeping the stronger weight', () => {
    addMemoryEdge({ from: 'a', to: 'b', relation: 'solves', weight: 0.5 })
    addMemoryEdge({ from: 'a', to: 'b', relation: 'solves', weight: 0.8 }) // appended again
    _resetGraphForTests()
    initMemoryGraph(tmp)
    expect(graphStats().edges).toBe(1)
    expect(edgesFrom('a')[0].weight).toBe(0.8)
  })
})
