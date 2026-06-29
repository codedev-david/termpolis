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
  // BB8: optional int8 scalar quantization. Float32 (exact, default) OR Int8 (round
  // of norm*127 → 384 B/vec, ~4x less RAM). Exactly one backing array is allocated.
  private readonly quantize: boolean
  private f32: Float32Array
  private i8: Int8Array
  private capacity: number
  private count = 0

  constructor(dim: number, initialCapacity = 1024, opts: { quantize?: boolean } = {}) {
    if (!Number.isInteger(dim) || dim <= 0) throw new Error('VectorStore: dim must be a positive integer')
    this.dim = dim
    this.quantize = opts.quantize ?? false
    this.capacity = Math.max(1, initialCapacity)
    this.f32 = new Float32Array(this.quantize ? 0 : this.capacity * dim)
    this.i8 = new Int8Array(this.quantize ? this.capacity * dim : 0)
  }

  get size(): number { return this.count }
  get dimension(): number { return this.dim }
  get quantized(): boolean { return this.quantize }

  /** Append a vector (stored L2-normalized). Returns its row index, or -1 for a
   *  dimension mismatch / zero vector (caller falls back to keyword search). */
  add(vec: ArrayLike<number>): number {
    const norm = normalizeToF32(vec, this.dim)
    if (!norm) return -1
    this.ensure(this.count + 1)
    const base = this.count * this.dim
    if (this.quantize) {
      for (let i = 0; i < this.dim; i++) this.i8[base + i] = Math.max(-127, Math.min(127, Math.round(norm[i] * 127)))
    } else {
      this.f32.set(norm, base)
    }
    return this.count++
  }

  /** Exact float dot of a normalized query against a float-stored row. */
  private dotF32(q: Float32Array, row: number): number {
    const base = row * this.dim
    let s = 0
    for (let i = 0; i < this.dim; i++) s += q[i] * this.f32[base + i]
    return s
  }
  /** Asymmetric rescore: float query × DEQUANTIZED int8 row (recovers most precision). */
  private dotI8(q: Float32Array, row: number): number {
    const base = row * this.dim
    let s = 0
    for (let i = 0; i < this.dim; i++) s += q[i] * (this.i8[base + i] / 127)
    return s
  }
  /** int8×int8 — cheap, approximate, only for relative ranking in the gather stage. */
  private dotI8I8(qi: Int8Array, row: number): number {
    const base = row * this.dim
    let s = 0
    for (let i = 0; i < this.dim; i++) s += qi[i] * this.i8[base + i]
    return s
  }

  // Bounded top-k by an injected per-row scorer (O(k) memory). Shared by both paths.
  private topK(k: number, allow: ((row: number) => boolean) | undefined, score: (row: number) => number): Scored[] {
    const top: Scored[] = []
    let min = -Infinity
    for (let row = 0; row < this.count; row++) {
      if (allow && !allow(row)) continue
      const s = score(row)
      if (top.length < k) {
        top.push({ row, score: s })
        if (top.length === k) { top.sort((a, b) => a.score - b.score); min = top[0].score }
      } else if (s > min) {
        top[0] = { row, score: s }
        top.sort((a, b) => a.score - b.score)
        min = top[0].score
      }
    }
    return top.sort((a, b) => b.score - a.score)
  }

  /**
   * Brute-force top-k by cosine. `allow(row)` (optional) gates eligible rows. Float
   * mode is an exact single-pass scan; int8 mode (BB8) is two-stage — gather the top
   * (k*4) by cheap int8×int8, then asymmetric float×int8 RESCORE to the final top-k.
   */
  searchTopK(query: ArrayLike<number>, k: number, allow?: (row: number) => boolean): Scored[] {
    const q = normalizeToF32(query, this.dim)
    if (!q || k <= 0) return []
    if (!this.quantize) return this.topK(k, allow, (row) => this.dotF32(q, row))
    const qi = new Int8Array(this.dim)
    for (let i = 0; i < this.dim; i++) qi[i] = Math.max(-127, Math.min(127, Math.round(q[i] * 127)))
    const gatherK = Math.min(this.count, Math.max(k * 4, k))
    const candidates = this.topK(gatherK, allow, (row) => this.dotI8I8(qi, row))
    return candidates
      .map((c) => ({ row: c.row, score: this.dotI8(q, c.row) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
  }

  /** The stored (normalized) vector at `row`, or null if out of range. Float mode
   *  returns an exact view; int8 mode returns a fresh DEQUANTIZED Float32 (approximate
   *  — the exact original lives in the device shard, so persistence is unaffected). */
  get(row: number): Float32Array | null {
    if (row < 0 || row >= this.count) return null
    const base = row * this.dim
    if (!this.quantize) return this.f32.subarray(base, base + this.dim)
    const out = new Float32Array(this.dim)
    for (let i = 0; i < this.dim; i++) out[i] = this.i8[base + i] / 127
    return out
  }

  /** Reset to empty (keeps the backing allocation for reuse). */
  clear(): void { this.count = 0 }

  /**
   * BB10: compact the store down to `liveRows` (in the given order), dropping the
   * orphaned vectors left behind by trims/deletes. Returns an old-row → new-row remap
   * so the caller can fix its row↔entry maps. Bounds steady-state RAM to ~live size.
   */
  compact(liveRows: number[]): Map<number, number> {
    const remap = new Map<number, number>()
    const cap = Math.max(1, liveRows.length)
    const freshF = new Float32Array(this.quantize ? 0 : cap * this.dim)
    const freshI = new Int8Array(this.quantize ? cap * this.dim : 0)
    let next = 0
    for (const oldRow of liveRows) {
      if (oldRow < 0 || oldRow >= this.count || remap.has(oldRow)) continue
      const src = oldRow * this.dim, dst = next * this.dim
      if (this.quantize) freshI.set(this.i8.subarray(src, src + this.dim), dst)
      else freshF.set(this.f32.subarray(src, src + this.dim), dst)
      remap.set(oldRow, next)
      next++
    }
    this.f32 = freshF
    this.i8 = freshI
    this.capacity = cap
    this.count = next
    return remap
  }

  private ensure(n: number): void {
    if (n <= this.capacity) return
    let cap = this.capacity
    while (cap < n) cap *= 2
    if (this.quantize) {
      const next = new Int8Array(cap * this.dim)
      next.set(this.i8.subarray(0, this.count * this.dim))
      this.i8 = next
    } else {
      const next = new Float32Array(cap * this.dim)
      next.set(this.f32.subarray(0, this.count * this.dim))
      this.f32 = next
    }
    this.capacity = cap
  }
}
