// codeGraph.ts — the native code-graph store: symbols + caller/callee edges over a repo,
// persisted, incrementally re-indexed, and queryable (explore / callers / callees / impact /
// search). Built on the pure codeGraphExtract heuristics + web-tree-sitter — no TS compiler,
// no external CodeGraph dependency.
//
// PER-REPO (v1.23): state is keyed by projectKey (projectKeyOf the repo root) so multiple repos
// coexist instead of clobbering one global store. Queries default to the ACTIVE repo (the last
// built), accept an explicit projectKey, or ALL_REPOS to union across every indexed repo — the
// last is what the cross-repo connection-miner and the memory<->code bridge read.
//
// Reference resolution is name-based (heuristic): a symbol's body is scanned for callable
// names, each resolved to a target symbol — same-file target preferred, else all same-named
// symbols. It over-approximates rather than misses, which is the right bias for blast-radius.

import * as fs from 'fs'
import * as path from 'path'
import { extractFile, extractReferences, languageForFile, type CodeSymbol, type SymbolKind, type FileExtract } from './codeGraphExtract'
import { extractFileTS } from './codeGraphTreeSitter'
import { isIndexableCodeFile, discoverRepoFiles, repoListingNotes } from './codeIngest'
import { projectKeyOf } from './projectKey'
import { MAP_FILE_CAP } from './repoFileList'
// A code-graph JSON is one object (not line-streamable), but reading a file past the V8 string limit
// as 'utf8' fatals uncatchably (see fileLines.ts). Guard the whole-file reads below with this cliff.
import { MAX_SINGLE_STRING_BYTES } from './fileLines'

export interface CodeGraphEdge {
  from: string // caller symbol id
  to: string // callee symbol id
}
export interface SymbolRec extends CodeSymbol {
  id: string
  refs: string[] // callable names referenced in this symbol's body
}
export interface SymbolHit {
  id: string
  name: string
  kind: SymbolKind
  file: string
  startLine: number
  endLine: number
  lang: string
}
export interface CodeGraphStats {
  files: number
  symbols: number
  edges: number
}
export interface ExploreResult {
  symbol: SymbolHit
  source: string
  callers: SymbolHit[]
  callees: SymbolHit[]
}
/** A code location a token resolves to (for the memory<->code bridge, C2). */
export interface ResolvedCode {
  symbols: SymbolHit[]
  files: string[]
}
/** A structured code anchor stamped onto a memory entry — the join key of the bridge (C2).
 *  Structured (not free text) so recall crosses memory<->code without traversing disjoint id
 *  spaces: a memory carries where it lives, and symbolHistory maps a symbol back to its memories. */
export interface CodeRef {
  file: string
  symbol?: string
  symbolId?: string
  projectKey?: string
}

/** Query sentinel: union across every indexed repo (cross-repo miner + bridge). */
export const ALL_REPOS = '*'

const GRAPH_FILE = 'code-graph.json' // the default (unkeyed) graph
const graphFileFor = (key: string): string => (key ? `code-graph-${key}.json` : GRAPH_FILE)
const GRAPH_FILE_RE = /^code-graph(?:-([0-9a-f]{16}))?\.json$/

interface GraphState {
  symbolsById: Map<string, SymbolRec>
  idsByFile: Map<string, string[]>
  idsByName: Map<string, string[]>
  idsByBasename: Map<string, string[]> // basename(file) -> symbol ids in that file (C2 bridge)
  fileImports: Map<string, string[]>
  callEdges: CodeGraphEdge[]
  /** normFileKey(file) -> the file key in idsByFile: an O(1) lookup for paths spelled another way. */
  fileKeys: Map<string, string>
}
function newState(): GraphState {
  return {
    symbolsById: new Map(),
    idsByFile: new Map(),
    idsByName: new Map(),
    idsByBasename: new Map(),
    fileImports: new Map(),
    callEdges: [],
    fileKeys: new Map(),
  }
}

let dir: string | null = null
const graphs = new Map<string, GraphState>()
/** Full builds asked for and not yet finished, by project key (buildCodeGraph), with how many. They run one at a time. */
const sweeping = new Map<string, number>()
/** The full build of a project under way (runBuild). `target` is the graph it fills: a new one aside (a rebuild,
 *  swapped in once whole) or the live one (a first build). `edited` holds the files an edit wrote while it ran
 *  (indexFileContent, or a watcher batch let in at one of its boundaries): the build leaves those as the edit left
 *  them. `retry` holds the files a watcher batch could not read while it ran (and removed): the build reads each once
 *  more before it publishes, so a read failure that passes (EBUSY while an editor saves) does not outlast the build.
 *  It is registered before the build lists the project's files, so an edit made while it lists is kept too. */
interface BuildRec { target: GraphState; aside: boolean; edited: Set<string>; retry: Set<string> }
const builds = new Map<string, BuildRec>()
/** A full build asked for while another of the project runs, by project key: it waits for that one. A later request of
 *  the project joins it: one listing serves every request made before it starts, and the last request's deps are the
 *  ones it runs with. Once it starts, a new request waits for a new build, which lists after it. A build asked for
 *  while none runs starts at once and is never joined. */
interface PendingBuild { deps: CodeGraphDeps; result: Promise<CodeGraphStats> }
const pendingBuilds = new Map<string, PendingBuild>()

/** How long one read of a file by a sweep or a watcher batch may take, and one listing of a project, before it counts as
 *  failed. Each holds the project's lock or its build queue while it waits (graphLock below), so one that never comes
 *  back (a share that stopped answering) would hold every later build and batch of the project. The abandoned read is
 *  left to finish on its own: its result is dropped. The listing's git calls have their own 60 s limit
 *  (codeIngest.ts LIST_TIMEOUT_MS); this one covers the whole listing, the nested repositories and file checks too. */
