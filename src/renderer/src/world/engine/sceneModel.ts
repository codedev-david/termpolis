// Pure description of what to draw. No Three.js: the renderer (Task 12) consumes a SceneModel.
import { NOT_IN_DESIGN } from '../../../../shared/world/reconcile'
import type { Building, Proposal, WorldDoc, WorldEdge } from '../../../../shared/world/types'

export type Vec3 = [number, number, number]
export type Look = 'solid' | 'wire' | 'amber' | 'fog'

export interface LayerState {
  /** Which names the renderer prints on buildings. A render switch: the scene model carries no label text for buildings. */
  labels: 'jobs' | 'tech'
  /** Show the coloured process shell around each building. */
  processes: boolean
  allLineLabels: boolean
  /** Show planned (proposed) buildings, the linked design and the connections that touch them. */
  planned: boolean
}
export const DEFAULT_LAYERS: LayerState = { labels: 'jobs', processes: false, allLineLabels: false, planned: true }

export interface SceneDistrict { id: string; pos: Vec3; radius: number; hue: number; label: string }
export interface SceneBuilding {
  id: string; pos: Vec3; floors: number; height: number; look: Look; ring: boolean; processShell?: string
  /** A short card tag, e.g. a built part the linked design does not have. */
  tag?: string
}
export interface SceneConduit {
  id: string; from: Vec3; to: Vec3; ctrl: Vec3; dashed: boolean; width: number; color: string; cargo: string
}
export interface SceneOrb { id: string; pos: Vec3; fog: boolean }
export interface SceneModel {
  districts: SceneDistrict[]; buildings: SceneBuilding[]; conduits: SceneConduit[]; orbs: SceneOrb[]
}

/** Optional data-driven override for a conduit (the live layer, section 5.11). */
export interface ConduitLive { width?: number; color?: string }

const FLOOR_HEIGHT = 3
const MIN_DISTRICT_RADIUS = 6
const DISTRICT_MARGIN = 4
const SELF_LOOP_OFFSET = 3
const FALLBACK_COLOR = '#94a3b8'
const WIDTH_BUSY = 0.3
const WIDTH_STEADY = 0.18
const WIDTH_RARE = 0.1
const BUSY = /\b(?:constant(?:ly)?|continuous(?:ly)?|stream(?:s|ing)?|real.?time)\b|\bevery (?:second|frame|keystroke)\b|\bper second\b/i
const RARE = /\b(?:on demand|rare(?:ly)?|occasional(?:ly)?|startup|manual(?:ly)?)\b|(?<!\bat )\bonce\b/i

/**
 * "Mostly inferred": more than half of the building's claims (`how` plus `why`) are `inferred`,
 * or the building has no evidence-backed claims at all (no claims, or none cites evidence).
 * Such a building is drawn as fog: we are guessing.
 */
export function isMostlyInferred(b: Building): boolean {
  const claims = [...b.how, ...b.why]
  if (!claims.some((c) => c.evidence.length > 0)) return true
  return claims.filter((c) => c.state === 'inferred').length * 2 > claims.length
}

/** Status to look. Precedence: proposed, mostly inferred, gap, built, then verified (solid plus ring). */
export function lookOf(b: Building): { look: Look; ring: boolean } {
  if (b.status === 'proposed') return { look: 'wire', ring: false }
  if (isMostlyInferred(b)) return { look: 'fog', ring: false }
  if (b.status === 'gap') return { look: 'amber', ring: false }
  return { look: 'solid', ring: b.status === 'verified' }
}

/**
 * Width and colour of a conduit. Width comes from `edge.rate` (three fixed widths), colour from
 * the document's cargo map; `live` overrides either. Callers do not pass `live` yet.
 * Takes the doc as well as the edge because the cargo map lives on the doc.
 */
export function conduitStyle(doc: WorldDoc, edge: WorldEdge, live?: ConduitLive): { width: number; color: string } {
  let width = WIDTH_STEADY
  if (BUSY.test(edge.rate)) width = WIDTH_BUSY
  else if (RARE.test(edge.rate)) width = WIDTH_RARE
  const cargo = doc.cargo[edge.cargo]
  return { width: live?.width ?? width, color: live?.color ?? (cargo ? cargo.color : FALLBACK_COLOR) }
}

