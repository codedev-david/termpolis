// Lumopolis labelling: asks a cheap model to name districts, buildings and edges and to explain
// how and why they work, one call per district. Every claim cites excerpts (E1..En) that are mapped
// back to Evidence. Replies are validated by hand and cached; with no model, or on any failure,
// names come from the code (paths, boundaries), so the world always renders.
import { createHash } from 'node:crypto'
import { makeHeadlessDistiller, type ExecFn } from '../mnemeDistiller'
import type { ExecAgent, ExecRequest, ExecResult } from '../headlessExec'
import type { ModelCatalog } from '../modelCatalog'
import { estimateTokens } from '../../shared/world/tokens'
import type { Claim, Evidence, Floor } from '../../shared/world/types'
import type { BoundaryKind } from './detectors/common'
import { cargoOf } from './cargoTypes'
import { edgeId, type GroupBuilding, type GroupEdge, type Grouping } from './group'
import { buildLabelPrompt, LABEL_PROMPT_VERSION, MAX_PROMPT_CHARS, type BatchExcerpt, type LabelBatch } from './labelPrompt'

export interface BuildingLabel {
  name: string
  /** True when the model's cited name replaced the code-derived one. */
  nameInferred: boolean
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
  /** Estimated tokens (prompt plus reply) of the model calls that missed the cache. */
  tokens: number
}

export interface LabelDeps {
  llm: ((prompt: string) => Promise<string | null>) | null
  cache: { get(h: string): Promise<string | null>; set(h: string, v: string): Promise<void> }
  excerpt: (file: string, line?: number) => Promise<string>
  /** Extra evidence for a building (commit subjects, docs lines, memory decisions), from main. Optional; a throw is ignored. */
  context?: (members: string[]) => Promise<Evidence[]>
  /** Per-excerpt cap, default 1200. */
  maxExcerptChars?: number
}

export const DEFAULT_MAX_EXCERPT_CHARS = 1200
/** Excerpt chars one batch may carry; each building of the batch gets an equal share of it. */
export const BATCH_EXCERPT_BUDGET = 24_000
/** Buildings per model call. A whole district in one call left most buildings undescribed: a big
 *  district's prompt did not fit at all, and a model asked about seven parts answered for two. */
