// Lumopolis labelling: asks a cheap model to name districts, buildings and edges and to explain
// how and why they work, one call per district. Every claim cites excerpts (E1..En) that are mapped
// back to Evidence. Replies are validated by hand and cached; with no model, or on any failure,
// names come from the code (paths, boundaries), so the world always renders.
import { createHash } from 'node:crypto'
import { makeHeadlessDistiller, type ExecFn } from '../mnemeDistiller'
import type { ExecAgent, ExecRequest, ExecResult } from '../headlessExec'
import type { ModelCatalog } from '../modelCatalog'
import { estimateTokens } from '../../shared/world/tokens'
import type { Claim, Evidence, EvidenceKind, Floor } from '../../shared/world/types'
import type { BoundaryKind } from './detectors/common'
import { cargoOf } from './cargoTypes'
import { edgeId, type GroupBuilding, type GroupEdge, type Grouping } from './group'
import {
  buildLabelPrompt,
  FULL_FIT,
  LABEL_PROMPT_VERSION,
  MAX_PROMPT_CHARS,
  promptCommandChars,
  SHORT_FIT,
  type BatchEnd,
  type BatchExcerpt,
  type LabelBatch,
  type PromptFit
} from './labelPrompt'

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
  /** One model call. `started`, when the runner calls it, marks the moment the call really began: a call that waits for
   *  a slot behind other worlds' calls (main's llmGate) is timed from then, never through its wait. A runner that never
   *  calls it is timed from the ask. */
  llm: ((prompt: string, started?: () => void) => Promise<string | null>) | null
  cache: { get(h: string): Promise<string | null>; set(h: string, v: string): Promise<void> }
  excerpt: (file: string, line?: number) => Promise<string>
  /** Extra evidence for a building (commit subjects, docs lines, memory decisions), from main. Optional; a throw is ignored. */
  context?: (members: string[]) => Promise<Evidence[]>
  /** Per-excerpt cap, default 1200. */
  maxExcerptChars?: number
  /** The most command chars one prompt may take, default MAX_PROMPT_CHARS. */
  maxPromptChars?: number
  /** A part outside the grouping being labelled (an incremental re-label's untouched end of a line): its name and
   *  files, so a line-only batch can say what that end is. Optional; without it the end is named by its id. */
  part?: (id: string) => BatchEnd | undefined
  /** The clock a model call is timed with, in ms (default performance.now: monotonic, so a laptop that
   *  sleeps or a clock that is set mid-call does not make a quick failure look like a timeout). */
  now?: () => number
  /** True once the world was removed: the pass asks nothing more, and a call cut short by the removal is neither a
   *  quick failure nor asked again. Optional (never stopped). */
  stopped?: () => boolean
}

export const DEFAULT_MAX_EXCERPT_CHARS = 1200
/** Excerpt chars one batch may carry; each building of the batch gets an equal share of it. */
export const BATCH_EXCERPT_BUDGET = 24_000
/** Buildings per model call. A whole district in one call left most buildings undescribed: a big
 *  district's prompt did not fit at all, and a model asked about seven parts answered for two. */
export const BUILDINGS_PER_BATCH = 3
/** Lines described per building: its boundary lines first, then lines to other districts, then by id. */
export const EDGES_PER_BUILDING = 4
/** Lines per line-only batch: every line no building batch carried. Ten lines through two boundaries each, with
 *  real code excerpts in full (LINE_BATCH_EXCERPT_BUDGET), measure 19,145 command chars (worldLabel.test.ts),
 *  well under MAX_PROMPT_CHARS. Quote-heavy excerpts or long names drop second excerpts first; a batch that does
 *  not fit with each line's first excerpt is asked in halves. */
export const LINES_PER_BATCH = 10
/** Excerpts per line of a line-only batch: its boundaries, or for an import the importing file and the imported part's first file. */
const MAX_EXCERPTS_PER_LINE = 2
/** Excerpt chars a full line-only batch carries at most: every line's excerpts at LINE_EXCERPT_CHARS. */
export const LINE_BATCH_EXCERPT_BUDGET = 14_000
/** Per-excerpt cap in a line-only batch (the lines around a boundary, or the head of a file with its imports): an
 *  equal share of LINE_BATCH_EXCERPT_BUDGET per excerpt of a full batch. */