const READ_TIMEOUT_MS = 30_000
const LISTING_TIMEOUT_MS = 5 * 60_000
let readTimeoutMs = READ_TIMEOUT_MS
let listingTimeoutMs = LISTING_TIMEOUT_MS
/** `work`, or a rejection (code ETIMEDOUT) once `ms` have passed without it settling. */
function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what} took longer than ${ms} ms`), { code: 'ETIMEDOUT' })), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}
const readBounded = (readFile: (file: string) => Promise<string>, file: string): Promise<string> =>
  bounded(readFile(file), readTimeoutMs, `reading ${file}`)
/** Whether a failed read says the file is not there (deleted, or a folder on its path is), not that it could not be read
 *  just now. */
const isGone = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * One project's full builds and watcher batches never run over each other (Codex and Opus reviews of 06419179).
 *
 * - buildQueue: full builds run one after another, in the order they were asked for. Each lists the project when its
 *   turn comes, so the last one asked for publishes last, and no older listing can land over a newer graph.
 * - graphLock: only its holder changes the project's graphs or its build record across an await. A watcher batch
 *   (reindexPaths) holds it from its first read to its apply. A full build holds it while it reads, and lets it go
 *   only while it lists and at its yield boundaries (fillGraph), where it has no read outstanding: a batch waiting
 *   then goes through, writes into both graphs, and the build reads on. So a build never holds a read older than an
 *   edit the watcher applied, and a batch never holds a read older than a graph a build published.
 *
 * The price: a watcher batch that comes while a build reads waits for that build's next boundary (at most 16 files;
 * it goes through while the build waits out that boundary's pause), and one that comes while a build is listing goes
 * ahead at once. A batch holds the lock through its own pauses (sweepPause, capped), so a build waits those out. Every
 * read under the lock, and the listing, is bounded (READ_TIMEOUT_MS, LISTING_TIMEOUT_MS): one that never comes back
 * holds the other side for that long, not for good. Builds asked for while one runs join one build (pendingBuilds),
 * which lists after the one running: only one aside copy at once, and one listing however many were asked for.
 */
const buildQueue = new Map<string, Promise<void>>()
const graphLock = new Map<string, Promise<void>>()
type Release = () => void
/** Resolves, in call order, once every earlier holder of `key` in `locks` has released. Never rejects. */
function acquire(locks: Map<string, Promise<void>>, key: string): Promise<Release> {
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((r) => { release = r })
  const tail = prev.then(() => mine)
  locks.set(key, tail)
  return prev.then(() => () => {
    release()
    if (locks.get(key) === tail) locks.delete(key)
  })
}
let activeKey = ''

/** The repo key for a root path (stable, full-path derived). Empty string = the default graph. */
export function graphKeyForRoot(root: string): string {
  return projectKeyOf(root) ?? ''
}

function stateFor(key?: string): GraphState {
  const k = key ?? activeKey
  let s = graphs.get(k)
  if (!s) {
    s = newState()
    graphs.set(k, s)
  }
  return s
}
/** States to WRITE an edit into: the live graph, and the graph a full build of that key is filling when that is another
 *  one: the one it fills aside, or a first build's that initCodeGraph took out of `graphs` (a brain import), which the
 *  build still publishes. */
function writeStates(key: string): GraphState[] {
  const out = [stateFor(key)]
  const b = builds.get(key)
  if (b && b.target !== out[0]) out.push(b.target)
  return out
}
/** An edit of `file` was just written: the build of `key` under way leaves the file as the edit left it. */
function markEdited(key: string, file: string): void {
  const b = builds.get(key)
  if (!b) return
  b.edited.add(file)
  b.retry.delete(file)
}
/** A watcher batch could not read `file` and removed it: the build of `key` under way reads it itself (it is no longer
 *  left as an earlier edit left it), and once more before it publishes. */
function markFailed(key: string, file: string): void {
  const b = builds.get(key)
  if (!b) return
  b.edited.delete(file)
  b.retry.add(file)
}
/** States to READ for a query: ALL_REPOS → every graph; else the one (active/explicit). */
function readStates(key?: string): GraphState[] {
  if (key === ALL_REPOS) return [...graphs.values()]
  return [stateFor(key)]
}

function symbolId(file: string, name: string, startLine: number): string {
  return `${file}#${name}@${startLine}`
}
const toHit = (s: SymbolRec): SymbolHit => ({
  id: s.id, name: s.name, kind: s.kind, file: s.file, startLine: s.startLine, endLine: s.endLine, lang: s.lang,
})

const normFileKey = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

function clearState(st: GraphState): void {
  st.symbolsById.clear()
  st.idsByFile.clear()
  st.idsByName.clear()
  st.idsByBasename.clear()
  st.fileImports.clear()
  st.callEdges = []
  st.fileKeys.clear()
}

function pushInto(map: Map<string, string[]>, key: string, id: string): void {
  const list = map.get(key) ?? []
  list.push(id)
  map.set(key, list)
}
function removeFrom(map: Map<string, string[]>, key: string, id: string): void {
  const list = map.get(key)
  if (!list) return
  const i = list.indexOf(id)
  if (i >= 0) list.splice(i, 1)
  if (list.length === 0) map.delete(key)
}

function addSymbolRec(st: GraphState, s: SymbolRec): void {
  st.symbolsById.set(s.id, s)
  pushInto(st.idsByFile, s.file, s.id)
  st.fileKeys.set(normFileKey(s.file), s.file)
  pushInto(st.idsByName, s.name, s.id)
  pushInto(st.idsByBasename, path.basename(s.file), s.id)
}

function removeFile(st: GraphState, file: string): void {
  const ids = st.idsByFile.get(file)
  if (ids) {
    for (const id of ids) {
      const s = st.symbolsById.get(id)
      st.symbolsById.delete(id)
      if (s) {
        removeFrom(st.idsByName, s.name, id)
        removeFrom(st.idsByBasename, path.basename(s.file), id)
      }
    }
    st.idsByFile.delete(file)
    if (st.fileKeys.get(normFileKey(file)) === file) st.fileKeys.delete(normFileKey(file))
  }
  st.fileImports.delete(file)
}

/**
 * Load persisted graphs from `d`: the default `code-graph.json` plus every `code-graph-<key>.json`.
 *
 * It replaces `graphs` at once and takes no lock (graphLock): it runs at start-up and after a brain import (index.ts),
 * both synchronous callers, and a lock per project would make it wait for every build under way, which can be held for
 * minutes by sweepPause. Nothing is lost to it meanwhile: a watcher batch picks the graphs it writes into after its
 * reads (reindexPathsImpl), so it writes into the loaded ones, and a build under way publishes the graph it fills
 * (runBuild), the disk as read after the archive was made, over the loaded one.
 */
