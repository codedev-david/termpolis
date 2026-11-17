import { describe, expect, it } from 'vitest'
import { bottomInset, clampIntoView, easeArea, freeArea, MIN_FREE_PX, sameArea, viewFrame, type FreeArea, districtNameHalf, OVERVIEW_DIR, overviewDir, PORTRAIT_DIR, PORTRAIT_HOLD, stretchFov, turnGround, TURN_RATIO, VERTICAL_NUDGES, LABEL_GLOW_PX, busyness, BUSY_LINES, clamp, edgeLabelSize, fitDistance, fitView, fogDensity, FOG_REACH, LABEL_GAP, LABEL_KEEP_GAP, nameBudget, OPEN_FOG, NUDGES, placeLabels, rightInset, ZOOM_ALL_NAMES, type LabelCandidate, type V3 } from '../../../src/renderer/src/world/engine/viewMath'

/** Where a point lands in the picture (-1..1 each way) for a camera at target + dir * dist. */
function project(p: V3, target: V3, dir: V3, dist: number, fov: number, aspect: number): [number, number] {
  const l = Math.hypot(...dir)
  const d: V3 = [dir[0] / l, dir[1] / l, dir[2] / l]
  const f: V3 = [-d[0], -d[1], -d[2]]
  const rr: V3 = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0]
  const rl = Math.hypot(...rr)
  const r: V3 = [rr[0] / rl, rr[1] / rl, rr[2] / rl]
  const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]
  const rel: V3 = [p[0] - target[0], p[1] - target[1], p[2] - target[2]]
  const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const depth = dist - dot(rel, d)
  const tanV = Math.tan((fov * Math.PI) / 360)
  return [dot(rel, r) / (depth * tanV * aspect), dot(rel, u) / (depth * tanV)]
}

describe('fogDensity', () => {
  it('keeps the theme density for a small world and thins it for a big one', () => {
    expect(fogDensity(0.004, 100, false)).toBe(0.004)
    expect(fogDensity(0.004, 1000, false)).toBeCloseTo(FOG_REACH / 1000)
  })

  it('thickens while a building is open', () => {
    expect(fogDensity(0.004, 100, true)).toBeCloseTo(0.004 * OPEN_FOG)
  })
})

describe('fitDistance', () => {
  const dir: V3 = [0, 0.5, 1]

  it('never comes closer than the least distance', () => {
    expect(fitDistance([], [0, 0, 0], dir, 55, 1.6, 1.1, 30)).toBe(30)
    expect(fitDistance([[0, 0, 0]], [0, 0, 0], dir, 55, 1.6, 1.1)).toBe(1)
  })

  it('puts the widest point at the edge of the picture less the margin', () => {
    const pts: V3[] = [[-50, 0, 0], [50, 0, 0], [0, 10, 0]]
    const dist = fitDistance(pts, [0, 0, 0], dir, 55, 1.6, 1.1)
    const xs = pts.map((p) => Math.abs(project(p, [0, 0, 0], dir, dist, 55, 1.6)[0]))
    expect(Math.max(...xs)).toBeCloseTo(1 / 1.1, 5)
  })

  it('fits a tall thing by its height in a narrow picture', () => {
    const pts: V3[] = [[0, 0, 0], [0, 80, 0]]
    const dist = fitDistance(pts, [0, 40, 0], [0, 0, 1], 55, 0.5, 1)
    expect(Math.abs(project([0, 80, 0], [0, 40, 0], [0, 0, 1], dist, 55, 0.5)[1])).toBeCloseTo(1, 5)
  })

  it('counts a point standing out toward the camera as nearer, so it needs more room', () => {
    const far = fitDistance([[10, 0, 0]], [0, 0, 0], [0, 0, 1], 55, 1, 1)
    const near = fitDistance([[10, 0, 5]], [0, 0, 0], [0, 0, 1], 55, 1, 1)
    expect(near).toBeCloseTo(far + 5, 5)
  })

  it('assumes an ordinary aspect when the view has no size', () => {
    const pts: V3[] = [[-50, 0, 0], [50, 0, 0]]
    const ok = fitDistance(pts, [0, 0, 0], dir, 55, 1.6, 1)
    expect(fitDistance(pts, [0, 0, 0], dir, 55, NaN, 1)).toBeCloseTo(ok)
    expect(fitDistance(pts, [0, 0, 0], dir, 55, 0, 1)).toBeCloseTo(ok)
  })

  it('looks straight down without losing its bearings', () => {
    const dist = fitDistance([[10, 0, 0], [-10, 0, 0]], [0, 0, 0], [0, 1, 0], 55, 1, 1)
    expect(Number.isFinite(dist)).toBe(true)
    expect(dist).toBeGreaterThan(10)
    expect(fitDistance([[1, 0, 0]], [0, 0, 0], [0, 0, 0], 55, 1, 1)).toBeGreaterThan(1)
  })
})