export const LINE_EXCERPT_CHARS = LINE_BATCH_EXCERPT_BUDGET / (LINES_PER_BATCH * MAX_EXCERPTS_PER_LINE)
/** Model calls in flight at once. */
export const LABEL_CONCURRENCY = 4
/** One model call's limit. A batch reply takes 30 to 60 s through the Claude Code CLI. */
export const LABEL_CALL_TIMEOUT_MS = 120_000
/** A call that brought nothing back after this long ran until it timed out (main's limit, or the host's):
 *  the model is slow or overloaded, so it is not asked again at once. A failure that came back sooner is. */
export const LABEL_SLOW_FAIL_MS = 30_000
/** A call that brought nothing back within this long reached no model (no agent, consent off, a refusal before
 *  any spawn): it costs no tokens. One that took longer reached a model process, and its prompt counts. Starting
 *  an agent CLI takes seconds, while a refusal is one IPC round trip to main: a second leaves room for a busy main
 *  (typing lag, a slow CI runner) without counting a refusal as spend. */
export const LABEL_NO_MODEL_MS = 1000
/** Calls that reached no model, with none reaching one, after which a pass stops asking: no agent is installed or
 *  consent is off, and every further call would be one more spawn or refusal for nothing. */
export const NO_MODEL_STRIKES = 2
const MAX_EXCERPTS_PER_BUILDING = 3
/** Files of a line's from part read to find the one that imports its to part. */
const MAX_IMPORTER_SCAN = 12
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

/** A file to excerpt: its head, or the lines around `line`. */
interface Candidate {
  file: string
  line?: number
}

/**
 * Reads candidates in order into `excerpts` (E-labelled in order) until `limit` are taken, skipping a read that
 * throws, an empty one, and one past `share` chars in all; returns the chars taken.
 */
async function takeExcerpts(candidates: Candidate[], limit: number, share: number, deps: LabelDeps, excerpts: BatchExcerpt[]): Promise<number> {
  const max = deps.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS
  let used = 0
  let taken = 0
  for (const c of candidates) {
    if (taken === limit) break
    let text: string
    try {
      text = (c.line === undefined ? await deps.excerpt(c.file) : await deps.excerpt(c.file, c.line)).slice(0, max)
    } catch {
      continue
    }
    if (text.trim() === '' || used + text.length > share) continue
    used += text.length
    taken++
    excerpts.push({ label: `E${excerpts.length + 1}`, ref: c.line === undefined ? c.file : boundaryRef(c.file, c.line), text })
  }
  return used
}

/** Up to 3 excerpts per building (first 2 files in sorted order, then first boundaries), E-labelled in order. */
async function collectExcerpts(buildings: GroupBuilding[], deps: LabelDeps): Promise<BatchExcerpt[]> {
  const max = deps.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS
  const excerpts: BatchExcerpt[] = []
  // An equal share per building, so the last building of a batch has evidence to cite too.
  const share = Math.floor(BATCH_EXCERPT_BUDGET / Math.max(1, buildings.length))
  for (const b of buildings) {
    const sorted = [...b.members].sort()
    const candidates: Candidate[] = [
      ...sorted.slice(0, MAX_FILE_EXCERPTS).map((file) => ({ file })),
      ...b.boundaries.map((x) => ({ file: x.file, line: x.line })),
      ...sorted.slice(MAX_FILE_EXCERPTS).map((file) => ({ file }))
    ]
    let used = await takeExcerpts(candidates, MAX_EXCERPTS_PER_BUILDING, share, deps, excerpts)
    // Commits, docs and memory decisions about this building, when main supplies them. A hook that
    // throws costs only this evidence: the building is labelled from its file excerpts alone.
    if (deps.context) {
      try {
        for (const e of await deps.context(b.members)) {
          const text = (e.excerpt ?? '').slice(0, max)
          if (text.trim() === '' || used + text.length > share) continue
          used += text.length
          excerpts.push({ label: `E${excerpts.length + 1}`, ref: e.ref, text, ...(e.kind === 'file' ? {} : { kind: e.kind }) })
        }
      } catch {
        // file excerpts alone
      }
    }
  }
  return excerpts
}

