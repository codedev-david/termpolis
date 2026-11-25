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
import { markTwoWay } from '../../shared/world/cardFacts'
import { domainToASCII } from 'node:url'
import { edgeId, groupProject, idSlug, isIgnored, resolveImport, shortHash, uniqueIds, type GroupBuilding, type Grouping } from './group'
import { isIndexableCodeFile } from '../codeFileFilter'
import { languageForFile } from '../codeGraphExtract'
import { mergeAnnotations } from './annotations'
import { idRenames, renameClaims, renameDoc } from './idMigration'
import { relativeImports, withImports } from './imports'
import { goModulePath, resolveLangImports, scanLangImports, type GoModule } from './langImports'
import { BUILTIN_TECH, detectStack, packageImports, techChips } from './techStack'
import { MESSAGE_PORT, MESSAGE_PORT_MEANS, portLabel, portWords, withoutUnusedOldPort } from './kindWords'
import { BUILDINGS_PER_BATCH, codeLabels, isLegacyOtherFloors, labelWorld, type BuildingLabel, type EdgeLabel, type LabelDeps, type Labels } from './label'
import { layoutWorld } from './layout'
import { overlayPlan } from './planOverlay'
import { cleanRuntimeNames } from '../../shared/world/runtimeNames'
import { readTestSources, RUNS_GRACE_MS, RUNS_WAIT_MS, statusFor, TEST_FILE, testClaims, type TestRun } from './testStatus'
import { isStageCache, STAGE_CACHE_VERSION, type StageCache, type StageFile } from './stageCache'
import { cappedReads, eachLimit, READ_CONCURRENCY } from './readCap'

export type CompileStage = 'structure' | 'boundaries' | 'grouping' | 'status' | 'labelling' | 'layout'

export interface CompileDeps {
  /** Resolves null (or rejects) to skip a file. Reads the test reports, and the source when there is no `readSource`. */
  readFile: (p: string) => Promise<string | null>
  /** Reads a source file for the boundary scan (null or a rejection skips it). The host caps it near
   *  MAX_DETECT_FILE_CHARS, so a huge source file is never read whole only to be dropped. */
  readSource?: (p: string) => Promise<string | null>
  /** `signal` aborts when the compile stops waiting for its searches (SEARCH_TIME_MS) or ends: the walk should stop. */
  glob: (root: string, patterns: string[], opts: { signal: AbortSignal }) => Promise<string[]>
  label: LabelDeps
  now: () => number
  /** Test runs from the agents' transcripts; null: main did not answer in time, so not known. Absent: none. */
  transcriptRuns?: () => Promise<TestRun[] | null>
  /** The newest CI conclusion as runs; each run's file is a file the commit changed (compile links it to the tests of that file); null: not known in time. Absent: none. */
  ciRuns?: () => Promise<TestRun[] | null>
  /** What people confirmed in the pane, by item id, merged into the claims of the buildings and lines. Absent: none. */
  annotations?: () => Promise<Record<string, Claim[]>>
  /** Copies the saved annotations of renamed parts (old id → new id) to their new ids, the old ids keeping theirs (idMigration.ts,
   *  WP5 fix I2). A rejection fails the compile, so the renamed world is not saved and the next open copies again. Absent: only
   *  this compile's copy is renamed. */
  copyAnnotations?: (renames: Record<string, string>) => Promise<void>
  onProgress?: (stage: CompileStage, pct: number) => void
  /**
   * A file's scan made from the text the snapshot already read (worldHost prescans), so a first map reads each file
   * once: a scan, or null when the text was read but has nothing to scan. Undefined: not scanned, so it is read here.
   */
  scanned?: (file: string) => StageFile | null | undefined
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
  [MESSAGE_PORT]: MESSAGE_PORT_MEANS,
  Process: 'A separate program the app starts and talks to',
  Worker: 'A background thread that runs work off the main thread',
  Spawn: 'Starts an outside command-line program',
  'HTTP client': 'Calls a web service over HTTP',
  'HTTP server': 'Answers web requests on a port',
  Config: 'Settings read from environment variables',
  MCP: 'Model Context Protocol: tools an AI agent can call',
  Watcher: 'Watches files and reacts when they change'
}

/** While a stage waits (test results, the label pass, the manifests), progress moves this often, so the
 *  pane never sits at one value while it waits. */
export const STATUS_BEAT_MS = 2000
/**
 * How long a compile waits, from its start, for its searches of the tree (test reports, manifests). Past it the
 * compile goes on with what they found by then, and the walks are told to stop. Main's transcript and CI runs keep
 * their own, longer clock (testStatus.ts RUNS_WAIT_MS + RUNS_GRACE_MS), so a slow `gh` costs only its own answer and
 * never the reports already read (fix round 3, N2).
 */
export const SEARCH_TIME_MS = 16_000
/**
 * The manifests' own budget, from the compile's start, apart from the window the file reads share. Before round 4 only
 * their listing was bound (by SEARCH_TIME_MS) and their reads, after the file reads, had no bound; round 4 put both
 * inside the window, so on a big project it cut reads that used to land (minor sweep, R4-1). Twice the window: still
 * bounded, and past it the compile goes on with the names read by then.
 */
export const MANIFEST_TIME_MS = 2 * SEARCH_TIME_MS
/** A stage that takes this long is named, with every stage's time, in one log line as the compile ends. */
export const SLOW_STAGE_MS = 5000
const STATUS_BEAT_TOP = 63
/** What one status beat adds: the 8 points from 55 to 63 spread over the longest the status stage can wait (main's
 *  asks, which start with the compile), so the bar keeps moving to the end of that wait and never sits at 63. */
const STATUS_BEAT_STEP = ((STATUS_BEAT_TOP - 55) * STATUS_BEAT_MS) / (RUNS_WAIT_MS + RUNS_GRACE_MS)
const LABEL_BEAT_TOP = 84
const MANIFEST_BEAT_TOP = 94
/** What one manifest beat adds: the 8 points from 86 to 94 spread over the manifests' whole budget, the longest the
 *  layout stage can wait on them, so the bar keeps moving to its end (minor sweep, R4-1). */