export function initCodeGraph(d: string): void {
  dir = d
  graphs.clear()
  activeKey = ''
  let names: string[] = []
  try {
    names = fs.readdirSync(d)
  } catch {
    return // no dir yet
  }
  for (const name of names) {
    const m = GRAPH_FILE_RE.exec(name)
    if (!m) continue
    const key = m[1] ?? ''
    const file = path.join(d, name)
    try {
      // A code-graph JSON past the V8 string limit would fatal the process on read (uncatchably —
      // this try/catch could NOT save it); skip it as if corrupt, and a later re-index rebuilds it.
      if (fs.statSync(file).size > MAX_SINGLE_STRING_BYTES) continue
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        symbols?: SymbolRec[]
        imports?: Array<[string, string[]]>
      }
      const st = stateFor(key)
      for (const s of data.symbols ?? []) addSymbolRec(st, s)
      for (const [f, specs] of data.imports ?? []) st.fileImports.set(f, specs)
      rebuildEdges(key)
    } catch {
      /* skip a corrupt graph file */
    }
  }
}

// Kinds you don't CALL — an interface/type/IaC name followed by `(` is a type annotation, a
// generic, or a cast, not a call, so resolving a reference to one is a false edge. (Classes and
// structs stay: `new Foo()` is a real construction edge.)
const NON_CALLABLE: ReadonlySet<string> = new Set(['interface', 'type', 'variable', 'resource', 'module'])

/** Re-resolve every symbol's reference names into caller→callee edges for one repo.
 *
 *  This was 1,951 ms of BLOCKED MAIN THREAD on David's real graph (61,696 symbols → 634,881 edges),
 *  and it runs at launch AND on every file save. Nearly all of it went into one global
 *  `Set<`${s.id}\0${t}`>`: 2,088,218 adds of ~300-char keys, hashing ~600 MB of transient string and
 *  retaining ~140 MB at peak.
 *
 *  That Set was global to answer a question that is purely LOCAL. The outer loop visits each source
 *  symbol exactly once, so `s.id` can never collide across iterations; and `idsByName` is keyed by
 *  symbol NAME (see pushInto below), so two DIFFERENT ref names can never resolve to the same target
 *  id. The only duplicate a symbol can produce is the same ref name repeated in its own `s.refs` —
 *  and real code does that constantly (`['ArgumentNullException','nameof','ArgumentNullException',
 *  'nameof']` is a verbatim record from the store). So: dedup the refs locally, drop the global Set,
 *  and fuse the three .filter() passes into one loop over reused scratch arrays.
 *
 *  MEASURED on the real 42 MB graph, old vs new: 1,951 ms -> 176 ms (11.1x), 634,881 edges both
 *  ways, IDENTICAL AS A LIST — same edges, same order. Order matters: the graph is persisted. */
export function rebuildEdges(projectKey?: string): void {
  const st = stateFor(projectKey)
  st.callEdges = []
  const sameFile: string[] = []   // scratch, reused across every (symbol, ref) pair
  const other: string[] = []
  for (const s of st.symbolsById.values()) {
    // A Set only when there's something to dedup — most symbols have 0-1 refs and shouldn't pay.
    const refs = s.refs.length > 1 ? new Set(s.refs) : s.refs
    for (const ref of refs) {
      const named = st.idsByName.get(ref)
      if (!named) continue
      sameFile.length = 0
      other.length = 0
      for (const id of named) {
        if (id === s.id) continue                          // never an edge to yourself
        const c = st.symbolsById.get(id)!
        if (NON_CALLABLE.has(c.kind)) continue             // a type name before `(` is not a call
        if (c.file === s.file) sameFile.push(id)
        else other.push(id)
      }
      // Same-file definitions win outright; only when there are none do cross-file ones count.
      for (const t of (sameFile.length ? sameFile : other)) st.callEdges.push({ from: s.id, to: t })
    }
  }
}

/** Store a FileExtract's symbols + imports. Per-symbol refs come from the AST extractor
 *  (sym.refs) when present, else are derived from the sliced body text (heuristic path). */
function indexExtract(st: GraphState, ex: FileExtract, content: string): number {
  const lines = content.split('\n')
  for (const sym of ex.symbols) {
    const refs = sym.refs ?? extractReferences(lines.slice(sym.startLine - 1, sym.endLine).join('\n'))
    addSymbolRec(st, { ...sym, id: symbolId(sym.file, sym.name, sym.startLine), refs })
  }
  // Every indexed file is recorded, even with no imports, so a snapshot lists symbol-less files too.
  st.fileImports.set(ex.file, ex.imports)
  return ex.symbols.length
}

/** Index (or re-index) one file's content via the heuristic extractor, pruning its prior symbols.
 *  Synchronous — used by the incremental single-file path and tests. Does NOT rebuild edges. */
export function indexFileContent(file: string, content: string, projectKey?: string): number {
  const key = projectKey ?? activeKey
  const ex = extractFile(file, content)
  let n = 0
  for (const t of writeStates(key)) {
    removeFile(t, file)
    if (ex) n = indexExtract(t, ex, content)
  }
  markEdited(key, file)
  return n
}

/** `ex` with every symbol's refs filled in from `content`, so it can be indexed later without the content. */
function withRefs(ex: FileExtract, content: string): FileExtract {
  const lines = content.split('\n')
  return {
    ...ex,
    symbols: ex.symbols.map((sym) => sym.refs ? sym : { ...sym, refs: extractReferences(lines.slice(sym.startLine - 1, sym.endLine).join('\n')) }),
  }
}

/** Incremental single-file re-index: index + rebuild edges + persist (one repo). */
export async function reindexFile(file: string, content: string, projectKey?: string): Promise<number> {
  const key = projectKey ?? activeKey
  const n = indexFileContent(file, content, key)
  rebuildEdges(key)
  await persistCodeGraph(key)
  return n
}

export interface CodeGraphDeps {
  listFiles: () => Promise<string[]>
  readFile: (file: string) => Promise<string>
  /** Asked at each yield boundary of a sweep (HP-3). main hands it sweepPause (sweepPause.ts): the loop governor's
   *  whenNotShed, which holds the sweep while the main thread is starved, then the typing gate, which holds it while
   *  someone types (each capped, fails open). A throw is ignored: the sweep goes on. */
  pause?: () => Promise<unknown>
}

/** HP-3: a file longer than this is left out of the graph. Its tree-sitter parse is one unbroken block on the main
 *  thread (the sweep yields between files, never inside one), and a generated or vendored file this size is not code
 *  anyone navigates. 512 KB of source. Override in KB with TERMPOLIS_CODE_GRAPH_FILE_CAP; 0 turns the cap off. */