/** A file's name without its extension; an `index` file is named by its folder ('' at the root). */
function stemOf(file: string): string {
  const parts = file.split('/')
  const base = (parts.pop() as string).replace(/\.[^.]*$/, '')
  return base === 'index' ? (parts.pop() ?? '') : base
}

/**
 * The from part's file that imports the to part: the first (sorted, of the first MAX_IMPORTER_SCAN) whose head
 * names a to file's stem as the last segment of a path. None found: the from part's first file, which an
 * import line's card would cite anyway. Undefined only for an end outside the grouping (no files).
 */
async function importerOf(from: string[], to: string[], read: Read): Promise<string | undefined> {
  const stems = [...new Set(to.map(stemOf))].filter((s) => s !== '')
  if (stems.length > 0) {
    for (const file of from.slice(0, MAX_IMPORTER_SCAN)) {
      let text: string
      try {
        text = await read(file)
      } catch {
        continue
      }
      if (stems.some((s) => ["'", '"', '.', '`'].some((q) => text.includes(`/${s}${q}`)))) return file
    }
  }
  return from[0]
}

/** An excerpt read; a line-only batch reads each file's head once (its lines' importer scans share files). */
type Read = (file: string, line?: number) => Promise<string>

/** What shows a line: the boundaries it runs through; an import line, the file that imports and the to part's first file. */
async function lineCandidates(e: GroupEdge, partOf: (id: string) => BatchEnd | undefined, read: Read): Promise<Candidate[]> {
  if (e.via.length > 0) return e.via.map((v) => ({ file: v.file, line: v.line }))
  const from = [...(partOf(e.from)?.members ?? [])].sort()
  const to = [...(partOf(e.to)?.members ?? [])].sort()
  const importer = await importerOf(from, to, read)
  return [...(importer === undefined ? [] : [{ file: importer }]), ...to.slice(0, 1).map((file) => ({ file }))]
}

/**
 * Up to MAX_EXCERPTS_PER_LINE excerpts per line of a line-only batch, each at most LINE_EXCERPT_CHARS, each ref once,
 * so at most LINE_BATCH_EXCERPT_BUDGET in all. Taken in rounds: every line's first excerpt, then every
 * line's second. The first `core` excerpts are the first round: trimming to fit drops second excerpts only, so every
 * line that has an excerpt keeps one of its own.
 */
async function collectLineExcerpts(
  edges: GroupEdge[],
  partOf: (id: string) => BatchEnd | undefined,
  deps: LabelDeps
): Promise<{ excerpts: BatchExcerpt[]; core: number }> {
  const max = Math.min(deps.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS, LINE_EXCERPT_CHARS)
  const heads = new Map<string, Promise<string>>()
  const read: Read = (file, line) => {
    if (line !== undefined) return deps.excerpt(file, line)
    const known = heads.get(file)
    if (known) return known
    const text = deps.excerpt(file)
    heads.set(file, text)
    return text
  }
  const queues: Candidate[][] = []
  for (const e of edges) queues.push(await lineCandidates(e, partOf, read))
  const excerpts: BatchExcerpt[] = []
  const seen = new Set<string>()
  const at = edges.map(() => 0)
  let core = 0
  for (let round = 0; round < MAX_EXCERPTS_PER_LINE; round++) {
    for (let i = 0; i < queues.length; i++) {
      while (at[i] < queues[i].length) {
        const c = queues[i][at[i]++]
        const ref = c.line === undefined ? c.file : boundaryRef(c.file, c.line)
        if (seen.has(ref)) continue
        let text: string
        try {
          text = (await read(c.file, c.line)).slice(0, max)
        } catch {
          continue
        }
        if (text.trim() === '') continue
        seen.add(ref)
        excerpts.push({ label: `E${excerpts.length + 1}`, ref, text })
        break
      }
    }
    if (round === 0) core = excerpts.length
  }
  return { excerpts, core }
}