describe('fitView', () => {
  const dir: V3 = [0.24, 0.72, 1]

  it('frames nothing at the origin from the least distance', () => {
    expect(fitView([], dir, 55, 1.6, 1.1, 40)).toEqual({ target: [0, 0, 0], dist: 40 })
  })

  it('fills the picture: the city reaches the margin on one side and is centred', () => {
    const pts: V3[] = []
    for (const x of [-200, 200]) for (const z of [-120, 120]) pts.push([x, 0, z], [x + 30, 20, z])
    const { target, dist } = fitView(pts, dir, 55, 1.6, 1.1)
    const proj = pts.map((p) => project(p, target, dir, dist, 55, 1.6))
    const xs = proj.map((p) => p[0])
    const ys = proj.map((p) => p[1])
    const reach = Math.max(Math.max(...xs.map(Math.abs)), Math.max(...ys.map(Math.abs)))
    expect(reach).toBeGreaterThan(0.85)
    expect(reach).toBeLessThanOrEqual(1 / 1.1 + 1e-6)
    expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2)).toBeLessThan(0.05)
    expect(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2)).toBeLessThan(0.05)
  })

  it('stands further off for a bigger city', () => {
    const small = fitView([[-10, 0, -10], [10, 0, 10]], dir, 55, 1.6, 1.1).dist
    const big = fitView([[-100, 0, -100], [100, 0, 100]], dir, 55, 1.6, 1.1).dist
    expect(big).toBeGreaterThan(small * 5)
  })
})

describe('clamp', () => {
  it('holds a number between bounds, the lower winning when they cross', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
    expect(clamp(5, 8, 2)).toBe(8)
  })
})

describe('busyness', () => {
  it('is 1 up to BUSY_LINES lines, then falls with the square root of the count', () => {
    expect(busyness(0)).toBe(1)
    expect(busyness(BUSY_LINES)).toBe(1)
    expect(busyness(BUSY_LINES * 4)).toBeCloseTo(0.5)
    expect(busyness(612)).toBeLessThan(busyness(200))
  })
})

describe('edgeLabelSize', () => {
  it('grows with the text and keeps one line height', () => {
    expect(edgeLabelSize(0)).toEqual({ w: 16, h: 18 })
    expect(edgeLabelSize(32).w).toBeGreaterThan(edgeLabelSize(10).w)
  })
})

