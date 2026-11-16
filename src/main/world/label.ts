// Lumopolis labelling: asks a cheap model to name districts, buildings and edges and to explain
// how and why they work, one call per district. Every claim cites excerpts (E1..En) that are mapped
// back to Evidence. Replies are validated by hand and cached; with no model, or on any failure,
// names come from the code (paths, boundaries), so the world always renders.
import { createHash } from 'node:crypto'
import { makeHeadlessDistiller, type ExecFn } from '../mnemeDistiller'
import type { ExecAgent, ExecRequest, ExecResult } from '../headlessExec'
import type { ModelCatalog } from '../modelCatalog'
import type { Claim, Evidence, Floor } from '../../shared/world/types'
import type { BoundaryKind } from './detectors/common'
import { edgeId, type GroupBuilding, type GroupEdge, type Grouping } from './group'
import { buildLabelPrompt, LABEL_PROMPT_VERSION, type BatchExcerpt, type LabelBatch } from './labelPrompt'

export interface BuildingLabel {
  name: string
  techLabel: string
  how: Claim[]
  why: Claim[]
  stack: string[]
  floors: Floor[]
}
export interface EdgeLabel {
  label: string
  cargo: string
  how: Claim[]
  why: Claim[]
  tech: string[]
  rate: string
}
export interface Labels {
  districts: Record<string, { name: string; subtitle: string }>
  buildings: Record<string, BuildingLabel>
  /** Keyed by edgeId(). */
  edges: Record<string, EdgeLabel>
  glossary: Record<string, string>
}

export interface LabelDeps {
  llm: ((prompt: string) => Promise<string | null>) | null
  cache: { get(h: string): Promise<string | null>; set(h: string, v: string): Promise<void> }
  excerpt: (file: string, line?: number) => Promise<string>
  /** Per-excerpt cap, default 1200. */
  maxExcerptChars?: number
}

export const DEFAULT_MAX_EXCERPT_CHARS = 1200
export const BATCH_EXCERPT_BUDGET = 24_000
const MAX_EXCERPTS_PER_BUILDING = 3
const MAX_FILE_EXCERPTS = 2
const MAX_FLOORS = 12
const MAX_CLAIMS = 6
const MAX_NAME = 60
const MAX_LABEL = 120
const MAX_CLAIM_TEXT = 400
const MAX_GLOSSARY = 20
const MAX_GLOSSARY_DEF = 240

const KIND_WORD: Record<BoundaryKind, string> = {
  ipc: 'IPC',
  port: 'TCP',
  fork: 'Process',
  worker: 'Worker',
  spawn: 'Spawn',
  'http-out': 'HTTP client',
  'http-listen': 'HTTP server',
  env: 'Config',
  mcp: 'MCP',
  watch: 'Watcher'
}

// ---------- model selection ----------

/** Cheapest sensible model: haiku for claude; the first catalog id with mini (codex) or flash (gemini). */
export function cheapModelFor(agent: ExecAgent, catalog: ModelCatalog | null): string | undefined {
  if (agent === 'claude') return 'haiku'
  const needle = agent === 'codex' ? 'mini' : 'flash'
  return catalog?.[agent].models.find((m) => m.id.toLowerCase().includes(needle))?.id
}

/**
 * The labelling model call. OBLIGATION for the wiring task: the caller must pass a `claudeExec`
 * and a `run` that route through the token proxy environment exactly as headless runs do today.
 * This module neither imports index.ts nor spawns anything itself; with no `run`, codex and gemini
 * resolve null. Never throws.
 */
export function makeWorldLlm(
  agent: ExecAgent,
  model: string | undefined,
  deps: { claudeExec?: ExecFn; run?: (req: ExecRequest) => Promise<ExecResult> } = {}
): (prompt: string) => Promise<string | null> {
  if (agent === 'claude') {
    return makeHeadlessDistiller({ model: model ?? 'haiku', exec: deps.claudeExec, timeoutMs: 60_000 })
  }
  const run = deps.run
  if (!run) return async () => null
  return async (prompt) => {
    try {
      const res = await run({ task: prompt, agent, model, write: false, timeoutMs: 60_000, noPrimer: true, noRemember: true })
      const out = res.ok ? res.output.trim() : ''
      return out === '' ? null : out
    } catch {
      return null
    }
  }
}

