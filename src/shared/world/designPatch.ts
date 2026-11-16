// Lumopolis design patches: the small set of changes an agent may make to a design world (a planned
// system, keyed design:<id>), the pure function that applies them, and the tolerant parser for the
// agent's reply. Dependency-free and ES2020, so main, the gateway and the renderer can all use it.
// Nothing an agent sends is trusted: every op is checked against the doc, and one that can't apply
// is skipped with a plain reason, never thrown. The result always passes validateWorld (a patch that
// would break it applies nothing). Positions come from an injected placer (main passes one built on
// layout.ts; shared-only callers get defaultPlacer), and a position once given is always kept.
import type { Claim, WorldDoc } from './types'
import { validateWorld } from './validate'

export type DesignOp =
  | { op: 'addDistrict'; id: string; name: string; subtitle?: string }
  | { op: 'addBuilding'; id: string; districtId: string; name: string; techLabel?: string; stack?: string[]; does?: string }
  | { op: 'addEdge'; from: string; to: string; label: string; cargo?: string }
  | { op: 'rename'; id: string; name: string }
  | { op: 'remove'; id: string }
  | { op: 'move'; id: string; districtId: string }
  | { op: 'describe'; id: string; does: string }

type Pos = [number, number, number]
/** Given a doc whose layout holds only the positions to keep, returns positions for every district and building. */
export type DesignPlacer = (doc: WorldDoc) => Record<string, Pos>

export interface DesignPatchResult { doc: WorldDoc; applied: number; skipped: { op: DesignOp; reason: string }[] }
export interface DesignReply { text: string; ops: DesignOp[]; /** Ops that were malformed or past MAX_DESIGN_OPS. */ dropped: number }

export const DESIGN_PROTOCOL = `Reply in plain language for someone who does not read code. Keep it under 150 words.
After your reply, add one fenced block tagged design-patch containing a JSON array of changes. Allowed changes:
{"op":"addDistrict","id":"...","name":"...","subtitle":"..."}
{"op":"addBuilding","id":"...","districtId":"...","name":"...","techLabel":"...","stack":["..."],"does":"..."}
{"op":"addEdge","from":"<building id>","to":"<building id>","label":"...","cargo":"..."}
{"op":"rename","id":"...","name":"..."} {"op":"remove","id":"..."}
{"op":"move","id":"<building id>","districtId":"..."} {"op":"describe","id":"...","does":"..."}
A district is an area of the system; a building is one part (a service, an app, a store) inside a district.
New ids are short lowercase words joined by dashes and unique across the design. Use only ids from the
DESIGN DATA or ones you add earlier in the same block.`

