// memoryGraphSample.ts
//
// The live connections graph on the dashboard renders the REAL knowledge graph
// (memoryGraph.ts) — but the full graph has ~2.6k nodes / ~3k edges, which is a
// hairball on a canvas. This picks a legible, information-dense subgraph: the most-
// connected nodes and the edges induced among them, labeled + colored by cognitive
// type. Pure — the store/graph accessors are injected — so the sampling is unit-tested
// with zero fs/electron.

import type { CognitiveType } from './mnemeTypeInfer'

export interface SampleNode {
  id: string
  label: string
  type: CognitiveType
  degree: number
}
export interface SampleEdge {
  from: string
  to: string
  relation: string
}
export interface GraphSample {
  nodes: SampleNode[]
  edges: SampleEdge[]
  totalNodes: number
  totalEdges: number
}

export interface RawEdge {
  from: string
  to: string
  relation: string
}

/** Metadata for a node id (its display label + cognitive type), or null when the
 *  entry behind the id is gone — edges outlive trimmed/tombstoned entries. */
export type NodeMeta = (id: string) => { label: string; type: CognitiveType } | null

/**
 * Pick the densest legible subgraph: rank nodes by undirected degree, keep the top
 * `limit` that still resolve to a live entry, induce the edges among them, then drop
 * any node left with no induced edge (so the canvas shows clusters, not a dust of
 * singletons). Deterministic: ties broken by id so the same store always samples the
 * same subgraph. `totalNodes`/`totalEdges` report the full-graph size for an honest
 * "showing N of M" label.
 */
export function sampleGraph(edges: RawEdge[], meta: NodeMeta, opts: { limit?: number; maxEdges?: number } = {}): GraphSample {
  const limit = Math.max(1, opts.limit ?? 160)
  const maxEdges = Math.max(1, opts.maxEdges ?? 600)

  const degree = new Map<string, number>()
  const bump = (id: string): void => { degree.set(id, (degree.get(id) || 0) + 1) }
  for (const e of edges) {
    if (!e || !e.from || !e.to || e.from === e.to) continue
    bump(e.from)
    bump(e.to)
  }
  const totalNodes = degree.size
  const totalEdges = edges.length

  // Rank by degree desc, id asc for determinism.
  const ranked = [...degree.keys()].sort((a, b) => (degree.get(b)! - degree.get(a)!) || (a < b ? -1 : 1))
  // Resolve meta once (skipping entries whose memory is gone — edges outlive trimmed
  // entries), preserving degree order.
  const metaCache = new Map<string, { label: string; type: CognitiveType }>()
  const resolved: string[] = []
  for (const id of ranked) {
    const m = meta(id)
    if (!m) continue
    metaCache.set(id, m)
    resolved.push(id)
  }
  // Diversity-aware selection: first reserve a per-type floor of each present type's
  // highest-degree nodes — so entity/semantic/procedural colors surface even when the
  // dense core is overwhelmingly episodic — then fill the rest by global degree. Both
  // passes walk `resolved` (degree order), so the result stays deterministic.
  const kept = new Set<string>()
  const perTypeFloor = Math.min(14, Math.max(1, Math.ceil(limit / 6)))
  const perType = new Map<string, number>()
  for (const id of resolved) {
    const t = metaCache.get(id)!.type
    const n = perType.get(t) || 0
    if (n < perTypeFloor) { kept.add(id); perType.set(t, n + 1) }
  }
  for (const id of resolved) {
    if (kept.size >= limit) break
    kept.add(id)
  }
  // If the per-type floor overshot the limit (many types), keep the highest-degree.
  if (kept.size > limit) {
    const trimmed = new Set<string>()
    for (const id of resolved) { if (trimmed.size >= limit) break; if (kept.has(id)) trimmed.add(id) }
    kept.clear()
    for (const id of trimmed) kept.add(id)
  }

  // Induced edges: both endpoints kept. Cap for canvas weight.
  const outEdges: SampleEdge[] = []
  const connected = new Set<string>()
  for (const e of edges) {
    if (outEdges.length >= maxEdges) break
    if (!e || e.from === e.to) continue
    if (kept.has(e.from) && kept.has(e.to)) {
      outEdges.push({ from: e.from, to: e.to, relation: e.relation })
      connected.add(e.from)
      connected.add(e.to)
    }
  }

  const nodes: SampleNode[] = [...connected].map((id) => {
    const m = metaCache.get(id)!
    return { id, label: m.label, type: m.type, degree: degree.get(id) || 0 }
  }).sort((a, b) => b.degree - a.degree)

  return { nodes, edges: outEdges, totalNodes, totalEdges }
}

/** Short display label for a graph node from its raw memory content. Pure. Code
 *  artifacts collapse to "file:range"; transcript turns drop the speaker prefix. */
export function graphNodeLabel(content: string, isCode: boolean, kind = ''): string {
  const first = (content || '').split('\n')[0].trim()
  if (isCode) {
    const tail = first.split(/[\\/]/).pop() || first // last path segment incl. ":start-end"
    return tail.slice(0, 44) || (kind || 'code')
  }
  const stripped = first.replace(/^(user|assistant|system)\s*:\s*/i, '').trim()
  return (stripped || kind || 'memory').slice(0, 52)
}
