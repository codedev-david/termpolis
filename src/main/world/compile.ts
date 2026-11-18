// Lumopolis compile: joins the pure stages (boundary detectors, grouping, test status, labelling,
// layout) into one WorldDoc, plus the coalescing recompile scheduler that drives it. Pure and
// dependency-injected: every read goes through `deps`, nothing here touches fs or Electron, and
// codeGraph is a type import only, so tree-sitter never loads in the utility process.
//
// Reads: only `snap.files` (joined onto `snap.root`), skipping ignored folders; the test-result
// reader reads the report files its own glob finds. Each file text feeds the detectors, the
// OpenTelemetry service-name scan and the relative-import scan (merged into `snap.fileImports`).
// compileWorldStaged also takes the stage cache a previous compile returned: then only the changed
// files (and any the cache lacks) are read, and the grouping is reused while the structure it was
// made from is unchanged.
import type { GraphSnapshot } from '../codeGraph'
import type { Building, Claim, District, Evidence, External, Tour, WorldDoc, WorldEdge } from '../../shared/world/types'
import { detectBoundaries, MAX_DETECT_FILE_CHARS, stripComments, type Boundary } from './detectors'
import { baseKey } from './detectors/common'
import { cargoColors, cargoLabel, cargoOf } from './cargoTypes'
import { edgeSummary } from '../../shared/world/edgeText'
import { edgeId, groupProject, isIgnored, resolveImport, slug, type GroupBuilding, type Grouping } from './group'
import { mergeAnnotations } from './annotations'
import { relativeImports, withImports } from './imports'
import { BUILTIN_TECH, detectStack, packageImports, techChips } from './techStack'
import { labelWorld, type BuildingLabel, type EdgeLabel, type LabelDeps, type Labels } from './label'
import { layoutWorld } from './layout'
import { overlayPlan } from './planOverlay'
import { cleanRuntimeNames } from '../../shared/world/runtimeNames'
import { readTestResults, statusFor, TEST_FILE, testClaims, type TestRun } from './testStatus'
import { isStageCache, STAGE_CACHE_VERSION, type StageCache, type StageFile } from './stageCache'

export type CompileStage = 'structure' | 'boundaries' | 'grouping' | 'status' | 'labelling' | 'layout'

export interface CompileDeps {
  /** Resolves null (or rejects) to skip a file. Reads the test reports, and the source when there is no `readSource`. */
  readFile: (p: string) => Promise<string | null>
  /** Reads a source file for the boundary scan (null or a rejection skips it). The host caps it near
   *  MAX_DETECT_FILE_CHARS, so a huge source file is never read whole only to be dropped. */
  readSource?: (p: string) => Promise<string | null>
  glob: (root: string, patterns: string[]) => Promise<string[]>
  label: LabelDeps
  now: () => number
  transcriptRuns?: () => Promise<TestRun[]>
  /** The newest CI conclusion as runs; each run's file is a file the commit changed (compile links it to the tests of that file). Absent: none. */
  ciRuns?: () => Promise<TestRun[]>
  /** What people confirmed in the pane, by item id, merged into the claims of the buildings and lines. Absent: none. */
  annotations?: () => Promise<Record<string, Claim[]>>
  onProgress?: (stage: CompileStage, pct: number) => void
}

export interface CompileInput {
  snap: GraphSnapshot
  projectKey: string
  head: { head: string; dirty: boolean }
  previous: WorldDoc | null
  /** Repository-relative files that changed since `previous`; only their buildings are re-labelled. */
  changed?: string[]
  /** The project's linked design, laid over the world as plan versus built (planOverlay.ts). */
  plan?: WorldDoc
}

/** One plain-English line per code-derived tech word. Wins over a model's definition of the same term. */
export const BUILTIN_GLOSSARY: Readonly<Record<string, string>> = {
  IPC: "Messages passed between the app's processes",
  TCP: 'A network connection on a numbered port',
  Process: 'A separate program the app starts and talks to',
  Worker: 'A background thread that runs work off the main thread',
  Spawn: 'Starts an outside command-line program',
  'HTTP client': 'Calls a web service over HTTP',
  'HTTP server': 'Answers web requests on a port',
  Config: 'Settings read from environment variables',
  MCP: 'Model Context Protocol: tools an AI agent can call',
  Watcher: 'Watches files and reacts when they change'
}