export const MAX_DESIGN_OPS = 200
const MAX_NAME = 120
const MAX_TEXT = 1000
const MAX_TECH = 40
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const BLOCK_RE = /```design-patch[ \t]*\r?\n([\s\S]*?)```/g
const DANGLING_RE = /```design-patch[\s\S]*$/
const SHAPES = ['cube', 'sphere', 'octa', 'tetra'] as const
const PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#86bcb6']
const DEFAULT_SEED = 1337
// defaultPlacer: districts on a 4-wide grid, buildings on a sunflower spiral around their centre.
const GRID = 70
const GRID_CLEARANCE = 35
const STEP = 5
const GAP = 6
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null
const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const clip = (s: string, max: number): string => s.trim().slice(0, max)
const optText = (v: unknown, max: number): string | undefined => (str(v) ? clip(v, max) : undefined)
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const round2 = (v: number): number => Math.round(v * 100) / 100

/** Drops the optional fields that came out undefined, so ops compare and serialize cleanly. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o)) if ((o as Rec)[k] === undefined) delete (o as Rec)[k]
  return o
}

/** A checked copy of one op from the agent (required fields present, strings trimmed and capped), or null. */
function normalizeOp(raw: unknown): DesignOp | null {
  if (!isRec(raw)) return null
  if (raw.op === 'addEdge') {
    if (!str(raw.from) || !str(raw.to) || !str(raw.label)) return null
    return compact<DesignOp>({ op: 'addEdge', from: raw.from.trim(), to: raw.to.trim(), label: clip(raw.label, MAX_NAME), cargo: optText(raw.cargo, MAX_TECH) })
  }
  if (!str(raw.id)) return null
  const id = clip(raw.id, MAX_NAME)
  switch (raw.op) {
    case 'addDistrict':
      return str(raw.name) ? compact<DesignOp>({ op: 'addDistrict', id, name: clip(raw.name, MAX_NAME), subtitle: optText(raw.subtitle, MAX_TEXT) }) : null
    case 'addBuilding': {
      if (!str(raw.districtId) || !str(raw.name)) return null
      const stack = Array.isArray(raw.stack) ? raw.stack.filter(str).map((t) => clip(t, MAX_TECH)) : undefined
      return compact<DesignOp>({
        op: 'addBuilding', id, districtId: raw.districtId.trim(), name: clip(raw.name, MAX_NAME),
        techLabel: optText(raw.techLabel, MAX_NAME), stack, does: optText(raw.does, MAX_TEXT)
      })
    }
    case 'rename':
      return str(raw.name) ? { op: 'rename', id, name: clip(raw.name, MAX_NAME) } : null
    case 'remove':
      return { op: 'remove', id }
    case 'move':
      return str(raw.districtId) ? { op: 'move', id, districtId: raw.districtId.trim() } : null
    case 'describe':
      return str(raw.does) ? { op: 'describe', id, does: clip(raw.does, MAX_TEXT) } : null
    default:
      return null
  }
}

/** Splits an agent reply into prose and the checked ops of its first design-patch block. Never throws. */
export function parseDesignReply(raw: string): DesignReply {
  const input = typeof raw === 'string' ? raw : ''
  const text = input.replace(BLOCK_RE, '').replace(DANGLING_RE, '').trim() // closed blocks, then a truncated opener
  const first = [...input.matchAll(BLOCK_RE)][0]
  if (!first) return { text, ops: [], dropped: 0 }
  let parsed: unknown
  try {
    parsed = JSON.parse(first[1])
  } catch {
    return { text, ops: [], dropped: 0 }
  }
  const list: unknown[] = Array.isArray(parsed) ? parsed : isRec(parsed) && Array.isArray(parsed.ops) ? parsed.ops : []
  const ops: DesignOp[] = []
  for (const item of list.slice(0, MAX_DESIGN_OPS)) {
    const op = normalizeOp(item)
    if (op) ops.push(op)
  }
  return { text, ops, dropped: list.length - ops.length }
}

/** A design world with nothing in it yet: valid, plan-only, keyed `key`. */
export function emptyDesignDoc(key: string, now: number): WorldDoc {
  return {
    version: 1, projectKey: key, generatedAt: now, sourceRevision: { head: '', dirty: false },
    districts: [], buildings: [], edges: [], externals: [], glossary: {}, cargo: {}, processes: {}, tours: [],
    layout: { seed: DEFAULT_SEED, positions: {} }, runtimeNames: {}, layers: { plan: [] }
  }
}

function hashOf(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const near = (a: Pos, b: Pos, d: number): boolean => Math.hypot(a[0] - b[0], a[2] - b[2]) < d

/** Deterministic placer for callers without layout.ts: keeps every given position and fills the rest. */
export const defaultPlacer: DesignPlacer = (doc) => {
  const positions: Record<string, Pos> = { ...doc.layout.positions }
  const centres = doc.districts.filter((d) => positions[d.id]).map((d) => positions[d.id])
  for (const d of doc.districts) {
    if (positions[d.id]) continue
    let k = 0
    const slot = (): Pos => [(k % 4) * GRID, 0, Math.floor(k / 4) * GRID]
    while (centres.some((c) => near(c, slot(), GRID_CLEARANCE))) k++
    positions[d.id] = slot()
    centres.push(positions[d.id])
  }
  for (const d of doc.districts) {
    const [cx, , cz] = positions[d.id]
    const ids = doc.buildings.filter((b) => b.districtId === d.id).map((b) => b.id)
    const taken = ids.filter((id) => positions[id]).map((id) => positions[id])
    for (const id of ids) {
      if (positions[id]) continue
      let i = 0
      const spot = (): Pos => [round2(cx + STEP * Math.sqrt(i + 0.5) * Math.cos(i * GOLDEN_ANGLE)), 0, round2(cz + STEP * Math.sqrt(i + 0.5) * Math.sin(i * GOLDEN_ANGLE))]
      while (taken.some((t) => near(t, spot(), GAP))) i++
      positions[id] = spot()
      taken.push(positions[id])
    }
  }
  return positions
}

const allIds = (doc: WorldDoc): Set<string> =>
  new Set([...doc.districts, ...doc.buildings, ...doc.edges, ...doc.externals].map((x) => x.id))

/** Removes a district (with its buildings), a building or an edge, plus every edge left dangling. */
function removeItem(doc: WorldDoc, id: string): string | null {
  const gone = new Set<string>([id])
  if (doc.districts.some((d) => d.id === id)) {
    for (const b of doc.buildings) if (b.districtId === id) gone.add(b.id)
  } else if (!doc.buildings.some((b) => b.id === id) && !doc.edges.some((e) => e.id === id)) {
    return `there is nothing called "${id}"`
  }
  doc.districts = doc.districts.filter((d) => !gone.has(d.id))
  doc.buildings = doc.buildings.filter((b) => !gone.has(b.id))
  doc.edges = doc.edges.filter((e) => !gone.has(e.id) && !gone.has(e.from) && !gone.has(e.to))
  for (const g of gone) delete doc.runtimeNames[g]
  const live = allIds(doc)
  for (const t of doc.tours) {
    t.steps = t.steps.map((s) => ({ ...s, ids: s.ids.filter((x) => live.has(x)) })).filter((s) => s.ids.length > 0)
  }
  return null
}

/** Applies one checked op to `doc` in place; returns why it can't apply, or null once applied. */
function applyOne(doc: WorldDoc, op: DesignOp, ref: string, moved: Set<string>): string | null {
  const claim = (text: string): Claim => ({ text, state: 'proposed', evidence: [{ kind: 'memory', ref }] })
  const district = (id: string) => doc.districts.find((d) => d.id === id)
  const building = (id: string) => doc.buildings.find((b) => b.id === id)
  const fresh = (id: string): string | null =>
    !ID_RE.test(id) ? `"${id}" is not a usable id` : allIds(doc).has(id) ? `"${id}" is already used` : null
  switch (op.op) {
    case 'addDistrict': {
      const why = fresh(op.id)
      if (why) return why
      const hue = Math.round((doc.districts.length * 137.508) % 360)
      doc.districts.push({ id: op.id, name: op.name, subtitle: op.subtitle ?? '', hue, members: [] })
      return null
    }
    case 'addBuilding': {
      const why = fresh(op.id) ?? (district(op.districtId) ? null : `there is no district "${op.districtId}"`)
      if (why) return why
      const stack = [...new Set(op.stack ?? [])]
      for (const t of stack) if (!has(doc.glossary, t)) doc.glossary[t] = ''
      doc.buildings.push({
        id: op.id, districtId: op.districtId, name: op.name, techLabel: op.techLabel ?? '', process: '', floors: [], stack,
        how: op.does ? [claim(op.does)] : [], why: [], status: 'proposed', members: []
      })
      return null
    }
    case 'addEdge': {
      const nodes = new Set([...doc.buildings, ...doc.externals].map((x) => x.id))
      const missing = [op.from, op.to].find((x) => !nodes.has(x))
      if (missing !== undefined) return `there is no building "${missing}"`
      if (op.from === op.to) return 'a connection needs two different parts'
      const id = `e-${op.from}--${op.to}`
      if (allIds(doc).has(id)) return 'that connection already exists'
      const cargo = op.cargo ?? ''
      if (cargo !== '' && !has(doc.cargo, cargo)) {
        const h = hashOf(cargo)
        doc.cargo[cargo] = { shape: SHAPES[h % SHAPES.length], color: PALETTE[h % PALETTE.length], label: cargo }
      }
      doc.edges.push({ id, from: op.from, to: op.to, cargo, label: op.label, how: [claim(op.label)], tech: [], why: [], rate: '', twoWay: false })
      return null
    }
    case 'rename':
    case 'describe': {
      const target = building(op.id) ?? district(op.id)
      if (!target) return `there is no district or building "${op.id}"`
      if (op.op === 'rename') target.name = op.name
      else if ('how' in target) target.how = [claim(op.does)]
      else target.subtitle = op.does
      return null
    }
    case 'move': {
      const b = building(op.id)
      if (!b) return `there is no building "${op.id}"`
      if (!district(op.districtId)) return `there is no district "${op.districtId}"`
      if (b.districtId !== op.districtId) moved.add(b.id)
      b.districtId = op.districtId
      return null
    }
    default:
      return removeItem(doc, op.id)
  }
}

/**
 * Applies `ops` to a copy of `doc`. Each op that can't apply (unknown target, used id, an edge to
 * nothing) is skipped with a reason; the rest apply in order. Positions of parts that remain (and
 * didn't move district) are kept as they are; `place` fills in the new ones.
 */
export function applyDesignPatch(doc: WorldDoc, ops: DesignOp[], place: DesignPlacer = defaultPlacer): DesignPatchResult {
  const work = JSON.parse(JSON.stringify(doc)) as WorldDoc
  const ref = doc.projectKey.startsWith('design:') ? doc.projectKey : `design:${doc.projectKey}`
  const moved = new Set<string>()
  const skipped: DesignPatchResult['skipped'] = []
  let applied = 0
  for (const raw of ops) {
    const op = normalizeOp(raw)
    const reason = op ? applyOne(work, op, ref, moved) : 'not a change Lumopolis understands'
    if (reason === null) applied++
    else skipped.push({ op: raw, reason })
  }
  if (applied === 0) return { doc, applied, skipped }

  const live = allIds(work)
  const keep: Record<string, Pos> = {}
  for (const [id, p] of Object.entries(work.layout.positions)) if (live.has(id) && !moved.has(id)) keep[id] = p
  work.layout = { seed: work.layout.seed, positions: keep }
  work.layout.positions = { ...place(work), ...keep }
  if (!validateWorld(work).ok) return { doc, applied: 0, skipped: ops.map((op) => ({ op, reason: 'the design would not be valid' })) }
  return { doc: work, applied, skipped }
}
