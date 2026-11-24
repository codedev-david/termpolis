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

/**
 * The pixel ratio a view `width` x `height` (CSS pixels) is drawn at: `want`, lowered so the drawing buffer fits the
 * GPU's largest buffer `cap` ([across, down]: the smaller of its biggest render buffer and its biggest viewport), as
 * on a 4K or bigger display, where a buffer past it draws nothing. A missing or unusable limit holds nothing back.
 */
export function bufferRatio(want: number, width: number, height: number, cap: readonly [number, number]): number {
  let r = want
  if (cap[0] > 0 && width * r > cap[0]) r = cap[0] / width
  if (cap[1] > 0 && height * r > cap[1]) r = cap[1] / height
  return r
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

/**
 * A label on screen: its centre and size in pixels. With `rowGap`, the extra room across it needs
 * from a label on the same row (a district's name, so it never reads on into its neighbour's words).
 */
export interface LabelBox { id: string; x: number; y: number; w: number; h: number; rowGap?: number }

/**
 * The size on screen of a line label of `chars` characters (12px type, 7px padding each side,
 * border), drawn `scale` times its base size (the labels' scale on a big screen).
 */
export function edgeLabelSize(chars: number, scale = 1): { w: number; h: number } {
  return { w: Math.ceil((chars * 6.8 + 16) * scale), h: Math.ceil(19 * scale) }
}

/**
 * Whether two labels keep `gap` pixels clear of each other, across or up and down. Across, a label
 * with a `rowGap` needs that much more: two labels on one row read on into each other otherwise.
 */
function clearOf(a: LabelBox, b: LabelBox, gap: number): boolean {
  const across = gap + Math.max(a.rowGap ?? 0, b.rowGap ?? 0)
  return Math.abs(a.x - b.x) * 2 >= a.w + b.w + across * 2 || Math.abs(a.y - b.y) * 2 >= a.h + b.h + gap * 2
}

/** A box on screen as left, top, right, bottom, in pixels. */
export type Rect = readonly [number, number, number, number]

/**
 * Where labels may go: inside `bounds` (the view), whole, and clear of every box in `blocked` (the
 * panels drawn over the view, the legend, the ask bar, the card): no label is ever drawn cut off at
 * the view's edge or under a panel. `solid` are the buildings' boxes on screen: a label marked
 * `solidFree` (a district's name) takes a place off them where it has one, and its own point else.
 */
export interface LabelRoom { bounds?: Rect; blocked?: readonly Rect[]; solid?: readonly Rect[] }

/** Whether a label lies off every box in `rects`. */
function offAll(rects: readonly Rect[], c: LabelBox): boolean {
  const l = c.x - c.w / 2
  const t = c.y - c.h / 2
  const r = c.x + c.w / 2
  const b = c.y + c.h / 2
  return rects.every(([pl, pt, pr, pb]) => r <= pl || l >= pr || b <= pt || t >= pb)
}

/** Whether a label sits whole inside the room's bounds and off every blocked box. */
function roomFor(room: LabelRoom, c: LabelBox): boolean {
  const l = c.x - c.w / 2
  const t = c.y - c.h / 2
  const r = c.x + c.w / 2
  const b = c.y + c.h / 2
  const [bl, bt, br, bb] = room.bounds ?? [-Infinity, -Infinity, Infinity, Infinity]
  if (l < bl || t < bt || r > br || b > bb) return false
  return offAll(room.blocked ?? [], c)
}

/**
 * A label that wants a place on screen: lower tiers are more wanted; a group can be capped. One that
 * may `nudge` can move off its point when that point is taken: to any of NUDGES (true), or only a row
 * or two up or down (VERTICAL_NUDGES, 'vertical'). With `keepIn` (left, top, right, bottom, in pixels)
 * a move off its point must keep the whole box inside that rectangle; its own point is always allowed.
 * One marked `always` is never dropped for want of room: when none of its places is clear it is shown
 * anyway, where it was last time or else on its own point ("label every line").
 */
export interface LabelCandidate extends LabelBox {
  tier: number; group?: string; nudge?: boolean | 'vertical'; keepIn?: readonly [number, number, number, number]; always?: boolean
  /** A smaller form on the same point (a district's name without its subtitle), tried where the whole label finds no room. */
  compact?: { w: number; h: number }
  /**
   * Takes the first of its places off the room's `solid` boxes (the buildings) where one is clear, a step to either
   * side included when it otherwise moves only up or down; else places as any label, compact, and goes in `solid`.
   */
  solidFree?: boolean
}

/**
 * The labels shown in their compact form: last time's (`was`), and this time's, which placeLabels fills (`now`); and,
 * where given, the solid-free labels it had to leave on a building (`solid`), which placeLabels also fills.
 */
export interface CompactForms { was: ReadonlySet<string>; now: Set<string>; solid?: Set<string> }

/** Room a label needs round it to appear, and the room it needs to stay once shown (LABEL_KEEP_GAP). */
export const LABEL_GAP = 6
export const LABEL_KEEP_GAP = 1

/**
 * The faintest a map label is drawn: fainter text reads as a smudge, not a word. A label that would fade below
 * LABEL_HIDE_BELOW (a name dimmed by the focus, a district name far out) is not drawn at all; one between the two
 * is drawn at LABEL_MIN_OPACITY.
 */
export const LABEL_MIN_OPACITY = 0.6
export const LABEL_HIDE_BELOW = 0.3

/** How strongly a label of opacity `o` is drawn: at least LABEL_MIN_OPACITY, or null (not drawn) below LABEL_HIDE_BELOW. */
export function readableOpacity(o: number): number | null {
  return o < LABEL_HIDE_BELOW ? null : Math.max(LABEL_MIN_OPACITY, o)
}

/** How far a label moves off its point, in pixels across and down. */
export type Nudge = readonly [number, number]

/**
 * Where a label that may nudge tries to go, in order, as steps of its own height (plus the gap) up
 * and down and of its own width (plus the gap) across: its point first, then just above or below,
 * then two rows off, then beside it.
 */
export const NUDGES: ReadonlyArray<readonly [number, number]> = [[0, 0], [0, -1], [0, 1], [0, -2], [0, 2], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]
/** The NUDGES that stay over or under the label's point: its point, then a row up or down, then two. */
export const VERTICAL_NUDGES: ReadonlyArray<readonly [number, number]> = NUDGES.filter(([ux]) => ux === 0)
/** The NUDGES straight to either side, which a name kept off the buildings also tries before it settles on one. */
const SIDE_STEPS: ReadonlyArray<readonly [number, number]> = NUDGES.filter(([ux, uy]) => ux !== 0 && uy === 0)

/**
 * Which labels to show so that no two overlap, and where: the lowest tier first (the order given
 * within a tier), each one that keeps clear of every label already kept, up to its group's cap in
 * `caps`. A label that may nudge takes the first of its NUDGES places that is clear. A label in
 * `shown` (on screen last time, with its nudge) needs only `keepGap` pixels round it to stay where
 * it was, a new one `gap` to appear: a label at the edge of its room stays put while the camera
 * moves, instead of flickering in and out or hopping. A label marked `always` that finds no clear
 * place still shows, as a last resort, overlapping. A label with a `compact` form (a district's
 * name without its subtitle) is placed in that form, so every name of its tier gets its room before
 * any subtitle; then, before the next tier is placed, each grows whole, in the same order, where the
 * whole label is clear of every label kept (by the keeping gap if it showed whole last time). One
 * that cannot stays compact (its id goes in `compact.now`), as does a `solidFree` one with no place off the buildings,
 * which also goes in `compact.solid`. Every place, a label's own point and an
 * `always` label's last resort included, must leave it whole in the `room` (LabelRoom). Returns each
 * shown label's nudge, in the order they were placed.
 */
export function placeLabels(
  cands: LabelCandidate[], shown: ReadonlyMap<string, Nudge>, caps: Readonly<Record<string, number>> = {}, gap = LABEL_GAP, keepGap = LABEL_KEEP_GAP,
  compact: CompactForms = { was: new Set(), now: new Set() }, room: LabelRoom = {},
): Map<string, Nudge> {
  const order = cands.map((c, i) => ({ c, i })).sort((a, b) => a.c.tier - b.c.tier || a.i - b.i)
  // `off`: placed off the buildings (solidFree), so it grows whole only where the whole label is off them too.
  const kept: Array<LabelBox & { c: LabelCandidate; off?: boolean }> = []
  const out = new Map<string, Nudge>()
  const used = new Map<string, number>()
  const clear = (box: LabelBox, g: number): boolean => roomFor(room, box) && kept.every((k) => clearOf(k, box, g))
  // Each label with a compact form placed since `grown` grows whole where it is clear of every label kept.
  let grown = 0
  const grow = (): void => {
    for (; grown < kept.length; grown++) {
      const i = grown
      const { c } = kept[i]
      if (!c.compact) continue
      const at = out.get(c.id) as Nudge
      const whole = { ...c, x: c.x + at[0], y: c.y + at[1] }
      const g = shown.has(c.id) && !compact.was.has(c.id) ? keepGap : gap
      // A name kept off the buildings grows only where the whole label is off them too: one left on a building stays
      // compact, since its thinner second line is what turns to a jumble over the glyphs.
      if (within(c, at) && roomFor(room, whole) && (!c.solidFree || (kept[i].off === true && offAll(room.solid ?? [], whole))) && kept.every((o, j) => j === i || clearOf(o, whole, g))) kept[i] = { ...kept[i], ...whole }
      else compact.now.add(c.id)
    }
  }
  let tier = order.length > 0 ? order[0].c.tier : 0
  for (const { c } of order) {
    // A tier's names have their room: its subtitles grow before the next tier's labels are placed.
    if (c.tier !== tier) { grow(); tier = c.tier }
    const n = c.group === undefined ? 0 : used.get(c.group) ?? 0
    if (c.group !== undefined && n >= (caps[c.group] ?? Infinity)) continue
    const box: LabelCandidate = c.compact ? { ...c, ...c.compact } : c
    const tries: Array<{ d: Nudge; g: number }> = []
    const was = shown.get(c.id)
    if (was) tries.push({ d: was, g: keepGap })
    const steps = c.nudge === 'vertical' ? VERTICAL_NUDGES : c.nudge ? NUDGES : NUDGES.slice(0, 1)
    for (const [ux, uy] of steps) tries.push({ d: [ux * (box.w + gap), uy * (box.h + gap)], g: gap })
    const fits = ({ d, g }: { d: Nudge; g: number }): boolean => within(box, d) && clear({ ...box, x: box.x + d[0], y: box.y + d[1] }, g)
    // A name kept off the buildings: the first clear place off them all, before any place on one, a step to either
    // side included.
    const offTries = c.nudge === 'vertical' ? tries.concat(SIDE_STEPS.map(([ux]) => ({ d: [ux * (box.w + gap), 0] as Nudge, g: gap }))) : tries
    // Only the buildings within reach of one of those places: a big world has thousands, each place looks at a few.
    const near = c.solidFree ? solidsNear(room.solid ?? [], box, offTries.map((t) => t.d)) : []
    const off = c.solidFree ? offTries.find((t) => fits(t) && offAll(near, { ...box, x: box.x + t.d[0], y: box.y + t.d[1] }))?.d : undefined
    const fit = off ?? tries.find(fits)?.d
    // Every place is taken: a label that must show keeps last time's place, or else its own point.
    // Never under a panel or cut off at the view's edge, though.
    const last: Nudge = was ?? [0, 0]
    const at: Nudge | undefined = fit ?? (c.always && roomFor(room, { ...box, x: box.x + last[0], y: box.y + last[1] }) ? last : undefined)
    if (!at) continue
    kept.push({ ...box, x: box.x + at[0], y: box.y + at[1], c, ...(off ? { off: true } : {}) })
    if (c.solidFree && !off && compact.solid) compact.solid.add(c.id)
    out.set(c.id, at)
    if (c.group !== undefined) used.set(c.group, n + 1)
  }
  grow()
  return out
}

/** The boxes in `solid` that meet `box` moved by any of `moves`: those a place of the label could lie on. */
function solidsNear(solid: readonly Rect[], box: LabelBox, moves: readonly Nudge[]): Rect[] {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
  for (const [dx, dy] of moves) {
    l = Math.min(l, box.x + dx - box.w / 2); r = Math.max(r, box.x + dx + box.w / 2)
    t = Math.min(t, box.y + dy - box.h / 2); b = Math.max(b, box.y + dy + box.h / 2)
  }
  return solid.filter(([sl, st, sr, sb]) => sr > l && sl < r && sb > t && st < b)
}

/** Whether a label moved by `d` stays inside its `keepIn` rectangle; unmoved, or with none, it always does. */
function within(c: LabelCandidate, d: Nudge): boolean {
  if (!c.keepIn || (d[0] === 0 && d[1] === 0)) return true
  const [l, t, r, b] = c.keepIn
  const x = c.x + d[0]
  const y = c.y + d[1]
  return x - c.w / 2 >= l && x + c.w / 2 <= r && y - c.h / 2 >= t && y + c.h / 2 <= b
}

/** From this zoom in (camera distance over the overview's), every building's name may show. */
export const ZOOM_ALL_NAMES = 0.3

/** Closeness (0 far, 1 near) under which only districts read: buildings draw as plain blocks, only district names show. */
export const ZOOM_FAR = 0.25
/** Closeness from which a building's floors, floor labels and seams draw. */
export const ZOOM_NEAR = 0.7
export type ZoomTier = 'districts' | 'buildings' | 'floors'

/** Semantic zoom tier for a closeness `zoom` (0 at the overview and beyond, toward 1 as the camera nears). */
export function zoomTier(zoom: number): ZoomTier {
  return zoom < ZOOM_FAR ? 'districts' : zoom < ZOOM_NEAR ? 'buildings' : 'floors'
}

/**
 * The tier for the camera's distance over the overview's (the scale nameBudget reads: 1 at the
 * overview, smaller as the camera nears), turned into closeness: 1 - ratio.
 */
export function zoomTierAt(ratio: number): ZoomTier {
  return zoomTier(1 - ratio)
}

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
 * `reserve` pixels, or none when the view is too narrow to give that much up (under `from`, which is
 * three times the strip unless the panel's owner says from what width it keeps the strip clear).
 */
export function rightInset(width: number, reserve: number, from = reserve * 3): number {
  return reserve > 0 && width >= from ? reserve : 0
}

/**
 * The strip at the bottom of the view the ask bar covers, kept out of the overview's fit: `reserve`
 * pixels, or none when that would leave the city less than half the view's height.
 */
export function bottomInset(height: number, reserve: number): number {
  return reserve > 0 && height >= reserve * 2 ? reserve : 0
}

/**
 * The vertical field of view (degrees) that shows `extra` more pixels of height than a `fovDeg`
 * camera does over `height` pixels, at the same scale: the picture is (height + extra) / height as
 * tall. A negative `extra` gives the field of the smaller part (height + extra pixels) of the view.
 */
export function stretchFov(fovDeg: number, height: number, extra: number): number {
  if (!(height > 0) || extra === 0) return fovDeg
  const t = Math.tan((fovDeg * Math.PI) / 360) * Math.max(0, height + extra) / height
  return (Math.atan(t) * 360) / Math.PI
}

/** The least room, each way, the free part of the view keeps: a card that would leave less is not reserved. */
export const MIN_FREE_PX = 120

/** The view's edges a panel covers, in pixels from each side: what the fits leave out. */
export interface FreeArea { left: number; top: number; right: number; bottom: number }

/**
 * The part of the view the panels leave free, which every fit fills (the overview, a building's
 * focus, a line's close-up, a tour step): the legend's strip on the right (`legend`, rightInset, from
 * `legendFrom` wide when given),
 * the ask bar's at the bottom (`ask`, bottomInset), and the open card's box in the top left corner
 * (`card`, its width and height from the corner, gaps included). The card is kept out as a strip
 * along the top or along the left, whichever leaves the larger free area: in a narrow pane, where
 * the card spans nearly the width, the top. A card that would leave less than MIN_FREE_PX either
 * way on both sides is not reserved (the fit keeps the rest of the view), except beside a legend strip kept
 * only because `legendFrom` is narrower than the default: then the strip is dropped if that lets the card be
 * reserved, since the card is what was just opened.
 */
export function freeArea(width: number, height: number, legend: number, ask: number, card: readonly [number, number] | null, legendFrom?: number): FreeArea {
  const out: FreeArea = { left: 0, top: 0, right: rightInset(width, legend, legendFrom), bottom: bottomInset(height, ask) }
  if (!card || !(card[0] > 0) || !(card[1] > 0)) return out
  const [cw, ch] = card
  const fw = width - out.right
  const fh = height - out.bottom
  const below = fw >= MIN_FREE_PX && fh - ch >= MIN_FREE_PX ? fw * (fh - ch) : -1
  const beside = fw - cw >= MIN_FREE_PX && fh >= MIN_FREE_PX ? (fw - cw) * fh : -1
  if (below < 0 && beside < 0) {
    if (out.right > 0 && rightInset(width, legend) === 0) {
      const bare = freeArea(width, height, 0, ask, card)
      if (bare.left > 0 || bare.top > 0) return bare
    }
    return out
  }
  return below >= beside ? { ...out, top: ch } : { ...out, left: cw }
}

/**
 * Whether the view point at (ndcX, ndcY), -1..1 each way across a `width` by `height` view (y up),
 * lies in the part the panels leave free (`f`), at least `inset` pixels inside its edges. A point
 * whose depth (`ndcZ`) is past -1..1 lies behind the camera, nearer than its near plane or past its
 * far one, and shows nowhere.
 */
export function inFreeArea(ndcX: number, ndcY: number, width: number, height: number, f: FreeArea, inset = 0, ndcZ = 0): boolean {
  if (Math.abs(ndcZ) > 1) return false
  const x = ((ndcX + 1) / 2) * width
  const y = ((1 - ndcY) / 2) * height
  return x >= f.left + inset && x <= width - f.right - inset && y >= f.top + inset && y <= height - f.bottom - inset
}

/**
 * The distances a framing backs off through, from `from` out to `to`: each `step` times the one
 * before, and `to` itself last. Only `from` when it is already as far as `to` (or `step` does not grow).
 */
export function backOffs(from: number, to: number, step: number): number[] {
  const out = [from]
  if (!(to > from) || !(step > 1)) return out
  for (let d = from * step; d < to; d *= step) out.push(d)
  out.push(to)
  return out
}

/** The ground direction `h` (its x and z) turned about the vertical by each of `degrees`. */
export function turnAcross(h: readonly [number, number], degrees: readonly number[]): Array<[number, number]> {
  return degrees.map((deg) => {
    const a = (deg * Math.PI) / 180
    const c = Math.cos(a)
    const s = Math.sin(a)
    return [h[0] * c + h[1] * s, -h[0] * s + h[1] * c]
  })
}

/**
 * The longest frame step the city's loop takes, in seconds. Only a spike is cut (a tab switched away
 * and back, a stall): a slow frame rate keeps its real step, so every ease and drift keeps wall time
 * however few frames a weak GPU draws at 4K.
 */
export const MAX_FRAME_DT = 0.25

/** A frame's step in seconds, from the clock's delta: never negative, cut only at MAX_FRAME_DT. */
export function frameStep(delta: number): number {
  return Math.min(Math.max(0, delta), MAX_FRAME_DT)
}

/** The share of the way an ease at `rate` covers in `dt` seconds: the same state at the same wall time at any frame rate. */
export function easeShare(rate: number, dt: number): number {
  return dt > 0 ? 1 - Math.exp(-rate * dt) : 0
}

/** A rate whose 60 fps frame moves `perFrame` of the way: the feel the old `min(1, dt * k)` step had at 60 fps. */
const at60 = (perFrame: number): number => -60 * Math.log(1 - perFrame)
/** An opening building's floors rising (5/60 of the way a frame at 60 fps), turning (4/60), and the fog's drift (2/60). */
export const FLOOR_RISE_RATE = at60(5 / 60)
export const FLOOR_TURN_RATE = at60(4 / 60)
export const FOG_RATE = at60(2 / 60)

/** Whether two free areas are the same to within half a pixel on every side. */
export function sameArea(a: FreeArea, b: FreeArea): boolean {
  return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.right - b.right) < 0.5 && Math.abs(a.bottom - b.bottom) < 0.5
}

/**
 * One frame (`dt` seconds) of the free area easing from `a` toward `goal`, so the picture glides
 * when a panel opens, closes or changes size: most of the way in a quarter of a second, and
 * exactly there once every side is within half a pixel.
 */
export function easeArea(a: FreeArea, goal: FreeArea, dt: number): FreeArea {
  const k = 1 - Math.exp(-Math.max(0, dt) * 12)
  const next: FreeArea = {
    left: a.left + (goal.left - a.left) * k,
    top: a.top + (goal.top - a.top) * k,
    right: a.right + (goal.right - a.right) * k,
    bottom: a.bottom + (goal.bottom - a.bottom) * k,
  }
  return sameArea(next, goal) ? { ...goal } : next
}

/** How the camera's picture is set so the free part of the view is what it centres on and fits. */
export interface ViewFrame {
  /** The full picture (setViewOffset): the view lies at (offX, offY) inside it. */
  fullW: number
  fullH: number
  offX: number
  offY: number
  /** The camera's vertical field (over fullH) and aspect. */
  fov: number
  aspect: number
  /** The field and aspect of the free part, at the camera's scale: what a fit fills. */
  fitFov: number
  fitAspect: number
}

/**
 * The camera's picture for a view with panels over it: centred on the middle of the free part, as
 * large as it takes to cover the whole view from there (the parts past the view's edges are cut
 * off), at the pixel scale of a `fovDeg` camera over the view. With nothing reserved it is the view.
 */
export function viewFrame(width: number, height: number, fovDeg: number, f: FreeArea): ViewFrame {
  const fw = Math.max(1, width - f.left - f.right)
  const fh = Math.max(1, height - f.top - f.bottom)
  const cx = f.left + fw / 2
  const cy = f.top + fh / 2
  const fullW = 2 * Math.max(cx, width - cx)
  const fullH = 2 * Math.max(cy, height - cy)
  return {
    fullW, fullH, offX: fullW / 2 - cx, offY: fullH / 2 - cy,
    fov: stretchFov(fovDeg, height, fullH - height), aspect: fullW / fullH,
    fitFov: stretchFov(fovDeg, height, fh - height), fitAspect: fw / fh,
  }
}

const unit = (a: V3): V3 => {
  const k = 1 / Math.hypot(a[0], a[1], a[2])
  return [a[0] * k, a[1] * k, a[2] * k]
}

/**
 * The overview's direction (from the city toward the camera) in a landscape view: from ahead of the
 * city and a little to its right, about 35 degrees up.
 */
export const OVERVIEW_DIR: V3 = unit([0.24, 0.72, 1])
/**
 * The overview's direction in a portrait view: the same bearing, about 57 degrees up, so the city's
 * depth spreads over the picture's height instead of lying in a flat band across it.
 */
export const PORTRAIT_DIR: V3 = unit([0.24, 1.6, 1])
/** A portrait overview turns the city a quarter only when its ground is this much wider across than deep. */
export const TURN_RATIO = 1.05
/** A portrait overview stays portrait up to this aspect, so a small resize near square does not flip it. */
export const PORTRAIT_HOLD = 1.1

/** The overview's direction, whether the view counts as portrait, and whether the city is turned a quarter. */
export interface OverviewDir { dir: V3; portrait: boolean; turned: boolean }

/**
 * The direction the overview looks from, for a fit area of this width-to-height and a city covering
 * the `ground` points (x, z). A landscape area (aspect 1 or more) gets OVERVIEW_DIR, untouched. A
 * portrait one (under 1; under PORTRAIT_HOLD once `wasPortrait`) looks down more steeply
 * (PORTRAIT_DIR), and turns a quarter (the camera moves 90 degrees round the city, toward +x) when the
 * city's ground is wider across the picture than deep into it by more than TURN_RATIO, so its longest
 * side runs up the screen. The turn depends only on the ground, never on the camera, so it holds
 * from frame to frame and through any resize that keeps the view portrait.
 */
export function overviewDir(aspect: number, ground: ReadonlyArray<readonly [number, number]>, wasPortrait = false): OverviewDir {
  const portrait = Number.isFinite(aspect) && aspect > 0 && aspect < (wasPortrait ? PORTRAIT_HOLD : 1)
  if (!portrait) return { dir: OVERVIEW_DIR, portrait: false, turned: false }
  const d = PORTRAIT_DIR
  const flat = Math.hypot(d[0], d[2])
  const extent = (ax: number, az: number): number => {
    let lo = Infinity
    let hi = -Infinity
    for (const [x, z] of ground) {
      const v = (x * ax + z * az) / flat
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
    return ground.length > 0 ? hi - lo : 0
  }
  // On the ground, `deep` runs from the camera's side of the city to the far side (up the picture),
  // `across` from left to right.
  const turned = extent(d[2], -d[0]) > extent(d[0], d[2]) * TURN_RATIO
  return { dir: turned ? [d[2], d[1], -d[0]] : d, portrait: true, turned }
}

/** A ground offset (x, z) turned the same quarter as a turned overview (overviewDir). */
export function turnGround(x: number, z: number, turned: boolean): [number, number] {
  return turned ? [z, -x] : [x, z]
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

/** How near (client pixels) a click or hover that hits nothing may land to a building or orb and still pick it. */
export const PICK_TOLERANCE_PX = 6

/** A building's or orb's footprint on screen: its projected bounding box, in client pixels. */
export interface ScreenBox { id: string; l: number; t: number; r: number; b: number }

/**
 * The building or orb a pointer at (x, y) that hit nothing is meant for: the one whose box among the
 * first `count` of `boxes` lies nearest, within `tol` pixels (0 inside it); null when none does. A
 * tie goes to the earlier box. Small buildings in a big world's overview are a few pixels across, so
 * a click a pixel or two beside one still opens it.
 */
export function nearestBox(boxes: readonly ScreenBox[], count: number, x: number, y: number, tol = PICK_TOLERANCE_PX): string | null {
  let best: string | null = null
  let bestD = tol * tol
  for (let i = 0; i < count; i++) {
    const b = boxes[i]
    const dx = x < b.l ? b.l - x : x > b.r ? x - b.r : 0
    const dy = y < b.t ? b.t - y : y > b.b ? y - b.b : 0
    const d = dx * dx + dy * dy
    if (d < bestD || (best === null && d === bestD)) { best = b.id; bestD = d }
  }
  return best
}

/**
 * A pick with the tolerance: what the ray hit (a building, orb or line) always wins; only when it hit
 * nothing is the nearest box within `tol` asked for, and `boxes` (projecting them) is only called then.
 */
export function toleratedPick<H>(hit: H | null, boxes: () => { boxes: readonly ScreenBox[]; count: number }, x: number, y: number, tol = PICK_TOLERANCE_PX): H | { kind: 'node'; id: string } | null {
  if (hit !== null) return hit
  const b = boxes()
  const id = nearestBox(b.boxes, b.count, x, y, tol)
  return id === null ? null : { kind: 'node', id }
}
