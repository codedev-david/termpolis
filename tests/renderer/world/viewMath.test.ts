import { describe, expect, it, test } from 'vitest'
import { LABEL_HIDE_BELOW, LABEL_MIN_OPACITY, readableOpacity, easeShare, frameStep, MAX_FRAME_DT, FLOOR_RISE_RATE, FLOOR_TURN_RATE, FOG_RATE, zoomTier, zoomTierAt, ZOOM_FAR, ZOOM_NEAR, backOffs, bottomInset, clampIntoView, inFreeArea, turnAcross, easeArea, freeArea, MIN_FREE_PX, sameArea, viewFrame, type FreeArea, districtNameHalf, OVERVIEW_DIR, overviewDir, PORTRAIT_DIR, PORTRAIT_HOLD, stretchFov, turnGround, TURN_RATIO, VERTICAL_NUDGES, LABEL_GLOW_PX, busyness, BUSY_LINES, clamp, edgeLabelSize, fitDistance, fitView, fogDensity, FOG_REACH, LABEL_GAP, LABEL_KEEP_GAP, nameBudget, OPEN_FOG, NUDGES, placeLabels, rightInset, ZOOM_ALL_NAMES, nearestBox, PICK_TOLERANCE_PX, toleratedPick, type ScreenBox, type LabelCandidate, type V3 } from '../../../src/renderer/src/world/engine/viewMath'

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
    expect(edgeLabelSize(0)).toEqual({ w: 16, h: 19 })
    expect(edgeLabelSize(10)).toEqual({ w: 84, h: 19 })
    expect(edgeLabelSize(32).w).toBeGreaterThan(edgeLabelSize(10).w)
  })
  it('scales with the labels on a big screen', () => {
    expect(edgeLabelSize(10, 1.5)).toEqual({ w: 126, h: 29 })
    expect(edgeLabelSize(0, 2)).toEqual({ w: 32, h: 38 })
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

  it('a label with a compact form (a district name without its subtitle) gets its room as a name first, then grows whole only where that is clear (film bug 7)', () => {
    // A district: a 40 x 18 name over a 300-pixel subtitle, 36 high in all. Its neighbour's name sits beside it.
    const sub: LabelCandidate = { id: 'd', x: 300, y: 100, w: 300, h: 36, tier: 3, compact: { w: 40, h: 18 } }
    const near = box('n', 400, 100) // clear of the 40-pixel name, not of the 300-pixel subtitle
    const out = { was: new Set<string>(), now: new Set<string>() }
    expect(placeLabels([near, sub], none, {}, LABEL_GAP, LABEL_KEEP_GAP, out).get('d')).toEqual([0, 0])
    expect([...out.now]).toEqual(['d'])
    // With room for it all, the whole label shows.
    const roomy = { was: new Set<string>(), now: new Set<string>() }
    expect(placeLabels([box('n', 700, 100), sub], none, {}, LABEL_GAP, LABEL_KEEP_GAP, roomy).get('d')).toEqual([0, 0])
    expect(roomy.now.size).toBe(0)
    // Whole last time, clear by the keeping gap only: it stays whole. Compact last time: it stays compact.
    const edge = box('n', 450 + 50 + LABEL_KEEP_GAP, 100)
    const whole = { was: new Set<string>(), now: new Set<string>() }
    placeLabels([edge, sub], was('d'), {}, LABEL_GAP, LABEL_KEEP_GAP, whole)
    expect(whole.now.size).toBe(0)
    const small = { was: new Set(['d']), now: new Set<string>() }
    placeLabels([edge, sub], was('d'), {}, LABEL_GAP, LABEL_KEEP_GAP, small)
    expect([...small.now]).toEqual(['d'])
    // Two districts whose subtitles meet: both names show, the first grows whole, the second stays compact.
    const sub2: LabelCandidate = { ...sub, id: 'e', x: 500 }
    const both = { was: new Set<string>(), now: new Set<string>() }
    expect([...placeLabels([sub, sub2], none, {}, LABEL_GAP, LABEL_KEEP_GAP, both).keys()]).toEqual(['d', 'e'])
    expect([...both.now]).toEqual(['e'])
    // A nudged label must stay inside its room to grow; a name with no room drops out.
    const roomOnly: LabelCandidate = { ...sub, nudge: 'vertical', keepIn: [0, 0, 1000, 200] }
    const up = { was: new Set<string>(), now: new Set<string>() }
    expect(placeLabels([box('n', 300, 100), roomOnly], none, {}, LABEL_GAP, LABEL_KEEP_GAP, up).get('d')).toEqual([0, -(18 + LABEL_GAP)])
    expect([...up.now]).toEqual(['d'])
    const gone = { was: new Set<string>(), now: new Set<string>() }
    expect(placeLabels([box('n', 300, 100), sub], none, {}, LABEL_GAP, LABEL_KEEP_GAP, gone).has('d')).toBe(false)
    expect(gone.now.size).toBe(0)
    // A subtitle grows before a later tier's labels are placed: a tier-4 name under it gives way.
    const later = { was: new Set<string>(), now: new Set<string>() }
    expect([...placeLabels([box('m', 420, 100, 4), sub], none, {}, LABEL_GAP, LABEL_KEEP_GAP, later).keys()]).toEqual(['d'])
    expect(later.now.size).toBe(0)
    expect(placeLabels([], none, {}, LABEL_GAP, LABEL_KEEP_GAP, later).size).toBe(0)
  })
})

