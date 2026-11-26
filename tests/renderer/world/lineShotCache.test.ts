// lineShotCache: a line close-up's search is kept per line and layout, and a new view size only fits the distance
// again over the kept points (look plan Task 5, WP2 M-a).
import { describe, expect, it } from 'vitest'
import { createLineShotCache, lineShotKey, reaim, type CachedLineShot } from '../../../src/renderer/src/world/engine/lineShotCache'
import { fitDistance, type V3 } from '../../../src/renderer/src/world/engine/viewMath'

const norm = (v: V3): V3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l] }
const FIT = { margin: 1.2, minDist: 10, maxDist: 420 }
/** An arch over 60 m and two end buildings, seen from across it and above. */
const LINE: CachedLineShot = {
  dir: norm([0.3, 0.8, 1]),
  target: [0, 4, 0],
  points: [[-30, 2, 0], [-15, 9, 1], [0, 12, 0], [15, 9, -1], [30, 2, 0], [-30, 14, 0], [30, 14, 0]],
  stretch: 1.15,
}

/** Whether `p` is inside a camera's picture: at `pos` looking at `target`, `fov` high and `aspect` wide. */
function inView(p: V3, pos: V3, target: V3, fov: number, aspect: number): boolean {
  const f = norm([target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]])
  const r = norm([-f[2], 0, f[0]]) // forward x up
  const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]
  const rel: V3 = [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]]
  const z = rel[0] * f[0] + rel[1] * f[1] + rel[2] * f[2]
  if (z <= 0) return false
  const tanV = Math.tan((fov * Math.PI) / 360)
  const x = Math.abs(rel[0] * r[0] + rel[1] * r[1] + rel[2] * r[2]) / z
  const y = Math.abs(rel[0] * u[0] + rel[1] * u[1] + rel[2] * u[2]) / z
  return x <= tanV * aspect + 1e-9 && y <= tanV + 1e-9
}

describe('createLineShotCache', () => {
  it('keeps a shot per line and layout, and forgets them all on clear', () => {
    const c = createLineShotCache()
    expect(lineShotKey('a', 3)).not.toBe(lineShotKey('a', 4))
    expect(lineShotKey('a', 12)).not.toBe(lineShotKey('a1', 2))
    c.put(lineShotKey('a', 3), LINE)
    expect(c.get(lineShotKey('a', 3))).toBe(LINE)
    expect(c.get(lineShotKey('a', 4))).toBeUndefined()
    expect(c.get(lineShotKey('b', 3))).toBeUndefined()
    c.clear()
    expect(c.get(lineShotKey('a', 3))).toBeUndefined()
  })
})

describe('reaim', () => {
  it('at the size the search ran at, puts the camera where the search did: the plain fit, stretched', () => {
    const fitted = fitDistance(LINE.points, LINE.target, LINE.dir, 50, 1.6, FIT.margin, FIT.minDist)
    const shot = reaim(LINE, 1.6, 50, FIT)
    const dist = Math.hypot(shot.pos[0] - LINE.target[0], shot.pos[1] - LINE.target[1], shot.pos[2] - LINE.target[2])
    expect(dist).toBeCloseTo(fitted * 1.15, 9)
    expect(shot.target).toEqual(LINE.target)
    expect(shot.target).not.toBe(LINE.target) // a copy: moving the camera never moves the kept shot
    const along = norm([shot.pos[0] - LINE.target[0], shot.pos[1] - LINE.target[1], shot.pos[2] - LINE.target[2]])
    for (let i = 0; i < 3; i++) expect(along[i]).toBeCloseTo(LINE.dir[i], 12)
  })

  it('keeps both ends of the line and its arch in view at any aspect from 0.5 to 3', () => {
    for (const aspect of [0.5, 0.75, 1, 1.5, 2, 3]) {
      const shot = reaim(LINE, aspect, 50, FIT)
      for (const p of LINE.points) expect(inView(p, shot.pos, shot.target, 50, aspect), `aspect ${aspect}, ${p.join(',')}`).toBe(true)
    }
    // narrower views stand further back
    const d = (a: number): number => { const s = reaim(LINE, a, 50, FIT); return Math.hypot(s.pos[0], s.pos[1] - 4, s.pos[2]) }
    expect(d(0.5)).toBeGreaterThan(d(1.5))
  })

  it('stays within the nearest and furthest the camera may stand', () => {
    expect(Math.hypot(...reaim({ ...LINE, points: [LINE.target] }, 1, 50, FIT).pos.map((v, i) => v - LINE.target[i]) as V3)).toBeCloseTo(FIT.minDist * 1.15, 9)
    const tiny = { ...LINE, points: [LINE.target], stretch: 0.5 }
    expect(Math.hypot(...reaim(tiny, 1, 50, FIT).pos.map((v, i) => v - LINE.target[i]) as V3)).toBeCloseTo(FIT.minDist, 9)
    const far = { ...LINE, points: [[-900, 0, 0], [900, 0, 0]] as V3[] }
    expect(Math.hypot(...reaim(far, 1, 50, FIT).pos.map((v, i) => v - LINE.target[i]) as V3)).toBeCloseTo(FIT.maxDist, 9)
  })
})
