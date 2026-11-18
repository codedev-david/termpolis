/**
 * Semantic zoom and batched drawing, the parts of it that need no WebGL: which of a building's
 * parts draw at a tier, which may share one draw call, how parts group into batches, and how the
 * pool of batches changes from one frame to the next.
 *
 * A building is drawn either as its floors (each a box with its seam outline) or as one block
 * (a single box with one outline). Every such part keeps its own three.js objects, which stay the
 * pick target and the holder of its look (focus dimming, heat, change pulses write to them); when
 * it may be batched, the objects themselves are not drawn and a shared batch draws them instead:
 * one InstancedMesh per look, which draws each box with its outline (the outline drawn on the
 * box's own faces, so a box and its edges keep the order they had as separate objects).
 */
import type { ZoomTier } from './viewMath'

export type PartKind = 'floor' | 'block'

/**
 * Whether a building's part draws at `tier`. At the 'districts' tier no building draws: each
 * district is one slab (slabsFor). Nearer in, an exploded building always shows its floors; others
 * show their floors from the 'floors' tier in and one block at the 'buildings' tier.
 */
export function partDrawn(kind: PartKind, tier: ZoomTier, exploded: boolean): boolean {
  if (tier === 'districts') return false
  const floors = exploded || tier === 'floors'
  return kind === 'floor' ? floors : !floors
}

/** A district as the slabs need it: its centre (x, y, z) and its platform's radius. */
export interface SlabDistrict { id: string; pos: readonly number[]; radius: number }
/** A building as the slabs need it: where it stands and how tall it is. */
export interface SlabBuilding { id: string; pos: readonly number[]; height: number }
/** One district drawn from far away: a hexagonal slab on its platform, `height` tall. */
export interface Slab { id: string; x: number; y: number; z: number; radius: number; height: number }

/** A slab covers this share of its platform's radius, so the platform's rim still shows round it. */
export const SLAB_INSET = 0.85
/** The lowest a slab stands (an empty district's, or one of low buildings): one floor. */
export const SLAB_MIN_HEIGHT = 3

/**
 * The district a point stands in: the nearest one whose platform contains it (the same rule that
 * gives a building its district's hue), or null outside every platform.
 */
export function districtAt(p: readonly number[], districts: readonly SlabDistrict[]): string | null {
  let best: string | null = null
  let bestD = Infinity
  for (const d of districts) {
    const dist = Math.hypot(p[0] - d.pos[0], p[2] - d.pos[2])
    if (dist <= d.radius && dist < bestD) { best = d.id; bestD = dist }
  }
  return best
}

/** Each building's district (districtAt), for the buildings that stand in one. */
export function districtsOf(buildings: readonly SlabBuilding[], districts: readonly SlabDistrict[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const b of buildings) {
    const d = districtAt(b.pos, districts)
    if (d !== null) out.set(b.id, d)
  }
  return out
}

/**
 * One slab per district, in the districts' order: on the district's platform, SLAB_INSET of its
 * radius, as tall as its buildings are on average (at least SLAB_MIN_HEIGHT).
 */
export function slabsFor(districts: readonly SlabDistrict[], buildings: readonly SlabBuilding[]): Slab[] {
  const of = districtsOf(buildings, districts)
  const sum = new Map<string, { h: number; n: number }>()
  for (const b of buildings) {
    const d = of.get(b.id)
    if (d === undefined) continue
    const s = sum.get(d) ?? { h: 0, n: 0 }
    s.h += b.height
    s.n++
    sum.set(d, s)
  }
  return districts.map((d) => {
    const s = sum.get(d.id)
    const height = Math.max(SLAB_MIN_HEIGHT, s ? s.h / s.n : 0)
    return { id: d.id, x: d.pos[0], y: d.pos[1], z: d.pos[2], radius: d.radius * SLAB_INSET, height }
  })
}

/**
 * The heights of the seams drawn round a slab, one per SLAB_MIN_HEIGHT (a floor) between its foot
 * and its top: from far away a district reads as stacked floors, as its buildings do nearer in.
 */
export function slabSeams(height: number): number[] {
  const out: number[] = []
  for (let y = SLAB_MIN_HEIGHT; y < height - 0.5; y += SLAB_MIN_HEIGHT) out.push(y)
  return out
}

/**
 * How high above its ground a conduit's end sits: on a building's roof, or, at the 'districts'
 * tier, on the top of its district's slab (an end outside every district keeps `own`).
 */
export function endHeight(id: string | undefined, own: number, tier: ZoomTier, districtOf: ReadonlyMap<string, string>, slabHeight: ReadonlyMap<string, number>): number {
  if (tier !== 'districts' || id === undefined) return own
  const d = districtOf.get(id)
  const h = d === undefined ? undefined : slabHeight.get(d)
  return h === undefined ? own : h
}

/** What a click or hover picks. */
export type TierPick = { kind: 'node' | 'edge' | 'district'; id: string }

/**
 * What a pick means at `tier`: at the 'districts' tier a building stands for its district (the slab
 * drawn over it), so the pick resolves to the district; lines, externals and every pick nearer in
 * are left as they are.
 */
