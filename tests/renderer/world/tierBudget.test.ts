// tierBudget: each quality tier's pixel budget, the render targets that count toward it, and the shrunk-buffer test
// (look spec §5 and §5.3, plan Task 0).
import { describe, expect, it } from 'vitest'
import { shrunk, targetsPixels, TIER_MAX_PIXELS, tierPixelRatio, type TierName } from '../../../src/renderer/src/world/engine/tierBudget'
import { SOFTWARE_MAX_PIXELS } from '../../../src/renderer/src/world/engine/viewMath'

const NO_CAP: [number, number] = [16384, 16384]
/** The drawing buffer a view gets at the tier's ratio, as three.js sizes the canvas (floored). */
const buffer = (tier: TierName, dpr: number, w: number, h: number, software = false): [number, number] => {
  const r = tierPixelRatio(tier, dpr, w, h, NO_CAP, software)
  return [Math.floor(w * r), Math.floor(h * r)]
}
const area = ([w, h]: [number, number]): number => w * h

describe('tierBudget', () => {
  it('high allows 3840x2160 drawing buffers and no more; low and flat allow 1920x1080', () => {
    expect(TIER_MAX_PIXELS).toEqual({ high: 3840 * 2160, low: 1920 * 1080, flat: 1920 * 1080 })
    // Each tier's own share of the screen's ratio where the budget holds nothing back.
    expect(tierPixelRatio('high', 3, 800, 600, NO_CAP, false)).toBe(2)
    expect(tierPixelRatio('high', 1.5, 800, 600, NO_CAP, false)).toBe(1.5)
    expect(tierPixelRatio('low', 2, 800, 600, NO_CAP, false)).toBe(0.75)
    expect(tierPixelRatio('low', 0.8, 800, 600, NO_CAP, false)).toBeCloseTo(0.6)
    expect(tierPixelRatio('flat', 2, 800, 600, NO_CAP, false)).toBe(1)
    expect(tierPixelRatio('flat', 0.5, 800, 600, NO_CAP, false)).toBe(0.5)
    // A 4K view at 2x: High draws a 3840x2160 buffer, the others a 1080p one.
    expect(buffer('high', 2, 3840, 2160)).toEqual([3840, 2160])
    expect(buffer('high', 1, 3840, 2160)).toEqual([3840, 2160])
    expect(area(buffer('low', 2, 3840, 2160))).toBeLessThanOrEqual(1920 * 1080)
    expect(area(buffer('flat', 2, 3840, 2160))).toBeLessThanOrEqual(1920 * 1080)
    expect(area(buffer('flat', 1, 3840, 2160))).toBeGreaterThan(1920 * 1080 * 0.999)
    // A 5K view at 2x: no tier goes past its budget.
    for (const tier of ['high', 'low', 'flat'] as const) expect(area(buffer(tier, 2, 5120, 2880))).toBeLessThanOrEqual(TIER_MAX_PIXELS[tier])
    expect(area(buffer('high', 2, 5120, 2880))).toBeGreaterThan(TIER_MAX_PIXELS.high * 0.999)
    // The GPU's largest buffer still caps every tier (bufferRatio), after the budget.
    expect(tierPixelRatio('high', 2, 3840, 2160, [2048, 4096], false)).toBe(2048 / 3840)
  })

  it('the bloom chain and composer targets count toward the budget', () => {
    // Flat: the canvas alone. High: the canvas, the composer's two targets and the bloom chain at full size (the bright
    // pass at half size, then five mips of two targets each from half size down). Low: the bloom chain from half size.
    expect(targetsPixels('flat', 1920, 1080)).toBe(1920 * 1080)
    const chain = (w: number, h: number): number => {
      let n = (w / 2) * (h / 2)
      for (let i = 0, x = w / 2, y = h / 2; i < 5; i++, x = Math.round(x / 2), y = Math.round(y / 2)) n += 2 * x * y
      return n
    }
    expect(targetsPixels('high', 3840, 2160)).toBe(3 * 3840 * 2160 + chain(3840, 2160))
    expect(targetsPixels('low', 1920, 1080)).toBe(3 * 1920 * 1080 + chain(960, 540))
    expect(targetsPixels('high', 3840, 2160) / (3840 * 2160)).toBeCloseTo(3.916, 2)
    expect(targetsPixels('high', 7, 5)).toBe(3 * 35 + 4 * 3 + 2 * (4 * 3 + 2 * 2 + 1 * 1 + 1 * 1 + 1 * 1)) // three rounds each half
    // Whatever the shape of the view, the targets together stay inside what the budget buffer needs. At 1000x2222 and
    // 2x the buffer's area fits High's budget, yet its bloom chain rounds a few pixels past: the ratio steps down.
    for (const tier of ['high', 'low', 'flat'] as const) {
      const [bw, bh] = tier === 'high' ? [3840, 2160] : [1920, 1080]
      for (const [w, h] of [[1000, 2222], [5120, 1440], [3000, 3000], [7680, 4320], [3841, 2161], [6000, 1000], [800, 600]]) {
        const [x, y] = buffer(tier, 2, w, h)
        expect(targetsPixels(tier, x, y)).toBeLessThanOrEqual(targetsPixels(tier, bw, bh))
      }
    }
    const tall = 2 * Math.sqrt((3840 * 2160) / (1000 * 2222 * 4))
    expect(tierPixelRatio('high', 2, 1000, 2222, NO_CAP, false)).toBeLessThan(tall)
    expect(tierPixelRatio('high', 2, 1000, 2222, NO_CAP, false)).toBeGreaterThan(tall * 0.99)
  })

  it('software lands on the 1920x1080 budget at every tier', () => {
    for (const tier of ['high', 'low', 'flat'] as const) {
      for (const [w, h] of [[3840, 2160], [5120, 2880], [2560, 1440]]) {
        const [x, y] = buffer(tier, 2, w, h, true)
        expect(x * y).toBeLessThanOrEqual(SOFTWARE_MAX_PIXELS)
        expect(targetsPixels(tier, x, y)).toBeLessThanOrEqual(targetsPixels(tier, 1920, 1080))
      }
    }
    expect(tierPixelRatio('high', 1, 5120, 2880, NO_CAP, true)).toBeCloseTo(0.375) // 1920 x 1080
    expect(tierPixelRatio('high', 1, 1920, 1080, NO_CAP, true)).toBe(1) // a 1080p view fits as it is
    expect(tierPixelRatio('low', 1, 1280, 720, NO_CAP, true)).toBe(0.75) // a small one keeps the tier's ratio
  })

  it('a drawing buffer smaller than the canvas is shrunk', () => {
    expect(shrunk({ drawingBufferWidth: 3840, drawingBufferHeight: 2160 }, { width: 3840, height: 2160 })).toBe(false)
    expect(shrunk({ drawingBufferWidth: 2715, drawingBufferHeight: 1527 }, { width: 3840, height: 2160 })).toBe(true)
    expect(shrunk({ drawingBufferWidth: 3840, drawingBufferHeight: 2159 }, { width: 3840, height: 2160 })).toBe(true)
    expect(shrunk({ drawingBufferWidth: 3839, drawingBufferHeight: 2160 }, { width: 3840, height: 2160 })).toBe(true)
  })
})