describe('placeLabels', () => {
  const box = (id: string, x: number, y: number, tier = 0, group?: string): LabelCandidate => ({ id, x, y, w: 100, h: 18, tier, ...(group ? { group } : {}) })
  const none = new Map<string, readonly [number, number]>()
  const was = (...ids: string[]): Map<string, readonly [number, number]> => new Map(ids.map((id) => [id, [0, 0] as const]))
  const ids = (m: Map<string, unknown>): string[] => [...m.keys()]
  it('keeps the first of overlapping labels and every label clear of the kept ones', () => {
    const shown = placeLabels([box('a', 100, 100), box('b', 150, 105), box('c', 220, 100), box('d', 100, 130)], none)
    expect(ids(shown)).toEqual(['a', 'c', 'd'])
    expect([...shown.values()]).toEqual([[0, 0], [0, 0], [0, 0]])
    expect(placeLabels([], none).size).toBe(0)
  })

  it('places the lower tiers first, keeping the given order within a tier', () => {
    const shown = placeLabels([box('far', 0, 0, 3), box('near', 40, 0, 1), box('next', 300, 0, 3), box('beside', 340, 0, 3)], none)
    expect(ids(shown)).toEqual(['near', 'next'])
  })

  it('caps a group, and lets labels with no group or an uncapped group through', () => {
    const cands = [box('e1', 0, 0, 0, 'line'), box('e2', 0, 100, 0, 'line'), box('e3', 0, 200, 0, 'line'), box('n', 0, 300), box('o', 0, 400, 0, 'other')]
    expect(ids(placeLabels(cands, none, { line: 2 }))).toEqual(['e1', 'e2', 'n', 'o'])
  })

  it('needs LABEL_GAP pixels to show a label and only LABEL_KEEP_GAP to keep one shown', () => {
    const edge = 100 + LABEL_KEEP_GAP * 2 + 1 // clear by more than the keep gap, less than the gap
    expect(edge).toBeLessThan(100 + LABEL_GAP * 2)
    expect(ids(placeLabels([box('a', 0, 0), box('b', edge, 0)], none))).toEqual(['a'])
    expect(ids(placeLabels([box('a', 0, 0), box('b', edge, 0)], was('b')))).toEqual(['a', 'b'])
    expect(ids(placeLabels([box('a', 0, 0), box('b', 102, 0)], none, {}, 4, 0))).toEqual(['a'])
    expect(ids(placeLabels([box('a', 0, 0), box('b', 108, 0)], none, {}, 4, 0))).toEqual(['a', 'b'])
    expect(ids(placeLabels([box('a', 0, 0), box('b', 0, 18)], was('b'), {}, 4, 0))).toEqual(['a', 'b'])
  })

  it('moves a label that may nudge to the first clear place round its point, else drops it', () => {
    const nudged = (id: string, x: number, y: number, tier = 1): LabelCandidate => ({ ...box(id, x, y, tier), nudge: true })
    // Its point is taken: just above it is free.
    expect([...placeLabels([box('a', 0, 0), nudged('b', 0, 0)], none)]).toEqual([['a', [0, 0]], ['b', [0, -(18 + LABEL_GAP)]]])
    // Its point is free: it stays there.
    expect(placeLabels([nudged('b', 0, 300)], none).get('b')).toEqual([0, 0])
    // Above taken too: below.
    expect(placeLabels([box('a', 0, 0), box('up', 0, -24), nudged('b', 0, 0)], none).get('b')).toEqual([0, 18 + LABEL_GAP])
    // Every place taken: not shown.
    const wall = NUDGES.map(([ux, uy], i) => box(`w${i}`, ux * (100 + LABEL_GAP), uy * (18 + LABEL_GAP)))
    expect(placeLabels([...wall, nudged('b', 0, 0)], none).has('b')).toBe(false)
  })

  it('moves a district name only up or down (vertical), and drops it when no row is clear', () => {
    const district = (id: string, x: number, y: number): LabelCandidate => ({ ...box(id, x, y, 3), nudge: 'vertical' })
    expect(VERTICAL_NUDGES).toEqual([[0, 0], [0, -1], [0, 1], [0, -2], [0, 2]])
    // Its point is taken: a row up is free.
    expect(placeLabels([district('api', 0, 100), district('auth', 40, 100)], none).get('auth')).toEqual([0, -(18 + LABEL_GAP)])
    // Up and down both taken one row off: two rows up.
    const rows = [box('a', 0, 100), box('up', 0, 76), box('down', 0, 124)]
    expect(placeLabels([...rows, district('b', 0, 100)], none).get('b')).toEqual([0, -2 * (18 + LABEL_GAP)])
    // Beside its point is free, but a district name never moves across: with every row taken it is dropped.
    const column = VERTICAL_NUDGES.map(([, uy], i) => box(`c${i}`, 0, 100 + uy * (18 + LABEL_GAP)))
    expect(placeLabels([...column, district('b', 0, 100)], none).has('b')).toBe(false)
    expect(placeLabels([...column, { ...box('b', 0, 100, 3), nudge: true }], none).get('b')).toEqual([-(100 + LABEL_GAP), 0])
  })

  it('keeps a moved label inside keepIn, and always allows its own point', () => {
    const view = [0, 0, 400, 300] as const
    const district = (id: string, x: number, y: number): LabelCandidate => ({ ...box(id, x, y, 3), nudge: 'vertical', keepIn: view })
    // At the top edge a row up would leave the view: it goes a row down.
    expect(placeLabels([box('a', 200, 12), district('b', 200, 12)], none).get('b')).toEqual([0, 18 + LABEL_GAP])
    // At the bottom edge it goes up.
    expect(placeLabels([box('a', 200, 288), district('b', 200, 288)], none).get('b')).toEqual([0, -(18 + LABEL_GAP)])
    // Its own point is allowed even if it pokes out; a kept place outside keepIn is not kept.
    expect(placeLabels([district('b', 200, 2)], none).get('b')).toEqual([0, 0])
    expect(placeLabels([district('b', 200, 12)], new Map([['b', [0, -24] as const]])).get('b')).toEqual([0, 0])
    expect(placeLabels([district('b', 200, 100)], new Map([['b', [0, -24] as const]])).get('b')).toEqual([0, -24])
  })

  it('keeps a shown label where it was while that place stays clear, else finds another', () => {
    const nudged: LabelCandidate = { ...box('b', 0, 0, 1), nudge: true }
    // Shown below last time, and below is still clear (above is clear too): it stays below.
    expect(placeLabels([box('a', 0, 0), nudged], new Map([['b', [0, 24] as const]])).get('b')).toEqual([0, 24])
    // Its old place is now taken: it moves to the first clear place.
    expect(placeLabels([box('a', 0, 0), box('c', 0, 24), nudged], new Map([['b', [0, 24] as const]])).get('b')).toEqual([0, -(18 + LABEL_GAP)])
  })
})

