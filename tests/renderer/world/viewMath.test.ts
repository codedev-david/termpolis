import { describe, expect, it } from 'vitest'
import { busyness, BUSY_LINES, clamp, fitDistance, fitView, fogDensity, FOG_REACH, OPEN_FOG, type V3 } from '../../../src/renderer/src/world/engine/viewMath'

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
