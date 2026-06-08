// Packed vector store — Phase 1 of the scalable-recall work.
//
// All embeddings live in ONE contiguous Float32Array instead of per-entry
// number[] (JS doubles, one heap object each). That roughly halves memory
// (4 bytes vs 8 per component, no per-object overhead) and makes the similarity
// scan a tight, cache-friendly dot-product loop — far faster than per-object
// cosine. Vectors are L2-normalized on insert, so cosine similarity is just the
// dot product.
//
// This deliberately stays pure TypeScript (no native binary, no WASM) so it ships
// as ordinary JS — preserving the no-Defender-FP / no-per-ABI-build property the
// rest of the memory stack was built around. Phase 2 (an HNSW graph for
// sub-linear search) is layered on top of this same packed storage.

export interface Scored {
  row: number
  score: number
}

// Normalize an arbitrary vector into a fresh Float32Array, or null if the
// dimension is wrong or it's a zero vector.
export function normalizeToF32(vec: ArrayLike<number>, dim: number): Float32Array | null {
  if (!vec || vec.length !== dim) return null
  let norm = 0
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm)
  if (norm === 0) return null
  const out = new Float32Array(dim)
  const inv = 1 / norm
  for (let i = 0; i < dim; i++) out[i] = vec[i] * inv
  return out
}

export class VectorStore {
  private readonly dim: number
  private data: Float32Array
  private capacity: number
  private count = 0

  constructor(dim: number, initialCapacity = 1024) {
    if (!Number.isInteger(dim) || dim <= 0) throw new Error('VectorStore: dim must be a positive integer')
    this.dim = dim
    this.capacity = Math.max(1, initialCapacity)
    this.data = new Float32Array(this.capacity * dim)
  }

  get size(): number { return this.count }
  get dimension(): number { return this.dim }

  /** Append a vector (stored L2-normalized). Returns its row index, or -1 for a
   *  dimension mismatch / zero vector (caller falls back to keyword search). */
  add(vec: ArrayLike<number>): number {
    const norm = normalizeToF32(vec, this.dim)
    if (!norm) return -1
    this.ensure(this.count + 1)
    this.data.set(norm, this.count * this.dim)
    return this.count++
  }

  /** Dot product (= cosine, since rows are normalized) of a normalized query
   *  against the stored row. */
  private dot(q: Float32Array, row: number): number {
    const base = row * this.dim
    let s = 0
    for (let i = 0; i < this.dim; i++) s += q[i] * this.data[base + i]
    return s
  }

  /**
   * Brute-force top-k by cosine. `allow(row)` (optional) gates which rows are
   * eligible — used for agent/kind/taskId filters and to skip deleted rows.
   * Keeps only k results in flight, so memory is O(k), not O(n).
   */
  searchTopK(query: ArrayLike<number>, k: number, allow?: (row: number) => boolean): Scored[] {
    const q = normalizeToF32(query, this.dim)
    if (!q || k <= 0) return []
    const top: Scored[] = []
    let min = -Infinity
    for (let row = 0; row < this.count; row++) {
      if (allow && !allow(row)) continue
      const score = this.dot(q, row)
      if (top.length < k) {
        top.push({ row, score })
        if (top.length === k) { top.sort((a, b) => a.score - b.score); min = top[0].score }
      } else if (score > min) {
        top[0] = { row, score }
        top.sort((a, b) => a.score - b.score)
        min = top[0].score
      }
    }
    return top.sort((a, b) => b.score - a.score)
  }

  /** A view of the stored (normalized) vector at `row`, or null if out of range.
   *  Used to reconstruct an entry's embedding (e.g. when snapshotting to disk). */
  get(row: number): Float32Array | null {
    if (row < 0 || row >= this.count) return null
    return this.data.subarray(row * this.dim, (row + 1) * this.dim)
  }

  /** Reset to empty (keeps the backing allocation for reuse). */
  clear(): void { this.count = 0 }

  private ensure(n: number): void {
    if (n <= this.capacity) return
    let cap = this.capacity
    while (cap < n) cap *= 2
    const next = new Float32Array(cap * this.dim)
    next.set(this.data.subarray(0, this.count * this.dim))
    this.data = next
    this.capacity = cap
  }
}