describe('nameBudget', () => {
  it('shows a few names at the overview and further out, never more than there are', () => {
    expect(nameBudget(100, 1)).toBe(10)
    expect(nameBudget(100, 1.6)).toBe(10)
    expect(nameBudget(25, 1)).toBe(5)
    expect(nameBudget(4, 1)).toBe(3)
    expect(nameBudget(2, 1)).toBe(2)
    expect(nameBudget(0, 1)).toBe(0)
    expect(nameBudget(400, 1)).toBe(10)
  })

  it('shows more as the camera nears, all of them from ZOOM_ALL_NAMES in', () => {
    const mid = nameBudget(100, 0.65)
    expect(mid).toBeGreaterThan(10)
    expect(mid).toBeLessThan(100)
    expect(nameBudget(100, 0.8)).toBeLessThan(mid)
    expect(nameBudget(100, ZOOM_ALL_NAMES)).toBe(100)
    expect(nameBudget(100, 0.1)).toBe(100)
  })
})

describe('the overview fit in a 500 px pane', () => {
  // A city 120 wide and 60 deep, seen from above and a little ahead, in a 500 x 700 canvas with the legend's chip on its right.
  const city: V3[] = [[-60, 0, -30], [60, 0, -30], [60, 0, 30], [-60, 0, 30], [-60, 20, 0], [60, 20, 0]]
  const view: V3 = [0.3, 1, 0.5]
  const chip = 108

  it('is fitted to the part the chip leaves free, and fills it', () => {
    const inset = rightInset(500, chip)
    expect(inset).toBe(chip)
    const free = (500 - inset) / 700
    const tight = fitView(city, view, 55, free, 1, 1).dist // the city touching the fit area's edge
    const fitted = fitView(city, view, 55, free, 1.1, 1).dist // what the overview uses
    expect(tight / fitted).toBeGreaterThan(0.85) // the city spans 85% or more of the fit area's limiting side
    expect(tight / fitted).toBeLessThan(1)
    // The 244 px strip would have left a 256 px fit area: the city smaller by the ratio of the areas.
    const strip = fitView(city, view, 55, (500 - 244) / 700, 1.1, 1).dist
    expect(strip).toBeGreaterThan(fitted * 1.3)
  })
})

