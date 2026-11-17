import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphSnapshot } from '../../src/main/codeGraph'
import type { WorldDoc } from '../../src/shared/world/types'
import { validateWorld } from '../../src/shared/world/validate'
import { applyDesignPatch, emptyDesignDoc } from '../../src/shared/world/designPatch'
import {
  BUILTIN_GLOSSARY,
  buildTours,
  compileWorld,
  createRecompileScheduler,
  type CompileDeps,
  type CompileStage
} from '../../src/main/world/compile'
import { edgeId, type GroupBuilding, type Grouping } from '../../src/main/world/group'
import { labelWorld, type LabelDeps } from '../../src/main/world/label'
import type { Boundary } from '../../src/main/world/detectors'
import { edgeSummary } from '../../src/shared/world/edgeText'

const ROOT = '/repo'

// A small Electron-shaped repo: main and renderer talk over IPC, main spawns an agent CLI and calls
// a web service, the renderer has a tested view, and telemetry names the OpenTelemetry service.
const FIXTURE: Record<string, string> = {
  'src/main/index.ts': [
    "import { ipcMain } from 'electron'",
    "import { spawn } from 'child_process'",
    "import './ipc'",
    "import './telemetry'",
    "ipcMain.handle('checkout:run', async () => 1)",
    "spawn('claude', ['-p'])",
    "spawn('git', ['status'])",
    "fetch('https://api.example.com/v1/orders')",
    "fetch('http://localhost:3000/health')",
    "const sdk = { serviceName: 'checkout' }"
  ].join('\n'),
  'src/main/ipc.ts': "export const CHANNEL = 'checkout:run'\nspawn('codex', [])\n",
  'src/main/telemetry.ts': "export const otel = { serviceName: 'checkout' }\n",
  'src/renderer/index.ts': "import './view'\nwindow.api = () => ipcRenderer.invoke('checkout:run')\n",
  'src/renderer/view.ts': 'export const view = 1\n',
  'src/renderer/view.test.ts': "import { view } from './view'\n",
  '.env.production': 'OTEL_SERVICE_NAME=checkout-web\n'
}

const IMPORTS: Record<string, string[]> = {
  'src/main/index.ts': ['electron', 'child_process', './ipc', './telemetry'],
  'src/renderer/index.ts': ['./view'],
  'src/renderer/view.test.ts': ['./view']
}

function snapOf(files: Record<string, string>, imports: Record<string, string[]> = IMPORTS, root = ROOT): GraphSnapshot {
  return { root, files: Object.keys(files).sort(), symbols: [], callEdges: [], fileImports: imports }
}

const REPORT = `${ROOT}/vitest-report.json`
const REPORT_TEXT = JSON.stringify({
  startTime: 5,
  testResults: [{ name: `${ROOT}/src/renderer/view.test.ts`, status: 'passed', endTime: 10 }]
})

function labelDeps(over: Partial<LabelDeps> = {}): LabelDeps {
  const store = new Map<string, string>()
  return {
    llm: null,
    cache: { get: async (h) => store.get(h) ?? null, set: async (h, v) => void store.set(h, v) },
    excerpt: async (f) => `code of ${f}`,
    ...over
  }
}

function mkDeps(files: Record<string, string> = FIXTURE, over: Partial<CompileDeps> = {}): CompileDeps & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    readFile: async (p) => {
      reads.push(p)
      if (p === REPORT) return REPORT_TEXT
      const rel = p.slice(ROOT.length + 1)
      return Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null
    },
    glob: async () => [REPORT],
    label: labelDeps(),
    now: () => 1234,
    ...over
  }
}

const HEAD = { head: 'abc123', dirty: false }

async function compileFixture(over: Partial<CompileDeps> = {}, previous: WorldDoc | null = null, changed?: string[]): Promise<WorldDoc> {
  return compileWorld({ snap: snapOf(FIXTURE), projectKey: 'demo', head: HEAD, previous, changed }, mkDeps(FIXTURE, over))
}

function expectValid(doc: WorldDoc): void {
  const r = validateWorld(doc)
  expect(r.ok ? [] : r.errors).toEqual([])
}

const MAIN = 'b-src-main-index'
const RENDERER = 'b-src-renderer-index'
const VIEW = 'b-src-renderer'
const ENV = 'b-env'