describe('placeLabels in its room: the view and the panels over it', () => {
  const none = new Map<string, readonly [number, number]>()
  const box = (id: string, x: number, y: number, extra: Partial<LabelCandidate> = {}): LabelCandidate => ({ id, x, y, w: 100, h: 18, tier: 1, ...extra })
  const view = [0, 0, 800, 600] as const
  const legend = [600, 300, 800, 600] as const

  it('drops a label cut off at the edge of the view, and one under a panel', () => {
    const room = { bounds: view, blocked: [legend] }
    const shown = placeLabels([box('in', 200, 100), box('cut', 30, 100), box('low', 200, 595), box('under', 650, 400), box('beside', 540, 400)], none, {}, LABEL_GAP, LABEL_KEEP_GAP, undefined, room)
    expect([...shown.keys()]).toEqual(['in', 'beside'])
    // With no room given, every place is open, as before.
    expect(placeLabels([box('cut', 30, 100), box('under', 650, 400)], none).size).toBe(2)
    // Bounds alone, or panels alone.
    expect([...placeLabels([box('cut', 30, 100), box('under', 650, 400)], none, {}, LABEL_GAP, LABEL_KEEP_GAP, undefined, { bounds: view }).keys()]).toEqual(['under'])
    expect([...placeLabels([box('cut', 30, 100), box('under', 650, 400)], none, {}, LABEL_GAP, LABEL_KEEP_GAP, undefined, { blocked: [legend] }).keys()]).toEqual(['cut'])
  })

  it('moves a label that may nudge out from under a panel', () => {
    const room = { bounds: view, blocked: [[0, 0, 800, 90] as const] }
    expect(placeLabels([box('b', 400, 90, { nudge: true })], none, {}, LABEL_GAP, LABEL_KEEP_GAP, undefined, room).get('b')).toEqual([0, 18 + LABEL_GAP])
  })

  it("never puts a label marked always under a panel as its last resort: last time's place, its own point, or not at all", () => {
    const pile = (n: number): LabelCandidate[] => Array.from({ length: n }, (_, i) => box('e:' + i, 200, 200, { tier: 5, nudge: true, always: true }))
    const cands = pile(NUDGES.length + 2)
    const open = placeLabels(cands, none, {}, LABEL_GAP, LABEL_KEEP_GAP, undefined, { bounds: view })
    expect(open.size).toBe(NUDGES.length + 2)
    // A panel over the point: the crowded ones are not drawn under it.
    const over = { bounds: view, blocked: [[150, 190, 250, 210] as const] }
    const shown = placeLabels(cands, none, {}, LABEL_GAP, LABEL_KEEP_GAP, undefined, over)
    expect([...shown.values()].every(([dx, dy]) => dx !== 0 || dy !== 0)).toBe(true)
    // Last time's place is kept only while it is in the room.
    const last = new Map<string, readonly [number, number]>([['e:' + (NUDGES.length + 1), [300, 300]]])
    expect(placeLabels(cands, last, {}, LABEL_GAP, LABEL_KEEP_GAP, undefined, { bounds: view }).get('e:' + (NUDGES.length + 1))).toEqual([300, 300])
    expect(placeLabels(cands, last, {}, LABEL_GAP, LABEL_KEEP_GAP, undefined, { bounds: [0, 0, 400, 400] }).has('e:' + (NUDGES.length + 1))).toBe(false)
  })

  it('keeps a district name compact where its whole label would run under a panel', () => {
    const sub: LabelCandidate = { id: 'd', x: 300, y: 100, w: 300, h: 36, tier: 3, compact: { w: 40, h: 18 } }
    const forms = { was: new Set<string>(), now: new Set<string>() }
    expect(placeLabels([sub], none, {}, LABEL_GAP, LABEL_KEEP_GAP, forms, { bounds: view, blocked: [[380, 0, 800, 200]] }).get('d')).toEqual([0, 0])
    expect([...forms.now]).toEqual(['d'])
  })

  it('keeps a word of room across between labels on one row when one asks for it (rowGap)', () => {
    // 100-pixel labels whose edges are LABEL_GAP + 10 apart: clear, until one asks for 15 more across.
    const at = 100 + LABEL_GAP + 10
    expect(placeLabels([box('a', 0, 0), box('b', at, 0)], none).size).toBe(2)
    expect([...placeLabels([box('a', 0, 0, { rowGap: 15 }), box('b', at, 0)], none).keys()]).toEqual(['a'])
    expect([...placeLabels([box('a', 0, 0), box('b', at, 0, { rowGap: 15 })], none).keys()]).toEqual(['a'])
    // Up and down, the row gap does not count.
    expect(placeLabels([box('a', 0, 0, { rowGap: 15 }), box('b', 0, 18 + LABEL_GAP)], none).size).toBe(2)
  })
})