describe('rightInset', () => {
  it('keeps the panel strip out of a wide view only', () => {
    expect(rightInset(1600, 244)).toBe(244)
    expect(rightInset(732, 244)).toBe(244)
    expect(rightInset(700, 244)).toBe(0)
    expect(rightInset(1600, 0)).toBe(0)
  })
})

describe('district name fit and clamp', () => {
  it('uses the measured half width plus the glow, and the fallback when unmeasured', () => {
    expect(districtNameHalf(200, 64)).toBe(100 + LABEL_GLOW_PX)
    expect(districtNameHalf(0, 64)).toBe(64)
  })
  it('a long name ("1 PART · 1 FILE" at 15px/11px with letter spacing is ~130px+) keeps more than the 64 px half', () => {
    expect(districtNameHalf(140, 64)).toBeGreaterThan(64)
  })
  it('shifts a box back inside the view with the inset, on each side', () => {
    expect(clampIntoView(10, 100, 100, 20, 500, 300, 4)).toEqual([44, 0])
    expect(clampIntoView(490, 100, 100, 20, 500, 300, 4)).toEqual([-44, 0])
    expect(clampIntoView(250, 5, 100, 20, 500, 300, 4)).toEqual([0, 9])
    expect(clampIntoView(250, 299, 100, 20, 500, 300, 4)).toEqual([0, -13])
  })
  it('leaves a box already inside alone, and centres one bigger than the view', () => {
    expect(clampIntoView(250, 150, 100, 20, 500, 300, 4)).toEqual([0, 0])
    expect(clampIntoView(100, 150, 600, 20, 500, 300, 4)).toEqual([150, 0])
  })
})

describe('the bottom reserve (the ask bar)', () => {
  it('keeps the strip out of the fit only while it leaves the city half the height or more', () => {
    expect(bottomInset(586, 150)).toBe(150)
    expect(bottomInset(300, 150)).toBe(150)
    expect(bottomInset(299, 150)).toBe(0)
    expect(bottomInset(586, 0)).toBe(0)
  })

  it('stretches the field of view to a taller picture at the same scale, and back to a part of it', () => {
    const tan = (deg: number): number => Math.tan((deg * Math.PI) / 360)
    expect(stretchFov(55, 400, 0)).toBe(55)
    expect(stretchFov(55, 0, 100)).toBe(55)
    expect(tan(stretchFov(55, 400, 100)) / tan(55)).toBeCloseTo(500 / 400, 10)
    expect(tan(stretchFov(55, 400, -100)) / tan(55)).toBeCloseTo(300 / 400, 10)
    // The scale stays: pixels per unit at a distance are height / (2 tan(fov / 2)) over the taller picture too.
    expect(500 / tan(stretchFov(55, 400, 100))).toBeCloseTo(400 / tan(55), 8)
    expect(stretchFov(55, 400, -500)).toBe(0)
  })
})