describe('compileWorld', () => {
  it('compile on fixture repo produces a doc that passes validateWorld', async () => {
    const deps = mkDeps()
    const doc = await compileWorld({ snap: snapOf(FIXTURE), projectKey: 'demo', head: HEAD, previous: null }, deps)
    expectValid(doc)
    expect(doc.version).toBe(1)
    expect(doc.projectKey).toBe('demo')
    expect(doc.generatedAt).toBe(1234)
    expect(doc.sourceRevision).toEqual(HEAD)
    expect(doc.layers).toEqual({ plan: [] })

    // Districts: sorted by id, golden-angle hues.
    expect(doc.districts.map((d) => d.id)).toEqual(['d-root', 'd-src-main', 'd-src-renderer'])
    expect(doc.districts.map((d) => d.hue)).toEqual([0, 138, 275])
    // The main entry stands alone; its imports are buildings of their own.
    expect(doc.buildings.map((b) => b.id)).toEqual([ENV, MAIN, 'b-src-main-ipc', 'b-src-main-telemetry', VIEW, RENDERER])

    // Status: the view is covered by a passing linked test; main has none.
    const byId = new Map(doc.buildings.map((b) => [b.id, b]))
    expect(byId.get(VIEW)?.status).toBe('verified')
    expect(byId.get(MAIN)?.status).toBe('gap')
    expect(byId.get(MAIN)?.process).toBe('main')
    expect(doc.processes.main).toEqual({ label: 'main', color: expect.stringMatching(/^#[0-9a-f]{6}$/) })
    expect(Object.keys(doc.processes).sort()).toEqual(['main', 'renderer'])

    // IPC edge renderer -> main with its cargo, tech glossed.
    const ipc = doc.edges.find((e) => e.id === edgeId({ from: RENDERER, to: MAIN })) as WorldDoc['edges'][number]
    // Its cargo is a human type (spec line 88); the channel name stays in the line's label.
    expect(ipc).toMatchObject({ from: RENDERER, to: MAIN, cargo: 'messages', tech: ['IPC'], twoWay: false })
    expect(ipc.label).toContain('checkout:run')
    expect(doc.cargo.messages).toEqual({ shape: expect.any(String), color: expect.any(String), label: 'Messages inside the app' })
    expect(doc.cargo.code.label).toBe('Code')
    expect(doc.cargo['checkout:run']).toBeUndefined()
    expect(doc.glossary.IPC).toBe(BUILTIN_GLOSSARY.IPC)

    // Externals: agent CLIs and non-local hosts only, each with a conduit from its building.
    expect(doc.externals).toEqual([
      { id: 'x-api-example-com', name: 'api.example.com', kind: 'service', fog: false },
      { id: 'x-claude', name: 'claude', kind: 'agent', fog: false },
      { id: 'x-codex', name: 'codex', kind: 'agent', fog: false }
    ])
    const toClaude = doc.edges.find((e) => e.to === 'x-claude')
    expect(toClaude).toEqual({
      id: edgeId({ from: MAIN, to: 'x-claude' }),
      from: MAIN,
      to: 'x-claude',
      cargo: 'jobs',
      label: 'spawn claude',
      how: [],
      why: [],
      tech: ['Spawn'],
      rate: '',
      twoWay: false,
      claims: [{ text: 'Seen in code', state: 'observed', evidence: [{ kind: 'file', ref: 'src/main/index.ts:6' }] }]
    })
    expect(doc.edges.find((e) => e.to === 'x-api-example-com')?.tech).toEqual(['HTTP client'])

    // Every node has a position; externals sit on a ring outside every district at y=12.
    for (const x of doc.externals) {
      const p = doc.layout.positions[x.id]
      expect(p[1]).toBe(12)
      const far = Math.max(...doc.districts.map((d) => Math.hypot(doc.layout.positions[d.id][0], doc.layout.positions[d.id][2])))
      expect(Math.hypot(p[0], p[2])).toBeCloseTo(far + 40, 1)
    }

    // Tours.
    const fits = doc.tours.find((t) => t.id === 'tour-how-it-fits')
    expect(fits?.steps.map((s) => s.ids[0])).toEqual(['d-root', 'd-src-main', 'd-src-renderer'])
    expect(fits?.steps[1].caption).toBe('main')
    const follow = doc.tours.find((t) => t.id === 'tour-follow-request')
    expect(follow?.steps).toEqual([
      { ids: [RENDERER], caption: 'renderer' },
      { ids: [ipc.id], caption: edgeSummary(ipc.label) }, // the line's short summary, not its identifier list
      { ids: [MAIN], caption: 'main' }
    ])

    // Only snapshot files (joined onto the root) and the test report were read.
    const allowed = new Set([...Object.keys(FIXTURE).map((f) => `${ROOT}/${f}`), REPORT])
    expect(deps.reads.every((p) => allowed.has(p))).toBe(true)
    expect(deps.reads).toContain(`${ROOT}/src/main/index.ts`)
  })

  it('reads relative imports from the file text when the graph has none', async () => {
    const doc = await compileWorld({ snap: snapOf(FIXTURE, {}), projectKey: 'demo', head: HEAD, previous: null }, mkDeps())
    expectValid(doc)
    // The same buildings and import edges as with the graph's specifiers, and the test still links.
    const withGraph = await compileWorld({ snap: snapOf(FIXTURE), projectKey: 'demo', head: HEAD, previous: null }, mkDeps())
    expect(doc.buildings.map((b) => b.id)).toEqual(withGraph.buildings.map((b) => b.id))
    expect(doc.edges.map((e) => e.id)).toEqual(withGraph.edges.map((e) => e.id))
    expect(doc.edges.some((e) => e.from === RENDERER && e.to === VIEW)).toBe(true)
    expect(doc.buildings.find((b) => b.id === VIEW)?.status).toBe('verified')
  })

  it('runtimeNames filled from detected OpenTelemetry service.name literals', async () => {
    const doc = await compileFixture()
    expect(doc.runtimeNames[MAIN]).toEqual(['checkout'])
    expect(doc.runtimeNames[ENV]).toEqual(['checkout-web'])
    expect(doc.runtimeNames[VIEW]).toBeUndefined()
  })

  it('runtimeNames: every literal form, commented-out names ignored, huge and ignored files skipped', async () => {
    const files: Record<string, string> = {
      'src/a.ts': [
        "const r = { 'service.name': 'orders' }",
        'const s = { [SemanticResourceAttributes.SERVICE_NAME]: "billing" }',
        "const t = { [ATTR_SERVICE_NAME]: 'auth' }",
        "const u = { serviceName: 'auth' }",
        "// const v = { serviceName: 'ghost' }",
        "const w = { serviceName: '   ' }"
      ].join('\n'),
      'src/big.ts': `const z = { serviceName: 'huge' }\n${'x'.repeat(512 * 1024)}`,
      'node_modules/lib/index.js': "const q = { serviceName: 'vendor' }",
      '.env': "# OTEL_SERVICE_NAME=commented\nexport OTEL_SERVICE_NAME='api'\n",
      'src/null.ts': 'never returned',
      'src/gone.ts': 'not returned either'
    }
    const read = mkDeps(files)
    const deps = mkDeps(files, {
      readFile: async (p) => {
        if (p.endsWith('null.ts')) throw new Error('unreadable')
        if (p.endsWith('gone.ts')) return null
        return read.readFile(p)
      }
    })
    const doc = await compileWorld({ snap: snapOf(files, {}), projectKey: 'k', head: HEAD, previous: null }, deps)
    expectValid(doc)
    const names = Object.values(doc.runtimeNames).flat().sort()
    expect(names).toEqual(['api', 'auth', 'billing', 'orders'])
    // node_modules is never read.
    expect(read.reads.some((p) => p.includes('node_modules'))).toBe(false)
  })

  it('previous positions preserved', async () => {
    const first = await compileFixture()
    const moved: WorldDoc = JSON.parse(JSON.stringify(first))
    const [x, y, z] = moved.layout.positions[MAIN]
    moved.layout.positions[MAIN] = [x + 1, y, z]
    moved.layout.positions['x-claude'] = [999, 12, -999]
    const second = await compileFixture({}, moved)
    expectValid(second)
    expect(second.layout.positions[MAIN]).toEqual([x + 1, y, z])
    expect(second.layout.positions['x-claude']).toEqual([999, 12, -999])
    expect(second.layout.positions['x-codex']).toEqual(first.layout.positions['x-codex'])
    for (const d of first.districts) expect(second.layout.positions[d.id]).toEqual(first.layout.positions[d.id])

    // An external missing from the previous layout gets a fresh ring spot.
    delete moved.layout.positions['x-codex']
    const third = await compileFixture({}, moved)
    expect(third.layout.positions['x-codex']).toEqual(first.layout.positions['x-codex'])
  })

  it('copies labels.tokens to doc.labelTokens, and an incremental run reports only its own calls', async () => {
    const reply = JSON.stringify({ buildings: {} })
    const llm = vi.fn(async (_prompt: string) => reply)
    const cost = (): number => llm.mock.calls.reduce((n, [p]) => n + Math.ceil(p.length / 4) + Math.ceil(reply.length / 4), 0)
    const first = await compileFixture({ label: labelDeps({ llm }) })
    expect(first.labelTokens).toBeGreaterThan(0)
    expect(first.labelTokens).toBe(cost())
    expect((await compileFixture()).labelTokens).toBe(0)
    llm.mockClear()
    const again = await compileFixture({ label: labelDeps({ llm }) }, first, ['src/renderer/view.ts'])
    expect(llm).toHaveBeenCalledTimes(1)
    expect(again.labelTokens).toBe(cost())
  })

  it('changed=[one file] relabels only that building', async () => {
    const previous = await compileFixture()
    const prev: WorldDoc = JSON.parse(JSON.stringify(previous))
    const main = prev.buildings.find((b) => b.id === MAIN) as WorldDoc['buildings'][number]
    main.name = 'Kept Main'
    prev.districts[0].subtitle = 'kept subtitle'
    const ipcId = edgeId({ from: RENDERER, to: MAIN })
    const importEdge = edgeId({ from: RENDERER, to: VIEW })
    const testEdge = prev.edges.find((e) => e.id === importEdge) as WorldDoc['edges'][number]
    testEdge.label = 'stale import label'
    const ipcEdge = prev.edges.find((e) => e.id === ipcId) as WorldDoc['edges'][number]
    ipcEdge.label = 'Kept IPC label'
    ipcEdge.tech = ['IPC', 'Gone']
    prev.glossary.Legacy = 'kept from before'

    const llm = vi.fn(async (prompt: string) => {
      expect(prompt).toContain(VIEW)
      return JSON.stringify({
        buildings: { [VIEW]: { name: 'View Layer', stack: ['TypeScript', 'Mystery'], how: [{ text: 'Renders.', evidence: ['E1'] }] } },
        // The incoming edge (its from building is untouched) is batched with the changed building.
        edges: { [importEdge]: { label: 'Hands the view its data' } },
        glossary: { TypeScript: 'Typed JavaScript', IPC: 'model says otherwise' }
      })
    })
    const doc = await compileFixture({ label: labelDeps({ llm }) }, prev, ['src/renderer/view.ts'])
    expectValid(doc)
    expect(llm).toHaveBeenCalledTimes(1)
    const byId = new Map(doc.buildings.map((b) => [b.id, b]))
    expect(byId.get(VIEW)?.name).toBe('View Layer')
    expect(byId.get(VIEW)?.stack).toEqual(['TypeScript'])
    expect(byId.get(VIEW)?.how[0].evidence[0].ref).toBe('src/renderer/view.test.ts')
    expect(byId.get(MAIN)?.name).toBe('Kept Main')
    expect(byId.get(RENDERER)?.name).toBe('renderer')
    expect(doc.districts[0].subtitle).toBe('kept subtitle')
    const edges = new Map(doc.edges.map((e) => [e.id, e]))
    expect(edges.get(ipcId)?.label).toBe('Kept IPC label')
    expect(edges.get(ipcId)?.tech).toEqual(['IPC'])
    expect(edges.get(importEdge)?.label).toBe('Hands the view its data')
    expect(doc.glossary.TypeScript).toBe('Typed JavaScript')
    expect(doc.glossary.IPC).toBe(BUILTIN_GLOSSARY.IPC)
    expect(doc.glossary.Legacy).toBe('kept from before')
  })

  it('changed: a district or edge the previous doc lacks gets the code-derived label', async () => {
    const fresh = await compileFixture()
    const prev: WorldDoc = JSON.parse(JSON.stringify(fresh))
    const ipcId = edgeId({ from: RENDERER, to: MAIN })
    for (const d of prev.districts) d.name = `old ${d.id}`
    prev.districts = prev.districts.filter((d) => d.id !== 'd-src-main')
    prev.edges = prev.edges.filter((e) => e.id !== ipcId)
    const llm = vi.fn(async () => null)
    const doc = await compileFixture({ label: labelDeps({ llm }) }, prev, ['.env.production'])
    expectValid(doc)
    expect(llm).toHaveBeenCalledTimes(1)
    const names = new Map(doc.districts.map((d) => [d.id, d.name]))
    expect(names.get('d-src-main')).toBe(fresh.districts[1].name)
    expect(names.get('d-src-renderer')).toBe('old d-src-renderer')
    const label = (d: WorldDoc, id: string): string | undefined => d.edges.find((e) => e.id === id)?.label
    expect(label(doc, ipcId)).toBe(label(fresh, ipcId))
  })

  it('links tests by import and by basename stem, and shares externals between buildings', async () => {
    const files: Record<string, string> = {
      'src/a/a.ts': "fetch('https://api.x.io/one')\nfetch('https://api.x.io/two')\n",
      'src/a/a.test.ts': 'test\n',
      'src/a/a.spec.ts': 'spec\n',
      'src/b/b.ts': "fetch('https://api.x.io/three')\nspawn('claude', [])\n",
      'tests/check.test.ts': 'check\n',
      'tests/more.test.ts': 'more\n'
    }
    const imports = { 'tests/check.test.ts': ['../src/b/b', 'vitest'], 'tests/more.test.ts': ['../src/b/b'] }
    const report = JSON.stringify({
      testResults: [
        { name: 'src/a/a.test.ts', status: 'passed', endTime: 1 },
        { name: 'src/a/a.spec.ts', status: 'passed', endTime: 1 },
        { name: 'tests/check.test.ts', status: 'passed', endTime: 1 },
        { name: 'tests/more.test.ts', status: 'failed', endTime: 1 }
      ]
    })
    const deps = mkDeps(files, {
      readFile: async (p) => (p === REPORT ? report : (files[p.slice(ROOT.length + 1)] ?? null))
    })
    const doc = await compileWorld({ snap: snapOf(files, imports), projectKey: 'k', head: HEAD, previous: null }, deps)
    expectValid(doc)
    const owner = (f: string): string => (doc.buildings.find((b) => b.members.includes(f)) as WorldDoc['buildings'][number]).id
    // a.ts: two stem-matched passing tests; b.ts: two importing tests, one failing.
    expect(doc.buildings.find((b) => b.id === owner('src/a/a.ts'))?.status).toBe('verified')
    expect(doc.buildings.find((b) => b.id === owner('src/b/b.ts'))?.status).toBe('built')
    expect(doc.externals.map((x) => x.id)).toEqual(['x-api-x-io', 'x-claude'])
    const toApi = doc.edges.filter((e) => e.to === 'x-api-x-io')
    expect(toApi.map((e) => e.from).sort()).toEqual([owner('src/a/a.ts'), owner('src/b/b.ts')].sort())
  })

  it('a deleted file relabels its building and leaves no floor listing it; a building new since previous is labelled', async () => {
    const files: Record<string, string> = { 'src/lib/a.ts': 'export const a = 1\n', 'src/z/z.ts': 'export const z = 1\n' }
    const compile = (previous: WorldDoc | null, changed: string[] | undefined, llm: LabelDeps['llm']): Promise<WorldDoc> =>
      compileWorld({ snap: snapOf(files, {}), projectKey: 'k', head: HEAD, previous, changed }, mkDeps(files, { label: labelDeps({ llm }) }))
    const fresh = await compile(null, undefined, null)
    const lib = fresh.buildings.find((b) => b.members.includes('src/lib/a.ts')) as WorldDoc['buildings'][number]
    const prev: WorldDoc = JSON.parse(JSON.stringify(fresh))
    const old = prev.buildings.find((b) => b.id === lib.id) as WorldDoc['buildings'][number]
    old.name = 'Old lib'
    old.members = ['src/lib/a.ts', 'src/lib/b.ts']
    old.floors = [{ name: 'Both', tech: [], members: ['src/lib/a.ts', 'src/lib/b.ts'] }]

    const llm = vi.fn(async (prompt: string) => {
      expect(prompt).toContain(lib.id)
      return JSON.stringify({ buildings: { [lib.id]: { name: 'New lib' } } })
    })
    const doc = await compile(prev, ['src/lib/b.ts'], llm)
    expectValid(doc)
    expect(llm).toHaveBeenCalledTimes(1)
    const now = doc.buildings.find((b) => b.id === lib.id) as WorldDoc['buildings'][number]
    expect(now.name).toBe('New lib')
    expect(now.floors.flatMap((f) => f.members)).not.toContain('src/lib/b.ts')

    // A building the previous doc does not have is labelled even when nothing in it changed.
    const without: WorldDoc = JSON.parse(JSON.stringify(fresh))
    without.buildings = without.buildings.filter((b) => b.id !== lib.id)
    const llm2 = vi.fn(async () => JSON.stringify({ buildings: { [lib.id]: { name: 'Brand new lib' } } }))
    const doc2 = await compile(without, [], llm2)
    expect(llm2).toHaveBeenCalledTimes(1)
    expect(doc2.buildings.find((b) => b.id === lib.id)?.name).toBe('Brand new lib')
  })

  it('changed without a previous doc labels everything; no changed labels everything', async () => {
    const llm = vi.fn(async () => null)
    await compileFixture({ label: labelDeps({ llm }) }, null, ['src/renderer/view.ts'])
    expect(llm).toHaveBeenCalledTimes(3) // one batch per district
    const prev = await compileFixture()
    llm.mockClear()
    await compileFixture({ label: labelDeps({ llm }) }, prev)
    expect(llm).toHaveBeenCalledTimes(3)
    llm.mockClear()
    await compileFixture({ label: labelDeps({ llm }) }, prev, [])
    expect(llm).not.toHaveBeenCalled()
  })

  it('model labels, glossary and floor tech are filtered against the glossary', async () => {
    const llm = vi.fn(async (prompt: string) => {
      if (!prompt.includes('DISTRICT "d-src-main"')) return null
      return JSON.stringify({
        district: { name: 'Main side', subtitle: 'the Electron main process' },
        buildings: {
          [MAIN]: {
            floors: [{ name: 'entry', tech: ['Electron', 'IPC', 'Nope'], members: ['src/main/index.ts'] }],
            stack: ['Electron']
          }
        },
        edges: { [edgeId({ from: MAIN, to: MAIN })]: { label: 'never used' } },
        glossary: { Electron: 'Desktop app framework' }
      })
    })
    const doc = await compileFixture({ label: labelDeps({ llm }) })
    expectValid(doc)
    const main = doc.buildings.find((b) => b.id === MAIN) as WorldDoc['buildings'][number]
    expect(main.floors[0].tech).toEqual(['Electron', 'IPC'])
    expect(main.stack).toEqual(['Electron'])
    expect(doc.districts[1]).toMatchObject({ id: 'd-src-main', name: 'Main side', subtitle: 'the Electron main process' })
    expect(doc.tours[0].steps[1].caption).toBe('the Electron main process')
  })

  it('onProgress stages emitted in order', async () => {
    const seen: [CompileStage, number][] = []
    await compileFixture({ onProgress: (s, p) => seen.push([s, p]) })
    const stages = seen.map(([s]) => s).filter((s, i, a) => i === 0 || a[i - 1] !== s)
    expect(stages).toEqual(['structure', 'boundaries', 'grouping', 'status', 'labelling', 'layout'])
    const pcts = seen.map(([, p]) => p)
    expect(pcts[0]).toBe(0)
    expect(pcts[pcts.length - 1]).toBe(100)
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1])
  })

  it('handles an empty project', async () => {
    const deps = mkDeps({}, { glob: async () => [] })
    const doc = await compileWorld({ snap: snapOf({}, {}), projectKey: 'e', head: HEAD, previous: null }, deps)
    expectValid(doc)
    expect(doc.buildings).toEqual([])
    expect(doc.tours).toEqual([])
    expect(doc.externals).toEqual([])
  })

  it('joins a trailing-slash root once and omits one-step tours', async () => {
    const files = { 'src/x.ts': "spawn('gemini.cmd', [])\n" }
    const deps = mkDeps(files, { glob: async () => [] })
    const doc = await compileWorld({ snap: snapOf(files, {}, `${ROOT}/`), projectKey: 'one', head: HEAD, previous: null }, deps)
    expectValid(doc)
    expect(deps.reads).toEqual([`${ROOT}/src/x.ts`])
    expect(doc.externals).toEqual([{ id: 'x-gemini', name: 'gemini', kind: 'agent', fog: false }])
    expect(doc.tours).toEqual([])
  })

  it('scans source through readSource when given, keeping readFile for the test reports', async () => {
    const base = mkDeps(FIXTURE)
    const fileReads: string[] = []
    const sourceReads: string[] = []
    const deps: CompileDeps = {
      ...base,
      readFile: async (p) => {
        fileReads.push(p)
        return p === REPORT ? REPORT_TEXT : null
      },
      readSource: async (p) => {
        sourceReads.push(p)
        return base.readFile(p)
      }
    }
    const doc = await compileWorld({ snap: snapOf(FIXTURE), projectKey: 'demo', head: HEAD, previous: null }, deps)
    expect(doc).toEqual(await compileFixture())
    expect(fileReads).toEqual([REPORT])
    expect([...sourceReads].sort()).toEqual(Object.keys(FIXTURE).map((f) => `${ROOT}/${f}`).sort())
  })

  it('reads every file once, in chunks, with rising boundary progress', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 70; i++) files[`src/m${String(i).padStart(2, '0')}/f.ts`] = `export const v${i} = ${i}\n`
    const seen: number[] = []
    const deps = mkDeps(files, { glob: async () => [], onProgress: (s, p) => s === 'boundaries' && seen.push(p) })
    const doc = await compileWorld({ snap: snapOf(files, {}), projectKey: 'big', head: HEAD, previous: null }, deps)
    expectValid(doc)
    expect(new Set(deps.reads).size).toBe(70)
    expect(seen.length).toBeGreaterThan(2)
    expect(seen[seen.length - 1]).toBe(40)
  })

  it('lays a linked design over the world as plan versus built, and leaves the world alone without one', async () => {
    const plain = await compileFixture()
    const first = plain.buildings[0]
    const plan = applyDesignPatch(emptyDesignDoc('design:p', 5), [
      { op: 'addDistrict', id: 'd', name: 'Plan' },
      { op: 'addBuilding', id: first.id, districtId: 'd', name: 'Same part' },
      { op: 'addBuilding', id: 'planned-only', districtId: 'd', name: 'Planned only' }
    ]).doc
    const doc = await compileWorld({ snap: snapOf(FIXTURE), projectKey: 'demo', head: HEAD, previous: null, plan }, mkDeps(FIXTURE))
    expectValid(doc)
    expect(doc.buildings).toEqual(plain.buildings)
    expect(doc.layers.plan).toHaveLength(1)
    expect(doc.layers.plan[0].reconcile).toMatchObject({ matched: { [first.id]: first.id }, missing: ['planned-only'], planAt: 5 })
    expect(doc.layers.plan[0].buildings.map((b) => b.id)).toEqual(['planned-only'])
    expect(plain.layers.plan).toEqual([])
  })
})

