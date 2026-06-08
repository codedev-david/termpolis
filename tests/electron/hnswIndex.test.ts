import { describe, it, expect } from 'vitest'
import { HnswIndex } from '../../src/main/hnswIndex'

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

  it('honors the allow() filter so deleted/filtered rows are excluded', () => {
    const dim = 8
    const r = rng(3)
    const vecs = Array.from({ length: 100 }, () => randomUnit(dim, r))
    const idx = new HnswIndex((row) => vecs[row] ?? null, { rng: rng(4) })
    for (let i = 0; i < 100; i++) idx.add(i)
    const got = idx.search(vecs[10], 5, (row) => row !== 10)
    expect(got.some((x) => x.row === 10)).toBe(false)
  })
})
