// Focus rules: which buildings and edges light up around a selection.
import type { WorldDoc } from '../../../../shared/world/types'

/** Tubes in focus never go brighter than this (the prototype's bloom fix). */
export const FOCUS_CAP = 0.62
const FOCUS_BOOST = 1.9
const DIM_FACTOR = 0.06

/**
 * The selection plus everything one connection away. For a building or external: its own id,
 * the ids at the other end of each incident edge, and those edges. For an edge: the edge and its
 * two endpoints. An unknown id yields just itself.
 */
export function neighbours(doc: WorldDoc, id: string): { ids: Set<string>; edgeIds: Set<string> } {
  const ids = new Set<string>([id])
  const edgeIds = new Set<string>()
  for (const e of doc.edges) {
    if (e.id === id) {
      edgeIds.add(e.id)
      ids.add(e.from)
      ids.add(e.to)
    } else if (e.from === id || e.to === id) {
      edgeIds.add(e.id)
      ids.add(e.from)
      ids.add(e.to)
    }
  }
  return { ids, edgeIds }
}

/** Opacity of a tube: boosted but capped at 0.62 in focus, nearly hidden out of focus. */
export function focusOpacity(baseOpacity: number, inFocus: boolean): number {
  return inFocus ? Math.min(FOCUS_CAP, baseOpacity * FOCUS_BOOST) : baseOpacity * DIM_FACTOR
}
