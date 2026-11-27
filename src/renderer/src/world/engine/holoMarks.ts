// What the Holotable look draws, as data (look spec §4): every mark is either a data mark, taken from the scene model
// (so from doc fields and nothing else), or one of the named stage marks of §4.3, taken from the layout's extent, the
// tier and the palette. The 2.0 spec's rule #12, extended to every mark; worldFacts.test.ts pins both halves.
// Pure: no Three.js, no clock, no window.
import type { Look, SceneModel, Vec3 } from './sceneModel'
import { foldHue, memberGain, plateColor, type HoloPalette } from './holoPalette'
import { TIER_LOOK, type TierName } from './tierBudget'

/** The closed list of stage marks (look spec §4.3), in drawing order. Nothing else may draw that is not data. */
export const STAGE_MARKS = ['disc', 'discSweep', 'track', 'beams', 'shafts', 'dust', 'vignetteGrain'] as const
export type StageKind = typeof STAGE_MARKS[number]

/** The disc reaches this far past the farthest plate edge (the spike's 1.06). */
export const DISC_SCALE = 1.06
/** The disc of a world with no plates. */
export const DISC_MIN_RADIUS = 10
/** The outside-ring track is a loop of this many segments. */
export const TRACK_SEGMENTS = 256
/** The grade pass's vignette and grain (look spec §3.3), where the tier has a composer and grain. */
const VIGNETTE = 0.5
const GRAIN = 0.03

/** The grade pass's vignette and grain at `tier`: none without a composer, grain only where the tier has it. */
export function gradeOf(tier: TierName): { vignette: number; grain: number } {
  const look = TIER_LOOK[tier]
  return { vignette: look.composer ? VIGNETTE : 0, grain: look.grain ? GRAIN : 0 }
}

export type DataMark =
  | { kind: 'plate'; id: string; pos: Vec3; radius: number; hue: number; color: string; gain: number; members: number }
  | {
    kind: 'slab'; id: string; pos: Vec3; floors: number; height: number; look: Look; color: string
    /** The verified ring's colour, or null when the part is not verified. */
    ring: string | null
    outline: boolean; heat: number; heatColor: string; processShell: string | null
  }
  | { kind: 'conduit'; id: string; from: Vec3; to: Vec3; ctrl: Vec3; width: number; color: string; dashed: boolean; cargo: string }
  | { kind: 'orb'; id: string; pos: Vec3; fog: boolean; color: string }

/** A point on the table, [x, z]. */
export type TablePoint = [number, number]

export type StageMark =
  | { kind: 'disc'; center: TablePoint; radius: number; color: string; arcColor: string; moving: boolean }
  /** The sweep runs only while the world is working (a compile or an Ask); `moving` is whether the tier animates it. */
  | { kind: 'discSweep'; center: TablePoint; radius: number; whileWorking: true; moving: boolean }
  | { kind: 'track'; radius: number; segments: number; color: string }
  | { kind: 'beams'; from: TablePoint; to: TablePoint[]; color: string }
  | { kind: 'shafts'; count: number }
  | { kind: 'dust'; count: number; stars: true }
  | { kind: 'vignetteGrain'; vignette: number; grain: number }

/** The layout's extent: the table's centre and reach round the plates, and the ring the outside orbs sit on. */
export interface LayoutExtent {
  /** The centre of the box round every plate (position ± radius). */
  center: TablePoint
  /** The farthest any plate's edge lies from the centre. */
  reach: number
  /** The farthest an orb lies from the origin (the compiler rings the orbs round it), or null with no orbs. */
  orbRing: number | null
}

/**
 * The extent the stage marks follow. Nothing computed it before this task: the compiler places the orbs on a ring
 * past the farthest building (compile.ts, in main), and the renderer only read positions. Defined here as the
 * spike's table (core.js) measures it.
 */
