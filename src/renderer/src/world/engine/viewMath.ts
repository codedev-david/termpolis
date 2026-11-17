// The camera arithmetic of the world view, kept free of three.js so it can be unit-tested: the fog
// density, and the distances that fit a set of points into the picture.

export type V3 = [number, number, number]

/**
 * The fog at the overview target: density x distance stays at or below this, so certain structure
 * at the overview is at most about a quarter fogged (1 - exp(-0.55^2) = 0.26). The theme's own
 * density still applies to a small world, where it is the lower of the two. Fog is a depth cue and
 * the look of uncertain parts (fog clouds, dashed lines), never a curtain over certain structure.
 */
export const FOG_REACH = 0.55
/** How much thicker the fog grows while a building is open, so the rest of the city recedes. */
export const OPEN_FOG = 2.2
/** The aspect assumed while the view has no size yet (a hidden pane). */
const FALLBACK_ASPECT = 1.6

/** The fog density: the theme's, thinned for a big world, thicker while a building is open. */
export function fogDensity(themeDensity: number, overviewDist: number, open: boolean): number {
  return Math.min(themeDensity, FOG_REACH / overviewDist) * (open ? OPEN_FOG : 1)
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2])
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]
}

/** A camera looking down `dir` reversed (dir points from the target to the camera): its right and up. */
function basis(dir: V3): { r: V3; u: V3; d: V3 } {
  const d = norm(dir)
  const f: V3 = [-d[0], -d[1], -d[2]]
  const r = norm(cross(f, Math.abs(d[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0]))
  return { r, u: cross(r, f), d }
}

/** The half-angle tangents of the picture, shrunk by the margin so the fit leaves that much room. */
function halfTangents(fovDeg: number, aspect: number, margin: number): { tanH: number; tanV: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : FALLBACK_ASPECT
  const tanV = Math.tan((fovDeg * Math.PI) / 360) / margin
  return { tanH: tanV * a, tanV }
}

/**
 * The least distance from `target` along `dir` at which a camera looking at `target` with this
 * vertical field of view and aspect sees every point, with `margin` (1.1 = a tenth to spare) round
 * the picture. Never closer than `minDist`.
 */
export function fitDistance(points: V3[], target: V3, dir: V3, fovDeg: number, aspect: number, margin: number, minDist = 1): number {
  const { r, u, d } = basis(dir)
  const { tanH, tanV } = halfTangents(fovDeg, aspect, margin)
  let dist = minDist
  for (const p of points) {
    const rel = sub(p, target)
    const toward = dot(rel, d) // how far the point stands out toward the camera
    dist = Math.max(dist, Math.abs(dot(rel, r)) / tanH + toward, Math.abs(dot(rel, u)) / tanV + toward)
  }
  return dist
}

/**
 * The overview: where to look and from how far so the whole city fills the picture, with `margin`
 * to spare. The target starts at the centre of the points' bounding box and is then nudged so the
 * city sits in the middle of the picture (the box centre seen at an angle is not the picture's).
 */
export function fitView(points: V3[], dir: V3, fovDeg: number, aspect: number, margin: number, minDist = 1): { target: V3; dist: number } {
  if (points.length === 0) return { target: [0, 0, 0], dist: minDist }
  const lo: V3 = [Infinity, Infinity, Infinity]
  const hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (const p of points) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]) }
  let target: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  const { r, u, d } = basis(dir)
  const { tanH, tanV } = halfTangents(fovDeg, aspect, 1)
  let dist = fitDistance(points, target, dir, fovDeg, aspect, margin, minDist)
  for (let pass = 0; pass < 3; pass++) {
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const p of points) {
      const rel = sub(p, target)
      const depth = Math.max(1e-6, dist - dot(rel, d))
      const x = dot(rel, r) / (depth * tanH)
      const y = dot(rel, u) / (depth * tanV)
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
    const sx = ((x0 + x1) / 2) * dist * tanH
    const sy = ((y0 + y1) / 2) * dist * tanV
    target = [target[0] + r[0] * sx + u[0] * sy, target[1] + r[1] * sx + u[1] * sy, target[2] + r[2] * sx + u[2] * sy]
    dist = fitDistance(points, target, dir, fovDeg, aspect, margin, minDist)
  }
  return { target, dist }
}

/** A number held between two bounds; the lower bound wins when they cross. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** A city with more lines than this is busy: each line draws fainter and the glow is turned down. */
export const BUSY_LINES = 40

/**
 * How much a busy city thins its lines and glow: 1 up to BUSY_LINES lines, then falling with the
 * square root of the count. Hundreds of lines meeting in one bundle otherwise add up to an opaque
 * pink band that the bloom turns into glare.
 */
export function busyness(lines: number): number {
  return Math.sqrt(BUSY_LINES / Math.max(BUSY_LINES, lines))
}