describe("the overview direction for the pane's shape", () => {
  // The small project's four districts on the hex lattice (api, auth, store, ui), 70 apart: wider in x
  // (105) than deep in z (61).
  const wide: Array<[number, number]> = [[0, 0], [-35, 60.62], [35, 60.62], [70, 0]]
  const deepCity: Array<[number, number]> = wide.map(([x, z]) => [z, x])
  const elevation = (d: readonly number[]): number => (Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI

  it('keeps OVERVIEW_DIR exactly in a landscape or square view, or one with no size', () => {
    for (const aspect of [1, 1.6, 3, 0, Number.NaN, Infinity]) {
      const o = overviewDir(aspect, wide)
      expect(o.dir).toBe(OVERVIEW_DIR)
      expect(o).toMatchObject({ portrait: false, turned: false })
    }
    expect(OVERVIEW_DIR[0] / OVERVIEW_DIR[2]).toBeCloseTo(0.24, 12)
    expect(OVERVIEW_DIR[1] / OVERVIEW_DIR[2]).toBeCloseTo(0.72, 12)
  })

  it('looks down more steeply in a portrait view, on the same bearing', () => {
    expect(Math.hypot(...PORTRAIT_DIR)).toBeCloseTo(1, 12)
    expect(elevation(OVERVIEW_DIR)).toBeCloseTo(35, 0)
    expect(elevation(PORTRAIT_DIR)).toBeGreaterThan(55)
    expect(elevation(PORTRAIT_DIR)).toBeLessThan(60)
    expect(PORTRAIT_DIR[0] / PORTRAIT_DIR[2]).toBeCloseTo(OVERVIEW_DIR[0] / OVERVIEW_DIR[2], 12)
    const o = overviewDir(0.71, deepCity)
    expect(o).toEqual({ dir: PORTRAIT_DIR, portrait: true, turned: false })
  })

  it('turns a city wider than deep a quarter, so its long side runs up the picture', () => {
    const o = overviewDir(0.71, wide)
    expect(o.portrait).toBe(true)
    expect(o.turned).toBe(true)
    expect(o.dir).toEqual([PORTRAIT_DIR[2], PORTRAIT_DIR[1], -PORTRAIT_DIR[0]])
    expect(elevation(o.dir)).toBeCloseTo(elevation(PORTRAIT_DIR), 12)
    // Seen from the turned direction, the ground's x (105 long) now runs into the picture, z (61) across.
    const flat = Math.hypot(o.dir[0], o.dir[2])
    const deepAxis = [o.dir[0] / flat, o.dir[2] / flat]
    const span = (ax: number[]): number => Math.max(...wide.map(([x, z]) => x * ax[0] + z * ax[1])) - Math.min(...wide.map(([x, z]) => x * ax[0] + z * ax[1]))
    expect(span(deepAxis)).toBeGreaterThan(span([deepAxis[1], -deepAxis[0]]))
  })

  it('does not turn a city near square (within TURN_RATIO), nor one with no ground', () => {
    // On the portrait direction's own ground axes: deep (into the picture) and across.
    const flat = Math.hypot(PORTRAIT_DIR[0], PORTRAIT_DIR[2])
    const deep = [PORTRAIT_DIR[0] / flat, PORTRAIT_DIR[2] / flat]
    const city = (across: number): Array<[number, number]> => [[0, 0], [deep[1] * across, -deep[0] * across], [deep[0] * 100, deep[1] * 100]]
    expect(overviewDir(0.7, city(100 * (TURN_RATIO - 0.01))).turned).toBe(false)
    expect(overviewDir(0.7, city(100 * (TURN_RATIO + 0.01))).turned).toBe(true)
    expect(overviewDir(0.7, []).turned).toBe(false)
  })

  it('stays portrait through a small resize near square, and never flips the turn with the size', () => {
    expect(overviewDir(1.05, wide).portrait).toBe(false)
    expect(overviewDir(1.05, wide, true).portrait).toBe(true)
    expect(overviewDir(PORTRAIT_HOLD, wide, true).portrait).toBe(false)
    const turns = [0.4, 0.6, 0.8, 0.95, 0.99].map((a) => overviewDir(a, wide).turned)
    expect(new Set(turns)).toEqual(new Set([true]))
  })

  it('turns a ground offset the same quarter as the direction', () => {
    expect(turnGround(0, 10, false)).toEqual([0, 10])
    // The name's offset toward the camera (+z) turns to +x, where the turned camera stands.
    expect(turnGround(0, 10, true)).toEqual([10, -0])
    const o = overviewDir(0.7, wide)
    const [x, z] = turnGround(0, 1, o.turned)
    expect(x * o.dir[0] + z * o.dir[2]).toBeGreaterThan(0)
  })
})

describe('freeArea', () => {
  it('with no card: the legend strip on the right and the ask bar strip at the bottom', () => {
    expect(freeArea(900, 700, 244, 158, null)).toEqual({ left: 0, top: 0, right: 244, bottom: 158 })
    // Each strip only where the view has room for it (rightInset, bottomInset).
    expect(freeArea(600, 300, 244, 158, null)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
    // A card of no size reserves nothing.
    expect(freeArea(900, 700, 0, 0, [0, 248])).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
    expect(freeArea(900, 700, 0, 0, [352, 0])).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
  })

  it('a narrow pane keeps the card out as a strip along the top, with the ask bar below', () => {
    // 416 px wide, the 330 px card spans nearly the width: beside it only 64 px would be left.
    const a = freeArea(416, 586, 0, 158, [352, 248])
    expect(a).toEqual({ left: 0, top: 248, right: 0, bottom: 158 })
    expect(586 - a.top - a.bottom).toBeGreaterThanOrEqual(MIN_FREE_PX)
  })

  it('a wide, short pane keeps the card out along the left, beside the legend strip', () => {
    // 1200 x 500 with the legend: below the card 500-248-120 = 132 px tall by 956 wide,
    // beside it 604 wide by 380 tall, the larger area.
    expect(freeArea(1200, 500, 244, 120, [352, 248])).toEqual({ left: 352, top: 0, right: 244, bottom: 120 })
  })

  it('a wide, tall pane keeps the card out along the top when that leaves the larger area', () => {
    // 800 x 900, legend 244, ask 150: below 556 x 502, beside 204 x 750.
    expect(freeArea(800, 900, 244, 150, [352, 248])).toEqual({ left: 0, top: 248, right: 244, bottom: 150 })
  })

  it('reserves no card when neither strip would leave MIN_FREE_PX each way', () => {
    // The ask bar strip stays; the card is not kept out.
    expect(freeArea(416, 400, 0, 158, [352, 248])).toEqual({ left: 0, top: 0, right: 0, bottom: 158 })
  })
})

describe('viewFrame', () => {
  it('is the view itself when nothing is reserved', () => {
    const f = viewFrame(800, 600, 55, { left: 0, top: 0, right: 0, bottom: 0 })
    expect(f).toEqual({ fullW: 800, fullH: 600, offX: 0, offY: 0, fov: 55, aspect: 800 / 600, fitFov: 55, fitAspect: 800 / 600 })
  })

  it('matches the right and bottom strips alone: a wider and taller picture, cut off at the left and top', () => {
    const f = viewFrame(800, 600, 55, { left: 0, top: 0, right: 200, bottom: 100 })
    expect(f.fullW).toBe(1000)
    expect(f.fullH).toBe(700)
    expect(f.offX).toBe(200)
    expect(f.offY).toBe(100)
    expect(f.fov).toBeCloseTo(stretchFov(55, 600, 100), 9)
    expect(f.aspect).toBeCloseTo(1000 / 700, 9)
    expect(f.fitFov).toBeCloseTo(stretchFov(55, 600, -100), 9)
    expect(f.fitAspect).toBeCloseTo(600 / 500, 9)
  })

  it('centres the picture on the free part between a top card strip and the ask bar', () => {
    const f = viewFrame(416, 586, 55, { left: 0, top: 248, right: 0, bottom: 158 })
    // The free part runs 248..428, its middle at 338: the picture is 676 tall, none cut at its top.
    expect(f.fullH).toBe(676)
    expect(f.offY).toBe(0)
    expect(f.fullW).toBe(416)
    expect(f.offX).toBe(0)
    expect(f.fitAspect).toBeCloseTo(416 / 180, 9)
    expect(f.fitFov).toBeCloseTo(stretchFov(55, 586, 180 - 586), 9)
  })

  it('a left card strip moves the centre right: the picture is cut off at its right edge', () => {
    const f = viewFrame(1200, 500, 55, { left: 352, top: 0, right: 244, bottom: 120 })
    // Free 352..956, middle 654: the picture spans 2 x 654 wide, the view at its left.
    expect(f.fullW).toBe(1308)
    expect(f.offX).toBe(0)
    expect(f.fullH).toBe(620)
    expect(f.offY).toBe(120)
  })

  it('never divides by a free part of no size', () => {
    const f = viewFrame(100, 100, 55, { left: 60, top: 60, right: 60, bottom: 60 })
    expect(Number.isFinite(f.fitAspect)).toBe(true)
    expect(Number.isFinite(f.fitFov)).toBe(true)
  })
})

describe('close-up fit inside the free area', () => {
  /** Where a point lands in view pixels, for a camera with this view frame at target + dir * dist. */
  function pixel(p: V3, target: V3, dir: V3, dist: number, width: number, height: number, area: FreeArea): [number, number] {
    const f = viewFrame(width, height, 55, area)
    const [x, y] = project(p, target, dir, dist, f.fov, f.aspect)
    return [((x + 1) / 2) * f.fullW - f.offX, ((1 - y) / 2) * f.fullH - f.offY]
  }
  // A line's arch and both end buildings, seen from the front and above.
  const pts: V3[] = [[-30, 0, 4], [-30, 18, 4], [0, 12, -2], [30, 0, -4], [30, 26, -4], [-10, 9, 0], [10, 9, 0]]
  const dir: V3 = [0.2, 0.6, 1]

  for (const [name, width, height, legend, ask] of [['narrow', 416, 586, 0, 158], ['wide', 1200, 500, 244, 120], ['tall', 800, 900, 244, 150]] as const) {
    it(`a ${name} pane: every point lands in the part the legend, the ask bar and the card leave free`, () => {
      const area = freeArea(width, height, legend, ask, [352, 248])
      expect(area.top + area.left).toBeGreaterThan(0) // the card is reserved
      const f = viewFrame(width, height, 55, area)
      const fit = fitView(pts, dir, f.fitFov, f.fitAspect, 1.1, 1)
      for (const p of pts) {
        const [x, y] = pixel(p, fit.target, dir, fit.dist, width, height, area)
        expect(x).toBeGreaterThanOrEqual(area.left - 0.5)
        expect(x).toBeLessThanOrEqual(width - area.right + 0.5)
        expect(y).toBeGreaterThanOrEqual(area.top - 0.5)
        expect(y).toBeLessThanOrEqual(height - area.bottom + 0.5)
      }
    })
  }

  it('the same fit without the card reserve puts points under the card', () => {
    const width = 416
    const height = 586
    const open = freeArea(width, height, 0, 158, null)
    const f = viewFrame(width, height, 55, open)
    const fit = fitView(pts, dir, f.fitFov, f.fitAspect, 1.1, 1)
    const under = pts.some((p) => {
      const [x, y] = pixel(p, fit.target, dir, fit.dist, width, height, open)
      return x < 352 && y < 248
    })
    expect(under).toBe(true)
  })
})

describe('easeArea', () => {
  const a: FreeArea = { left: 0, top: 0, right: 0, bottom: 0 }
  const goal: FreeArea = { left: 0, top: 248, right: 244, bottom: 158 }

  it('moves part of the way each frame, and lands exactly within half a pixel', () => {
    const next = easeArea(a, goal, 1 / 60)
    expect(next.top).toBeGreaterThan(0)
    expect(next.top).toBeLessThan(248)
    expect(sameArea(next, goal)).toBe(false)
    let cur = a
    for (let i = 0; i < 120 && !sameArea(cur, goal); i++) cur = easeArea(cur, goal, 1 / 60)
    expect(cur).toEqual(goal)
  })

  it('a frame of no time (or negative) does not move it', () => {
    expect(easeArea(a, goal, 0)).toEqual(a)
    expect(easeArea(a, goal, -1)).toEqual(a)
  })

  it('sameArea looks at every side', () => {
    expect(sameArea(a, { ...a, left: 0.4 })).toBe(true)
    for (const k of ['left', 'top', 'right', 'bottom'] as const) expect(sameArea(a, { ...a, [k]: 1 })).toBe(false)
  })
})