describe('placeLabels with every line labelled', () => {
  const none = new Map<string, readonly [number, number]>()
  // A dense knot: 40 line labels piled on one point, so every nudge slot of the later ones is taken.
  const dense = (always: boolean): LabelCandidate[] =>
    Array.from({ length: 40 }, (_, i) => ({ id: 'e:' + i, x: 200, y: 200, w: 100, h: 18, tier: 5, nudge: true, ...(always ? { always: true } : {}) }))
  it('places every label marked always, the crowded ones as a last resort on their own point', () => {
    const shown = placeLabels(dense(true), none)
    expect(shown.size).toBe(40)
    // The first 11 take the 11 nudge slots; the rest overlap at their own point.
    expect(new Set([...shown.values()].slice(0, NUDGES.length).map((d) => d.join())).size).toBe(NUDGES.length)
    expect([...shown.values()].slice(NUDGES.length).every(([dx, dy]) => dx === 0 && dy === 0)).toBe(true)
    // Without the mark, the crowded ones drop as before.
    expect(placeLabels(dense(false), none).size).toBe(NUDGES.length)
  })
  it('a crowded label marked always keeps the place it had last time', () => {
    const cands = dense(true)
    const last = new Map<string, readonly [number, number]>([['e:39', [7, -3]]])
    expect(placeLabels(cands, last).get('e:39')).toEqual([7, -3])
  })
})