export const MAX_GRAPH_FILE_CHARS = 512 * 1024

export function maxGraphFileChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TERMPOLIS_CODE_GRAPH_FILE_CAP
  if (raw === undefined || raw.trim() === '') return MAX_GRAPH_FILE_CHARS
  const kb = Number(raw)
  if (!Number.isFinite(kb) || kb < 0) return MAX_GRAPH_FILE_CHARS
  return kb === 0 ? Infinity : kb * 1024
}

/** What the full sweeps did since start-up: files parsed, files left out for size, governor asks. */
export interface CodeGraphSweepCounters { parsed: number; skippedLarge: number; pauses: number }
const sweepCounters: CodeGraphSweepCounters = { parsed: 0, skippedLarge: 0, pauses: 0 }

export function codeGraphSweepCounters(): CodeGraphSweepCounters {
  return { ...sweepCounters }
}

/**
 * Hand the event loop back mid-sweep.
 *
 * This is NOT belt-and-braces — it is the whole reason the sweep is survivable. `await` on an
 * ALREADY-RESOLVED promise queues a MICROTASK, and Node drains the microtask queue to completion
 * before the event loop advances. So a loop of `await`s over synchronous work never yields at all:
 * the PTY is not pumped, IPC is not served, and Windows paints "(Not Responding)".
 *
 * Both awaits in the sweep resolve synchronously in production — the reader (fs.promises.readFile is
 * genuinely async, but a sync reader has been injected here before and would silently re-freeze the
 * app) and extractFileTS, whose async signature hides a synchronous WASM parse. setImmediate is a
 * MACROTASK, so it actually returns control to the loop. Measured on this repo: 645 files went from
 * 2,777 ms of unbroken starvation to a 68 ms worst-case stall, for the same total work.
 */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

/** Files handled between yields. Low enough that the worst stall stays far under the 400 ms that
 *  reads as a freeze; high enough that the yield overhead is noise. */
const YIELD_EVERY = 16

/** Re-index a repo's code graph from disk — used by the file-watch freshness path (codeWatch). `pause` is the
 *  sweep's own (CodeGraphDeps.pause): a whole-repo re-sweep stands aside exactly as the first index does. */
export async function reindexRepoGraph(root: string, pause?: () => Promise<unknown>): Promise<CodeGraphStats> {
  return buildCodeGraph(
    { listFiles: () => discoverRepoFiles(root), readFile: (f) => fs.promises.readFile(f, 'utf8'), ...(pause ? { pause } : {}) },
    graphKeyForRoot(root),
  )
}

/** Full (re)build over a set of files into `projectKey` (default = the unkeyed graph), and mark it
 *  active. Non-indexable / unsupported-language files are skipped (isIndexableCodeFile reuses the
 *  read-watcher's secret denylist, so .env/keys are never graphed).
 *
 *  Wipe guard: if discovery yields NO files but this repo already has a non-empty graph, the old
 *  graph is preserved — a transient git-off-PATH / non-git cwd can no longer erase a good index. */
export function buildCodeGraph(deps: CodeGraphDeps, projectKey = ''): Promise<CodeGraphStats> {
  // The project asked for last is the one the queries that name none answer from (code-graph:search, the MCP code
  // tools), whichever of the builds asked for finishes last.
  activeKey = projectKey
  const waiting = pendingBuilds.get(projectKey)
  if (waiting) {
    waiting.deps = deps
    return waiting.result
  }
  // Name the work, so a stall during a repo sweep is reported as `code-graph:sweep` rather than as an
  // anonymous `sync-work` the user has to guess at. (Guessing is precisely what this cost us.)
  sweeping.set(projectKey, (sweeping.get(projectKey) ?? 0) + 1)
  const req = { deps } as PendingBuild
  if (buildQueue.has(projectKey)) pendingBuilds.set(projectKey, req)
  req.result = buildCodeGraphImpl(req, projectKey).finally(() => {
    const left = (sweeping.get(projectKey) as number) - 1
    if (left > 0) sweeping.set(projectKey, left)
    else sweeping.delete(projectKey)
  })
  return req.result
}

/**
 * Whether a full build of `projectKey` is under way or waiting its turn. A rebuild fills a new graph aside and swaps it in at the end,
 * so until then the graph is the last build's, which may be stale; a first build (no graph yet) fills the live
 * graph file by file, so it holds only the files read so far. Either way a reader that needs the whole project as
 * it is now (the world's first map) must not take it for the project.
 */
export function graphSweeping(projectKey: string): boolean {
  return sweeping.has(projectKey)
}

async function buildCodeGraphImpl(req: PendingBuild, projectKey: string): Promise<CodeGraphStats> {
  const done = await acquire(buildQueue, projectKey) // the builds asked for before this one finish first
  // Started: a request from now on waits for a build of its own, which lists after this one. A build that started at
  // once was never the waiting one, and one asked for after it may be by now.
  if (pendingBuilds.get(projectKey) === req) pendingBuilds.delete(projectKey)
  try {
    return await runBuild(req.deps, projectKey)
  } finally {
    done()
  }
}

async function runBuild(deps: CodeGraphDeps, projectKey: string): Promise<CodeGraphStats> {
  const hold = { release: await acquire(graphLock, projectKey) }
  // A rebuild fills a new graph aside and swaps it in once it is whole, so a reader (the MCP code tools) keeps the
  // last complete graph meanwhile instead of a part of one; a held sweep (sweepPause) can take minutes under steady
  // typing. A first build has nothing to keep, so it fills the live graph and answers grow file by file.
  const st = stateFor(projectKey)
  const aside = st.symbolsById.size > 0 || st.fileImports.size > 0
  const rec: BuildRec = { target: aside ? newState() : st, aside, edited: new Set(), retry: new Set() }
  if (!aside) clearState(st)
  builds.set(projectKey, rec)
  try {
    hold.release() // a watcher batch may go through while the project is listed
    let files: string[] | null = null
    try {
      files = await bounded(deps.listFiles(), listingTimeoutMs, 'listing the project')
    } catch {
      /* keep the graph as it is */
    }
    hold.release = await acquire(graphLock, projectKey)
    // A failed or empty listing keeps the last good graph: a transient git-off-PATH must not wipe a good index.
    if (files === null || (files.length === 0 && aside)) return statsOf(stateFor(projectKey))
    await fillGraph(rec, files, async () => {
      hold.release()
      await yieldToEventLoop()
      if (deps.pause) {
        sweepCounters.pauses++
        try { await deps.pause() } catch { /* fail open: the sweep goes on */ }
      }
      hold.release = await acquire(graphLock, projectKey)
    }, deps.readFile)
    await settleEdits(rec, files, deps.readFile)
    // Published whether or not it was filled aside: a first build's graph is the live one, unless a brain import
    // (initCodeGraph) replaced `graphs` while it ran, and this build read the disk after that archive was made.
    graphs.set(projectKey, rec.target)
    rebuildEdges(projectKey)
  } finally {
    builds.delete(projectKey)
    hold.release()
  }
  await persistCodeGraph(projectKey)
  return statsOf(rec.target)
}