// ---------- code-derived fallback ----------

function basename(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1)
}

function kindWords(kinds: BoundaryKind[]): string[] {
  return [...new Set(kinds.map((k) => KIND_WORD[k]))]
}

function fallbackTechLabel(b: GroupBuilding): string {
  if (b.boundaries.length > 0) return kindWords(b.boundaries.map((x) => x.kind)).slice(0, 3).join(' · ')
  const counts = new Map<string, number>()
  for (const f of b.members) {
    const base = basename(f)
    const i = base.lastIndexOf('.')
    if (i > 0) counts.set(base.slice(i + 1).toUpperCase(), (counts.get(base.slice(i + 1).toUpperCase()) ?? 0) + 1)
  }
  let best = ''
  let n = 0
  for (const [e, c] of [...counts].sort((a, z) => a[0].localeCompare(z[0]))) {
    if (c > n) {
      best = e
      n = c
    }
  }
  return best
}

function floorOf(file: string): Floor {
  const base = basename(file)
  const i = base.lastIndexOf('.')
  return { name: i > 0 ? base.slice(0, i) : base, tech: [], members: [file] }
}

function fallbackFloors(members: string[]): Floor[] {
  if (members.length <= MAX_FLOORS) return members.map(floorOf)
  return [...members.slice(0, MAX_FLOORS - 1).map(floorOf), { name: 'other', tech: [], members: members.slice(MAX_FLOORS - 1) }]
}

function fallbackBuilding(b: GroupBuilding): BuildingLabel {
  return { name: b.name, techLabel: fallbackTechLabel(b), how: [], why: [], stack: [], floors: fallbackFloors(b.members) }
}

function fallbackEdge(e: GroupEdge): EdgeLabel {
  const label = e.via.length === 0 ? 'imports' : [...new Set(e.via.map((v) => `${v.kind} ${v.key}`))].join(', ').slice(0, MAX_LABEL)
  return {
    label,
    cargo: e.via.length === 0 ? 'code' : e.via[0].key,
    how: [],
    why: [],
    tech: kindWords(e.via.map((v) => v.kind)),
    rate: ''
  }
}

// ---------- validation ----------

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isArr = (v: unknown): v is unknown[] => Array.isArray(v)
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)
const cap = (s: string, n: number): string => s.trim().slice(0, n)

/** Thrown inside one entity's validation: that entity's model output is dropped wholesale. */
class Reject extends Error {}

