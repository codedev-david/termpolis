// frameSampler: the frame-time ring the 3D map's loop feeds (look spec §6.1, plan Task 1). Pure: the gaps are given.
import { describe, expect, test } from 'vitest'
import { createFrameSampler } from '../../../src/renderer/src/world/engine/frameSampler'

const EMPTY = { frames: 0, p50: 0, p95: 0, p99: 0, worst: 0 }

describe('frameSampler', () => {
  test('p50/p95/p99/worst by nearest rank over the counted gaps', () => {
    const s = createFrameSampler()
    expect(s.stats()).toEqual(EMPTY)
    // 1..100 ms in a shuffled order: nearest rank is the ceil(n * p)th smallest.
    const gaps = Array.from({ length: 100 }, (_, i) => ((i * 37) % 100) + 1)
    for (const g of gaps) s.add(g, true)
    expect(s.stats()).toEqual({ frames: 100, p50: 50, p95: 95, p99: 99, worst: 100 })
    // Twenty gaps: p95 is the 19th, p99 the 20th.
    const t = createFrameSampler()
    for (let i = 1; i <= 20; i++) t.add(i, true)
    expect(t.stats()).toEqual({ frames: 20, p50: 10, p95: 19, p99: 20, worst: 20 })
    // One gap is every percentile.
    const one = createFrameSampler()
    one.add(16.7, true)
    expect(one.stats()).toEqual({ frames: 1, p50: 16.7, p95: 16.7, p99: 16.7, worst: 16.7 })
  })

  test('a gap after an uncounted frame is not counted (idle sleep never reads as a 2 s frame)', () => {
    const s = createFrameSampler()
    s.add(16, true)
    s.add(17, true)
    s.add(2000, false) // the first frame after an idle sleep: its gap is the sleep
    s.add(18, true)
    expect(s.stats()).toEqual({ frames: 3, p50: 17, p95: 18, p99: 18, worst: 18 })
  })

  test('skip(5) drops the next five gaps', () => {
    const s = createFrameSampler()
    s.skip(5)
    for (const g of [90, 80, 70, 60, 50]) s.add(g, true)
    expect(s.stats().frames).toBe(0)
    s.add(16, true)
    expect(s.stats()).toEqual({ frames: 1, p50: 16, p95: 16, p99: 16, worst: 16 })
    // A skip while one runs keeps the longer of the two; an uncounted frame uses up a skipped one as well.
    s.skip(3)
    s.skip(2)
    s.add(40, false)
    s.add(41, true)
    s.add(42, true)
    s.add(20, true)
    expect(s.stats()).toEqual({ frames: 2, p50: 16, p95: 20, p99: 20, worst: 20 })
    s.skip(0)
    s.add(15, true)
    expect(s.stats().frames).toBe(3)
  })

  test('the ring keeps the last 600 gaps', () => {
    const s = createFrameSampler()
    for (let i = 0; i < 600; i++) s.add(1000, true) // old slow frames, pushed out below
    for (let i = 0; i < 600; i++) s.add(16, true)
    expect(s.stats()).toEqual({ frames: 600, p50: 16, p95: 16, p99: 16, worst: 16 })
    const small = createFrameSampler(3)
    for (const g of [5, 6, 7, 8]) small.add(g, true)
    expect(small.stats()).toEqual({ frames: 3, p50: 7, p95: 8, p99: 8, worst: 8 })
  })

  test('window() gives the gaps since the last window, and reset() forgets everything', () => {
    const s = createFrameSampler(4)
    s.add(10, true)
    s.add(30, true)
    expect(s.window()).toEqual({ frames: 2, p50: 10, p95: 30, p99: 30, worst: 30 })
    expect(s.window()).toEqual(EMPTY)
    // A window holds ten rings' worth, then keeps the newest.
    for (let i = 1; i <= 45; i++) s.add(i, true)
    const w = s.window()
    expect(w.frames).toBe(40)
    expect(w.worst).toBe(45)
    expect(w.p50).toBe(25) // 6..45: the 20th smallest
    expect(s.stats()).toEqual({ frames: 4, p50: 43, p95: 45, p99: 45, worst: 45 })
    s.skip(2)
    s.add(9, true)
    s.reset()
    expect(s.stats()).toEqual(EMPTY)
    expect(s.window()).toEqual(EMPTY)
    s.add(9, true) // the skip went with the reset
    expect(s.stats().frames).toBe(1)
  })
})
