// Lumopolis: groups a project into districts (subsystems), buildings (services or processes) and
// edges (dependencies). Pure and deterministic: no fs, no Electron, and only a type import from
// codeGraph, so tree-sitter never loads in the utility process that runs this.
//
// 1. Districts are seeded from the top-level folders under src/ (a monorepo's packages/apps
//    folder, or the repository root), then capped by merging the smallest into its most-connected
//    neighbour.
// 2. Process entries (fork/worker targets, main/renderer/preload entries) each become a building.
//    A fork/worker entry takes its exclusive import closure inside its district (and, when its key
//    names a folder, the rest of that folder); a main/renderer/preload entry takes only itself,
//    since everything in its seed folder is reachable from it. An index/main file counts as such an
//    entry only when nothing but tests imports it. A channel service (a module an entry hands
//    an IPC channel family to, like swarmManager.ts for `swarm:*`) also stands on its own.
// 3. Remaining files start as name families (a small sub-folder is one family; in a big folder,
//    files sharing a leading name word are one), then clusters in one district merge, densest
//    first, while their cross-edge density is above MERGE_DENSITY.
// 4. Buildings are capped by merging the smallest into its densest neighbour (link weight over
//    the neighbour's size) in the same district, never into a process building or channel service;
//    with no link, its nearest plain building in path order. Those fixed buildings go last.
// 5. Names: a process building is named after its process; any other after its front door, the
//    non-test member reaching most of the building, then most imported from outside it, skipping
//    names that would pass for the district or a main/renderer/preload entry.
// 6. Ids are slugs of member paths (a name with no letter or digit a slug keeps, such as an emoji or
//    a non-Latin script, is 'u' plus a short hash of the name, never 'root', which is the repository
//    root's alone). A base no other building shares is used as is; colliding bases get '--' plus the
//    first member's basename, and only if that collides '--' plus a short hash of the first member's
//    path, so a new path never renumbers its siblings.
// 7. Edges come from resolved imports, fork/worker targets and provide/consume boundary pairs.
import type { GraphSnapshot } from '../codeGraph'
import type { BuildingGrowth, District } from '../../shared/world/types'
import { baseKey, type Boundary } from './detectors/common'
import { BRIDGE_PREFIX } from './detectors/ipc'
import { isIgnoredPath } from '../repoFileList'

export interface GroupBuilding {
  id: string
  districtId: string
  name: string
  /** Repository-relative paths, sorted. */
  members: string[]
  /** The OS process the code runs in: a process building's own (its fork/worker key, or main or
   *  renderer; a preload runs in 'renderer'); any other building inherits its district's process
   *  when the district is a main/renderer/preload folder, else ''. */
  process: string
  boundaries: Boundary[]
  /** How it grew: what it started as, the clusters merged into that start, and the buildings the cap folded in.
   *  groupProject always sets it; a building made any other way may have none. */
  growth?: BuildingGrowth
}

/** Directed dependency: importer -> imported, consumer -> provider, forker -> forked. */
export interface GroupEdge {
  from: string
  to: string
  /** Boundaries behind the edge (empty for import-only edges). */
  via: Boundary[]
}

export interface Grouping {
  districts: Omit<District, 'hue' | 'subtitle' | 'nameState'>[]
  buildings: GroupBuilding[]
  edges: GroupEdge[]
}

export interface GroupOptions {
  maxDistricts?: number
  maxBuildings?: number
}

export const DEFAULT_MAX_DISTRICTS = 12
export const DEFAULT_MAX_BUILDINGS = 60
/** Clusters in one district merge while w(X,Y) / (2|X||Y|) is above this (w counts directed imports). */
export const MERGE_DENSITY = 0.35

const ENTRY_PROCESSES = new Set(['main', 'renderer', 'preload'])
const ENTRY_NAMES = new Set(['index', 'main'])
/** The OS process a seed folder's code runs in when that differs from its name: Electron loads a
 *  preload script into the renderer process (the page's isolated world), so a preload building is
 *  named 'preload' but runs in 'renderer', and its ipcRenderer calls cross renderer -> main. */
const RUNS_IN: Readonly<Record<string, string>> = { preload: 'renderer' }
const runsIn = (role: string): string => RUNS_IN[role] ?? role
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const JS_TO_TS: readonly (readonly [string, string])[] = [
  ['.js', '.ts'],
  ['.js', '.tsx'],
  ['.jsx', '.tsx'],
  ['.mjs', '.mts'],
  ['.cjs', '.cts']
]
/** A sub-folder with at most this many files is one module; a bigger one groups by name stem. */
export const FAMILY_FOLDER_MAX = 16
/** Over the building cap, a building whose files mostly share one name in one folder (at least this
 *  many of them, and at least COHESIVE_SHARE of the building) is a module by naming convention:
 *  codeGraph.ts, codeIngest.ts, codeLocate.ts. It counts COHESIVE_WEIGHT times its size when the cap
 *  picks what to merge next, so a mixed building of the same size gives way first and a named
 *  module keeps its identity as the project grows. */
export const COHESIVE_MIN = 3
export const COHESIVE_SHARE = 0.75
export const COHESIVE_WEIGHT = 2
const RELATIVE = /^\.\.?(\/|$)/
/** Test files (`x.test.ts`, `x.spec.tsx`): never a process entry. */
const TEST_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/
/** How many import steps naming one building's front door may take (review K6): a search from every member is quadratic on
 *  a long chain. Members with the fewest importers inside the building are searched first, as they reach the most; past the
 *  budget a member counts only what it reached, and one never searched counts only itself, so the same input names alike. */