const READ_CHUNK = 32
/** Places one "Seen in code" claim cites at most. */
const MAX_SEEN = 3
const MAX_LABEL = 120
const RING_MARGIN = 40
const RING_Y = 12
const MAX_TOUR_DEPTH = 8
/** Edge expansions the follow-request search may spend in total; dense graphs stop early. */
export const MAX_TOUR_EXPANSIONS = 50_000
const AGENT_CLIS = new Set(['claude', 'codex', 'gemini'])
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const PREFERRED_KINDS = new Set(['ipc', 'http-out', 'http-listen', 'port'])
const SHAPES = ['cube', 'sphere', 'octa', 'tetra'] as const
const PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#86bcb6']

// OpenTelemetry service names. Linear: literal anchors, one bounded character class, a backreference.
const OTEL_SOURCE =
  /(?:\bserviceName|['"]service\.name['"]|\[\s*(?:SemanticResourceAttributes\.SERVICE_NAME|ATTR_SERVICE_NAME)\s*\])\s*:\s*(['"])([^'"\r\n]{1,200})\1/g
const OTEL_ENV = /^[ \t]*(?:export[ \t]+)?OTEL_SERVICE_NAME[ \t]*=[ \t]*['"]?([^'"\s#]{1,200})/gm

const cmp = (a: string, b: string): number => Number(a > b) - Number(a < b)
const round2 = (v: number): number => Math.round(v * 100) / 100
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

function hash(s: string, seed = 2166136261): number {
  let h = seed
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const colorOf = (s: string): string => PALETTE[(hash(s) >>> 3) % PALETTE.length]

async function safeRead(read: CompileDeps['readFile'], p: string): Promise<string | null> {
  try {
    return await read(p)
  } catch {
    return null
  }
}

/** OpenTelemetry service names declared in one file (comments ignored in source files). */
export function serviceNames(file: string, text: string): string[] {
  if (baseName(file).startsWith('.env')) return [...text.matchAll(OTEL_ENV)].map((m) => m[1])
  return [...stripComments(text).matchAll(OTEL_SOURCE)].map((m) => m[2].trim()).filter(Boolean)
}

const COMPOSE = /^docker-compose.*\.ya?ml$/
const K8S_DOC = /^kind:\s*(?:Deployment|Service)\s*$/m
const K8S_NAME = /^metadata:\s*\r?\n(?:[ \t]+[^\n]*\n)*?[ \t]+name:\s*['"]?([\w.-]+)['"]?\s*$/m
/** Manifest files compile reads for runtime names: compose files, package.json and Kubernetes YAML in the usual folders. */
export const MANIFEST_PATTERNS = ['**/docker-compose*.yml', '**/docker-compose*.yaml', '**/package.json', '**/{k8s,kubernetes,deploy,manifests}/**/*.{yml,yaml}', '!**/node_modules/**']
const MAX_MANIFESTS = 300
const MAX_MANIFEST_CHARS = 256 * 1024

/**
 * The names a manifest gives its parts: the service keys of a docker-compose file, the `metadata.name` of a Kubernetes
 * Deployment or Service, the `name` of a package.json (without its @scope/). Names that do not fit are left out.
 */
export function manifestServiceNames(file: string, text: string): string[] {
  const base = baseName(file)
  let found: string[] = []
  if (base === 'package.json') {
    try {
      const name = (JSON.parse(text) as { name?: unknown } | null)?.name
      if (typeof name === 'string') found = [name.slice(name.lastIndexOf('/') + 1)]
    } catch {
      // not JSON: no name
    }
  } else if (COMPOSE.test(base)) {
    let indent = -1
    let inServices = false
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*(#.*)?$/.test(line)) continue
      const lead = line.length - line.trimStart().length
      if (lead === 0) { inServices = /^services:\s*(#.*)?$/.test(line); indent = -1; continue }
      if (!inServices) continue
      if (indent < 0) indent = lead
      const key = lead === indent ? /^\s+['"]?([\w.-]+)['"]?:\s*(#.*)?$/.exec(line) : null
      if (key) found.push(key[1])
    }
  } else {
    for (const doc of text.split(/^---\s*$/m)) {
      const name = K8S_DOC.test(doc) ? K8S_NAME.exec(doc) : null
      if (name) found.push(name[1])
    }
  }
  return cleanRuntimeNames(found)
}

/** Runtime names the manifests under the project give, by building: a manifest's names go to the building with the most members in its folder. */
async function manifestNames(deps: CompileDeps, root: string, g: Grouping): Promise<Map<string, string[]>> {
  let paths: string[]
  try {
    paths = await deps.glob(root, MANIFEST_PATTERNS)
  } catch {
    paths = []
  }
  const out = new Map<string, string[]>()
  const prefix = `${root.replace(/\\/g, '/')}/`
  for (const abs of paths.map((p) => p.replace(/\\/g, '/')).filter((p) => p.startsWith(prefix) && /(?:\.ya?ml|\/package\.json)$/.test(p) && !p.split('/').includes('node_modules')).sort().slice(0, MAX_MANIFESTS)) {
    const text = await safeRead(deps.readFile, abs)
    if (text === null || text.length > MAX_MANIFEST_CHARS) continue
    const rel = abs.slice(prefix.length)
    const names = manifestServiceNames(rel, text)
    if (names.length === 0) continue
    const dir = rel.includes('/') ? `${rel.slice(0, rel.lastIndexOf('/'))}/` : ''
    let best: { id: string; n: number } | null = null
    for (const b of g.buildings) {
      const n = b.members.filter((m) => m.startsWith(dir)).length
      if (n > 0 && (best === null || n > best.n || (n === best.n && cmp(b.id, best.id) < 0))) best = { id: b.id, n }
    }
    if (best) out.set(best.id, [...(out.get(best.id) ?? []), ...names])
  }
  return out
}

/** A CI run names a file the commit changed: a test file stands for itself, any other becomes a run of each test linked to it. */
function expandCi(runs: TestRun[], testsByMember: Record<string, string[]>): TestRun[] {
  return runs.flatMap((r) => (r.source !== 'ci' || TEST_FILE.test(r.file) ? [r] : (testsByMember[r.file] ?? []).map((file) => ({ ...r, file }))))
}

/** Test files linked to each member: tests that import it, or share its basename stem. */
function linkTests(snap: GraphSnapshot, g: Grouping): Record<string, string[]> {
  const fileSet = new Set(snap.files)
  const tests = [...fileSet].filter((f) => TEST_FILE.test(f)).sort()
  const byTarget = new Map<string, string[]>()
  const byStem = new Map<string, string[]>()
  const add = (m: Map<string, string[]>, k: string, t: string): void => void m.set(k, [...(m.get(k) ?? []), t])
  for (const t of tests) {
    for (const spec of snap.fileImports[t] ?? []) {
      const r = resolveImport(t, spec, fileSet)
      if (r !== null) add(byTarget, r, t)
    }
    add(byStem, baseName(t).replace(TEST_FILE, ''), t)
  }
  const out: Record<string, string[]> = {}
  for (const b of g.buildings) {
    for (const m of b.members) {
      const linked = new Set([...(byTarget.get(m) ?? []), ...(byStem.get(baseName(m).replace(/\.[^.]*$/, '')) ?? [])])
      if (linked.size > 0) out[m] = [...linked].sort()
    }
  }
  return out
}

function fromPrevious(b: WorldDoc['buildings'][number]): BuildingLabel {
  return { name: b.name, nameInferred: b.nameState === 'inferred', techLabel: b.techLabel, how: b.how, why: b.why, stack: b.stack, floors: b.floors }
}

function edgeFromPrevious(e: WorldEdge): EdgeLabel {
  return { label: e.label, cargo: e.cargo, how: e.how, why: e.why, tech: e.tech, rate: e.rate }
}

/**
 * Full labelling, or (with a previous doc and `changed`) a re-label of only the touched buildings
 * (a member changed, the member set differs from the previous doc's, or the building is new), each
 * in its own district so it costs one model batch, plus the edges touching them (an incoming edge
 * rides with its to building). Everything else reuses the previous doc's labels by id, falling back
 * to code-derived labels.
 */
/**
 * The buildings a change touches: a member changed, the member set differs from the previous doc's (a
 * file was deleted or moved), or the building is new. Every other building has a previous twin with
 * the same members.
 */
function touchedBuildings(g: Grouping, previous: WorldDoc, changed: string[]): GroupBuilding[] {
  const touched = new Set(changed)
  const prevB = new Map(previous.buildings.map((b) => [b.id, b]))
  const memberKey = (members: string[]): string => JSON.stringify([...members].sort())
  const sameMembers = (b: GroupBuilding): boolean => {
    const p = prevB.get(b.id)
    return p !== undefined && memberKey(p.members) === memberKey(b.members)
  }
  return g.buildings.filter((b) => b.members.some((m) => touched.has(m)) || !sameMembers(b))
}

async function labelAll(g: Grouping, previous: WorldDoc | null, changed: string[] | undefined, deps: LabelDeps): Promise<Labels> {
  if (!previous || !changed) return labelWorld(g, deps)
  const prevB = new Map(previous.buildings.map((b) => [b.id, b]))
  const subB = touchedBuildings(g, previous, changed)
  const ids = new Set(subB.map((b) => b.id))
  const dName = new Map(g.districts.map((d) => [d.id, d.name]))
  const own = (b: GroupBuilding): string => `${b.districtId}/${b.id}`
  const touches = (e: { from: string; to: string }): boolean => ids.has(e.from) || ids.has(e.to)
  const sub: Grouping = {
    districts: subB.map((b) => ({ id: own(b), name: dName.get(b.districtId) as string, members: [b.id] })),
    buildings: subB.map((b) => ({ ...b, districtId: own(b) })),
    edges: g.edges.filter(touches)
  }
  const fresh = await labelWorld(sub, deps)
  const labels = await labelWorld(g, { ...deps, llm: null })
  const prevD = new Map(previous.districts.map((d) => [d.id, d]))
  const prevE = new Map(previous.edges.map((e) => [e.id, e]))
  for (const d of g.districts) {
    const p = prevD.get(d.id)
    if (p) labels.districts[d.id] = { name: p.name, subtitle: p.subtitle }
  }
  // Every untouched building has a previous twin with the same members (a new one is touched).
  for (const b of g.buildings) {
    labels.buildings[b.id] = ids.has(b.id) ? fresh.buildings[b.id] : fromPrevious(prevB.get(b.id) as WorldDoc['buildings'][number])
  }
  for (const e of g.edges) {
    const id = edgeId(e)
    const p = prevE.get(id)
    if (touches(e)) labels.edges[id] = fresh.edges[id]
    else if (p) labels.edges[id] = edgeFromPrevious(p)
  }
  labels.glossary = { ...previous.glossary, ...fresh.glossary }
  labels.tokens = fresh.tokens
  return labels
}

const seenIn = (refs: string[]): Claim[] =>
  [refs]
    .filter((r) => r.length > 0)
    .map((r): Claim => ({ text: 'Seen in code', state: 'observed', evidence: r.slice(0, MAX_SEEN).map((ref): Evidence => ({ kind: 'file', ref })) }))

/** Where a line shows in the code: its boundaries (file:line), else the files whose imports reach the other end. */
function seenInCode(e: Grouping['edges'][number], g: Grouping, snap: GraphSnapshot): Claim[] {
  if (e.via.length > 0) return seenIn(e.via.map((v) => `${v.file}:${v.line}`))
  const files = new Set(snap.files)
  const target = new Set((g.buildings.find((b) => b.id === e.to) as GroupBuilding).members)
  const importers = (g.buildings.find((b) => b.id === e.from) as GroupBuilding).members.filter((m) =>
    (snap.fileImports[m] ?? []).some((spec) => {
      const r = resolveImport(m, spec, files)
      return r !== null && target.has(r)
    })
  )
  return seenIn([...importers].sort())
}

/** Agent CLIs and non-local web services the buildings reach, each with one conduit per building. */
function externalsOf(g: Grouping): { externals: External[]; edges: WorldEdge[] } {
  const externals = new Map<string, External>()
  const edges = new Map<string, WorldEdge>()
  for (const b of g.buildings) {
    for (const bd of b.boundaries) {
      let found: { kind: External['kind']; name: string; tech: string } | null = null
      if (bd.kind === 'spawn' && AGENT_CLIS.has(baseKey(bd.key).toLowerCase())) {
        found = { kind: 'agent', name: baseKey(bd.key).toLowerCase(), tech: 'Spawn' }
      } else if (bd.kind === 'http-out' && !LOCAL_HOSTS.has(bd.key.toLowerCase())) {
        found = { kind: 'service', name: bd.key.toLowerCase(), tech: 'HTTP client' }
      }
      if (!found) continue
      const x: External = { id: `x-${slug(found.name)}`, name: found.name, kind: found.kind, fog: false }
      if (!externals.has(x.id)) externals.set(x.id, x)
      const id = edgeId({ from: b.id, to: x.id })
      if (edges.has(id)) continue
      edges.set(id, {
        id,
        from: b.id,
        to: x.id,
        cargo: cargoOf([bd.kind]),
        label: `${bd.kind} ${bd.key}`.slice(0, MAX_LABEL),
        how: [],
        why: [],
        tech: [found.tech],
        rate: '',
        twoWay: false,
        claims: seenIn([`${bd.file}:${bd.line}`])
      })
    }
  }
  return { externals: [...externals.values()].sort((a, z) => cmp(a.id, z.id)), edges: [...edges.values()] }
}

/** Districts with their dependencies first; ties and cycles broken by id. */
function districtOrder(g: Grouping): string[] {
  const districtOf = new Map(g.buildings.map((b) => [b.id, b.districtId]))
  const ids = g.districts.map((d) => d.id).sort(cmp)
  const needs = new Map(ids.map((id) => [id, new Set<string>()]))
  for (const e of g.edges) {
    const a = districtOf.get(e.from) as string
    const b = districtOf.get(e.to) as string
    if (a !== b) (needs.get(a) as Set<string>).add(b)
  }
  const done = new Set<string>()
  const order: string[] = []
  while (order.length < ids.length) {
    const ready = ids.find((id) => !done.has(id) && [...(needs.get(id) as Set<string>)].every((x) => done.has(x)))
    const next = ready ?? (ids.find((id) => !done.has(id)) as string)
    done.add(next)
    order.push(next)
  }
  return order
}

interface Hop {
  id: string
  to: string
  pref: number
}

/** Longest simple path (depth <= 8) over boundary edges from the renderer, preferring ipc/http/port. */
function followRequest(g: Grouping, labels: Labels): Tour | null {
  const ids = g.buildings.map((b) => b.id).sort(cmp)
  const renderers = g.buildings.filter((b) => b.process === 'renderer').map((b) => b.id).sort(cmp)
  const starts = renderers.length > 0 ? renderers : ids.slice(0, 1)
  const out = new Map<string, Hop[]>()
  for (const e of g.edges) {
    if (e.via.length === 0) continue
    const hop = { id: edgeId(e), to: e.to, pref: e.via.some((v) => PREFERRED_KINDS.has(v.kind)) ? 1 : 0 }
    out.set(e.from, [...(out.get(e.from) ?? []), hop])
  }
  for (const list of out.values()) list.sort((a, z) => z.pref - a.pref || cmp(a.to, z.to))

  let best: { nodes: string[]; edges: string[]; pref: number } = { nodes: [], edges: [], pref: -1 }
  let budget = MAX_TOUR_EXPANSIONS
  const nodes: string[] = []
  const edges: string[] = []
  const visited = new Set<string>()
  let pref = 0
  const dfs = (u: string): void => {
    if (edges.length === MAX_TOUR_DEPTH) return
    for (const h of out.get(u) ?? []) {
      if (budget === 0) return
      if (visited.has(h.to)) continue
      budget--
      visited.add(h.to)
      nodes.push(h.to)
      edges.push(h.id)
      pref += h.pref
      if (edges.length > best.edges.length || (edges.length === best.edges.length && pref > best.pref)) {
        best = { nodes: [...nodes], edges: [...edges], pref }
      }
      dfs(h.to)
      pref -= h.pref
      edges.pop()
      nodes.pop()
      visited.delete(h.to)
    }
  }
  for (const s of starts) {
    nodes.push(s)
    visited.add(s)
    if (best.pref < 0) best = { nodes: [s], edges: [], pref: 0 }
    dfs(s)
    nodes.pop()
    visited.delete(s)
  }
  if (best.edges.length === 0) return null
  const steps: Tour['steps'] = [{ ids: [best.nodes[0]], caption: labels.buildings[best.nodes[0]].name }]
  best.edges.forEach((e, i) => {
    const n = best.nodes[i + 1]
    steps.push({ ids: [e], caption: edgeSummary(labels.edges[e].label) }, { ids: [n], caption: labels.buildings[n].name })
  })
  return { id: 'tour-follow-request', title: 'Follow a request', steps }
}

/** The generated tours; any with fewer than two steps is omitted. */
export function buildTours(g: Grouping, labels: Labels): Tour[] {
  const tours: Tour[] = []
  const order = districtOrder(g)
  if (order.length >= 2) {
    tours.push({
      id: 'tour-how-it-fits',
      title: 'How it fits together',
      steps: order.map((id) => ({ ids: [id], caption: labels.districts[id].subtitle || labels.districts[id].name }))
    })
  }
  const follow = followRequest(g, labels)
  if (follow) tours.push(follow)
  return tours
}

export interface StagedInput extends CompileInput {
  /** The stage cache the previous compile of this project returned; a wrong shape is ignored. */
  cache?: StageCache | null
  /** With a cache: the files to read again (default `changed`; absent both, every file is read and checked). */
  reread?: string[]
}

/** Content hash of a text: its length and two FNV-1a hashes with different seeds. */
export function contentHash(text: string): string {
  return `${text.length.toString(36)}.${hash(text).toString(36)}.${hash(text, 0x5bd1e995).toString(36)}`
}

const cmpLine = (a: Boundary, z: Boundary): number => a.line - z.line || cmp(a.kind, z.kind) || cmp(a.key, z.key) || cmp(a.side, z.side)
const cmpBoundary = (a: Boundary, z: Boundary): number => cmp(a.file, z.file) || cmpLine(a, z)
const signature = (b: Boundary): string => `${b.kind}\u0000${b.key}\u0000${b.side}`

/** What the grouping depends on: the files, their merged imports, and each file's boundary signatures in line order (lines left out). */
function structureHashOf(snap: GraphSnapshot, files: string[], entries: Map<string, StageFile>): string {
  const parts = files.map((f) => [f, [...(snap.fileImports[f] ?? [])].sort(), [...(entries.get(f)?.boundaries ?? [])].sort(cmpLine).map(signature)])
  return contentHash(JSON.stringify(parts))
}

/**
 * The previous grouping with every boundary moved to its line in the new scan. The structure hash
 * matched, so each file has the same signatures in the same line order: the k-th boundary with one
 * signature in the old scan is the k-th in the new. Each old boundary is matched once per list, so two
 * with the same signature on one line move to two places; a copy past what the old scan held is
 * dropped, and a boundary the old scan never had is kept as it is (once).
 */
function regroupLines(g: Grouping, prior: StageCache, entries: Map<string, StageFile>): Grouping {
  const fix = (list: Boundary[]): Boundary[] => {
    const used = new Set<string>()
    const out: Boundary[] = []
    for (const b of list) {
      const same = (x: Boundary): boolean => signature(x) === signature(b)
      const old = (prior.files[b.file]?.boundaries ?? []).filter(same).sort(cmpLine)
      const now = (entries.get(b.file)?.boundaries ?? []).filter(same).sort(cmpLine)
      const at = (k: number): string => `${b.file}\u0000${signature(b)}\u0000${k}`
      const lineMatches = old.map((x, k) => (x.line === b.line ? k : -1)).filter((k) => k >= 0)
      const k = lineMatches.find((i) => !used.has(at(i)))
      if (k !== undefined) {
        used.add(at(k))
        out.push(now[k] ?? b)
      } else if (lineMatches.length === 0) {
        const own = `${b.file}\u0000${signature(b)}\u0000@${b.line}`
        if (!used.has(own)) out.push(b)
        used.add(own)
      }
    }
    return out.sort(cmpBoundary)
  }
  return {
    districts: g.districts,
    buildings: g.buildings.map((b) => ({ ...b, boundaries: fix(b.boundaries) })),
    edges: g.edges.map((e) => ({ ...e, via: fix(e.via) }))
  }
}

/** The scan of one file's text, or null when it is unread or too long to scan. */
function scanFile(f: string, text: string | null): StageFile | null {
  if (text === null || text.length > MAX_DETECT_FILE_CHARS) return null
  const found = serviceNames(f, text)
  const packages = packageImports(f, text)
  return {
    hash: contentHash(text),
    boundaries: detectBoundaries(f, text),
    imports: relativeImports(f, text),
    ...(packages.length > 0 ? { packages } : {}),
    ...(found.length > 0 ? { names: found } : {})
  }
}

/** The world, as compileWorldStaged makes it, without the stage cache. */
export async function compileWorld(input: CompileInput, deps: CompileDeps): Promise<WorldDoc> {
  return (await compileWorldStaged(input, deps)).doc
}

/**
 * Compiles the world and returns the stage cache for the next compile. With a cache, only `reread`
 * (default `changed`) and the files the cache lacks are read, and every other file's scan comes from
 * the cache; with neither list every file is read and a file whose text hashes the same keeps its
 * old scan. Without a cache every file is read and scanned. The grouping is reused (its boundaries
 * moved to their new lines) while the structure hash matches, and made afresh when it moves.
 */
export async function compileWorldStaged(input: StagedInput, deps: CompileDeps): Promise<{ doc: WorldDoc; cache: StageCache }> {
  const { previous } = input
  let { snap } = input
  const progress = (stage: CompileStage, pct: number): void => deps.onProgress?.(stage, pct)
  progress('structure', 0)
  const prior = isStageCache(input.cache) ? input.cache : null

  // Boundaries, imports and service names, from one read per file that needs one.
  const root = snap.root.replace(/\/+$/, '')
  const files = [...new Set(snap.files)].filter((f) => !isIgnored(f)).sort()
  const again = new Set(input.reread ?? input.changed ?? files)
  const kept = (f: string): boolean => prior !== null && !again.has(f) && Object.hasOwn(prior.files, f)
  const entries = new Map<string, StageFile>()
  for (const f of files) if (kept(f)) entries.set(f, (prior as StageCache).files[f])
  const toRead = files.filter((f) => !kept(f))
  // Files whose text differs from the cache's (or that the cache lacks): with `changed` they are touched too,
  // so an edit a watcher never reported (made while the app was closed, or in a failed run) is re-labelled.
  const differs = new Set<string>()
  progress('boundaries', 5)
  const readSource = deps.readSource ?? deps.readFile
  for (let i = 0; i < toRead.length; i += READ_CHUNK) {
    const chunk = toRead.slice(i, i + READ_CHUNK)
    const texts = await Promise.all(chunk.map((f) => safeRead(readSource, `${root}/${f}`)))
    chunk.forEach((f, k) => {
      const text = texts[k]
      const before = prior && text !== null && Object.hasOwn(prior.files, f) ? prior.files[f] : undefined
      // The same text as last time: the old scan stands.
      const entry = before && before.hash === contentHash(text as string) ? before : scanFile(f, text)
      if (entry) entries.set(f, entry)
      if (prior && entry !== prior.files[f]) differs.add(f)
    })
    progress('boundaries', 5 + Math.round((35 * Math.min(toRead.length, i + READ_CHUNK)) / toRead.length))
  }
  const bounds: Boundary[] = []
  const names = new Map<string, string[]>()
  const scanned = new Map<string, string[]>()
  for (const f of files) {
    const e = entries.get(f)
    if (!e) continue
    bounds.push(...e.boundaries)
    if (e.imports.length > 0) scanned.set(f, e.imports)
    if (e.names) names.set(f, e.names)
  }

  // The graph's tree-sitter path keeps no import specifiers; the text's own fill the gap.
  snap = withImports(snap, scanned)
  progress('grouping', 45)
  const structureHash = structureHashOf(snap, files, entries)
  const reused = prior?.grouping !== undefined && prior.structureHash === structureHash
  const g = reused ? regroupLines(prior.grouping as Grouping, prior, entries) : groupProject(snap, bounds)
  const changed = input.changed ? [...new Set([...input.changed, ...differs])].sort() : undefined

  progress('status', 55)
  const testsByMember = linkTests(snap, g)
  const runs = expandCi(await readTestResults(snap.root, { readFile: deps.readFile, glob: deps.glob, transcriptRuns: deps.transcriptRuns, ciRuns: deps.ciRuns }), testsByMember)
  const tests = contentHash(runs.map((r) => JSON.stringify([r.file, r.passed, r.at, r.source])).sort().join('\n'))
  const cache: StageCache = { version: STAGE_CACHE_VERSION, files: Object.fromEntries(entries), structureHash, grouping: g, tests }
  // Status for the touched buildings only: with the grouping reused (so the same files, imports and test
  // links), the same test results and a previous doc, an untouched building keeps its status and claims.
  const statusScoped = reused && previous !== null && changed !== undefined && (prior as StageCache).tests === tests
  const restatus = statusScoped ? new Set(touchedBuildings(g, previous as WorldDoc, changed as string[]).map((b) => b.id)) : null
  const prevStatus = new Map((previous?.buildings ?? []).map((b) => [b.id, b]))
  const statusOf = (b: GroupBuilding): Pick<Building, 'status' | 'claims'> => {
    const p = restatus && !restatus.has(b.id) ? prevStatus.get(b.id) : undefined
    if (p) return { status: p.status, claims: p.claims.filter((c) => !c.evidence.some((e) => e.kind === 'person')) }
    return { status: statusFor(b.members, runs, testsByMember), claims: testClaims(b.members, runs, testsByMember) }
  }

  progress('labelling', 65)
  const labels = await labelAll(g, previous, changed, deps.label)

  progress('layout', 85)
  const glossary: Record<string, string> = { ...labels.glossary, ...BUILTIN_GLOSSARY }
  // Technology chips: what the code shows (extensions, imported packages) first, then the model's
  // stack, each named by its glossary key whatever its case or spelling; a term with no definition is dropped.
  const packagesOf = (f: string): string[] => [
    ...(entries.get(f)?.packages ?? []),
    ...(snap.fileImports[f] ?? []).filter((s) => !s.startsWith('.') && !s.startsWith('/'))
  ]
  const chips = (terms: string[], first: string[] = []): string[] => techChips(first, terms, glossary)

  const districts: District[] = [...g.districts]
    .sort((a, z) => cmp(a.id, z.id))
    .map((d, i) => ({
      id: d.id,
      name: labels.districts[d.id].name,
      subtitle: labels.districts[d.id].subtitle,
      hue: Math.round((i * 137.508) % 360),
      members: d.members,
      // A name the model changed is a suggestion; one still equal to the code's own is observed.
      nameState: labels.districts[d.id].name === d.name ? 'observed' : 'inferred'
    }))
  const buildings: Building[] = g.buildings.map((b) => {
    const l = labels.buildings[b.id]
    const st = statusOf(b)
    return {
      id: b.id,
      districtId: b.districtId,
      name: l.name,
      techLabel: l.techLabel,
      process: b.process,
      floors: l.floors.map((f) => ({ ...f, tech: chips(f.tech) })),
      stack: chips(l.stack, detectStack(b.members, packagesOf, { browser: b.process === 'renderer' })),
      how: l.how,
      why: l.why,
      status: st.status,
      members: b.members,
      claims: st.claims,
      nameState: l.nameInferred ? 'inferred' : 'observed'
    }
  })
  const ext = externalsOf(g)
  const edges: WorldEdge[] = [
    ...g.edges.map((e): WorldEdge => {
      const id = edgeId(e)
      const l = labels.edges[id]
      return { id, from: e.from, to: e.to, cargo: l.cargo, label: l.label, how: l.how, tech: chips(l.tech), why: l.why, rate: l.rate, twoWay: false, claims: seenInCode(e, g, snap) }
    }),
    ...ext.edges
  ].sort((a, z) => cmp(a.id, z.id))

  // The builtin definition of every technology a chip shows (it wins over a model's).
  for (const t of [...buildings.flatMap((b) => [...b.stack, ...b.floors.flatMap((f) => f.tech)]), ...edges.flatMap((e) => e.tech)]) {
    if (Object.hasOwn(BUILTIN_TECH, t)) glossary[t] = BUILTIN_TECH[t]
  }

  const cargoKeys = [...new Set(edges.map((e) => e.cargo).filter(Boolean))].sort()
  const cargoColor = cargoColors(cargoKeys)
  const cargo = Object.fromEntries(
    cargoKeys.map((c) => [c, { shape: SHAPES[hash(c) % SHAPES.length], color: cargoColor[c], label: cargoLabel(c) }])
  )
  const processes = Object.fromEntries(
    [...new Set(buildings.map((b) => b.process).filter(Boolean))].sort().map((p) => [p, { label: p, color: colorOf(p) }])
  )

  const ownerOf = new Map<string, string>()
  for (const b of g.buildings) for (const m of b.members) ownerOf.set(m, b.id)
  const runtime = new Map<string, Set<string>>()
  for (const [f, list] of names) {
    const id = ownerOf.get(f) as string
    runtime.set(id, new Set([...(runtime.get(id) ?? []), ...list]))
  }
  for (const [id, list] of await manifestNames(deps, root, g)) runtime.set(id, new Set([...(runtime.get(id) ?? []), ...list]))
  const runtimeNames = Object.fromEntries([...runtime].sort((a, z) => cmp(a[0], z[0])).map(([id, s]) => [id, [...s].sort()]))

  const layout = layoutWorld(g, previous?.layout ?? null)
  const far = g.districts.reduce((m, d) => Math.max(m, Math.hypot(layout.positions[d.id][0], layout.positions[d.id][2])), 0)
  const radius = far + RING_MARGIN
  ext.externals.forEach((x, i) => {
    const angle = (2 * Math.PI * i) / ext.externals.length
    layout.positions[x.id] = previous?.layout.positions[x.id] ?? [round2(radius * Math.cos(angle)), RING_Y, round2(radius * Math.sin(angle))]
  })

  const doc: WorldDoc = {
    version: 1,
    projectKey: input.projectKey,
    generatedAt: deps.now(),
    sourceRevision: { head: input.head.head, dirty: input.head.dirty },
    districts,
    buildings,
    edges,
    externals: ext.externals,
    glossary,
    cargo,
    processes,
    tours: buildTours(g, labels),
    layout,
    runtimeNames,
    layers: { plan: [] },
    labelTokens: labels.tokens
  }
  // Annotations are merged by item id before the plan is laid over, so a recompile never loses one.
  const merged = deps.annotations ? mergeAnnotations(doc, await deps.annotations()) : doc
  progress('layout', 100)
  return { doc: input.plan ? overlayPlan(merged, input.plan, previous) : merged, cache }
}

// ---------- recompile scheduler ----------

/**
 * Debounces file-change notifications into one run. At most one run is in flight; changes that
 * arrive during a run are coalesced into exactly one follow-up. A failed run is swallowed.
 */
export function createRecompileScheduler(
  run: (changed: string[]) => Promise<void>,
  debounceMs = 1500
): { notify(files: string[]): void; dispose(): void } {
  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let queued = false
  let disposed = false

  const start = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    queued = false
    running = true
    const files = [...pending].sort()
    pending = new Set()
    new Promise<void>((resolve) => resolve(run(files)))
      .catch(() => undefined)
      .then(() => {
        running = false
        if (queued) start()
      })
  }
  const fire = (): void => {
    timer = null
    if (running) queued = true
    else start()
  }
  return {
    notify(files) {
      if (disposed || files.length === 0) return
      for (const f of files) pending.add(f)
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(fire, debounceMs)
    },
    dispose() {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      queued = false
      pending = new Set()
    }
  }
}