const MANIFEST_BEAT_STEP = ((MANIFEST_BEAT_TOP - 86) * STATUS_BEAT_MS) / MANIFEST_TIME_MS
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
/**
 * Progress for `done` of `total` reads, 5 to 40, in twentieths of a point: at most 700 reports a pass, and a big
 * folder read slowly (20,000 files at a dozen a second) still moves the bar every few seconds instead of holding one
 * whole percent for most of a minute (fix round 3). Used by the snapshot's reads and the compile's.
 */
export const readPct = (done: number, total: number): number => 5 + Math.floor((700 * done) / total) / 20
/** A hundredth more than `shown`, but never the next twentieth, which only a read reaches: what a beat of the reads
 *  shows when no read moved the bar since the last beat (fix round 4, M1). Four beats, then it holds below that. */
export const readBeat = (shown: number): number => Math.min(round2(shown + 0.01), round2((Math.floor(shown * 20 + 1e-6) + 1) / 20 - 0.01))
/**
 * Progress of a read stage: `read` posts readPct as the reads go, and every STATUS_BEAT_MS in which no read moved it
 * (one stuck on a slow disk, say), a beat moves it by readBeat, so the bar never sits on one value while the reads
 * run. Nothing beats below 5, where no read has posted yet. `stop` ends the beats.
 */
export function readProgress(post: (pct: number) => void, shown: number): { read: (done: number, total: number) => void; stop: () => void } {
  let moved = false
  const timer = setInterval(() => {
    const beat = readBeat(shown)
    if (!moved && shown >= 5 && beat > shown) post((shown = beat))
    moved = false
  }, STATUS_BEAT_MS)
  return {
    read: (done, total) => {
      const pct = readPct(done, total)
      if (pct <= shown) return
      moved = true
      post((shown = pct))
    },
    stop: () => clearInterval(timer)
  }
}
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
// A line's trailing \r (one or more, as a file run twice through a CRLF conversion has) is read as space.
const K8S_META = /^metadata:\s*$/
const K8S_KEY_NAME = /^name:[ \t]*['"]?([\w.-]+)['"]?\s*$/
// A `name:` with its value on the next line, as a plain scalar indented deeper.
const K8S_KEY_EMPTY = /^name:\s*$/
const K8S_SCALAR = /^['"]?([\w.-]+)['"]?\s*$/

const leadOf = (line: string): number => line.length - line.replace(/^[ \t]+/, '').length

/**
 * The `name:` of a Kubernetes document's top-level `metadata:` block: a key at the block's own indent (the smallest
 * seen so far), so a `name:` nested deeper (a label called name) is not taken. Its value is on the same line, or on
 * the next one indented deeper. Blank and comment lines are skipped, and the block ends at the first line that is
 * not indented. Each line is read once, and once more as the value of an empty `name:` above it.
 */
function k8sName(doc: string): string | null {
  const lines = doc.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!K8S_META.test(lines[i])) continue
    let indent = -1
    for (; i + 1 < lines.length; i++) {
      const line = lines[i + 1]
      const key = line.trimStart()
      if (key === '' || key.startsWith('#')) continue
      const lead = leadOf(line)
      if (lead === 0) break
      if (indent < 0 || lead < indent) indent = lead
      if (lead !== indent) continue
      const rest = line.slice(lead)
      const m = K8S_KEY_NAME.exec(rest)
      if (m) return m[1]
      const next = K8S_KEY_EMPTY.test(rest) && i + 2 < lines.length ? lines[i + 2] : ''
      const deeper = leadOf(next)
      const value = deeper > indent ? K8S_SCALAR.exec(next.slice(deeper)) : null
      if (value) return value[1]
    }
  }
  return null
}

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
      const name = K8S_DOC.test(doc) ? k8sName(doc) : null
      if (name) found.push(name)
    }
  }
  return cleanRuntimeNames(found)
}

/** Manifests read at once: a few, so they never crowd the file reads. */
const MANIFEST_CONCURRENCY = 4

/**
 * The manifests under the project and the runtime names each gives: listed, then read four at a time, on their own
 * clock (`budgetMs` from the call, MANIFEST_TIME_MS) rather than the search window the file reads share (minor sweep,
 * R4-1). The listing is told to stop at `listMs` (SEARCH_TIME_MS, as before round 4); the walk then hands back what it
 * found, and those manifests are still read in the rest of the budget, so a late listing drops only the manifests it
 * had not reached (minor sweep, M5). At the budget, or at `stop` (the compile ended), the search and the reads stop
 * and what was read by then is kept, so a late read costs its own names and no one else's (fix round 4, M5). A read
 * that never returns stops counting then too. `complete` is false when anything was cut short.
 */