/**
 * The files a watcher batch touched while a build ran, settled against the disk before it publishes (under graphLock,
 * so no batch holds a read meanwhile):
 *
 * - A file a batch wrote that the listing does not hold. The listing may be older than the batch's read (a file made
 *   since) or newer (deleted since: the batch read it while the build listed, then it went). A read says which: one
 *   that finds it gone takes it out; one that fails otherwise (busy, slow) leaves what the batch wrote. Its delete
 *   event still comes, and its batch takes it out of the live graph as any batch does.
 * - A file a batch could not read, and removed (BuildRec.retry): read once more, so a failure that passed is not
 *   published. Still unreadable, it stays out, as a batch with no build under way leaves it.
 */
async function settleEdits(rec: BuildRec, files: string[], readFile: (file: string) => Promise<string>): Promise<void> {
  const listed = new Set(files)
  for (const file of [...rec.edited]) {
    if (listed.has(file)) continue
    try {
      await readBounded(readFile, file)
    } catch (e) {
      if (isGone(e)) removeFile(rec.target, file)
    }
  }
  const cap = maxGraphFileChars()
  for (const file of [...rec.retry]) {
    let ex: FileExtract | null = null
    try {
      const content = await readBounded(readFile, file)
      if (content.length > cap) sweepCounters.skippedLarge++
      else {
        const got = (await extractFileTS(file, content)) ?? extractFile(file, content)
        if (got) ex = withRefs(got, content)
      }
    } catch {
      /* still unreadable: it stays out */
    }
    // An edit of the file made while this read and parsed (indexFileContent) is newer, and was written already. A file
    // still unreadable needs no removal: one on this list is not in rec.target, as the batch that failed removed it
    // from every graph it writes, and fillGraph takes a file off the list when it indexes it.
    if (!ex || rec.edited.has(file)) continue
    removeFile(rec.target, file)
    indexExtract(rec.target, ex, '')
  }
}

/** One sweep's reads and parses into its graph, calling `boundary` every YIELD_EVERY files (the build gives the main
 *  thread back there, asks deps.pause, and lets a waiting watcher batch through). A file an edit wrote (rec.edited) is
 *  left as the edit left it; each file's old symbols go and its new ones come in one synchronous step, after the
 *  awaits. */
async function fillGraph(rec: BuildRec, files: string[], boundary: () => Promise<void>, readFile: (file: string) => Promise<string>): Promise<void> {
  const st = rec.target
  const cap = maxGraphFileChars()
  let sinceYield = 0
  for (const file of files) {
    // Give the main thread back regularly — see yieldToEventLoop. Counted over EVERY file, skips
    // included, so a repo full of unindexable paths cannot starve the loop either.
    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0
      await boundary()
    }
    if (!isIndexableCodeFile(file) || !languageForFile(file) || rec.edited.has(file)) continue
    let content: string
    try {
      content = await readBounded(readFile, file)
    } catch {
      continue
    }
    if (content.length > cap) {
      sweepCounters.skippedLarge++
      continue
    }
    sweepCounters.parsed++
    // Prefer AST-precise extraction (web-tree-sitter); fall back to the heuristic for languages
    // without a grammar, or if the grammar can't load. The graph degrades, it never breaks.
    const ex = (await extractFileTS(file, content)) ?? extractFile(file, content)
    // The read and the parse awaited: a synchronous edit of this file made meanwhile (indexFileContent) is newer.
    if (rec.edited.has(file)) continue
    removeFile(st, file)
    if (ex) indexExtract(st, ex, content)
    rec.retry.delete(file) // read here after a batch could not: settleEdits need not read it again
  }
}

/** Incremental re-index of just the changed paths of one repo — the file-watch fast path. For each
 *  path: (if it still reads and is indexable) re-extract it AST-first (web-tree-sitter, heuristic
 *  fallback) EXACTLY as buildCodeGraph does — so an edited file KEEPS its AST precision instead of
 *  downgrading to the heuristic — then swap its old symbols for the new. A path that no longer reads
 *  (deleted or renamed away) is removed. The whole batch is applied, and its edges rebuilt, in one step
 *  at the end, and the graph persisted once.
 *  Far cheaper than a whole-repo re-sweep: only the changed files are re-parsed. No wipe-guard here
 *  (unlike buildCodeGraph) — an explicit change set of deletes SHOULD be able to empty the graph. */
export async function reindexPaths(
  files: string[],
  readFile: (file: string) => Promise<string>,
  projectKey?: string,
  pause?: () => Promise<unknown>,
): Promise<number> {
  return reindexPathsImpl(files, readFile, projectKey, pause)
}

