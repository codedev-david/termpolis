// asyncPool.mapLimit: at most `limit` calls run at once, results keep the order of the items. Counters only.
import { describe, it, expect } from 'vitest'
import { mapLimit } from '../../src/main/asyncPool'

describe('mapLimit', () => {
  it('never runs more than the limit at once, however many items', async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit(Array.from({ length: 100 }, (_, i) => i), 4, async (i) => {
      running++
      peak = Math.max(peak, running)
      await new Promise<void>((r) => setImmediate(r))
      running--
      return i * 2
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
    expect(out).toEqual(Array.from({ length: 100 }, (_, i) => i * 2))
  })

  it('keeps the order of the items even when later ones finish first', async () => {
    const out = await mapLimit([30, 1, 20, 2], 4, async (ms, i) => { await new Promise((r) => setTimeout(r, ms)); return i })
    expect(out).toEqual([0, 1, 2, 3])
  })

  it('handles no items, a limit larger than the items, and a limit of zero or less (nothing runs, nothing hangs)', async () => {
    expect(await mapLimit([], 4, async (x) => x)).toEqual([])
    expect(await mapLimit([1, 2], 50, async (x) => x + 1)).toEqual([2, 3])
    expect(await mapLimit([1, 2], 0, async (x) => x)).toEqual([undefined, undefined])
  })

  it('a rejection rejects the whole map (callers catch inside fn when one failure must not stop the rest)', async () => {
    await expect(mapLimit([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error('boom'); return x })).rejects.toThrow('boom')
  })
})
