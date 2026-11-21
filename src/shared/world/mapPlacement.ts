// Where the flat maps stand each thing of a world: the 2D map (renderer engine fallback2d.ts) and the documentation's
// map of the areas (documentationHtml.ts) both read this, so the two never disagree about the city's arrangement.
// Pure, ES2020 and deterministic.
import type { WorldDoc } from './types'

/** A point on the flat map: the layout's x, and its z drawn downward. */
export type MapPoint = [number, number]

export interface MapPlacement {
  /** Each part and outside system by id. */
  at: Map<string, MapPoint>
  /** Each district, in the world's order. */
  districts: MapPoint[]
}

/**
 * A part or outside system stands at its layout x and z; one with no position takes the next slot of a six-wide grid
 * below the city, parts first, then outside systems. A district stands at its own position, else at the centre of its
 * parts, else at the origin.
 */
export function placeOnMap(doc: WorldDoc): MapPlacement {
  let slot = 0
  const at = new Map<string, MapPoint>()
  const place = (id: string): void => {
    const p = doc.layout.positions[id]
    at.set(id, p ? [p[0], p[2]] : [(slot % 6) * 8, 14 + Math.floor(slot++ / 6) * 8])
  }
  for (const b of doc.buildings) place(b.id)
  for (const x of doc.externals) place(x.id)
  const districts = doc.districts.map((d): MapPoint => {
    const own = doc.layout.positions[d.id]
    if (own) return [own[0], own[2]]
    const mine = doc.buildings.filter((b) => b.districtId === d.id).map((b) => at.get(b.id) as MapPoint)
    return mine.length ? [mine.reduce((s, p) => s + p[0], 0) / mine.length, mine.reduce((s, p) => s + p[1], 0) / mine.length] : [0, 0]
  })
  return { at, districts }
}
