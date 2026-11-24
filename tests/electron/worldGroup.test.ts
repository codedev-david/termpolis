import { describe, expect, it } from 'vitest'
import type { GraphSnapshot } from '../../src/main/codeGraph'
import type { Boundary } from '../../src/main/world/detectors'
import {
  DEFAULT_MAX_BUILDINGS,
  DEFAULT_MAX_DISTRICTS,
  FAMILY_FOLDER_MAX,
  MERGE_DENSITY,
  groupProject,
  isIgnored,
  nameStem,
  idSlug,
  resolveImport,
  shortHash,
  slug,
  uniqueIds,
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
    expect(FAMILY_FOLDER_MAX).toBe(16)
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

describe('shortHash and idSlug (WP5: G10, G15, F03)', () => {
  it('shortHash is six lowercase hex digits, stable, and differs for different input', () => {
    expect(shortHash('')).toBe('811c9d')
    expect(shortHash('src/a-b')).toMatch(/^[0-9a-f]{6}$/)
    expect(shortHash('src/a-b')).toBe(shortHash('src/a-b'))
    expect(shortHash('src/a-b')).not.toBe(shortHash('src/a_b'))
  })

  it('idSlug keeps a readable slug, and gives a name with none u plus its hash, never root', () => {
    expect(idSlug('src/Main')).toBe('src-main')
    expect(idSlug('')).toBe('')
    expect(idSlug('🚀')).toBe(`u${shortHash('🚀')}`)
    expect(idSlug('文档')).toBe(`u${shortHash('文档')}`)
    expect(idSlug('文档')).not.toBe(idSlug('资料'))
  })
})

describe('uniqueIds (WP5: G14)', () => {
  it('keeps a base no other item shares, tags shared bases, and hashes a tag that still collides', () => {
    const ids = uniqueIds([
      { base: 'b-a', tag: 'x', order: 'a/x.ts' },
      { base: 'b-q', tag: 'x', order: 'q/1/x.ts' },
      { base: 'b-q', tag: 'x', order: 'q/2/x.ts' },
      { base: 'b-q', tag: 'y', order: 'q/y.ts' },
      { base: 'd-r', tag: '', order: 'r' },
      { base: 'd-r', tag: '', order: 'R' }
    ])
    expect(ids).toEqual([
      'b-a',
      `b-q--x--${shortHash('q/1/x.ts')}`,
      `b-q--x--${shortHash('q/2/x.ts')}`,
      'b-q--y',
      `d-r--${shortHash('r')}`,
      `d-r--${shortHash('R')}`
    ])
  })

  it('a colliding item that comes or goes leaves the others ids alone', () => {
    const two = [
      { base: 'b-q', tag: 'x', order: 'q/m/x.ts' },
      { base: 'b-q', tag: 'x', order: 'q/z/x.ts' }
    ]
    const before = uniqueIds(two)
    const after = uniqueIds([{ base: 'b-q', tag: 'x', order: 'q/a/x.ts' }, ...two])
    expect(after.slice(1)).toEqual(before)
  })

  it('two items with the same base and order (a hash that cannot tell them apart) still get distinct ids, in order', () => {
    expect(uniqueIds([
      { base: 'b-q', tag: '', order: 'same' },
      { base: 'b-q', tag: '', order: 'same' }
    ])).toEqual([`b-q--${shortHash('same')}`, `b-q--${shortHash('same')}-2`])
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

  it('ignores virtual environments, Python caches, Rust and Next.js output, coverage, bower and bundled css or js', () => {
    for (const p of ['.venv/lib/site.py', 'venv/lib/x.py', 'app/__pycache__/m.py', 'target/debug/main.rs', '.next/server/page.js', 'coverage/lcov-report/a.js', 'bower_components/jq/jq.js', 'web/site.min.css', 'web/app.bundle.js']) {
      expect(isIgnored(p)).toBe(true)
    }
    for (const p of ['src/target.ts', 'src/venv.py', 'src/coverage.ts', 'web/site.css', 'web/bundle.js', 'web/app.bundle.ts']) {
      expect(isIgnored(p)).toBe(false)
    }
  })
})

describe('nameStem', () => {
  it('takes the leading camelCase, kebab or acronym word, lower-cased', () => {
    expect(nameStem('memoryHost.ts')).toBe('memory')
    expect(nameStem('remote-bridge.ts')).toBe('remote')
    expect(nameStem('AccountChip.tsx')).toBe('account')
    expect(nameStem('MCPServer.ts')).toBe('mcp')
    expect(nameStem('HTTP.ts')).toBe('http')
    expect(nameStem('IPC_bus.ts')).toBe('ipc')
    expect(nameStem('swarm.test.ts')).toBe('swarm')
    expect(nameStem('http2Server.ts')).toBe('http2')
  })
  it('says nothing for short words, entry names and names with no leading letter', () => {
    expect(nameStem('ui.ts')).toBe('')
    expect(nameStem('index.ts')).toBe('')
    expect(nameStem('main.tsx')).toBe('')
    expect(nameStem('_private.ts')).toBe('')
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
    // The main entry is a process building too, on its own: everything in its folder is reachable
    // from it, so a closure would swallow the folder.
    const main = home(g, 'src/main/index.ts')
    expect(main).toMatchObject({ id: 'b-src-main-index', name: 'main', process: 'main', members: ['src/main/index.ts'] })
    expect(main.boundaries).toEqual([fork])
    expect(home(g, 'src/main/util.ts')).toMatchObject({ id: 'b-src-main-util', name: 'util', process: 'main', boundaries: [ghost] })
    // A non-process building in the main district runs in the main process.
    expect(home(g, 'src/main/store.ts')).toMatchObject({ id: 'b-src-main-store', name: 'store', process: 'main', boundaries: [worker] })
    // The shortest path wins the target match; the longer one stays an ordinary building.
    expect(home(g, 'src/main/legacy/memoryHost.ts')).toMatchObject({ id: 'b-src-main-legacy-memoryhost', process: 'main' })

    expect(g.edges).toEqual([
      { from: 'b-src-main-index', to: 'b-src-main-memoryhost', via: [fork] },
      { from: 'b-src-main-index', to: 'b-src-main-store', via: [] },
      { from: 'b-src-main-index', to: 'b-src-main-util', via: [] },
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

  it('a fork key naming a folder targets the root file of that folder', () => {
    const s = snap({
      'src/main/index.ts': [],
      'src/main/other.ts': ['./util'],
      'src/main/proxy/aaaa.ts': ['./util'],
      'src/main/proxy/b.ts': [],
      'src/main/proxy/go.ts': ['./util'],
      'src/main/proxy/go.test.ts': ['./go'],
      'src/main/proxy/run.ts': ['./util'],
      'src/main/proxy/util.ts': []
    })
    const f1 = B('fork', 'proxy', 'consume', 'src/main/index.ts', 3)
    const f2 = B('fork', 'proxy', 'consume', 'src/main/index.ts', 9)
    const g = groupProject(s, [f2, f1])
    checkInvariants(g, s.files)
    // Not imported (a test does not count), imports the most, then the shortest path.
    const proxy = home(g, 'src/main/proxy/go.ts')
    expect(proxy).toMatchObject({ name: 'proxy', process: 'proxy' })
    // The process is built from the folder, so the rest of the folder is part of it.
    expect(proxy.members).toEqual(['aaaa.ts', 'b.ts', 'go.test.ts', 'go.ts', 'run.ts', 'util.ts'].map((f) => `src/main/proxy/${f}`))
    expect(home(g, 'src/main/other.ts').process).toBe('main')
    expect(g.edges).toContainEqual({ from: 'b-src-main-index', to: home(g, 'src/main/proxy/go.ts').id, via: [f1, f2] })
  })

  it('keeps preload bridge reads only for names something exposes', () => {
    const s = snap({ 'src/preload/index.ts': [], 'src/renderer/src/app.ts': [], 'src/renderer/src/main.tsx': [] })
    const expose = B('ipc', 'window.api', 'provide', 'src/preload/index.ts', 2)
    const read = B('ipc', 'window.api', 'consume', 'src/renderer/src/app.ts', 4)
    const page = B('ipc', 'window.location', 'consume', 'src/renderer/src/app.ts', 5)
    const plain = B('ipc', 'nope', 'consume', 'src/renderer/src/app.ts', 6)
    const g = groupProject(s, [page, read, expose, plain])
    checkInvariants(g, s.files)
    expect(home(g, 'src/renderer/src/app.ts').boundaries).toEqual([read, plain])
    expect(g.edges).toEqual([{ from: home(g, 'src/renderer/src/app.ts').id, to: 'b-src-preload-index', via: [expose, read] }])
    // The preload runs in the renderer process.
    expect(home(g, 'src/preload/index.ts')).toMatchObject({ name: 'preload', process: 'renderer' })
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
    // Named after its front door: a, b and c reach each other, and only a is imported from outside.
    expect(home(g, 'src/lib/a.ts')).toMatchObject({ id: 'b-src-lib--a', name: 'a', process: '' })
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
    // Equally short entry candidates: path order picks index over main. A preload script runs in
    // the renderer process, so its buildings keep the name but run in 'renderer'.
    expect(home(g, 'src/preload/index.ts')).toMatchObject({ name: 'preload', process: 'renderer' })
    expect(home(g, 'src/preload/main.tsx')).toMatchObject({ name: 'main', process: 'renderer' })
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

  it('collisions: natural ids first, then --basename, then -- a short hash of the first path', () => {
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
    // Districts carry no tag: the natural d-src-a-b-2 keeps its id, and a-b and a_b each take a hash of their folder.
    expect(home(g, 'src/a-b/y.ts').districtId).toBe(`d-src-a-b--${shortHash('src/a-b')}`)
    expect(home(g, 'src/a-b-2/z.ts').districtId).toBe('d-src-a-b-2')
    expect(home(g, 'src/a_b/x.ts').districtId).toBe(`d-src-a-b--${shortHash('src/a_b')}`)
    // src/main.ts and the src/main/{x,y} building share b-src-main, so both are tagged.
    expect(home(g, 'src/main.ts').id).toBe('b-src-main--main')
    expect(home(g, 'src/main/x/a.ts')).toMatchObject({ id: 'b-src-main--a', name: 'a', members: ['src/main/x/a.ts', 'src/main/y/b.ts'] })
    // A natural id is never suffixed.
    expect(home(g, 'src/main-2.ts').id).toBe('b-src-main-2')
    // Same base and same first basename: a hash of each first member's path, so neither depends on the other.
    expect(home(g, 'src/q/a/x.ts').id).toBe(`b-src-q--x--${shortHash('src/q/a/x.ts')}`)
    expect(home(g, 'src/q/b/x.ts').id).toBe(`b-src-q--x--${shortHash('src/q/b/x.ts')}`)
  })

  it('G14: a new earlier path with the same base and basename leaves its siblings ids and their notes alone', () => {
    const base: Record<string, string[]> = {
      'src/q/b/x.ts': ['../d/k'],
      'src/q/d/k.ts': ['../b/x'],
      'src/q/e/x.ts': ['../f/k'],
      'src/q/f/k.ts': ['../e/x']
    }
    const idOf = (g: Grouping): Record<string, string> => Object.fromEntries(g.buildings.flatMap((b) => b.members.map((m) => [m, b.id])))
    const before = idOf(groupProject(snap(base), []))
    const after = idOf(groupProject(snap({ ...base, 'src/q/a/x.ts': ['../c/k'], 'src/q/c/k.ts': ['../a/x'] }), []))
    expect(after['src/q/a/x.ts']).toBe(`b-src-q--x--${shortHash('src/q/a/x.ts')}`)
    for (const [f, id] of Object.entries(before)) expect(after[f]).toBe(id)
  })

  // Review K5: a file renamed in a slug-collision group must not hand its siblings' ids (and their notes) to another file.
  it('K5: renaming one file of a slug-collision group leaves the other files their ids', () => {
    const idOf = (g: Grouping): Record<string, string> => Object.fromEntries(g.buildings.flatMap((b) => b.members.map((m) => [m, b.id])))
    const before = idOf(groupProject(snap({ 'src/a!.ts': [], 'src/a$.ts': [], 'src/a%.ts': [] }), []))
    const after = idOf(groupProject(snap({ 'src/b!.ts': [], 'src/a$.ts': [], 'src/a%.ts': [] }), []))
    expect(new Set(Object.values(before)).size).toBe(3)
    expect(after['src/a$.ts']).toBe(before['src/a$.ts'])
    expect(after['src/a%.ts']).toBe(before['src/a%.ts'])
  })

  it('K5: a colliding building takes its tag and suffix from its own front door, not from whichever file sorts first', () => {
    // Two buildings in src/q whose folders slug alike (q-x, q_x): each is named after the file the rest of it imports from.
    const base: Record<string, string[]> = {
      'src/q-x/api.ts': ['./util', './more'],
      'src/q-x/util.ts': [],
      'src/q-x/more.ts': [],
      'src/q_x/api.ts': ['./util', './more'],
      'src/q_x/util.ts': [],
      'src/q_x/more.ts': []
    }
    const g = groupProject(snap(base), [])
    const door = (gr: Grouping, f: string): string => home(gr, f).id
    expect(door(g, 'src/q-x/api.ts')).toBe(`b-src-q-x--api--${shortHash('src/q-x/api.ts')}`)
    expect(door(g, 'src/q_x/api.ts')).toBe(`b-src-q-x--api--${shortHash('src/q_x/api.ts')}`)
    // A file that sorts before the others joins one building: neither building's id moves.
    const grown = groupProject(snap({ ...base, 'src/q-x/aaa.ts': [], 'src/q-x/api.ts': ['./util', './more', './aaa'] }), [])
    expect(home(grown, 'src/q-x/aaa.ts').id).toBe(door(g, 'src/q-x/api.ts'))
    expect(door(grown, 'src/q-x/api.ts')).toBe(door(g, 'src/q-x/api.ts'))
    expect(door(grown, 'src/q_x/api.ts')).toBe(door(g, 'src/q_x/api.ts'))
  })

  // Review K6: naming a building's front door searched its imports from every member, so a 20k-file chain was quadratic.
  it('K6: a 20k-file import chain in one building is named in bounded work, after the file that reaches the rest', () => {
    const N = 20000
    const name = (i: number): string => `src/chain/item${String(i).padStart(5, '0')}.ts`
    const m: Record<string, string[]> = {}
    for (let i = 0; i < N; i++) m[name(i)] = i + 1 < N ? [`./item${String(i + 1).padStart(5, '0')}`] : []
    const t0 = Date.now()
    const g = groupProject(snap(m), [], { maxBuildings: 1 })
    const ms = Date.now() - t0
    const b = home(g, name(0))
    expect(b.members.length).toBe(N)
    expect(b.name).toBe('item00000')
    expect(ms).toBeLessThan(10000) // 31 s before the budget on a laptop; about 1 s with it
    // The same input names the same building, however far the search got.
    expect(home(groupProject(snap(m), [], { maxBuildings: 1 }), name(N - 1)).name).toBe('item00000')
  }, 60000)

  it('G15 and F03: folders and files named only in a non-Latin script or emoji get readable distinct ids, not root', () => {
    const s = snap({ '文档/a.ts': [], '资料/b.ts': [], '🚀.ts': [], 'z.ts': [] })
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    expect(home(g, '文档/a.ts').districtId).toBe(`d-u${shortHash('文档')}`)
    expect(home(g, '资料/b.ts').districtId).toBe(`d-u${shortHash('资料')}`)
    expect(home(g, '🚀.ts')).toMatchObject({ id: `b-u${shortHash('🚀')}`, name: '🚀', districtId: 'd-root' })
    expect(g.districts.find((d) => d.id === `d-u${shortHash('文档')}`)?.name).toBe('文档')
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

  it('names a building after its folder, else "root", when every member name is taken', () => {
    const s = snap({ 'a.ts': ['./b'], 'b.ts': ['./a'], '_.ts': [], 'main.ts': ['./renderer'], 'renderer.ts': ['./main'] })
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    // '_' slugs to nothing, so its id is u plus a hash of the name, never the root folder's 'root'.
    expect(home(g, '_.ts')).toMatchObject({ id: `b-u${shortHash('_')}`, name: '_' })
    expect(home(g, 'a.ts')).toMatchObject({ id: 'b-root--a', name: 'a', districtId: 'd-root' })
    // 'main' and 'renderer' would pass for process entries, and the root folder has no name.
    expect(home(g, 'main.ts')).toMatchObject({ name: 'root', members: ['main.ts', 'renderer.ts'] })
    // In a named folder whose files are all called after it, the folder name is all that is left.
    const t = snap({ 'src/tools/index.ts': ['./main'], 'src/tools/main.ts': ['./index'] })
    expect(home(groupProject(t, []), 'src/tools/main.ts')).toMatchObject({ name: 'tools', members: ['src/tools/index.ts', 'src/tools/main.ts'] })
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

  it('an index file something other than a test imports is no process entry', () => {
    const s = snap({ 'src/main/index.ts': [], 'src/main/app.ts': ['./index'], 'src/main/index.test.ts': ['./index'] })
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    expect(home(g, 'src/main/index.ts')).toMatchObject({ process: 'main', members: ['src/main/app.ts', 'src/main/index.ts'] })
    expect(home(g, 'src/main/index.ts').name).toBe('app')
    // Imported by its test only, it is still the entry.
    const t = snap({ 'src/main/index.ts': [], 'src/main/index.test.ts': ['./index'] })
    expect(home(groupProject(t, []), 'src/main/index.ts')).toMatchObject({ name: 'main', members: ['src/main/index.ts'] })
  })

  it('groups free files by name family: a small sub-folder as one, a big folder by leading word', () => {
    const fi: Record<string, string[]> = {
      'src/app/memoryClient.ts': [],
      'src/app/memoryGraph.ts': [],
      'src/app/memoryStore.ts': ['./memoryGraph'],
      'src/app/remoteHost.ts': [],
      'src/app/remotePump.ts': [],
      'src/app/ui.ts': [],
      'src/app/xy.ts': [],
      'src/app/widgets/a.ts': [],
      'src/app/widgets/b.ts': [],
      'src/app/widgets/c.ts': []
    }
    // Pad the folder past FAMILY_FOLDER_MAX with unrelated, uniquely named files.
    const pad = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']
    for (const w of pad) fi[`src/app/${w}.ts`] = []
    const s = snap(fi)
    expect(s.files.filter((f) => /^src\/app\/[^/]+$/.test(f)).length).toBeGreaterThan(FAMILY_FOLDER_MAX)
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    expect(home(g, 'src/app/memoryClient.ts').members).toEqual(['src/app/memoryClient.ts', 'src/app/memoryGraph.ts', 'src/app/memoryStore.ts'])
    // The front door reaches most of the family.
    expect(home(g, 'src/app/memoryClient.ts').name).toBe('memoryStore')
    expect(home(g, 'src/app/remoteHost.ts').members).toEqual(['src/app/remoteHost.ts', 'src/app/remotePump.ts'])
    expect(home(g, 'src/app/widgets/a.ts').members).toEqual(['src/app/widgets/a.ts', 'src/app/widgets/b.ts', 'src/app/widgets/c.ts'])
    // Names with no leading word of three letters stand alone.
    expect(home(g, 'src/app/ui.ts').members).toEqual(['src/app/ui.ts'])
    expect(home(g, 'src/app/xy.ts').members).toEqual(['src/app/xy.ts'])
  })

  it('a big sub-folder groups by leading word too, and a small seed folder is not one family', () => {
    const fi: Record<string, string[]> = { 'src/s/aaa1.ts': [], 'src/s/bbb.ts': [] }
    for (let i = 0; i <= FAMILY_FOLDER_MAX; i++) fi[`src/s/big/w${String(i).padStart(2, '0')}.ts`] = []
    fi['src/s/big/zetaOne.ts'] = []
    fi['src/s/big/zetaTwo.ts'] = []
    const g = groupProject(snap(fi), [])
    checkInvariants(g, Object.keys(fi))
    expect(home(g, 'src/s/big/zetaOne.ts').members).toEqual(['src/s/big/zetaOne.ts', 'src/s/big/zetaTwo.ts'])
    expect(home(g, 'src/s/big/w00.ts').members).toEqual(['src/s/big/w00.ts'])
    expect(home(g, 'src/s/aaa1.ts').members).toEqual(['src/s/aaa1.ts'])
  })

  it('names a building after a non-test member before any test', () => {
    const s = snap({
      'src/k/zed.test.ts': ['./zed', './yak'],
      'src/k/zed.ts': ['./yak'],
      'src/k/yak.ts': ['./zed']
    })
    const g = groupProject(s, [])
    checkInvariants(g, s.files)
    expect(g.buildings).toHaveLength(1)
    // The test reaches the most, but a test is never the front door.
    expect(g.buildings[0].name).toBe('yak')
  })

  describe('channel services', () => {
    // index.ts serves channel families and imports one module named for each. Only a module that
    // only entries import and that imports nothing else of its district counts, and only when it
    // is the one module named for the family.
    const fi: Record<string, string[]> = {
      'src/main/index.ts': [
        './swarmManager', './swarmMemory', './gitChanges', './gitHooks', './windowsRepair', './memoryStore',
        './routeTable', './configFile', './appMenu', './ptyHost', '../lib/util', './tasks.test'
      ],
      'src/main/appMenu.ts': ['./worker'],
      'src/main/configFile.ts': ['../shared/paths'],
      'src/main/gitChanges.ts': [],
      'src/main/gitHooks.ts': [],
      'src/main/memoryStore.ts': [],
      'src/main/other.ts': ['./memoryStore'],
      'src/main/ptyHost.ts': [],
      'src/main/routeTable.ts': ['./zebra'],
      'src/main/swarmManager.test.ts': ['./swarmManager'],
      'src/main/swarmManager.ts': [],
      'src/main/swarmMemory.ts': ['./vectorStore'],
      'src/main/tasks.test.ts': [],
      'src/main/vectorStore.ts': [],
      'src/main/windowsRepair.ts': [],
      'src/main/worker.ts': [],
      'src/main/zebra.ts': [],
      'src/lib/util.ts': [],
      'src/shared/paths.ts': []
    }
    const s = snap(fi)
    const at = 'src/main/index.ts'
    const bounds = [
      B('fork', 'ptyHost', 'consume', at, 1),
      B('worker', 'worker', 'consume', at, 2),
      B('ipc', 'swarm:tasks', 'provide', at, 3),
      B('ipc', 'swarm:clear', 'provide', at, 4),
      B('ipc', 'git:status', 'provide', at, 5),
      B('ipc', 'gitHooks:list', 'provide', at, 6),
      B('ipc', 'window:close', 'provide', at, 7),
      B('ipc', 'memory:search', 'provide', at, 8),
      B('ipc', 'route:list', 'provide', at, 9),
      B('ipc', 'config-file:get', 'provide', at, 10),
      B('ipc', 'app:quit', 'provide', at, 11),
      B('ipc', 'pty:spawn', 'provide', at, 12),
      B('ipc', 'util:run', 'provide', at, 13),
      B('ipc', 'tasks:list', 'provide', at, 14),
      B('ipc', 'ab:x', 'provide', at, 15),
      B('ipc', 'zebra', 'provide', at, 16),
      B('ipc', 'zebra:x', 'consume', at, 17),
      B('ipc', 'other:x', 'provide', 'src/main/other.ts', 1)
    ]
    const alone = (g: Grouping, f: string): boolean => home(g, f).members.length === 1
    const SERVICES = ['src/main/appMenu.ts', 'src/main/configFile.ts', 'src/main/gitHooks.ts', 'src/main/swarmManager.ts']

    it('stands each one on its own, named after it, outside its name family', () => {
      const g = groupProject(s, bounds)
      checkInvariants(g, s.files)
      for (const f of SERVICES) expect(home(g, f)).toMatchObject({ members: [f], process: 'main' })
      expect(home(g, 'src/main/swarmManager.ts')).toMatchObject({ id: 'b-src-main-swarmmanager', name: 'swarmManager' })
      // Without the rule the swarm family would hold swarmManager.ts.
      expect(home(g, 'src/main/swarmMemory.ts').members).not.toContain('src/main/swarmManager.ts')
      expect(home(groupProject(s, bounds.slice(0, 2)), 'src/main/swarmMemory.ts').members).toContain('src/main/swarmManager.ts')
    })

    it('stays merged-last like a process while plain buildings without a link walk past it', () => {
      const free = groupProject(s, bounds)
      const fixedCount = SERVICES.length + 3 // plus the main, pty and worker processes
      const g = groupProject(s, bounds, { maxBuildings: fixedCount + 3 })
      checkInvariants(g, s.files)
      expect(free.buildings.length).toBeGreaterThan(g.buildings.length)
      for (const f of SERVICES) expect(alone(g, f), f).toBe(true)
      // No module stands alone for git: two are named for it (and gitHooks.ts answers gitHooks:).
      // memoryStore.ts has a plain importer, routeTable.ts a plain import, windowsRepair.ts only a
      // word that starts like window; ptyHost.ts is a process, util.ts lives in another district.
      for (const f of ['src/main/gitChanges.ts', 'src/main/memoryStore.ts', 'src/main/routeTable.ts', 'src/main/windowsRepair.ts']) {
        expect(alone(g, f), f).toBe(false)
      }
      // gitChanges.ts has no link: with services on one side, its nearest plain building lies past them.
      expect(home(g, 'src/main/gitChanges.ts').members.some((m) => SERVICES.includes(m))).toBe(false)
    })

    it('goes last of all when the cap needs it', () => {
      const g = groupProject(s, bounds, { maxBuildings: 3 })
      checkInvariants(g, s.files)
      expect(g.buildings).toHaveLength(3)
    })
  })

  describe('building cap targets', () => {
    it('prefers the densest link over the heaviest one', () => {
      const s = snap({
        'src/m/a.ts': ['./big1', './big2', './small'],
        'src/m/big1.ts': ['./big2', './big3', './big4'],
        'src/m/big2.ts': ['./big1', './big3', './big4'],
        'src/m/big3.ts': ['./big1', './big2', './big4'],
        'src/m/big4.ts': ['./big1', './big2', './big3'],
        'src/m/small.ts': ['./smallb'],
        'src/m/smallb.ts': ['./small']
      })
      const free = groupProject(s, [])
      expect(free.buildings).toHaveLength(3)
      // a links twice to the four-file cluster (2/4) and once to the pair (1/2): a tie on density,
      // broken by path order, so a joins big1's building.
      const g = groupProject(s, [], { maxBuildings: 2 })
      checkInvariants(g, s.files)
      expect(home(g, 'src/m/a.ts').id).toBe(home(g, 'src/m/big1.ts').id)
      const t = snap({ ...s.fileImports, 'src/m/a.ts': ['./big1', './small', './smallb'] })
      const g2 = groupProject(t, [], { maxBuildings: 2 })
      // Now 1/4 against 2/2: the pair is denser although the cluster is bigger.
      expect(home(g2, 'src/m/a.ts').id).toBe(home(g2, 'src/m/small.ts').id)
    })

    it('over the cap, a mixed building gives way before a named module of the same size', () => {
      // Every file imports every other: one cluster per group.
      const clique = (names: string[]): Record<string, string[]> =>
        Object.fromEntries(names.map((n) => [`src/m/${n}.ts`, names.filter((o) => o !== n).map((o) => `./${o}`)]))
      const s = snap({
        // One module by name: four api* files in one folder.
        ...clique(['apiAuth', 'apiCache', 'apiClient', 'apiRoutes']),
        // As tightly knit and as big, but four unrelated names.
        ...clique(['zalpha', 'zbeta', 'zdelta', 'zgamma']),
        ...clique(['zz1', 'zz2', 'zz3', 'zz4', 'zz5'])
      })
      const free = groupProject(s, [])
      expect(free.buildings).toHaveLength(3)
      // The two four-file buildings tie on size, and path order alone would merge api* first.
      const g = groupProject(s, [], { maxBuildings: 2 })
      checkInvariants(g, s.files)
      expect(home(g, 'src/m/apiAuth.ts').members).toEqual(['src/m/apiAuth.ts', 'src/m/apiCache.ts', 'src/m/apiClient.ts', 'src/m/apiRoutes.ts'])
      // It has no links, so it joins its nearest neighbour in path order, the zz files.
      expect(home(g, 'src/m/zbeta.ts').members).toHaveLength(9)
      // Past the mixed building, the named module still merges when the cap demands it.
      const one = groupProject(s, [], { maxBuildings: 1 })
      expect(one.buildings).toHaveLength(1)
    })

    it('never merges a plain building into a process building by link, but walks past it in path order', () => {
      const s = snap({
        'src/m/aa.ts': ['./bb'],
        'src/m/bb.ts': [],
        'src/m/cc.ts': [],
        'src/solo/x.ts': []
      })
      const bounds = [B('worker', 'bb', 'consume', 'src/solo/x.ts')]
      const g = groupProject(s, bounds, { maxBuildings: 3 })
      checkInvariants(g, s.files)
      // aa's only link is the bb worker; its path neighbour bb is a process too, so it skips to cc.
      expect(home(g, 'src/m/bb.ts').members).toEqual(['src/m/bb.ts'])
      expect(home(g, 'src/m/aa.ts').members).toEqual(['src/m/aa.ts', 'src/m/cc.ts'])
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

describe('how a building grew', () => {
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
    'src/m/zz/r.ts': [],
    'src/solo/only.ts': ['../m/a1']
  })
  const bounds = [B('worker', 'pa', 'consume', 'src/solo/only.ts', 1), B('worker', 'pb', 'consume', 'src/solo/only.ts', 2)]

  it('a plain building records what it started as, and that nothing joined it', () => {
    const g = groupProject(s, bounds)
    const none = { merged: 0, mergedFiles: 0, folded: 0, cap: DEFAULT_MAX_BUILDINGS }
    // A name family of one file is that file, not a family.
    expect(home(g, 'src/solo/only.ts').growth).toEqual({ start: 'file', seed: 'src/solo/only.ts', ...none })
    expect(home(g, 'src/m/zz/q.ts').growth).toEqual({ start: 'folder', seed: 'src/m/zz', ...none })
    expect(home(g, 'src/m/pa.ts').growth).toEqual({ start: 'process', seed: 'pa', reached: 0, inFolder: 0, ...none })
    expect(home(g, 'src/m/a1.ts').growth).toEqual({ start: 'file', seed: 'src/m/a1.ts', ...none })
  })

  it('a small folder of one file is that file, not a folder', () => {
    const g = groupProject(snap({ 'src/m/one/only.ts': [], 'src/m/x.ts': [], 'src/m/y.ts': [] }), [])
    expect(home(g, 'src/m/one/only.ts').growth).toMatchObject({ start: 'file', seed: 'src/m/one/only.ts' })
  })

  it('a density-merged building counts the name families and the single files that joined it', () => {
    const d = snap({
      'src/core/terminalHost.ts': ['./terminalView', './ptyBridge', './shellRunner'],
      'src/core/terminalView.ts': ['./terminalHost', './ptyQueue'],
      'src/core/ptyBridge.ts': ['./terminalHost', './ptyQueue'],
      'src/core/ptyQueue.ts': ['./ptyBridge', './terminalView'],
      'src/core/shellRunner.ts': ['./terminalHost', './terminalView', './ptyBridge', './ptyQueue'],
      'src/core/loneHelper.ts': []
    })
    const g = groupProject(d, [])
    checkInvariants(g, d.files)
    const big = home(g, 'src/core/terminalHost.ts')
    expect(big.members).toEqual(['src/core/ptyBridge.ts', 'src/core/ptyQueue.ts', 'src/core/shellRunner.ts', 'src/core/terminalHost.ts', 'src/core/terminalView.ts'])
    // shellRunner joins the terminal family first (the densest pair), then the pty family joins the larger side.
    // The pty family is two files; shellRunner is a file of its own.
    expect(big.growth).toEqual({ start: 'family', seed: 'terminal', folder: 'src/core', merged: 1, mergedFiles: 1, folded: 0, cap: DEFAULT_MAX_BUILDINGS })
    expect(home(g, 'src/core/loneHelper.ts').growth).toMatchObject({ merged: 0, mergedFiles: 0, folded: 0 })
  })

  it('a cap-folded building counts the buildings folded into it, and the cap', () => {
    const g = groupProject(s, bounds, { maxBuildings: 9 })
    // a1 has no same-district neighbour and joins a2, the next building in path order.
    expect(home(g, 'src/m/a2.ts').growth).toEqual({ start: 'file', seed: 'src/m/a2.ts', merged: 0, mergedFiles: 0, folded: 1, cap: 9 })
    const g2 = groupProject(s, bounds, { maxBuildings: 2 })
    // Everything in src/m ends in pa's building at the last.
    expect(home(g2, 'src/m/a1.ts').growth).toEqual({ start: 'process', seed: 'pa', merged: 0, mergedFiles: 0, reached: 0, inFolder: 0, folded: 9, cap: 2 })
    // The same project grouped twice records the same facts.
    expect(groupProject(s, bounds, { maxBuildings: 2 })).toEqual(g2)
  })

  it('a channel service records the file it started as', () => {
    const g = groupProject(
      snap({ 'src/main/index.ts': ['./swarmManager'], 'src/main/swarmManager.ts': [], 'src/main/swarmMemory.ts': [] }),
      [B('ipc', 'swarm:tasks', 'provide', 'src/main/index.ts', 1)]
    )
    expect(home(g, 'src/main/swarmManager.ts').growth).toEqual({ start: 'service', seed: 'src/main/swarmManager.ts', merged: 0, mergedFiles: 0, folded: 0, cap: DEFAULT_MAX_BUILDINGS })
  })

  it('a process building records the files reached only from its entry, and the rest of its folder', () => {
    const g = groupProject(
      snap({
        'src/w/job.ts': ['./jobA', './jobB'],
        'src/w/jobA.ts': ['./jobC'],
        'src/w/jobB.ts': [],
        'src/w/jobC.ts': [],
        'src/w/shared.ts': [],
        'src/w/other.ts': ['./shared'],
        'src/tool/main.ts': ['./x'],
        'src/tool/x.ts': [],
        'src/tool/spare.ts': [],
        'src/tool/stray.ts': []
      }),
      [B('worker', 'job', 'consume', 'src/w/other.ts', 1), B('fork', 'tool', 'consume', 'src/w/other.ts', 2)]
    )
    // jobA, jobB and jobC are imported only from inside job's building.
    expect(home(g, 'src/w/job.ts').growth).toEqual({ start: 'process', seed: 'job', merged: 0, mergedFiles: 0, reached: 3, inFolder: 0, folded: 0, cap: DEFAULT_MAX_BUILDINGS })
    // tool names a folder: its root main.ts reaches x, then takes spare and stray, the rest of src/tool.
    const tool = home(g, 'src/tool/main.ts')
    expect(tool.members).toEqual(['src/tool/main.ts', 'src/tool/spare.ts', 'src/tool/stray.ts', 'src/tool/x.ts'])
    expect(tool.growth).toEqual({ start: 'process', seed: 'tool', folder: 'src/tool', merged: 0, mergedFiles: 0, reached: 1, inFolder: 2, folded: 0, cap: DEFAULT_MAX_BUILDINGS })
  })
})
