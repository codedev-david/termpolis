// Lumopolis compile: joins the pure stages (boundary detectors, grouping, test status, labelling,
// layout) into one WorldDoc, plus the coalescing recompile scheduler that drives it. Pure and
// dependency-injected: every read goes through `deps`, nothing here touches fs or Electron, and
// codeGraph is a type import only, so tree-sitter never loads in the utility process.
//
// Reads: only `snap.files` (joined onto `snap.root`), skipping ignored folders; the test-result
// reader reads the report files its own glob finds. Each file text feeds the detectors and the
// OpenTelemetry service-name scan.
import type { GraphSnapshot } from '../codeGraph'
import type { Building, District, External, Tour, WorldDoc, WorldEdge } from '../../shared/world/types'
import { detectBoundaries, MAX_DETECT_FILE_CHARS, stripComments, type Boundary } from './detectors'
import { baseKey } from './detectors/common'
import { edgeId, groupProject, isIgnored, resolveImport, slug, type GroupBuilding, type Grouping } from './group'
import { labelWorld, type BuildingLabel, type EdgeLabel, type LabelDeps, type Labels } from './label'
import { layoutWorld } from './layout'
import { readTestResults, statusFor, TEST_FILE, type TestRun } from './testStatus'

export type CompileStage = 'structure' | 'boundaries' | 'grouping' | 'status' | 'labelling' | 'layout'

export interface CompileDeps {
  /** Resolves null (or rejects) to skip a file. */
  readFile: (p: string) => Promise<string | null>
  glob: (root: string, patterns: string[]) => Promise<string[]>
  label: LabelDeps
  now: () => number
  transcriptRuns?: () => Promise<TestRun[]>
  onProgress?: (stage: CompileStage, pct: number) => void
}

