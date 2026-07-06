// codeGraph.ts — the native code-graph store: symbols + caller/callee edges over a repo,
// persisted, incrementally re-indexed, and queryable (explore / callers / callees / impact /
// search). Built on the pure codeGraphExtract heuristics — no tree-sitter, no TS compiler,
// no external CodeGraph dependency. It intentionally lives in its OWN store (not the memory
// brain's hot window — thousands of symbols would flood it); a later bridge can link a symbol
// to a memory entity so "why" (lessons/decisions) meets "what/where" (structure).
//
// Reference resolution is name-based (heuristic): a symbol's body is scanned for callable
// names, each resolved to a target symbol — same-file target preferred, else all same-named
// symbols. It over-approximates rather than misses, which is the right bias for blast-radius.

import * as fs from 'fs'
import * as path from 'path'
import { extractFile, extractReferences, languageForFile, type CodeSymbol, type SymbolKind, type FileExtract } from './codeGraphExtract'
import { extractFileTS } from './codeGraphTreeSitter'
import { isIndexableCodeFile, discoverRepoFiles } from './codeIngest'

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

const GRAPH_FILE = 'code-graph.json'

let dir: string | null = null
const symbolsById = new Map<string, SymbolRec>()
const idsByFile = new Map<string, string[]>()
const idsByName = new Map<string, string[]>()
const fileImports = new Map<string, string[]>()
let callEdges: CodeGraphEdge[] = []

function symbolId(file: string, name: string, startLine: number): string {
  return `${file}#${name}@${startLine}`
}
const toHit = (s: SymbolRec): SymbolHit => ({
  id: s.id, name: s.name, kind: s.kind, file: s.file, startLine: s.startLine, endLine: s.endLine, lang: s.lang,
})

function clearAll(): void {
  symbolsById.clear()
  idsByFile.clear()
  idsByName.clear()
  fileImports.clear()
  callEdges = []
}

function addSymbolRec(s: SymbolRec): void {
  symbolsById.set(s.id, s)
  const fl = idsByFile.get(s.file) ?? []
  fl.push(s.id)
  idsByFile.set(s.file, fl)
  const nl = idsByName.get(s.name) ?? []
  nl.push(s.id)
  idsByName.set(s.name, nl)
}

function removeFile(file: string): void {
  const ids = idsByFile.get(file)
  if (ids) {
    for (const id of ids) {
      const s = symbolsById.get(id)
      symbolsById.delete(id)
      if (s) {
        const nl = idsByName.get(s.name)
        if (nl) {
          const i = nl.indexOf(id)
          if (i >= 0) nl.splice(i, 1)
          if (nl.length === 0) idsByName.delete(s.name)
        }
      }
    }
    idsByFile.delete(file)
  }
  fileImports.delete(file)
}

/** Load a persisted graph from `d`. Safe if none exists yet. */
export function initCodeGraph(d: string): void {
  dir = d
  clearAll()
  try {
    const data = JSON.parse(fs.readFileSync(path.join(d, GRAPH_FILE), 'utf8')) as {
      symbols?: SymbolRec[]
      imports?: Array<[string, string[]]>
    }
    for (const s of data.symbols ?? []) addSymbolRec(s)
    for (const [f, specs] of data.imports ?? []) fileImports.set(f, specs)
    rebuildEdges()
  } catch {
    /* no graph on disk yet */
  }
}

/** Re-resolve every symbol's reference names into caller→callee edges. Call after a batch of
 *  indexFileContent(). O(total references) — fine at personal-repo scale. */
// Kinds you don't CALL — an interface/type/IaC name followed by `(` is a type annotation, a
// generic, or a cast, not a call, so resolving a reference to one is a false edge. (Classes and
// structs stay: `new Foo()` is a real construction edge.)
const NON_CALLABLE: ReadonlySet<string> = new Set(['interface', 'type', 'variable', 'resource', 'module'])

export function rebuildEdges(): void {
  callEdges = []
  const seen = new Set<string>()
  for (const s of symbolsById.values()) {
    for (const ref of s.refs) {
      const named = idsByName.get(ref)
      if (!named) continue
      const candidates = named.filter((id) => !NON_CALLABLE.has(symbolsById.get(id)!.kind))
      if (candidates.length === 0) continue
      const sameFile = candidates.filter((id) => id !== s.id && symbolsById.get(id)!.file === s.file)
      const targets = sameFile.length ? sameFile : candidates.filter((id) => id !== s.id)
      for (const t of targets) {
        const key = `${s.id}\0${t}`
        if (seen.has(key)) continue
        seen.add(key)
        callEdges.push({ from: s.id, to: t })
      }
    }
  }
}

/** Index (or re-index) one file's content, pruning its prior symbols. Does NOT rebuild edges
 *  (batch first, then rebuildEdges once). Returns the symbol count for the file. */
/** Store a FileExtract's symbols + imports. Per-symbol refs come from the AST extractor
 *  (sym.refs) when present, else are derived from the sliced body text (heuristic path). */
function indexExtract(ex: FileExtract, content: string): number {
  const lines = content.split('\n')
  for (const sym of ex.symbols) {
    const refs = sym.refs ?? extractReferences(lines.slice(sym.startLine - 1, sym.endLine).join('\n'))
    addSymbolRec({ ...sym, id: symbolId(sym.file, sym.name, sym.startLine), refs })
  }
  if (ex.imports.length) fileImports.set(ex.file, ex.imports)
  return ex.symbols.length
}

