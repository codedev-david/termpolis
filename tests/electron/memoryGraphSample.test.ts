import { describe, it, expect } from 'vitest'
import { sampleGraph, graphNodeLabel, type RawEdge, type NodeMeta } from '../../src/main/memoryGraphSample'
import type { CognitiveType } from '../../src/main/mnemeTypeInfer'

const meta: NodeMeta = (id) => ({ label: id, type: 'episodic' })

describe('sampleGraph — densest legible subgraph of the knowledge graph', () => {
  it('reports full-graph totals and induces edges among kept nodes', () => {
    const edges: RawEdge[] = [
      { from: 'a', to: 'b', relation: 'relates-to' },
      { from: 'b', to: 'c', relation: 'follows' },
      { from: 'c', to: 'a', relation: 'solves' },
    ]
    const s = sampleGraph(edges, meta, { limit: 10 })
    expect(s.totalNodes).toBe(3)
    expect(s.totalEdges).toBe(3)
    expect(s.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c'])
    expect(s.edges).toHaveLength(3)
  })

  it('keeps the highest-degree nodes when over the limit and drops resulting singletons', () => {
    // hub h connects to a,b,c,d; isolated pair x-y. limit=3 keeps h + 2 of its spokes.
    const edges: RawEdge[] = [
      { from: 'h', to: 'a', relation: 'relates-to' },
      { from: 'h', to: 'b', relation: 'relates-to' },
      { from: 'h', to: 'c', relation: 'relates-to' },
      { from: 'h', to: 'd', relation: 'relates-to' },
      { from: 'x', to: 'y', relation: 'relates-to' },
    ]
    const s = sampleGraph(edges, meta, { limit: 3 })
    expect(s.totalNodes).toBe(7) // h,a,b,c,d,x,y
    expect(s.nodes.find((n) => n.id === 'h')).toBeTruthy() // the hub is kept (degree 4)
    expect(s.nodes.length).toBeLessThanOrEqual(3)
    // every returned node has at least one induced edge (no singletons)
    const withEdges = new Set(s.edges.flatMap((e) => [e.from, e.to]))
    for (const n of s.nodes) expect(withEdges.has(n.id)).toBe(true)
  })

  it('skips nodes whose entry is gone (edges outlive trimmed entries)', () => {
    const edges: RawEdge[] = [
      { from: 'a', to: 'b', relation: 'relates-to' },
      { from: 'a', to: 'ghost', relation: 'relates-to' },
    ]
    const partialMeta: NodeMeta = (id) => (id === 'ghost' ? null : { label: id, type: 'entity' })
    const s = sampleGraph(edges, partialMeta, { limit: 10 })
    expect(s.nodes.map((n) => n.id).sort()).toEqual(['a', 'b'])
    expect(s.edges).toEqual([{ from: 'a', to: 'b', relation: 'relates-to' }])
  })

  it('ignores self-loops and caps edges at maxEdges', () => {
    const edges: RawEdge[] = [
      { from: 'a', to: 'a', relation: 'relates-to' }, // self-loop ignored
      { from: 'a', to: 'b', relation: 'r1' },
      { from: 'a', to: 'b', relation: 'r2' },
      { from: 'b', to: 'c', relation: 'r3' },
    ]
    const s = sampleGraph(edges, meta, { limit: 10, maxEdges: 2 })
    expect(s.edges).toHaveLength(2)
  })

  it('surfaces minority-type nodes for color variety, not just the densest episodic core', () => {
    const typeOf = (id: string): CognitiveType => (id === 'ent' ? 'entity' : id === 'sem' ? 'semantic' : 'episodic')
    const m: NodeMeta = (id) => ({ label: id, type: typeOf(id) })
    const edges: RawEdge[] = []
    for (let i = 0; i < 10; i++) edges.push({ from: 'h', to: `e${i}`, relation: 'follows' }) // episodic hub + spokes
    edges.push({ from: 'h', to: 'ent', relation: 'refers-to' }) // one low-degree entity node
    edges.push({ from: 'h', to: 'sem', relation: 'relates-to' }) // one low-degree semantic node
    const s = sampleGraph(edges, m, { limit: 8 })
    const types = new Set(s.nodes.map((n) => n.type))
    expect(types.has('entity')).toBe(true) // reserved by the per-type floor despite low degree
    expect(types.has('semantic')).toBe(true)
    expect(types.has('episodic')).toBe(true)
  })

  it('is deterministic across runs (ties broken by id)', () => {
    const edges: RawEdge[] = [
      { from: 'b', to: 'z', relation: 'r' },
      { from: 'a', to: 'z', relation: 'r' },
    ]
    const a = sampleGraph(edges, meta, { limit: 10 })
    const b = sampleGraph(edges, meta, { limit: 10 })
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id))
  })
})

describe('graphNodeLabel', () => {
  it('collapses code artifacts to the file:range tail', () => {
    expect(graphNodeLabel('C:\\Users\\d\\repos\\app\\src\\index.ts:1-40\nconst x = 1', true)).toBe('index.ts:1-40')
  })
  it('strips the speaker prefix from a transcript turn', () => {
    expect(graphNodeLabel('user: how does auth work here', false)).toBe('how does auth work here')
    expect(graphNodeLabel('assistant: it uses OAuth', false)).toBe('it uses OAuth')
  })
  it('falls back to kind when content is empty', () => {
    expect(graphNodeLabel('', false, 'decision')).toBe('decision')
  })
})
