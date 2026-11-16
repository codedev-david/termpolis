import { describe, expect, it } from 'vitest'
import type { GraphSnapshot } from '../../src/main/codeGraph'
import type { Boundary } from '../../src/main/world/detectors'
import {
  DEFAULT_MAX_BUILDINGS,
  DEFAULT_MAX_DISTRICTS,
  MERGE_DENSITY,
  groupProject,
  isIgnored,
  resolveImport,
  slug,
  type Grouping
} from '../../src/main/world/group'

/** Snapshot whose files are the keys of `fileImports` plus `extra`. */
function snap(fileImports: Record<string, string[]>, extra: string[] = []): GraphSnapshot {
  const files = [...new Set([...Object.keys(fileImports), ...extra])].sort()
  return { root: '/repo', files, symbols: [], callEdges: [], fileImports }
}

function B(kind: Boundary['kind'], key: string, side: Boundary['side'], file: string, line = 1): Boundary {
  return { kind, key, side, file, line }
}

function home(g: Grouping, file: string): Grouping['buildings'][number] {
  const b = g.buildings.find((x) => x.members.includes(file))
  if (!b) throw new Error(`no building for ${file}`)
  return b
}

const ids = (g: Grouping): string[] => g.buildings.map((b) => b.id)

/** Structural invariants every grouping must satisfy. */
function checkInvariants(g: Grouping, files: string[]): void {
  const all = g.buildings.flatMap((b) => b.members)
  expect([...all].sort()).toEqual([...files].sort())
  expect(new Set(all).size).toBe(all.length)
  const bIds = ids(g)
  expect(new Set(bIds).size).toBe(bIds.length)
  expect([...bIds].sort()).toEqual(bIds)
  const dIds = g.districts.map((d) => d.id)
  expect([...dIds].sort()).toEqual(dIds)
  for (const d of g.districts) {
    expect(d.members).toEqual(g.buildings.filter((b) => b.districtId === d.id).map((b) => b.id))
    expect(d.members.length).toBeGreaterThan(0)
  }
  for (const b of g.buildings) {
    expect(dIds).toContain(b.districtId)
    expect([...b.members].sort()).toEqual(b.members)
  }
  for (const e of g.edges) {
    expect(bIds).toContain(e.from)
    expect(bIds).toContain(e.to)
    expect(e.from).not.toBe(e.to)
  }
  const keys = g.edges.map((e) => `${e.from}\0${e.to}`)
  expect([...keys].sort()).toEqual(keys)
  expect(new Set(keys).size).toBe(keys.length)
}

describe('constants', () => {
  it('uses the documented defaults', () => {
    expect(DEFAULT_MAX_DISTRICTS).toBe(12)
    expect(DEFAULT_MAX_BUILDINGS).toBe(60)
    expect(MERGE_DENSITY).toBe(0.35)
  })
})

describe('slug', () => {
  it('lowercases, collapses non-alphanumeric runs and trims dashes', () => {
    expect(slug('src/main')).toBe('src-main')
    expect(slug('  A__B--c/memoryHost ')).toBe('a-b-c-memoryhost')
    expect(slug('_')).toBe('')
    expect(slug('')).toBe('')
  })
})

describe('isIgnored', () => {
  it('ignores vendored and build output directories and minified bundles', () => {
    for (const p of ['node_modules/x/index.js', 'dist/a.js', 'out/b.js', 'build/c.js', 'vendor/d.js', 'src/main/build/gen.ts', 'src/lib/jq.min.js']) {
      expect(isIgnored(p)).toBe(true)
    }
    for (const p of ['src/main/build.ts', 'src/main/dist.ts', 'src/main/a.js', 'src/outline/x.ts']) {
      expect(isIgnored(p)).toBe(false)
    }
  })
})