type Linked = Proposal & { reconcile: NonNullable<Proposal['reconcile']> }

function fallbackPos(index: number): Vec3 {
  return [(index % 6) * 8, 0, 14 + Math.floor(index / 6) * 8]
}

export function buildSceneModel(doc: WorldDoc, layers: LayerState, opts?: { revealProposal?: string }): SceneModel {
  const proposal = opts?.revealProposal === undefined ? undefined : doc.layers.plan.find((p) => p.id === opts.revealProposal)
  // The linked design (a proposal carrying reconcile) shows with the planned layer; its missing parts are
  // wireframes at their design position, and the parts it matched are the built buildings themselves.
  const linked = layers.planned ? doc.layers.plan.filter((p): p is Linked => p.reconcile !== undefined) : []
  const shown: Proposal[] = proposal && !linked.some((p) => p === proposal) ? [...linked, proposal] : linked
  const notInDesign = new Set(linked.flatMap((p) => p.reconcile.extra))
  const buildings: Building[] = doc.buildings.filter((b) => layers.planned || b.status !== 'proposed')
  const known = new Set(buildings.map((b) => b.id))
  // The existing doc item wins over a revealed proposal item with the same id.
  for (const b of shown.flatMap((p) => p.buildings)) {
    if (known.has(b.id)) continue
    known.add(b.id)
    buildings.push({ ...b, status: 'proposed' })
  }
  const proposedIds = new Set(buildings.filter((b) => b.status === 'proposed').map((b) => b.id))

  let slot = 0
  const positions = new Map<string, Vec3>()
  const place = (id: string): Vec3 => {
    const p = doc.layout.positions[id] ?? fallbackPos(slot++)
    positions.set(id, p)
    return p
  }

  const sceneBuildings: SceneBuilding[] = buildings.map((b) => {
    const { look, ring } = lookOf(b)
    const floors = Math.max(1, b.floors.length)
    const sb: SceneBuilding = { id: b.id, pos: place(b.id), floors, height: floors * FLOOR_HEIGHT, look, ring }
    if (layers.processes) sb.processShell = b.process
    if (notInDesign.has(b.id)) sb.tag = NOT_IN_DESIGN
    return sb
  })
  const orbs: SceneOrb[] = doc.externals.map((x) => ({ id: x.id, pos: place(x.id), fog: x.fog }))

  const districts: SceneDistrict[] = []
  for (const d of doc.districts) {
    const pts = buildings.filter((b) => b.districtId === d.id).map((b) => positions.get(b.id) as Vec3)
    if (pts.length === 0) continue // nothing visible in it (empty, or all planned and hidden)
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length
    const cz = pts.reduce((s, p) => s + p[2], 0) / pts.length
    const far = Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[2] - cz)))
    districts.push({ id: d.id, pos: [cx, 0, cz], radius: Math.max(MIN_DISTRICT_RADIUS, far + DISTRICT_MARGIN), hue: d.hue, label: d.name })
  }

  const conduits: SceneConduit[] = []
  const seenEdges = new Set(doc.edges.map((e) => e.id))
  const revealedEdges: WorldEdge[] = []
  for (const e of shown.flatMap((p) => p.edges)) {
    if (seenEdges.has(e.id)) continue
    seenEdges.add(e.id)
    revealedEdges.push(e)
  }
  const revealedIds = new Set(revealedEdges.map((e) => e.id))
  for (const e of [...doc.edges, ...revealedEdges]) {
    const from = positions.get(e.from)
    const to = positions.get(e.to)
    if (!from || !to) continue // an endpoint was hidden (planned layer off)
    const lift = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) * 0.22 + 4
    // A self-loop has no span, so push its control point sideways to keep the curve a visible arc.
    const side = e.from === e.to ? SELF_LOOP_OFFSET : 0
    const ctrl: Vec3 = [(from[0] + to[0]) / 2 + side, (from[1] + to[1]) / 2 + lift, (from[2] + to[2]) / 2]
    const style = conduitStyle(doc, e)
    conduits.push({
      id: e.id, from, to, ctrl, dashed: revealedIds.has(e.id) || proposedIds.has(e.from) || proposedIds.has(e.to),
      width: style.width, color: style.color, cargo: e.cargo,
    })
  }
  return { districts, buildings: sceneBuildings, conduits, orbs }
}
