import { describe, it, expect } from 'vitest'
import { VectorStore, normalizeToF32 } from '../../src/main/vectorStore'

describe('normalizeToF32', () => {
  it('normalizes to unit length', () => {
    const v = normalizeToF32([3, 4], 2)!
    expect(v).not.toBeNull()
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6)
    expect(v[0]).toBeCloseTo(0.6, 6)
    expect(v[1]).toBeCloseTo(0.8, 6)
  })
  it('rejects dim mismatch and zero vectors', () => {
    expect(normalizeToF32([1, 2, 3], 2)).toBeNull()
    expect(normalizeToF32([0, 0], 2)).toBeNull()
  })
})

describe('VectorStore', () => {
  it('rejects a non-positive dim', () => {
    expect(() => new VectorStore(0)).toThrow()
    expect(() => new VectorStore(-1)).toThrow()
  })

  it('adds vectors and reports size + dimension', () => {
    const s = new VectorStore(3)
    expect(s.dimension).toBe(3)
    expect(s.add([1, 0, 0])).toBe(0)
    expect(s.add([0, 1, 0])).toBe(1)
    expect(s.size).toBe(2)
  })

  it('rejects dim-mismatched and zero vectors with -1', () => {
    const s = new VectorStore(3)
    expect(s.add([1, 0])).toBe(-1)
    expect(s.add([0, 0, 0])).toBe(-1)
    expect(s.size).toBe(0)
  })

  it('ranks the nearest vector first (cosine via dot)', () => {
    const s = new VectorStore(3)
    s.add([1, 0, 0])     // row 0 — exact match
    s.add([0, 1, 0])     // row 1 — orthogonal
    s.add([0.9, 0.1, 0]) // row 2 — close to row 0
    const res = s.searchTopK([1, 0, 0], 2)
    expect(res).toHaveLength(2)
    expect(res[0].row).toBe(0)
    expect(res[0].score).toBeCloseTo(1, 5)
    expect(res[1].row).toBe(2)
    expect(res[0].score).toBeGreaterThan(res[1].score)
  })

  it('normalizes on add so magnitude does not affect ranking', () => {
    const s = new VectorStore(2)
    s.add([100, 0]) // same direction as [1,0], just longer
    expect(s.searchTopK([1, 0], 1)[0].score).toBeCloseTo(1, 5)
  })

  it('honors the allow() filter', () => {
    const s = new VectorStore(2)
    s.add([1, 0]) // row 0
    s.add([1, 0]) // row 1 (identical)
    const res = s.searchTopK([1, 0], 5, (row) => row === 1)
    expect(res).toHaveLength(1)
    expect(res[0].row).toBe(1)
  })

  it('caps results at k', () => {
    const s = new VectorStore(2)
    for (let i = 0; i < 10; i++) s.add([Math.cos(i), Math.sin(i)])
    expect(s.searchTopK([1, 0], 3)).toHaveLength(3)
  })

  it('returns [] for an empty store, k<=0, or a bad query', () => {
    const s = new VectorStore(2)
    expect(s.searchTopK([1, 0], 3)).toEqual([])
    s.add([1, 0])
    expect(s.searchTopK([1, 0], 0)).toEqual([])
    expect(s.searchTopK([1, 0, 0], 3)).toEqual([]) // dim mismatch
  })

  it('grows past the initial capacity without losing data', () => {
    const s = new VectorStore(2, 2) // tiny initial capacity → forces grows
    for (let i = 0; i < 50; i++) s.add([i + 1, 0])
    expect(s.size).toBe(50)
    expect(s.searchTopK([1, 0], 1)[0].score).toBeCloseTo(1, 5)
  })

  it('clear() resets size', () => {
    const s = new VectorStore(2)
    s.add([1, 0]); s.add([0, 1])
    s.clear()
    expect(s.size).toBe(0)
    expect(s.searchTopK([1, 0], 1)).toEqual([])
  })

  it('get() returns the stored (normalized) vector and null out of range', () => {
    const s = new VectorStore(2)
    const row = s.add([3, 4]) // normalizes to [0.6, 0.8]
    const v = s.get(row)!
    expect(v).not.toBeNull()
    expect(v[0]).toBeCloseTo(0.6, 5)
    expect(v[1]).toBeCloseTo(0.8, 5)
    expect(s.get(-1)).toBeNull()
    expect(s.get(99)).toBeNull()
  })
})

describe('VectorStore.compact (BB10)', () => {
  it('keeps only the live rows in order and remaps old→new', () => {
    const s = new VectorStore(2)
    s.add([1, 0]); s.add([0, 1]); s.add([1, 1]); s.add([0.5, 0.5]) // rows 0,1,2,3
    expect(s.size).toBe(4)
    const remap = s.compact([2, 0]) // keep old rows 2 then 0
    expect(s.size).toBe(2)
    expect(remap.get(2)).toBe(0)
    expect(remap.get(0)).toBe(1)
    expect(s.get(0)![0]).toBeCloseTo(Math.SQRT1_2, 5) // new row 0 = old row 2 = normalize([1,1])
    expect(s.searchTopK([1, 0], 1)[0].row).toBe(1)    // old row 0 ([1,0]) → new row 1
  })
  it('drops out-of-range and duplicate rows safely', () => {
    const s = new VectorStore(2)
    s.add([1, 0]); s.add([0, 1])
    const remap = s.compact([0, 0, 99, -1]) // duplicate 0, out-of-range 99/-1
    expect(s.size).toBe(1)
    expect(remap.get(0)).toBe(0)
  })
})
