/**
 * What a district's slab shows of its buildings from far away (semantic zoom). At the districts
 * tier the buildings hide under their slabs, so the signals the spec keeps visible (heat, planned
 * and changed parts, parts a proposal takes away, and fog) must reach the slab: its hottest
 * building's heat, an outline when any building carries one (a changed part) or is planned (a
 * wireframe), and the fading or fog look only when every building in it has that look (one solid
 * building among them is still a solid district).
 */
import type { Look } from './sceneModel'

/** A building as its slab's signals need it. */
export interface SignalBuilding { id: string; look: Look; outline: boolean; heat: number }

/** What one district's slab shows. `hot`: its heat is above 0. */
export interface SlabSignals { id: string; heat: number; hot: boolean; outline: boolean; fading: boolean; fog: boolean }

/** The look a slab is drawn with: fading wins over fog, as it does on a building. */
export type SlabLook = 'solid' | 'fog' | 'fading'

/** Each slab's signals, in `slabIds` order, from the buildings `districtOf` places in it. */
export function slabSignals(slabIds: readonly string[], buildings: readonly SignalBuilding[], districtOf: ReadonlyMap<string, string>): SlabSignals[] {
  const members = new Map<string, SignalBuilding[]>()
  for (const b of buildings) {
    const d = districtOf.get(b.id)
    if (d === undefined) continue
    const list = members.get(d) ?? []
    list.push(b)
    members.set(d, list)
  }
  return slabIds.map((id) => {
    const ms = members.get(id) ?? []
    const heat = ms.reduce((h, b) => Math.max(h, b.heat), 0)
    const all = (look: Look): boolean => ms.length > 0 && ms.every((b) => b.look === look)
    return { id, heat, hot: heat > 0, outline: ms.some((b) => b.outline || b.look === 'wire'), fading: all('fading'), fog: all('fog') }
  })
}

/** The look `s` draws its slab with. */
export function slabLook(s: SlabSignals): SlabLook {
  return s.fading ? 'fading' : s.fog ? 'fog' : 'solid'
}