export const FRONT_DOOR_BUDGET = 2_000_000

/** Stable id of a grouping edge (edges carry none). Labels and the compiled world key on it. */
export function edgeId(e: { from: string; to: string }): string {
  return `e-${e.from}--${e.to}`
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** A short, stable hash of a string (FNV-1a, 32 bits, the first six hex digits): the readable part of an id
 *  when a name has none, or the part that tells colliding ids apart. Never contains '-'. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6)
}

/** slug(s), or for a name a slug keeps nothing of (an emoji, a non-Latin script) 'u' plus its shortHash; '' stays ''. */
export function idSlug(s: string): string {
  return slug(s) || (s ? `u${shortHash(s)}` : '')
}

/** True for files under dependency, virtual-environment, cache and build output folders, and minified or bundled files. */
export function isIgnored(path: string): boolean {
  // One list for every reader (repoFileList.ts): the git listing and the folder walk leave out what no world shows.
  return isIgnoredPath(path)
}

const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')))
const lastSeg = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const stripExt = (p: string): string => p.replace(/\.[^./]*$/, '')
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const bump = (m: Map<number, number>, k: number, w: number): void => {
  m.set(k, (m.get(k) ?? 0) + w)
}

function cmpBoundary(a: Boundary, b: Boundary): number {
  return cmp(a.file, b.file) || a.line - b.line || cmp(a.kind, b.kind) || cmp(a.key, b.key) || cmp(a.side, b.side)
}

/**
 * Resolve a raw import specifier to a file in `files`. Only relative specifiers count. Tries the
 * exact path, `.js`-style specifiers mapped to TypeScript, then each extension, then `/index.*`.
 */
export function resolveImport(importer: string, spec: string, files: ReadonlySet<string>): string | null {
  if (!RELATIVE.test(spec)) return null
  const out = dirOf(importer).split('/').filter(Boolean)
  for (const seg of spec.split('/')) {
    if (seg === '..') {
      if (!out.length) return null
      out.pop()
    } else if (seg && seg !== '.') out.push(seg)
  }
  const p = out.join('/')
  const dir = p ? `${p}/` : ''
  const candidates = [
    p,
    ...JS_TO_TS.filter(([from]) => p.endsWith(from)).map(([from, to]) => p.slice(0, -from.length) + to),
    ...EXTS.map((e) => p + e),
    ...EXTS.map((e) => `${dir}index${e}`)
  ]
  return candidates.find((c) => files.has(c)) ?? null
}

/**
 * The leading word of a file name, lower-cased: `memoryHost.ts` -> 'memory', `remote-bridge.ts` ->
 * 'remote', `AccountChip.tsx` -> 'account', `MCPServer.ts` -> 'mcp'. '' for words under three
 * letters and for entry names (index, main), which say nothing about what a file does.
 */
export function nameStem(name: string): string {
  const base = name.replace(/\..*$/, '')
  const m = /^[A-Z]{2,}(?=[A-Z][a-z]|[^A-Za-z]|$)|^[A-Za-z][a-z0-9]*/.exec(base)
  const w = (m ? m[0] : '').toLowerCase()
  return w.length < 3 || ENTRY_NAMES.has(w) ? '' : w
}

/** What a member is called: its base name, or its folder's name for an entry file (index.ts). */
function memberKey(file: string): string {
  const k = baseKey(file)
  return ENTRY_NAMES.has(k) ? lastSeg(dirOf(file)) || k : k
}

/** Longest common directory of sorted paths ('' when they share none). */
function commonDir(sorted: readonly string[]): string {
  const a = sorted[0].split('/').slice(0, -1)
  const b = sorted[sorted.length - 1].split('/').slice(0, -1)
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return a.slice(0, n).join('/')
}

function prefixLen(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

/** Union-find with path compression. `attach` always hangs a root under the chosen root. */
class UnionFind {
  private readonly parent: Int32Array
  constructor(n: number) {
    this.parent = Int32Array.from({ length: n }, (_, i) => i)
  }
  find(x: number): number {
    let r = x
    while (this.parent[r] !== r) r = this.parent[r]
    while (this.parent[x] !== r) {
      const up = this.parent[x]
      this.parent[x] = r
      x = up
    }
    return r
  }
  attach(child: number, root: number): void {
    this.parent[child] = root
  }
}

/** Binary heap; `before(a, b)` is true when a comes out first. */
class Heap<T> {
  private readonly items: T[] = []
  private readonly before: (a: T, b: T) => boolean
  constructor(before: (a: T, b: T) => boolean) {
    this.before = before
  }
  get size(): number {
    return this.items.length
  }
  push(x: T): void {
    const a = this.items
    a.push(x)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.before(a[i], a[p])) break
      ;[a[i], a[p]] = [a[p], a[i]]
      i = p
    }
  }
  /** Removes and returns the first item. Callers check `size` first. */
  pop(): T {
    const a = this.items
    const top = a[0]
    const last = a.pop() as T
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && this.before(a[l], a[m])) m = l
        if (r < a.length && this.before(a[r], a[m])) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }
}