describe('zoomTier', () => {
  test('zoomTier', () => { expect(zoomTier(0.1)).toBe('districts'); expect(zoomTier(0.5)).toBe('buildings'); expect(zoomTier(0.9)).toBe('floors') })
  it('changes tier at ZOOM_FAR and ZOOM_NEAR', () => {
    expect(zoomTier(ZOOM_FAR - 0.001)).toBe('districts')
    expect(zoomTier(ZOOM_FAR)).toBe('buildings')
    expect(zoomTier(ZOOM_NEAR)).toBe('floors')
  })
  it('reads the camera distance over the overview distance as closeness', () => {
    expect(zoomTierAt(1)).toBe('districts')
    expect(zoomTierAt(1.4)).toBe('districts')
    expect(zoomTierAt(0.5)).toBe('buildings')
    expect(zoomTierAt(0.2)).toBe('floors')
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

  it('keeps the strip from the width its owner names, when it names one', () => {
    // The exported page's Ask strip (344 px) is kept clear from 732 px, not from three times the strip (1032).
    expect(rightInset(1024, 344)).toBe(0)
    expect(rightInset(1024, 344, 732)).toBe(344)
    expect(rightInset(732, 344, 732)).toBe(344)
    expect(rightInset(731, 344, 732)).toBe(0)
    expect(rightInset(1600, 0, 732)).toBe(0)
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

  it('keeps the legend strip from the width given for it', () => {
    // 1024 x 645, the exported page on a macOS runner: the Ask strip (344) and the card beside it (352).
    expect(freeArea(1024, 645, 344, 56, [352, 549])).toEqual({ left: 352, top: 0, right: 0, bottom: 56 })
    expect(freeArea(1024, 645, 344, 56, [352, 549], 732)).toEqual({ left: 352, top: 0, right: 344, bottom: 56 })
  })

  it('drops a strip kept only from the width given for it when the open card fits nowhere beside it', () => {
    // The exported page 732 to 827 px wide with a full-height card (12 + 340 + 12 wide, its CSS max height
    // calc(100% - 110px) plus its gaps tall): beside the Ask strip (344) the card leaves under MIN_FREE_PX, so the
    // card wins and the building is framed right of it, not behind it.
    const centreX = (w: number, f: FreeArea): number => f.left + (w - f.left - f.right) / 2
    for (const [w, h] of [[800, 700], [732, 600]] as const) {
      const card = [364, h - 86] as const
      const f = freeArea(w, h, 344, 56, card, 732)
      expect(f).toEqual({ left: 364, top: 0, right: 0, bottom: 56 })
      expect(centreX(w, f), `${w} x ${h}: the framed building's centre is right of the card`).toBeGreaterThan(card[0])
    }
    // From 828 px the card fits beside the strip, and both are kept.
    expect(freeArea(828, 700, 344, 56, [364, 614], 732)).toEqual({ left: 364, top: 0, right: 344, bottom: 56 })
    // A card that fits nowhere even without the strip leaves the strip kept, as before.
    expect(freeArea(732, 600, 344, 56, [700, 560], 732)).toEqual({ left: 0, top: 0, right: 344, bottom: 56 })
    // A strip the default width (three times its own) keeps is never dropped for the card.
    expect(freeArea(1100, 150, 344, 56, [364, 140], 732)).toEqual({ left: 0, top: 0, right: 344, bottom: 56 })
    expect(freeArea(1100, 150, 344, 56, [364, 140])).toEqual({ left: 0, top: 0, right: 344, bottom: 56 })
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

describe("a long line's close-up: both ends beside the card", () => {
  const card = freeArea(416, 618, 108, 158, [400, 176])
  it('inFreeArea takes the free part of the view, inset pixels inside its edges', () => {
    expect(card).toEqual({ left: 0, top: 176, right: 108, bottom: 158 })
    const ndc = (x: number, y: number): [number, number] => [(x / 416) * 2 - 1, 1 - (y / 618) * 2]
    expect(inFreeArea(...ndc(150, 300), 416, 618, card)).toBe(true)
    expect(inFreeArea(...ndc(150, 100), 416, 618, card)).toBe(false) // under the card
    expect(inFreeArea(...ndc(350, 300), 416, 618, card)).toBe(false) // under the legend
    expect(inFreeArea(...ndc(150, 500), 416, 618, card)).toBe(false) // under the ask bar
    expect(inFreeArea(...ndc(3, 300), 416, 618, card)).toBe(true)
    expect(inFreeArea(...ndc(3, 300), 416, 618, card, 6)).toBe(false) // on the view's edge
    expect(inFreeArea(...ndc(150, 180), 416, 618, card, 6)).toBe(false) // on the card's edge
    expect(inFreeArea(...ndc(150, 190), 416, 618, card, 6)).toBe(true)
    // a point past the far plane, or behind the camera, shows nowhere
    expect(inFreeArea(...ndc(150, 300), 416, 618, card, 0, 0.99)).toBe(true)
    expect(inFreeArea(...ndc(150, 300), 416, 618, card, 0, 1.01)).toBe(false)
    expect(inFreeArea(...ndc(150, 300), 416, 618, card, 0, -1.01)).toBe(false)
  })
  it('backOffs steps out from the fit to the reach, the reach last', () => {
    expect(backOffs(100, 300, 1.5)).toEqual([100, 150, 225, 300])
    expect(backOffs(100, 100, 1.5)).toEqual([100])
    expect(backOffs(200, 100, 1.5)).toEqual([200])
    expect(backOffs(100, 300, 1)).toEqual([100])
    expect(backOffs(100, 300, Number.NaN)).toEqual([100])
  })
  it('turnAcross turns a ground direction about the vertical', () => {
    const [a, b, c, d] = turnAcross([0, 1], [0, 180, 90, -45])
    expect(a[0]).toBeCloseTo(0); expect(a[1]).toBeCloseTo(1)
    expect(b[0]).toBeCloseTo(0); expect(b[1]).toBeCloseTo(-1)
    expect(c[0]).toBeCloseTo(1); expect(c[1]).toBeCloseTo(0)
    expect(d[0]).toBeCloseTo(-Math.SQRT1_2); expect(d[1]).toBeCloseTo(Math.SQRT1_2)
    expect(turnAcross([1, 0], [])).toEqual([])
  })
  it('a line across the city in a narrow pane: backing off brings an end cut off at the side into the free area', () => {
    // The two ends of a long line, and a camera fitted only to a point near one of them: the far
    // end falls outside the view; backing off along the same direction brings it inside.
    const width = 416
    const height = 618
    const f = viewFrame(width, height, 55, card)
    const dir: V3 = [0.2, 0.7, 1]
    const near: V3 = [0, 20, 0]
    const far: V3 = [-160, 20, 0]
    const fit = fitView([near], dir, f.fitFov, f.fitAspect, 1.2, 30)
    const at = (dist: number): boolean => {
      const [x, y] = project(far, fit.target, dir, dist, f.fov, f.aspect)
      // From the camera's full picture to the view, then to the view's -1..1.
      const px = ((x + 1) / 2) * f.fullW - f.offX
      const py = ((1 - y) / 2) * f.fullH - f.offY
      return inFreeArea((px / width) * 2 - 1, 1 - (py / height) * 2, width, height, card, 6)
    }
    const steps = backOffs(fit.dist, 2000, 1.3)
    expect(at(steps[0])).toBe(false)
    const first = steps.findIndex(at)
    expect(first).toBeGreaterThan(0)
    expect(steps.slice(first).every(at)).toBe(true)
  })
})

describe('frame-rate independent easing', () => {
  /** `seconds` of frames at `fps`, each moving `v` toward `goal` by easeShare(rate, dt), as the city's loop does. */
  const run = (fps: number, seconds: number, rate: number, v = 0, goal = 100): number => {
    const dt = 1 / fps
    for (let t = 0; t < seconds - 1e-9; t += dt) v += (goal - v) * easeShare(rate, frameStep(dt))
    return v
  }

  it('reaches the same point at the same wall time at 10, 30 and 60 fps', () => {
    for (const rate of [FLOOR_RISE_RATE, FLOOR_TURN_RATE, FOG_RATE, 12]) {
      for (const seconds of [0.2, 0.5, 1]) {
        const at60 = run(60, seconds, rate)
        expect(run(30, seconds, rate)).toBeCloseTo(at60, 6)
        expect(run(10, seconds, rate)).toBeCloseTo(at60, 6)
      }
    }
  })

  it('keeps the old per-frame step at 60 fps (min(1, dt * k) with k 5, 4 and 2)', () => {
    expect(easeShare(FLOOR_RISE_RATE, 1 / 60)).toBeCloseTo(5 / 60, 9)
    expect(easeShare(FLOOR_TURN_RATE, 1 / 60)).toBeCloseTo(4 / 60, 9)
    expect(easeShare(FOG_RATE, 1 / 60)).toBeCloseTo(2 / 60, 9)
  })

  it('a frame of no time (or negative) moves nothing; a long one never overshoots', () => {
    expect(easeShare(5, 0)).toBe(0)
    expect(easeShare(5, -1)).toBe(0)
    expect(easeShare(5, 100)).toBeLessThanOrEqual(1)
  })

  it('a frame step is only cut at a tab-switch spike, never at a slow frame rate', () => {
    expect(frameStep(1 / 10)).toBe(0.1)
    expect(frameStep(0.2)).toBe(0.2)
    expect(frameStep(5)).toBe(MAX_FRAME_DT)
    expect(MAX_FRAME_DT).toBe(0.25)
    expect(frameStep(-0.01)).toBe(0)
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

  it('reaches the same area at the same wall time at 10, 30 and 60 fps', () => {
    const at = (fps: number): FreeArea => {
      let cur = a
      for (let i = 0; i < fps * 0.2 - 1e-9; i++) cur = easeArea(cur, goal, frameStep(1 / fps))
      return cur
    }
    const at60 = at(60)
    for (const fps of [10, 30]) for (const k of ['left', 'top', 'right', 'bottom'] as const) expect(at(fps)[k]).toBeCloseTo(at60[k], 6)
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

describe('nearestBox (the pick tolerance)', () => {
  const box = (id: string, l: number, t: number, r: number, b: number): ScreenBox => ({ id, l, t, r, b })
  const small = box('m3', 100, 100, 104, 103) // a building a few pixels across in a big world's overview

  it('picks a building a miss lands within 6 px of, inside it as well', () => {
    expect(PICK_TOLERANCE_PX).toBe(6)
    expect(nearestBox([small], 1, 102, 101)).toBe('m3') // inside
    expect(nearestBox([small], 1, 98, 101)).toBe('m3') // 2 px left
    expect(nearestBox([small], 1, 102, 97)).toBe('m3') // 3 px above
    expect(nearestBox([small], 1, 110, 101)).toBe('m3') // exactly 6 px right
    expect(nearestBox([small], 1, 108, 107)).toBe('m3') // 4, 4 off the corner: 5.7 px
  })

  it('picks nothing beyond 6 px', () => {
    expect(nearestBox([small], 1, 110.5, 101)).toBeNull()
    expect(nearestBox([small], 1, 109, 108)).toBeNull() // 5, 5 off the corner: 7.1 px
    expect(nearestBox([small], 1, 102, 90)).toBeNull()
    expect(nearestBox([], 0, 102, 101)).toBeNull()
  })

  it('takes the nearest of two, and the earlier on a tie', () => {
    const a = box('a', 100, 100, 104, 104)
    const b = box('b', 110, 100, 114, 104)
    expect(nearestBox([a, b], 2, 106, 102)).toBe('a') // 2 px from a, 4 from b
    expect(nearestBox([a, b], 2, 108.5, 102)).toBe('b') // 4.5 from a, 1.5 from b
    expect(nearestBox([a, b], 2, 107, 102)).toBe('a') // 3 from each
    expect(nearestBox([b, a], 2, 107, 102)).toBe('b')
    // A box inside counts as 0 and beats one only near.
    expect(nearestBox([a, box('big', 90, 90, 130, 130)], 2, 106, 102)).toBe('big')
  })

  it('reads only the first `count` boxes (the rest are kept for reuse)', () => {
    expect(nearestBox([box('gone', 0, 0, 10, 10), small], 1, 102, 101)).toBeNull()
    expect(nearestBox([small, box('stale', 100, 100, 104, 103)], 1, 102, 101)).toBe('m3')
  })
})

describe('toleratedPick', () => {
  const near = [{ id: 'm3', l: 100, t: 100, r: 104, b: 103 }]
  it('lets a direct ray hit win over a nearer box, and projects the boxes only on a miss', () => {
    let projected = 0
    const boxes = (): { boxes: ScreenBox[]; count: number } => { projected++; return { boxes: near, count: 1 } }
    expect(toleratedPick({ kind: 'edge', id: 'e1' }, boxes, 102, 101)).toEqual({ kind: 'edge', id: 'e1' })
    expect(toleratedPick({ kind: 'node', id: 'far' }, boxes, 102, 101)).toEqual({ kind: 'node', id: 'far' })
    expect(projected).toBe(0)
    expect(toleratedPick(null, boxes, 98, 101)).toEqual({ kind: 'node', id: 'm3' })
    expect(toleratedPick(null, boxes, 120, 101)).toBeNull()
    expect(projected).toBe(2)
  })
})

describe('placeLabels: names kept off the buildings (solid)', () => {
  const name = (id: string, x: number, y: number, over: Partial<LabelCandidate> = {}): LabelCandidate => ({ id, x, y, w: 100, h: 20, tier: 3, nudge: 'vertical', solidFree: true, ...over })
  const none = new Map<string, readonly [number, number]>()

  it("moves a name that would lie on a building's box up or down to a place clear of it", () => {
    // A building's box on screen right over the name's point; above it (a row up) is clear.
    const out = placeLabels([name('d', 200, 200)], none, {}, 6, 1, undefined, { solid: [[150, 195, 250, 260]] })
    expect(out.get('d')).toEqual([0, -26])
  })

  it('keeps the name on its point where every place it could go meets a building, rather than dropping it', () => {
    const out = placeLabels([name('d', 200, 200)], none, {}, 6, 1, undefined, { solid: [[0, 0, 400, 400]] })
    expect(out.get('d')).toEqual([0, 0])
  })

  it('places a name kept off the buildings on its point where the room names no buildings', () => {
    expect(placeLabels([name('d', 200, 200)], none, {}, 6, 1, undefined, {}).get('d')).toEqual([0, 0])
  })

  it('lets a label not marked solidFree lie on a building, and a name clear of the buildings stay on its point', () => {
    const out = placeLabels([name('chip', 200, 200, { solidFree: false, tier: 0 }), name('d', 200, 40)], none, {}, 6, 1, undefined, { solid: [[150, 150, 250, 260]] })
    expect(out.get('chip')).toEqual([0, 0])
    expect(out.get('d')).toEqual([0, 0])
  })

  it('a solid-free place still keeps clear of the labels already kept and inside its room', () => {
    // The point and a row down meet the building; a row and two rows up are taken by labels; two rows down is clear of all.
    const chip = (id: string, y: number): LabelCandidate => name(id, 200, y, { solidFree: false, tier: 0, nudge: undefined })
    const out = placeLabels(
      [chip('chip', 174), chip('chip2', 148), name('d', 200, 200)],
      none, {}, 6, 1, undefined, { solid: [[150, 195, 250, 235]], bounds: [0, 0, 400, 400] },
    )
    expect(out.get('d')).toEqual([0, 52])
  })

  it("grows a name's subtitle only where the whole label stays off the buildings it kept clear of", () => {
    const compact = { was: new Set<string>(), now: new Set<string>() }
    // The name alone (20 px) fits above the building; whole (40 px tall, from the same middle) it would reach down onto it.
    placeLabels([name('d', 200, 100, { h: 40, compact: { w: 100, h: 20 } })], none, {}, 6, 1, compact, { solid: [[150, 112, 250, 200]] })
    expect([...compact.now]).toEqual(['d'])
    const roomy = { was: new Set<string>(), now: new Set<string>() }
    placeLabels([name('d', 200, 100, { h: 40, compact: { w: 100, h: 20 } })], none, {}, 6, 1, roomy, { solid: [[150, 130, 250, 200]] })
    expect([...roomy.now]).toEqual([])
    // A name left on a building (no clear place) grows as it did before: it lies on the building either way.
    const stuck = { was: new Set<string>(), now: new Set<string>() }
    placeLabels([name('d', 200, 100, { h: 40, compact: { w: 100, h: 20 } })], none, {}, 6, 1, stuck, { solid: [[0, 0, 400, 400]] })
    expect([...stuck.now]).toEqual([])
  })
})

describe('readableOpacity', () => {
  it('raises a faint label to a readable floor and hides one fainter still, rather than drawing it as a smudge', () => {
    expect(LABEL_MIN_OPACITY).toBeGreaterThanOrEqual(0.5)
    expect(LABEL_HIDE_BELOW).toBeLessThan(LABEL_MIN_OPACITY)
    expect(readableOpacity(1)).toBe(1)
    expect(readableOpacity(0.8)).toBe(0.8)
    expect(readableOpacity(LABEL_MIN_OPACITY - 0.05)).toBe(LABEL_MIN_OPACITY)
    expect(readableOpacity(LABEL_HIDE_BELOW)).toBe(LABEL_MIN_OPACITY)
    expect(readableOpacity(LABEL_HIDE_BELOW - 0.01)).toBeNull()
    expect(readableOpacity(0.2)).toBeNull()
    expect(readableOpacity(0)).toBeNull()
  })
})
