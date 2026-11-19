// Lumopolis linked design overlay: compile lays a project's linked design (a design world, the plan)
// over the freshly compiled code world as one Proposal in layers.plan. Plan buildings the code already
// has (reconcilePlan) are not drawn again: the built building stands for them, in its wireframe's
// place when it was built from the design (holdPlannedSpots). The missing ones
// become proposed buildings, placed inside the code district of the same name when there is one,
// else on a ring just outside the districts. The result is validated; an overlay that would not
// validate is dropped (the plain world is saved instead), so a bad plan never costs the stored world.
import type { Building, PlanReconcile, Proposal, WorldDoc, WorldEdge } from '../../shared/world/types'
import { normalizePartName, reconcilePlan } from '../../shared/world/reconcile'
import { validateWorld } from '../../shared/world/validate'
import { MIN_SIBLING_GAP, MOVED_TOLERANCE, SLOT_CLEARANCE, clear, districtRadius, placeBuilding } from './layout'

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

/**
 * A part built from the design takes the place its wireframe held, so the wireframe at P rises into
 * the building at P (spec 5.12), and keeps that place on later compiles while it stays in the same
 * district (the layout alone would move one that stands off its district's platform), and when its
 * id changes with its files. A building that already stood when it matched keeps its own spot. Re-layout clears the previous positions,
 * so it lays matched parts out like any other.
 * A spot is taken only when it lies on the building's own district slab, by the test the layout keeps a
 * position with (districtRadius + MOVED_TOLERANCE), and is clear of every sibling (MIN_SIBLING_GAP);
 * otherwise the layout's spot stands. A wireframe on the ring, or in another district, so never pulls a
 * building off its slab, and a sibling the layout put on the spot never shares it. Only the previous
 * proposal of the same design (`key`) lends spots.
 * A part whose wireframe stood on the ring usually lands in a district new this compile (its folder had none),
 * which the layout put on a free slot elsewhere. When that district holds only the part, the district moves so
 * the part stands on the wireframe's spot, its slab under it, provided the slab stays clear of every other
 * district (SLOT_CLEARANCE, and the two radii plus MIN_SIBLING_GAP). Later compiles keep it there: the layout
 * keeps a district's place. A district that stood before never moves.
 */
function holdPlannedSpots(doc: WorldDoc, key: string, matched: Record<string, string>, previous: WorldDoc | null, positions: Record<string, Pos>): void {
  const link = previous?.layers.plan.find((p) => p.reconcile !== undefined && p.id === key)
  const was = link?.reconcile
  const prevPos = previous ? previous.layout.positions : {}
  // A linked proposal's buildings are its missing plan parts, in order (see overlayPlan).
  const wireAt = new Map<string, Pos | undefined>()
  link?.buildings.forEach((b, i) => wireAt.set((was as PlanReconcile).missing[i], prevPos[b.id]))
  const prevDistrict = new Map((previous ? previous.buildings : []).map((b) => [b.id, b.districtId]))
  const stoodBefore = new Set((previous ? previous.districts : []).map((d) => d.id))
  const districtOf = new Map(doc.buildings.map((b) => [b.id, b.districtId]))
  const fits = (bid: string, p: Pos): boolean => {
    const d = districtOf.get(bid) as string
    const c = positions[d]
    if (c === undefined) return false
    // The layout places every building of a placed district, so each member has a position.
    const members = doc.buildings.filter((b) => b.districtId === d)
    const others = members.filter((b) => b.id !== bid).map((b): [number, number] => [positions[b.id][0], positions[b.id][2]])
    return Math.hypot(p[0] - c[0], p[2] - c[2]) <= districtRadius(members.length) + MOVED_TOLERANCE && clear([p[0], p[2]], others)
  }
  const size = (d: string): number => doc.buildings.filter((b) => b.districtId === d).length
  const moveDistrict = (bid: string, at: Pos): void => {
    const d = districtOf.get(bid) as string
    const c = positions[d]
    if (c === undefined || stoodBefore.has(d) || size(d) !== 1) return
    const b = positions[bid]
    const to: Pos = [round2(c[0] + at[0] - b[0]), 0, round2(c[2] + at[2] - b[2])]
    const room = (o: string): number => Math.max(SLOT_CLEARANCE, districtRadius(size(o)) + districtRadius(1) + MIN_SIBLING_GAP)
    if (!doc.districts.every((o) => o.id === d || Math.hypot(positions[o.id][0] - to[0], positions[o.id][2] - to[2]) >= room(o.id))) return
    positions[d] = to
    positions[bid] = at
  }
  for (const [pid, bid] of Object.entries(matched)) {
    const at = wireAt.get(pid)
    // The building that stood for this part last time: the same one, or one whose id changed with its files
    // (its old id is gone from the code). Never one that still stands, or the two would share a spot.
    const before = was?.matched[pid] ?? bid
    const held = prevPos[before]
    const fresh = prevDistrict.has(bid) ? undefined : at
    const spot = fresh ?? ((before === bid || !districtOf.has(before)) && prevDistrict.get(before) === districtOf.get(bid) ? held : undefined)
    if (spot && fits(bid, spot)) positions[bid] = spot
    else if (fresh) moveDistrict(bid, fresh)
  }
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
  holdPlannedSpots(doc, plan.projectKey, rec.matched, previous, positions)
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

  // Parts the design takes away (its removePart changes), as the built buildings that stand for them.
  const removes = [...new Set(plan.layers.plan.flatMap((p) => p.removes ?? []))]
    .map((id) => rec.matched[id])
    .filter((id): id is string => id !== undefined)
  const proposal: Proposal = {
    id: plan.projectKey, title: LINKED_DESIGN_TITLE, summary: [], buildings, edges,
    reconcile: { ...rec, planAt: plan.generatedAt },
    ...(removes.length > 0 ? { removes } : {})
  }
  const out: WorldDoc = {
    ...doc, glossary, cargo,
    layout: { ...doc.layout, positions },
    layers: { ...doc.layers, plan: [...doc.layers.plan, proposal] }
  }
  return validateWorld(out).ok ? out : doc
}
