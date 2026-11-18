// The facts both Lumopolis cards state, gathered once: the HTML card (renderer engine cards.ts) and the
// plain-text card an agent reads (main cardText.ts) import these, so the two cannot say different things.
// Pure and ES2020.
import type { Building, WorldDoc, WorldEdge } from './types'

/** The status pill of a building, in words. */
export const BUILD_STATUS_TEXT: Record<Building['status'], string> = {
  verified: 'Built · tests pass', built: 'Built · not yet checked', gap: 'Built · no test results yet', proposed: 'Planned only',
}

/** The built buildings and those of every proposal. */
export const allBuildings = (doc: WorldDoc): Building[] => [...doc.buildings, ...doc.layers.plan.flatMap((p) => p.buildings)]
/** The built edges and those of every proposal. */
export const allEdges = (doc: WorldDoc): WorldEdge[] => [...doc.edges, ...doc.layers.plan.flatMap((p) => p.edges)]

/** A node's name: a building's, an outside part's, else its id. */
export const nodeName = (doc: WorldDoc, id: string): string =>
  allBuildings(doc).find((b) => b.id === id)?.name ?? doc.externals.find((x) => x.id === id)?.name ?? id

/** Whether the project's linked design does not have this built building. */
export const notInDesign = (doc: WorldDoc, id: string): boolean =>
  doc.layers.plan.some((p) => p.reconcile !== undefined && p.reconcile.extra.indexOf(id) >= 0)

/** The process a building runs in: its label when the world names it, else the raw id (may be blank). */
export const runsIn = (doc: WorldDoc, b: Building): string => {
  const proc = doc.processes[b.process]
  return proc ? proc.label : b.process
}
