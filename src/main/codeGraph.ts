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
import { isIndexableCodeFile, discoverRepoFiles } from './codeIngest'
import { projectKeyOf } from './projectKey'

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
}
function newState(): GraphState {
  return {
    symbolsById: new Map(),
    idsByFile: new Map(),
    idsByName: new Map(),
    idsByBasename: new Map(),
    fileImports: new Map(),
    callEdges: [],
  }
}

let dir: string | null = null
const graphs = new Map<string, GraphState>()
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

function clearState(st: GraphState): void {
  st.symbolsById.clear()
  st.idsByFile.clear()
  st.idsByName.clear()
  st.idsByBasename.clear()
  st.fileImports.clear()
  st.callEdges = []
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
  }
  st.fileImports.delete(file)
}

/** Load persisted graphs from `d`: the default `code-graph.json` plus every `code-graph-<key>.json`. */
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
    try {
      const data = JSON.parse(fs.readFileSync(path.join(d, name), 'utf8')) as {
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

/** Re-resolve every symbol's reference names into caller→callee edges for one repo. */
export function rebuildEdges(projectKey?: string): void {
  const st = stateFor(projectKey)
  st.callEdges = []
  const seen = new Set<string>()
  for (const s of st.symbolsById.values()) {
    for (const ref of s.refs) {
      const named = st.idsByName.get(ref)
      if (!named) continue
      const candidates = named.filter((id) => !NON_CALLABLE.has(st.symbolsById.get(id)!.kind))
      if (candidates.length === 0) continue
      const sameFile = candidates.filter((id) => id !== s.id && st.symbolsById.get(id)!.file === s.file)
      const targets = sameFile.length ? sameFile : candidates.filter((id) => id !== s.id)
      for (const t of targets) {
        const key = `${s.id}\0${t}`
        if (seen.has(key)) continue
        seen.add(key)
        st.callEdges.push({ from: s.id, to: t })
      }
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
  if (ex.imports.length) st.fileImports.set(ex.file, ex.imports)
  return ex.symbols.length
}

/** Index (or re-index) one file's content via the heuristic extractor, pruning its prior symbols.
 *  Synchronous — used by the incremental single-file path and tests. Does NOT rebuild edges. */
export function indexFileContent(file: string, content: string, projectKey?: string): number {
  const st = stateFor(projectKey)
  removeFile(st, file)
  const ex = extractFile(file, content)
  return ex ? indexExtract(st, ex, content) : 0
}

/** Incremental single-file re-index: index + rebuild edges + persist (one repo). */
export function reindexFile(file: string, content: string, projectKey?: string): number {
  const key = projectKey ?? activeKey
  const n = indexFileContent(file, content, key)
  rebuildEdges(key)
  persistCodeGraph(key)
  return n
}

export interface CodeGraphDeps {
  listFiles: () => Promise<string[]>
  readFile: (file: string) => Promise<string>
}

/** Re-index a repo's code graph from disk — used by the file-watch freshness path (codeWatch). */
export async function reindexRepoGraph(root: string): Promise<CodeGraphStats> {
  return buildCodeGraph(
    { listFiles: () => discoverRepoFiles(root), readFile: (f) => fs.promises.readFile(f, 'utf8') },
    graphKeyForRoot(root),
  )
}

/** Full (re)build over a set of files into `projectKey` (default = the unkeyed graph), and mark it
 *  active. Non-indexable / unsupported-language files are skipped (isIndexableCodeFile reuses the
 *  read-watcher's secret denylist, so .env/keys are never graphed).
 *
 *  Wipe guard: if discovery yields NO files but this repo already has a non-empty graph, the old
 *  graph is preserved — a transient git-off-PATH / non-git cwd can no longer erase a good index. */
export async function buildCodeGraph(deps: CodeGraphDeps, projectKey = ''): Promise<CodeGraphStats> {
  activeKey = projectKey
  const st = stateFor(projectKey)
  let files: string[]
  try {
    files = await deps.listFiles()
  } catch {
    return statsOf(st)
  }
  if (files.length === 0 && st.symbolsById.size > 0) {
    return statsOf(st) // preserve the last good graph — don't wipe on empty discovery
  }
  clearState(st)
  for (const file of files) {
    if (!isIndexableCodeFile(file) || !languageForFile(file)) continue
    let content: string
    try {
      content = await deps.readFile(file)
    } catch {
      continue
    }
    // Prefer AST-precise extraction (web-tree-sitter); fall back to the heuristic for languages
    // without a grammar, or if the grammar can't load. The graph degrades, it never breaks.
    removeFile(st, file)
    const ex = (await extractFileTS(file, content)) ?? extractFile(file, content)
    if (ex) indexExtract(st, ex, content)
  }
  rebuildEdges(projectKey)
  persistCodeGraph(projectKey)
  return statsOf(st)
}

/** Incremental re-index of just the changed paths of one repo — the file-watch fast path. For each
 *  path: drop its old symbols, then (if it still reads and is indexable) re-extract it AST-first
 *  (web-tree-sitter, heuristic fallback) EXACTLY as buildCodeGraph does — so an edited file KEEPS its
 *  AST precision instead of downgrading to the heuristic. A path that no longer reads (deleted or
 *  renamed away) simply stays removed. Edges are rebuilt and the graph persisted once, at the end.
 *  Far cheaper than a whole-repo re-sweep: only the changed files are re-parsed. No wipe-guard here
 *  (unlike buildCodeGraph) — an explicit change set of deletes SHOULD be able to empty the graph. */
export async function reindexPaths(
  files: string[],
  readFile: (file: string) => Promise<string>,
  projectKey?: string,
): Promise<number> {
  const key = projectKey ?? activeKey
  const st = stateFor(key)
  let n = 0
  for (const file of files) {
    removeFile(st, file) // prune old symbols first — this alone handles a delete/rename
    if (!isIndexableCodeFile(file) || !languageForFile(file)) continue
    let content: string
    try {
      content = await readFile(file)
    } catch {
      continue // gone / unreadable — leave it removed
    }
    const ex = (await extractFileTS(file, content)) ?? extractFile(file, content)
    if (ex) n += indexExtract(st, ex, content)
  }
  rebuildEdges(key)
  persistCodeGraph(key)
  return n
}

/** The file-watch reindex action: incrementally re-index the paths that changed under `root` (given
 *  relative to root, the way fs.watch reports them), falling back to a full repo re-sweep when the
 *  change set is empty or the incremental pass throws — so a watch event never leaves the graph
 *  stale. `readFile` is injected (index.ts wires real fs; tests inject their own). */
export async function reindexWatchedChange(
  root: string,
  files: string[],
  readFile: (file: string) => Promise<string>,
): Promise<void> {
  try {
    if (files.length === 0) {
      await reindexRepoGraph(root)
      return
    }
    const abs = files.map((f) => path.join(root, f)) // graph file keys are absolute (discoverRepoFiles)
    await reindexPaths(abs, readFile, graphKeyForRoot(root))
  } catch {
    try {
      await reindexRepoGraph(root)
    } catch {
      /* keep the last good graph */
    }
  }
}

export function persistCodeGraph(projectKey?: string): void {
  if (!dir) return
  const key = projectKey ?? activeKey
  const st = stateFor(key)
  try {
    const data = { symbols: [...st.symbolsById.values()], imports: [...st.fileImports.entries()] }
    const target = path.join(dir, graphFileFor(key))
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, target) // atomic replace
  } catch {
    /* best effort — the graph rebuilds from source on next full index */
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
      const content = readSource ? readSource(sym.file) : fs.readFileSync(sym.file, 'utf8')
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

/** The projectKey of the graph most recently built/queried (the repo the user is in). */
export function activeProjectKey(): string {
  return activeKey
}

export function _resetCodeGraphForTests(): void {
  dir = null
  graphs.clear()
  activeKey = ''
}
