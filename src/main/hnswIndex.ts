// Hierarchical Navigable Small World (HNSW) index — Phase 2 of scalable recall.
//
// A multi-layer proximity graph that turns nearest-neighbour search from O(n)
// brute force into ~O(log n): query descends from a sparse top layer to the
// dense base layer, greedily walking toward the target. Built incrementally
// (cheap inserts), it lets the memory brain scale to millions of chunks with
// sub-10 ms recall.
//
// Pure TypeScript over a vector accessor (rows in the packed VectorStore) — no
// native binary, no WASM, so it ships as ordinary JS like the rest of the stack.
// Vectors are L2-normalized, so similarity = dot product and distance = 1 - dot.
// Deletion is handled by the caller's `allow` filter at search time (a removed
// row simply stops being eligible), so the graph never needs costly repair.

type GetVec = (row: number) => Float32Array | null

export interface HnswOptions {
  M?: number              // max neighbours per node per layer (base layer uses 2M)
  efConstruction?: number // candidate breadth while building (higher = better graph)
  efSearch?: number       // candidate breadth while querying (higher = better recall)
  rng?: () => number      // layer-assignment randomness; injectable for deterministic tests
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

// Binary heap of {row, d}. `cmp(a,b) < 0` ⇒ a has priority. We use a min-heap by
// distance for the exploration frontier and a max-heap by distance for the
// kept-best set (so the worst is poppable in O(log n)).
class Heap {
  private h: { row: number; d: number }[] = []
  constructor(private readonly worstFirst: boolean) {} // true ⇒ max-heap by d
  get size(): number { return this.h.length }
  peek(): { row: number; d: number } | undefined { return this.h[0] }
  private less(i: number, j: number): boolean {
    return this.worstFirst ? this.h[i].d > this.h[j].d : this.h[i].d < this.h[j].d
  }
  push(item: { row: number; d: number }): void {
    const h = this.h
    h.push(item)
    let i = h.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.less(i, p)) { [h[i], h[p]] = [h[p], h[i]]; i = p } else break
    }
  }
  pop(): { row: number; d: number } | undefined {
    const h = this.h
    if (h.length === 0) return undefined
    const top = h[0]
    const last = h.pop()!
    if (h.length > 0) {
      h[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2
        let m = i
        if (l < h.length && this.less(l, m)) m = l
        if (r < h.length && this.less(r, m)) m = r
        if (m === i) break
        ;[h[i], h[m]] = [h[m], h[i]]
        i = m
      }
    }
    return top
  }
}

export class HnswIndex {
  private readonly M: number
  private readonly M0: number
  private readonly efC: number
  private readonly efS: number
  private readonly mL: number
  private readonly rng: () => number
  private readonly links = new Map<number, number[][]>() // row → links[layer] = neighbour rows
  private readonly nodeLevel = new Map<number, number>()
  private entry = -1
  private topLayer = -1

  constructor(private readonly getVec: GetVec, opts: HnswOptions = {}) {
    this.M = opts.M ?? 16
    this.M0 = this.M * 2
    this.efC = opts.efConstruction ?? 200
    this.efS = opts.efSearch ?? 64
    this.mL = 1 / Math.log(this.M)
    this.rng = opts.rng ?? Math.random
  }

  get size(): number { return this.nodeLevel.size }

  private d(q: Float32Array, row: number): number {
    const v = this.getVec(row)
    return v ? 1 - dot(q, v) : Infinity
  }

  private neighbours(row: number, layer: number): number[] {
    const ls = this.links.get(row)
    return ls && ls[layer] ? ls[layer] : []
  }

  private randomLevel(): number {
    return Math.floor(-Math.log(this.rng() || 1e-9) * this.mL)
  }

  /** Greedy walk on one layer: from the entry points, hop to ever-closer nodes. */
  private greedy(q: Float32Array, entryRows: number[], layer: number): number {
    let best = entryRows[0]
    let bestD = this.d(q, best)
    let improved = true
    while (improved) {
      improved = false
      for (const n of this.neighbours(best, layer)) {
        const dn = this.d(q, n)
        if (dn < bestD) { bestD = dn; best = n; improved = true }
      }
    }
    return best
  }

