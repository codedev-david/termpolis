// Lumopolis linked design overlay: compile lays a project's linked design (a design world, the plan)
// over the freshly compiled code world as one Proposal in layers.plan. Plan buildings the code already
// has (reconcilePlan) are not drawn again: the built building stands for them. The missing ones
// become proposed buildings, placed inside the code district of the same name when there is one,
// else on a ring just outside the districts. The result is validated; an overlay that would not
// validate is dropped (the plain world is saved instead), so a bad plan never costs the stored world.
import type { Building, Proposal, WorldDoc, WorldEdge } from '../../shared/world/types'
import { normalizePartName, reconcilePlan } from '../../shared/world/reconcile'
import { validateWorld } from '../../shared/world/validate'
import { districtRadius, placeBuilding } from './layout'

export const LINKED_DESIGN_TITLE = 'Linked design'
/** How far outside the farthest district centre a planned part with no district sits. */
export const PLAN_RING_GAP = 20

type Pos = [number, number, number]
const round2 = (v: number): number => Math.round(v * 100) / 100
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** Ids of the buildings a previous compile overlaid from a linked design: their positions are kept. */
function plannedBefore(previous: WorldDoc | null): Set<string> {
  const out = new Set<string>()
  for (const p of previous ? previous.layers.plan : []) {
    if (p.reconcile) for (const b of p.buildings) out.add(b.id)
  }
  return out
}

export function overlayPlan(doc: WorldDoc, plan: WorldDoc, previous: WorldDoc | null): WorldDoc {
  const rec = reconcilePlan(plan, doc)
  const used = new Set([...doc.districts, ...doc.buildings, ...doc.edges, ...doc.externals].map((x) => x.id))
  const free = (want: string): string => {
    let id = want
    for (let n = 1; used.has(id); n++) id = n === 1 ? `${want}-plan` : `${want}-plan-${n}`
    used.add(id)
    return id
  }
  const idFor = new Map(Object.entries(rec.matched))
  const planById = new Map(plan.buildings.map((b) => [b.id, b]))
  for (const pid of rec.missing) idFor.set(pid, free(pid))

  // A plan district maps onto the code district with the same normalized name, if any.
  const districtFor = new Map<string, string>()
  for (const pd of plan.districts) {
    const n = normalizePartName(pd.name)
    const hit = n === '' ? undefined : doc.districts.find((d) => normalizePartName(d.name) === n)
    if (hit) districtFor.set(pd.id, hit.id)
  }

  const positions: Record<string, Pos> = { ...doc.layout.positions }
  const glossary = { ...doc.glossary }
  const cargo = { ...doc.cargo }
  const kept = plannedBefore(previous)
  const buildings: Building[] = []
  const outside: string[] = []
  for (const pid of rec.missing) {
    const pb = planById.get(pid) as Building
    const id = idFor.get(pid) as string
    const districtId = districtFor.get(pb.districtId) ?? ''
    buildings.push({ ...pb, id, districtId, process: '', status: 'proposed' })
    for (const t of [...pb.stack, ...pb.floors.flatMap((f) => f.tech)]) {
      if (!has(glossary, t)) glossary[t] = has(plan.glossary, t) ? plan.glossary[t] : ''
    }
    const before = previous?.layout.positions[id]
    if (before && kept.has(id)) positions[id] = before
    else if (districtId === '') outside.push(id)
    else {
      const siblings = [...doc.buildings, ...buildings].filter((b) => b.districtId === districtId && b.id !== id && positions[b.id])
      const [cx, , cz] = positions[districtId]
      const taken = siblings.map((b): [number, number] => [positions[b.id][0], positions[b.id][2]])
      const p = placeBuilding(id, doc.layout.seed, cx, cz, districtRadius(siblings.length + 1), taken)
      positions[id] = [p[0], 0, p[1]]
    }
  }
  const far = doc.districts.reduce((m, d) => Math.max(m, Math.hypot(positions[d.id][0], positions[d.id][2])), 0)
  outside.forEach((id, i) => {
    const angle = (2 * Math.PI * (i + 0.5)) / outside.length
    positions[id] = [round2((far + PLAN_RING_GAP) * Math.cos(angle)), 0, round2((far + PLAN_RING_GAP) * Math.sin(angle))]
  })

  const builtLinks = new Set(doc.edges.map((e) => `${e.from}\n${e.to}`))
  const edges: WorldEdge[] = []
  for (const e of plan.edges) {
    const from = idFor.get(e.from)
    const to = idFor.get(e.to)
    if (!from || !to) continue
    // A planned connection the code already makes between two built parts is not drawn twice.
    if (rec.matched[e.from] !== undefined && rec.matched[e.to] !== undefined && builtLinks.has(`${from}\n${to}`)) continue
    const def = plan.cargo[e.cargo]
    if (def && !has(cargo, e.cargo)) cargo[e.cargo] = def
    edges.push({ ...e, id: free(e.id), from, to })
  }

  const proposal: Proposal = {
    id: plan.projectKey, title: LINKED_DESIGN_TITLE, summary: [], buildings, edges,
    reconcile: { ...rec, planAt: plan.generatedAt }
  }
  const out: WorldDoc = {
    ...doc, glossary, cargo,
    layout: { ...doc.layout, positions },
    layers: { ...doc.layers, plan: [...doc.layers.plan, proposal] }
  }
  return validateWorld(out).ok ? out : doc
}
