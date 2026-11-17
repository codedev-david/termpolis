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

/** A label on screen: its centre and size in pixels. */
export interface LabelBox { id: string; x: number; y: number; w: number; h: number }

/** The size on screen of a line label of `chars` characters (11px type, 7px padding each side, border). */
export function edgeLabelSize(chars: number): { w: number; h: number } {
  return { w: Math.ceil(chars * 6.2) + 16, h: 18 }
}

/** Whether two labels keep `gap` pixels clear of each other, across or up and down. */
function clearOf(a: LabelBox, b: LabelBox, gap: number): boolean {
  return Math.abs(a.x - b.x) * 2 >= a.w + b.w + gap * 2 || Math.abs(a.y - b.y) * 2 >= a.h + b.h + gap * 2
}

/**
 * A label that wants a place on screen: lower tiers are more wanted; a group can be capped. One that
 * may `nudge` can move off its point (NUDGES) when that point is taken.
 */
export interface LabelCandidate extends LabelBox { tier: number; group?: string; nudge?: boolean }

/** Room a label needs round it to appear, and the room it needs to stay once shown (LABEL_KEEP_GAP). */
export const LABEL_GAP = 6
export const LABEL_KEEP_GAP = 1

/** How far a label moves off its point, in pixels across and down. */
export type Nudge = readonly [number, number]

/**
 * Where a label that may nudge tries to go, in order, as steps of its own height (plus the gap) up
 * and down and of its own width (plus the gap) across: its point first, then just above or below,
 * then two rows off, then beside it.
 */
export const NUDGES: ReadonlyArray<readonly [number, number]> = [[0, 0], [0, -1], [0, 1], [0, -2], [0, 2], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]

/**
 * Which labels to show so that no two overlap, and where: the lowest tier first (the order given
 * within a tier), each one that keeps clear of every label already kept, up to its group's cap in
 * `caps`. A label that may nudge takes the first of its NUDGES places that is clear. A label in
 * `shown` (on screen last time, with its nudge) needs only `keepGap` pixels round it to stay where
 * it was, a new one `gap` to appear: a label at the edge of its room stays put while the camera
 * moves, instead of flickering in and out or hopping. Returns each shown label's nudge, in the
 * order they were placed.
 */
export function placeLabels(
  cands: LabelCandidate[], shown: ReadonlyMap<string, Nudge>, caps: Readonly<Record<string, number>> = {}, gap = LABEL_GAP, keepGap = LABEL_KEEP_GAP,
): Map<string, Nudge> {
  const order = cands.map((c, i) => ({ c, i })).sort((a, b) => a.c.tier - b.c.tier || a.i - b.i)
  const kept: LabelBox[] = []
  const out = new Map<string, Nudge>()
  const used = new Map<string, number>()
  const clear = (box: LabelBox, g: number): boolean => kept.every((k) => clearOf(k, box, g))
  for (const { c } of order) {
    const n = c.group === undefined ? 0 : used.get(c.group) ?? 0
    if (c.group !== undefined && n >= (caps[c.group] ?? Infinity)) continue
    const tries: Array<{ d: Nudge; g: number }> = []
    const was = shown.get(c.id)
    if (was) tries.push({ d: was, g: keepGap })
    for (const [ux, uy] of c.nudge ? NUDGES : NUDGES.slice(0, 1)) tries.push({ d: [ux * (c.w + gap), uy * (c.h + gap)], g: gap })
    const fit = tries.find(({ d, g }) => clear({ ...c, x: c.x + d[0], y: c.y + d[1] }, g))
    if (!fit) continue
    kept.push({ ...c, x: c.x + fit.d[0], y: c.y + fit.d[1] })
    out.set(c.id, fit.d)
    if (c.group !== undefined) used.set(c.group, n + 1)
  }
  return out
}

/** From this zoom in (camera distance over the overview's), every building's name may show. */
export const ZOOM_ALL_NAMES = 0.3

/**
 * Semantic zoom: how many building names, the most important first, may show among `n` at `zoom`
 * (the camera's distance over the overview's). At the overview and further out, a few: the square
 * root of the count, 3 to 10 (never more than there are); all of them from ZOOM_ALL_NAMES in; in
 * between, a smooth ramp.
 */
export function nameBudget(n: number, zoom: number): number {
  const few = Math.min(n, clamp(Math.round(Math.sqrt(n)), 3, 10))
  const s = clamp((1 - zoom) / (1 - ZOOM_ALL_NAMES), 0, 1)
  return Math.round(few + (n - few) * s * s * (3 - 2 * s))
}

/**
 * The strip on the right of the view a panel covers (the legend), kept out of the overview's fit:
 * `reserve` pixels, or none when the view is too narrow to give that much up (under three times it).
 */
export function rightInset(width: number, reserve: number): number {
  return reserve > 0 && width >= reserve * 3 ? reserve : 0
}

/** Pixels a district name's glow (text-shadow 12px) reaches past its box. */
export const LABEL_GLOW_PX = 6

/**
 * Half the width the overview's fit must keep clear on each side of a district's name: its measured
 * width (offsetWidth) halved, plus the glow; `fallback` (a half width) when it has not been measured (0).
 */
export function districtNameHalf(measuredWidth: number, fallback: number): number {
  return measuredWidth > 0 ? measuredWidth / 2 + LABEL_GLOW_PX : fallback
}

/**
 * The shift, in pixels, that puts a label box (centre x, y; size w, h) inside a w0 by h0 view with
 * `inset` pixels to spare. A box wider or taller than the view is centred on it.
 */
export function clampIntoView(x: number, y: number, w: number, h: number, w0: number, h0: number, inset: number): [number, number] {
  const axis = (c: number, size: number, total: number): number => {
    const lo = inset + size / 2
    const hi = total - inset - size / 2
    if (lo > hi) return total / 2 - c
    return c < lo ? lo - c : c > hi ? hi - c : 0
  }
  return [axis(x, w, w0), axis(y, h, h0)]
}
