// Lumopolis: groups a project into districts (subsystems), buildings (services or processes) and
// edges (dependencies). Pure and deterministic: no fs, no Electron, and only a type import from
// codeGraph, so tree-sitter never loads in the utility process that runs this.
//
// 1. Districts are seeded from the top-level folders under src/ (or the repository root), then
//    capped by merging the smallest into its most-connected neighbour.
// 2. Process entries (fork/worker targets, main/renderer/preload entries) each become a building
//    together with their exclusive import closure inside their district.
// 3. Remaining files are clustered with union-find: clusters in one district merge, densest first,
//    while their cross-edge density is above MERGE_DENSITY.
// 4. Buildings are capped by merging the smallest into its most-connected neighbour in the same
//    district (else its nearest in path order). Process buildings go last.
// 5. Ids are slugs of member paths, suffixed -2, -3 on collision in path order.
// 6. Edges come from resolved imports, fork/worker targets and provide/consume boundary pairs.
import type { GraphSnapshot } from '../codeGraph'
import type { District } from '../../shared/world/types'
import { baseKey, type Boundary } from './detectors/common'

export interface GroupBuilding {
  id: string
  districtId: string
  name: string
  /** Repository-relative paths, sorted. */
  members: string[]
  /** Process buildings: the fork/worker key or main/renderer/preload. Others: the district's process or ''. */
  process: string
  boundaries: Boundary[]
}

/** Directed dependency: importer -> imported, consumer -> provider, forker -> forked. */
export interface GroupEdge {
  from: string
  to: string
  /** Boundaries behind the edge (empty for import-only edges). */
  via: Boundary[]
}

