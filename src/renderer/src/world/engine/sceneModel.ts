// Pure description of what to draw. No Three.js: the renderer (Task 12) consumes a SceneModel.
import { NOT_IN_DESIGN } from '../../../../shared/world/reconcile'
import type { Building, Claim, Proposal, WorldDoc, WorldEdge } from '../../../../shared/world/types'

export type Vec3 = [number, number, number]
/** `fading`: a built part the shown proposal takes away, drawn pulsing out. */
export type Look = 'solid' | 'wire' | 'amber' | 'fog' | 'fading'

export interface LayerState {
  /** Which names the renderer prints on buildings. A render switch: the scene model carries no label text for buildings. */
  labels: 'jobs' | 'tech'
  /** Show the coloured process shell around each building. */
  processes: boolean
  allLineLabels: boolean
  /** Show planned (proposed) buildings, the linked design and the connections that touch them. */
  planned: boolean
  /** The id of the proposal drawn over the world (its parts, outlines and fades); null: none. */
  proposal: string | null
}
export const DEFAULT_LAYERS: LayerState = { labels: 'jobs', processes: false, allLineLabels: false, planned: true, proposal: null }

export interface SceneDistrict { id: string; pos: Vec3; radius: number; hue: number; label: string }
export interface SceneBuilding {
  id: string; pos: Vec3; floors: number; height: number; look: Look; ring: boolean; processShell?: string
  /** A wireframe shell a little larger than a solid building the code changed since the last reconcile. */
  outline: boolean
  /** 0..1 from the live layer's latency (a second is 1); 0 with no live data. */
  heat: number
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

/** What the live layer knows about one building or line, keyed by its id. */
export type LiveRecord = Record<string, { rate?: number; latencyMs?: number }>

const FLOOR_HEIGHT = 3
const MIN_DISTRICT_RADIUS = 6
const DISTRICT_MARGIN = 4
const SELF_LOOP_OFFSET = 3
const FALLBACK_COLOR = '#94a3b8'
const WIDTH_MIN = 0.04
const WIDTH_MAX = 0.2
const HEAT_FULL_MS = 1000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** `doc.layers.live` as a record of `{rate?, latencyMs?}` when it is shaped right; an empty one otherwise (never throws). */
export function liveOf(doc: WorldDoc): LiveRecord {
  const raw = doc.layers.live
  if (!isRecord(raw)) return {}
  const out: LiveRecord = {}
  for (const [id, v] of Object.entries(raw)) {
    if (!isRecord(v)) continue
    const rec: { rate?: number; latencyMs?: number } = {}
    if (finite(v.rate) && v.rate >= 0) rec.rate = v.rate
    if (finite(v.latencyMs) && v.latencyMs >= 0) rec.latencyMs = v.latencyMs
    out[id] = rec
  }
  return out
}

/** 0..1 of how slow a building is now, from its live latency (a second is full); 0 with no live data. */
export function heatOf(live: LiveRecord, id: string): number {
  const ms = live[id]?.latencyMs
  return ms === undefined ? 0 : Math.min(1, ms / HEAT_FULL_MS)
}

/**
 * "Mostly inferred": the building makes claims (`how` plus `why`) and more than half of them are
 * `inferred`, or none of them cites evidence. Such a building is drawn as fog: we are guessing.
 * A building with no claims at all guesses nothing: its structure comes from the code itself
 * (spec lines 50 and 93: fog marks uncertain claims, never certain structure), so it is not fog.
 */
export function isMostlyInferred(b: Pick<Building, 'how' | 'why'>): boolean {
  const claims = [...b.how, ...b.why]
  if (claims.length === 0) return false
  if (!claims.some((c) => c.evidence.length > 0)) return true
  return claims.filter((c) => c.state === 'inferred').length * 2 > claims.length
}

/** The warm colour a building's glow moves toward as its latency rises. */
export const HEAT_COLOR = '#ff6a2b'
/** How far the glow colour moves toward HEAT_COLOR (0..0.75) and how much brighter it burns (1..1.8) at heat 0..1. Heat 0 changes nothing. */
export function heatMix(heat: number): { toward: number; glow: number } {
  const h = Math.min(1, Math.max(0, heat))
  return { toward: h * 0.75, glow: 1 + h * 0.8 }
}

/** Status to look. Precedence: proposed, mostly inferred, gap, built, then verified (solid plus ring). */
export function lookOf(b: Building): { look: Look; ring: boolean } {
  if (b.status === 'proposed') return { look: 'wire', ring: false }
  if (isMostlyInferred(b)) return { look: 'fog', ring: false }
  if (b.status === 'gap') return { look: 'amber', ring: false }
  return { look: 'solid', ring: b.status === 'verified' }
}

/** The edge's claims (how, why and the rest): the facts it rests on. */
const edgeClaims = (e: WorldEdge): Claim[] => [...e.how, ...e.why, ...e.claims]

/**
 * Width, colour and dash of a conduit. Width grows with the traffic: the live rate, else the number in
 * `edge.rate`, else 1 (clamp(0.04 + 0.02 * log2(1 + rate), 0.04, 0.2)). Colour comes from the document's
 * cargo map. Dashed marks a guess or a plan: a line that touches a proposed part, or that has claims and
 * none of them is seen (observed or verified), or that is mostly inferred. A line with no claims is solid.
 * `live` is keyed by edge id.
 */
export function conduitStyle(doc: WorldDoc, edge: WorldEdge, live?: LiveRecord, proposedIds?: ReadonlySet<string>): { width: number; color: string; dashed: boolean } {
  const parsed = Number.parseFloat(/\d+(?:\.\d+)?/.exec(edge.rate)?.[0] ?? '')
  const rate = live?.[edge.id]?.rate ?? (Number.isFinite(parsed) ? parsed : 1)
  const width = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, 0.04 + 0.02 * Math.log2(1 + rate)))
  const cargo = doc.cargo[edge.cargo]
  const claims = edgeClaims(edge)
  const guess = claims.length > 0 && (isMostlyInferred(edge) || !claims.some((c) => c.state === 'observed' || c.state === 'verified'))
  const planned = proposedIds !== undefined && (proposedIds.has(edge.from) || proposedIds.has(edge.to))
  return { width, color: cargo ? cargo.color : FALLBACK_COLOR, dashed: planned || guess }
}

