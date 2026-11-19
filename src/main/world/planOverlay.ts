// Lumopolis linked design overlay: compile lays a project's linked design (a design world, the plan)
// over the freshly compiled code world as one Proposal in layers.plan. Plan buildings the code already
// has (reconcilePlan) are not drawn again: the built building stands for them, in its wireframe's
// place when it was built from the design (holdPlannedSpots). The missing ones
// become proposed buildings, placed inside the code district of the same name when there is one,
// else on a ring just outside the districts. The result is validated; an overlay that would not
// validate is dropped (the plain world is saved instead), so a bad plan never costs the stored world.
import type { Building, PlanReconcile, Proposal, WorldDoc, WorldEdge } from '../../shared/world/types'
import { markTwoWay } from '../../shared/world/cardFacts'
import { normalizePartName, reconcilePlan } from '../../shared/world/reconcile'
import { validateWorld } from '../../shared/world/validate'
import { MIN_SIBLING_GAP, MOVED_TOLERANCE, SLOT_CLEARANCE, clear, districtRadius, placeBuilding } from './layout'

export const LINKED_DESIGN_TITLE = 'Linked design'
/**
 * The least distance from the farthest district centre to the ring of planned parts with no district.
 * The ring is set at least one slab's room out (slabRoom), so the one-building district a ring part is
 * later built into can stand centred on its wireframe, clear of every district.
 */
export const PLAN_RING_GAP = SLOT_CLEARANCE

type Pos = [number, number, number]
/** How far a one-building district's centre stands from a district of `n` buildings: both slabs and a gap, and never nearer than a layout slot. */
const slabRoom = (n: number): number => Math.max(SLOT_CLEARANCE, districtRadius(n) + districtRadius(1) + MIN_SIBLING_GAP)
/** How far a one-building district's centre stands from a wireframe still waiting to be built: off its slab by a sibling gap. */
const WIRE_ROOM = districtRadius(1) + MIN_SIBLING_GAP
const sizeOf = (doc: WorldDoc, d: string): number => doc.buildings.filter((b) => b.districtId === d).length
// "+ 0" turns -0 into 0, so a spot reads the same before and after the world is stored as JSON.
const round2 = (v: number): number => Math.round(v * 100) / 100 + 0
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
 * which the layout put on a free slot elsewhere. When that district holds only the part, the district moves to
 * the wireframe's spot, centred under the part, provided it stays clear of every other district (slabRoom) and
 * of every wireframe still waiting (`wires`, WIRE_ROOM). The ring lies at least slabRoom past every district, so
 * only another wireframe, or a district new this compile, can refuse it. Several such moves in one compile are
 * settled together: each is checked against the others' new spots, and while one fails, the first that fails (in
 * the order of `matched`) stays where the layout put it and the rest are checked again. Later compiles keep the
 * district there: the layout keeps a district's place. A district that stood before never moves.
 */
function holdPlannedSpots(
  doc: WorldDoc, key: string, matched: Record<string, string>, previous: WorldDoc | null, positions: Record<string, Pos>, wires: Pos[],
): void {
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
  const movers: { bid: string, d: string, at: Pos }[] = []
  const canMove = (bid: string): boolean => {
    const d = districtOf.get(bid) as string
    return positions[d] !== undefined && !stoodBefore.has(d) && sizeOf(doc, d) === 1
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
    else if (fresh && canMove(bid)) movers.push({ bid, d: districtOf.get(bid) as string, at: fresh })
  }
  const apart = (a: Pos, b: Pos, room: number): boolean => Math.hypot(a[0] - b[0], a[2] - b[2]) >= room
  let going = movers
  for (;;) {
    const spotOf = (o: string): Pos => going.find((m) => m.d === o)?.at ?? positions[o]
    const roomy = (m: { d: string, at: Pos }): boolean =>
      doc.districts.every((o) => o.id === m.d || apart(spotOf(o.id), m.at, slabRoom(sizeOf(doc, o.id)))) &&
      wires.every((w) => apart(w, m.at, WIRE_ROOM))
    const stays = going.find((m) => !roomy(m))
    if (stays === undefined) break
    going = going.filter((m) => m !== stays)
  }
  for (const m of going) {
    positions[m.d] = m.at
    positions[m.bid] = m.at
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
  const kept = plannedBefore(previous)
  const missing = rec.missing.map((pid) => {
    const pb = planById.get(pid) as Building
    const id = idFor.get(pid) as string
    const before = previous?.layout.positions[id]
    return { pb, id, districtId: districtFor.get(pb.districtId) ?? '', before: before && kept.has(id) ? before : undefined }
  })
  // The ring is set from the districts as laid out, before any district moves under a built part, so every
  // wireframe of this compile shares one ring, and it lies at least a slab's room past every district.
  const far = doc.districts.reduce((m, d) => Math.max(m, Math.hypot(positions[d.id][0], positions[d.id][2])), 0)
  const ring = far + Math.max(PLAN_RING_GAP, ...doc.districts.map((d) => slabRoom(sizeOf(doc, d.id))))
  const outside = missing.filter((m) => m.before === undefined && m.districtId === '')
  outside.forEach((m, i) => {
    const angle = (2 * Math.PI * (i + 0.5)) / outside.length
    positions[m.id] = [round2(ring * Math.cos(angle)), 0, round2(ring * Math.sin(angle))]
  })
  for (const m of missing) if (m.before) positions[m.id] = m.before
  // Wireframes placed so far (kept ones and the ring) stay unbuilt this compile: a moved district keeps off them.
  const wires = missing.filter((m) => positions[m.id] !== undefined).map((m) => positions[m.id])
  holdPlannedSpots(doc, plan.projectKey, rec.matched, previous, positions, wires)
  const glossary = { ...doc.glossary }
  const cargo = { ...doc.cargo }
  const buildings: Building[] = []
  for (const { pb, id, districtId, before } of missing) {
    buildings.push({ ...pb, id, districtId, process: '', status: 'proposed' })
    for (const t of [...pb.stack, ...pb.floors.flatMap((f) => f.tech)]) {
      if (!has(glossary, t)) glossary[t] = has(plan.glossary, t) ? plan.glossary[t] : ''
    }
    if (before === undefined && districtId !== '') {
      const siblings = [...doc.buildings, ...buildings].filter((b) => b.districtId === districtId && b.id !== id && positions[b.id])
      const [cx, , cz] = positions[districtId]
      const taken = siblings.map((b): [number, number] => [positions[b.id][0], positions[b.id][2]])
      const p = placeBuilding(id, doc.layout.seed, cx, cz, districtRadius(siblings.length + 1), taken)
      positions[id] = [p[0], 0, p[1]]
    }
  }

  const builtLinks = new Set(doc.edges.map((e) => `${e.from}\n${e.to}`))
  const edges: WorldEdge[] = []
  // Marked on the whole plan first (a design stored before lines were marked), so a line whose reverse the code
  // already makes, and is not drawn again, still runs both ways.
  for (const e of markTwoWay(plan.edges)) {
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