/** `root/<first segment>` for files below `root`, `root` itself for files directly in it. */
function topDir(file: string, root: string): string | null {
  const prefix = root ? `${root}/` : ''
  if (!file.startsWith(prefix)) return null
  const rest = file.slice(prefix.length)
  const i = rest.indexOf('/')
  return i < 0 ? root : prefix + rest.slice(0, i)
}

/**
 * The folder whose children seed districts: 'src' when there is a src folder; else a monorepo
 * folder (packages/, apps/, ...) that holds most files spread over two or more child folders;
 * else '' (the repository root).
 */
function seedRoot(files: readonly string[]): string {
  if (files.some((f) => f.startsWith('src/'))) return 'src'
  const count = new Map<string, number>()
  const kids = new Map<string, Set<string>>()
  for (const f of files) {
    const parts = f.split('/')
    if (parts.length < 3) continue
    count.set(parts[0], (count.get(parts[0]) ?? 0) + 1)
    const k = kids.get(parts[0])
    if (k) k.add(parts[1])
    else kids.set(parts[0], new Set([parts[1]]))
  }
  // At most one folder can hold more than half the files, so iteration order does not matter.
  for (const [top, c] of count) if (c * 2 > files.length && (kids.get(top) as Set<string>).size >= 2) return top
  return ''
}

/** Seed districts: the children of seedRoot(); files outside it use the repository root's folders. */
function seedDistricts(files: readonly string[]): { dirs: string[]; seedOf: Int32Array } {
  const root = seedRoot(files)
  const dirOfFile = files.map((f) => topDir(f, root) ?? (topDir(f, '') as string))
  const dirs = [...new Set(dirOfFile)].sort()
  const at = new Map(dirs.map((d, i) => [d, i]))
  return { dirs, seedOf: Int32Array.from(dirOfFile, (d) => at.get(d) as number) }
}

/** Merge the smallest district into its most-connected one until at most `max` remain. */
function capDistricts(seedOf: Int32Array, count: number, imports: number[][], max: number): Int32Array {
  const n = seedOf.length
  const K = n + 1
  const size = new Array<number>(count).fill(0)
  for (const s of seedOf) size[s]++
  const adj = Array.from({ length: count }, () => new Map<number, number>())
  imports.forEach((targets, i) => {
    for (const g of targets) {
      const a = seedOf[i]
      const b = seedOf[g]
      if (a !== b) {
        bump(adj[a], b, 1)
        bump(adj[b], a, 1)
      }
    }
  })
  const alive = new Array<boolean>(count).fill(true)
  const uf = new UnionFind(count)
  for (let live = count; live > max; live--) {
    // Smallest by (size, path order); then the most connected (weight, path order).
    let s = -1
    let sk = Infinity
    for (let d = 0; d < count; d++) {
      const k = size[d] * K + d
      if (alive[d] && k < sk) {
        s = d
        sk = k
      }
    }
    let t = -1
    let best = -1
    for (const [o, w] of adj[s]) {
      const score = w * K + (K - 1 - o)
      if (score > best) {
        t = o
        best = score
      }
    }
    if (t < 0) {
      let tk = Infinity
      for (let d = 0; d < count; d++) {
        const k = size[d] * K + d
        if (alive[d] && d !== s && k < tk) {
          t = d
          tk = k
        }
      }
    }
    alive[s] = false
    uf.attach(s, t)
    size[t] += size[s]
    for (const [k, w] of adj[s]) {
      adj[k].delete(s)
      if (k !== t) {
        bump(adj[t], k, w)
        bump(adj[k], t, w)
      }
    }
  }
  return Int32Array.from(seedOf, (s) => uf.find(s))
}

/** Cluster files not owned by a building yet; returns the union-find over file indices. */
function clusterFree(imports: number[][], district: Int32Array, owner: Int32Array, family: Int32Array): UnionFind {
  const n = imports.length
  const uf = new UnionFind(n)
  const size = new Int32Array(n)
  const minIdx = Int32Array.from({ length: n }, (_, i) => i)
  const stamp = new Int32Array(n)
  const adj = Array.from({ length: n }, () => new Map<number, number>())
  // Families start as one cluster each, rooted at their first file.
  for (let i = 0; i < n; i++) {
    if (owner[i] >= 0) continue
    const r = family[i]
    if (r !== i) uf.attach(i, r)
    size[r]++
    minIdx[r] = Math.min(minIdx[r], i)
  }
  for (let i = 0; i < n; i++) {
    if (owner[i] >= 0) continue
    for (const g of imports[i]) {
      const a = family[i]
      const b = family[g]
      if (owner[g] < 0 && district[g] === district[i] && a !== b) {
        bump(adj[a], b, 1)
        bump(adj[b], a, 1)
      }
    }
  }
  interface Pair { d: number; a: number; b: number; sa: number; sb: number; lo: number; hi: number }
  const heap = new Heap<Pair>((x, y) => (x.d !== y.d ? x.d > y.d : x.lo !== y.lo ? x.lo < y.lo : x.hi < y.hi))
  const push = (a: number, b: number): void => {
    const d = (adj[a].get(b) as number) / (2 * size[a] * size[b])
    const lo = Math.min(minIdx[a], minIdx[b])
    const hi = Math.max(minIdx[a], minIdx[b])
    heap.push({ d, a, b, sa: stamp[a], sb: stamp[b], lo, hi })
  }
  for (let a = 0; a < n; a++) for (const b of adj[a].keys()) if (a < b) push(a, b)
  while (heap.size) {
    const p = heap.pop()
    if (p.sa !== stamp[p.a] || p.sb !== stamp[p.b]) continue
    if (p.d <= MERGE_DENSITY) break
    const [r, o] = size[p.a] >= size[p.b] ? [p.a, p.b] : [p.b, p.a]
    stamp[r]++
    stamp[o]++
    uf.attach(o, r)
    size[r] += size[o]
    minIdx[r] = Math.min(minIdx[r], minIdx[o])
    for (const [k, w] of adj[o]) {
      adj[k].delete(o)
      if (k !== r) {
        bump(adj[r], k, w)
        bump(adj[k], r, w)
      }
    }
    adj[o].clear()
    for (const k of adj[r].keys()) push(r, k)
  }
  return uf
}

