// The pixel budget of each quality tier (look spec §5 and §5.3): how big a drawing buffer the 3D map may ask for, and
// how to tell that the browser gave it a smaller one than it asked for. Pure: no WebGL, no window.
import { bufferRatio, pixelBudgetRatio, SOFTWARE_MAX_PIXELS } from './viewMath'

/** The 3D map's quality tiers, best first. */
export type TierName = 'high' | 'low' | 'flat'

/** The largest drawing buffer each tier draws, [across, down]: a bigger view is drawn at a lower pixel ratio. */
const TIER_BUDGET: Record<TierName, readonly [number, number]> = { high: [3840, 2160], low: [1920, 1080], flat: [1920, 1080] }
/** Drawn in software, every tier draws at most a 1080p buffer (SOFTWARE_MAX_PIXELS). */
const SOFTWARE_BUDGET: readonly [number, number] = [1920, 1080]

/** The pixels of each tier's largest drawing buffer: 8.3 MP at High, 2.07 MP at Low and Flat. */
export const TIER_MAX_PIXELS: Record<TierName, number> = {
  high: TIER_BUDGET.high[0] * TIER_BUDGET.high[1],
  low: TIER_BUDGET.low[0] * TIER_BUDGET.low[1],
  flat: TIER_BUDGET.flat[0] * TIER_BUDGET.flat[1],
}

/** The screen's pixel ratio as each tier draws it: High at most 2, Low at most 1 and three quarters of it, Flat at most 1. */
function tierFactor(tier: TierName, dpr: number): number {
  if (tier === 'high') return Math.min(dpr, 2)
  return tier === 'low' ? Math.min(dpr, 1) * 0.75 : Math.min(dpr, 1)
}

/**
 * The pixels of UnrealBloomPass's targets for a `w` x `h` input, as three.js makes them: the bright pass at half size,
 * then five mips, each a horizontal and a vertical target, from half size down, each half the last (rounded).
 */
function bloomPixels(w: number, h: number): number {
  let x = Math.round(w / 2)
  let y = Math.round(h / 2)
  let n = x * y
  for (let i = 0; i < 5; i++) {
    n += 2 * x * y
    x = Math.round(x / 2)
    y = Math.round(y / 2)
  }
  return n
}

/**
 * Every render target a tier draws into for a `w` x `h` drawing buffer, in pixels: the canvas itself; at High and Low
 * also the composer's two full-size targets and the bloom chain (at full size at High, from half size at Low). Flat
 * draws straight to the canvas.
 */
export function targetsPixels(tier: TierName, w: number, h: number): number {
  if (tier === 'flat') return w * h
  return 3 * w * h + (tier === 'high' ? bloomPixels(w, h) : bloomPixels(Math.round(w / 2), Math.round(h / 2)))
}

/**
 * The pixel ratio a `width` x `height` view (CSS pixels) is drawn at in `tier`: the tier's share of the screen's ratio
 * `dpr`, lowered so every render target together stays inside what the tier's budget buffer would need (in software
 * the 1080p one, whatever the tier), then lowered to the GPU's largest buffer `cap` (bufferRatio).
 */
export function tierPixelRatio(tier: TierName, dpr: number, width: number, height: number, cap: readonly [number, number], software: boolean): number {
  const [bw, bh] = software ? SOFTWARE_BUDGET : TIER_BUDGET[tier]
  const most = targetsPixels(tier, bw, bh)
  let r = pixelBudgetRatio(tierFactor(tier, dpr), width, height, software ? SOFTWARE_MAX_PIXELS : TIER_MAX_PIXELS[tier])
  // The buffer's area is inside the budget now; the bloom chain's rounding can still take the targets a few pixels
  // past what the budget buffer needs, at another shape of view. A step or two down settles it.
  while (targetsPixels(tier, Math.floor(width * r), Math.floor(height * r)) > most) r *= 0.999
  return bufferRatio(r, width, height, cap)
}

/**
 * The browser gave the canvas a smaller drawing buffer than its size asks for: Chromium does so, without an error, when
 * it cannot allocate the buffer asked for. A frame then draws only part of the view, or nothing.
 */
export function shrunk(gl: { drawingBufferWidth: number; drawingBufferHeight: number }, canvas: { width: number; height: number }): boolean {
  return gl.drawingBufferWidth < canvas.width || gl.drawingBufferHeight < canvas.height
}

/** What each tier draws (look spec §5's table). */
export interface TierLook {
  /** The composer (bloom and grade): at High and Low; Flat draws straight to the canvas. */
  composer: boolean
  /** The bloom's input: the full buffer at High, half of it at Low. */
  bloom: 'full' | 'half' | null
  /** Film grain in the grade. */
  grain: boolean
  /** Light shafts under the disc. */
  shafts: number
  /** Dust points drifting through the city. */
  dust: number
  /** The table's disc moves (its rings turn); at Flat it is drawn still. */
  discMoving: boolean
  /** Whether the lines' beams and the track are drawn. */
  beams: boolean
  /** Whether the scan lines move; at Flat they are drawn still. */
  scanLinesMoving: boolean
}

/**
 * Look spec §5: High draws all of it, Low the bloom at half size, no grain, one shaft and a third of the dust, Flat no
 * composer, a still disc and no shafts, dust or beams. (The renderer draws the composer, the bloom's size and the dust
 * from it now; the disc, shafts, grain, beams and scan lines come with the Holotable look's later tasks.)
 */
export const TIER_LOOK: Record<TierName, TierLook> = {
  high: { composer: true, bloom: 'full', grain: true, shafts: 2, dust: 1800, discMoving: true, beams: true, scanLinesMoving: true },
  low: { composer: true, bloom: 'half', grain: false, shafts: 1, dust: 600, discMoving: true, beams: true, scanLinesMoving: true },
  flat: { composer: false, bloom: null, grain: false, shafts: 0, dust: 0, discMoving: false, beams: false, scanLinesMoving: false },
}