// ---------- tours (hand-built groupings) ----------

function B(kind: Boundary['kind'], key: string, file = 'f.ts'): Boundary {
  return { kind, key, side: 'consume', file, line: 1 }
}
function bld(id: string, districtId: string, process = ''): GroupBuilding {
  return { id, districtId, name: id, members: [`${id}.ts`], process, boundaries: [] }
}
async function toursOf(g: Grouping): Promise<ReturnType<typeof buildTours>> {
  return buildTours(g, await labelWorld(g, labelDeps()))
}

describe('buildTours', () => {
  it('breaks district dependency cycles by id', async () => {
    const g: Grouping = {
      districts: [
        { id: 'd-b', name: 'B', members: ['b'] },
        { id: 'd-a', name: 'A', members: ['a'] },
        { id: 'd-c', name: 'C', members: ['c'] }
      ],
      buildings: [bld('a', 'd-a'), bld('b', 'd-b'), bld('c', 'd-c')],
      edges: [
        { from: 'a', to: 'b', via: [] },
        { from: 'b', to: 'a', via: [] },
        { from: 'c', to: 'a', via: [] }
      ]
    }
    const tours = await toursOf(g)
    expect(tours.find((t) => t.id === 'tour-how-it-fits')?.steps.map((s) => s.ids[0])).toEqual(['d-a', 'd-b', 'd-c'])
    // No renderer and no boundary edges: the follow tour would have one step, so it is omitted.
    expect(tours.map((t) => t.id)).toEqual(['tour-how-it-fits'])
  })

  it('follows the longest boundary chain, preferring ipc/http/port on ties, from the first building without a renderer', async () => {
    const g: Grouping = {
      districts: [{ id: 'd', name: 'D', members: ['a', 'b', 'c', 'z'] }],
      buildings: [bld('a', 'd'), bld('b', 'd'), bld('c', 'd'), bld('z', 'd')],
      edges: [
        { from: 'a', to: 'b', via: [B('env', 'X')] },
        { from: 'a', to: 'z', via: [B('http-out', 'h.io')] },
        { from: 'b', to: 'c', via: [B('env', 'Y')] },
        { from: 'z', to: 'c', via: [B('port', '80')] },
        { from: 'c', to: 'a', via: [B('ipc', 'loop')] }
      ]
    }
    const follow = (await toursOf(g)).find((t) => t.id === 'tour-follow-request')
    expect(follow?.steps.map((s) => s.ids[0])).toEqual(['a', 'e-a--z', 'z', 'e-z--c', 'c'])
    expect(follow?.steps[1].caption).toBe('calls 1 web address') // 'http-out h.io', summarised
  })

  it('starts at the renderer, caps depth at 8 edges and bounds the search on dense graphs', async () => {
    const chain: Grouping = {
      districts: [{ id: 'd', name: 'D', members: [] }],
      buildings: Array.from({ length: 14 }, (_, i) => bld(`n${String(i).padStart(2, '0')}`, 'd', i === 3 ? 'renderer' : '')),
      edges: Array.from({ length: 13 }, (_, i) => ({
        from: `n${String(i).padStart(2, '0')}`,
        to: `n${String(i + 1).padStart(2, '0')}`,
        via: [B('ipc', `c${i}`)]
      }))
    }
    const steps = (await toursOf(chain)).find((t) => t.id === 'tour-follow-request')?.steps ?? []
    expect(steps[0].ids).toEqual(['n03'])
    expect(steps.length).toBe(1 + 2 * 8)

    const ids = Array.from({ length: 11 }, (_, i) => `k${String(i).padStart(2, '0')}`)
    const dense: Grouping = {
      districts: [{ id: 'd', name: 'D', members: ids }],
      buildings: ids.map((id) => bld(id, 'd')),
      edges: ids.flatMap((a) => ids.filter((b) => b !== a).map((b) => ({ from: a, to: b, via: [B('ipc', `${a}${b}`)] })))
    }
    const t0 = Date.now()
    const denseSteps = (await toursOf(dense)).find((t) => t.id === 'tour-follow-request')?.steps ?? []
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(denseSteps.length).toBe(1 + 2 * 8)
  })
})