/**
 * Ids that stay put when unrelated items come and go. A base no other item shares is used as is,
 * so natural ids are never suffixed. Items sharing a base become `base--tag` (no tag: `base`), and
 * when that still collides every one of them becomes `base--tag--<shortHash(order)>`, so an item
 * that comes or goes never renumbers the others (G14). Slugs never contain '--', so a tagged or
 * hashed id cannot take a natural one. Two orders whose hashes collide (or two equal orders) get
 * -2, -3, ... in order: only that, which no real project meets, depends on what else is there.
 */
export function uniqueIds(items: readonly { base: string; tag: string; order: string }[]): string[] {
  const count = (keys: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1)
    return m
  }
  const baseUses = count(items.map((it) => it.base))
  const wants = items.map((it) => (baseUses.get(it.base) === 1 ? it.base : it.tag ? `${it.base}--${it.tag}` : it.base))
  const wantUses = count(wants)
  const out = new Array<string>(items.length)
  const used = new Set<string>()
  items.forEach((it, i) => {
    if (baseUses.get(it.base) === 1) {
      out[i] = it.base
      used.add(it.base)
    }
  })
  const rest: { k: string; want: string; i: number }[] = []
  items.forEach((it, i) => {
    if (baseUses.get(it.base) === 1) return
    const want = wantUses.get(wants[i]) === 1 ? wants[i] : `${wants[i]}--${shortHash(it.order)}`
    rest.push({ k: `${want}\0${it.order}`, want, i })
  })
  rest.sort((x, y) => cmp(x.k, y.k))
  for (const { want, i } of rest) {
    let id = want
    for (let k = 2; used.has(id); k++) id = `${want}-${k}`
    used.add(id)
    out[i] = id
  }
  return out
}

