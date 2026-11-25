// Lumopolis "watch it grow": what changed between two worlds of one project, so the viewer can
// raise new parts, pulse changed ones, fade removed ones and say so in a short toast.
// Pure and ES2020 (the renderer imports it).
import type { Building, PlanReconcile, WorldDoc } from './types'

export interface WorldDiff {
  /** Building ids in next that prev did not have (next's order). */
  added: string[]
  /** Building ids in prev that next does not have (prev's order). */
  removed: string[]
  /** Same id, but a different members list, floors or status (next's order). */
  changed: string[]
  /** Built building ids that now stand for a plan part prev's linked design listed as missing. */
  turnedSolid: string[]
}

/** At most this many parts rise per load; the rest simply appear. */
export const RISE_CAP = 20

/** The reconcile of the doc's linked design (the proposal compile appends), if it carries one. */
function linkedReconcile(doc: WorldDoc): PlanReconcile | undefined {
  return doc.layers.plan.find((p) => p.reconcile !== undefined)?.reconcile
}

/** What a building looks like for "changed": its members, its floors and its status. */
const shape = (b: Building): string => JSON.stringify([b.members, b.floors, b.status])

/** Compares `doc.buildings` only. A null prev means everything in next is added. */
export function diffWorlds(prev: WorldDoc | null, next: WorldDoc): WorldDiff {
  if (prev === null) return { added: next.buildings.map((b) => b.id), removed: [], changed: [], turnedSolid: [] }
  const before = new Map(prev.buildings.map((b) => [b.id, b]))
  const after = new Set(next.buildings.map((b) => b.id))
  const added: string[] = []
  const changed: string[] = []
  for (const b of next.buildings) {
    const old = before.get(b.id)
    if (!old) added.push(b.id)
    else if (shape(old) !== shape(b)) changed.push(b.id)
  }
  const removed = prev.buildings.filter((b) => !after.has(b.id)).map((b) => b.id)
  const turnedSolid: string[] = []
  const wasMissing = new Set(linkedReconcile(prev)?.missing ?? [])
  const now = linkedReconcile(next)
  for (const [planId, builtId] of Object.entries(now?.matched ?? {})) {
    if (wasMissing.has(planId) && after.has(builtId) && !turnedSolid.includes(builtId)) turnedSolid.push(builtId)
  }
  return { added, removed, changed, turnedSolid }
}

/** Where the parts are and what they hold: everything of a world but its test status (statuses, claims) and names. */
const partsOf = (d: WorldDoc): string =>
  JSON.stringify([
    d.projectKey,
    d.layout,
    d.districts.map((x) => [x.id, x.members]),
    d.buildings.map((b) => [b.id, b.districtId, b.members, b.floors]),
    d.edges.map((e) => [e.id, e.from, e.to]),
    d.externals.map((x) => x.id)
  ])

/**
 * The same parts in the same places (WP4b fix round 1, M6): only test status (and so the statuses and claims) can
 * differ. A world CI's late answer recompiled is one, and the viewer restyles it in place rather than loading it.
 */
export function sameParts(prev: WorldDoc, next: WorldDoc): boolean {
  return partsOf(prev) === partsOf(next)
}

/** The parts that rise: added and turned-solid ids, each once, at most RISE_CAP of them. */
export function riseIds(diff: WorldDiff): string[] {
  return uniqueParts(diff).slice(0, RISE_CAP)
}

function uniqueParts(diff: WorldDiff): string[] {
  return Array.from(new Set([...diff.added, ...diff.turnedSolid]))
}

/** The toast text, e.g. "+3 parts, 2 changed". Zero counts are left out; an empty diff gives "". */
export function diffSummary(diff: WorldDiff): string {
  const parts = uniqueParts(diff).length
  const pieces: string[] = []
  if (parts > 0) pieces.push(`+${parts} ${parts === 1 ? 'part' : 'parts'}`)
  if (diff.changed.length > 0) pieces.push(`${diff.changed.length} changed`)
  if (diff.removed.length > 0) pieces.push(`${diff.removed.length} removed`)
  return pieces.join(', ')
}