export function layoutExtent(scene: Pick<SceneModel, 'districts' | 'orbs'>): LayoutExtent {
  let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const d of scene.districts) {
    minX = Math.min(minX, d.pos[0] - d.radius)
    maxX = Math.max(maxX, d.pos[0] + d.radius)
    minZ = Math.min(minZ, d.pos[2] - d.radius)
    maxZ = Math.max(maxZ, d.pos[2] + d.radius)
  }
  const center: TablePoint = scene.districts.length > 0 ? [(minX + maxX) / 2, (minZ + maxZ) / 2] : [0, 0]
  let reach = 0
  for (const d of scene.districts) reach = Math.max(reach, Math.hypot(d.pos[0] - center[0], d.pos[2] - center[1]) + d.radius)
  let orbRing: number | null = null
  for (const o of scene.orbs) orbRing = Math.max(orbRing ?? 0, Math.hypot(o.pos[0], o.pos[2]))
  return { center, reach, orbRing }
}

/** Every mark of `scene` in `palette` at `tier` (High when none is given): the data marks, then the stage marks. */
export function holoMarks(scene: SceneModel, palette: HoloPalette, tier: TierName = 'high'): { data: DataMark[]; stage: StageMark[] } {
  const data: DataMark[] = [
    ...scene.districts.map((d): DataMark => ({
      kind: 'plate', id: d.id, pos: d.pos, radius: d.radius, hue: foldHue(d.hue), color: plateColor(d.hue), gain: memberGain(d.members), members: d.members,
    })),
    ...scene.buildings.map((b): DataMark => ({
      kind: 'slab', id: b.id, pos: b.pos, floors: b.floors, height: b.height, look: b.look,
      color: b.look === 'amber' ? palette.attention : palette.holo, ring: b.ring ? palette.seal : null,
      outline: b.outline, heat: b.heat, heatColor: palette.heat, processShell: b.processShell ?? null,
    })),
    // A line keeps its cargo colour as the doc gives it: cargo colours are data, and the legend shows them as they are.
    ...scene.conduits.map((c): DataMark => ({ kind: 'conduit', id: c.id, from: c.from, to: c.to, ctrl: c.ctrl, width: c.width, color: c.color, dashed: c.dashed, cargo: c.cargo })),
    ...scene.orbs.map((o): DataMark => ({ kind: 'orb', id: o.id, pos: o.pos, fog: o.fog, color: palette.orb })),
  ]

  return { data, stage: stageMarks(scene, palette, tier) }
}

/**
 * The stage marks alone of `scene` in `palette` at `tier` (High when none is given), in drawing order: what the stage
 * is built and fitted from (holoStage), without the data marks. They read only the plates and the orbs.
 */
export function stageMarks(scene: Pick<SceneModel, 'districts' | 'orbs'>, palette: HoloPalette, tier: TierName = 'high'): StageMark[] {
  const look = TIER_LOOK[tier]
  const extent = layoutExtent(scene)
  const radius = scene.districts.length > 0 ? extent.reach * DISC_SCALE : DISC_MIN_RADIUS
  const stage: StageMark[] = [
    { kind: 'disc', center: extent.center, radius, color: palette.holo, arcColor: palette.attention, moving: look.discMoving },
    { kind: 'discSweep', center: extent.center, radius, whileWorking: true, moving: look.scanLinesMoving },
  ]
  if (extent.orbRing !== null) stage.push({ kind: 'track', radius: extent.orbRing, segments: TRACK_SEGMENTS, color: palette.holo })
  // A beam stands on each plate: the plates' positions, which the layout gives; no data of their own.
  if (look.beams) stage.push({ kind: 'beams', from: extent.center, to: scene.districts.map((d): TablePoint => [d.pos[0], d.pos[2]]), color: palette.holo })
  stage.push(
    { kind: 'shafts', count: look.shafts },
    { kind: 'dust', count: look.dust, stars: true },
    { kind: 'vignetteGrain', ...gradeOf(tier) },
  )
  return stage
}