  /** Best `ef` nodes near q on `layer`, starting from `entryRows`. */
  private searchLayer(q: Float32Array, entryRows: number[], ef: number, layer: number): { row: number; d: number }[] {
    const visited = new Set<number>()
    const frontier = new Heap(false) // min-heap: explore closest first
    const kept = new Heap(true)      // max-heap: worst of the kept-best is on top
    for (const r of entryRows) {
      const dr = this.d(q, r)
      visited.add(r)
      frontier.push({ row: r, d: dr })
      kept.push({ row: r, d: dr })
    }
    while (frontier.size > 0) {
      const c = frontier.pop()!
      const worst = kept.peek()!
      if (kept.size >= ef && c.d > worst.d) break
      for (const n of this.neighbours(c.row, layer)) {
        if (visited.has(n)) continue
        visited.add(n)
        const dn = this.d(q, n)
        const w = kept.peek()
        if (kept.size < ef || (w && dn < w.d)) {
          frontier.push({ row: n, d: dn })
          kept.push({ row: n, d: dn })
          if (kept.size > ef) kept.pop()
        }
      }
    }
    const out: { row: number; d: number }[] = []
    while (kept.size > 0) out.push(kept.pop()!)
    return out.reverse() // nearest first
  }

  /** Pick the `m` closest candidates (simple, high-recall on normalized embeddings). */
  private select(candidates: { row: number; d: number }[], m: number): number[] {
    return candidates.slice().sort((a, b) => a.d - b.d).slice(0, m).map((c) => c.row)
  }

  private connect(row: number, layer: number, neighbours: number[]): void {
    let ls = this.links.get(row)
    if (!ls) { ls = []; this.links.set(row, ls) }
    ls[layer] = neighbours.slice()
  }

  /** Insert the vector stored at `row` into the graph. */
  add(row: number): void {
    if (this.nodeLevel.has(row)) return
    const q = this.getVec(row)
    if (!q) return
    const level = this.randomLevel()
    this.nodeLevel.set(row, level)
    this.links.set(row, [])

    if (this.entry === -1) { this.entry = row; this.topLayer = level; return }

    let cur = this.entry
    for (let l = this.topLayer; l > level; l--) cur = this.greedy(q, [cur], l)

    for (let l = Math.min(this.topLayer, level); l >= 0; l--) {
      const cand = this.searchLayer(q, [cur], this.efC, l)
      const m = l === 0 ? this.M0 : this.M
      const neigh = this.select(cand, m)
      this.connect(row, l, neigh)
      // Wire back-links and prune over-connected neighbours.
      for (const n of neigh) {
        const nl = this.neighbours(n, l)
        if (!nl.includes(row)) nl.push(row)
        const cap = l === 0 ? this.M0 : this.M
        if (nl.length > cap) {
          const nv = this.getVec(n)
          const pruned = nv
            ? this.select(nl.map((r) => ({ row: r, d: this.d(nv, r) })), cap)
            : nl.slice(0, cap)
          this.connect(n, l, pruned)
        } else {
          this.connect(n, l, nl)
        }
      }
      cur = cand.length ? cand[0].row : cur
    }

    if (level > this.topLayer) { this.entry = row; this.topLayer = level }
  }

  /**
   * Approximate k nearest to `query`. `allow(row)` (optional) gates eligible rows
   * (filters + deletions) — ineligible rows are still traversed for connectivity
   * but never returned. Scores are cosine similarity (higher = better).
   */
  search(query: Float32Array, k: number, allow?: (row: number) => boolean): { row: number; score: number }[] {
    if (this.entry === -1 || k <= 0) return []
    let cur = this.entry
    for (let l = this.topLayer; l > 0; l--) cur = this.greedy(query, [cur], l)
    const ef = Math.max(this.efS, k)
    const found = this.searchLayer(query, [cur], ef, 0)
    const out: { row: number; score: number }[] = []
    for (const f of found) {
      if (allow && !allow(f.row)) continue
      out.push({ row: f.row, score: 1 - f.d })
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, k)
  }

  // ---- Persistence ----
  // The graph is keyed by store rows; a serialized graph is only valid against a
  // vector store with the SAME rows (the caller guards this with a content
  // fingerprint), so loading skips the O(n log n) rebuild on launch.

  toJSON(): SerializedHnsw {
    const nodes: SerializedNode[] = []
    for (const [row, level] of this.nodeLevel) nodes.push([row, level, this.links.get(row) ?? []])
    return { v: 1, M: this.M, efC: this.efC, efS: this.efS, entry: this.entry, topLayer: this.topLayer, nodes }
  }

  static fromJSON(data: SerializedHnsw, getVec: GetVec): HnswIndex {
    const idx = new HnswIndex(getVec, { M: data.M, efConstruction: data.efC, efSearch: data.efS })
    for (const [row, level, links] of data.nodes) {
      idx.nodeLevel.set(row, level)
      idx.links.set(row, links.map((l) => l.slice()))
    }
    idx.entry = data.entry
    idx.topLayer = data.topLayer
    return idx
  }
}

type SerializedNode = [number, number, number[][]] // [row, level, links-per-layer]
export interface SerializedHnsw {
  v: 1
  M: number
  efC: number
  efS: number
  entry: number
  topLayer: number
  nodes: SerializedNode[]
}
