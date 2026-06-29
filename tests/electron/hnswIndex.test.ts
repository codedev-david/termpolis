import { describe, it, expect } from 'vitest'
import { HnswIndex, efForK, selectHeuristic } from '../../src/main/hnswIndex'

// Deterministic RNG (mulberry32) so build + recall are reproducible.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomUnit(dim: number, r: () => number): Float32Array {
  const v = new Float32Array(dim)
  let norm = 0
  for (let i = 0; i < dim; i++) { v[i] = r() * 2 - 1; norm += v[i] * v[i] }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i++) v[i] /= norm
  return v
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

describe('HnswIndex', () => {
  it('returns [] when empty', () => {
    const idx = new HnswIndex(() => null)
    expect(idx.search(new Float32Array(4), 5)).toEqual([])
  })

  it('ignores duplicate adds', () => {
    const v = new Float32Array([1, 0, 0, 0])
    const idx = new HnswIndex(() => v)
    idx.add(0)
    idx.add(0)
    expect(idx.size).toBe(1)
  })

  it('finds the exact match for an indexed vector', () => {
    const dim = 16
    const r = rng(1)
    const vecs = Array.from({ length: 200 }, () => randomUnit(dim, r))
    const idx = new HnswIndex((row) => vecs[row] ?? null, { rng: rng(7) })
    for (let i = 0; i < vecs.length; i++) idx.add(i)
    expect(idx.size).toBe(200)
    const top = idx.search(vecs[42], 1)
    expect(top[0].row).toBe(42)
    expect(top[0].score).toBeCloseTo(1, 4)
  })

  it('achieves high recall@10 vs brute-force ground truth (the correctness gate)', () => {
    const dim = 32
    const N = 1000
    const r = rng(123)
    const vecs = Array.from({ length: N }, () => randomUnit(dim, r))
    const idx = new HnswIndex((row) => vecs[row] ?? null, { rng: rng(99), efSearch: 96 })
    for (let i = 0; i < N; i++) idx.add(i)

    const k = 10
    const qr = rng(55)
    let hit = 0
    let total = 0
    for (let t = 0; t < 30; t++) {
      const q = randomUnit(dim, qr)
      const truth = vecs
        .map((v, row) => ({ row, s: dot(q, v) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, k)
        .map((x) => x.row)
      const got = new Set(idx.search(q, k).map((x) => x.row))
      for (const row of truth) { total++; if (got.has(row)) hit++ }
    }
    expect(hit / total).toBeGreaterThan(0.9)
  })

  it('heuristic:true (BB9 opt-in) keeps recall@10 high at adequate efSearch', () => {
    const dim = 32, N = 300, r = rng(123)
    const vecs = Array.from({ length: N }, () => randomUnit(dim, r))
    const idx = new HnswIndex((row) => vecs[row] ?? null, { rng: rng(99), efSearch: 200, heuristic: true })
    for (let i = 0; i < N; i++) idx.add(i)
    const k = 10, qr = rng(55)
    let hit = 0, total = 0
    for (let t = 0; t < 20; t++) {
      const q = randomUnit(dim, qr)
      const truth = vecs.map((v, row) => ({ row, s: dot(q, v) })).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.row)
      const got = new Set(idx.search(q, k).map((x) => x.row))
      for (const row of truth) { total++; if (got.has(row)) hit++ }
    }
    expect(hit / total).toBeGreaterThan(0.9)
  })

  it('heuristic:false falls back to simple closest-m selection and still finds the exact match (BB9)', () => {
    const dim = 16
    const r = rng(1)
    const vecs = Array.from({ length: 80 }, () => randomUnit(dim, r))
    const idx = new HnswIndex((row) => vecs[row] ?? null, { rng: rng(7), heuristic: false })
    for (let i = 0; i < vecs.length; i++) idx.add(i)
    expect(idx.search(vecs[10], 1)[0].row).toBe(10)
  })

  it('honors an explicit efSearch override on search() and still finds the exact match (QW3)', () => {
    const dim = 16
    const r = rng(1)
    const vecs = Array.from({ length: 200 }, () => randomUnit(dim, r))
    const idx = new HnswIndex((row) => vecs[row] ?? null, { rng: rng(7) })
    for (let i = 0; i < vecs.length; i++) idx.add(i)
    // Override path (explicit 4th arg) and the default efForK path both find the match.
    expect(idx.search(vecs[42], 1, undefined, 200)[0].row).toBe(42)
    expect(idx.search(vecs[42], 30)[0].row).toBe(42) // k>=25 exercises efForK widening
  })

  it('honors the allow() filter so deleted/filtered rows are excluded', () => {
    const dim = 8
    const r = rng(3)
    const vecs = Array.from({ length: 100 }, () => randomUnit(dim, r))
    const idx = new HnswIndex((row) => vecs[row] ?? null, { rng: rng(4) })
    for (let i = 0; i < 100; i++) idx.add(i)
    const got = idx.search(vecs[10], 5, (row) => row !== 10)
    expect(got.some((x) => x.row === 10)).toBe(false)
  })

  it('serializes + deserializes to an identical graph (persistence)', () => {
    const dim = 16
    const r = rng(11)
    const vecs = Array.from({ length: 300 }, () => randomUnit(dim, r))
    const idx = new HnswIndex((row) => vecs[row] ?? null, { rng: rng(22) })
    for (let i = 0; i < vecs.length; i++) idx.add(i)
    const json = JSON.parse(JSON.stringify(idx.toJSON())) // round-trip through disk-shaped JSON
    const restored = HnswIndex.fromJSON(json, (row) => vecs[row] ?? null)
    expect(restored.size).toBe(idx.size)
    // identical graph ⇒ identical search results for any query
    for (const seed of [33, 44, 55]) {
      const q = randomUnit(dim, rng(seed))
      expect(restored.search(q, 5).map((x) => x.row)).toEqual(idx.search(q, 5).map((x) => x.row))
    }
  })
})

describe('efForK — Pareto-safe adaptive query breadth (QW3)', () => {
  it('never drops below the previous max(efS, k) for any realistic k (no recall regression)', () => {
    const efS = 96
    for (const k of [1, 5, 10, 24, 25, 40, 50, 96, 97, 100, 150, 200]) {
      expect(efForK(k, efS)).toBeGreaterThanOrEqual(Math.max(efS, k))
    }
  })
  it('keeps the dominant small-k path unchanged (k<=24 stays at efS)', () => {
    expect(efForK(10, 96)).toBe(96)
    expect(efForK(24, 96)).toBe(96)
  })
  it('widens the large-k digest/primer path up to the cap', () => {
    expect(efForK(25, 96)).toBe(100)  // round(25*4)
    expect(efForK(50, 96)).toBe(200)  // round(50*4)=200 -> at cap
    expect(efForK(100, 96)).toBe(200) // round(400) -> capped
  })
  it('never exceeds the max cap and honors custom mult/max', () => {
    expect(efForK(1000, 96)).toBe(200)
    expect(efForK(100, 96, 4, 150)).toBe(150)
    expect(efForK(10, 96, 8)).toBe(96)   // 80 < efS -> efS
    expect(efForK(20, 96, 8)).toBe(160)  // round(160)
  })
})

describe('selectHeuristic — Alg-4 diversity selection (BB9)', () => {
  // base node + 3 candidates: 0 and 1 are a tight cluster; 2 is far from both.
  const dist = (x: number, y: number): number =>
    ({ '0-1': 0.02, '0-2': 0.5, '1-2': 0.5 } as Record<string, number>)[[x, y].sort().join('-')] ?? 0
  const cands = [{ row: 0, d: 0.1 }, { row: 1, d: 0.12 }, { row: 2, d: 0.2 }]

  it('keeps a candidate only if it is closer to base than to kept neighbours (drops near-dups)', () => {
    // 0 kept; 1 is closer to 0 (0.02) than to base (0.12) → pruned; 2 is far → kept.
    expect(selectHeuristic(cands, 2, dist, false)).toEqual([0, 2])
  })
  it('backfills the closest pruned candidates when under m (keepPruned)', () => {
    expect(selectHeuristic(cands, 3, dist, true).slice().sort()).toEqual([0, 1, 2])
  })
  it('returns at most m, closest-to-base first', () => {
    expect(selectHeuristic([{ row: 5, d: 0.9 }, { row: 3, d: 0.1 }], 1, () => 1)).toEqual([3])
  })
})