/** One end of a line in a line-only batch; an end nothing knows is named by its id alone. */
function endOf(partOf: (id: string) => BatchEnd | undefined, id: string): BatchEnd {
  const b = partOf(id)
  return b ? { name: b.name, members: b.members } : { name: id, members: [] }
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

const emptyLabels = (): BatchResult => ({ districts: dict(), buildings: dict(), edges: dict(), glossary: dict(), tokens: 0 })

/** One model call: a slice of one district's buildings and the lines they own, or (with `parts`) lines alone. */
interface Planned {
  district: Grouping['districts'][number]
  buildings: GroupBuilding[]
  edges: GroupEdge[]
  /** The district's first batch: the only one whose district name counts. */
  first: boolean
  /** Set for a line-only batch (no buildings): every part of the grouping by id, to say what each line's ends are. */
  parts?: ReadonlyMap<string, GroupBuilding>
}

/**
 * Splits every district into batches of BUILDINGS_PER_BATCH, each with its buildings' EDGES_PER_BUILDING best
 * lines; then the district's other lines go in line-only batches of LINES_PER_BATCH, after every building batch.
 */
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
  const ranked = (id: string): GroupEdge[] => [...(owned.get(id) ?? [])].sort((a, z) => rank(a) - rank(z) || edgeId(a).localeCompare(edgeId(z)))
  const parts = new Map(g.buildings.map((b) => [b.id, b]))
  const plan: Planned[] = []
  const lines: Planned[] = []
  for (const d of g.districts) {
    const buildings = g.buildings.filter((b) => b.districtId === d.id)
    const own = buildings.map((b) => ranked(b.id))
    // A district with no buildings is still asked once, for its name.
    for (let i = 0; i === 0 || i < buildings.length; i += BUILDINGS_PER_BATCH) {
      const edges = own.slice(i, i + BUILDINGS_PER_BATCH).flatMap((x) => x.slice(0, EDGES_PER_BUILDING))
      plan.push({ district: d, buildings: buildings.slice(i, i + BUILDINGS_PER_BATCH), edges, first: i === 0 })
    }
    const rest = own.flatMap((x) => x.slice(EDGES_PER_BUILDING))
    for (let i = 0; i < rest.length; i += LINES_PER_BATCH) lines.push({ district: d, buildings: [], edges: rest.slice(i, i + LINES_PER_BATCH), first: false, parts })
  }
  return [...plan, ...lines]
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

/** One batch's labels; `failed`: a call brought back no reply it could read. 'retry': it threw or returned
 *  nothing in under LABEL_SLOW_FAIL_MS, or its reply was not JSON, so the batch is worth asking again; 'later': it
 *  ran until it timed out, or no model is reachable this pass (it was not sent), so it is not asked again this pass. */
interface BatchResult extends Labels { failed?: 'retry' | 'later' }

/** One labelling pass: the model call, and what its calls so far showed. */
interface Pass {
  llm: (prompt: string, started?: () => void) => Promise<string | null>
  /** Cache keys of every prompt sent to the model this pass. The second chance never sends one again: a batch of
   *  one building or one line, or a half already asked twice, cannot get smaller. */
  sent: Set<string>
  /** Calls that came back with nothing within LABEL_NO_MODEL_MS (they reached no model). */
  quick: number
  /** Some call reached a model: it answered, or took longer than LABEL_NO_MODEL_MS. */
  reached: boolean
  /** Second-chance batches not sent because their prompt was already sent this pass. */
  repeats: number
  /** The world was removed (LabelDeps.stopped). */
  stopped: () => boolean
}

/** No model is reachable: NO_MODEL_STRIKES calls reached none, and none reached one. The pass stops asking. */
const noModel = (pass: Pass): boolean => !pass.reached && pass.quick >= NO_MODEL_STRIKES
/** The pass asks nothing more: no model is reachable, or the world was removed. */
const halted = (pass: Pass): boolean => pass.stopped() || noModel(pass)

/** One batch's own labels (only what its reply set) and the tokens its call cost. `second`: a second-chance batch,
 *  not sent when the same prompt was already sent this pass. */
async function labelBatch(p: Planned, deps: LabelDeps, pass: Pass, second = false): Promise<BatchResult> {
  const out = emptyLabels()
  const { buildings, parts } = p
  const partOf = (id: string): BatchEnd | undefined => parts?.get(id) ?? deps.part?.(id)
  const { excerpts: all, core } = parts ? await collectLineExcerpts(p.edges, partOf, deps) : { excerpts: await collectExcerpts(buildings, deps), core: 0 }
  const mk = (excerpts: BatchExcerpt[]): LabelBatch => ({
    district: { id: p.district.id, name: p.district.name },
    buildings: buildings.map((b) => ({
      id: b.id,
      name: b.name,
      members: b.members,
      boundaries: b.boundaries.map((x) => `${x.kind} ${x.key} (${x.side})`)
    })),
    edges: p.edges.map((e) => ({
      id: edgeId(e),
      from: e.from,
      to: e.to,
      via: e.via.map((v) => `${v.kind} ${v.key}`),
      ...(parts ? { ends: { from: endOf(partOf, e.from), to: endOf(partOf, e.to) } } : {})
    })),
    excerpts
  })
  const cap = deps.maxPromptChars ?? MAX_PROMPT_CHARS
  // Excerpts are dropped from the end until the prompt fits, down to the first `keep`.
  const fitWith = (fit: PromptFit, keep: number): { batch: LabelBatch; prompt: string; over: boolean } => {
    const excerpts = [...all]
    for (;;) {
      const batch = mk(excerpts)
      const prompt = buildLabelPrompt(batch, fit)
      const over = promptCommandChars(prompt) > cap
      if (!over || excerpts.length <= keep) return { batch, prompt, over }
      excerpts.pop()
    }
  }
  // A line-only batch keeps each line's first excerpt (`core`): a line with none of its own could not be described.
  let fitted = fitWith(FULL_FIT, core)
  // Still too big (long or quote-heavy names, a long file list, or a line batch's first excerpts): its halves are
  // asked instead, down to one building or one line, which is listed short (SHORT_FIT) with its excerpts back. One
  // building or one line fits that way even at the true worst (worldLabel.test.ts, M6); the size is checked again
  // after shortening, and a part still over (a lower maxPromptChars, or a later change) is not sent: the warning
  // names it.
  if (fitted.over) {
    if ((parts ? p.edges.length : buildings.length) > 1) return labelHalves(p, deps, pass, second)
    fitted = fitWith(SHORT_FIT, 0)
    if (fitted.over) {
      console.warn(`[world label] too big to ask even listed short: ${[...buildings.map((b) => b.id), ...p.edges.map(edgeId)].join(', ')}`)
      return out
    }
  }
  const { batch, prompt } = fitted
  const evidence = new Map<string, Evidence>(batch.excerpts.map((x) => [x.label, { kind: (x.kind ?? 'file') as EvidenceKind, ref: x.ref, excerpt: x.text }]))
  const key = sha(`${LABEL_PROMPT_VERSION}\n${prompt}`)
  // A line-only batch lists no buildings, so the district it is filed under is not its to name.
  const named = !parts
  // A reply counts when it described at least one part the batch asked about (a building or a line); a batch that
  // asks about none (a district with no buildings) counts any accepted field. One that described none of its parts
  // is not cached, and a cached one like it is a miss: its parts are asked again rather than hidden by the cache.
  const counts = (into: BatchResult, reply: Json): boolean =>
    applyReply(into, reply, batch, buildings, evidence, named) > 0 &&
    (buildings.length + p.edges.length === 0 || Object.keys(into.buildings).length + Object.keys(into.edges).length > 0)

  try {
    const hit = await deps.cache.get(key)
    const cached = hit === null ? null : parseReply(hit)
    const fromCache = emptyLabels()
    if (cached && counts(fromCache, cached)) return fromCache
  } catch {
    // a broken cache is a miss
  }
  if (second && pass.sent.has(key)) {
    pass.repeats++
    return out
  }
  if (halted(pass)) return { ...out, failed: 'later' }
  pass.sent.add(key)
  const clock = deps.now ?? (() => performance.now())
  // Timed from when the call began (LABEL_SLOW_FAIL_MS, LABEL_NO_MODEL_MS), never through a wait for a slot.
  let started = clock()
  let raw: string | null = null
  try {
    raw = await pass.llm(prompt, () => {
      started = clock()
    })
  } catch {
    raw = null
  }
  const took = clock() - started
  const timedOut = raw === null && took >= LABEL_SLOW_FAIL_MS
  // Tokens count for a call that reached a model: one that answered, or one that took longer than
  // LABEL_NO_MODEL_MS (the prompt alone). Nothing back at once (no agent, consent off) reached no model and costs nothing.
  if (raw !== null || took > LABEL_NO_MODEL_MS) {
    pass.reached = true
    out.tokens += estimateTokens(prompt) + estimateTokens(raw ?? '')
  } else if (!pass.stopped()) pass.quick++
  const reply = raw === null ? null : parseReply(raw)
  if (!reply) return { ...out, failed: timedOut || pass.stopped() ? 'later' : 'retry' }
  // A reply that counts is cached even if it left parts out: those get the second chance in smaller batches,
  // whose prompts differ and are cached on their own. The second chance is worked out from the reply whether it
  // came from the model or the cache, so every pass asks a left-out part again until it is described. A reply
  // that described none of its parts is not cached; its parts get the second chance too.
  if (!counts(out, reply)) return out
  try {
    await deps.cache.set(key, raw as string)
  } catch {
    // an unwritable cache only costs a repeat call next time
  }
  return out
}

/** A batch of `buildings` of `p`, with the lines of `p` they own: a line rides with its from building when that
 *  is in the batch, else with its to building. */
function subPlan(p: Planned, buildings: GroupBuilding[], first: boolean): Planned {
  const all = new Set(p.buildings.map((b) => b.id))
  const ids = new Set(buildings.map((b) => b.id))
  return { district: p.district, buildings, edges: p.edges.filter((e) => ids.has(e.from) || (!all.has(e.from) && ids.has(e.to))), first }
}

/** Labels a batch too big for one prompt as two smaller ones (its buildings, or a line-only batch's lines, cut in
 *  two), one after the other. */
async function labelHalves(p: Planned, deps: LabelDeps, pass: Pass, second: boolean): Promise<BatchResult> {
  const cut = Math.ceil((p.parts ? p.edges : p.buildings).length / 2)
  const [first, last]: Planned[] = p.parts
    ? [{ ...p, edges: p.edges.slice(0, cut) }, { ...p, edges: p.edges.slice(cut) }]
    : [subPlan(p, p.buildings.slice(0, cut), p.first), subPlan(p, p.buildings.slice(cut), false)]
  const out = emptyLabels()
  const a = await labelBatch(first, deps, pass, second)
  merge(out, a, p.district.id)
  // The model is slow, or none is reachable: the second half would only wait as long again, or not be sent. Its
  // buildings wait for the next compile.
  if (a.failed === 'later') return { ...out, failed: 'later' }
  const b = await labelBatch(last, deps, pass, second)
  merge(out, b, null)
  // Asked again whole: the half that worked is in the cache, so only the failed half calls the model.
  // A half that timed out stops the retry: the other half's quick failure is not worth a slow call.
  const failed = b.failed === 'later' ? 'later' : (a.failed ?? b.failed)
  return failed ? { ...out, failed } : out
}

/** A batch whose call failed quickly, or whose reply was not the JSON asked for, is asked once more, straight
 *  away, in the same pass: that is usually a one-off, and otherwise its buildings keep the code's names until
 *  the next compile. One that timed out is not: its buildings wait for the next compile; nor is one when no model
 *  is reachable. Both calls' tokens count. */
async function labelWithRetry(p: Planned, deps: LabelDeps, pass: Pass): Promise<BatchResult> {
  const first = await labelBatch(p, deps, pass)
  if (first.failed !== 'retry' || halted(pass)) return first
  console.warn(`[world label] batch retried: ${p.district.name}`)
  const again = await labelBatch(p, deps, pass)
  return { ...again, tokens: again.tokens + first.tokens }
}

/**
 * The second chance, once per pass, for a batch that did not time out: its parts its reply left out (or every
 * part, when it failed twice), in smaller batches. A building batch: one batch per building left out, with the
 * lines it owns that are left out too; the lines of buildings that were described, in one line-only batch. A
 * line-only batch: its lines left out, half the batch at a time. A batch whose prompt was already sent this pass
 * (one building or one line, or a half asked twice) is not sent again (labelBatch's `second`).
 */
function secondChance(p: Planned, r: BatchResult, parts: ReadonlyMap<string, GroupBuilding>): Planned[] {
  if (r.failed === 'later') return []
  const left = p.edges.filter((e) => !Object.hasOwn(r.edges, edgeId(e)))
  const chunks = (edges: GroupEdge[], size: number): Planned[] => {
    const out: Planned[] = []
    for (let i = 0; i < edges.length; i += size) out.push({ district: p.district, buildings: [], edges: edges.slice(i, i + size), first: false, parts })
    return out
  }
  if (p.parts) return chunks(left, Math.ceil(p.edges.length / 2))
  const missing = p.buildings.filter((b) => !Object.hasOwn(r.buildings, b.id))
  const asked = new Set<GroupEdge>()
  const own = missing.map((b) => {
    const s = subPlan(p, [b], p.first && b === p.buildings[0])
    const edges = s.edges.filter((e) => left.includes(e))
    for (const e of edges) asked.add(e)
    return { ...s, edges }
  })
  return [...own, ...chunks(left.filter((e) => !asked.has(e)), LINES_PER_BATCH)]
}

/** Merges one batch's labels into `into`; `district` names the district whose name it may set, if any. The
 *  first batch to define a glossary term wins. */
function merge(into: Labels, r: Labels, district: string | null): void {
  if (district !== null && Object.hasOwn(r.districts, district)) into.districts[district] = { ...into.districts[district], ...r.districts[district] }
  for (const [id, v] of Object.entries(r.buildings)) into.buildings[id] = { ...into.buildings[id], ...v }
  for (const [id, v] of Object.entries(r.edges)) into.edges[id] = { ...into.edges[id], ...v }
  for (const [term, def] of Object.entries(r.glossary)) if (!Object.hasOwn(into.glossary, term)) into.glossary[term] = def
  into.tokens += r.tokens
}

/** A part with no how and no why claim: its card says only what the code says. */
const bare = (x: { how: Claim[]; why: Claim[] }): boolean => x.how.length === 0 && x.why.length === 0

export async function labelWorld(g: Grouping, deps: LabelDeps): Promise<Labels> {
  const labels: Labels = { districts: dict(), buildings: dict(), edges: dict(), glossary: dict(), tokens: 0 }
  for (const d of g.districts) labels.districts[d.id] = { name: d.name, subtitle: '' }
  for (const b of g.buildings) labels.buildings[b.id] = fallbackBuilding(b)
  for (const e of g.edges) labels.edges[edgeId(e)] = fallbackEdge(e)
  const llm = deps.llm
  if (!llm) return labels

  const plan = planBatches(g)
  const isStopped = deps.stopped
  const pass: Pass = { llm, sent: new Set(), quick: 0, reached: false, repeats: 0, stopped: () => isStopped?.() === true }
  const results = await pool(plan, LABEL_CONCURRENCY, (p) => labelWithRetry(p, deps, pass))
  // Merged in batch order whatever order the calls finished in, so the world is the same every run:
  // a district takes its first batch's name, and the first batch to define a glossary term wins.
  results.forEach((r, i) => merge(labels, r, plan[i].first ? plan[i].district.id : null))
  const parts = new Map(g.buildings.map((b) => [b.id, b]))
  const again = halted(pass) ? [] : plan.flatMap((p, i) => secondChance(p, results[i], parts))
  const second = await pool(again, LABEL_CONCURRENCY, (p) => labelBatch(p, deps, pass, true))
  second.forEach((r, i) => merge(labels, r, again[i].first ? again[i].district.id : null))
  // One line per pass, so a run can show how much of the map is described.
  const left = g.buildings.filter((b) => bare(labels.buildings[b.id])).length
  const leftLines = g.edges.filter((e) => bare(labels.edges[edgeId(e)])).length
  const stopped = pass.stopped() ? '; the world was removed, the rest was not asked' : noModel(pass) ? '; no model reachable, the rest was not asked' : ''
  console.info(
    `[world label] left undescribed: ${left} of ${g.buildings.length} buildings, ${leftLines} of ${g.edges.length} lines (${again.length - pass.repeats} batches asked a second time${stopped})`
  )
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
  evidence: ReadonlyMap<string, Evidence>,
  named: boolean
): number {
  let accepted = 0
  const dist = named ? validDistrict(own(reply, 'district'), evidence) : null
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