/** Index (or re-index) one file's content via the heuristic extractor, pruning its prior symbols.
 *  Synchronous — used by the incremental single-file path and tests. The full build path
 *  (buildCodeGraph) prefers the AST extractor. Does NOT rebuild edges. */
export function indexFileContent(file: string, content: string): number {
  removeFile(file)
  const ex = extractFile(file, content)
  return ex ? indexExtract(ex, content) : 0
}

/** Incremental single-file re-index: index + rebuild edges + persist. */
export function reindexFile(file: string, content: string): number {
  const n = indexFileContent(file, content)
  rebuildEdges()
  persistCodeGraph()
  return n
}

export interface CodeGraphDeps {
  listFiles: () => Promise<string[]>
  readFile: (file: string) => Promise<string>
}

/** Re-index a repo's code graph from disk — used by the file-watch freshness path (codeWatch). */
export async function reindexRepoGraph(root: string): Promise<CodeGraphStats> {
  return buildCodeGraph({ listFiles: () => discoverRepoFiles(root), readFile: (f) => fs.promises.readFile(f, 'utf8') })
}

/** Full (re)build over a set of files. Non-indexable / unsupported-language files are skipped
 *  (isIndexableCodeFile reuses the read-watcher's secret denylist, so .env/keys are never graphed). */
export async function buildCodeGraph(deps: CodeGraphDeps): Promise<CodeGraphStats> {
  let files: string[]
  try {
    files = await deps.listFiles()
  } catch {
    return codeGraphStats()
  }
  clearAll()
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
    removeFile(file)
    const ex = (await extractFileTS(file, content)) ?? extractFile(file, content)
    if (ex) indexExtract(ex, content)
  }
  rebuildEdges()
  persistCodeGraph()
  return codeGraphStats()
}

export function persistCodeGraph(): void {
  if (!dir) return
  try {
    const data = { symbols: [...symbolsById.values()], imports: [...fileImports.entries()] }
    const target = path.join(dir, GRAPH_FILE)
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, target) // atomic replace
  } catch {
    /* best effort — the graph rebuilds from source on next full index */
  }
}

// ---- Queries ---------------------------------------------------------------

/** Symbols whose name contains `query` (case-insensitive); all symbols if no query. */
export function codeSymbols(query?: string, limit = 50): SymbolHit[] {
  const q = (query ?? '').toLowerCase()
  const all = [...symbolsById.values()]
  const matched = q ? all.filter((s) => s.name.toLowerCase().includes(q)) : all
  return matched.slice(0, Math.max(0, limit)).map(toHit)
}

/** Symbols that call any symbol named `name`. */
export function codeCallers(name: string): SymbolHit[] {
  const targetIds = new Set(idsByName.get(name) ?? [])
  if (targetIds.size === 0) return []
  const callerIds = new Set(callEdges.filter((e) => targetIds.has(e.to)).map((e) => e.from))
  return [...callerIds].map((id) => symbolsById.get(id)).filter((s): s is SymbolRec => !!s).map(toHit)
}

/** Symbols called by any symbol named `name`. */
export function codeCallees(name: string): SymbolHit[] {
  const srcIds = new Set(idsByName.get(name) ?? [])
  if (srcIds.size === 0) return []
  const calleeIds = new Set(callEdges.filter((e) => srcIds.has(e.from)).map((e) => e.to))
  return [...calleeIds].map((id) => symbolsById.get(id)).filter((s): s is SymbolRec => !!s).map(toHit)
}

/** Blast radius: the transitive set of symbols that (in)directly call `name` — i.e. what could
 *  break if you change it. Reverse-BFS over call edges, bounded by maxDepth. */
export function codeImpact(name: string, maxDepth = 6): SymbolHit[] {
  const startIds = idsByName.get(name)
  if (!startIds || startIds.length === 0) return []
  const visited = new Set<string>(startIds)
  const result = new Set<string>()
  let frontier = new Set<string>(startIds)
  for (let d = 0; d < maxDepth && frontier.size > 0; d++) {
    const next = new Set<string>()
    for (const e of callEdges) {
      if (frontier.has(e.to) && !visited.has(e.from)) {
        visited.add(e.from)
        next.add(e.from)
        result.add(e.from)
      }
    }
    frontier = next
  }
  return [...result].map((id) => symbolsById.get(id)).filter((s): s is SymbolRec => !!s).map(toHit)
}

/** One-call structural answer: the best-matching symbol, its source, and direct callers/callees.
 *  `readSource` is injected for testability; defaults to reading the file from disk. */
export function codeExplore(query: string, readSource?: (file: string) => string): ExploreResult | null {
  if (!query || !query.trim()) return null
  const exact = idsByName.get(query)
  let sym: SymbolRec | undefined
  if (exact && exact.length) sym = symbolsById.get(exact[0])
  else {
    const q = query.toLowerCase()
    sym = [...symbolsById.values()].find((s) => s.name.toLowerCase().includes(q))
  }
  if (!sym) return null
  let source = ''
  try {
    const content = readSource ? readSource(sym.file) : fs.readFileSync(sym.file, 'utf8')
    source = content.split('\n').slice(sym.startLine - 1, sym.endLine).join('\n')
  } catch {
    /* source unavailable (file moved) — structure is still useful */
  }
  return { symbol: toHit(sym), source, callers: codeCallers(sym.name), callees: codeCallees(sym.name) }
}

export function codeGraphStats(): CodeGraphStats {
  return { files: idsByFile.size, symbols: symbolsById.size, edges: callEdges.length }
}

export function _resetCodeGraphForTests(): void {
  dir = null
  clearAll()
}