async function reindexPathsImpl(
  files: string[],
  readFile: (file: string) => Promise<string>,
  projectKey?: string,
  pause?: () => Promise<unknown>,
): Promise<number> {
  const key = projectKey ?? activeKey
  // The project's lock (graphLock), from the first read to the apply: no build publishes and no build reads while
  // this batch holds reads, so neither can land over the other with an older view of a file.
  const release = await acquire(graphLock, key)
  let n = 0
  try {
    // Read and parse every path first, then apply them all in one synchronous step with the edges, so a reader sees
    // the graph from before the pass or after it, never a file removed while its replacement is still being read.
    // Refs are filled in at once (withRefs), so the file contents are not held until then.
    // `failed`: 'gone' when the read says the file is not there (it is left removed, as an edit leaves it), 'retry'
    // when it could not be read just now (busy, slow, outside the folder).
    const changes: { file: string; ex: FileExtract | null; failed: false | 'gone' | 'retry' }[] = []
    let sinceYield = 0
    for (const file of files) {
      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0
        await yieldToEventLoop() // same starvation trap as buildCodeGraph — see yieldToEventLoop
        // And the same pause (CodeGraphDeps.pause): a branch switch can hand this hundreds of files.
        if (pause) {
          sweepCounters.pauses++
          try { await pause() } catch { /* fail open: the pass goes on */ }
        }
      }
      // A path that is not code, or no longer reads (deleted or renamed away), is removed: that alone handles a delete.
      let ex: FileExtract | null = null
      let failed: false | 'gone' | 'retry' = false
      if (isIndexableCodeFile(file) && languageForFile(file)) {
        let content: string | null = null
        try {
          content = await readBounded(readFile, file)
        } catch (e) {
          failed = isGone(e) ? 'gone' : 'retry' // gone / unreadable — leave it removed
        }
        if (content !== null) {
          const got = (await extractFileTS(file, content)) ?? extractFile(file, content)
          if (got) ex = withRefs(got, content)
        }
      }
      changes.push({ file, ex, failed })
    }
    // Into the live graph and the graph a build under way is filling aside. A file this batch read, or found gone, is
    // marked edited, so that build keeps it as it is here. A file it could not read just now is removed, and its mark
    // (from an earlier batch) cleared: the build reads it itself if it has not reached it yet, and once more before it
    // publishes (settleEdits), so a failure that passes (EBUSY or EPERM while an editor saves it on Windows) does not
    // outlast that build.
    // The states are picked here, after the reads, and not before them: initCodeGraph (a brain import) replaces
    // `graphs` without the lock, so a pick from before a read could be a graph no longer in `graphs`, and this batch's
    // files would be lost.
    const states = writeStates(key)
    for (const { file, ex, failed } of changes) {
      for (const t of states) {
        removeFile(t, file)
        if (ex) indexExtract(t, ex, '')
      }
      if (failed === 'retry') markFailed(key, file)
      else markEdited(key, file)
      if (ex) n += ex.symbols.length
    }
    rebuildEdges(key)
  } finally {
    release()
  }
  await persistCodeGraph(key)
  return n
}

/** The file-watch reindex action: incrementally re-index the paths that changed under `root` (given
 *  relative to root, the way fs.watch reports them), falling back to a full repo re-sweep when the
 *  change set is empty or the incremental pass throws — so a watch event never leaves the graph
 *  stale. `readFile` is injected (index.ts wires real fs; tests inject their own). `pause` is asked at every
 *  yield boundary of either pass (CodeGraphDeps.pause; index.ts hands it sweepPause). */
export async function reindexWatchedChange(
  root: string,
  files: string[],
  readFile: (file: string) => Promise<string>,
  pause?: () => Promise<unknown>,
): Promise<void> {
  try {
    if (files.length === 0) {
      await reindexRepoGraph(root, pause)
      return
    }
    const abs = files.map((f) => path.join(root, f)) // graph file keys are absolute (discoverRepoFiles)
    await reindexPaths(abs, readFile, graphKeyForRoot(root), pause)
  } catch {
    try {
      await reindexRepoGraph(root, pause)
    } catch {
      /* keep the last good graph */
    }
  }
}

/** Each project's persist under way, so the next one waits for it (persistCodeGraph). */
const persisting = new Map<string, Promise<void>>()

/** Write a project's graph to disk. Calls for one project run one after another, each writing the graph as it is when
 *  its turn comes: two overlapping writes shared the one temp file, and the one renamed last, maybe the older, won. */
export function persistCodeGraph(projectKey?: string): Promise<void> {
  if (!dir) return Promise.resolve()
  const key = projectKey ?? activeKey
  const at = dir
  const run = (persisting.get(key) ?? Promise.resolve()).then(() => writeGraphFile(at, key))
  // The queue goes on past a write that rejects (none can today: writeGraphFile catches its own failures), so one
  // failure never holds every later persist of the project, nor leaves an unhandled rejection.
  const tail = run.then(noop, noop)
  persisting.set(key, tail)
  void tail.then(() => { if (persisting.get(key) === tail) persisting.delete(key) })
  return run
}
function noop(): void { /* nothing */ }

async function writeGraphFile(at: string, key: string): Promise<void> {
  const st = stateFor(key)
  // The write and the rename are async. This was the last synchronous tail in a file whose sweep had
  // already been moved onto setImmediate yields (see yieldToEventLoop: 645 files went from 2,777 ms
  // of unbroken starvation to a 68 ms worst-case stall) — and it runs on the 2-second-debounced
  // file-watch reindex, so an edit storm paid a full blocking writeFileSync per save on the thread
  // that pumps every PTY. Atomicity is unchanged: still temp-file + rename, just without blocking.
  // JSON.stringify is still synchronous, but it is bounded by graph size rather than by disk.
  const target = path.join(at, graphFileFor(key))
  const tmp = `${target}.tmp`
  try {
    const data = { symbols: [...st.symbolsById.values()], imports: [...st.fileImports.entries()] }
    await fs.promises.writeFile(tmp, JSON.stringify(data))
    await fs.promises.rename(tmp, target) // atomic replace
  } catch {
    // Best effort — the graph rebuilds from source on next full index. The last file stays; a half-written or
    // unrenamed temp file does not.
    try { await fs.promises.rm(tmp, { force: true }) } catch { /* nothing more to do */ }
  }
}

// ---- Queries ---------------------------------------------------------------

function statsOf(st: GraphState): CodeGraphStats {
  return { files: st.idsByFile.size, symbols: st.symbolsById.size, edges: st.callEdges.length }
}

/** Symbols whose name contains `query` (case-insensitive); all symbols if no query. */
export function codeSymbols(query?: string, limit = 50, projectKey?: string): SymbolHit[] {
  const q = (query ?? '').toLowerCase()
  const out: SymbolHit[] = []
  for (const st of readStates(projectKey)) {
    for (const s of st.symbolsById.values()) {
      if (!q || s.name.toLowerCase().includes(q)) out.push(toHit(s))
    }
  }
  return out.slice(0, Math.max(0, limit))
}