export interface CompileInput {
  snap: GraphSnapshot
  projectKey: string
  head: { head: string; dirty: boolean }
  previous: WorldDoc | null
  /** Repository-relative files that changed since `previous`; only their buildings are re-labelled. */
  changed?: string[]
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
const MAX_CARGO = 40
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

function hash(s: string): number {
  let h = 2166136261
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
  return { name: b.name, techLabel: b.techLabel, how: b.how, why: b.why, stack: b.stack, floors: b.floors }
}

function edgeFromPrevious(e: WorldEdge): EdgeLabel {
  return { label: e.label, cargo: e.cargo, how: e.how, why: e.why, tech: e.tech, rate: e.rate }
}

/**
 * Full labelling, or (with a previous doc and `changed`) a re-label of only the touched buildings,
 * each in its own district so it costs one model batch, plus the edges touching them. Everything
 * else reuses the previous doc's labels by id, falling back to code-derived labels.
 */
async function labelAll(g: Grouping, previous: WorldDoc | null, changed: string[] | undefined, deps: LabelDeps): Promise<Labels> {
  if (!previous || !changed) return labelWorld(g, deps)
  const touched = new Set(changed)
  const subB = g.buildings.filter((b) => b.members.some((m) => touched.has(m)))
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
  const prevB = new Map(previous.buildings.map((b) => [b.id, b]))
  const prevE = new Map(previous.edges.map((e) => [e.id, e]))
  for (const d of g.districts) {
    const p = prevD.get(d.id)
    if (p) labels.districts[d.id] = { name: p.name, subtitle: p.subtitle }
  }
  for (const b of g.buildings) {
    const p = prevB.get(b.id)
    if (ids.has(b.id)) labels.buildings[b.id] = fresh.buildings[b.id]
    else if (p) labels.buildings[b.id] = fromPrevious(p)
  }
  for (const e of g.edges) {
    const id = edgeId(e)
    const p = prevE.get(id)
    if (touches(e)) labels.edges[id] = fresh.edges[id]
    else if (p) labels.edges[id] = edgeFromPrevious(p)
  }
  labels.glossary = { ...previous.glossary, ...fresh.glossary }
  return labels
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
        cargo: bd.key.slice(0, MAX_CARGO),
        label: `${bd.kind} ${bd.key}`.slice(0, MAX_LABEL),
        how: [],
        why: [],
        tech: [found.tech],
        rate: '',
        twoWay: false
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
    steps.push({ ids: [e], caption: labels.edges[e].label }, { ids: [n], caption: labels.buildings[n].name })
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

export async function compileWorld(input: CompileInput, deps: CompileDeps): Promise<WorldDoc> {
  const { snap, previous } = input
  const progress = (stage: CompileStage, pct: number): void => deps.onProgress?.(stage, pct)
  progress('structure', 0)

  // Boundaries and service names, from one read per file.
  const root = snap.root.replace(/\/+$/, '')
  const files = [...new Set(snap.files)].filter((f) => !isIgnored(f)).sort()
  const bounds: Boundary[] = []
  const names = new Map<string, string[]>()
  progress('boundaries', 5)
  for (let i = 0; i < files.length; i += READ_CHUNK) {
    const chunk = files.slice(i, i + READ_CHUNK)
    const texts = await Promise.all(chunk.map((f) => safeRead(deps.readFile, `${root}/${f}`)))
    chunk.forEach((f, k) => {
      const text = texts[k]
      if (text === null || text.length > MAX_DETECT_FILE_CHARS) return
      for (const b of detectBoundaries(f, text)) bounds.push(b)
      const found = serviceNames(f, text)
      if (found.length > 0) names.set(f, found)
    })
    progress('boundaries', 5 + Math.round((35 * Math.min(files.length, i + READ_CHUNK)) / files.length))
  }

  progress('grouping', 45)
  const g = groupProject(snap, bounds)

  progress('status', 55)
  const runs = await readTestResults(snap.root, { readFile: deps.readFile, glob: deps.glob, transcriptRuns: deps.transcriptRuns })
  const testsByMember = linkTests(snap, g)

  progress('labelling', 65)
  const labels = await labelAll(g, previous, input.changed, deps.label)

  progress('layout', 85)
  const glossary: Record<string, string> = { ...labels.glossary, ...BUILTIN_GLOSSARY }
  const known = (t: string): boolean => Object.prototype.hasOwnProperty.call(glossary, t)

  const districts: District[] = [...g.districts]
    .sort((a, z) => cmp(a.id, z.id))
    .map((d, i) => ({
      id: d.id,
      name: labels.districts[d.id].name,
      subtitle: labels.districts[d.id].subtitle,
      hue: Math.round((i * 137.508) % 360),
      members: d.members
    }))
  const buildings: Building[] = g.buildings.map((b) => {
    const l = labels.buildings[b.id]
    return {
      id: b.id,
      districtId: b.districtId,
      name: l.name,
      techLabel: l.techLabel,
      process: b.process,
      floors: l.floors.map((f) => ({ ...f, tech: f.tech.filter(known) })),
      stack: l.stack.filter(known),
      how: l.how,
      why: l.why,
      status: statusFor(b.members, runs, testsByMember),
      members: b.members
    }
  })
  const ext = externalsOf(g)
  const edges: WorldEdge[] = [
    ...g.edges.map((e): WorldEdge => {
      const id = edgeId(e)
      const l = labels.edges[id]
      return { id, from: e.from, to: e.to, cargo: l.cargo, label: l.label, how: l.how, tech: l.tech.filter(known), why: l.why, rate: l.rate, twoWay: false }
    }),
    ...ext.edges
  ].sort((a, z) => cmp(a.id, z.id))

  const cargo = Object.fromEntries(
    [...new Set(edges.map((e) => e.cargo).filter(Boolean))].sort().map((c) => {
      const h = hash(c)
      return [c, { shape: SHAPES[h % SHAPES.length], color: colorOf(c), label: c }]
    })
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
    layers: { plan: [] }
  }
  progress('layout', 100)
  return doc
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