describe('resolveImport', () => {
  const files = new Set([
    'src/a/x.ts',
    'src/a/y.tsx',
    'src/a/m.mts',
    'src/a/c.cts',
    'src/a/dir/index.tsx',
    'src/a/style.css',
    'src/a/index.ts',
    'src/a/plain.js',
    'src/index.js',
    'b.ts',
    'index.ts'
  ])
  const r = (spec: string, importer = 'src/a/q.ts'): string | null => resolveImport(importer, spec, files)

  it('tries the exact path, then extensions, then index files', () => {
    expect(r('./x')).toBe('src/a/x.ts')
    expect(r('./style.css')).toBe('src/a/style.css')
    expect(r('./plain')).toBe('src/a/plain.js')
    expect(r('./dir')).toBe('src/a/dir/index.tsx')
    expect(r('./dir/')).toBe('src/a/dir/index.tsx')
    expect(r('.//x')).toBe('src/a/x.ts')
  })
  it('maps TS ESM style .js specifiers onto TypeScript files', () => {
    expect(r('./x.js')).toBe('src/a/x.ts')
    expect(r('./y.js')).toBe('src/a/y.tsx')
    expect(r('./y.jsx')).toBe('src/a/y.tsx')
    expect(r('./m.mjs')).toBe('src/a/m.mts')
    expect(r('./c.cjs')).toBe('src/a/c.cts')
  })
  it('resolves . and .. against the importer directory', () => {
    expect(r('.')).toBe('src/a/index.ts')
    expect(r('..')).toBe('src/index.js')
    expect(r('../a/./x')).toBe('src/a/x.ts')
    expect(r('./b', 'a.ts')).toBe('b.ts')
    expect(r('.', 'a.ts')).toBe('index.ts')
  })
  it('ignores bare packages, paths above the root and missing files', () => {
    expect(r('react')).toBeNull()
    expect(r('@scope/pkg')).toBeNull()
    expect(r('.hidden')).toBeNull()
    expect(r('../../../x')).toBeNull()
    expect(r('./missing')).toBeNull()
  })
})

