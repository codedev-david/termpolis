// The facts both Lumopolis cards state, gathered once: the HTML card (renderer engine cards.ts) and the
// plain-text card an agent reads (main cardText.ts) import these, so the two cannot say different things.
// Pure and ES2020.
import type { Building, Evidence, WorldDoc, WorldEdge } from './types'
import { edgeActions, edgeItems } from './edgeText'

/** The status pill of a building, in words. */
export const BUILD_STATUS_TEXT: Record<Building['status'], string> = {
  verified: 'Built · tests pass', built: 'Built · not yet checked', gap: 'Built · no test results yet', proposed: 'Planned only',
}

/** One piece of evidence in words: its kind and where it points, and for a test where its result came from (a test
 *  report, an agent transcript or CI), so a pass read off a transcript never looks like one from a report. */
export const evidenceText = (e: Evidence): string =>
  e.kind === 'test' && typeof e.excerpt === 'string' && e.excerpt !== '' ? `${e.kind} ${e.ref} (${e.excerpt})` : `${e.kind} ${e.ref}`

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

/** What a planned line no model has described says under "How it travels": it has no code to read. */
export const NOT_DESCRIBED = 'Not described yet.'

/** What a line no model has described says under "How it travels": for a built line, what the code alone shows, who
 *  reaches whom and through what (the identifiers themselves are listed under "What it carries"); a planned line
 *  (a proposal's) has no code, so it says only that it is not described. */
export function edgeFromCode(doc: WorldDoc, e: WorldEdge): string {
  if (!doc.edges.some((x) => x.id === e.id)) return NOT_DESCRIBED
  const from = nodeName(doc, e.from)
  const to = nodeName(doc, e.to)
  const items = edgeItems(e.label)
  if (items) {
    const acts = edgeActions(items)
    const said = acts.length === 1 ? acts[0] : `${acts.slice(0, -1).join(', ')} and ${acts[acts.length - 1]}`
    return `From the code: ${from} reaches ${to} this way: it ${said}.`
  }
  if (e.label.trim() === 'imports') return `From the code: ${from} imports code from ${to}.`
  return `From the code: ${from} reaches ${to}${e.tech.length ? ` through ${e.tech.join(', ')}` : ''}.`
}

/** What a line no model has described says under "Why". Nobody read the code for a reason (the line may be past the
 *  labelling cap, or not reached yet), so it claims nothing about the code beyond what code can show. */
export const NO_WHY_YET = 'Not described yet; the code alone does not say why.'