function callersIn(st: GraphState, name: string): SymbolHit[] {
  const targetIds = new Set(st.idsByName.get(name) ?? [])
  if (targetIds.size === 0) return []
  const callerIds = new Set(st.callEdges.filter((e) => targetIds.has(e.to)).map((e) => e.from))
  return [...callerIds].map((id) => st.symbolsById.get(id)).filter((s): s is SymbolRec => !!s).map(toHit)
}
function calleesIn(st: GraphState, name: string): SymbolHit[] {
  const srcIds = new Set(st.idsByName.get(name) ?? [])
  if (srcIds.size === 0) return []
  const calleeIds = new Set(st.callEdges.filter((e) => srcIds.has(e.from)).map((e) => e.to))
  return [...calleeIds].map((id) => st.symbolsById.get(id)).filter((s): s is SymbolRec => !!s).map(toHit)
}
function impactIn(st: GraphState, name: string, maxDepth: number): SymbolHit[] {
  const startIds = st.idsByName.get(name)
  if (!startIds || startIds.length === 0) return []
  const visited = new Set<string>(startIds)
  const result = new Set<string>()
  let frontier = new Set<string>(startIds)
  for (let d = 0; d < maxDepth && frontier.size > 0; d++) {
    const next = new Set<string>()
    for (const e of st.callEdges) {
      if (frontier.has(e.to) && !visited.has(e.from)) {
        visited.add(e.from)
        next.add(e.from)
        result.add(e.from)
      }
    }
    frontier = next
  }
  return [...result].map((id) => st.symbolsById.get(id)).filter((s): s is SymbolRec => !!s).map(toHit)
}

/** The symbols one indexed file defines (the v1.55.0 outline hint), looked up in every repo's graph by
 *  path, ignoring case and slash direction. Empty when no graph holds the file. */
export function fileSymbols(file: string): SymbolHit[] {
  const want = normFileKey(file)
  for (const st of graphs.values()) {
    const key = st.idsByFile.has(file) ? file : st.fileKeys.get(want)
    const ids = key === undefined ? undefined : st.idsByFile.get(key)
    if (ids) return ids.map((id) => st.symbolsById.get(id)).filter((s): s is SymbolRec => !!s).map(toHit)
  }
  return []
}

/** Symbols that call any symbol named `name`. */
export function codeCallers(name: string, projectKey?: string): SymbolHit[] {
  return readStates(projectKey).flatMap((st) => callersIn(st, name))
}
/** Symbols called by any symbol named `name`. */
export function codeCallees(name: string, projectKey?: string): SymbolHit[] {
  return readStates(projectKey).flatMap((st) => calleesIn(st, name))
}
/** Blast radius: transitive callers of `name` — what could break if you change it. */
export function codeImpact(name: string, maxDepth = 6, projectKey?: string): SymbolHit[] {
  return readStates(projectKey).flatMap((st) => impactIn(st, name, maxDepth))
}

/** One-call structural answer: the best-matching symbol, its source, and direct callers/callees. */
export function codeExplore(query: string, readSource?: (file: string) => string, projectKey?: string): ExploreResult | null {
  if (!query || !query.trim()) return null
  const q = query.toLowerCase()
  for (const st of readStates(projectKey)) {
    const exact = st.idsByName.get(query)
    let sym: SymbolRec | undefined
    if (exact && exact.length) sym = st.symbolsById.get(exact[0])
    else sym = [...st.symbolsById.values()].find((s) => s.name.toLowerCase().includes(q))
    if (!sym) continue
    let source = ''
    try {
      // Guard the whole-file 'utf8' read: a source file past the V8 string limit fatals uncatchably.
      let content: string
      if (readSource) content = readSource(sym.file)
      else if (fs.statSync(sym.file).size > MAX_SINGLE_STRING_BYTES) content = '' // too big to decode as one string
      else content = fs.readFileSync(sym.file, 'utf8')
      source = content.split('\n').slice(sym.startLine - 1, sym.endLine).join('\n')
    } catch {
      /* source unavailable (file moved) — structure is still useful */
    }
    return { symbol: toHit(sym), source, callers: callersIn(st, sym.name), callees: calleesIn(st, sym.name) }
  }
  return null
}

/** Resolve a token (a bare filename or a symbol name) to code locations — the join the
 *  memory<->code bridge (C2) uses. Filenames match by basename; symbol names by exact name. */
export function resolveToken(token: string, projectKey?: string): ResolvedCode {
  const t = (token ?? '').trim()
  const symbols: SymbolHit[] = []
  const files = new Set<string>()
  if (!t) return { symbols: [], files: [] }
  for (const st of readStates(projectKey)) {
    // filename token → the files whose basename matches (+ their symbols as context)
    const byBase = st.idsByBasename.get(t) ?? st.idsByBasename.get(path.basename(t))
    if (byBase) {
      for (const id of byBase) {
        const s = st.symbolsById.get(id)
        if (s) files.add(s.file)
      }
    }
    // symbol-name token → the matching symbols
    for (const id of st.idsByName.get(t) ?? []) {
      const s = st.symbolsById.get(id)
      if (s) symbols.push(toHit(s))
    }
  }
  return { symbols, files: [...files] }
}

/** Resolve entity/token names (a lesson's referenced files/functions/errors) into structured
 *  CodeRefs — the anchors C2 stamps on a memory so it knows where it lives. Deduped; a token that
 *  resolves to nothing contributes nothing (an error code like ENOENT simply has no code anchor). */
export function resolveCodeRefs(names: string[], projectKey?: string): CodeRef[] {
  const refs: CodeRef[] = []
  const seen = new Set<string>()
  const key = projectKey === ALL_REPOS ? undefined : (projectKey ?? activeKey)
  const add = (r: CodeRef): void => {
    const dedup = `${r.file}\0${r.symbol ?? ''}\0${r.symbolId ?? ''}`
    if (seen.has(dedup)) return
    seen.add(dedup)
    refs.push(r)
  }
  for (const name of names ?? []) {
    const { symbols, files } = resolveToken(name, projectKey)
    for (const s of symbols) add({ file: s.file, symbol: s.name, symbolId: s.id, projectKey: key })
    for (const f of files) add({ file: f, projectKey: key })
  }
  return refs
}

export function codeGraphStats(projectKey?: string): CodeGraphStats {
  if (projectKey === ALL_REPOS) {
    let files = 0, symbols = 0, edges = 0
    for (const st of graphs.values()) {
      files += st.idsByFile.size
      symbols += st.symbolsById.size
      edges += st.callEdges.length
    }
    return { files, symbols, edges }
  }
  return statsOf(stateFor(projectKey))
}