export interface Grouping {
  districts: Omit<District, 'hue' | 'subtitle'>[]
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

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'vendor'])
const ENTRY_PROCESSES = new Set(['main', 'renderer', 'preload'])
const ENTRY_NAMES = new Set(['index', 'main'])
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const JS_TO_TS: readonly (readonly [string, string])[] = [
  ['.js', '.ts'],
  ['.js', '.tsx'],
  ['.jsx', '.tsx'],
  ['.mjs', '.mts'],
  ['.cjs', '.cts']
]
const RELATIVE = /^\.\.?(\/|$)/

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** True for files under node_modules/dist/out/build/vendor folders, and minified bundles. */
export function isIgnored(path: string): boolean {
  return path.endsWith('.min.js') || path.split('/').slice(0, -1).some((seg) => IGNORED_DIRS.has(seg))
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

/** Seed districts: src/<x> when there is a src folder, else the repository root's folders. */
function seedDistricts(files: readonly string[]): { dirs: string[]; seedOf: Int32Array } {
  const srcRoot = files.some((f) => f.startsWith('src/')) ? 'src' : ''
  const dirOfFile = files.map((f) => topDir(f, srcRoot) ?? (topDir(f, '') as string))
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
function clusterFree(imports: number[][], district: Int32Array, owner: Int32Array): UnionFind {
  const n = imports.length
  const uf = new UnionFind(n)
  const size = new Int32Array(n).fill(1)
  const minIdx = Int32Array.from({ length: n }, (_, i) => i)
  const stamp = new Int32Array(n)
  const adj = Array.from({ length: n }, () => new Map<number, number>())
  for (let i = 0; i < n; i++) {
    if (owner[i] >= 0) continue
    for (const g of imports[i]) {
      if (owner[g] < 0 && district[g] === district[i]) {
        bump(adj[i], g, 1)
        bump(adj[g], i, 1)
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

function uniqueIds(items: readonly { base: string; order: string }[]): string[] {
  const keyed = items.map((it, i) => ({ k: `${it.base}\0${it.order}`, i })).sort((x, y) => cmp(x.k, y.k))
  const used = new Set<string>()
  const out = new Array<string>(items.length)
  for (const { i } of keyed) {
    let id = items[i].base
    for (let k = 2; used.has(id); k++) id = `${items[i].base}-${k}`
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
  const kept = bounds.filter((b) => fileSet.has(b.file)).sort(cmpBoundary)

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
    if (!ENTRY_NAMES.has(k) || !ENTRY_PROCESSES.has(lastSeg(dirs[seedOf[i]]))) return
    const e = entryOf.get(seedOf[i])
    if (e === undefined || f.length < files[e].length) entryOf.set(seedOf[i], i)
  })
  for (const [s, i] of entryOf) proc.set(i, lastSeg(dirs[s]))
  const forks = kept.filter((b) => b.kind === 'fork' || b.kind === 'worker')
  for (const b of forks) {
    const t = byKey.get(b.key)
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
  for (const e of entries) {
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

  // 3. Cluster the rest.
  const fileUf = clusterFree(imports, district, owner)
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
    }
    owner[i] = b
    bFiles[b].push(i)
  }

  // 4. Cap buildings. Heap key orders (process?, size, first path); adjacency is same-district only.
  const nb = bFiles.length
  const K = n + 1
  const bSize = bFiles.map((m) => m.length)
  const bMin = bFiles.map((m) => Math.min(...m))
  const bDist = bFiles.map((m) => district[m[0]])
  const bStamp = new Int32Array(nb)
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
  const key = (b: number): number => (bEntry[b] >= 0 ? K * K : 0) + bSize[b] * K + bMin[b]
  const heap = new Heap<[number, number, number]>((x, y) => x[0] < y[0])
  for (let b = 0; b < nb; b++) heap.push([key(b), b, 0])
  const bUf = new UnionFind(nb)
  for (let live = nb; live > maxBuildings; ) {
    const [, b, s] = heap.pop()
    if (s !== bStamp[b] || (perDistrict.get(bDist[b]) as number) < 2) continue
    let t = -1
    let best = -1
    for (const [o, w] of bAdj[b]) {
      const score = w * K + (K - 1 - bMin[o])
      if (score > best) {
        t = o
        best = score
      }
    }
    if (t < 0) {
      const at = files[bMin[b]]
      const lp = prev[b] < 0 ? -1 : prefixLen(at, files[bMin[prev[b]]])
      const lq = next[b] < 0 ? -1 : prefixLen(at, files[bMin[next[b]]])
      t = lp >= lq ? prev[b] : next[b]
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
  const districtRoots = [...new Set(district)].sort((x, y) => x - y)
  const dIds = uniqueIds(districtRoots.map((d) => ({ base: `d-${slug(dirs[d]) || 'root'}`, order: dirs[d] })))
  const dIdOf = new Map(districtRoots.map((d, i) => [d, dIds[i]]))
  const anchors = liveB.map((b) => {
    const m = members.get(b) as string[]
    return bEntry[b] >= 0 ? stripExt(files[bEntry[b]]) : m.length === 1 ? stripExt(m[0]) : commonDir(m)
  })
  const bIds = uniqueIds(liveB.map((b, i) => ({ base: `b-${slug(anchors[i]) || 'root'}`, order: (members.get(b) as string[])[0] })))
  const bIdOf = new Map(liveB.map((b, i) => [b, bIds[i]]))
  const boundariesOf = new Map<number, Boundary[]>(liveB.map((b) => [b, []]))
  for (const bd of kept) (boundariesOf.get(finalOf(index.get(bd.file) as number)) as Boundary[]).push(bd)
  const buildings: GroupBuilding[] = liveB.map((b, i) => {
    const m = members.get(b) as string[]
    const dName = lastSeg(dirs[bDist[b]])
    return {
      id: bIds[i],
      districtId: dIdOf.get(bDist[b]) as string,
      name: bEntry[b] >= 0 ? bProc[b] : m.length === 1 ? baseKey(m[0]) : lastSeg(anchors[i]) || 'root',
      members: m,
      process: bEntry[b] >= 0 ? bProc[b] : ENTRY_PROCESSES.has(dName) ? dName : '',
      boundaries: boundariesOf.get(b) as Boundary[]
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
  const link = (fromFile: number, toFile: number, via: Boundary[]): void => {
    const from = bIdOf.get(finalOf(fromFile)) as string
    const to = bIdOf.get(finalOf(toFile)) as string
    if (from === to) return
    const k = `${from}\0${to}`
    const e = edgeMap.get(k)
    if (e) e.via.push(...via)
    else edgeMap.set(k, { from, to, via: [...via] })
  }
  imports.forEach((targets, i) => targets.forEach((g) => link(i, g, [])))
  for (const b of forks) {
    const t = byKey.get(b.key)
    if (t !== undefined) link(index.get(b.file) as number, t, [b])
  }
  const pairs = new Map<string, { provide: Boundary[]; consume: Boundary[] }>()
  for (const b of kept) {
    const k = `${b.kind}\0${b.key}`
    let p = pairs.get(k)
    if (!p) pairs.set(k, (p = { provide: [], consume: [] }))
    p[b.side].push(b)
  }
  for (const { provide, consume } of pairs.values()) {
    for (const c of consume) for (const p of provide) link(index.get(c.file) as number, index.get(p.file) as number, [c, p])
  }
  const edges = [...edgeMap.keys()].sort(cmp).map((k) => {
    const e = edgeMap.get(k) as GroupEdge
    const via = e.via.sort(cmpBoundary).filter((b, i, a) => i === 0 || cmpBoundary(a[i - 1], b) !== 0)
    return { from: e.from, to: e.to, via }
  })

  return { districts, buildings, edges }
}