export function tierPick(hit: TierPick | null, tier: ZoomTier, districtOf: ReadonlyMap<string, string>): TierPick | null {
  if (!hit || tier !== 'districts' || hit.kind !== 'node') return hit
  const d = districtOf.get(hit.id)
  return d === undefined ? hit : { kind: 'district', id: d }
}

/**
 * Whether a drawn part may go into a shared batch. An exploded building swaps back to its own
 * meshes (its floors move apart and turn), and so does a part whose look moves every frame (the
 * wireframe pulse, the fading pulse): a batch holds looks that stay put.
 */
export function batchable(exploded: boolean, moving: boolean): boolean {
  return !exploded && !moving
}

/** Whether a building's floor labels may show: exploded, or hovered or selected from the 'floors' tier in. */
export function floorLabelsShown(tier: ZoomTier, exploded: boolean, target: boolean): boolean {
  return exploded || (tier === 'floors' && target)
}

/**
 * The tier drawn, given the camera's: a selected building or line, or a focus on parts (search, the
 * tree, a tour step; not a hover), keeps the buildings up. Those are the parts asked for, and a
 * small world frames them from about as far out as its overview, where slabs would stand in for them.
 */
export function heldTier(tier: ZoomTier, holding: boolean): ZoomTier {
  return holding && tier === 'districts' ? 'buildings' : tier
}

/** Whether the ranked building names (nameBudget's) may show: at the 'districts' tier only district names do. */
export function buildingNamesShown(tier: ZoomTier): boolean {
  return tier !== 'districts'
}

/** What a box with its outline looks like, apart from its glow and its outline's colour (those go per instance). */
export interface FillLook { color: number; metalness: number; roughness: number; opacity: number; lineOpacity: number; depthWrite: boolean; fog: boolean }

/** The batch a box joins: parts with the same look share one draw call. */
export function fillKey(l: FillLook): string {
  return `fill|${l.color}|${l.metalness}|${l.roughness}|${l.opacity}|${l.lineOpacity}|${l.depthWrite}|${l.fog}`
}

/** The batch a conduit's moving packet joins: one per shape (`geometry`) and opacity; the colour goes per instance. */
export function packetKey(geometry: string, opacity: number, fog: boolean): string {
  return `packet|${geometry}|${opacity}|${fog}`
}

export interface BatchItem { key: string; depth: number }

/**
 * Groups items into batches by key. Within a batch the items run far first (`depth`, the squared
 * distance from the camera, falling): see-through boxes are then painted back to front, as three.js
 * sorts separate transparent objects. The result is each batch's instance index map: the i-th
 * instance of batch `key` draws item `groups.get(key)[i]`.
 */
export function groupBatches(items: readonly BatchItem[]): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  items.forEach((it, i) => {
    const g = groups.get(it.key)
    if (g) g.push(i)
    else groups.set(it.key, [i])
  })
  for (const g of groups.values()) g.sort((a, b) => items[b].depth - items[a].depth)
  return groups
}

/** The batches to make and to free between the pool this frame starts with and the keys it needs. */
export function poolChanges(have: Iterable<string>, want: Iterable<string>): { add: string[]; drop: string[] } {
  const h = new Set(have)
  const w = new Set(want)
  return { add: [...w].filter((k) => !h.has(k)), drop: [...h].filter((k) => !w.has(k)) }
}

/**
 * Where a batch draws among the other batches (lower first): the packets, then the boxes from the
 * most opaque to the faintest. A focused part's batch so draws before the dimmed parts' batch, whose
 * boxes in front then fade over it, as the separate objects did; drawn the other way round, a faint
 * box in front would hide the focused one behind it (it writes depth).
 */
export function batchRank(kind: 'packet' | 'fill', opacity: number): number {
  return kind === 'packet' ? 0 : 2 - opacity
}

/**
 * The render order of the conduits' lines: after every batch of boxes. The batches all sort at one
 * point (transparentOrder), so a line sorted among them by its own centre could draw before a
 * building behind it and, writing depth, cut a dark slot through it. Drawn after them, a line
 * blends over whatever stands behind it.
 */
export const LINE_ORDER = 1

/** A transparent render item as three.js sorts it (WebGLRenderList). */
export interface SortItem { groupOrder: number; renderOrder: number; z: number; id: number; object: { userData: { batchRank?: number } } }

/**
 * three.js's own back-to-front order for transparent objects, with one addition: batches, which all
 * sit at one point (their bounding spheres are pinned there), draw by their batchRank before falling
 * back on creation order.
 */
export function transparentOrder(a: SortItem, b: SortItem): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder
  if (a.z !== b.z) return b.z - a.z
  const ra = a.object.userData.batchRank
  const rb = b.object.userData.batchRank
  if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb
  return a.id - b.id
}

/** The room a batch keeps for `n` instances: grown in powers of two (at least 16), so a batch is rarely remade. */
export function batchCapacity(n: number, have: number): number {
  if (n <= have) return have
  let c = Math.max(16, have)
  while (c < n) c *= 2
  return c
}
