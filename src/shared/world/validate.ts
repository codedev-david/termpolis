// Structural validator for a WorldDoc. Hand-written and dependency-free on purpose: it runs in
// the main process, the renderer and the standalone website bundle. Target is ES2020 (no
// Array.prototype.at, no Object.hasOwn).
import type { WorldDoc } from './types'

type Rec = Record<string, unknown>

const CLAIM_STATES = new Set(['proposed', 'observed', 'inferred', 'verified'])
const EVIDENCE_KINDS = new Set(['file', 'symbol', 'test', 'transcriptStep', 'memory', 'commit',
  'trace', 'metric', 'log', 'deploy'])
// Kinds whose ref is a path inside the repository: exports must stay repository-relative (§5.9).
const PATH_KINDS = new Set(['file', 'symbol', 'test'])
const BUILD_STATUSES = new Set(['verified', 'built', 'gap', 'proposed'])
const EXTERNAL_KINDS = new Set(['agent', 'provider', 'files', 'machine', 'service'])
const CARGO_SHAPES = new Set(['cube', 'sphere', 'octa', 'tetra'])
const ABSOLUTE_PATH = /^([a-zA-Z]:|[\\/])/

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const has = (o: Rec, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

const idsOf = (list: unknown): string[] => {
  const out: string[] = []
  if (Array.isArray(list)) {
    for (const item of list) if (isRecord(item) && isStr(item.id)) out.push(item.id)
  }
  return out
}

interface Ctx {
  errors: string[]
  glossary: Rec
  positions: Rec | null
  districtIds: Set<string>
  seen: { building: Set<string>; district: Set<string>; edge: Set<string>; external: Set<string>; proposal: Set<string>; tour: Set<string> }
}

/** Label for an item: `<kind> <id>` when it has a usable id, else `<kind> #<index>`. */
const labelOf = (kind: string, item: Rec, index: number): { id: string | null; label: string } => {
  const id = isStr(item.id) && item.id !== '' ? item.id : null
  return { id, label: id ? `${kind} ${id}` : `${kind} #${index}` }
}

/** Common prologue for a list item: object check, id check, duplicate check. Returns null to stop. */
const openItem = (
  ctx: Ctx, kind: keyof Ctx['seen'], prefix: string, item: unknown, index: number
): { id: string | null; label: string; rec: Rec } | null => {
  if (!isRecord(item)) {
    ctx.errors.push(`${prefix}${kind} #${index} is not an object`)
    return null
  }
  const { id, label } = labelOf(kind, item, index)
  if (id === null) ctx.errors.push(`${prefix}${label}: id must be a non-empty string`)
  else if (ctx.seen[kind].has(id)) ctx.errors.push(`${prefix}${label}: duplicate id`)
  else ctx.seen[kind].add(id)
  return { id, label: prefix + label, rec: item }
}

const checkStr = (ctx: Ctx, p: string, rec: Rec, field: string): void => {
  if (!isStr(rec[field])) ctx.errors.push(`${p}: ${field} must be a string`)
}

/** True when `v` is an array of strings; otherwise records an error and returns false. */
const checkStrings = (ctx: Ctx, p: string, field: string, v: unknown): v is string[] => {
  const ok = Array.isArray(v) && v.every(isStr)
  if (!ok) ctx.errors.push(`${p}: ${field} must be an array of strings`)
  return ok
}

const checkTech = (ctx: Ctx, p: string, field: string, v: unknown): void => {
  if (checkStrings(ctx, p, field, v)) {
    for (const t of v) if (!has(ctx.glossary, t)) ctx.errors.push(`${p}: ${field} "${t}" not in glossary`)
  }
}

const checkEvidence = (ctx: Ctx, p: string, ev: unknown): void => {
  if (!isRecord(ev)) {
    ctx.errors.push(`${p}: evidence is not an object`)
    return
  }
  if (!EVIDENCE_KINDS.has(ev.kind as string)) ctx.errors.push(`${p}: evidence kind "${String(ev.kind)}" is invalid`)
  if (!isStr(ev.ref)) ctx.errors.push(`${p}: evidence ref must be a string`)
  else if (PATH_KINDS.has(ev.kind as string) && (ev.ref === '' || ABSOLUTE_PATH.test(ev.ref))) {
    ctx.errors.push(`${p}: evidence ref "${ev.ref}" must be repository-relative`)
  }
  if (ev.excerpt !== undefined && !isStr(ev.excerpt)) ctx.errors.push(`${p}: evidence excerpt must be a string`)
}

const checkClaims = (ctx: Ctx, p: string, field: string, v: unknown): void => {
  if (!Array.isArray(v)) {
    ctx.errors.push(`${p}: ${field} must be an array`)
    return
  }
  for (const c of v) {
    if (!isRecord(c)) {
      ctx.errors.push(`${p}: claim is not an object`)
      continue
    }
    if (!isStr(c.text)) ctx.errors.push(`${p}: claim text must be a string`)
    if (!CLAIM_STATES.has(c.state as string)) ctx.errors.push(`${p}: claim state "${String(c.state)}" is invalid`)
    if (!Array.isArray(c.evidence)) ctx.errors.push(`${p}: claim evidence must be an array`)
    else if (c.evidence.length === 0) ctx.errors.push(`${p}: claim without evidence`)
    else for (const ev of c.evidence) checkEvidence(ctx, p, ev)
  }
}

const checkFloors = (ctx: Ctx, p: string, floors: unknown): void => {
  if (!Array.isArray(floors)) {
    ctx.errors.push(`${p}: floors must be an array`)
    return
  }
  floors.forEach((f, i) => {
    if (!isRecord(f)) {
      ctx.errors.push(`${p}: floor #${i} is not an object`)
      return
    }
    const fp = `${p}: floor ${isStr(f.name) ? `"${f.name}"` : `#${i}`}`
    checkStr(ctx, fp, f, 'name')
    checkTech(ctx, fp, 'tech', f.tech)
    checkStrings(ctx, fp, 'members', f.members)
  })
}

const checkBuilding = (ctx: Ctx, prefix: string, b: unknown, i: number, proposed: boolean): void => {
  const it = openItem(ctx, 'building', prefix, b, i)
  if (!it) return
  const { id, label: p, rec } = it
  if (!ctx.districtIds.has(rec.districtId as string)) ctx.errors.push(`${p}: unknown districtId "${String(rec.districtId)}"`)
  for (const f of ['name', 'techLabel', 'process']) checkStr(ctx, p, rec, f)
  if (!BUILD_STATUSES.has(rec.status as string)) ctx.errors.push(`${p}: status "${String(rec.status)}" is invalid`)
  if (proposed && rec.status !== 'proposed') ctx.errors.push(`${p}: status must be "proposed"`)
  checkStrings(ctx, p, 'members', rec.members)
  checkTech(ctx, p, 'stack', rec.stack)
  checkFloors(ctx, p, rec.floors)
  checkClaims(ctx, p, 'how', rec.how)
  checkClaims(ctx, p, 'why', rec.why)
  if (id !== null && ctx.positions) {
    if (!has(ctx.positions, id)) ctx.errors.push(`${p}: no layout position`)
    else {
      const pos = ctx.positions[id]
      if (!Array.isArray(pos) || pos.length !== 3 || !pos.every(isNum)) ctx.errors.push(`${p}: layout position must be [x, y, z]`)
    }
  }
}

const checkEdge = (ctx: Ctx, prefix: string, e: unknown, i: number, nodes: Set<string>): void => {
  const it = openItem(ctx, 'edge', prefix, e, i)
  if (!it) return
  const { label: p, rec } = it
  if (!nodes.has(rec.from as string)) ctx.errors.push(`${p}: unknown from "${String(rec.from)}"`)
  if (!nodes.has(rec.to as string)) ctx.errors.push(`${p}: unknown to "${String(rec.to)}"`)
  for (const f of ['cargo', 'label', 'rate']) checkStr(ctx, p, rec, f)
  if (typeof rec.twoWay !== 'boolean') ctx.errors.push(`${p}: twoWay must be a boolean`)
  checkTech(ctx, p, 'tech', rec.tech)
  checkClaims(ctx, p, 'how', rec.how)
  checkClaims(ctx, p, 'why', rec.why)
}

const checkDistrict = (ctx: Ctx, d: unknown, i: number): void => {
  const it = openItem(ctx, 'district', '', d, i)
  if (!it) return
  const { label: p, rec } = it
  checkStr(ctx, p, rec, 'name')
  checkStr(ctx, p, rec, 'subtitle')
  if (!isNum(rec.hue)) ctx.errors.push(`${p}: hue must be a number`)
  checkStrings(ctx, p, 'members', rec.members)
}

const checkExternal = (ctx: Ctx, x: unknown, i: number): void => {
  const it = openItem(ctx, 'external', '', x, i)
  if (!it) return
  const { label: p, rec } = it
  checkStr(ctx, p, rec, 'name')
  if (!EXTERNAL_KINDS.has(rec.kind as string)) ctx.errors.push(`${p}: kind "${String(rec.kind)}" is invalid`)
  if (typeof rec.fog !== 'boolean') ctx.errors.push(`${p}: fog must be a boolean`)
}

const checkTour = (ctx: Ctx, t: unknown, i: number): void => {
  const it = openItem(ctx, 'tour', '', t, i)
  if (!it) return
  const { label: p, rec } = it
  checkStr(ctx, p, rec, 'title')
  if (!Array.isArray(rec.steps)) {
    ctx.errors.push(`${p}: steps must be an array`)
    return
  }
  rec.steps.forEach((s, n) => {
    if (!isRecord(s)) {
      ctx.errors.push(`${p}: step #${n} is not an object`)
      return
    }
    checkStrings(ctx, `${p}: step #${n}`, 'ids', s.ids)
    checkStr(ctx, `${p}: step #${n}`, s, 'caption')
  })
}

const checkProposal = (ctx: Ctx, pr: unknown, i: number, baseNodes: Set<string>): void => {
  const it = openItem(ctx, 'proposal', '', pr, i)
  if (!it) return
  const { label, rec } = it
  const p = `${label}: `
  checkStr(ctx, label, rec, 'title')
  if (!Array.isArray(rec.summary)) ctx.errors.push(`${label}: summary must be an array`)
  else checkClaims(ctx, label, 'summary', rec.summary)
  const nodes = new Set(baseNodes)
  for (const id of idsOf(rec.buildings)) nodes.add(id)
  if (!Array.isArray(rec.buildings)) ctx.errors.push(`${label}: buildings must be an array`)
  else rec.buildings.forEach((b, n) => checkBuilding(ctx, p, b, n, true))
  if (!Array.isArray(rec.edges)) ctx.errors.push(`${label}: edges must be an array`)
  else rec.edges.forEach((e, n) => checkEdge(ctx, p, e, n, nodes))
}

const checkMaps = (ctx: Ctx, doc: Rec): void => {
  const map = (name: string, v: unknown, each: (k: string, val: unknown) => void): void => {
    if (!isRecord(v)) ctx.errors.push(`${name} must be an object`)
    else for (const k of Object.keys(v)) each(k, v[k])
  }
  map('glossary', doc.glossary, (k, v) => { if (!isStr(v)) ctx.errors.push(`glossary "${k}" must be a string`) })
  map('cargo', doc.cargo, (k, v) => {
    if (!isRecord(v)) return void ctx.errors.push(`cargo "${k}" must be an object`)
    if (!CARGO_SHAPES.has(v.shape as string)) ctx.errors.push(`cargo "${k}": shape "${String(v.shape)}" is invalid`)
    checkStr(ctx, `cargo "${k}"`, v, 'color')
    checkStr(ctx, `cargo "${k}"`, v, 'label')
  })
  map('processes', doc.processes, (k, v) => {
    if (!isRecord(v)) return void ctx.errors.push(`process "${k}" must be an object`)
    checkStr(ctx, `process "${k}"`, v, 'label')
    checkStr(ctx, `process "${k}"`, v, 'color')
  })
  map('runtimeNames', doc.runtimeNames, (k, v) => { checkStrings(ctx, `runtimeNames "${k}"`, 'value', v) })
}

const listOf = (ctx: Ctx, name: string, v: unknown, each: (item: unknown, i: number) => void): void => {
  if (!Array.isArray(v)) ctx.errors.push(`${name} must be an array`)
  else v.forEach(each)
}

export function validateWorld(doc: unknown): { ok: true; doc: WorldDoc } | { ok: false; errors: string[] } {
  if (!isRecord(doc)) return { ok: false, errors: ['world doc must be an object'] }

  const layout = doc.layout
  const layoutOk = isRecord(layout) && isNum(layout.seed) && isRecord(layout.positions)
  const ctx: Ctx = {
    errors: [],
    glossary: isRecord(doc.glossary) ? doc.glossary : {},
    positions: layoutOk ? ((layout as Rec).positions as Rec) : null,
    districtIds: new Set(idsOf(doc.districts)),
    seen: { building: new Set(), district: new Set(), edge: new Set(), external: new Set(), proposal: new Set(), tour: new Set() }
  }
  const e = ctx.errors

  if (doc.version !== 1) e.push('version must be 1')
  if (!isStr(doc.projectKey)) e.push('projectKey must be a string')
  if (!isNum(doc.generatedAt)) e.push('generatedAt must be a number')
  const rev = doc.sourceRevision
  if (!isRecord(rev) || !isStr(rev.head) || typeof rev.dirty !== 'boolean') e.push('sourceRevision must be { head: string, dirty: boolean }')
  if (!isRecord(layout)) e.push('layout must be an object')
  else {
    if (!isNum(layout.seed)) e.push('layout.seed must be a number')
    if (!isRecord(layout.positions)) e.push('layout.positions must be an object')
  }
  checkMaps(ctx, doc)

  const nodes = new Set([...idsOf(doc.buildings), ...idsOf(doc.externals)])
  listOf(ctx, 'districts', doc.districts, (d, i) => checkDistrict(ctx, d, i))
  listOf(ctx, 'buildings', doc.buildings, (b, i) => checkBuilding(ctx, '', b, i, false))
  listOf(ctx, 'edges', doc.edges, (x, i) => checkEdge(ctx, '', x, i, nodes))
  listOf(ctx, 'externals', doc.externals, (x, i) => checkExternal(ctx, x, i))
  listOf(ctx, 'tours', doc.tours, (t, i) => checkTour(ctx, t, i))

  if (!isRecord(doc.layers)) e.push('layers must be an object')
  else listOf(ctx, 'layers.plan', doc.layers.plan, (pr, i) => checkProposal(ctx, pr, i, nodes))

  return e.length ? { ok: false, errors: e } : { ok: true, doc: doc as unknown as WorldDoc }
}
