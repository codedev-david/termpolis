// Knowledge graph over the shared memory — typed edges between memory entries that
// accumulate as agents work, so the brain doesn't just STORE facts, it stores the
// CONNECTIONS between them. An agent can follow a chain (bug -> solved-by -> fix ->
// follows -> decision) to reuse out-of-training knowledge fast instead of
// re-deriving it. Edges are created two ways: EXPLICITLY by an agent (the
// memory_link tool) and AUTOMATICALLY when a curated memory is written (linked to
// its nearest neighbours). Persisted as a JSONL append-log so the graph survives
// restarts and keeps getting denser the more you use it.

import * as fs from 'fs'
import * as path from 'path'

export interface MemoryEdge {
  from: string
  to: string
  relation: string
  weight: number
  ts: number
  createdBy?: string
}

export interface GraphHit {
  id: string
  relation: string
  distance: number
  from: string
  weight: number   // the traversed edge's stored weight (decayed at scoring time)
  ts: number       // the traversed edge's timestamp — input to the forgetting curve
}

// QW5 — edge forgetting curve. Connections fade out of traversal scoring as they
// age, with no extra writes. A 90-day half-life keeps recent links strong while
// long-stale ones decay below EDGE_EPSILON and drop out.
export const EDGE_HALF_LIFE = 90 * 86_400_000
export const EDGE_EPSILON = 1e-3

/**
 * Time-decayed edge weight: `weight * 0.5^((now-ts)/halfLife)`. Pure. `deltaT` is
 * clamped ≥ 0 so a future-dated synced-peer edge can't score above its stored
 * weight. Lets memoryGraphQuery finally USE the cosine weight it already stores
 * (instead of pure hop-count) and lets stale edges decay out of traversal.
 */
export function effectiveWeight(weight: number, ts: number, now: number, halfLife = EDGE_HALF_LIFE): number {
  const deltaT = Math.max(0, now - ts)
  return weight * Math.pow(0.5, deltaT / halfLife)
}

// Suggested relation vocabulary — free-form is allowed, these just guide the agent.
export const CANONICAL_RELATIONS = [
  'relates-to', 'solves', 'solved-by', 'supersedes', 'superseded-by',
  'caused-by', 'causes', 'part-of', 'follows', 'duplicates', 'refers-to',
] as const

/** Normalize a relation to a short kebab-case token; defaults to 'relates-to'. Pure. */
export function normalizeRelation(r: string | undefined | null): string {
  const n = (r || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40)
  return n || 'relates-to'
}

/**
 * Insert or update an edge in a node's adjacency list: dedup by from+to+relation,
 * keeping the stronger weight and latest ts, sorted by weight desc. Pure (mutates
 * + returns the list).
 */
export function upsertEdge(list: MemoryEdge[], edge: MemoryEdge): MemoryEdge[] {
  const i = list.findIndex(e => e.from === edge.from && e.to === edge.to && e.relation === edge.relation)
  if (i >= 0) {
    list[i] = { ...list[i], weight: Math.max(list[i].weight, edge.weight), ts: Math.max(list[i].ts, edge.ts) }
  } else {
    list.push(edge)
  }
  list.sort((a, b) => b.weight - a.weight)
  return list
}

/**
 * Breadth-first n-hop traversal from `start` — cycle-safe, depth- and limit-bounded,
 * optionally filtered to a single relation. Excludes the start node. Pure (operates
 * on the supplied adjacency map).
 */
export function bfsTraverse(
  adjacency: Map<string, MemoryEdge[]>,
  start: string,
  opts: { relation?: string; depth?: number; limit?: number } = {},
): GraphHit[] {
  const depth = Math.max(1, opts.depth ?? 2)
  const limit = Math.max(1, opts.limit ?? 20)
  const relation = opts.relation ? normalizeRelation(opts.relation) : undefined
  const visited = new Set<string>([start])
  const out: GraphHit[] = []
  let frontier: string[] = [start]
  for (let d = 1; d <= depth && out.length < limit; d++) {
    const next: string[] = []
    for (const node of frontier) {
      for (const e of adjacency.get(node) || []) {
        if (relation && e.relation !== relation) continue
        if (visited.has(e.to)) continue
        visited.add(e.to)
        out.push({ id: e.to, relation: e.relation, distance: d, from: e.from, weight: e.weight, ts: e.ts })
        next.push(e.to)
        if (out.length >= limit) break
      }
      if (out.length >= limit) break
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return out
}

// ── Stateful store (persisted JSONL append-log) ──────────────────────────────
const adjacency = new Map<string, MemoryEdge[]>()
let edgeCount = 0
let graphPath: string | null = null

/** Point the graph at a userData dir and load any existing edges (survives restarts). */
export function initMemoryGraph(dir: string): void {
  adjacency.clear()
  edgeCount = 0
  graphPath = path.join(dir, 'memory-graph.jsonl')
  try {
    if (fs.existsSync(graphPath)) {
      for (const line of fs.readFileSync(graphPath, 'utf8').split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const e = JSON.parse(t) as MemoryEdge
          if (e && e.from && e.to && e.relation) indexEdge(e)
        } catch { /* skip a corrupt line */ }
      }
    }
  } catch { /* best effort — a missing/locked file just means an empty graph */ }
}

function indexEdge(e: MemoryEdge): void {
  const list = adjacency.get(e.from) || []
  const before = list.length
  upsertEdge(list, e)
  adjacency.set(e.from, list)
  edgeCount += list.length - before // +1 for a new edge, +0 when it dedups
}

export interface AddEdgeInput { from: string; to: string; relation?: string; weight?: number; createdBy?: string }

/** Record a typed edge (in memory + appended to the JSONL log). Returns it, or null
 *  for a self-loop / missing endpoint. */
export function addMemoryEdge(input: AddEdgeInput): MemoryEdge | null {
  if (!input || !input.from || !input.to || input.from === input.to) return null
  const edge: MemoryEdge = {
    from: String(input.from),
    to: String(input.to),
    relation: normalizeRelation(input.relation),
    weight: typeof input.weight === 'number' && input.weight > 0 ? input.weight : 1,
    ts: Date.now(),
    ...(input.createdBy && { createdBy: input.createdBy }),
  }
  indexEdge(edge)
  if (graphPath) {
    try { fs.appendFileSync(graphPath, JSON.stringify(edge) + '\n') } catch { /* best effort */ }
  }
  return edge
}

export function traverseGraph(start: string, opts: { relation?: string; depth?: number; limit?: number } = {}): GraphHit[] {
  return bfsTraverse(adjacency, start, opts)
}

export function edgesFrom(id: string): MemoryEdge[] {
  const list = adjacency.get(id)
  return list ? [...list] : []
}

export function graphStats(): { edges: number; nodes: number } {
  return { edges: edgeCount, nodes: adjacency.size }
}

export function _resetGraphForTests(): void {
  adjacency.clear()
  edgeCount = 0
  graphPath = null
}