export async function readManifests(
  deps: Pick<CompileDeps, 'glob' | 'readFile'>,
  root: string,
  stop: AbortSignal,
  budgetMs: number = MANIFEST_TIME_MS,
  listMs: number = SEARCH_TIME_MS
): Promise<{ found: Array<[string, string[]]>; complete: boolean }> {
  const prefix = `${root.replace(/\\/g, '/')}/`
  const got: Array<[string, string[]] | null> = []
  const own = new AbortController()
  const end = (): void => own.abort()
  if (stop.aborted) end()
  else stop.addEventListener('abort', end, { once: true })
  const timer = setTimeout(end, budgetMs)
  const signal = own.signal
  // The listing's own stop: at listMs, or with the budget.
  const listing = new AbortController()
  const endListing = (): void => listing.abort()
  if (signal.aborted) endListing()
  else signal.addEventListener('abort', endListing, { once: true })
  const listTimer = setTimeout(endListing, listMs)
  const stopped = new Promise<false>((resolve) => (signal.aborted ? resolve(false) : signal.addEventListener('abort', () => resolve(false), { once: true })))
  const search = async (): Promise<boolean> => {
    const listed = await Promise.resolve()
      .then(() => deps.glob(root, MANIFEST_PATTERNS, { signal: listing.signal }))
      .catch((): string[] => [])
    const listedWhole = !listing.signal.aborted
    const paths = listed
      .map((p) => p.replace(/\\/g, '/'))
      .filter((p) => p.startsWith(prefix) && /(?:\.ya?ml|\/package\.json)$/.test(p) && !p.split('/').includes('node_modules'))
      .sort()
      .slice(0, MAX_MANIFESTS)
    got.length = paths.length
    await eachLimit(paths, MANIFEST_CONCURRENCY, async (abs, i) => {
      if (signal.aborted) return
      const text = await safeRead(deps.readFile, abs)
      const rel = abs.slice(prefix.length)
      got[i] = text === null || text.length > MAX_MANIFEST_CHARS || signal.aborted ? null : [rel, manifestServiceNames(rel, text)]
    })
    return listedWhole && !signal.aborted
  }
  try {
    const complete = await Promise.race([search(), stopped])
    // In path order, as read by now: a read that lands after the budget is not counted.
    return { found: got.filter((x): x is [string, string[]] => x != null && x[1].length > 0), complete }
  } finally {
    clearTimeout(timer)
    clearTimeout(listTimer)
    stop.removeEventListener('abort', end)
    // A walk or a read still out is told to stop: nothing waits on it now.
    end()
  }
}