/** A postMessage-safe, fully copied view of one repo's graph for the world compiler (utility process).
 *  `fileImports` values are the raw import specifiers as written (e.g. './lib/b'), not resolved paths. */
export interface GraphSnapshot {
  root: string
  /** Repository-relative, `/` separated, sorted. */
  files: string[]
  symbols: SymbolHit[]
  callEdges: CodeGraphEdge[]
  fileImports: Record<string, string[]>
  /** Set when a folder walk stopped at its cap: how many files are mapped. */
  filesCapped?: number
  /** Set when only the nested repositories were cut (the repository itself never is): the cap they shared. */
  nestedCapped?: number
  /** Listed names that are not valid UTF-8, so no read finds them: the world counts the source files among them. */
  unreadable?: string[]
  /** How many top-level dot-folders held source files the world leaves out as tooling (world/group.ts isToolingPath). */
  toolingFolders?: number
  /** Set on a listing with no file to map: why (WP4b F-R9), so the pane says it in its own words. */
  noFiles?: 'empty' | 'unsupported' | 'unreadable'
}

const slashed = (p: string): string => p.replace(/\\/g, '/')
const isAbs = (p: string): boolean => /^([a-zA-Z]:)?\//.test(p)

/** Longest shared directory prefix of absolute, `/`-separated file paths ('' if none). */
function commonDir(files: string[]): string {
  let parts: string[] | null = null
  for (const f of files) {
    if (!isAbs(f)) continue
    const d = f.split('/').slice(0, -1)
    if (parts === null) { parts = d; continue }
    let i = 0
    while (i < parts.length && i < d.length && parts[i].toLowerCase() === d[i].toLowerCase()) i++
    parts = parts.slice(0, i)
  }
  return parts ? parts.join('/') : ''
}

export interface GraphSnapshotOptions {
  /** Copy only the structure (root, files, fileImports): `symbols` and `callEdges` come back empty.
   *  The world compiler (Lumopolis) reads nothing else, and copying every symbol and call edge of a
   *  big repo on the main thread for each compile or watcher batch is wasted work. */
  structureOnly?: boolean
}

/** Every file path the graph knows (indexed, importing, or holding a symbol), raw. */
function indexedFiles(st: GraphState): string[] {
  const all = new Set<string>([...st.idsByFile.keys(), ...st.fileImports.keys()])
  for (const s of st.symbolsById.values()) all.add(s.file)
  return [...all]
}

/** Copy of a repo's graph with paths relative to the repo root. Pure read: an unknown key yields empty arrays
 *  and does NOT register a state (unlike stateFor). With an explicit `root`, paths are made relative to it and
 *  files outside it are excluded; without one the root is the longest common directory of the indexed absolute
 *  paths (the graph does not store the root it was built from). */
export function graphSnapshot(projectKey: string, root?: string, opts: GraphSnapshotOptions = {}): GraphSnapshot {
  const st = graphs.get(projectKey)
  if (!st) return { root: root ? slashed(root).replace(/\/+$/, '') : '', files: [], symbols: [], callEdges: [], fileImports: {} }
  const base = root ? slashed(root).replace(/\/+$/, '') : commonDir(indexedFiles(st).map(slashed))
  const lowBase = base.toLowerCase() + '/'
  const rel = (p: string): string | null => {
    const n = slashed(p)
    if (!base) return n
    return n.toLowerCase().startsWith(lowBase) ? n.slice(base.length + 1) : root ? null : n
  }
  const files = [...new Set([...st.idsByFile.keys(), ...st.fileImports.keys()].map(rel).filter((f): f is string => f !== null))].sort()
  const fileImports: Record<string, string[]> = {}
  for (const [f, imps] of st.fileImports) {
    const r = rel(f)
    if (r !== null) fileImports[r] = [...imps]
  }
  // What the repository's listing could not show (codeIngest.ts discoverRepoFiles), for the world's pane note.
  const notes = root ? repoListingNotes(base) : null
  const said = {
    ...(notes?.nestedCapped ? { nestedCapped: MAP_FILE_CAP } : {}),
    ...(notes && notes.unreadable.length > 0 ? { unreadable: [...notes.unreadable] } : {})
  }
  if (opts.structureOnly === true) return { root: base, files, symbols: [], callEdges: [], fileImports, ...said }
  const idMap = new Map<string, string>()
  const symbols: SymbolHit[] = []
  for (const s of st.symbolsById.values()) {
    const f = rel(s.file)
    if (f === null) continue
    const h = toHit(s)
    h.file = f
    h.id = symbolId(h.file, s.name, s.startLine)
    idMap.set(s.id, h.id)
    symbols.push(h)
  }
  const callEdges: CodeGraphEdge[] = []
  for (const e of st.callEdges) {
    const from = idMap.get(e.from)
    const to = idMap.get(e.to)
    if (from !== undefined && to !== undefined) callEdges.push({ from, to })
  }
  return { root: base, files, symbols, callEdges, fileImports, ...said }
}

/** The projectKey of the graph most recently built/queried (the repo the user is in). */
export function activeProjectKey(): string {
  return activeKey
}

/** Whether a full build of `projectKey` still has its record (tests: none is left behind), and its locks are free. */
export function _codeGraphBuildsForTests(projectKey: string): number {
  return [builds, buildQueue, graphLock, pendingBuilds].filter((m) => m.has(projectKey)).length
}

/** The import specifiers the live graph of `projectKey` holds for `file` (tests). */
export function _codeGraphImportsForTests(projectKey: string, file: string): string[] | undefined {
  return stateFor(projectKey).fileImports.get(file)
}

/** Shortens the read and listing time limits (tests); no argument puts them back. */
export function _setCodeGraphTimeoutsForTests(t: { readMs?: number; listingMs?: number } = {}): void {
  readTimeoutMs = t.readMs ?? READ_TIMEOUT_MS
  listingTimeoutMs = t.listingMs ?? LISTING_TIMEOUT_MS
}

export function _resetCodeGraphForTests(): void {
  dir = null
  graphs.clear()
  sweeping.clear()
  builds.clear()
  pendingBuilds.clear()
  readTimeoutMs = READ_TIMEOUT_MS
  listingTimeoutMs = LISTING_TIMEOUT_MS
  buildQueue.clear()
  graphLock.clear()
  persisting.clear()
  activeKey = ''
  sweepCounters.parsed = sweepCounters.skippedLarge = sweepCounters.pauses = 0
}
