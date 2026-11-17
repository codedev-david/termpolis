// Lumopolis plan versus built: which parts of a linked design (the plan) the compiled code world
// already has. Pure and ES2020 (the renderer imports the stamps and the tag text).
import type { Building, PlanReconcile, WorldDoc } from './types'

export type { PlanReconcile }

/** The card tag on a built building the linked design does not have. */
export const NOT_IN_DESIGN = 'not in the design'

const SUFFIX = /(?:service|api|app)$/

/** Lowercase, letters and digits only, minus one trailing "service", "api" or "app" (never down to nothing). */
export function normalizePartName(name: string): string {
  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  const cut = flat.replace(SUFFIX, '')
  return cut === '' ? flat : cut
}

/** Every path segment of the building's files (its own and its floors'), extension dropped, normalized. */
function segmentsOf(b: Building): Set<string> {
  const out = new Set<string>()
  for (const path of [...b.members, ...b.floors.flatMap((f) => f.members)]) {
    for (const seg of path.split(/[\\/]/)) {
      const n = normalizePartName(seg.replace(/\.[^.]*$/, ''))
      if (n !== '') out.add(n)
    }
  }
  return out
}

/** The tech a building names: its stack and every floor's tech, lower-cased. */
function techOf(b: Building): Set<string> {
  return new Set([...b.stack, ...b.floors.flatMap((f) => f.tech)].map((t) => t.toLowerCase()))
}

/**
 * Whether the built building still falls short of the plan part: a planned file it lacks, a planned
 * floor it has no floor of that name for, or planned tech it does not name. Stateless: it is true for
 * as long as the build differs from the plan, however often the world recompiles.
 */
function unmet(p: Building, b: Building): boolean {
  const files = new Set([...b.members, ...b.floors.flatMap((f) => f.members)])
  if ([...p.members, ...p.floors.flatMap((f) => f.members)].some((m) => !files.has(m))) return true
  const floors = new Set(b.floors.map((f) => normalizePartName(f.name)))
  if (p.floors.some((f) => !floors.has(normalizePartName(f.name)))) return true
  const tech = techOf(b)
  return [...techOf(p)].some((t) => !tech.has(t))
}

const byId = (a: Building, b: Building): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * Pairs plan buildings with built ones in three passes: same id, then the same normalized name, then
 * a built file path with the normalized plan name as one of its segments. Each built building stands
 * for at most one plan building; within a pass the first match wins, in plan id order.
 * `changed` lists the matched built buildings that do not yet meet their plan part (see `unmet`).
 */
export function reconcilePlan(plan: WorldDoc, built: WorldDoc): PlanReconcile {
  const planned = [...plan.buildings].sort(byId)
  const have = [...built.buildings].sort(byId)
  const names = new Map(have.map((b) => [b.id, normalizePartName(b.name)]))
  const segments = new Map(have.map((b) => [b.id, segmentsOf(b)]))
  const matched: Record<string, string> = {}
  const used = new Set<string>()
  const pass = (fits: (p: Building, b: Building) => boolean): void => {
    for (const p of planned) {
      if (matched[p.id] !== undefined) continue
      const hit = have.find((b) => !used.has(b.id) && fits(p, b))
      if (!hit) continue
      matched[p.id] = hit.id
      used.add(hit.id)
    }
  }
  pass((p, b) => p.id === b.id)
  pass((p, b) => {
    const n = normalizePartName(p.name)
    return n !== '' && n === names.get(b.id)
  })
  pass((p, b) => (segments.get(b.id) as Set<string>).has(normalizePartName(p.name)))
  const builtById = new Map(have.map((b) => [b.id, b]))
  const changed = planned.flatMap((p) => {
    const b = builtById.get(matched[p.id])
    return b && unmet(p, b) ? [b.id] : []
  })
  return {
    matched,
    missing: planned.filter((p) => matched[p.id] === undefined).map((p) => p.id),
    extra: have.filter((b) => !used.has(b.id)).map((b) => b.id),
    changed
  }
}

/** What a compiled world remembers of the plan it was reconciled against: its key and save time. */
export function planStamp(plan: WorldDoc | null): string {
  return plan ? `${plan.projectKey}@${plan.generatedAt}` : ''
}

/** The stamp of the linked plan a compiled world carries, or '' when it carries none. */
export function linkedPlanStamp(doc: WorldDoc): string {
  for (const p of doc.layers.plan) {
    if (p.reconcile) return `${p.id}@${p.reconcile.planAt}`
  }
  return ''
}