type Linked = Proposal & { reconcile: NonNullable<Proposal['reconcile']> }

function fallbackPos(index: number): Vec3 {
  return [(index % 6) * 8, 0, 14 + Math.floor(index / 6) * 8]
}

export function buildSceneModel(doc: WorldDoc, layers: LayerState, opts?: { revealProposal?: string; fogged?: ReadonlySet<string> }): SceneModel {
  const proposal = opts?.revealProposal === undefined ? undefined : doc.layers.plan.find((p) => p.id === opts.revealProposal)
  // The linked design (a proposal carrying reconcile) shows with the planned layer; its missing parts are
  // wireframes at their design position, and the parts it matched are the built buildings themselves.
  const chosen = layers.planned && layers.proposal !== null ? doc.layers.plan.filter((p) => p.id === layers.proposal) : []
  const linked = chosen.filter((p): p is Linked => p.reconcile !== undefined)
  const shown: Proposal[] = proposal && !chosen.some((p) => p === proposal) ? [...chosen, proposal] : chosen
  const notInDesign = new Set(linked.flatMap((p) => p.reconcile.extra))
  const changed = new Set(linked.flatMap((p) => p.reconcile.changed ?? []))
  const removed = new Set(shown.flatMap((p) => p.removes ?? []))
  const buildings: Building[] = doc.buildings.filter((b) => layers.planned || b.status !== 'proposed')
  const known = new Set(buildings.map((b) => b.id))
  // The existing doc item wins over a revealed proposal item with the same id.
  for (const b of shown.flatMap((p) => p.buildings)) {
    if (known.has(b.id)) continue
    known.add(b.id)
    buildings.push({ ...b, status: 'proposed' })
  }
  const proposedIds = new Set(buildings.filter((b) => b.status === 'proposed').map((b) => b.id))

  const live = liveOf(doc)
  let slot = 0
  const positions = new Map<string, Vec3>()
  const place = (id: string): Vec3 => {
    const p = doc.layout.positions[id] ?? fallbackPos(slot++)
    positions.set(id, p)
    return p
  }

  const sceneBuildings: SceneBuilding[] = buildings.map((b) => {
    const fogged = opts?.fogged?.has(b.id) === true // an answer the evidence does not support fogs its parts
    const base = fogged ? { look: 'fog' as const, ring: false } : lookOf(b)
    const { look, ring } = removed.has(b.id) && !fogged ? { look: 'fading' as const, ring: false } : base
    const floors = Math.max(1, b.floors.length)
    const sb: SceneBuilding = { id: b.id, pos: place(b.id), floors, height: floors * FLOOR_HEIGHT, look, ring, outline: changed.has(b.id), heat: heatOf(live, b.id) }
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
    const style = conduitStyle(doc, e, live, proposedIds)
    conduits.push({
      id: e.id, from, to, ctrl, dashed: revealedIds.has(e.id) || style.dashed,
      width: style.width, color: style.color, cargo: e.cargo,
    })
  }
  return { districts, buildings: sceneBuildings, conduits, orbs }
}