// ---------- scheduler ----------

describe('createRecompileScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('scheduler: 500 notify calls within 1s → exactly 1 run; notify during run → exactly 1 follow-up', async () => {
    vi.useFakeTimers()
    let release: () => void = () => undefined
    const run = vi.fn(
      (changed: string[]) =>
        new Promise<void>((res) => {
          void changed
          release = res
        })
    )
    const s = createRecompileScheduler(run, 1500)
    for (let i = 0; i < 500; i++) {
      s.notify([`f${i % 7}.ts`])
      await vi.advanceTimersByTimeAsync(2)
    }
    await vi.advanceTimersByTimeAsync(1497)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toEqual(['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts', 'f6.ts'])

    // Changes during the run: the debounce elapses while busy, so exactly one follow-up queues.
    s.notify(['a.ts'])
    await vi.advanceTimersByTimeAsync(1500)
    s.notify(['b.ts', 'a.ts'])
    await vi.advanceTimersByTimeAsync(1500)
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][0]).toEqual(['a.ts', 'b.ts'])
    release()
    await vi.advanceTimersByTimeAsync(5000)
    expect(run).toHaveBeenCalledTimes(2)
    s.dispose()
  })

  it('a change still debouncing when a run ends waits for its timer', async () => {
    vi.useFakeTimers()
    let release: () => void = () => undefined
    const run = vi.fn(() => new Promise<void>((res) => (release = res)))
    const s = createRecompileScheduler(run)
    s.notify(['a.ts'])
    await vi.advanceTimersByTimeAsync(1500)
    s.notify(['b.ts'])
    await vi.advanceTimersByTimeAsync(100)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1400)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1]).toEqual([['b.ts']])
    s.dispose()
  })

  it('a follow-up absorbs a change still debouncing when the run ends', async () => {
    vi.useFakeTimers()
    let release: () => void = () => undefined
    const run = vi.fn(() => new Promise<void>((res) => (release = res)))
    const s = createRecompileScheduler(run)
    s.notify(['a.ts'])
    await vi.advanceTimersByTimeAsync(1500)
    s.notify(['b.ts'])
    await vi.advanceTimersByTimeAsync(1500) // fires while busy: one follow-up queued
    s.notify(['c.ts']) // still debouncing when the run ends
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1]).toEqual([['b.ts', 'c.ts']])
    release()
    await vi.advanceTimersByTimeAsync(5000)
    expect(run).toHaveBeenCalledTimes(2)
    s.dispose()
  })

  it('swallows rejected and throwing runs, ignores empty notifies, and dispose drops queued work', async () => {
    vi.useFakeTimers()
    const run = vi
      .fn<(c: string[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(() => {
        throw new Error('sync boom')
      })
      .mockResolvedValue(undefined)
    const s = createRecompileScheduler(run, 10)
    s.notify([])
    await vi.advanceTimersByTimeAsync(50)
    expect(run).not.toHaveBeenCalled()
    s.notify(['a'])
    await vi.advanceTimersByTimeAsync(10)
    s.notify(['b'])
    await vi.advanceTimersByTimeAsync(10)
    s.notify(['c'])
    await vi.advanceTimersByTimeAsync(10)
    expect(run.mock.calls).toEqual([[['a']], [['b']], [['c']]])

    s.notify(['d'])
    s.dispose()
    await vi.advanceTimersByTimeAsync(100)
    s.notify(['e'])
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('dispose during a run drops the queued follow-up', async () => {
    vi.useFakeTimers()
    let release: () => void = () => undefined
    const run = vi.fn(() => new Promise<void>((res) => (release = res)))
    const s = createRecompileScheduler(run, 10)
    s.notify(['a'])
    await vi.advanceTimersByTimeAsync(10)
    s.notify(['b'])
    await vi.advanceTimersByTimeAsync(10)
    s.dispose()
    release()
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('claims, name states and annotations', () => {
  const person = { text: 'Confirmed by a person', state: 'verified' as const, evidence: [{ kind: 'person' as const, ref: 'confirmed in Lumopolis' }] }

  it('a building with passing linked tests gets one verified claim; one with none gets none', async () => {
    const doc = await compileFixture()
    const byId = new Map(doc.buildings.map((b) => [b.id, b]))
    expect(byId.get(VIEW)?.claims).toEqual([
      { text: 'Its 1 linked tests passed', state: 'verified', evidence: [{ kind: 'test', ref: 'src/renderer/view.test.ts' }] }
    ])
    expect(byId.get(MAIN)?.claims).toEqual([])
  })

  it('a line shows where it is seen in code: its boundaries file:line, else the importing files', async () => {
    const doc = await compileFixture()
    const ipc = doc.edges.find((e) => e.id === edgeId({ from: RENDERER, to: MAIN })) as WorldDoc['edges'][number]
    expect(ipc.claims).toHaveLength(1)
    expect(ipc.claims[0]).toMatchObject({ text: 'Seen in code', state: 'observed' })
    expect(ipc.claims[0].evidence.every((e) => e.kind === 'file' && /^src\/.+:\d+$/.test(e.ref))).toBe(true)
    // Every line has either claim or none, never a malformed one; at least one comes from imports (no line number).
    expect(doc.edges.every((e) => e.claims.every((c) => c.text === 'Seen in code' && c.evidence.length >= 1 && c.evidence.length <= 3))).toBe(true)
    expect(doc.edges.some((e) => e.claims.some((c) => c.evidence.some((x) => !/:\d+$/.test(x.ref))))).toBe(true)
  })

  it('cites at most three places', async () => {
    const files: Record<string, string> = { ...FIXTURE }
    const imports: Record<string, string[]> = { ...IMPORTS }
    for (const n of ['a', 'b', 'c', 'd']) {
      files[`src/renderer/ui/${n}.ts`] = "import './view'\n"
      imports[`src/renderer/ui/${n}.ts`] = ['../view']
    }
    files['src/renderer/ui/e.ts'] = 'export const e = 1\n' // a member that imports nothing
    imports['src/renderer/ui/a.ts'] = ['../view', 'some-package'] // a package is no place in this code
    const doc = await compileWorld({ snap: snapOf(files, imports), projectKey: 'k', head: HEAD, previous: null }, mkDeps(files))
    const line = doc.edges.find((e) => e.id === edgeId({ from: 'b-src-renderer-ui', to: VIEW })) as WorldDoc['edges'][number]
    expect(line.claims[0].evidence.map((e) => e.ref)).toEqual(['src/renderer/ui/a.ts', 'src/renderer/ui/b.ts', 'src/renderer/ui/c.ts'])
  })

  it('a name the model gave is inferred, one from the code is observed', async () => {
    const plain = await compileFixture()
    expect(plain.buildings.every((b) => b.nameState === 'observed')).toBe(true)
    expect(plain.districts.every((d) => d.nameState === 'observed')).toBe(true)
    const b = plain.buildings[0]
    const d = plain.districts.find((x) => x.id === b.districtId) as WorldDoc['districts'][number]
    const llm = vi.fn(async (prompt: string): Promise<string | null> =>
      prompt.includes(`DISTRICT "${d.id}"`) ? JSON.stringify({ district: { name: 'Renamed District', subtitle: 's' }, buildings: { [b.id]: { name: 'Renamed Building' } } }) : null
    )
    const doc = await compileFixture({ label: labelDeps({ llm }) })
    const nb = doc.buildings.find((x) => x.id === b.id) as WorldDoc['buildings'][number]
    expect(nb.name).toBe('Renamed Building')
    expect(nb.nameState).toBe('inferred')
    expect(doc.districts.find((x) => x.id === d.id)?.nameState).toBe('inferred')
    expectValid(doc)
  })

  it('merges stored annotations by item id into buildings and lines, and again on every compile', async () => {
    const first = await compileFixture()
    const edge = first.edges[0]
    const annotations = vi.fn(async () => ({ [VIEW]: [person], [edge.id]: [person], nothing: [person] }))
    const doc = await compileFixture({ annotations })
    expect(doc.buildings.find((b) => b.id === VIEW)?.claims.slice(-1)[0]).toEqual(person)
    expect(doc.edges.find((e) => e.id === edge.id)?.claims.slice(-1)[0]).toEqual(person)
    expectValid(doc)
    // A recompile over that doc does not double them.
    const again = await compileFixture({ annotations }, doc)
    expect(again.buildings.find((b) => b.id === VIEW)?.claims.filter((c) => c.evidence.some((e) => e.kind === 'person'))).toEqual([person])
  })
});
