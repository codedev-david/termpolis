// Lumopolis: stable layout. Every district centre and building gets an [x, y, z] position, and a
// position once given never changes, so the user's mental map of the city survives rebuilds.
// Pure and deterministic: no fs, no Electron.
//
// - Districts sit on a hex lattice (DISTRICT_SPACING apart) filled in spiral order from the origin.
//   A new district takes the first slot with no kept or newly placed district centre within
//   SLOT_CLEARANCE.
// - Buildings sit on a phyllotaxis (sunflower) spiral around their district centre. District radius
//   is BUILDING_STEP * sqrt(n) + RADIUS_MARGIN for n buildings, which holds every spiral spot up to
//   index n + 2*sqrt(n) (the spiral spot i is at BUILDING_STEP * sqrt(i + 0.5)). With the 60-building
//   cap, the worst two-district split (30/30) sums to about 67, under DISTRICT_SPACING (70), so
//   neighbouring districts never overlap.
// - A kept building position farther than districtRadius(current) + MOVED_TOLERANCE from its current
//   district's centre is treated as new and placed fresh ("inside its district" outranks "never
//   move"). This covers a building that moved to another district, or whose district was removed.
// - A building whose districtId matches no district is skipped (no position).
// - A new building tries spiral indices 0..k (all inside the radius), taking the first spot that is
//   at least MIN_SIBLING_GAP from every sibling. If none is clear, it falls back to expanding rings
//   around the centre, which always ends with a clear spot (it may lie just outside the radius).
// - Randomness: mulberry32 seeded by seed XOR hash(id), so only a building's spiral rotation is
//   random and adding a building never shifts another's draws.
import type { WorldDoc } from '../../shared/world/types'
import type { Grouping } from './group'

type Layout = WorldDoc['layout']
type Pos = [number, number, number]

export const DEFAULT_SEED = 1337
export const DISTRICT_SPACING = 70
export const SLOT_CLEARANCE = 35
export const MIN_SIBLING_GAP = 6
export const BUILDING_STEP = 5
export const RADIUS_MARGIN = 6
export const MOVED_TOLERANCE = 6
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

const cmp = (a: string, b: string): number => Number(a > b) - Number(a < b)
const round2 = (v: number): number => Math.round(v * 100) / 100

function hashId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Radius of a district holding n buildings. */
export function districtRadius(n: number): number {
  return BUILDING_STEP * Math.sqrt(n) + RADIUS_MARGIN
}

const HEX_DIRS: readonly (readonly [number, number])[] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]

/** The k-th hex slot in spiral order (0 = origin, then ring 1, ring 2, ...), as x/z. */
function hexSlot(k: number): [number, number] {
  if (k === 0) return [0, 0]
  let ring = 1
  let rest = k - 1
  while (rest >= ring * 6) {
    rest -= ring * 6
    ring++
  }
  let q = -ring
  let r = ring
  const side = Math.floor(rest / ring)
  const step = rest % ring
  for (let s = 0; s < side; s++) {
    q += HEX_DIRS[s][0] * ring
    r += HEX_DIRS[s][1] * ring
  }
  q += HEX_DIRS[side][0] * step
  r += HEX_DIRS[side][1] * step
  return [round2(DISTRICT_SPACING * (q + r / 2)), round2(DISTRICT_SPACING * (Math.sqrt(3) / 2) * r)]
}

/** Spiral spot i around (cx, cz), rotated by one draw from a PRNG seeded per call by seed and id (a per-call hash, so adding a building shifts no other draw). */
export function spiralSpot(id: string, seed: number, cx: number, cz: number, i: number): [number, number] {
  const rotation = mulberry32((seed ^ hashId(id)) >>> 0)() * Math.PI * 2
  const rad = BUILDING_STEP * Math.sqrt(i + 0.5)
  const ang = rotation + i * GOLDEN_ANGLE
  return [round2(cx + rad * Math.cos(ang)), round2(cz + rad * Math.sin(ang))]
}

const clear = (p: [number, number], taken: readonly [number, number][]): boolean =>
  taken.every((t) => Math.hypot(p[0] - t[0], p[1] - t[1]) >= MIN_SIBLING_GAP)

/** Position for a new building: first clear spiral spot inside the radius, else the first clear ring spot. */
export function placeBuilding(
  id: string, seed: number, cx: number, cz: number, radius: number, taken: readonly [number, number][],
): [number, number] {
  const attempts = Math.floor((radius / BUILDING_STEP) ** 2 - 0.5) + 1
  for (let i = 0; i < attempts; i++) {
    const p = spiralSpot(id, seed, cx, cz, i)
    if (clear(p, taken)) return p
  }
  for (let rho = 0; ; rho += MIN_SIBLING_GAP) {
    const count = Math.max(1, Math.floor((2 * Math.PI * rho) / MIN_SIBLING_GAP))
    for (let k = 0; k < count; k++) {
      const a = (2 * Math.PI * k) / count
      const p: [number, number] = [round2(cx + rho * Math.cos(a)), round2(cz + rho * Math.sin(a))]
      if (clear(p, taken)) return p
    }
  }
}

export function layoutWorld(g: Grouping, previous: Layout | null, seed?: number): Layout {
  const used = seed ?? previous?.seed ?? DEFAULT_SEED
  const prev = previous?.positions ?? {}
  const positions: Record<string, Pos> = {}

  const districts = [...g.districts].sort((a, b) => cmp(a.id, b.id))
  const centres: [number, number][] = []
  for (const d of districts) {
    if (prev[d.id]) {
      positions[d.id] = prev[d.id]
      centres.push([prev[d.id][0], prev[d.id][2]])
    }
  }
  let slot = 0
  for (const d of districts) {
    if (positions[d.id]) continue
    let s = hexSlot(slot)
    while (centres.some((c) => Math.hypot(c[0] - s[0], c[1] - s[1]) < SLOT_CLEARANCE)) s = hexSlot(++slot)
    centres.push(s)
    positions[d.id] = [s[0], 0, s[1]]
  }

  const byDistrict = new Map<string, string[]>()
  const known = new Set(districts.map((d) => d.id))
  for (const b of [...g.buildings].sort((a, c) => cmp(a.id, c.id))) {
    if (!known.has(b.districtId)) continue // unknown district: nowhere to put it
    byDistrict.set(b.districtId, [...(byDistrict.get(b.districtId) ?? []), b.id])
  }
  for (const d of districts) {
    const ids = byDistrict.get(d.id) ?? []
    const taken: [number, number][] = []
    const [cx, , cz] = positions[d.id]
    const radius = districtRadius(ids.length)
    for (const id of ids) {
      if (prev[id] && Math.hypot(prev[id][0] - cx, prev[id][2] - cz) <= radius + MOVED_TOLERANCE) {
        positions[id] = prev[id]
        taken.push([prev[id][0], prev[id][2]])
      }
    }
    for (const id of ids) {
      if (positions[id]) continue
      const p = placeBuilding(id, used, cx, cz, radius, taken)
      taken.push(p)
      positions[id] = [p[0], 0, p[1]]
    }
  }
  return { seed: used, positions }
}
