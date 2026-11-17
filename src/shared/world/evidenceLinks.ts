// Lumopolis evidence links: which parts of the world a piece of cited evidence points at. The answer
// panel opens the first of them and highlights all of them when its evidence chip is clicked.
import type { Claim, Evidence, WorldDoc } from './types'

/** The file a ref names: `src/a.ts:12` and `src/a.ts#fn` both name `src/a.ts`. */
const fileOf = (ref: string): string => ref.replace(/[:#].*$/, '')

const cites = (claims: Claim[], ref: string, file: string): boolean =>
  claims.some((c) => c.evidence.some((e) => e.ref === ref || fileOf(e.ref) === file))

/**
 * The building ids whose members include the file part of `ev.ref`, or whose how, why or claims
 * cite that ref, plus the edge ids whose claims cite it. Buildings come first, in world order.
 */
export function itemsForEvidence(doc: WorldDoc, ev: Evidence): string[] {
  const file = fileOf(ev.ref)
  const buildings = doc.buildings
    .filter((b) => b.members.includes(file) || cites([...b.how, ...b.why, ...b.claims], ev.ref, file))
    .map((b) => b.id)
  const edges = doc.edges.filter((e) => cites([...e.how, ...e.why, ...e.claims], ev.ref, file)).map((e) => e.id)
  return [...buildings, ...edges]
}