function parseReply(raw: string): Json | null {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(raw)
  try {
    const v: unknown = JSON.parse(fenced ? fenced[1] : raw)
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/** A field that may be absent (undefined) but, when present, must have the right type. */
function field<T>(o: Json, key: string, ok: (v: unknown) => v is T): T | undefined {
  const v = o[key]
  if (v === undefined) return undefined
  if (!ok(v)) throw new Reject()
  return v
}

function claimsFrom(o: Json, key: string, evidenceOf: ReadonlyMap<string, Evidence>): Claim[] | undefined {
  const arr = field(o, key, isArr)
  if (!arr) return undefined
  const out: Claim[] = []
  for (const item of arr) {
    if (!isObj(item) || !isStr(item.text) || !isStrArr(item.evidence)) throw new Reject()
    const labels = item.evidence
    const text = cap(item.text, MAX_CLAIM_TEXT)
    // A claim citing nothing, or anything outside this batch, is dropped.
    if (labels.length === 0 || text === '' || labels.some((l) => !evidenceOf.has(l))) continue
    out.push({ text, state: 'inferred', evidence: labels.map((l) => ({ ...(evidenceOf.get(l) as Evidence) })) })
    if (out.length === MAX_CLAIMS) break
  }
  return out
}

function textField(o: Json, key: string, max: number, into: Record<string, unknown>): void {
  const v = field(o, key, isStr)
  if (v !== undefined && v.trim() !== '') into[key] = cap(v, max)
}

function strList(o: Json, key: string, into: Record<string, unknown>): void {
  const v = field(o, key, isStrArr)
  if (v) into[key] = v.map((s) => cap(s, MAX_NAME)).filter((s) => s !== '')
}

function validBuilding(raw: unknown, b: GroupBuilding, ev: ReadonlyMap<string, Evidence>): Partial<BuildingLabel> | null {
  try {
    if (!isObj(raw)) throw new Reject()
    const out: Record<string, unknown> = {}
    textField(raw, 'name', MAX_NAME, out)
    textField(raw, 'techLabel', MAX_LABEL, out)
    strList(raw, 'stack', out)
    const how = claimsFrom(raw, 'how', ev)
    if (how) out.how = how
    const why = claimsFrom(raw, 'why', ev)
    if (why) out.why = why
    const floors = field(raw, 'floors', isArr)
    if (floors) {
      const own = new Set(b.members)
      out.floors = floors.slice(0, MAX_FLOORS).map((f): Floor => {
        if (!isObj(f) || !isStr(f.name) || !isStrArr(f.tech) || !isStrArr(f.members) || f.members.some((m) => !own.has(m))) {
          throw new Reject()
        }
        return { name: cap(f.name, MAX_NAME), tech: f.tech.map((t) => cap(t, MAX_NAME)), members: f.members }
      })
    }
    return out as Partial<BuildingLabel>
  } catch {
    return null
  }
}

function validEdge(raw: unknown, ev: ReadonlyMap<string, Evidence>): Partial<EdgeLabel> | null {
  try {
    if (!isObj(raw)) throw new Reject()
    const out: Record<string, unknown> = {}
    textField(raw, 'label', MAX_LABEL, out)
    textField(raw, 'cargo', MAX_LABEL, out)
    textField(raw, 'rate', MAX_LABEL, out)
    strList(raw, 'tech', out)
    const how = claimsFrom(raw, 'how', ev)
    if (how) out.how = how
    const why = claimsFrom(raw, 'why', ev)
    if (why) out.why = why
    return out as Partial<EdgeLabel>
  } catch {
    return null
  }
}

function validDistrict(raw: unknown): { name?: string; subtitle?: string } | null {
  try {
    if (!isObj(raw)) throw new Reject()
    const out: { name?: string; subtitle?: string } = {}
    const name = field(raw, 'name', isStr)
    if (name !== undefined && name.trim() !== '') out.name = cap(name, MAX_NAME)
    const sub = field(raw, 'subtitle', isStr)
    if (sub !== undefined) out.subtitle = cap(sub, MAX_LABEL)
    return out
  } catch {
    return null
  }
}

// ---------- batching ----------

function boundaryRef(file: string, line: number): string {
  return `${file}:${line}`
}

/** Up to 3 excerpts per building (first 2 files in sorted order, then first boundaries), E-labelled in order. */
async function collectExcerpts(
  buildings: GroupBuilding[],
  deps: LabelDeps
): Promise<{ excerpts: BatchExcerpt[]; evidence: Map<string, Evidence> }> {
  const max = deps.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS
  const excerpts: BatchExcerpt[] = []
  const evidence = new Map<string, Evidence>()
  let used = 0
  for (const b of buildings) {
    const candidates: { file: string; line?: number }[] = [
      ...[...b.members].sort().slice(0, MAX_FILE_EXCERPTS).map((file) => ({ file })),
      ...b.boundaries.map((x) => ({ file: x.file, line: x.line }))
    ]
    let taken = 0
    for (const c of candidates) {
      if (taken === MAX_EXCERPTS_PER_BUILDING) break
      let text: string
      try {
        text = (c.line === undefined ? await deps.excerpt(c.file) : await deps.excerpt(c.file, c.line)).slice(0, max)
      } catch {
        continue
      }
      if (text.trim() === '' || used + text.length > BATCH_EXCERPT_BUDGET) continue
      used += text.length
      taken++
      const label = `E${excerpts.length + 1}`
      const ref = c.line === undefined ? c.file : boundaryRef(c.file, c.line)
      excerpts.push({ label, ref, text })
      evidence.set(label, { kind: 'file', ref, excerpt: text })
    }
  }
  return { excerpts, evidence }
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

// ---------- labelWorld ----------

export async function labelWorld(g: Grouping, deps: LabelDeps): Promise<Labels> {
  const labels: Labels = { districts: {}, buildings: {}, edges: {}, glossary: {} }
  for (const d of g.districts) labels.districts[d.id] = { name: d.name, subtitle: '' }
  for (const b of g.buildings) labels.buildings[b.id] = fallbackBuilding(b)
  for (const e of g.edges) labels.edges[edgeId(e)] = fallbackEdge(e)
  const llm = deps.llm
  if (!llm) return labels

  const districtOf = new Map(g.buildings.map((b) => [b.id, b.districtId]))
  for (const d of g.districts) {
    const buildings = g.buildings.filter((b) => b.districtId === d.id)
    const edges = g.edges.filter((e) => districtOf.get(e.from) === d.id)
    const { excerpts, evidence } = await collectExcerpts(buildings, deps)
    const batch: LabelBatch = {
      district: { id: d.id, name: d.name },
      buildings: buildings.map((b) => ({
        id: b.id,
        name: b.name,
        members: b.members,
        boundaries: b.boundaries.map((x) => `${x.kind} ${x.key} (${x.side})`)
      })),
      edges: edges.map((e) => ({ id: edgeId(e), from: e.from, to: e.to, via: e.via.map((v) => `${v.kind} ${v.key}`) })),
      excerpts
    }
    const prompt = buildLabelPrompt(batch)
    const key = sha(`${LABEL_PROMPT_VERSION}\n${prompt}`)

    let reply: Json | null = null
    try {
      const hit = await deps.cache.get(key)
      if (hit !== null) reply = parseReply(hit)
    } catch {
      reply = null
    }
    if (!reply) {
      let raw: string | null = null
      try {
        raw = await llm(prompt)
      } catch {
        raw = null
      }
      if (raw === null) continue
      reply = parseReply(raw)
      if (!reply) continue
      try {
        await deps.cache.set(key, raw)
      } catch {
        // an unwritable cache only costs a repeat call next time
      }
    }
    applyReply(labels, reply, batch, buildings, evidence)
  }
  return labels
}

function own(o: unknown, key: string): unknown {
  return isObj(o) && Object.hasOwn(o, key) ? o[key] : undefined
}

function applyReply(
  labels: Labels,
  reply: Json,
  batch: LabelBatch,
  buildings: GroupBuilding[],
  evidence: ReadonlyMap<string, Evidence>
): void {
  const dist = validDistrict(reply.district)
  if (dist) labels.districts[batch.district.id] = { ...labels.districts[batch.district.id], ...dist }
  for (const b of buildings) {
    const raw = own(reply.buildings, b.id)
    if (raw === undefined) continue
    const v = validBuilding(raw, b, evidence)
    if (v) labels.buildings[b.id] = { ...labels.buildings[b.id], ...v }
  }
  for (const e of batch.edges) {
    const raw = own(reply.edges, e.id)
    if (raw === undefined) continue
    const v = validEdge(raw, evidence)
    if (v) labels.edges[e.id] = { ...labels.edges[e.id], ...v }
  }
  if (isObj(reply.glossary)) {
    let n = 0
    for (const [term, def] of Object.entries(reply.glossary)) {
      if (n === MAX_GLOSSARY) break
      if (!isStr(def) || term.trim() === '' || def.trim() === '') continue
      n++
      const k = cap(term, MAX_NAME)
      if (!Object.hasOwn(labels.glossary, k)) labels.glossary[k] = cap(def, MAX_GLOSSARY_DEF)
    }
  }
}
