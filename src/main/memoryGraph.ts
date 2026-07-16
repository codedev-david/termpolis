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
import { forEachBufferLine } from './fileLines' // byte-safe JSONL reader (never a >512 MiB string; see fileLines.ts)
import { isTemporallyValid } from './mnemeGraphLogic'

export interface MemoryEdge {
  from: string
  to: string
  relation: string
  weight: number
  ts: number
  createdBy?: string
  validFrom?: number // WP-D: edge not in force before this instant (open-ended when unset)
  validTo?: number   // WP-D: edge not in force after this instant (open-ended when unset)
}

export interface GraphHit {
  id: string
  relation: string
  distance: number
  from: string
  weight: number      // the LAST traversed edge's stored weight (decayed at scoring time)
  ts: number          // the LAST traversed edge's timestamp — input to the forgetting curve
  pathWeight: number  // BB5: product of clamped edge weights along the whole path (0,1]
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

// Directional relation pairs — when we traverse an edge BACKWARDS we relabel it
// with its inverse so the result reads correctly from the seed's perspective
// (X "solved-by" Y, walked from Y, becomes Y "solves" X). Symmetric relations
// (relates-to, duplicates) and any unknown relation invert to themselves.
const RELATION_INVERSE: Record<string, string> = {
  'solves': 'solved-by', 'solved-by': 'solves',
  'supersedes': 'superseded-by', 'superseded-by': 'supersedes',
  'causes': 'caused-by', 'caused-by': 'causes',
  'part-of': 'has-part', 'has-part': 'part-of',
  'follows': 'precedes', 'precedes': 'follows',
  'refers-to': 'referred-by', 'referred-by': 'refers-to',
  // v1.25 — the Weave's code<->purpose bridge. Without an inverse, an UNDIRECTED traversal
  // walking this edge backwards would relabel it 'explains', making the code chunk appear to
  // explain the decision rather than the other way round.
  'explains': 'explained-by', 'explained-by': 'explains',
}

/** The inverse of a relation for backward traversal; unchanged if symmetric/unknown. Pure. */
export function invertRelation(relation: string): string {
  return RELATION_INVERSE[relation] ?? relation
}

/** Adjacency lists are kept strongest-edge-first; traversals read the head. */
const byWeightDesc = (a: MemoryEdge, b: MemoryEdge): number => b.weight - a.weight

/**
 * Insert or update an edge in a node's adjacency list: dedup by from+to+relation,
 * keeping the stronger weight and latest ts, sorted by weight desc. Pure (mutates
 * + returns the list).
 */
export function upsertEdge(list: MemoryEdge[], edge: MemoryEdge, sort = true): MemoryEdge[] {
  const i = list.findIndex(e => e.from === edge.from && e.to === edge.to && e.relation === edge.relation)
  if (i >= 0) {
    list[i] = { ...list[i], weight: Math.max(list[i].weight, edge.weight), ts: Math.max(list[i].ts, edge.ts) }
  } else {
    list.push(edge)
  }
  // `sort=false` is the BULK-LOAD path: sorting on every insert makes building a node of degree
  // d cost O(d^2 log d), and only the final order is ever observed. initMemoryGraph sorts each
  // list once at the end instead. Every other caller adds one edge at a time and keeps sorting.
  if (sort) list.sort(byWeightDesc)
  return list
}

/**
 * Breadth-first n-hop traversal from `start` — cycle-safe, depth- and limit-bounded,
 * optionally filtered to a single relation. Excludes the start node. Pure (operates
 * on the supplied adjacency map).
 *
 * BB4: when `directed` is false AND a `reverse` adjacency map is supplied, incoming
 * edges are also expanded (the neighbour is `e.from`, the relation is inverted) — so
 * a canonical "answer" node that only has edges pointing AT it stops returning [].
 * Legacy callers pass neither (directed defaults true) and get the forward-only path.
 */
export function bfsTraverse(
  adjacency: Map<string, MemoryEdge[]>,
  start: string,
  opts: { relation?: string; depth?: number; limit?: number; directed?: boolean; reverse?: Map<string, MemoryEdge[]>; now?: number } = {},
): GraphHit[] {
  const depth = Math.max(1, opts.depth ?? 2)
  const limit = Math.max(1, opts.limit ?? 20)
  const relation = opts.relation ? normalizeRelation(opts.relation) : undefined
  const directed = opts.directed ?? true
  const reverse = opts.reverse
  // BB5: clamp each edge weight to (0,1] before multiplying into the path product,
  // so a stray weight:5 (addMemoryEdge has no upper bound) can't dominate the score.
  const clamp01 = (w: number): number => Math.min(1, Math.max(0, w))
  const visited = new Set<string>([start])
  const out: GraphHit[] = []
  let frontier: Array<{ id: string; pw: number }> = [{ id: start, pw: 1 }]
  for (let d = 1; d <= depth && out.length < limit; d++) {
    const next: Array<{ id: string; pw: number }> = []
    for (const { id: node, pw } of frontier) {
      // Outgoing edges (forward) — relation as stored.
      for (const e of adjacency.get(node) || []) {
        if (opts.now !== undefined && !isTemporallyValid(e, opts.now)) continue // WP-D: skip out-of-force edges
        if (relation && e.relation !== relation) continue
        if (visited.has(e.to)) continue
        visited.add(e.to)
        const childPw = pw * clamp01(e.weight)
        out.push({ id: e.to, relation: e.relation, distance: d, from: node, weight: e.weight, ts: e.ts, pathWeight: childPw })
        next.push({ id: e.to, pw: childPw })
        if (out.length >= limit) break
      }
      if (out.length >= limit) break
      // Incoming edges (reverse), relation inverted — only when undirected.
      if (!directed && reverse) {
        for (const e of reverse.get(node) || []) {
          if (opts.now !== undefined && !isTemporallyValid(e, opts.now)) continue // WP-D: skip out-of-force edges
          const rel = invertRelation(e.relation)
          if (relation && rel !== relation) continue
          if (visited.has(e.from)) continue
          visited.add(e.from)
          const childPw = pw * clamp01(e.weight)
          out.push({ id: e.from, relation: rel, distance: d, from: node, weight: e.weight, ts: e.ts, pathWeight: childPw })
          next.push({ id: e.from, pw: childPw })
          if (out.length >= limit) break
        }
        if (out.length >= limit) break
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return out
}

// ── Stateful store (persisted JSONL append-log) ──────────────────────────────
const adjacency = new Map<string, MemoryEdge[]>()
// BB4: reverse index keyed by edge target — edges pointing AT a node — so we can
// walk incoming connections without scanning the whole graph. Built alongside the
// forward map at every mutation; never persisted separately (derived from edges).
const reverseAdjacency = new Map<string, MemoryEdge[]>()
let edgeCount = 0
let graphPath: string | null = null

/**
 * Point the graph at a userData dir and load any existing edges (survives restarts).
 *
 * Read + JSON.parse per line, synchronously, at launch — and the edge log only ever grows. Labelled
 * so that when it does start costing seconds, the panel says so instead of shrugging.
 */
/**
 * Load the graph log into memory.
 *
 * MEASURED (v1.25.17): this took **7.4 SECONDS** on a 3.4 MB / 23,587-line file — synchronously,
 * at launch, on the thread that echoes keystrokes. It was the single largest item in the launch
 * freeze, and it was hiding inside a file 140x smaller than the memory store. Not a data-volume
 * problem; two compounding quadratics:
 *
 *   1. Every `{removeNode}` marker (there are 1,625 in the real log) called a helper that swept
 *      the ENTIRE adjacency map — copying it with `[...adjacency]` and allocating a fresh array
 *      per node via `.filter()` — to find the edges pointing at one id. The reverse index that
 *      answers exactly that question in O(1) already existed and was simply not used. Fixed in
 *      `removeIncidentInMemory`.
 *   2. `upsertEdge` re-sorted a node's whole adjacency list on EVERY insert, so building a node
 *      of degree d cost O(d^2 log d). The sort is only needed for the FINAL state, so the bulk
 *      load now defers it and sorts each list once at the end. Identical result, and the
 *      incremental `addMemoryEdge` path still sorts per insert (one edge at a time — cheap).
 *
 * The append-order semantics are preserved exactly: markers are still applied in order as they
 * are read, so an edge re-added after a marker still survives it.
 */
export function initMemoryGraph(dir: string): void {
  adjacency.clear()
  reverseAdjacency.clear()
  edgeCount = 0
  graphPath = path.join(dir, 'memory-graph.jsonl')
  try {
    if (fs.existsSync(graphPath!)) {
      // Stream the (append-only, unbounded) graph log from bytes — never decode the whole file as one
      // 'utf8' string, which fatals V8 uncatchably past ~512 MiB (see fileLines.ts). This runs in the
      // memory utilityProcess AND in main on the in-process fallback — the same double-crash surface as
      // the shard loader. Append-order semantics preserved: markers apply in order, sort once at the end.
      forEachBufferLine(fs.readFileSync(graphPath!), (line) => {
        const t = line.trim()
        if (!t) return
        try {
          const e = JSON.parse(t) as MemoryEdge & { removeNode?: unknown }
          // Wave2 (graph-edges-dangle): a {removeNode:id} marker prunes edges incident to a
          // deleted memory — applied in append order so edges re-added after it survive.
          if (e && typeof e.removeNode === 'string') { removeIncidentInMemory(e.removeNode); return }
          if (e && e.from && e.to && e.relation) indexEdge(e, false) // defer the sort
        } catch { /* skip a corrupt line */ }
      })
      // Sort every list ONCE, now that the final membership is known.
      for (const list of adjacency.values()) list.sort(byWeightDesc)
      for (const list of reverseAdjacency.values()) list.sort(byWeightDesc)
    }
  } catch { /* best effort — a missing/locked file just means an empty graph */ }
}

function indexEdge(e: MemoryEdge, sort = true): void {
  const list = adjacency.get(e.from) || []
  const before = list.length
  upsertEdge(list, e, sort)
  adjacency.set(e.from, list)
  edgeCount += list.length - before // +1 for a new edge, +0 when it dedups
  // Mirror into the reverse index (keyed by target). Same dedup semantics; we don't
  // re-count here — edgeCount tracks distinct edges via the forward map only.
  const rlist = reverseAdjacency.get(e.to) || []
  upsertEdge(rlist, e, sort)
  reverseAdjacency.set(e.to, rlist)
}

export interface AddEdgeInput { from: string; to: string; relation?: string; weight?: number; createdBy?: string; ts?: number; validFrom?: number; validTo?: number }

/** Record a typed edge (in memory + appended to the JSONL log). Returns it, or null
 *  for a self-loop / missing endpoint. */
export function addMemoryEdge(input: AddEdgeInput): MemoryEdge | null {
  if (!input || !input.from || !input.to || input.from === input.to) return null
  const edge: MemoryEdge = {
    from: String(input.from),
    to: String(input.to),
    relation: normalizeRelation(input.relation),
    weight: typeof input.weight === 'number' && input.weight > 0 ? input.weight : 1,
    // P0 sibling: honor an explicit conversation ts so a backdated (re-ingested)
    // memory's edges don't look freshly created (which would skew BB5 time-decay).
    ts: typeof input.ts === 'number' ? input.ts : Date.now(),
    createdBy: input.createdBy || 'system', // provenance: every edge is attributable by origin
    ...(typeof input.validFrom === 'number' && { validFrom: input.validFrom }),
    ...(typeof input.validTo === 'number' && { validTo: input.validTo }),
  }
  indexEdge(edge)
  if (graphPath) {
    try { fs.appendFileSync(graphPath, JSON.stringify(edge) + '\n') } catch { /* best effort */ }
  }
  return edge
}

// Wave2: remove all edges incident to `id` from the in-memory adjacency (both directions),
// keeping edgeCount consistent. Pure in-memory — the log side is handled by the callers.
/**
 * Prune every edge incident to `id`, in O(degree(id)) rather than O(V + E).
 *
 * The previous version swept the ENTIRE adjacency map on every call — `[...adjacency]` copied
 * all of it, and `.filter()` allocated a fresh array for every node whether or not it held a
 * matching edge — and then did the same again for the reverse map. That is fine once. It is
 * called once per `{removeNode}` marker, and the real graph log holds 1,625 of them, so it ran
 * 1,625 full sweeps at every launch: ~7.4 seconds, synchronously, on the UI thread.
 *
 * `reverseAdjacency` is an index whose entire purpose is to answer "which edges point AT this
 * node?" in O(1). It was already being maintained. It just wasn't being used here.
 */
function removeIncidentInMemory(id: string): number {
  let removed = 0

  // OUTGOING (id -> *): the whole list goes, and each of those edges is also mirrored in the
  // reverse index under its TARGET, so unmirror them there too.
  const out = adjacency.get(id)
  if (out) {
    edgeCount -= out.length
    removed += out.length
    adjacency.delete(id)
    for (const e of out) {
      const rlist = reverseAdjacency.get(e.to)
      if (!rlist) continue
      const kept = rlist.filter((x) => x.from !== id)
      if (kept.length) reverseAdjacency.set(e.to, kept)
      else reverseAdjacency.delete(e.to)
    }
  }

  // INCOMING (* -> id): ask the reverse index directly instead of sweeping every node.
  // Repeated `from`s (several relations between the same pair) are safe: the first pass filters
  // out every edge to `id`, so a later pass sees an unchanged list and decrements nothing.
  const incoming = reverseAdjacency.get(id)
  if (incoming) {
    for (const e of incoming) {
      const list = adjacency.get(e.from)
      if (!list) continue // already pruned (e.g. a self-loop, whose adjacency entry is gone)
      const kept = list.filter((x) => x.to !== id)
      if (kept.length !== list.length) {
        edgeCount -= list.length - kept.length
        removed += list.length - kept.length
        if (kept.length) adjacency.set(e.from, kept)
        else adjacency.delete(e.from)
      }
    }
    reverseAdjacency.delete(id)
  }
  return removed
}

/** Wave2 (graph-edges-dangle-after-delete): prune edges incident to a deleted memory so a
 *  later traversal doesn't hit a dangling link, and persist a {removeNode} marker so the
 *  pruning survives reload. Returns how many edges were removed. */
export function removeNodeEdges(id: string): number {
  if (!id) return 0
  const removed = removeIncidentInMemory(id)
  if (removed > 0 && graphPath) {
    try { fs.appendFileSync(graphPath, JSON.stringify({ removeNode: id }) + '\n') } catch { /* best effort */ }
  }
  return removed
}

/** Wave2 (clear-doesnt-reset-graph): reset the knowledge graph (in-memory + on-disk) so a
 *  memory clear doesn't leave every edge dangling and the graph file growing forever. */
export function clearMemoryGraph(): void {
  adjacency.clear()
  reverseAdjacency.clear()
  edgeCount = 0
  if (graphPath) { try { fs.writeFileSync(graphPath, '') } catch { /* best effort */ } }
}

// BB4: traversal is UNDIRECTED by default now — it walks both outgoing and incoming
// edges (incoming relabeled with the inverse relation), which is what lets a queried
// "answer" node surface the questions/notes that point at it. Pass `directed: true`
// for the legacy forward-only walk.
export function traverseGraph(
  start: string,
  opts: { relation?: string; depth?: number; limit?: number; directed?: boolean; now?: number } = {},
): GraphHit[] {
  // WP-D: default `now` to the wall clock so expired / not-yet-in-force edges are excluded in
  // production (windowless edges are always valid, so this is backward-compatible); tests inject `now`.
  return bfsTraverse(adjacency, start, { ...opts, now: opts.now ?? Date.now(), directed: opts.directed ?? false, reverse: reverseAdjacency })
}

export function edgesFrom(id: string): MemoryEdge[] {
  const list = adjacency.get(id)
  return list ? [...list] : []
}

/**
 * BB4: all 1-hop neighbours of `id` regardless of edge direction — outgoing edges
 * as stored, incoming edges relabeled with the inverse relation — deduped by
 * neighbour id keeping the strongest weight. The basis for bidirectional
 * `memory_related` and graph fusion.
 */
export function neighboursOf(id: string): Array<{ id: string; relation: string; weight: number; ts: number }> {
  const out = new Map<string, { id: string; relation: string; weight: number; ts: number }>()
  const consider = (nid: string, relation: string, weight: number, ts: number): void => {
    const cur = out.get(nid)
    if (!cur || weight > cur.weight) out.set(nid, { id: nid, relation, weight, ts })
  }
  for (const e of adjacency.get(id) || []) consider(e.to, e.relation, e.weight, e.ts)
  for (const e of reverseAdjacency.get(id) || []) consider(e.from, invertRelation(e.relation), e.weight, e.ts)
  return [...out.values()]
}

export function graphStats(): { edges: number; nodes: number } {
  return { edges: edgeCount, nodes: adjacency.size }
}

// v1.23 C7 — relation-quality breakdown: raw edge counts hide that the graph inflates with
// damped `relates-to`/`follows` co-occurrence (redundant with the vector index + recency) while
// the predictive causal/supersedes/entity edges are what actually help. Surfacing the split lets
// the dashboard show — and lets us tune — the high-signal ratio you can't improve if you can't see.
export function graphRelationStats(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const list of adjacency.values()) {
    for (const e of list) counts[e.relation] = (counts[e.relation] ?? 0) + 1
  }
  return counts
}

/** All forward edges as a flat list — for consumers that need the whole edge set
 *  (e.g. P3 supersession filtering). Reverse edges are these same edges, indexed by target. */
export function getAllEdges(): MemoryEdge[] {
  const out: MemoryEdge[] = []
  for (const list of adjacency.values()) out.push(...list)
  return out
}

/** Serialize every edge as JSONL — the portable knowledge-graph content for a brain export. */
export function exportGraphEdges(): string {
  return getAllEdges().map((e) => JSON.stringify(e)).join('\n')
}

/** Merge edges from an exported graph into this one (upsert — additive, never removes). Returns
 *  how many valid edges were merged. Malformed lines are skipped, not fatal. */
export function importGraphEdges(jsonl: string): number {
  if (!jsonl) return 0
  let n = 0
  for (const line of jsonl.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const e = JSON.parse(s) as { from?: unknown; to?: unknown; relation?: unknown; weight?: unknown; ts?: unknown; createdBy?: unknown }
      if (typeof e.from === 'string' && typeof e.to === 'string') {
        addMemoryEdge({
          from: e.from,
          to: e.to,
          relation: typeof e.relation === 'string' ? e.relation : undefined,
          weight: typeof e.weight === 'number' ? e.weight : undefined,
          ts: typeof e.ts === 'number' ? e.ts : undefined,
          createdBy: typeof e.createdBy === 'string' ? e.createdBy : undefined,
        })
        n++
      }
    } catch {
      /* skip a malformed edge line */
    }
  }
  return n
}

/**
 * BB7: GraphRAG one-hop fusion. After ranking, expand the top-`seeds` results one
 * hop along the graph; a neighbour scores `seedScore * edgeWeight * lambda` (lambda
 * capped at 0.5 so a fused neighbour never outranks a direct hit's full strength) and
 * is folded in — deduped by id keeping the best score, only edges with weight >= tau,
 * at most `cap` added. Pure: `neighbours` and `makeHit` are injected; `makeHit`
 * returns null to SKIP a neighbour whose entry is gone (edges outlive trimmed/
 * tombstoned entries) or fails the caller's filter. Byte-identical to `ranked` when
 * no qualifying neighbour is found.
 */
export function expandWithGraph<T extends { id: string; score: number }>(
  ranked: T[],
  neighbours: (id: string) => Array<{ id: string; weight: number }>,
  makeHit: (id: string, score: number) => T | null,
  opts: { seeds?: number; tau?: number; lambda?: number; cap?: number } = {},
): T[] {
  const seeds = opts.seeds ?? 5
  const tau = opts.tau ?? 0.1
  const lambda = Math.min(opts.lambda ?? 0.5, 0.5)
  const cap = opts.cap ?? 10
  const best = new Map<string, T>()
  for (const r of ranked) best.set(r.id, r)
  let added = 0
  for (const seed of ranked.slice(0, seeds)) {
    if (added >= cap) break
    for (const n of neighbours(seed.id)) {
      if (added >= cap) break
      if (n.weight < tau) continue
      const fused = seed.score * n.weight * lambda
      if (!(fused > 0)) continue
      const existing = best.get(n.id)
      if (existing) {
        if (fused > existing.score) best.set(n.id, { ...existing, score: fused }) // boost only
        continue
      }
      const hit = makeHit(n.id, fused)
      if (!hit) continue // entry trimmed/tombstoned or filtered out — edges outlive entries
      best.set(n.id, hit)
      added++
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score)
}

export function _resetGraphForTests(): void {
  adjacency.clear()
  reverseAdjacency.clear()
  edgeCount = 0
  graphPath = null
}
