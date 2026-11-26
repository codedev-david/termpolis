// The line close-up's search, kept (look plan Task 5, WP2 M-a). Framing a line searches many directions and distances
// for one that shows the whole arch and both of its ends (threeRenderer lineShot: up to about 400 looks of 40 probes
// each). A resize or a panel change used to run that search again on every ResizeObserver call, so dragging the pane
// divider with a line card open stuttered. The search's result that does not depend on the view's size (the direction
// it looks from, what it looks at, and the points it framed) is kept per line and layout; a new size only fits the
// distance again, over those points, without a search.
import { fitDistance, type V3 } from './viewMath'

/** What a line's search found that holds at any view size. */
export interface CachedLineShot {
  /** From the target toward the camera, unit length. */
  dir: V3
  /** What the camera looks at. */
  target: V3
  /** The points the close-up frames (the arch and the ends up to their names). */
  points: V3[]
  /**
   * How much further out the search put the camera than a plain fit of `points` at the size it searched at: it steps
   * back to clear the towers, and that step is kept at any size.
   */
  stretch: number
}

/** The cache's key: a line in one layout of the city. */
export function lineShotKey(lineId: string, layoutVersion: number): string {
  return lineId + '\0' + layoutVersion
}

export interface LineShotCache {
  get(key: string): CachedLineShot | undefined
  put(key: string, v: CachedLineShot): void
  clear(): void
}

export function createLineShotCache(): LineShotCache {
  const kept = new Map<string, CachedLineShot>()
  return {
    get: (key) => kept.get(key),
    put: (key, v) => { kept.set(key, v) },
    clear: () => { kept.clear() },
  }
}

/** How a re-aim fits: the margin around the points and the nearest and furthest the camera may stand. */
export interface ReaimFit { margin: number; minDist: number; maxDist: number }

/**
 * The kept close-up at a view of width-to-height `aspect` and vertical field `fov` (degrees; both those of the free area
 * the picture fills): the same direction and target, at the distance that fits the kept points, stretched as the
 * search stretched it, within the fit's limits. O(points): no search.
 */
export function reaim(cached: CachedLineShot, aspect: number, fov: number, fit: ReaimFit): { pos: V3; target: V3 } {
  const { dir, target } = cached
  const fitted = fitDistance(cached.points, target, dir, fov, aspect, fit.margin, fit.minDist)
  const dist = Math.min(fit.maxDist, Math.max(fit.minDist, fitted * cached.stretch))
  return { pos: [target[0] + dir[0] * dist, target[1] + dir[1] * dist, target[2] + dir[2] * dist], target: [...target] }
}