/** Runtime names the manifests give, by building: a manifest's names go to the building with the most members in its folder. */
function manifestNames(g: Grouping, found: Array<[string, string[]]>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [rel, names] of found) {
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

/** Folders whose go.mod one compile looks for: the shallowest first, so a project's own modules come before deep ones. */
const MAX_GO_MODULE_DIRS = 1000

/**
 * The Go modules a project's Go files are in: a go.mod in a folder of Go files or any folder above one, up to the
 * root, with the module path it declares. Looked for by name rather than by a walk of the tree, so it needs no glob.
 */
async function goModules(deps: CompileDeps, root: string, files: readonly string[]): Promise<GoModule[]> {
  const dirs = new Set<string>()
  for (const f of files) {
    if (!f.endsWith('.go')) continue
    // Every folder above one already in the set is in it too, so the climb stops there.
    for (let d = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''; !dirs.has(d); d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') dirs.add(d)
  }
  const depth = (d: string): number => (d === '' ? 0 : d.split('/').length)
  // `files` has no file under node_modules or another ignored folder (isIgnored), so no such folder is looked in.
  // The sort is stable and `files` is sorted, so folders of one depth stay in path order.
  const look = [...dirs].sort((a, z) => depth(a) - depth(z)).slice(0, MAX_GO_MODULE_DIRS)
  const found = await Promise.all(
    look.map(async (dir): Promise<GoModule | null> => {
      const text = await safeRead(deps.readFile, `${root}/${dir === '' ? '' : `${dir}/`}go.mod`)
      const path = text === null || text.length > MAX_MANIFEST_CHARS ? null : goModulePath(text)
      return path === null ? null : { dir, path }
    })
  )
  return found.filter((m): m is GoModule => m !== null)
}

/** A CI run names a file the commit changed: a test file stands for itself, any other becomes a run of each test linked to it. */
function expandCi(runs: TestRun[], testsByMember: Record<string, string[]>): TestRun[] {
  return runs.flatMap((r) => (r.source !== 'ci' || TEST_FILE.test(r.file) ? [r] : (testsByMember[r.file] ?? []).map((file) => ({ ...r, file }))))
}

/**
 * Tests link to their resolved imports and, when none of those has the test's own stem (only relative imports
 * resolve, so a subject behind an alias leaves just helpers), to the one file of that stem in their folder or package,
 * or to the one file of that stem in the whole world: with a single candidate anywhere there is nothing to mistake it for.
 */
function linkTests(snap: GraphSnapshot, g: Grouping, manifests: string[]): Record<string, string[]> {
  const prefix = `${snap.root.replace(/\\/g, '/').replace(/\/+$/, '')}/`
  const packages = new Set(manifests.map((p) => p.replace(/\\/g, '/'))
    .filter((p) => p.startsWith(prefix) && baseName(p) === 'package.json')
    .map((p) => p.slice(prefix.length)))
  const folder = (file: string): string => file.slice(0, file.lastIndexOf('/') + 1)
  const nearestPackage = (dir: string): string | undefined => {
    for (let d = dir; ; d = folder(d.slice(0, -1))) {
      if (packages.has(`${d}package.json`)) return d
      if (d === '') return undefined
    }
  }
  const fileSet = new Set(g.buildings.flatMap((b) => b.members))
  // A test the world leaves out (one kept with the tooling, say) links to nothing: it is no test of a part.
  const tests = [...new Set(snap.files.filter((f) => TEST_FILE.test(f) && !isIgnored(f)))].sort()
  const byStem = new Map<string, string[]>()
  const add = (m: Map<string, string[]>, k: string, t: string): void => {
    const list = m.get(k)
    if (list) list.push(t)
    else m.set(k, [t])
  }
  const stemOf = (file: string): string => baseName(file).replace(/\.[^.]*$/, '')
  for (const m of fileSet) add(byStem, stemOf(m), m)
  // The source-code files of each stem, counted once: a test whose stem names exactly one links to it at any depth.
  // A config.json or a README is no source, so it neither links nor makes a code file's stem ambiguous.
  const sourcesByStem = new Map<string, string[]>()
  for (const m of fileSet) if (!TEST_FILE.test(m) && languageForFile(m) !== null) add(sourcesByStem, stemOf(m), m)
  const byTarget = new Map<string, string[]>()
  for (const t of tests) {
    const targets = new Set<string>()
    for (const spec of snap.fileImports[t] ?? []) {
      const r = resolveImport(t, spec, fileSet)
      if (r !== null) targets.add(r)
    }
    const stem = baseName(t).replace(TEST_FILE, '')
    if (![...targets].some((r) => stemOf(r) === stem)) {
      const dir = folder(t)
      const pkg = nearestPackage(dir)
      const candidates = (byStem.get(stem) ?? []).filter((m) => {
        const targetDir = folder(m)
        return targetDir === dir || (pkg !== undefined && nearestPackage(targetDir) === pkg)
      })
      if (candidates.length === 1) targets.add(candidates[0])
      else {
        const only = stem === '' ? undefined : sourcesByStem.get(stem)
        if (only?.length === 1) targets.add(only[0])
      }
    }
    for (const target of targets) add(byTarget, target, t)
  }
  return Object.fromEntries(byTarget)
}

function fromPrevious(b: WorldDoc['buildings'][number]): BuildingLabel {
  return { name: b.name, nameInferred: b.nameState === 'inferred', techLabel: b.techLabel, how: b.how, why: b.why, stack: b.stack, floors: b.floors }
}

function edgeFromPrevious(e: WorldEdge): EdgeLabel {
  return { label: e.label, cargo: e.cargo, how: e.how, why: e.why, tech: e.tech, rate: e.rate }
}

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

/**
 * Full labelling, or (with a previous doc and `changed`) a re-label of only the touched buildings, batched
 * under their own district so its first batch names it again, plus the edges touching them (an incoming
 * edge rides with its to building). A district whose buildings changed (one touched, gone or new) takes
 * that answer, or the code-derived label when it has no touched building left to ask with. Everything
 * else reuses the previous doc's labels by id, falling back to code-derived labels.
 */
async function labelAll(g: Grouping, previous: WorldDoc | null, changed: string[] | undefined, deps: LabelDeps): Promise<Labels> {
  if (!previous || !changed) return labelWorld(g, deps)
  const prevB = new Map(previous.buildings.map((b) => [b.id, b]))
  const subB = touchedBuildings(g, previous, changed)
  const ids = new Set(subB.map((b) => b.id))
  const asked = new Set(subB.map((b) => b.districtId))
  const prevD = new Map(previous.districts.map((d) => [d.id, d]))
  // A district is named by its first batch alone, its first BUILDINGS_PER_BATCH buildings in grouping order
  // (planBatches), so it is asked again only when that batch changed: a building in it was touched, or it holds
  // other buildings now. Then it is asked with exactly that batch, as a full compile asks it.
  const firstBatch = (list: readonly { id: string; districtId: string }[], id: string): string[] =>
    list.filter((b) => b.districtId === id).slice(0, BUILDINGS_PER_BATCH).map((b) => b.id)
  const changedFirst = (id: string): boolean => {
    const now = firstBatch(g.buildings, id)
    return !prevD.has(id) || now.some((b) => ids.has(b)) || JSON.stringify(now) !== JSON.stringify(firstBatch(previous.buildings, id))
  }
  const rename = new Set(g.districts.map((d) => d.id).filter(changedFirst))
  const touches = (e: { from: string; to: string }): boolean => ids.has(e.from) || ids.has(e.to)
  const sub: Grouping = {
    districts: g.districts.filter((d) => asked.has(d.id)).map((d) => ({ ...d, members: d.members.filter((id) => ids.has(id)) })),
    buildings: subB,
    edges: g.edges.filter(touches)
  }
  const fresh = await labelWorld(sub, { ...deps, part: (id) => g.buildings.find((b) => b.id === id) })
  const labels = await labelWorld(g, { ...deps, llm: null })
  const named = rename.size > 0 ? await labelWorld(g, { ...deps, firstBatchOf: rename }) : labels
  const prevE = new Map(previous.edges.map((e) => [e.id, e]))
  for (const d of g.districts) {
    const p = prevD.get(d.id)
    labels.districts[d.id] = rename.has(d.id) ? named.districts[d.id] : { name: (p as District).name, subtitle: (p as District).subtitle }
  }
  // Every untouched building has a previous twin with the same members (a new one is touched). Its floors are kept,
  // unless they are the old code-derived "other" floor (look spec §9.3): those give way to the code's floors today.
  // An older compiler's TCP for a port (look spec §9.4) is renamed by the part's own boundaries, and a line's by its own
  // crossings, so a model's TCP on a part or line with no port is kept (review I-1, M-7).
  for (const b of g.buildings) {
    if (ids.has(b.id)) {
      labels.buildings[b.id] = fresh.buildings[b.id]
      continue
    }
    const p = prevB.get(b.id) as WorldDoc['buildings'][number]
    const kept = fromPrevious(p)
    if (isLegacyOtherFloors(p.floors, p.members)) kept.floors = labels.buildings[b.id].floors
    kept.techLabel = portLabel(p.techLabel, b.boundaries.map((x) => x.kind))
    labels.buildings[b.id] = kept
  }
  for (const e of g.edges) {
    const id = edgeId(e)
    const p = prevE.get(id)
    if (touches(e)) labels.edges[id] = fresh.edges[id]
    else if (p) labels.edges[id] = { ...edgeFromPrevious(p), tech: [...portWords(p.tech, e.via.map((v) => v.kind))] }
  }
  labels.glossary = { ...previous.glossary, ...named.glossary, ...fresh.glossary }
  labels.tokens = fresh.tokens + named.tokens
  return labels
}

const seenIn = (refs: string[]): Claim[] =>
  [refs]
    .filter((r) => r.length > 0)
    .map((r): Claim => ({ text: 'Seen in code', state: 'observed', evidence: r.slice(0, MAX_SEEN).map((ref): Evidence => ({ kind: 'file', ref })) }))

/** Where a line shows in the code: its boundaries (file:line), else the files whose imports reach the other end. */
/** `files` is the snapshot's file set, made once for all the edges: one per edge cost a 50k-entry set each on a big
 *  project (WP4a fix round 4). */
function seenInCode(e: Grouping['edges'][number], g: Grouping, snap: GraphSnapshot, files: () => ReadonlySet<string>): Claim[] {
  if (e.via.length > 0) return seenIn(e.via.map((v) => `${v.file}:${v.line}`))
  const target = new Set((g.buildings.find((b) => b.id === e.to) as GroupBuilding).members)
  const importers = (g.buildings.find((b) => b.id === e.from) as GroupBuilding).members.filter((m) =>
    (snap.fileImports[m] ?? []).some((spec) => {
      const r = resolveImport(m, spec, files())
      return r !== null && target.has(r)
    })
  )
  return seenIn([...importers].sort())
}

/**
 * A web host as one orb knows it: `ascii`, its punycode form (url.domainToASCII), is who it is, so a host written in
 * Unicode and in punycode is one orb; `name`, what the orb shows, is that same punycode form (WP5 fix I4), never turned back
 * into Unicode, so a look-alike host cannot pass for another. A host domainToASCII refuses keeps its own spelling for both.
 */
function hostOf(key: string): { ascii: string; name: string } {
  const host = key.toLowerCase()
  const ascii = domainToASCII(host) || host
  return { ascii, name: ascii }
}

/** Top-level names RFC 2606 / RFC 6761 keep for tests, documentation and the local machine: no real service lives there. */
const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost'])
/** Second-level names RFC 2606 keeps for documentation. */
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org']
/** Folders that hold tests, test helpers and fixtures, whatever their files are called. */
const TEST_DIRS = new Set(['tests', 'test', 'e2e', '__tests__', 'fixtures'])

/**
 * True for a host no real service answers on (look spec §9.2): one under a reserved top-level name (`relay.test`,
 * `svc.invalid`, `app.localhost`, the bare name too) or a documentation domain (`example.com`, `api.example.org`).
 * Case and a trailing dot do not matter; a look-alike (`example.com.au`, `myexample.com`, `test.com`) is a real host.
 */
export function isReservedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '')
  if (RESERVED_TLDS.has(h.slice(h.lastIndexOf('.') + 1))) return true
  return RESERVED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`))
}

/** True for a test file, or any file under a folder of tests or fixtures: what it calls is the test's, not the app's. */
function isTestSource(file: string): boolean {
  return TEST_FILE.test(file) || file.split('/').slice(0, -1).some((dir) => TEST_DIRS.has(dir))
}

/** Two orbs are one when they are the same kind and the same agent or host (a host in punycode, so its two spellings are one). */
const orbKey = (x: Pick<External, 'kind' | 'name'>): string => `${x.kind}\0${x.kind === 'service' ? hostOf(x.name).ascii : x.name}`

/**
 * Agent CLIs and non-local web services the buildings' source reaches (a host only tests call, or a reserved one, is
 * none), each with one conduit per building. An orb's id is
 * `x-` plus the slug of its punycode form, so an ordinary host keeps the id it always had and a Unicode host gets
 * a readable one (`x-xn-wgv71a-jp`), never a bare `x-` (G10). Two orbs whose slugs collide (`api.foo.com` and
 * `api-foo.com`, or an agent and a host of one name) both take `--` plus a short hash of what they are, so they
 * never share an orb; an orb whose slug no other shares keeps its plain id (G09).
 */
function externalsOf(g: Grouping): { externals: External[]; edges: WorldEdge[] } {
  const found = new Map<string, { ext: Omit<External, 'id'>; base: string }>()
  const links: { from: string; who: string; bd: Boundary; tech: string }[] = []
  for (const b of g.buildings) {
    for (const bd of b.boundaries) {
      let hit: { kind: External['kind']; name: string; ascii: string; tech: string } | null = null
      if (bd.kind === 'spawn' && AGENT_CLIS.has(baseKey(bd.key).toLowerCase())) {
        const name = baseKey(bd.key).toLowerCase()
        hit = { kind: 'agent', name, ascii: name, tech: 'Spawn' }
      } else if (bd.kind === 'http-out' && !LOCAL_HOSTS.has(bd.key.toLowerCase()) && !isTestSource(bd.file)) {
        // A call from a test or a fixture is no service the app reaches, and a reserved host is no service at all.
        const host = hostOf(bd.key)
        if (!isReservedHost(host.ascii)) hit = { kind: 'service', ...host, tech: 'HTTP client' }
      }
      if (!hit) continue
      const who = orbKey({ kind: hit.kind, name: hit.ascii })
      if (!found.has(who)) found.set(who, { ext: { name: hit.name, kind: hit.kind, fog: false }, base: `x-${idSlug(hit.ascii)}` })
      links.push({ from: b.id, who, bd, tech: hit.tech })
    }
  }
  const whos = [...found.keys()].sort()
  const ids = uniqueIds(whos.map((who) => ({ base: (found.get(who) as { base: string }).base, tag: shortHash(who), order: who })))
  const idOf = new Map(whos.map((who, i) => [who, ids[i]]))
  const edges = new Map<string, WorldEdge>()
  for (const { from, who, bd, tech } of links) {
    const to = idOf.get(who) as string
    const id = edgeId({ from, to })
    if (edges.has(id)) continue
    edges.set(id, {
      id,
      from,
      to,
      cargo: cargoOf([bd.kind]),
      label: `${bd.kind} ${bd.key}`.slice(0, MAX_LABEL),
      how: [],
      why: [],
      tech: [tech],
      rate: '',
      twoWay: false,
      claims: seenIn([`${bd.file}:${bd.line}`])
    })
  }
  const externals = whos.map((who): External => ({ id: idOf.get(who) as string, ...(found.get(who) as { ext: Omit<External, 'id'> }).ext }))
  return { externals: externals.sort((a, z) => cmp(a.id, z.id)), edges: [...edges.values()] }
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

/**
 * A building's stop on a tour: its name and the first thing said about what it does ("main: Starts the app and
 * opens its window."), so a stop explains itself; its name alone where nothing is said yet.
 */
function stopCaption(b: BuildingLabel): string {
  return b.how.length > 0 ? `${b.name}: ${b.how[0].text}` : b.name
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
  const steps: Tour['steps'] = [{ ids: [best.nodes[0]], caption: stopCaption(labels.buildings[best.nodes[0]]) }]
  best.edges.forEach((e, i) => {
    const n = best.nodes[i + 1]
    steps.push({ ids: [e], caption: edgeSummary(labels.edges[e].label) }, { ids: [n], caption: stopCaption(labels.buildings[n]) })
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
  /** Positions to start from when there is no previous world: the first map drawn from the listing, so the parts
   *  stay where they were drawn. */
  layoutFrom?: WorldDoc['layout']
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
export function scanFile(f: string, text: string | null): StageFile | null {
  if (text === null || text.length > MAX_DETECT_FILE_CHARS) return null
  const found = serviceNames(f, text)
  const packages = packageImports(f, text)
  const lang = scanLangImports(f, text)
  return {
    hash: contentHash(text),
    boundaries: detectBoundaries(f, text),
    imports: relativeImports(f, text),
    ...(packages.length > 0 ? { packages } : {}),
    ...(found.length > 0 ? { names: found } : {}),
    ...(lang && lang.refs.length > 0 ? { refs: lang.refs } : {}),
    ...(lang?.pkg !== undefined ? { pkg: lang.pkg } : {}),
    ...(lang?.decls !== undefined ? { decls: lang.decls } : {})
  }
}

/** `p`, with `beat(n)` called every STATUS_BEAT_MS while it is pending (n = 1, 2, ...). */
async function beating<T>(p: Promise<T>, beat: (n: number) => void): Promise<T> {
  let n = 0
  const timer = setInterval(() => beat(++n), STATUS_BEAT_MS)
  try {
    return await p
  } finally {
    clearInterval(timer)
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
/**
 * The doc's files note counts: a capped walk records the files the world maps; nested repositories cut at the cap
 * record the cap they shared; names the listing could not read are counted when the world would have shown them (a
 * source file outside the folders it leaves out).
 */
function filesNotes(snap: GraphSnapshot, root: string, mapped: number): Pick<WorldDoc, 'filesCapped' | 'nestedCapped' | 'filesUnreadable'> {
  const unreadable = (snap.unreadable ?? []).filter((f) => !isIgnored(f) && isIndexableCodeFile(`${root}/${f}`) && languageForFile(f) !== null).length
  return {
    ...(snap.filesCapped !== undefined ? { filesCapped: mapped } : {}),
    ...(snap.nestedCapped !== undefined ? { nestedCapped: snap.nestedCapped } : {}),
    ...(unreadable > 0 ? { filesUnreadable: unreadable } : {})
  }
}

/**
 * The first map of a big listing (WP4a): its files grouped from their paths alone, named by the code and laid out,
 * with nothing read and no lines, test runs, chips, tours or notes. It is drawn while the files are read and the full
 * compile runs behind it from its positions, so it builds only what the pane draws: the grouping is garbage as soon
 * as it returns (fix round 1, I5: the world process holds one listing's grouping at a time, not a compile's).
 */
export function firstMap(paths: GraphSnapshot, projectKey: string, head: { head: string; dirty: boolean }, at: number): WorldDoc {
  const g = groupProject(paths, [])
  const labels = codeLabels(g)
  const districts: District[] = [...g.districts]
    .sort((a, z) => cmp(a.id, z.id))
    .map((d, i) => ({ id: d.id, name: d.name, subtitle: '', hue: Math.round((i * 137.508) % 360), members: d.members, nameState: 'observed' }))
  const buildings: Building[] = g.buildings.map((b) => {
    const l = labels.buildings[b.id]
    return {
      id: b.id,
      districtId: b.districtId,
      name: l.name,
      techLabel: l.techLabel,
      process: b.process,
      floors: l.floors,
      stack: [],
      how: [],
      why: [],
      status: 'gap',
      members: b.members,
      claims: [],
      nameState: 'observed',
      growth: b.growth
    }
  })
  const processes = Object.fromEntries(
    [...new Set(buildings.map((b) => b.process).filter(Boolean))].sort().map((p) => [p, { label: p, color: colorOf(p) }])
  )
  return {
    version: 1,
    projectKey,
    generatedAt: at,
    sourceRevision: { head: head.head, dirty: head.dirty },
    districts,
    buildings,
    edges: [],
    externals: [],
    glossary: { ...BUILTIN_GLOSSARY },
    cargo: {},
    processes,
    tours: [],
    layout: layoutWorld(g, null),
    runtimeNames: {},
    layers: { plan: [] },
    provisional: true
  }
}

export async function compileWorldStaged(input: StagedInput, deps: CompileDeps): Promise<{ doc: WorldDoc; cache: StageCache }> {
  // One window for every search the compile starts: at SEARCH_TIME_MS it stops waiting, and when it ends (however
  // it ends) the walks still running are told to stop.
  const searches = new AbortController()
  const timer = setTimeout(() => searches.abort(), SEARCH_TIME_MS)
  // The manifests keep their own clock (MANIFEST_TIME_MS): this ends them early only when the compile ends (R4-1).
  const ended = new AbortController()
  try {
    return await compileWithin(input, deps, searches.signal, ended.signal)
  } finally {
    clearTimeout(timer)
    searches.abort()
    ended.abort()
  }
}

/** One log line as a compile ends, when a stage was slow or a search ran out of time: every stage with its time. */
function logSlow(projectKey: string, stages: Array<[CompileStage, number]>, end: number, ranOut: boolean): void {
  const spent = stages.map(([stage, at], i): [CompileStage, number] => [stage, (i + 1 < stages.length ? stages[i + 1][1] : end) - at])
  if (!ranOut && !spent.some(([, ms]) => ms >= SLOW_STAGE_MS)) return
  const why = ranOut ? `; a search or a source of test results ran out of time (searches ${SEARCH_TIME_MS} ms, manifests ${MANIFEST_TIME_MS} ms, main's runs ${RUNS_WAIT_MS} ms)` : ''
  console.warn(`[world compile] ${projectKey}: ${spent.map(([stage, ms]) => `${stage} ${ms} ms`).join(', ')}${why}`)
}

async function compileWithin(input: StagedInput, deps: CompileDeps, signal: AbortSignal, ended: AbortSignal): Promise<{ doc: WorldDoc; cache: StageCache }> {
  let { previous } = input
  let { snap } = input
  // When each stage began, for the slow-stage log.
  const stages: Array<[CompileStage, number]> = []
  const progress = (stage: CompileStage, pct: number): void => {
    const last = stages[stages.length - 1]
    if (last === undefined || last[0] !== stage) stages.push([stage, Date.now()])
    deps.onProgress?.(stage, pct)
  }
  let ranOut = false
  progress('structure', 0)
  const prior = isStageCache(input.cache) ? input.cache : null

  // Boundaries, imports and service names, from one read per file that needs one.
  const root = snap.root.replace(/\/+$/, '')
  const files = [...new Set(snap.files)].filter((f) => !isIgnored(f)).sort()
  // Slow reads of the whole tree start now, so they overlap the file reads rather than wait behind them.
  // On their own clock, not the window the file reads share, keeping what was read by then (fix round 4, M5;
  // minor sweep, R4-1).
  // The listing is kept as well: the test links scope a name match by the package.json files it holds (review 1, I3).
  // The status stage waits for it only while the search window is open, as the listing was before R4-1, so the
  // manifests' longer clock never holds the status bar still; a listing later than that links by folder alone.
  let manifestPaths: string[] = []
  let listed!: (inTime: boolean) => void
  const listing = new Promise<boolean>((resolve) => (listed = resolve))
  const manifestsFound = readManifests({
    readFile: deps.readFile,
    glob: async (...args) => {
      try {
        return (manifestPaths = await deps.glob(...args))
      } finally {
        listed(true)
      }
    }
  }, root, ended)
  void manifestsFound.finally(() => listed(false))
  // The window is opened just before this compile starts, so it is still open here.
  const listingSeen = Promise.race([listing, new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true }))])
  // Not raced with the window: each source keeps its own clock and what it found by then (testStatus.ts, N2).
  const runsFound = readTestSources(snap.root, { readFile: deps.readFile, glob: deps.glob, transcriptRuns: deps.transcriptRuns, ciRuns: deps.ciRuns }, signal)
  // More files than a map reads: all are parts of the world, only the capped set is read (readCap.ts).
  const traced = cappedReads(files)
  const reads = (f: string): boolean => traced === null || traced.has(f)
  const again = new Set(input.reread ?? input.changed ?? files)
  const kept = (f: string): boolean => prior !== null && reads(f) && !again.has(f) && Object.hasOwn(prior.files, f)
  const entries = new Map<string, StageFile>()
  for (const f of files) if (kept(f)) entries.set(f, (prior as StageCache).files[f])
  const toRead = files.filter((f) => reads(f) && !kept(f))
  // Files whose text differs from the cache's (or that the cache lacks): with `changed` they are touched too,
  // so an edit a watcher never reported (made while the app was closed, or in a failed run) is re-labelled.
  const differs = new Set<string>()
  progress('boundaries', 5)
  const readSource = deps.readSource ?? deps.readFile
  const got: (StageFile | null)[] = new Array<StageFile | null>(toRead.length).fill(null)
  let done = 0
  const readsShown = readProgress((pct) => progress('boundaries', pct), 5)
  try {
    await eachLimit(toRead, READ_CONCURRENCY, async (f, i) => {
      const before = prior && Object.hasOwn(prior.files, f) ? prior.files[f] : undefined
      // The same text as last time: the old scan stands.
      const pre = deps.scanned?.(f)
      if (pre !== undefined) got[i] = before && pre && before.hash === pre.hash ? before : pre
      else {
        const text = await safeRead(readSource, `${root}/${f}`)
        got[i] = before && text !== null && before.hash === contentHash(text) ? before : scanFile(f, text)
      }
      readsShown.read(++done, toRead.length)
    })
  } finally {
    readsShown.stop()
  }
  toRead.forEach((f, i) => {
    const entry = got[i]
    if (entry) entries.set(f, entry)
    if (prior && entry !== prior.files[f]) differs.add(f)
  })
  // Of the capped set, the files whose text was read (an unreadable or oversized one was not): fix round 1, M7.
  const readCount = traced === null ? 0 : files.reduce((n, f) => (traced.has(f) && entries.has(f) ? n + 1 : n), 0)
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
  // Python, Go, Rust, Java and Kotlin imports, as specifiers to the project files they name.
  const goMods = [...entries.values()].some((e) => e.refs?.some((r) => r.startsWith('go:'))) ? await goModules(deps, root, files) : []
  for (const [f, specs] of resolveLangImports(files, entries, goMods)) scanned.set(f, [...(scanned.get(f) ?? []), ...specs])

  // The graph's tree-sitter path keeps no import specifiers; the text's own fill the gap.
  snap = withImports(snap, scanned)
  progress('grouping', 45)
  const structureHash = structureHashOf(snap, files, entries)
  const reused = prior?.grouping !== undefined && prior.structureHash === structureHash
  const g = reused ? regroupLines(prior.grouping as Grouping, prior, entries) : groupProject(snap, bounds)
  const changed = input.changed ? [...new Set([...input.changed, ...differs])].sort() : undefined
  const ext = externalsOf(g)
  // A world compiled under the old id rules: its parts the new rules renamed take their new ids before anything reads them by id.
  const renames = previous ? idRenames(previous, g, ext, orbKey) : new Map<string, string>()
  if (renames.size > 0) {
    previous = renameDoc(previous as WorldDoc, renames)
    await deps.copyAnnotations?.(Object.fromEntries(renames))
  }

  progress('status', 55)
  const [inTime, found] = await beating(Promise.all([listingSeen, runsFound]),
    (n) => progress('status', Math.min(STATUS_BEAT_TOP, round2(55 + n * STATUS_BEAT_STEP))))
  if (!found.complete || !inTime) ranOut = true
  const manifests = inTime ? manifestPaths : []
  const testsByMember = linkTests(snap, g, manifests)
  const runs = expandCi(found.runs, testsByMember)
  // A partial set of results is never taken for the whole one: no hash, so the next compile judges every building.
  const tests = found.complete ? contentHash(JSON.stringify([
    Object.entries(testsByMember).sort(([a], [b]) => cmp(a, b)),
    runs.map((r) => JSON.stringify([r.file, r.passed, r.at, r.source])).sort()
  ])) : ''
  const cache: StageCache = { version: STAGE_CACHE_VERSION, files: Object.fromEntries(entries), structureHash, grouping: g, tests }
  // An untouched building keeps its status and claims when grouping, test links and results are reused.
  const statusScoped = found.complete && reused && previous !== null && changed !== undefined && (prior as StageCache).tests === tests
  const restatus = statusScoped ? new Set(touchedBuildings(g, previous as WorldDoc, changed as string[]).map((b) => b.id)) : null
  const prevStatus = new Map((previous?.buildings ?? []).map((b) => [b.id, b]))
  const statusKept = (p: Building): Pick<Building, 'status' | 'claims'> => ({ status: p.status, claims: p.claims.filter((c) => !c.evidence.some((e) => e.kind === 'person')) })
  const statusOf = (b: GroupBuilding): Pick<Building, 'status' | 'claims'> => {
    const p = restatus && !restatus.has(b.id) ? prevStatus.get(b.id) : undefined
    if (p) return statusKept(p)
    const claims = testClaims(b.members, runs, testsByMember)
    // No result for it, and a source did not answer in time: what it showed before stands, and a building with no
    // past reads as not yet checked ('built'), never as untested ('gap'), which nothing read can say (fix round 3, N2).
    if (claims.length === 0 && !found.complete) {
      const was = prevStatus.get(b.id)
      return was ? statusKept(was) : { status: 'built', claims: [] }
    }
    return { status: statusFor(b.members, runs, testsByMember), claims }
  }
  // The status pass runs here, in its own stage, so the bar and the slow-stage log put its time under status and
  // not under layout (fix round 3, N3).
  const statusById = new Map(g.buildings.map((b) => [b.id, statusOf(b)]))
  progress('status', 64)

  progress('labelling', 65)
  const labels = await beating(labelAll(g, previous, changed, deps.label), (n) => progress('labelling', Math.min(LABEL_BEAT_TOP, 65 + n)))

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
    const st = statusById.get(b.id) as Pick<Building, 'status' | 'claims'>
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
      nameState: l.nameInferred ? 'inferred' : 'observed',
      growth: b.growth
    }
  })
  // A line whose reverse the code also makes runs both ways: both lines say so and keep their ids.
  let fileSet: ReadonlySet<string> | undefined
  const filesOf = (): ReadonlySet<string> => (fileSet ??= new Set(snap.files))
  const edges: WorldEdge[] = markTwoWay([
    ...g.edges.map((e): WorldEdge => {
      const id = edgeId(e)
      const l = labels.edges[id]
      return { id, from: e.from, to: e.to, cargo: l.cargo, label: l.label, how: l.how, tech: chips(l.tech), why: l.why, rate: l.rate, twoWay: false, claims: seenInCode(e, g, snap, filesOf) }
    }),
    ...ext.edges
  ]).sort((a, z) => cmp(a.id, z.id))

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
  progress('layout', 86)
  const fromManifests = manifestsFound.then(({ found, complete }) => {
    if (!complete) ranOut = true
    return manifestNames(g, found)
  })
  for (const [id, list] of await beating(fromManifests, (n) => progress('layout', Math.min(MANIFEST_BEAT_TOP, round2(86 + n * MANIFEST_BEAT_STEP))))) runtime.set(id, new Set([...(runtime.get(id) ?? []), ...list]))
  progress('layout', 95)
  const runtimeNames = Object.fromEntries([...runtime].sort((a, z) => cmp(a[0], z[0])).map(([id, s]) => [id, [...s].sort()]))

  const seed = previous?.layout ?? input.layoutFrom ?? null
  const layout = layoutWorld(g, seed)
  const far = g.districts.reduce((m, d) => Math.max(m, Math.hypot(layout.positions[d.id][0], layout.positions[d.id][2])), 0)
  const radius = far + RING_MARGIN
  ext.externals.forEach((x, i) => {
    const angle = (2 * Math.PI * i) / ext.externals.length
    layout.positions[x.id] = seed?.positions[x.id] ?? [round2(radius * Math.cos(angle)), RING_Y, round2(radius * Math.sin(angle))]
  })
  progress('layout', 98)

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
    labelTokens: labels.tokens,
    ...filesNotes(snap, root, files.length),
    ...(traced !== null ? { filesRead: readCount, filesListed: files.length } : {})
  }
  // Annotations are merged by item id before the plan is laid over, so a recompile never loses one. The older
  // compiler's TCP definition goes once nothing shows TCP (the plan brings its own definitions with it).
  const tidy = withoutUnusedOldPort(doc)
  const merged = deps.annotations ? mergeAnnotations(tidy, renameClaims(await deps.annotations(), renames)) : tidy
  progress('layout', 100)
  logSlow(input.projectKey, stages, Date.now(), ranOut)
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
