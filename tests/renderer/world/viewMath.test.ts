import { describe, expect, it } from 'vitest'
import { clampIntoView, districtNameHalf, LABEL_GLOW_PX, busyness, BUSY_LINES, clamp, edgeLabelSize, fitDistance, fitView, fogDensity, FOG_REACH, LABEL_GAP, LABEL_KEEP_GAP, nameBudget, OPEN_FOG, NUDGES, placeLabels, rightInset, ZOOM_ALL_NAMES, type LabelCandidate, type V3 } from '../../../src/renderer/src/world/engine/viewMath'

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