describe('groupProject', () => {
  it('every fork/worker target becomes its own building with process = target name', () => {
    const s = snap({
      'src/main/index.ts': ['./store', './util', 'electron', './util.js'],
      'src/main/memoryHost.ts': ['./store', './memory/db'],
      'src/main/memory/db.ts': ['./schema'],
      'src/main/memory/schema.ts': [],
      'src/main/store.ts': [],
      'src/main/util.ts': [],
      'src/main/indexer.ts': [],
      'src/main/legacy/memoryHost.ts': []
    })
    const fork = B('fork', 'memoryHost', 'consume', 'src/main/index.ts', 10)
    const worker = B('worker', 'indexer', 'consume', 'src/main/store.ts', 3)
    const ghost = B('fork', 'ghost', 'consume', 'src/main/util.ts', 2)
    const g = groupProject(s, [worker, ghost, fork])
    checkInvariants(g, s.files)

    const host = home(g, 'src/main/memoryHost.ts')
    expect(host).toMatchObject({ id: 'b-src-main-memoryhost', name: 'memoryHost', process: 'memoryHost', districtId: 'd-src-main' })
    // Its exclusive import closure comes along; shared files do not.
    expect(host.members).toEqual(['src/main/memory/db.ts', 'src/main/memory/schema.ts', 'src/main/memoryHost.ts'])
    expect(home(g, 'src/main/indexer.ts')).toMatchObject({ id: 'b-src-main-indexer', process: 'indexer', members: ['src/main/indexer.ts'] })
    // The main entry is a process building too, with its private helper.
    const main = home(g, 'src/main/index.ts')
    expect(main).toMatchObject({ id: 'b-src-main-index', name: 'main', process: 'main', members: ['src/main/index.ts', 'src/main/util.ts'] })
    expect(main.boundaries).toEqual([fork, ghost])
    // A non-process building in the main district runs in the main process.
    expect(home(g, 'src/main/store.ts')).toMatchObject({ id: 'b-src-main-store', name: 'store', process: 'main', boundaries: [worker] })
    // The shortest path wins the target match; the longer one stays an ordinary building.
    expect(home(g, 'src/main/legacy/memoryHost.ts')).toMatchObject({ id: 'b-src-main-legacy-memoryhost', process: 'main' })

    expect(g.edges).toEqual([
      { from: 'b-src-main-index', to: 'b-src-main-memoryhost', via: [fork] },
      { from: 'b-src-main-index', to: 'b-src-main-store', via: [] },
      { from: 'b-src-main-memoryhost', to: 'b-src-main-store', via: [] },
      { from: 'b-src-main-store', to: 'b-src-main-indexer', via: [worker] }
    ])
  })

  it('matches equally short fork targets in path order and skips edges inside one building', () => {
    const s = snap({
      'src/a/x.ts': [],
      'src/b/x.ts': [],
      'src/c/run.ts': [],
      'src/c/self.ts': []
    })
    const w = B('worker', 'x', 'consume', 'src/c/run.ts')
    const self = B('worker', 'self', 'consume', 'src/c/self.ts')
    const g = groupProject(s, [w, self])
    checkInvariants(g, s.files)
    expect(home(g, 'src/a/x.ts').process).toBe('x')
    expect(home(g, 'src/b/x.ts').process).toBe('')
    expect(home(g, 'src/c/self.ts').process).toBe('self')
    expect(g.edges).toEqual([{ from: 'b-src-c-run', to: 'b-src-a-x', via: [w] }])
  })

  it('files that import each other densely share a building', () => {
    const s = snap({
      'src/lib/a.ts': ['./b', './c'],
      'src/lib/b.ts': ['./a', './c'],
      'src/lib/c.ts': ['./a', './b'],
      'src/lib/d.ts': ['./a'],
      'src/lib/x.ts': ['./y'],
      'src/lib/y.ts': ['./z'],
      'src/lib/z.ts': [],
      'src/other/o.ts': ['../lib/z']
    })
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    expect(home(g, 'src/lib/a.ts').members).toEqual(['src/lib/a.ts', 'src/lib/b.ts', 'src/lib/c.ts'])
    expect(home(g, 'src/lib/a.ts')).toMatchObject({ id: 'b-src-lib--a', name: 'lib', process: '' })
    expect(home(g, 'src/lib/d.ts').members).toEqual(['src/lib/d.ts'])
    // A one-way chain only pairs up: density 1/(2*2*1) = 0.25 for the third link.
    expect(home(g, 'src/lib/x.ts')).toMatchObject({ id: 'b-src-lib--x', members: ['src/lib/x.ts', 'src/lib/y.ts'] })
    expect(home(g, 'src/lib/z.ts').members).toEqual(['src/lib/z.ts'])
    // Imports across districts never merge buildings, but they are edges.
    expect(home(g, 'src/other/o.ts').members).toEqual(['src/other/o.ts'])
    expect(g.edges).toContainEqual({ from: 'b-src-other-o', to: 'b-src-lib-z', via: [] })
    expect(g.edges).toContainEqual({ from: 'b-src-lib-d', to: 'b-src-lib--a', via: [] })
  })

  it('a smaller cluster joins a larger one when their cross density is high enough', () => {
    // a1..a3 form first (path order), then x<->y; {x,y} to {a1,a2,a3} is 5/(2*2*3) = 0.42.
    const s = snap({
      'src/s/a1.ts': ['./a2', './a3', './x'],
      'src/s/a2.ts': ['./a1', './a3', './x'],
      'src/s/a3.ts': ['./a1', './a2'],
      'src/s/x.ts': ['./a1', './a2', './y'],
      'src/s/y.ts': ['./x', './a3']
    })
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    expect(g.buildings).toHaveLength(1)
  })

  it('top-level source folders seed districts', () => {
    const s = snap({
      'src/main/index.ts': [],
      'src/main/a.ts': [],
      'src/renderer/src/main.tsx': [],
      'src/preload/index.ts': [],
      'src/preload/main.tsx': []
    })
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    expect(g.districts).toEqual([
      { id: 'd-src-main', name: 'main', members: ['b-src-main-a', 'b-src-main-index'] },
      { id: 'd-src-preload', name: 'preload', members: ['b-src-preload-index', 'b-src-preload-main'] },
      { id: 'd-src-renderer', name: 'renderer', members: ['b-src-renderer-src-main'] }
    ])
    expect(home(g, 'src/main/index.ts')).toMatchObject({ name: 'main', process: 'main' })
    expect(home(g, 'src/main/a.ts')).toMatchObject({ name: 'a', process: 'main' })
    // Equally short entry candidates: path order picks index over main.
    expect(home(g, 'src/preload/index.ts')).toMatchObject({ name: 'preload', process: 'preload' })
    expect(home(g, 'src/preload/main.tsx')).toMatchObject({ name: 'main', process: 'preload' })
    expect(home(g, 'src/renderer/src/main.tsx')).toMatchObject({ name: 'renderer', process: 'renderer' })
  })

  it('seeds districts from the repository root when there is no src folder', () => {
    const s = snap({ 'app/a.ts': [], 'lib/b.ts': [], 'index.ts': [] })
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    expect(g.districts.map((d) => [d.id, d.name])).toEqual([
      ['d-app', 'app'],
      ['d-lib', 'lib'],
      ['d-root', 'root']
    ])
  })

  it('files outside src get their own top-level districts', () => {
    const s = snap({ 'src/main/a.ts': [], 'src/top.ts': [], 'scripts/x.ts': [], 'README.ts': [] })
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    expect(g.districts.map((d) => [d.id, d.name])).toEqual([
      ['d-root', 'root'],
      ['d-scripts', 'scripts'],
      ['d-src', 'src'],
      ['d-src-main', 'main']
    ])
  })

  it('collisions: natural ids first, then --basename, then -2 in path order', () => {
    const s = snap({
      'src/a-b/y.ts': [],
      'src/a-b-2/z.ts': [],
      'src/a_b/x.ts': [],
      'src/main.ts': [],
      'src/main-2.ts': [],
      'src/main/x/a.ts': ['../y/b'],
      'src/main/y/b.ts': ['../x/a'],
      'src/q/a/x.ts': ['../c/k'],
      'src/q/c/k.ts': ['../a/x'],
      'src/q/b/x.ts': ['../d/k'],
      'src/q/d/k.ts': ['../b/x']
    })
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    // Districts carry no tag: the natural d-src-a-b-2 keeps its id, so a_b skips to -3.
    expect(home(g, 'src/a-b/y.ts').districtId).toBe('d-src-a-b')
    expect(home(g, 'src/a-b-2/z.ts').districtId).toBe('d-src-a-b-2')
    expect(home(g, 'src/a_b/x.ts').districtId).toBe('d-src-a-b-3')
    // src/main.ts and the src/main/{x,y} building share b-src-main, so both are tagged.
    expect(home(g, 'src/main.ts').id).toBe('b-src-main--main')
    expect(home(g, 'src/main/x/a.ts')).toMatchObject({ id: 'b-src-main--a', name: 'main', members: ['src/main/x/a.ts', 'src/main/y/b.ts'] })
    // A natural id is never suffixed.
    expect(home(g, 'src/main-2.ts').id).toBe('b-src-main-2')
    // Same base and same first basename: -2 in path order.
    expect(home(g, 'src/q/a/x.ts').id).toBe('b-src-q--x')
    expect(home(g, 'src/q/b/x.ts').id).toBe('b-src-q--x-2')
  })

  it('ids stay put when an unrelated cluster joins the same folder', () => {
    const base: Record<string, string[]> = {
      'src/main/q1.ts': ['./q2'],
      'src/main/q2.ts': ['./q1'],
      'src/main/x1.ts': ['./x2'],
      'src/main/x2.ts': ['./x1'],
      'src/main/a1.ts': ['./a2'],
      'src/main/a2.ts': ['./a1'],
      'src/main/solo.ts': []
    }
    const idOf = (g: Grouping): Record<string, string> =>
      Object.fromEntries(g.buildings.flatMap((b) => b.members.map((m) => [m, b.id])))
    const before = idOf(groupProject(snap(base), []))
    expect(before).toMatchObject({ 'src/main/a1.ts': 'b-src-main--a1', 'src/main/q1.ts': 'b-src-main--q1', 'src/main/x1.ts': 'b-src-main--x1', 'src/main/solo.ts': 'b-src-main-solo' })
    const withPair = idOf(groupProject(snap({ ...base, 'src/main/c1.ts': ['./c2'], 'src/main/c2.ts': ['./c1'] }), []))
    expect(withPair['src/main/c1.ts']).toBe('b-src-main--c1')
    for (const [f, id] of Object.entries(before)) expect(withPair[f]).toBe(id)
  })

  it('ids stay put when a lone src/main.ts is added', () => {
    const base: Record<string, string[]> = {
      'src/main/q1.ts': ['./q2'],
      'src/main/q2.ts': ['./q1'],
      'src/main/a1.ts': ['./a2'],
      'src/main/a2.ts': ['./a1'],
      'src/main/solo.ts': []
    }
    const idOf = (g: Grouping): Record<string, string> =>
      Object.fromEntries(g.buildings.flatMap((b) => b.members.map((m) => [m, b.id])))
    const before = idOf(groupProject(snap(base), []))
    const after = idOf(groupProject(snap({ ...base, 'src/main.ts': [] }), []))
    expect(after['src/main.ts']).toBe('b-src-main--main')
    for (const [f, id] of Object.entries(before)) expect(after[f]).toBe(id)
  })

  it('pins the cyclic private helper limitation: the cycle stays out of the entry building', () => {
    const s = snap({ 'src/main/index.ts': ['./h1'], 'src/main/h1.ts': ['./h2'], 'src/main/h2.ts': ['./h1'] })
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    expect(g.buildings.map((b) => [b.id, b.members, b.process])).toEqual([
      ['b-src-main', ['src/main/h1.ts', 'src/main/h2.ts'], 'main'],
      ['b-src-main-index', ['src/main/index.ts'], 'main']
    ])
  })

  it('takes process from the seed folder, not the merged district', () => {
    const s = snap({
      'src/main/index.ts': [],
      'src/main/m.ts': [],
      'src/renderer/r.ts': [],
      'src/zz/q.ts': []
    })
    const g = groupProject(s, [], { maxDistricts: 1 })
    checkInvariants(g, s.files)
    expect(g.districts.map((d) => d.id)).toEqual(['d-src-zz'])
    expect(home(g, 'src/main/index.ts').process).toBe('main')
    expect(home(g, 'src/main/m.ts').process).toBe('main')
    expect(home(g, 'src/renderer/r.ts').process).toBe('renderer')
    expect(home(g, 'src/zz/q.ts').process).toBe('')
  })

  it('monorepo: seeds districts from the packages folder children', () => {
    const s = snap({
      'packages/api/src/a.ts': ['./b'],
      'packages/api/src/b.ts': [],
      'packages/web/src/c.ts': ['../../shared/d'],
      'packages/shared/d.ts': [],
      'packages/x.ts': []
    })
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    expect(g.districts.map((d) => [d.id, d.name])).toEqual([
      ['d-packages', 'packages'],
      ['d-packages-api', 'api'],
      ['d-packages-shared', 'shared'],
      ['d-packages-web', 'web']
    ])
    const three = snap({
      'packages/api/src/a.ts': [],
      'packages/web/src/c.ts': [],
      'packages/shared/d.ts': []
    })
    expect(groupProject(three, []).districts.map((d) => [d.id, d.name])).toEqual([
      ['d-packages-api', 'api'],
      ['d-packages-shared', 'shared'],
      ['d-packages-web', 'web']
    ])
  })

  it('monorepo seeding needs a majority folder with two or more children', () => {
    const ids = (fi: Record<string, string[]>): string[] => groupProject(snap(fi), []).districts.map((d) => d.id)
    // One child only: plain root folders.
    expect(ids({ 'packages/api/a.ts': [], 'packages/api/b.ts': [], 'tools/t.ts': [] })).toEqual(['d-packages', 'd-tools'])
    // No majority: plain root folders.
    expect(ids({ 'apps/a/x.ts': [], 'apps/b/y.ts': [], 'lib/p.ts': [], 'lib/q.ts': [], 'z.ts': [] })).toEqual(['d-apps', 'd-lib', 'd-root'])
    // Majority with files outside it: those keep their root folders.
    expect(ids({ 'apps/a/x.ts': [], 'apps/b/y.ts': [], 'lib/p.ts': [] })).toEqual(['d-apps-a', 'd-apps-b', 'd-lib'])
  })

  it('names a multi-file building at the repository root "root"', () => {
    const s = snap({ 'a.ts': ['./b'], 'b.ts': ['./a'], '_.ts': [] })
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    // '_' slugs to nothing, so it falls back to 'root' too; with no tag it keeps the bare base.
    expect(home(g, '_.ts')).toMatchObject({ id: 'b-root', name: '_' })
    expect(home(g, 'a.ts')).toMatchObject({ id: 'b-root--a', name: 'root', districtId: 'd-root' })
  })

  it('ipc provide/consume pairs become edges with via=[ipc boundary]', () => {
    const s = snap({ 'src/renderer/src/api.ts': [], 'src/main/ipc.ts': [], 'src/main/other.ts': [] })
    const consume = B('ipc', 'memory:search', 'consume', 'src/renderer/src/api.ts', 4)
    const provide = B('ipc', 'memory:search', 'provide', 'src/main/ipc.ts', 7)
    const provide2 = B('ipc', 'memory:search', 'provide', 'src/main/ipc.ts', 9)
    const provideOther = B('ipc', 'memory:search', 'provide', 'src/main/other.ts', 2)
    const lonely = B('ipc', 'nope', 'consume', 'src/renderer/src/api.ts', 5)
    // A pair inside one building is not an edge.
    const envUse = B('env', 'X', 'consume', 'src/main/ipc.ts', 1)
    const envSet = B('env', 'X', 'provide', 'src/main/ipc.ts', 2)
    const g = groupProject(s, [lonely, provideOther, provide2, consume, envSet, provide, envUse])
    checkInvariants(g, s.files)
    expect(g.edges).toEqual([
      { from: 'b-src-renderer-src-api', to: 'b-src-main-ipc', via: [provide, provide2, consume] },
      { from: 'b-src-renderer-src-api', to: 'b-src-main-other', via: [provideOther, consume] }
    ])
    expect(home(g, 'src/main/ipc.ts').boundaries).toEqual([envUse, envSet, provide, provide2])
  })

  it('sorts boundaries by file, line, kind, key and side', () => {
    const f = 'src/x/a.ts'
    const s = snap({ [f]: [], 'src/x/b.ts': [] })
    const list = [
      B('ipc', 'b', 'consume', f, 1),
      B('ipc', 'a', 'provide', f, 1),
      B('env', 'z', 'consume', f, 1),
      B('ipc', 'a', 'consume', f, 1),
      B('ipc', 'a', 'consume', f, 2),
      B('ipc', 'a', 'consume', 'src/x/b.ts', 1),
      B('ipc', 'a', 'consume', f, 1),
      B('ipc', 'a', 'consume', 'src/nowhere.ts', 1)
    ]
    const g = groupProject(s, list)
    expect(home(g, f).boundaries).toEqual([
      B('env', 'z', 'consume', f, 1),
      B('ipc', 'a', 'consume', f, 1),
      B('ipc', 'a', 'consume', f, 1),
      B('ipc', 'a', 'provide', f, 1),
      B('ipc', 'b', 'consume', f, 1),
      B('ipc', 'a', 'consume', f, 2)
    ])
    expect(home(g, 'src/x/b.ts').boundaries).toEqual([B('ipc', 'a', 'consume', 'src/x/b.ts', 1)])
  })

  it('caps: 5000 synthetic files produce <= 12 districts and <= 60 buildings', () => {
    const pad = (k: number): string => String(k).padStart(2, '0')
    const path = (i: number): string => `src/d${pad(i % 30)}/s${Math.floor(i / 30) % 10}/f${i}.ts`
    const imports: Record<string, string[]> = {}
    for (let i = 0; i < 5000; i++) {
      const own: string[] = ['react']
      if (i >= 300) own.push(`./f${i - 300}`)
      if (i % 7 === 0 && i + 1 < 5000) own.push(`../../${path(i + 1).slice(4)}`.replace(/\.ts$/, ''))
      if (i % 11 === 0 && i >= 600) own.push(`./f${i - 600}.js`)
      imports[path(i)] = own
    }
    const s = snap(imports)
    expect(s.files).toHaveLength(5000)
    const bounds = [B('fork', 'f42', 'consume', path(7)), B('ipc', 'k', 'provide', path(1)), B('ipc', 'k', 'consume', path(2))]
    const t0 = performance.now()
    const g = groupProject(s, bounds)
    const ms = performance.now() - t0
    console.log(`[worldGroup] 5000 files grouped in ${ms.toFixed(0)} ms: ${g.districts.length} districts, ${g.buildings.length} buildings, ${g.edges.length} edges`)
    expect(ms).toBeLessThan(2000)
    expect(g.districts.length).toBeLessThanOrEqual(12)
    expect(g.buildings.length).toBeLessThanOrEqual(60)
    checkInvariants(g, s.files)
    expect(home(g, path(42)).process).toBe('f42')
  })

  it('honours custom caps, never letting districts outnumber buildings', () => {
    const s = snap({ 'src/a/1.ts': [], 'src/b/1.ts': [], 'src/c/1.ts': [] })
    const g = groupProject(s, [], { maxBuildings: 2 })
    checkInvariants(g, s.files)
    expect(g.districts).toHaveLength(2)
    expect(g.buildings).toHaveLength(2)
    const one = groupProject(s, [], { maxBuildings: 0, maxDistricts: 0 })
    checkInvariants(one, s.files)
    expect(one.buildings).toHaveLength(1)
  })

  it('merges the smallest district into its most-connected one, ties in path order', () => {
    const s = snap({
      'src/a/1.ts': ['../c/1', '../b/1', '../d/1'],
      'src/b/1.ts': [],
      'src/b/2.ts': [],
      'src/c/1.ts': [],
      'src/c/2.ts': [],
      'src/c/3.ts': [],
      'src/d/1.ts': [],
      'src/d/2.ts': [],
      'src/d/3.ts': [],
      'src/d/4.ts': []
    })
    const g3 = groupProject(s, [], { maxDistricts: 3 })
    checkInvariants(g3, s.files)
    expect(g3.districts.map((d) => d.id)).toEqual(['d-src-b', 'd-src-c', 'd-src-d'])
    expect(home(g3, 'src/a/1.ts').districtId).toBe('d-src-b')
    // Next round: b (3 files) ties c on size and goes first in path order; its links to c and d tie too.
    const g2 = groupProject(s, [], { maxDistricts: 2 })
    checkInvariants(g2, s.files)
    expect(g2.districts.map((d) => d.id)).toEqual(['d-src-c', 'd-src-d'])
    expect(home(g2, 'src/a/1.ts').districtId).toBe('d-src-c')
    expect(home(g2, 'src/b/1.ts').districtId).toBe('d-src-c')
  })

  it('merges an unconnected district into the next smallest', () => {
    const s = snap({ 'src/a/1.ts': [], 'src/b/1.ts': [], 'src/b/2.ts': [], 'src/c/1.ts': [], 'src/c/2.ts': [], 'src/c/3.ts': [] })
    const g2 = groupProject(s, [], { maxDistricts: 2 })
    expect(g2.districts.map((d) => d.id)).toEqual(['d-src-b', 'd-src-c'])
    expect(home(g2, 'src/a/1.ts').districtId).toBe('d-src-b')
    const g1 = groupProject(s, [], { maxDistricts: 1 })
    checkInvariants(g1, s.files)
    expect(g1.districts).toEqual([{ id: 'd-src-c', name: 'c', members: g1.buildings.map((b) => b.id) }])
  })

  describe('building cap', () => {
    const s = snap({
      'src/m/a1.ts': [],
      'src/m/a2.ts': [],
      'src/m/b.ts': ['./c1', './d1'],
      'src/m/c0.ts': [],
      'src/m/c1.ts': ['./c2'],
      'src/m/c2.ts': ['./c1'],
      'src/m/d0.ts': [],
      'src/m/d1.ts': ['./d2'],
      'src/m/d2.ts': ['./d1'],
      'src/m/pa.ts': [],
      'src/m/pb.ts': [],
      'src/m/zz/q.ts': [],
      'src/solo/only.ts': ['../m/a1']
    })
    const bounds = [B('worker', 'pa', 'consume', 'src/solo/only.ts', 1), B('worker', 'pb', 'consume', 'src/solo/only.ts', 2)]
    const together = (g: Grouping, a: string, b: string): boolean => home(g, a).id === home(g, b).id

    it('starts from unmerged clusters', () => {
      const g = groupProject(s, bounds)
      checkInvariants(g, s.files)
      expect(g.buildings).toHaveLength(11)
      expect(together(g, 'src/m/c1.ts', 'src/m/c2.ts')).toBe(true)
      expect(together(g, 'src/m/b.ts', 'src/m/c1.ts')).toBe(false)
    })

    it('merges the smallest building into its most-connected neighbour, else its nearest in path order', () => {
      const g = groupProject(s, bounds, { maxBuildings: 9 })
      checkInvariants(g, s.files)
      expect(g.buildings).toHaveLength(9)
      // a1 has no same-district neighbour: it joins a2, the next building in path order.
      expect(together(g, 'src/m/a1.ts', 'src/m/a2.ts')).toBe(true)
      // b links to the c and d clusters equally: the first in path order wins.
      expect(together(g, 'src/m/b.ts', 'src/m/c1.ts')).toBe(true)
      expect(together(g, 'src/m/b.ts', 'src/m/d1.ts')).toBe(false)
    })

    it('keeps single-building districts and process buildings until last', () => {
      const g = groupProject(s, bounds, { maxBuildings: 4 })
      checkInvariants(g, s.files)
      expect(g.buildings).toHaveLength(4)
      expect(home(g, 'src/solo/only.ts').members).toEqual(['src/solo/only.ts'])
      expect(home(g, 'src/m/pa.ts').process).toBe('pa')
      expect(home(g, 'src/m/pb.ts').process).toBe('pb')
      expect(together(g, 'src/m/pa.ts', 'src/m/pb.ts')).toBe(false)
      const g2 = groupProject(s, bounds, { maxBuildings: 2 })
      checkInvariants(g2, s.files)
      expect(g2.buildings).toHaveLength(2)
      expect(home(g2, 'src/m/a1.ts')).toMatchObject({ process: 'pa', id: 'b-src-m-pa' })
    })
  })

  it('ignores node_modules, dist, out, build, vendor, *.min.js', () => {
    const s = snap({
      'src/main/a.ts': ['../../node_modules/x/index.js', './build/gen', './lib/jq.min.js', './build'],
      'node_modules/x/index.js': [],
      'dist/a.js': [],
      'out/b.js': [],
      'build/c.js': [],
      'vendor/d.js': [],
      'src/main/build/gen.ts': ['../a'],
      'src/main/lib/jq.min.js': [],
      'src/main/build.ts': []
    })
    const g = groupProject(s, [B('ipc', 'k', 'provide', 'dist/a.js'), B('ipc', 'k', 'consume', 'src/main/a.ts')])
    checkInvariants(g, ['src/main/a.ts', 'src/main/build.ts'])
    expect(home(g, 'src/main/a.ts').members).toEqual(['src/main/a.ts', 'src/main/build.ts'])
    expect(home(g, 'src/main/a.ts').boundaries).toEqual([B('ipc', 'k', 'consume', 'src/main/a.ts')])
    expect(g.edges).toEqual([])
  })

  it('tolerates empty input, self-imports and import lists for unknown files', () => {
    expect(groupProject(snap({}), [])).toEqual({ districts: [], buildings: [], edges: [] })
    const s: GraphSnapshot = {
      root: '/repo',
      files: ['src/x/a.ts', 'constructor'],
      symbols: [],
      callEdges: [],
      fileImports: { 'src/x/a.ts': ['./a', './a.ts'], 'src/x/gone.ts': ['./a'] }
    }
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    expect(g.edges).toEqual([])
    expect(g.buildings.map((b) => b.members)).toEqual([['constructor'], ['src/x/a.ts']])
  })

  it('keeps entries that import each other in separate process buildings', () => {
    const s = snap({ 'src/main/index.ts': ['./worker', './shared'], 'src/main/worker.ts': ['./shared'], 'src/main/shared.ts': [] })
    const g = groupProject(s, [B('worker', 'worker', 'consume', 'src/main/index.ts')])
    checkInvariants(g, s.files)
    expect(home(g, 'src/main/index.ts').members).toEqual(['src/main/index.ts'])
    expect(home(g, 'src/main/worker.ts').members).toEqual(['src/main/worker.ts'])
    expect(home(g, 'src/main/shared.ts').members).toEqual(['src/main/shared.ts'])
  })

  it('a process closure stays inside its district', () => {
    const s = snap({ 'src/main/memoryHost.ts': ['../shared/types', './memo'], 'src/main/memo.ts': [], 'src/shared/types.ts': [] })
    const g = groupProject(s, [B('fork', 'memoryHost', 'consume', 'src/main/memoryHost.ts')])
    checkInvariants(g, s.files)
    expect(home(g, 'src/main/memoryHost.ts').members).toEqual(['src/main/memo.ts', 'src/main/memoryHost.ts'])
    expect(home(g, 'src/shared/types.ts').members).toEqual(['src/shared/types.ts'])
  })

  it('deterministic: same input gives deep-equal output', () => {
    const imports: Record<string, string[]> = {
      'src/main/index.ts': ['./a', './b', './c'],
      'src/main/a.ts': ['./b'],
      'src/main/b.ts': ['./a', './c'],
      'src/main/c.ts': ['./a'],
      'src/main/memoryHost.ts': ['./mem/x'],
      'src/main/mem/x.ts': [],
      'src/renderer/src/main.tsx': ['./api'],
      'src/renderer/src/api.ts': [],
      'src/preload/index.ts': []
    }
    const bounds = [
      B('fork', 'memoryHost', 'consume', 'src/main/index.ts', 3),
      B('ipc', 'q', 'consume', 'src/renderer/src/api.ts', 1),
      B('ipc', 'q', 'provide', 'src/main/a.ts', 9)
    ]
    const first = groupProject(snap(imports), bounds)
    const keys = Object.keys(imports).reverse()
    const shuffled: GraphSnapshot = {
      root: '/repo',
      files: keys,
      symbols: [],
      callEdges: [],
      fileImports: Object.fromEntries(keys.map((k) => [k, [...imports[k]].reverse()]))
    }
    const second = groupProject(shuffled, [...bounds].reverse())
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(groupProject(snap(imports), bounds)).toEqual(first)
  })

  it('ids are stable slugs of member paths', () => {
    const base: Record<string, string[]> = {
      'src/main/index.ts': ['./a', './b'],
      'src/main/a.ts': ['./b'],
      'src/main/b.ts': ['./a'],
      'src/main/zzz.ts': [],
      'src/main/q/one.ts': ['./two'],
      'src/main/q/two.ts': ['./one'],
      'src/shared/types.ts': []
    }
    const before = groupProject(snap(base), [])
    const renamed = { ...base, 'src/main/aaa.ts': [] }
    delete renamed['src/main/zzz.ts']
    const after = groupProject(snap(renamed), [])
    const idsOf = (g: Grouping): Record<string, string> =>
      Object.fromEntries(g.buildings.flatMap((b) => b.members.map((m) => [m, b.id])))
    const a = idsOf(before)
    const b = idsOf(after)
    expect(a['src/main/a.ts']).toBe('b-src-main')
    expect(a['src/main/q/one.ts']).toBe('b-src-main-q')
    expect(a['src/main/zzz.ts']).toBe('b-src-main-zzz')
    expect(b['src/main/aaa.ts']).toBe('b-src-main-aaa')
    for (const f of Object.keys(base).filter((k) => k !== 'src/main/zzz.ts')) expect(b[f]).toBe(a[f])
    expect(after.districts.map((d) => d.id)).toEqual(before.districts.map((d) => d.id))
  })
})