export function groupProject(snap: GraphSnapshot, bounds: Boundary[], opts: GroupOptions = {}): Grouping {
  const maxBuildings = Math.max(1, opts.maxBuildings ?? DEFAULT_MAX_BUILDINGS)
  const maxDistricts = Math.max(1, Math.min(opts.maxDistricts ?? DEFAULT_MAX_DISTRICTS, maxBuildings))
  const files = [...new Set(snap.files)].filter((f) => !isIgnored(f)).sort()
  const n = files.length
  const index = new Map(files.map((f, i) => [f, i]))
  const fileSet = new Set(files)

  // Resolved, de-duplicated import edges (sorted target indices) and their reverse.
  const imports: number[][] = []
  const importers: number[][] = files.map(() => [])
  files.forEach((f) => {
    const specs = Object.prototype.hasOwnProperty.call(snap.fileImports, f) ? snap.fileImports[f] : []
    const targets = new Set<number>()
    for (const spec of specs) {
      const r = resolveImport(f, spec, fileSet)
      if (r !== null && r !== f) targets.add(index.get(r) as number)
    }
    imports.push([...targets].sort((a, b) => a - b))
  })
  imports.forEach((targets, i) => targets.forEach((g) => importers[g].push(i)))
  // A page read of a bridge name nothing exposes (window.location, window.localStorage) is no boundary.
  const exposed = new Set(bounds.filter((b) => b.kind === 'ipc' && b.side === 'provide').map((b) => b.key))
  const kept = bounds
    .filter((b) => fileSet.has(b.file))
    .filter((b) => !(b.kind === 'ipc' && b.side === 'consume' && b.key.startsWith(BRIDGE_PREFIX) && !exposed.has(b.key)))
    .sort(cmpBoundary)

  // 1. Districts.
  const { dirs, seedOf } = seedDistricts(files)
  const district = capDistricts(seedOf, dirs.length, imports, maxDistricts)

  // 2. Process entries: main/renderer/preload entries (shortest index|main file in that seed
  //    folder), then fork/worker targets (shortest file whose basename is the key).
  const proc = new Map<number, string>()
  const entryOf = new Map<number, number>()
  const byKey = new Map<string, number>()
  files.forEach((f, i) => {
    const k = baseKey(f)
    const cur = byKey.get(k)
    if (cur === undefined || f.length < files[cur].length) byKey.set(k, i)
    if (!ENTRY_NAMES.has(k) || !ENTRY_PROCESSES.has(lastSeg(dirs[seedOf[i]])) || importers[i].some((j) => !TEST_NAME.test(files[j]))) return
    const e = entryOf.get(seedOf[i])
    if (e === undefined || f.length < files[e].length) entryOf.set(seedOf[i], i)
  })
  for (const [s, i] of entryOf) proc.set(i, lastSeg(dirs[s]))
  const forks = kept.filter((b) => b.kind === 'fork' || b.kind === 'worker')
  // A key no file is named after can name a folder, as a bundler entry named after its folder does
  // (`headroomProxy.js` built from headroomProxy/proxyMain.ts). The target is that folder's root:
  // a non-test file nothing but tests imports, the one importing most, then the shortest path.
  const folderRoot = (key: string): number | undefined => {
    let best: number | undefined
    files.forEach((f, i) => {
      if (lastSeg(dirOf(f)) !== key || TEST_NAME.test(f) || importers[i].some((j) => !TEST_NAME.test(files[j]))) return
      if (best === undefined || imports[i].length > imports[best].length || (imports[i].length === imports[best].length && f.length < files[best].length)) best = i
    })
    return best
  }
  const targetOf = new Map<string, number | undefined>()
  const folderProc = new Set<number>()
  for (const b of forks) {
    if (targetOf.has(b.key)) continue
    const named = byKey.get(b.key)
    const t = named ?? folderRoot(b.key)
    if (named === undefined && t !== undefined) folderProc.add(t)
    targetOf.set(b.key, t)
  }
  for (const b of forks) {
    const t = targetOf.get(b.key)
    if (t !== undefined) proc.set(t, b.key)
  }

  const owner = new Int32Array(n).fill(-1)
  const bFiles: number[][] = []
  const bProc: string[] = []
  const bEntry: number[] = []
  const entries = [...proc.keys()].sort((a, b) => a - b)
  for (const e of entries) {
    owner[e] = bFiles.length
    bFiles.push([e])
    bProc.push(proc.get(e) as string)
    bEntry.push(e)
  }
  // Exclusive closure: a file joins once every one of its importers is in the closure.
  // Known limitation: a private helper cycle (entry -> h1 <-> h2) never joins, because h1 waits
  // for h2 and h2 for h1; the cycle is clustered on its own instead (pinned by a test).
  for (const e of entries) {
    if (ENTRY_PROCESSES.has(proc.get(e) as string)) continue
    const b = owner[e]
    const seen = new Map<number, number>()
    const stack = [e]
    while (stack.length) {
      const u = stack.pop() as number
      for (const g of imports[u]) {
        if (owner[g] >= 0 || district[g] !== district[e]) continue
        const c = (seen.get(g) ?? 0) + 1
        seen.set(g, c)
        if (c === importers[g].length) {
          owner[g] = b
          bFiles[b].push(g)
          stack.push(g)
        }
      }
    }
  }

  // Files each process building reached from its entry (none for main, renderer and preload).
  const bReached = entries.map((_, b) => bFiles[b].length - 1)

  // A process built from a folder (its key names the folder) owns the rest of that folder too.
  for (const e of entries) {
    if (!folderProc.has(e)) continue
    const dir = dirOf(files[e])
    files.forEach((f, i) => {
      if (owner[i] < 0 && dirOf(f) === dir) {
        owner[i] = owner[e]
        bFiles[owner[e]].push(i)
      }
    })
  }

  // Channel services. An entry serving an IPC channel family (`swarm:tasks`, `swarm:create-task`)
  // that imports exactly one module named for it (swarmManager.ts), where only entries import that
  // module and it imports nothing else of its district, hands those channels to that module: it is
  // the service behind them. With no structural neighbour it would be placed by spelling alone (next
  // to swarmMemory.ts), so it stands as a building of its own, merged only once plain ones are spent.
  const families = new Map<number, Set<string>>()
  for (const b of kept) {
    const e = index.get(b.file) as number
    const colon = b.key.indexOf(':')
    const ns = b.key.slice(0, Math.max(0, colon)).replace(/[^A-Za-z]/g, '').toLowerCase()
    if (b.kind !== 'ipc' || b.side !== 'provide' || !proc.has(e) || ns.length < 3) continue
    const cur = families.get(e)
    if (cur) cur.add(ns)
    else families.set(e, new Set([ns]))
  }
  const services = new Set<number>()
  for (const [e, spaces] of families) {
    const named = new Map<string, number[]>()
    for (const g of imports[e]) {
      const alone =
        owner[g] < 0 &&
        !TEST_NAME.test(files[g]) &&
        district[g] === district[e] &&
        importers[g].every((j) => proc.has(j) || TEST_NAME.test(files[j])) &&
        imports[g].every((h) => proc.has(h) || district[h] !== district[g])
      // Whole leading words only: `window:` names no windowsShortcutRepair.ts.
      const words = [...baseKey(files[g]).matchAll(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g)].map((w) => w[0].toLowerCase())
      const heads = new Set(words.map((_, k) => words.slice(0, k + 1).join('')))
      for (const ns of spaces) if (alone && heads.has(ns)) named.set(ns, [...(named.get(ns) ?? []), g])
    }
    for (const list of named.values()) if (list.length === 1) services.add(list[0])
  }
  const pinned = new Set<number>()
  // What each building before the cap started as (index = building), and what joined that start: for a process,
  // the files reached only from its entry and the rest of the folder it is named for.
  const bStart: Omit<BuildingGrowth, 'folded' | 'cap'>[] = entries.map((e, b) => ({
    start: 'process',
    seed: proc.get(e) as string,
    ...(folderProc.has(e) ? { folder: dirOf(files[e]) } : {}),
    merged: 0,
    mergedFiles: 0,
    reached: bReached[b],
    inFolder: bFiles[b].length - 1 - bReached[b]
  }))
  for (const g of [...services].sort((a, b) => a - b)) {
    bStart.push({ start: 'service', seed: files[g], merged: 0, mergedFiles: 0 })
    owner[g] = bFiles.length
    pinned.add(bFiles.length)
    bFiles.push([g])
    bProc.push('')
    bEntry.push(-1)
  }

  // 3. Cluster the rest, starting from name families: free files in one folder whose names share a
  //    leading word (memoryClient.ts, memoryGraph.ts) are one module by naming convention.
  const family = Int32Array.from({ length: n }, (_, i) => i)
  const firstOf = new Map<string, number>()
  /** A family's root file -> its stem ('/' for a whole small folder); a file in no family has none. */
  const stemOf = new Map<number, string>()
  const inDir = new Map<string, number>()
  for (const f of files) inDir.set(dirOf(f), (inDir.get(dirOf(f)) ?? 0) + 1)
  files.forEach((f, i) => {
    if (owner[i] >= 0) return
    const small = (inDir.get(dirOf(f)) as number) <= FAMILY_FOLDER_MAX && dirOf(f) !== dirs[seedOf[i]]
    const stem = small ? '/' : nameStem(lastSeg(f))
    if (stem === '') return
    const k = `${district[i]}\0${dirOf(f)}\0${stem}`
    const r = firstOf.get(k)
    if (r === undefined) {
      firstOf.set(k, i)
      stemOf.set(i, stem)
    } else family[i] = r
  })
  const fileUf = clusterFree(imports, district, owner, family)
  // Files in each family (keyed by its root): a family of one file is just that file.
  const famSize = new Map<number, number>()
  for (let i = 0; i < n; i++) if (owner[i] < 0) famSize.set(family[i], (famSize.get(family[i]) ?? 0) + 1)
  const rootB = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    if (owner[i] >= 0) continue
    const r = fileUf.find(i)
    let b = rootB.get(r)
    if (b === undefined) {
      b = bFiles.length
      rootB.set(r, b)
      bFiles.push([])
      bProc.push('')
      bEntry.push(-1)
      // The cluster is named for its root's family: the family it grew from (the larger side of every merge).
      // A family of one file (a one-file folder too) started as that file.
      const stem = (famSize.get(r) as number) > 1 ? stemOf.get(r) : undefined
      const dir = dirOf(files[r])
      const none = { merged: 0, mergedFiles: 0 }
      bStart.push(stem === undefined ? { start: 'file', seed: files[r], ...none } : stem === '/' ? { start: 'folder', seed: dir, ...none } : { start: 'family', seed: stem, folder: dir, ...none })
    }
    owner[i] = b
    bFiles[b].push(i)
  }
  // Merged for density: the families in a building less the one it started as, told apart into name families of
  // two or more files and single files.
  const familiesIn = new Map<number, Set<number>>()
  for (const b of rootB.values()) familiesIn.set(b, new Set())
  for (let i = 0; i < n; i++) familiesIn.get(owner[i])?.add(family[i])
  for (const [r, b] of rootB) {
    for (const f of familiesIn.get(b) as Set<number>) {
      if (f === family[r]) continue
      if ((famSize.get(f) as number) > 1) bStart[b].merged++
      else bStart[b].mergedFiles++
    }
  }

  // 4. Cap buildings. Heap key orders (process?, size, first path); adjacency is same-district only.
  const nb = bFiles.length
  const K = n + 1
  const bSize = bFiles.map((m) => m.length)
  // reduce, not Math.min(...m): spreading a 100k-member building overflows the call stack.
  const bMin = bFiles.map((m) => m.reduce((a, x) => Math.min(a, x)))
  const bDist = bFiles.map((m) => district[m[0]])
  const bStamp = new Int32Array(nb)
  // Per building: how many members share each folder + name stem, and the largest such count.
  const bStems = bFiles.map((m) => {
    const c = new Map<string, number>()
    for (const i of m) {
      const stem = nameStem(lastSeg(files[i]))
      if (stem !== '') {
        const k = `${dirOf(files[i])}\u0000${stem}`
        c.set(k, (c.get(k) ?? 0) + 1)
      }
    }
    return c
  })
  const topOf = (c: Map<string, number>): number => [...c.values()].reduce((a, x) => Math.max(a, x), 0)
  const bTop = bStems.map(topOf)
  const bAdj = Array.from({ length: nb }, () => new Map<number, number>())
  imports.forEach((targets, i) => {
    for (const g of targets) {
      const a = owner[i]
      const b = owner[g]
      if (a !== b && bDist[a] === bDist[b]) {
        bump(bAdj[a], b, 1)
        bump(bAdj[b], a, 1)
      }
    }
  })
  const prev = new Int32Array(nb).fill(-1)
  const next = new Int32Array(nb).fill(-1)
  const tail = new Map<number, number>()
  const perDistrict = new Map<number, number>()
  for (const b of [...bMin.keys()].sort((x, y) => bMin[x] - bMin[y])) {
    const t = tail.get(bDist[b])
    if (t !== undefined) [prev[b], next[t]] = [t, b]
    tail.set(bDist[b], b)
    perDistrict.set(bDist[b], (perDistrict.get(bDist[b]) ?? 0) + 1)
  }
  // Process buildings and channel services are fixed: merged last, and never a link target.
  const fixed = (b: number): boolean => bEntry[b] >= 0 || pinned.has(b)
  const cohesive = (b: number): boolean => bTop[b] >= COHESIVE_MIN && bTop[b] >= bSize[b] * COHESIVE_SHARE
  // Weighted sizes reach COHESIVE_WEIGHT * n, so fixed buildings sit above every plain key.
  const key = (b: number): number =>
    (fixed(b) ? (COHESIVE_WEIGHT + 1) * K * K : 0) + bSize[b] * (cohesive(b) ? COHESIVE_WEIGHT : 1) * K + bMin[b]
  const heap = new Heap<[number, number, number]>((x, y) => x[0] < y[0])
  for (let b = 0; b < nb; b++) heap.push([key(b), b, 0])
  const bUf = new UnionFind(nb)
  for (let live = nb; live > maxBuildings; ) {
    const [, b, s] = heap.pop()
    if (s !== bStamp[b] || (perDistrict.get(bDist[b]) as number) < 2) continue
    // The densest link (weight over the neighbour's size, so a hub that imports everything never
    // wins by bulk), ties in path order. A fixed building never takes in a plain one by a link:
    // its name says what runs or answers there, and unrelated helpers would blur that.
    let t = -1
    for (const [o, w] of bAdj[b]) {
      if (fixed(o)) continue
      const d = t < 0 ? 1 : w * bSize[t] - (bAdj[b].get(t) as number) * bSize[o]
      if (d > 0 || (d === 0 && bMin[o] < bMin[t])) t = o
    }
    if (t < 0) {
      // Nearest in path order, skipping fixed buildings while a plain one is left.
      const at = files[bMin[b]]
      const step = (from: number, dir: Int32Array): number => {
        let x = from
        while (x >= 0 && fixed(x)) x = dir[x]
        return x
      }
      let p = step(prev[b], prev)
      let q = step(next[b], next)
      // A plain building on either side wins; only with none left does a fixed neighbour take it.
      if (p < 0 && q < 0) [p, q] = [prev[b], next[b]]
      const lp = p < 0 ? -1 : prefixLen(at, files[bMin[p]])
      const lq = q < 0 ? -1 : prefixLen(at, files[bMin[q]])
      t = lp >= lq ? p : q
    }
    if (prev[b] >= 0) next[prev[b]] = next[b]
    if (next[b] >= 0) prev[next[b]] = prev[b]
    bStamp[b]++
    bStamp[t]++
    bUf.attach(b, t)
    perDistrict.set(bDist[b], (perDistrict.get(bDist[b]) as number) - 1)
    live--
    bSize[t] += bSize[b]
    bMin[t] = Math.min(bMin[t], bMin[b])
    for (const [k, c] of bStems[b]) bStems[t].set(k, (bStems[t].get(k) ?? 0) + c)
    bTop[t] = topOf(bStems[t])
    for (const [k, w] of bAdj[b]) {
      bAdj[k].delete(b)
      if (k !== t) {
        bump(bAdj[t], k, w)
        bump(bAdj[k], t, w)
      }
    }
    bAdj[b].clear()
    heap.push([key(t), t, bStamp[t]])
  }

  // 5. Ids and names.
  const finalOf = (i: number): number => bUf.find(owner[i])
  const members = new Map<number, string[]>()
  for (let i = 0; i < n; i++) {
    const b = finalOf(i)
    const m = members.get(b)
    if (m) m.push(files[i])
    else members.set(b, [files[i]])
  }
  const liveB = [...members.keys()].sort((x, y) => x - y)
  // Buildings the cap folded into each live one.
  const folded = new Map<number, number>()
  for (let b = 0; b < nb; b++) folded.set(bUf.find(b), (folded.get(bUf.find(b)) ?? -1) + 1)
  const districtRoots = [...new Set(district)].sort((x, y) => x - y)
  const dIds = uniqueIds(districtRoots.map((d) => ({ base: `d-${idSlug(dirs[d]) || 'root'}`, tag: '', order: dirs[d] })))
  const dIdOf = new Map(districtRoots.map((d, i) => [d, dIds[i]]))
  const anchors = liveB.map((b) => {
    const m = members.get(b) as string[]
    return bEntry[b] >= 0 ? stripExt(files[bEntry[b]]) : m.length === 1 ? stripExt(m[0]) : commonDir(m)
  })
  const boundariesOf = new Map<number, Boundary[]>(liveB.map((b) => [b, []]))
  for (const bd of kept) (boundariesOf.get(finalOf(index.get(bd.file) as number)) as Boundary[]).push(bd)
  // A plain building is named after its front door: the non-test member whose imports reach most
  // of the building, then the one most imported from outside it, then most imported overall, then
  // path order; names that would pass for the district or a main/renderer/preload entry are skipped.
  const frontDoor = (b: number, dName: string): number => {
    const own = new Set((members.get(b) as string[]).map((f) => index.get(f) as number))
    const key = new Map<number, number[]>()
    const inside = new Map([...own].map((i) => [i, importers[i].filter((j) => own.has(j)).length]))
    let budget = FRONT_DOOR_BUDGET
    for (const i of [...own].sort((x, y) => (inside.get(x) as number) - (inside.get(y) as number) || x - y)) {
      const seen = new Set([i])
      const stack = budget > 0 ? [i] : []
      while (stack.length && budget > 0) {
        for (const g of imports[stack.pop() as number]) {
          if (own.has(g) && !seen.has(g)) {
            seen.add(g)
            stack.push(g)
          }
        }
        budget--
      }
      const outside = importers[i].length - (inside.get(i) as number)
      key.set(i, [TEST_NAME.test(files[i]) ? 0 : 1, seen.size, outside, importers[i].length])
    }
    const rank = (x: number, y: number): number => {
      const kx = key.get(x) as number[]
      const ky = key.get(y) as number[]
      for (let k = 0; k < kx.length; k++) if (kx[k] !== ky[k]) return ky[k] - kx[k]
      return x - y
    }
    const pick = [...own].sort(rank).find((i) => {
      const k = memberKey(files[i])
      return k !== dName && !ENTRY_PROCESSES.has(k)
    })
    return pick === undefined ? -1 : pick
  }
  // Each building's own anchor file: its entry, else its front door, else its first member. A colliding id takes its tag and
  // suffix from it (review K5), so a file that joins a building, or a sibling renamed, never moves the id or its notes.
  const doors = liveB.map((b) => (bEntry[b] >= 0 ? -1 : frontDoor(b, lastSeg(dirs[bDist[b]]) || 'root')))
  const anchorFile = (b: number, i: number): string =>
    bEntry[b] >= 0 ? files[bEntry[b]] : doors[i] >= 0 ? files[doors[i]] : (members.get(b) as string[])[0]
  const bIds = uniqueIds(
    liveB.map((b, i) => {
      const own = anchorFile(b, i)
      return { base: `b-${idSlug(anchors[i]) || 'root'}`, tag: idSlug(baseKey(own)), order: own }
    })
  )
  const bIdOf = new Map(liveB.map((b, i) => [b, bIds[i]]))
  const buildings: GroupBuilding[] = liveB.map((b, i) => {
    const m = members.get(b) as string[]
    // The first member's own seed folder, so a renderer file stays 'renderer' after a district merge.
    const dName = lastSeg(dirs[seedOf[index.get(m[0]) as number]])
    return {
      id: bIds[i],
      districtId: dIdOf.get(bDist[b]) as string,
      name: bEntry[b] >= 0 ? bProc[b] : (doors[i] >= 0 ? memberKey(files[doors[i]]) : '') || lastSeg(anchors[i]) || 'root',
      members: m,
      process: bEntry[b] >= 0 ? runsIn(bProc[b]) : ENTRY_PROCESSES.has(dName) ? runsIn(dName) : '',
      boundaries: boundariesOf.get(b) as Boundary[],
      growth: { ...bStart[b], folded: folded.get(b) as number, cap: maxBuildings }
    }
  })
  buildings.sort((x, y) => cmp(x.id, y.id))
  const districts = districtRoots
    .map((d) => {
      const id = dIdOf.get(d) as string
      return { id, name: lastSeg(dirs[d]) || 'root', members: buildings.filter((b) => b.districtId === id).map((b) => b.id) }
    })
    .sort((x, y) => cmp(x.id, y.id))

  // 6. Edges.
  const edgeMap = new Map<string, GroupEdge>()
  const link = (fromB: number, toB: number, via: Boundary[]): void => {
    const from = bIdOf.get(fromB) as string
    const to = bIdOf.get(toB) as string
    if (from === to) return
    const k = `${from}\0${to}`
    const e = edgeMap.get(k)
    if (e) e.via.push(...via)
    else edgeMap.set(k, { from, to, via: [...via] })
  }
  const at = (b: Boundary): number => finalOf(index.get(b.file) as number)
  imports.forEach((targets, i) => targets.forEach((g) => link(finalOf(i), finalOf(g), [])))
  for (const b of forks) {
    const t = targetOf.get(b.key)
    if (t !== undefined) link(at(b), finalOf(t), [b])
  }
  const pairs = new Map<string, { provide: Boundary[]; consume: Boundary[] }>()
  for (const b of kept) {
    const k = `${b.kind}\0${b.key}`
    let p = pairs.get(k)
    if (!p) pairs.set(k, (p = { provide: [], consume: [] }))
    p[b.side].push(b)
  }
  // Group each side by building first: N consumers x M providers cost one link per building pair.
  const byBuilding = (list: Boundary[]): Map<number, Boundary[]> => {
    const m = new Map<number, Boundary[]>()
    for (const b of list) {
      const cur = m.get(at(b))
      if (cur) cur.push(b)
      else m.set(at(b), [b])
    }
    return m
  }
  for (const { provide, consume } of pairs.values()) {
    const providers = byBuilding(provide)
    for (const [cb, cs] of byBuilding(consume)) for (const [pb, ps] of providers) link(cb, pb, [...cs, ...ps])
  }
  const edges = [...edgeMap.keys()].sort(cmp).map((k) => {
    const e = edgeMap.get(k) as GroupEdge
    const via = e.via.sort(cmpBoundary).filter((b, i, a) => i === 0 || cmpBoundary(a[i - 1], b) !== 0)
    return { from: e.from, to: e.to, via }
  })

  return { districts, buildings, edges }
}
