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
 * Whether a building's part draws at `tier`. An exploded building always shows its floors; others
 * show their floors from the 'floors' tier in and one block further out.
 */
export function partDrawn(kind: PartKind, tier: ZoomTier, exploded: boolean): boolean {
  const floors = exploded || tier === 'floors'
  return kind === 'floor' ? floors : !floors
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