export const BUILDINGS_PER_BATCH = 3
/** Lines described per building: its boundary lines first, then lines to other districts, then by id. */
export const EDGES_PER_BUILDING = 4
/** Model calls in flight at once. */
export const LABEL_CONCURRENCY = 4
/** One model call's limit. A batch reply takes 30 to 60 s through the Claude Code CLI. */
export const LABEL_CALL_TIMEOUT_MS = 120_000
const MAX_EXCERPTS_PER_BUILDING = 3
const MAX_FILE_EXCERPTS = 2
const MAX_FLOORS = 12
const MAX_CLAIMS = 6
const MAX_NAME = 60
const MAX_LABEL = 120
const MAX_CLAIM_TEXT = 400
const MAX_GLOSSARY = 20
const MAX_GLOSSARY_DEF = 240
const MAX_LIST = 8
const MAX_ITEM = 40
const MAX_EVIDENCE = 5
const MAX_CARGO = 40

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
    // The prompt carries repository excerpts, so it goes on stdin, never on the command line
    // (endpoint scanners read command lines; source trips their credential-signature rules).
    return makeHeadlessDistiller({ model: model ?? 'haiku', exec: deps.claudeExec, timeoutMs: LABEL_CALL_TIMEOUT_MS, promptVia: 'stdin' })
  }
  const run = deps.run
  if (!run) return async () => null
  return async (prompt) => {
    try {
      const res = await run({ task: prompt, agent, model, write: false, timeoutMs: LABEL_CALL_TIMEOUT_MS, noPrimer: true, noRemember: true })
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
  return { name: b.name, nameInferred: false, techLabel: fallbackTechLabel(b), how: [], why: [], stack: [], floors: fallbackFloors(b.members) }
}

function fallbackEdge(e: GroupEdge): EdgeLabel {
  // Every identifier, in full: the line shows a short summary of them (shared/world/edgeText.ts)
  // and its card lists them all.
  const label = e.via.length === 0 ? 'imports' : [...new Set(e.via.map((v) => `${v.kind} ${v.key}`.slice(0, MAX_LABEL)))].join(', ')
  return {
    label,
    cargo: cargoOf(e.via.map((v) => v.kind)),
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

/**
 * At most `n` characters, cut at the last word boundary with an ellipsis, so a legend line never ends
 * mid-word; one word longer than the limit is cut at it. Text that fits is kept whole.
 */
function capWords(s: string, n: number): string {
  const t = s.trim()
  if (t.length <= n) return t
  // The ellipsis takes one character; a word that ends exactly at the room's end is whole.
  const room = t.slice(0, n - 1)
  const cut = /\s/.test(t[n - 1]) ? n - 1 : room.lastIndexOf(' ')
  const head = cut > 0 ? room.slice(0, cut) : room
  return `${head.replace(/[\s,;:.\-–—]+$/, '') || room}…`
}

/** Thrown inside one entity's validation: that entity's model output is dropped wholesale. */
class Reject extends Error {}

function parseReply(raw: string): Json | null {
  // Linear fence handling (a regex here backtracked badly on long whitespace runs).
  let t = raw.trim()
  if (t.startsWith('```')) {
    t = t.slice(3).replace(/^[a-z]*/i, '')
    const close = t.lastIndexOf('```')
    if (close >= 0) t = t.slice(0, close)
  }
  try {
    const v: unknown = JSON.parse(t.trim())
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/** A field that may be absent (undefined) but, when present, must have the right type. Model output
 *  is untrusted: only OWN properties count, so nothing is ever read through a prototype. */
function field<T>(o: Json, key: string, ok: (v: unknown) => v is T): T | undefined {
  const v = own(o, key)
  if (v === undefined) return undefined
  if (!ok(v)) throw new Reject()
  return v
}

function claimsFrom(o: Json, key: string, evidenceOf: ReadonlyMap<string, Evidence>): Claim[] | undefined {
  const arr = field(o, key, isArr)
  if (!arr) return undefined
  const out: Claim[] = []
  for (const item of arr) {
    const itemText = own(item, 'text')
    const itemEvidence = own(item, 'evidence')
    if (!isStr(itemText) || !isStrArr(itemEvidence)) throw new Reject()
    const labels = [...new Set(itemEvidence)]
    const text = cap(itemText, MAX_CLAIM_TEXT)
    // A claim citing nothing, or anything outside this batch, is dropped.
    if (labels.length === 0 || text === '' || labels.some((l) => !evidenceOf.has(l))) continue
    out.push({ text, state: 'inferred', evidence: labels.slice(0, MAX_EVIDENCE).map((l) => ({ ...(evidenceOf.get(l) as Evidence) })) })
    if (out.length === MAX_CLAIMS) break
  }
  return out
}

/** The valid evidence labels a `{ value, evidence }` field cites: only labels that were in this batch's prompt count. */
function citations(raw: unknown, evidenceOf: ReadonlyMap<string, Evidence>): string[] {
  const cites = own(raw, 'evidence')
  return isStrArr(cites) ? [...new Set(cites)].filter((l) => evidenceOf.has(l)) : []
}

/** A cited text field: `{ value: string, evidence: ["E1"] }`. A bare string, a wrong type, or no valid citation: undefined
 *  (the caller keeps the code-derived value). */
function citedText(o: Json, key: string, max: number, ev: ReadonlyMap<string, Evidence>, fit: (s: string, n: number) => string = cap): string | undefined {
  return citedOf(own(o, key), max, ev, fit)
}

function citedOf(raw: unknown, max: number, ev: ReadonlyMap<string, Evidence>, fit: (s: string, n: number) => string = cap): string | undefined {
  const v = own(raw, 'value')
  if (!isStr(v) || v.trim() === '' || citations(raw, ev).length === 0) return undefined
  return fit(v, max)
}

function citedList(o: Json, key: string, ev: ReadonlyMap<string, Evidence>): string[] | undefined {
  const raw = own(o, key)
  const v = own(raw, 'value')
  return isStrArr(v) && citations(raw, ev).length > 0 ? shortList(v) : undefined
}

function shortList(v: string[]): string[] {
  return v
    .map((x) => x.trim())
    .filter((x) => x !== '' && x.length <= MAX_ITEM)
    .slice(0, MAX_LIST)
}

function validBuilding(raw: unknown, b: GroupBuilding, ev: ReadonlyMap<string, Evidence>): Partial<BuildingLabel> | null {
  try {
    if (!isObj(raw)) throw new Reject()
    const out: Record<string, unknown> = {}
    const name = citedText(raw, 'name', MAX_NAME, ev)
    if (name !== undefined) {
      out.name = name
      out.nameInferred = name !== b.name
    }
    const techLabel = citedText(raw, 'techLabel', MAX_LABEL, ev)
    if (techLabel !== undefined) out.techLabel = techLabel
    const stack = citedList(raw, 'stack', ev)
    if (stack) out.stack = stack
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
        return { name: cap(f.name, MAX_NAME), tech: shortList(f.tech), members: f.members }
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
    // The line's description and its technology chips cite an excerpt like every other field; uncited, the
    // identifiers the code found stay.
    const label = citedText(raw, 'label', MAX_LABEL, ev)
    if (label !== undefined) out.label = label
    // The cargo names a line in the legend: cut at a word, never mid-word.
    const cargo = citedText(raw, 'cargo', MAX_CARGO, ev, capWords)
    if (cargo !== undefined) out.cargo = cargo
    const rate = citedText(raw, 'rate', MAX_LABEL, ev)
    if (rate !== undefined) out.rate = rate
    const tech = citedList(raw, 'tech', ev)
    if (tech) out.tech = tech
    const how = claimsFrom(raw, 'how', ev)
    if (how) out.how = how
    const why = claimsFrom(raw, 'why', ev)
    if (why) out.why = why
    return out as Partial<EdgeLabel>
  } catch {
    return null
  }
}

function validDistrict(raw: unknown, ev: ReadonlyMap<string, Evidence>): { name?: string; subtitle?: string } | null {
  if (!isObj(raw)) return null
  const out: { name?: string; subtitle?: string } = {}
  const name = citedText(raw, 'name', MAX_NAME, ev)
  if (name !== undefined) out.name = name
  const sub = citedText(raw, 'subtitle', MAX_LABEL, ev)
  if (sub !== undefined) out.subtitle = sub
  return out
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
  // An equal share per building, so the last building of a batch has evidence to cite too.
  const share = Math.floor(BATCH_EXCERPT_BUDGET / Math.max(1, buildings.length))
  for (const b of buildings) {
    let used = 0
    const sorted = [...b.members].sort()
    const candidates: { file: string; line?: number }[] = [
      ...sorted.slice(0, MAX_FILE_EXCERPTS).map((file) => ({ file })),
      ...b.boundaries.map((x) => ({ file: x.file, line: x.line })),
      ...sorted.slice(MAX_FILE_EXCERPTS).map((file) => ({ file }))
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
      if (text.trim() === '' || used + text.length > share) continue
      used += text.length
      taken++
      const label = `E${excerpts.length + 1}`
      const ref = c.line === undefined ? c.file : boundaryRef(c.file, c.line)
      excerpts.push({ label, ref, text })
      evidence.set(label, { kind: 'file', ref, excerpt: text })
    }
    // Commits, docs and memory decisions about this building, when main supplies them. A hook that
    // throws costs only this evidence: the building is labelled from its file excerpts alone.
    if (deps.context) {
      try {
        for (const e of await deps.context(b.members)) {
          const text = (e.excerpt ?? '').slice(0, max)
          if (text.trim() === '' || used + text.length > share) continue
          used += text.length
          const label = `E${excerpts.length + 1}`
          excerpts.push({ label, ref: e.ref, text, ...(e.kind === 'file' ? {} : { kind: e.kind }) })
          evidence.set(label, { kind: e.kind, ref: e.ref, excerpt: text })
        }
      } catch {
        // file excerpts alone
      }
    }
  }
  return { excerpts, evidence }
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

// ---------- labelWorld ----------

/** A map keyed by strings that came (in part) from a model: no prototype, so a key like `__proto__`
 *  or `constructor` is just a key, never a setter or an inherited value. */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>

/** Glossary terms that would be dangerous or confusing as keys anywhere downstream: skipped. */
const RESERVED_TERMS = new Set(['__proto__', 'constructor', 'prototype'])

/** One model call: a slice of one district's buildings and the lines they own. */
interface Planned {
  district: Grouping['districts'][number]
  buildings: GroupBuilding[]
  edges: GroupEdge[]
  /** The district's first batch: the only one whose district name counts. */
  first: boolean
}

/** Splits every district into batches of BUILDINGS_PER_BATCH, each with its buildings' best lines. */
function planBatches(g: Grouping): Planned[] {
  const districtOf = new Map(g.buildings.map((b) => [b.id, b.districtId]))
  // A line rides with its from building; when from is outside this grouping (an incremental
  // re-label), with its to building. Both ends outside: not batched, the fallback is kept.
  const owned = new Map<string, GroupEdge[]>()
  for (const e of g.edges) {
    const owner = districtOf.has(e.from) ? e.from : e.to
    if (!districtOf.has(owner)) continue
    owned.set(owner, [...(owned.get(owner) ?? []), e])
  }
  const rank = (e: GroupEdge): number => (e.via.length > 0 ? 0 : districtOf.get(e.from) !== districtOf.get(e.to) ? 1 : 2)
  const best = (id: string): GroupEdge[] =>
    [...(owned.get(id) ?? [])].sort((a, z) => rank(a) - rank(z) || edgeId(a).localeCompare(edgeId(z))).slice(0, EDGES_PER_BUILDING)
  const plan: Planned[] = []
  for (const d of g.districts) {
    const buildings = g.buildings.filter((b) => b.districtId === d.id)
    // A district with no buildings is still asked once, for its name.
    for (let i = 0; i === 0 || i < buildings.length; i += BUILDINGS_PER_BATCH) {
      const slice = buildings.slice(i, i + BUILDINGS_PER_BATCH)
      plan.push({ district: d, buildings: slice, edges: slice.flatMap((b) => best(b.id)), first: i === 0 })
    }
  }
  return plan
}

/** Runs `fn` over `items` with at most `n` in flight; results keep the items' order. `fn` never rejects. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

/** One batch's own labels (only what its reply set) and the tokens its call cost. */
async function labelBatch(p: Planned, deps: LabelDeps, llm: (prompt: string) => Promise<string | null>): Promise<Labels> {
  const out: Labels = { districts: dict(), buildings: dict(), edges: dict(), glossary: dict(), tokens: 0 }
  const { buildings } = p
  const { excerpts, evidence } = await collectExcerpts(buildings, deps)
  const mk = (): LabelBatch => ({
    district: { id: p.district.id, name: p.district.name },
    buildings: buildings.map((b) => ({
      id: b.id,
      name: b.name,
      members: b.members,
      boundaries: b.boundaries.map((x) => `${x.kind} ${x.key} (${x.side})`)
    })),
    edges: p.edges.map((e) => ({ id: edgeId(e), from: e.from, to: e.to, via: e.via.map((v) => `${v.kind} ${v.key}`) })),
    excerpts
  })
  let batch = mk()
  let prompt = buildLabelPrompt(batch)
  // A batch's listed files, boundaries and lines are capped, so dropping excerpts from the end
  // always brings it under the cap.
  while (prompt.length > MAX_PROMPT_CHARS && excerpts.length > 0) {
    evidence.delete((excerpts.pop() as BatchExcerpt).label)
    batch = mk()
    prompt = buildLabelPrompt(batch)
  }
  const key = sha(`${LABEL_PROMPT_VERSION}\n${prompt}`)

  try {
    const hit = await deps.cache.get(key)
    const cached = hit === null ? null : parseReply(hit)
    if (cached && applyReply(out, cached, batch, buildings, evidence) > 0) return out
  } catch {
    // a broken cache is a miss
  }
  let raw: string | null = null
  try {
    raw = await llm(prompt)
  } catch {
    raw = null
  }
  // The call was made, so its prompt counts even when nothing came back.
  out.tokens += estimateTokens(prompt) + estimateTokens(raw ?? '')
  const reply = raw === null ? null : parseReply(raw)
  // Only a reply that yielded at least one accepted field is worth caching.
  if (!reply || applyReply(out, reply, batch, buildings, evidence) === 0) return out
  try {
    await deps.cache.set(key, raw as string)
  } catch {
    // an unwritable cache only costs a repeat call next time
  }
  return out
}

export async function labelWorld(g: Grouping, deps: LabelDeps): Promise<Labels> {
  const labels: Labels = { districts: dict(), buildings: dict(), edges: dict(), glossary: dict(), tokens: 0 }
  for (const d of g.districts) labels.districts[d.id] = { name: d.name, subtitle: '' }
  for (const b of g.buildings) labels.buildings[b.id] = fallbackBuilding(b)
  for (const e of g.edges) labels.edges[edgeId(e)] = fallbackEdge(e)
  const llm = deps.llm
  if (!llm) return labels

  const plan = planBatches(g)
  const results = await pool(plan, LABEL_CONCURRENCY, (p) => labelBatch(p, deps, llm))
  // Merged in batch order whatever order the calls finished in, so the world is the same every run:
  // a district takes its first batch's name, and the first batch to define a glossary term wins.
  results.forEach((r, i) => {
    const d = plan[i].district.id
    if (plan[i].first && Object.hasOwn(r.districts, d)) labels.districts[d] = { ...labels.districts[d], ...r.districts[d] }
    for (const [id, v] of Object.entries(r.buildings)) labels.buildings[id] = { ...labels.buildings[id], ...v }
    for (const [id, v] of Object.entries(r.edges)) labels.edges[id] = { ...labels.edges[id], ...v }
    for (const [term, def] of Object.entries(r.glossary)) if (!Object.hasOwn(labels.glossary, term)) labels.glossary[term] = def
    labels.tokens += r.tokens
  })
  return labels
}

function own(o: unknown, key: string): unknown {
  return isObj(o) && Object.hasOwn(o, key) ? o[key] : undefined
}

/** Number of non-empty model fields kept (an all-dropped claim list is not a field). */
function countFields(v: object): number {
  return Object.values(v).filter((x) => !(Array.isArray(x) && x.length === 0)).length
}

function applyReply(
  labels: Labels,
  reply: Json,
  batch: LabelBatch,
  buildings: GroupBuilding[],
  evidence: ReadonlyMap<string, Evidence>
): number {
  let accepted = 0
  const dist = validDistrict(own(reply, 'district'), evidence)
  if (dist) {
    labels.districts[batch.district.id] = { ...labels.districts[batch.district.id], ...dist }
    accepted += countFields(dist)
  }
  for (const b of buildings) {
    const raw = own(reply.buildings, b.id)
    if (raw === undefined) continue
    const v = validBuilding(raw, b, evidence)
    if (v) {
      labels.buildings[b.id] = { ...labels.buildings[b.id], ...v }
      accepted += countFields(v)
    }
  }
  for (const e of batch.edges) {
    const raw = own(reply.edges, e.id)
    if (raw === undefined) continue
    const v = validEdge(raw, evidence)
    if (v) {
      labels.edges[e.id] = { ...labels.edges[e.id], ...v }
      accepted += countFields(v)
    }
  }
  const glossary = own(reply, 'glossary')
  if (isObj(glossary)) {
    let n = 0
    for (const [term, def] of Object.entries(glossary)) {
      if (n === MAX_GLOSSARY) break
      // A definition citing no excerpt of this batch is dropped: there is no code-derived glossary value to keep.
      const text = citedOf(def, MAX_GLOSSARY_DEF, evidence)
      if (text === undefined || term.trim() === '') continue
      const k = cap(term, MAX_NAME)
      if (RESERVED_TERMS.has(k)) continue
      n++
      if (!Object.hasOwn(labels.glossary, k)) {
        labels.glossary[k] = text
        accepted++
      }
    }
  }
  return accepted
}
