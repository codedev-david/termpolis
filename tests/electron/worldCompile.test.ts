import { afterEach, describe, expect, it, vi } from 'vitest'
import { fill, linear, TIMED } from './_linearTime'
import type { GraphSnapshot } from '../../src/main/codeGraph'
import type { WorldDoc, WorldEdge } from '../../src/shared/world/types'
import { validateWorld } from '../../src/shared/world/validate'
import { applyDesignPatch, emptyDesignDoc } from '../../src/shared/world/designPatch'
import {
  BUILTIN_GLOSSARY,
  STATUS_BEAT_MS,
  buildTours,
  compileWorld,
  compileWorldStaged,
  contentHash,
  createRecompileScheduler,
  isReservedHost,
  manifestServiceNames,
  type CompileDeps,
  type CompileStage,
  type StagedInput
} from '../../src/main/world/compile'
import { isStageCache, STAGE_CACHE_VERSION, type StageCache } from '../../src/main/world/stageCache'
import { BUILTIN_TECH } from '../../src/main/world/techStack'
import { MAX_DETECT_FILE_CHARS } from '../../src/main/world/detectors'
import { KIND_WORD, upgradeSavedWords } from '../../src/main/world/kindWords'
import { edgeId, isToolingPath, shortHash, type GroupBuilding, type Grouping } from '../../src/main/world/group'
import { labelWorld, type LabelDeps } from '../../src/main/world/label'
import type { Boundary } from '../../src/main/world/detectors'
import { edgeSummary } from '../../src/shared/world/edgeText'
import { runtimeText } from '../../src/shared/world/runtimeNames'
import type { TestRun } from '../../src/main/world/testStatus'
/** A cited field, as the model must answer it. */const F = (value: unknown, ev = 'E1'): { value: unknown; evidence: string[] } => ({ value, evidence: [ev] })

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
    "fetch('https://api.shopco.dev/v1/orders')",
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
      { id: 'x-api-shopco-dev', name: 'api.shopco.dev', kind: 'service', fog: false },
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
    expect(doc.edges.find((e) => e.to === 'x-api-shopco-dev')?.tech).toEqual(['HTTP client'])

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

  it('a line whose reverse the code also makes is twoWay on both, each keeping its id; a lone line stays one way', async () => {
    const files = {
      ...FIXTURE,
      'src/main/index.ts': `${FIXTURE['src/main/index.ts']}\nipcRenderer.send('view:ready')`,
      'src/renderer/index.ts': `${FIXTURE['src/renderer/index.ts']}ipcMain.on('view:ready', () => 1)\n`
    }
    const doc = await compileWorld({ snap: snapOf(files), projectKey: 'demo', head: HEAD, previous: null }, mkDeps(files))
    expectValid(doc)
    const there = doc.edges.find((e) => e.id === edgeId({ from: RENDERER, to: MAIN }))
    const back = doc.edges.find((e) => e.id === edgeId({ from: MAIN, to: RENDERER }))
    expect(there?.twoWay).toBe(true)
    expect(back?.twoWay).toBe(true)
    expect(doc.edges.filter((e) => e.id !== there?.id && e.id !== back?.id).every((e) => !e.twoWay)).toBe(true)
    const plain = await compileFixture()
    expect(plain.edges.every((e) => !e.twoWay)).toBe(true)
  })

  it('every built building carries how the grouping made it', async () => {
    const doc = await compileFixture()
    expect(doc.buildings.every((b) => b.growth !== undefined && b.growth.cap === 60)).toBe(true)
    expect(doc.buildings.find((b) => b.id === MAIN)?.growth).toEqual({ start: 'process', seed: 'main', merged: 0, mergedFiles: 0, reached: 0, inFolder: 0, folded: 0, cap: 60 })
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

  it('a capped listing sets doc.filesCapped to the files the world maps, so the pane can say only the first files are shown', async () => {
    const snap = snapOf(FIXTURE)
    const capped = await compileWorld({ snap: { ...snap, filesCapped: 20000 }, projectKey: 'demo', head: HEAD, previous: null }, mkDeps(FIXTURE))
    expect(capped.filesCapped).toBe(new Set(capped.buildings.flatMap((b) => b.members)).size)
    expect(capped.filesCapped).toBeLessThan(20000)
    const plain = await compileFixture()
    expect('filesCapped' in plain).toBe(false)
    expect('filesUnreadable' in plain).toBe(false)
    expect('nestedCapped' in plain).toBe(false)
  })

  it('nested repositories cut at the cap set doc.nestedCapped to the cap they shared, and leave filesCapped out', async () => {
    const snap = snapOf(FIXTURE)
    const cut = await compileWorld({ snap: { ...snap, nestedCapped: 20000 }, projectKey: 'demo', head: HEAD, previous: null }, mkDeps(FIXTURE))
    expect(cut.nestedCapped).toBe(20000)
    expect('filesCapped' in cut).toBe(false)
  })

  it('counts the unreadable names the world would have shown: source files outside the folders it leaves out', async () => {
    const unreadable = ['src/q\uFFFD.ts', 'lib/r\uFFFD.py', 'notes/n\uFFFD.md', 'vendor/v\uFFFD.ts', 'web/w\uFFFD.min.js', 'img/i\uFFFD.png']
    const doc = await compileWorld({ snap: { ...snapOf(FIXTURE), unreadable }, projectKey: 'demo', head: HEAD, previous: null }, mkDeps(FIXTURE))
    expect(doc.filesUnreadable).toBe(2)
    const none = await compileWorld({ snap: { ...snapOf(FIXTURE), unreadable: ['notes/n\uFFFD.md'] }, projectKey: 'demo', head: HEAD, previous: null }, mkDeps(FIXTURE))
    expect('filesUnreadable' in none).toBe(false)
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
    // The view's batch, then its district's first batch, which holds the view, and that batch's first building alone
    // (the reply described none).
    expect(llm).toHaveBeenCalledTimes(3)
    expect(again.labelTokens).toBe(cost())
  })

  it('changed=[one file] relabels only that building', async () => {
    const previous = await compileFixture()
    const prev: WorldDoc = JSON.parse(JSON.stringify(previous))
    const main = prev.buildings.find((b) => b.id === MAIN) as WorldDoc['buildings'][number]
    main.name = 'Kept Main'
    main.nameState = 'inferred'
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
        buildings: { [VIEW]: { name: F('View Layer'), stack: F(['TypeScript', 'Mystery']), how: [{ text: 'Renders.', evidence: ['E1'] }] } },
        // The incoming edge (its from building is untouched) is batched with the changed building.
        edges: { [importEdge]: { label: F('Hands the view its data') } },
        glossary: { TypeScript: F('Typed JavaScript'), IPC: F('model says otherwise') }
      })
    })
    const doc = await compileFixture({ label: labelDeps({ llm }) }, prev, ['src/renderer/view.ts'])
    expectValid(doc)
    // The view's batch, and its district's first batch, which holds the view, for the district's name.
    expect(llm).toHaveBeenCalledTimes(2)
    const byId = new Map(doc.buildings.map((b) => [b.id, b]))
    expect(byId.get(VIEW)?.name).toBe('View Layer')
    expect(byId.get(VIEW)?.stack).toEqual(['TypeScript'])
    expect(byId.get(VIEW)?.how[0].evidence[0].ref).toBe('src/renderer/view.test.ts')
    expect(byId.get(MAIN)?.name).toBe('Kept Main')
    expect(byId.get(MAIN)?.nameState).toBe('inferred')
    expect(byId.get(RENDERER)?.nameState).toBe('observed')
    expect(byId.get(RENDERER)?.name).toBe('renderer')
    expect(doc.districts[0].subtitle).toBe('kept subtitle')
    const edges = new Map(doc.edges.map((e) => [e.id, e]))
    expect(edges.get(ipcId)?.label).toBe('Kept IPC label')
    expect(edges.get(ipcId)?.tech).toEqual(['IPC'])
    expect(edges.get(importEdge)?.label).toBe('Hands the view its data')
    // A builtin technology keeps its own definition, as the builtin glossary does.
    expect(doc.glossary.TypeScript).toBe(BUILTIN_TECH.TypeScript)
    expect(doc.glossary.IPC).toBe(BUILTIN_GLOSSARY.IPC)
    expect(doc.glossary.Legacy).toBe('kept from before')
  })

  it("an incremental re-label names a line's untouched end, with its files, in a line-only batch", async () => {
    const previous = await compileFixture()
    const importEdge = edgeId({ from: RENDERER, to: VIEW })
    const prompts: string[] = []
    // The building batch describes the view but leaves its incoming line out, so the line is asked again alone.
    const llm = vi.fn(async (prompt: string) => {
      prompts.push(prompt)
      if (prompt.includes('this batch describes only the edges')) return JSON.stringify({ edges: { [importEdge]: { label: F('Hands the view its data') } } })
      return JSON.stringify({ buildings: { [VIEW]: { name: F('View Layer') } } })
    })
    const doc = await compileFixture({ label: labelDeps({ llm }) }, previous, ['src/renderer/view.ts'])
    expectValid(doc)
    const lineOnly = prompts.filter((p) => p.includes('this batch describes only the edges'))
    expect(lineOnly).toHaveLength(1)
    // RENDERER is untouched, so it is not in the re-labelled grouping: the line's from end still has its name and files.
    expect(lineOnly[0]).toMatch(/^ {2}from "renderer" files: "src\/renderer\/index\.ts"/m)
    expect(lineOnly[0]).not.toContain(`from "${RENDERER}"`)
    expect(doc.edges.find((e) => e.id === importEdge)?.label).toBe('Hands the view its data')
  })

  it('a scoped compile resets the touched district name and subtitle to the code defaults when the model names it no more', async () => {
    const defaults = await compileFixture()
    const previous = await compileFixture({
      label: labelDeps({
        llm: async () => JSON.stringify({
          district: { name: F('Billing API'), subtitle: F('Processes invoices') },
          buildings: { [VIEW]: { how: [{ text: 'Renders invoices.', evidence: ['E1'] }] } }
        })
      })
    })
    const districtId = previous.buildings.find((b) => b.id === VIEW)?.districtId
    const district = (doc: WorldDoc) => doc.districts.find((d) => d.id === districtId)
    expect(district(previous)).toMatchObject({ name: 'Billing API', subtitle: 'Processes invoices', nameState: 'inferred' })

    const doc = await compileFixture({}, previous, ['src/renderer/view.ts'])
    expect(district(doc)).toEqual(district(defaults))
    expect(doc.districts.filter((d) => d.id !== districtId)).toEqual(previous.districts.filter((d) => d.id !== districtId))
  })

  // Review 2 (NI2): a district is named by its full-compile first batch, so a scoped compile asks that batch again.
  it('a scoped compile asks a touched district its name again, in its full-compile first batch', async () => {
    const previous = await compileFixture()
    const districtId = previous.buildings.find((b) => b.id === VIEW)?.districtId as string
    const llm = vi.fn(async (prompt: string) =>
      prompt.includes(`DISTRICT "${districtId}"`)
        ? JSON.stringify({ district: { name: F('View District'), subtitle: F('Draws the window.') }, buildings: { [VIEW]: { name: F('View Layer') } } })
        : '{}'
    )
    const doc = await compileFixture({ label: labelDeps({ llm }) }, previous, ['src/renderer/view.ts'])
    expectValid(doc)
    // The untouched renderer is in the district's first batch, so the batch that names it lists it too.
    expect(llm.mock.calls.filter(([p]) => p.includes(`DISTRICT "${districtId}"`) && p.includes(`- "${RENDERER}"`) && p.includes(`- "${VIEW}"`))).toHaveLength(1)
    expect(llm.mock.calls.every(([p]) => !p.includes(`DISTRICT "${districtId}/`))).toBe(true)
    expect(doc.districts.find((d) => d.id === districtId)).toMatchObject({ name: 'View District', subtitle: 'Draws the window.', nameState: 'inferred' })
    expect(doc.buildings.find((b) => b.id === VIEW)?.name).toBe('View Layer')
    expect(doc.districts.filter((d) => d.id !== districtId)).toEqual(previous.districts.filter((d) => d.id !== districtId))
  })

  describe('scoped compile: district names (review 2, NI2)', () => {
    // One district of five buildings: its first batch is alpha, beta and delta (grouping order), so gamma and epsilon are outside it.
    const CORE_NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
    const CORE: Record<string, string> = Object.fromEntries(
      CORE_NAMES.flatMap((n) => [
        [`src/core/${n}/index.ts`, `import './util'\nexport const ${n} = 1\n`],
        [`src/core/${n}/util.ts`, 'export const u = 1\n']
      ])
    )
    const CORE_IMPORTS = Object.fromEntries(CORE_NAMES.map((n) => [`src/core/${n}/index.ts`, ['./util']]))
    const CORE_ID = 'd-src-core'
    const FIRST = ['alpha', 'beta', 'delta']
    const compileCore = (over: Partial<CompileDeps> = {}, previous: WorldDoc | null = null, changed?: string[]): Promise<WorldDoc> =>
      compileWorld({ snap: snapOf(CORE, CORE_IMPORTS), projectKey: 'demo', head: HEAD, previous, changed }, mkDeps(CORE, over))
    const rows = (prompt: string): RegExpMatchArray[] => [...(prompt.split('\nBUILDINGS\n')[1] ?? '').matchAll(/^- "([^"]+)": "([^"]+)"$/gm)]
    const listed = (prompt: string): string[] => rows(prompt).map((m) => m[2])
    // A model that names the district from the buildings its batch lists, as one citing their excerpts would, and
    // describes each of them (a building left out is asked again alone, and that batch could name the district).
    const namer = () =>
      vi.fn(async (prompt: string) => {
        const names = listed(prompt)
        const buildings = Object.fromEntries(rows(prompt).map((m) => [m[1], { name: F(`The ${m[2]}`) }]))
        return JSON.stringify({ district: { name: F(`Core of ${names.join(' ')}`), subtitle: F(`Holds ${names.join(' ')}.`) }, buildings })
      })
    const core = (doc: WorldDoc) => doc.districts.find((d) => d.id === CORE_ID)
    const building = (n: string, members: string[]) => ({ id: `b-src-core-${n}`, name: n, members })

    it('the fixture district is named from its first batch by a full compile', async () => {
      const llm = namer()
      const doc = await compileCore({ label: labelDeps({ llm }) })
      expect(doc.buildings.filter((b) => b.districtId === CORE_ID).map((b) => b.id)).toEqual(['alpha', 'beta', 'delta', 'epsilon', 'gamma'].map((n) => `b-src-core-${n}`))
      expect(core(doc)).toMatchObject({ name: 'Core of alpha beta delta', subtitle: 'Holds alpha beta delta.' })
      expect(llm).toHaveBeenCalledTimes(2)
    })

    it.each(CORE_NAMES.flatMap((n) => [`src/core/${n}/index.ts`, `src/core/${n}/util.ts`]))('editing %s gives the district the name Re-layout gives it', async (file) => {
      const relayout = await compileCore({ label: labelDeps({ llm: namer() }) })
      const llm = namer()
      const doc = await compileCore({ label: labelDeps({ llm }) }, relayout, [file])
      expect(core(doc)).toEqual(core(relayout))
      const inFirst = FIRST.some((n) => file.startsWith(`src/core/${n}/`))
      // The edited building's own batch, and the first batch again only when the edit is in it.
      expect(llm.mock.calls.map(([p]) => listed(p))).toEqual([[file.split('/')[2]], ...(inFirst ? [FIRST] : [])])
    })

    it('an edit outside the first batch keeps the previous name, asking no batch for it', async () => {
      const prev: WorldDoc = JSON.parse(JSON.stringify(await compileCore({ label: labelDeps({ llm: namer() }) })))
      Object.assign(core(prev) as object, { name: 'Kept Core', subtitle: 'Kept subtitle.' })
      for (const file of ['src/core/gamma/util.ts', 'src/core/epsilon/index.ts']) {
        const llm = namer()
        const doc = await compileCore({ label: labelDeps({ llm }) }, prev, [file])
        expect(core(doc)).toMatchObject({ name: 'Kept Core', subtitle: 'Kept subtitle.', nameState: 'inferred' })
        expect(llm).toHaveBeenCalledTimes(1)
      }
    })

    it('an edit in the first batch asks exactly that batch, untouched buildings and all, and takes its name', async () => {
      const previous = await compileCore()
      expect(core(previous)?.name).toBe('core')
      const llm = namer()
      const doc = await compileCore({ label: labelDeps({ llm }) }, previous, ['src/core/beta/util.ts'])
      expect(core(doc)).toMatchObject({ name: 'Core of alpha beta delta', subtitle: 'Holds alpha beta delta.', nameState: 'inferred' })
      expect(llm.mock.calls.map(([p]) => listed(p))).toEqual([['beta'], FIRST])
    })

    it('a district that lost a building outside its first batch keeps its previous name, asking nothing', async () => {
      const prev: WorldDoc = JSON.parse(JSON.stringify(await compileCore({ label: labelDeps({ llm: namer() }) })))
      const gamma = prev.buildings.find((b) => b.id === 'b-src-core-gamma') as WorldDoc['buildings'][number]
      prev.buildings.push({ ...gamma, ...building('zeta', ['src/core/zeta/index.ts']) })
      Object.assign(core(prev) as object, { name: 'Kept Core' })
      const llm = namer()
      const doc = await compileCore({ label: labelDeps({ llm }) }, prev, ['src/core/zeta/index.ts'])
      expect(llm).not.toHaveBeenCalled()
      expect(core(doc)?.name).toBe('Kept Core')
    })

    it('a district that lost a first-batch building is asked again with its new first batch', async () => {
      const relayout = await compileCore({ label: labelDeps({ llm: namer() }) })
      const prev: WorldDoc = JSON.parse(JSON.stringify(relayout))
      const alpha = prev.buildings.find((b) => b.id === 'b-src-core-alpha') as WorldDoc['buildings'][number]
      prev.buildings.splice(prev.buildings.indexOf(alpha), 0, { ...alpha, ...building('aaa', ['src/core/aaa/index.ts']) })
      Object.assign(core(prev) as object, { name: 'Core of aaa alpha beta', subtitle: 'Holds aaa alpha beta.' })
      const llm = namer()
      const doc = await compileCore({ label: labelDeps({ llm }) }, prev, ['src/core/aaa/index.ts'])
      expect(llm.mock.calls.map(([p]) => listed(p))).toEqual([FIRST])
      expect(core(doc)).toEqual(core(relayout))
    })

    it('a scoped compile shares the first batch prompt, and so its cached name, with Re-layout', async () => {
      const store = new Map<string, string>()
      const cache = { get: async (h: string) => store.get(h) ?? null, set: async (h: string, v: string) => void store.set(h, v) }
      const previous = await compileCore()
      const scoped = await compileCore({ label: labelDeps({ llm: namer(), cache }) }, previous, ['src/core/alpha/index.ts'])
      const llm = namer()
      const relayout = await compileCore({ label: labelDeps({ llm, cache }) })
      expect(core(relayout)).toEqual(core(scoped))
      // Only the batch the scoped compile never asked (epsilon and gamma) goes to the model.
      expect(llm.mock.calls.map(([p]) => listed(p))).toEqual([['epsilon', 'gamma']])
    })
  })

  it('changed: a district or edge the previous doc lacks gets the code-derived label', async () => {
    const fresh = await compileFixture()
    const prev: WorldDoc = JSON.parse(JSON.stringify(fresh))
    const ipcId = edgeId({ from: RENDERER, to: MAIN })
    for (const d of prev.districts) d.name = `old ${d.id}`
    prev.districts = prev.districts.filter((d) => d.id !== 'd-src-main')
    prev.edges = prev.edges.filter((e) => e.id !== ipcId)
    // An answer describing nothing: the code-derived labels stay, and a batch is asked once (a failed call is retried).
    const llm = vi.fn(async () => '{}')
    const doc = await compileFixture({ label: labelDeps({ llm }) }, prev, ['.env.production'])
    expectValid(doc)
    // The changed building's batch, its district's first batch (it is in it), and the new district's first batch and
    // that batch's first building alone (the reply described it not). The root's first building alone is the
    // root's first batch again, so it is not sent twice.
    expect(llm).toHaveBeenCalledTimes(4)
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

  it.each([
    { name: 'resolved import', test: 'src/search/parser.test.ts', imports: ['./parser'], manifests: ['package.json'], search: 'verified' },
    { name: 'nearest package', test: 'src/search/tests/parser.test.ts', imports: [], manifests: ['package.json', 'src/search/package.json'], search: 'verified' },
    { name: 'ambiguous package', test: 'src/search/parser.test.ts', imports: [], manifests: ['package.json'], search: 'gap' },
    { name: 'no shared package', test: 'tests/parser.test.ts', imports: [], manifests: [], search: 'gap' },
    { name: 'no basename match', test: 'src/search/other.test.ts', imports: [], manifests: ['package.json'], search: 'gap' },
    // Review 1 (I3, M4): a test whose own folder holds its subject needs no manifest, and one that resolves only a helper
    // (its subject imported through an alias the scan cannot read) still links to the subject.
    { name: 'same folder without manifests', test: 'src/search/parser.test.ts', imports: [], manifests: [], search: 'verified' },
    { name: 'a resolved helper only', test: 'src/search/tests/parser.test.ts', imports: ['../../testing/helper'], manifests: ['package.json', 'src/search/package.json'], search: 'verified' },
    { name: 'a resolved helper, ambiguous package', test: 'src/search/tests/parser.test.ts', imports: ['../../testing/helper'], manifests: ['package.json'], search: 'gap' }
  ])('scopes a basename test link by $name', async ({ test, imports, manifests, search }) => {
    const files = {
      'src/search/parser.ts': 'export const search = 1',
      'src/billing/parser.ts': 'export const billing = 1',
      'src/testing/helper.ts': 'export const helper = 1',
      [test]: ''
    }
    const report = JSON.stringify({ testResults: [{ name: test, status: 'passed', endTime: 1 }] })
    const deps = mkDeps(files, {
      glob: async (_root, patterns) => patterns.includes('**/package.json') ? manifests.map((p) => `${ROOT}/${p}`) : [REPORT],
      readFile: async (p) => p === REPORT ? report : (files[p.slice(ROOT.length + 1)] ?? null)
    })
    const doc = await compileWorld({ snap: snapOf(files, { [test]: imports }), projectKey: 'k', head: HEAD, previous: null }, deps)
    const status = (file: string) => doc.buildings.find((b) => b.members.includes(file))?.status
    expect(status('src/search/parser.ts')).toBe(search)
    expect(status('src/billing/parser.ts')).toBe('gap')
    expect(status('src/testing/helper.ts')).toBe(imports.some((i) => i.endsWith('/helper')) ? 'verified' : 'gap')
  })

  it('links a test by name across folders only where the stem names one source file in the world; two or more keep the folder and package rule', async () => {
    const files: Record<string, string> = {
      'packages/a/src/index.ts': 'export const a = 1\n',
      'packages/a/src/index.test.ts': 'test\n',
      'packages/b/src/index.ts': 'export const b = 1\n',
      'packages/b/test/index.test.ts': 'test\n',
      'packages/b/src/deep/index.ts': 'export const d = 1\n',
      'src/foo.ts': 'export const foo = 1\n',
      'tests/foo.test.ts': 'test\n',
      'tests/index.test.ts': 'test\n',
      'tools/index.test.ts': 'test\n'
    }
    // tools/index.test.ts names no file but proves itself by import.
    const imports = { 'tools/index.test.ts': ['../packages/b/src/deep/index'] }
    const report = JSON.stringify({
      testResults: [
        { name: 'packages/a/src/index.test.ts', status: 'passed', endTime: 1 },
        { name: 'packages/b/test/index.test.ts', status: 'failed', endTime: 1 },
        { name: 'tests/foo.test.ts', status: 'passed', endTime: 1 },
        { name: 'tests/index.test.ts', status: 'failed', endTime: 1 },
        { name: 'tools/index.test.ts', status: 'passed', endTime: 1 }
      ]
    })
    const deps = mkDeps(files, {
      readFile: async (p) => (p === REPORT ? report : (files[p.slice(ROOT.length + 1)] ?? null))
    })
    const doc = await compileWorld({ snap: snapOf(files, imports), projectKey: 'k', head: HEAD, previous: null }, deps)
    expectValid(doc)
    const of = (f: string): WorldDoc['buildings'][number] => doc.buildings.find((b) => b.members.includes(f)) as WorldDoc['buildings'][number]
    const refs = (f: string): string[] => of(f).claims.flatMap((c) => c.evidence.filter((e) => e.kind === 'test').map((e) => e.ref)).sort()
    // Three index.ts files: the same-folder test links; the sibling test folder (no package.json) and the root test do not.
    expect(of('packages/a/src/index.ts').status).toBe('verified')
    expect(refs('packages/a/src/index.ts')).toEqual(['packages/a/src/index.test.ts'])
    expect(of('packages/b/src/index.ts').status).toBe('gap')
    expect(refs('packages/b/src/index.ts')).toEqual([])
    for (const f of ['packages/a/src/index.ts', 'packages/b/src/index.ts', 'packages/b/src/deep/index.ts']) expect(refs(f)).not.toContain('tests/index.test.ts')
    // One foo.ts in the world: the usual src/ and tests/ split with no package.json links.
    expect(of('src/foo.ts').status).toBe('verified')
    expect(refs('src/foo.ts')).toEqual(['tests/foo.test.ts'])
    // An import is evidence wherever the test lives.
    expect(refs('packages/b/src/deep/index.ts')).toEqual(['tools/index.test.ts'])
    for (const f of ['packages/a/src/index.ts', 'packages/b/src/index.ts']) expect(refs(f)).not.toContain('tools/index.test.ts')
  })

  it.each([
    { name: 'a lone data file of that stem', files: { 'tests/config.test.ts': '', 'docs/config.json': '{}' }, member: 'docs/config.json', status: 'gap' },
    { name: 'a unique source file beside a data file of that stem', files: { 'tests/config.test.ts': '', 'docs/config.json': '{}', 'src/config.ts': 'export const c = 1' }, member: 'src/config.ts', status: 'verified' },
    { name: 'an empty stem', files: { 'tests/.test.ts': '', 'src/.ts': 'export const c = 1' }, member: 'src/.ts', status: 'gap' }
  ])('the any-depth name link counts source code only and never an empty stem: $name', async ({ files, member, status }) => {
    const report = JSON.stringify({ testResults: Object.keys(files).filter((f) => f.startsWith('tests/')).map((name) => ({ name, status: 'passed', endTime: 1 })) })
    const deps = mkDeps(files, { readFile: async (p) => (p === REPORT ? report : (files[p.slice(ROOT.length + 1) as keyof typeof files] ?? null)) })
    const doc = await compileWorld({ snap: snapOf(files, {}), projectKey: 'k', head: HEAD, previous: null }, deps)
    expectValid(doc)
    expect(doc.buildings.find((b) => b.members.includes(member))?.status).toBe(status)
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
      return JSON.stringify({ buildings: { [lib.id]: { name: F('New lib') } } })
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
    const llm2 = vi.fn(async () => JSON.stringify({ buildings: { [lib.id]: { name: F('Brand new lib') } } }))
    const doc2 = await compile(without, [], llm2)
    expect(llm2).toHaveBeenCalledTimes(1)
    expect(doc2.buildings.find((b) => b.id === lib.id)?.name).toBe('Brand new lib')
  })

  it('changed without a previous doc labels everything; no changed labels everything', async () => {
    const llm = vi.fn(async () => '{}')
    await compileFixture({ label: labelDeps({ llm }) }, null, ['src/renderer/view.ts'])
    // One batch per district, then the second chance for every part a '{}' reply left out (5 smaller batches).
    expect(llm).toHaveBeenCalledTimes(8)
    const prev = await compileFixture()
    llm.mockClear()
    await compileFixture({ label: labelDeps({ llm }) }, prev)
    expect(llm).toHaveBeenCalledTimes(8)
    llm.mockClear()
    await compileFixture({ label: labelDeps({ llm }) }, prev, [])
    expect(llm).not.toHaveBeenCalled()
  })

  it('model labels, glossary and floor tech are filtered against the glossary', async () => {
    // Other districts get a reply that describes nothing: a quick null reads as no model reachable and stops the pass.
    const llm = vi.fn(async (prompt: string) => {
      if (!prompt.includes('DISTRICT "d-src-main"')) return '{}'
      return JSON.stringify({
        district: { name: F('Main side'), subtitle: F('the Electron main process') },
        buildings: {
          [MAIN]: {
            floors: [{ name: F('entry'), tech: F(['Electron', 'IPC', 'Nope']), members: ['src/main/index.ts'] }],
            stack: F(['Electron'])
          }
        },
        edges: { [edgeId({ from: MAIN, to: MAIN })]: { label: F('never used') } },
        glossary: { Electron: F('Desktop app framework') }
      })
    })
    const doc = await compileFixture({ label: labelDeps({ llm }) })
    expectValid(doc)
    const main = doc.buildings.find((b) => b.id === MAIN) as WorldDoc['buildings'][number]
    expect(main.floors[0].tech).toEqual(['Electron', 'IPC'])
    expect(main.stack).toEqual(['TypeScript', 'Node.js', 'Electron'])
    expect(doc.districts[1]).toMatchObject({ id: 'd-src-main', name: 'Main side', subtitle: 'the Electron main process' })
    expect(doc.tours[0].steps[1].caption).toBe('the Electron main process')
  })

  it("a mapped repo gets technology chips from its code, labelling or not, and the model's stack in any case (film bug 1)", async () => {
    const files = {
      ...FIXTURE,
      'src/renderer/scene.tsx': "import { useState } from 'react'\nimport * as THREE from 'three'\nimport Database from 'better-sqlite3'\nimport { EventEmitter } from 'events'\nimport type { WebContents } from 'electron'\nexport const s = 1\n",
      'src/renderer/index.ts': "import './view'\nimport './scene'\nwindow.api = () => ipcRenderer.invoke('checkout:run')\n"
    }
    const plain = await compileWorld({ snap: snapOf(files), projectKey: 'demo', head: HEAD, previous: null }, mkDeps(files))
    expectValid(plain)
    const stackOf = (d: WorldDoc, id: string): string[] => (d.buildings.find((b) => b.id === id) as WorldDoc['buildings'][number]).stack
    expect(stackOf(plain, MAIN)).toEqual(['TypeScript', 'Node.js', 'Electron'])
    const scene = plain.buildings.find((b) => b.members.includes('src/renderer/scene.tsx')) as WorldDoc['buildings'][number]
    expect(scene.stack).toEqual(expect.arrayContaining(['TypeScript', 'React', 'Three.js', 'SQLite']))
    // The renderer's `events` is a browser polyfill and its Electron import names a type only (fix wave M5).
    expect(scene.process).toBe('renderer')
    expect(scene.stack).not.toContain('Node.js')
    expect(scene.stack).not.toContain('Electron')
    expect(plain.buildings.every((b) => b.stack.every((t) => Object.hasOwn(plain.glossary, t)))).toBe(true)
    expect(plain.glossary.Electron).toBe(BUILTIN_TECH.Electron)
    expect(plain.glossary.Python).toBeUndefined() // only the technologies a chip shows are defined
    // The model's stack in lower case, an alias and a term of its own glossary are named by their keys.
    const llm = vi.fn(async (prompt: string) => {
      if (!prompt.includes('DISTRICT "d-src-main"')) return '{}'
      return JSON.stringify({
        buildings: { [MAIN]: { stack: F(['electron', 'node', 'Event BUS', 'Mystery']) } },
        glossary: { 'Event bus': F('Passes events between parts') }
      })
    })
    const labelled = await compileWorld({ snap: snapOf(files), projectKey: 'demo', head: HEAD, previous: null }, mkDeps(files, { label: labelDeps({ llm }) }))
    expect(stackOf(labelled, MAIN)).toEqual(['TypeScript', 'Node.js', 'Electron', 'Event bus'])
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

  it("a building's stop says what it does after its name; one with nothing said keeps its name alone (F6)", async () => {
    const g: Grouping = {
      districts: [{ id: 'd', name: 'D', members: ['a', 'b'] }],
      buildings: [bld('a', 'd'), bld('b', 'd')],
      edges: [{ from: 'a', to: 'b', via: [B('ipc', 'ch')] }]
    }
    const labels = await labelWorld(g, labelDeps())
    labels.buildings.a = { ...labels.buildings.a, how: [{ text: 'Draws the window and sends what you type to the main process.', state: 'inferred', evidence: [] }, { text: 'Second.', state: 'inferred', evidence: [] }] }
    labels.buildings.b = { ...labels.buildings.b, how: [] }
    const follow = buildTours(g, labels).find((t) => t.id === 'tour-follow-request')
    expect(follow?.steps.map((s) => s.caption)).toEqual(['a: Draws the window and sends what you type to the main process.', 'uses 1 message channel', 'b'])
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
      { text: 'Its 1 linked tests passed', state: 'verified', evidence: [{ kind: 'test', ref: 'src/renderer/view.test.ts', excerpt: 'from a test report' }] }
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
      prompt.includes(`DISTRICT "${d.id}"`) ? JSON.stringify({ district: { name: F('Renamed District'), subtitle: F('s') }, buildings: { [b.id]: { name: F('Renamed Building') } } }) : null
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

// ── Task 14: the staged compile re-reads only what changed ─────────────────────────────────────

describe('manifestServiceNames', () => {
  it('reads compose services, k8s Deployment and Service names, and the package.json name', () => {
    const compose = [
      'version: "3"',
      'services:',
      '  web:',
      '    image: nginx',
      '    environment:',
      '      A: b',
      '  # a comment',
      '',
      '  "api.v2":   # trailing',
      '    build: .',
      'volumes:',
      '  data: {}'
    ].join('\r\n')
    expect(manifestServiceNames('deploy/docker-compose.prod.yml', compose)).toEqual(['web', 'api.v2'])
    expect(manifestServiceNames('docker-compose.yml', 'services: # top\n    only:\n      image: x\n')).toEqual(['only'])
    const k8s = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: orders', '---', 'kind: Service', 'metadata:', '  name: orders-svc', '---', 'kind: ConfigMap', 'metadata:', '  name: not-me', '---', 'kind: Deployment', 'metadata:', '  name: "bad name!"'].join('\n')
    expect(manifestServiceNames('k8s/app.yaml', k8s)).toEqual(['orders', 'orders-svc'])
    expect(manifestServiceNames('package.json', '{"name":"@acme/checkout-web"}')).toEqual(['checkout-web'])
    expect(manifestServiceNames('web/package.json', '{"name":"plain"}')).toEqual(['plain'])
    expect(manifestServiceNames('package.json', '{"version":"1"}')).toEqual([])
    expect(manifestServiceNames('package.json', '{"name":7}')).toEqual([])
    expect(manifestServiceNames('package.json', 'null')).toEqual([])
    expect(manifestServiceNames('package.json', 'not json')).toEqual([])
    expect(manifestServiceNames('notes.yml', 'kind: Deployment\n')).toEqual([])
  })

  it('reads a k8s metadata name after labels, comments, blank lines and CRLF, quoted or bare, and not a generateName', () => {
    const doc = (kind: string, ...meta: string[]): string => ['apiVersion: v1', `kind: ${kind}`, 'metadata:', ...meta, 'spec:', '  replicas: 1', '  template:', '    metadata:', '      name: inner'].join('\n')
    expect(manifestServiceNames('k8s/a.yaml', doc('Deployment', '  labels:', '    app: web', '  # the name', '  name: web'))).toEqual(['web'])
    expect(manifestServiceNames('k8s/a.yaml', doc('Service', "  name: 'q-svc'", '  namespace: x'))).toEqual(['q-svc'])
    expect(manifestServiceNames('k8s/a.yaml', doc('Service', '  name: "dq.svc"  '))).toEqual(['dq.svc'])
    expect(manifestServiceNames('k8s/a.yaml', doc('Service', '\tname: tabbed'))).toEqual(['tabbed'])
    // A blank line, or one of only spaces, inside the block no longer ends it before the name.
    expect(manifestServiceNames('k8s/a.yaml', doc('Deployment', '  labels:', '    app: web', '', '   ', '  name: after-blank'))).toEqual(['after-blank'])
    expect(manifestServiceNames('k8s/a.yaml', doc('Deployment', '  labels:', '    app: web', '  name: crlf').replace(/\n/g, '\r\n'))).toEqual(['crlf'])
    expect(manifestServiceNames('k8s/a.yaml', 'kind: Service\r\nmetadata:  \r\n\r\n  name: s\r\n')).toEqual(['s'])
    // A doubled \r ending the metadata: line, as the old `\s*` read it.
    expect(manifestServiceNames('k8s/a.yaml', 'kind: Service\r\nmetadata:\r\r\n  name: a\r\n')).toEqual(['a'])
    expect(manifestServiceNames('k8s/a.yaml', 'kind: Service\r\nmetadata: \r\r\r\n  name: b\r\r\n')).toEqual(['b'])
    // A doubled \r on a blank line inside the block, as on the metadata: line.
    expect(manifestServiceNames('k8s/a.yaml', 'kind: Service\r\nmetadata:\r\n\r\r\n  name: c\r\n')).toEqual(['c'])
    // Only metadata's own name: a name: nested under labels is a label, and a comment's indent sets nothing.
    expect(manifestServiceNames('k8s/a.yaml', doc('Deployment', '  labels:', '    name: label-value', '  name: real'))).toEqual(['real'])
    expect(manifestServiceNames('k8s/a.yaml', doc('Deployment', '  labels:', '    name: label-only'))).toEqual([])
    expect(manifestServiceNames('k8s/a.yaml', doc('Service', '      # deeper comment', '  name: own'))).toEqual(['own'])
    expect(manifestServiceNames('k8s/a.yaml', doc('Service', '  name: two words', '  name: second'))).toEqual(['second'])
    // A comment at column 0 does not end the block (YAML allows it there); a key less indented than the first one is
    // the block's own indent.
    expect(manifestServiceNames('k8s/a.yaml', doc('Service', '# the name', '  name: after-comment'))).toEqual(['after-comment'])
    expect(manifestServiceNames('k8s/a.yaml', doc('Service', '    app: x', '  name: shallower'))).toEqual(['shallower'])
    // generateName only: the block ends at spec:, and a name further down belongs to something else.
    expect(manifestServiceNames('k8s/a.yaml', doc('Deployment', '  generateName: gen-', '  labels:', '    app: web'))).toEqual([])
    expect(manifestServiceNames('k8s/a.yaml', 'kind: Deployment\nmetadata:\nspec:\n  name: no')).toEqual([])
    // A metadata: block that ends unnamed, then a second one at the top level that is named.
    expect(manifestServiceNames('k8s/a.yaml', 'kind: Service\nmetadata:\n  labels: {}\nmetadata:\n  name: later\n')).toEqual(['later'])
    // A name: with its value on the next line, indented deeper, quoted or not, CRLF or not.
    expect(manifestServiceNames('k8s/a.yaml', doc('Service', '  name:', '    nl-web'))).toEqual(['nl-web'])
    expect(manifestServiceNames('k8s/a.yaml', doc('Service', '  name:  ', "      'nl.q'", '  namespace: x').replace(/\n/g, '\r\n'))).toEqual(['nl.q'])
    // ...but not a value at the block's indent or above, nor a key, a blank line or the end of the file under it.
    expect(manifestServiceNames('k8s/a.yaml', doc('Service', '  name:', '  namespace: x'))).toEqual([])
    expect(manifestServiceNames('k8s/a.yaml', doc('Service', '  name:', '    app: x'))).toEqual([])
    expect(manifestServiceNames('k8s/a.yaml', doc('Service', '  name:', '', '    later'))).toEqual([])
    expect(manifestServiceNames('k8s/a.yaml', 'kind: Service\nmetadata:\n  name:')).toEqual([])
    // An empty name: does not stop the search: a name: further down the block is read.
    expect(manifestServiceNames('k8s/a.yaml', doc('Service', '  name:', '  name: second'))).toEqual(['second'])
  })

  describe('reads a metadata block with no name in time linear in its size (exponential on main)', TIMED, () => {
    // Reading 8 times the block takes under 24 times as long (see _linearTime); the regex before took seconds at 50k.
    // One test per input, so each stays well inside the test timeout on a loaded runner with coverage on.
    const N = 64 * 1024
    const read = (src: string): string[] => manifestServiceNames('k8s/a.yaml', src)
    const names = (want: string[]) => (found: string[]): void => expect(found).toEqual(want)
    const head = 'kind: Deployment\nmetadata:\n'
    const cases: [string, (n: number) => string, string[]][] = []
    for (const body of ['\n', '\r\n', '  \n', ' \r\n', '  a: b\n', '  a\n\n', ' ']) {
      cases.push([JSON.stringify(body), (n) => head + fill(body, n), []])
      cases.push([`${JSON.stringify(body)} then a late name`, (n) => head + fill(body, n) + '\nx: 1\n  name: late', []])
    }
    cases.push(['tabs', (n) => head + '\t'.repeat(n) + '\n', []])
    cases.push(['empty names', (n) => head + fill('  name:\n', n), []])
    cases.push(['metadata blocks', (n) => 'kind: Service\n' + fill('metadata:\n  labels:\n', n), []])
    cases.push(['found', (n) => head + fill('  a: b\n\n', n) + '  name: found', ['found']])
    it.each(cases)('%s', (label, make, want) => linear(make, read, N, label, names(want)))
  })
})

describe('compile sources: manifests, hand-edited names, transcript and CI runs', () => {
  const MANIFESTS: Record<string, string> = {
    [`${ROOT}/src/main/package.json`]: '{"name":"main-svc"}',
    [`${ROOT}/src/renderer/docker-compose.yml`]: 'services:\n  viewer:\n    image: x\n',
    [`${ROOT}/node_modules/x/package.json`]: '{"name":"vendor"}',
    [`${ROOT}/src/big/package.json`]: `{"name":"big"}${' '.repeat(300 * 1024)}`,
    [`${ROOT}/nowhere/package.json`]: '{"name":"orphan"}',
    '/elsewhere/package.json': '{"name":"outside"}',
    [`${ROOT}/src/main/unreadable.yml`]: 'x',
    [`${ROOT}/src/main/nonames.yml`]: 'key: 1'
  }
  const baseDeps = mkDeps()
  const withManifests = (over: Partial<CompileDeps> = {}): Partial<CompileDeps> => ({
    glob: async (_r, pats) => (pats.includes('**/package.json') ? [...Object.keys(MANIFESTS), `${ROOT}\\src\\main\\win\\package.json`] : []),
    readFile: async (p) => {
      if (p.endsWith('unreadable.yml')) return null
      return p in MANIFESTS ? MANIFESTS[p] : baseDeps.readFile(p)
    },
    ...over
  })
  const person = (text: string): { text: string; state: 'verified'; evidence: { kind: 'person'; ref: string }[] } => ({ text, state: 'verified', evidence: [{ kind: 'person', ref: 'edited in Lumopolis' }] })

  it('manifest names go to the building owning the most files under the manifest folder', async () => {
    const doc = await compileFixture(withManifests())
    const names = doc.runtimeNames
    expect(names[MAIN]).toEqual(expect.arrayContaining(['checkout', 'main-svc']))
    expect(names[VIEW]).toEqual(['viewer'])
    const all = Object.values(names).flat()
    for (const skipped of ['vendor', 'big', 'orphan', 'outside']) expect(all).not.toContain(skipped)
  })

  it('a glob that rejects leaves the OpenTelemetry names alone', async () => {
    const doc = await compileFixture({ glob: async (_r, pats) => (pats.includes('**/package.json') ? Promise.reject(new Error('x')) : []) })
    expect(doc.runtimeNames[MAIN]).toEqual(['checkout'])
  })

  it('a root package.json goes to one building, the biggest, a tie to the smaller id', async () => {
    const files: Record<string, string> = { 'src/a/x.ts': 'a', 'src/b/y.ts': 'b' }
    const base = mkDeps(files)
    const deps = mkDeps(files, { glob: async () => [`${ROOT}/package.json`], readFile: async (p) => (p === `${ROOT}/package.json` ? '{"name":"whole"}' : base.readFile(p)) })
    const doc = await compileWorld({ snap: snapOf(files, {}), projectKey: 'k', head: HEAD, previous: null }, deps)
    const owners = Object.entries(doc.runtimeNames).filter(([, n]) => n.includes('whole'))
    expect(owners).toHaveLength(1)
    expect(owners[0][0]).toBe(doc.buildings.map((b) => b.id).sort()[0])
  })

  it('runtimeNames merges OpenTelemetry names, manifest names and hand-edited names', async () => {
    const merged = await compileFixture(withManifests())
    expect(merged.runtimeNames[MAIN]).toEqual(['checkout', 'main-svc'])
    // A hand-edited claim is authoritative for its building; another building keeps its detected names.
    const edited = await compileFixture(withManifests({ annotations: async () => ({ [MAIN]: [person(runtimeText(['mine', 'checkout']))] }) }))
    expect(edited.runtimeNames[MAIN]).toEqual(['mine', 'checkout'])
    expect(edited.runtimeNames[VIEW]).toEqual(['viewer'])
    expect(edited.buildings.find((b) => b.id === MAIN)?.claims.some((c) => c.text.startsWith('runtime:'))).toBe(false)
    expectValid(edited)
    const cleared = await compileFixture(withManifests({ annotations: async () => ({ [MAIN]: [person(runtimeText([]))] }) }))
    expect(cleared.runtimeNames[MAIN]).toBeUndefined()
  })

  const TEST_ID = 'src/renderer/view.test.ts'
  const noReport = { glob: async (): Promise<string[]> => [] }

  it('transcript test runs reach readTestResults and can turn a building verified', async () => {
    const doc = await compileFixture({ ...noReport, transcriptRuns: async () => [{ file: TEST_ID, passed: true, at: 7, source: 'transcript' }] })
    const view = doc.buildings.find((b) => b.id === VIEW)
    expect(view?.status).toBe('verified')
    expect(view?.claims.some((c) => c.state === 'verified')).toBe(true)
    const none = await compileFixture(noReport)
    expect(none.buildings.find((b) => b.id === VIEW)?.status).not.toBe('verified')
  })

  it('a CI result marks the tests linked to the changed files, and a test file stands for itself', async () => {
    const ci = (file: string, passed: boolean): TestRun => ({ file, passed, at: 9, source: 'ci' })
    const viaSource = await compileFixture({ ...noReport, ciRuns: async () => [ci('src/renderer/view.ts', true), ci('docs/readme.md', true)] })
    expect(viaSource.buildings.find((b) => b.id === VIEW)?.status).toBe('verified')
    const viaTest = await compileFixture({ ...noReport, ciRuns: async () => [ci(TEST_ID, true)] })
    expect(viaTest.buildings.find((b) => b.id === VIEW)?.status).toBe('verified')
    const failed = await compileFixture({ ...noReport, ciRuns: async () => [ci('src/renderer/view.ts', false)] })
    expect(failed.buildings.find((b) => b.id === VIEW)?.status).not.toBe('verified')
  })
})

describe('compileWorldStaged', () => {
  const sources = (reads: string[]): string[] => reads.filter((p) => p !== REPORT).map((p) => p.slice(ROOT.length + 1))
  const staged = (files: Record<string, string>, extra: Partial<StagedInput> = {}, deps = mkDeps(files)) =>
    compileWorldStaged({ snap: snapOf(files), projectKey: 'demo', head: HEAD, previous: null, ...extra }, deps)

  it('a world from before the cache (no stage cache stored) compiles in full and stores one', async () => {
    const deps = mkDeps()
    const out = await staged(FIXTURE, {}, deps)
    expectValid(out.doc)
    expect(out.doc).toEqual(await compileFixture())
    expect(sources(deps.reads).sort()).toEqual(Object.keys(FIXTURE).sort())
    expect(isStageCache(out.cache)).toBe(true)
    expect(Object.keys(out.cache.files).sort()).toEqual(Object.keys(FIXTURE).sort())
    expect(out.cache.files['src/main/index.ts'].imports).toEqual(['./ipc', './telemetry'])
    expect(out.cache.files['src/main/telemetry.ts'].names).toEqual(['checkout'])
    expect(out.cache.files['src/renderer/view.ts'].names).toBeUndefined()
    expect(out.cache.grouping?.buildings.length).toBe(out.doc.buildings.length)
    // A cache of the wrong shape is ignored: a full read again.
    const deps2 = mkDeps()
    await staged(FIXTURE, { cache: { files: 1 } as unknown as StageCache }, deps2)
    expect(sources(deps2.reads)).toHaveLength(Object.keys(FIXTURE).length)
  })

  it('compile with changed=[a.ts] re-reads only a.ts (readFile spy) and reuses the grouping when imports are unchanged', async () => {
    const first = await staged(FIXTURE)
    const moved = { ...FIXTURE, 'src/main/index.ts': '// a comment that moves every line down\n\n' + FIXTURE['src/main/index.ts'] }
    const deps = mkDeps(moved)
    const readFile = vi.spyOn(deps, 'readFile')
    const out = await staged(moved, { cache: first.cache, changed: ['src/main/index.ts'] }, deps)
    expect(sources(readFile.mock.calls.map((c) => c[0]))).toEqual(['src/main/index.ts'])
    // The grouping was reused (the same districts), with the boundaries moved to their new lines.
    expect(out.cache.structureHash).toBe(first.cache.structureHash)
    expect(out.cache.grouping?.districts).toBe(first.cache.grouping?.districts)
    const lines = (c: StageCache): number[] =>
      (c.grouping?.buildings.find((b) => b.id === MAIN)?.boundaries ?? []).filter((b) => b.file === 'src/main/index.ts').map((b) => b.line)
    expect(lines(out.cache)).toEqual(lines(first.cache).map((l) => l + 2))
    expect(out.cache.files['src/main/ipc.ts']).toBe(first.cache.files['src/main/ipc.ts'])
    // The same world as a full compile of the moved text.
    expect(out.doc).toEqual((await staged(moved)).doc)
  })

  it('compile with a new import edge regroups', async () => {
    const first = await staged(FIXTURE)
    const linked = { ...FIXTURE, 'src/main/ipc.ts': "import './telemetry'\n" + FIXTURE['src/main/ipc.ts'] }
    const deps = mkDeps(linked)
    const out = await staged(linked, { cache: first.cache, changed: ['src/main/ipc.ts'] }, deps)
    expect(sources(deps.reads)).toEqual(['src/main/ipc.ts'])
    expect(out.cache.structureHash).not.toBe(first.cache.structureHash)
    expect(out.cache.grouping?.districts).not.toBe(first.cache.grouping?.districts)
    // The new edge joins ipc and telemetry into one building.
    const members = (d: WorldDoc): string[][] => d.buildings.map((b) => b.members)
    expect(members(first.doc)).toContainEqual(['src/main/ipc.ts'])
    expect(members(out.doc)).toContainEqual(['src/main/ipc.ts', 'src/main/telemetry.ts'])
    expect(out.doc).toEqual((await staged(linked)).doc)
  })

  it('without a changed list every file is read, and a file whose text is the same keeps its old scan', async () => {
    const first = await staged(FIXTURE)
    const edited = { ...FIXTURE, 'src/renderer/view.ts': 'export const view = 2\n' }
    const deps = mkDeps(edited)
    const out = await staged(edited, { cache: first.cache }, deps)
    expect(sources(deps.reads)).toHaveLength(Object.keys(FIXTURE).length)
    expect(out.cache.files['src/main/index.ts']).toBe(first.cache.files['src/main/index.ts'])
    expect(out.cache.files['src/renderer/view.ts']).not.toBe(first.cache.files['src/renderer/view.ts'])
    // reread wins over changed: an empty list reads nothing at all.
    const none = mkDeps(edited)
    const again = await staged(edited, { cache: out.cache, changed: ['src/main/index.ts'], reread: [] }, none)
    expect(sources(none.reads)).toEqual([])
    expect(again.cache.files).toEqual(out.cache.files)
  })

  it('a deleted, unreadable or too-long file has no cache entry; a file the cache lacks is read', async () => {
    const first = await staged(FIXTURE)
    const files = { ...FIXTURE, 'src/main/huge.ts': 'x'.repeat(MAX_DETECT_FILE_CHARS + 1), 'src/main/new.ts': "spawn('claude', [])\n" }
    delete (files as Record<string, string>)['src/main/telemetry.ts']
    const snap = { ...snapOf(files), files: [...Object.keys(files), 'src/main/telemetry.ts'].sort() }
    const deps = mkDeps(files)
    const out = await compileWorldStaged({ snap, projectKey: 'demo', head: HEAD, previous: null, cache: first.cache, changed: ['src/main/telemetry.ts', 'src/main/huge.ts'] }, deps)
    expect(sources(deps.reads).sort()).toEqual(['src/main/huge.ts', 'src/main/new.ts', 'src/main/telemetry.ts'])
    expect(Object.hasOwn(out.cache.files, 'src/main/telemetry.ts')).toBe(false)
    expect(Object.hasOwn(out.cache.files, 'src/main/huge.ts')).toBe(false)
    expect(out.cache.files['src/main/new.ts'].boundaries.map((b) => b.kind)).toEqual(['spawn'])
  })

  it('a reused grouping keeps a boundary it cannot place, and lists each boundary once', async () => {
    const first = await staged(FIXTURE)
    const g = first.cache.grouping as Grouping
    const main = g.buildings.find((b) => b.id === MAIN) as GroupBuilding
    const lost: Boundary = { kind: 'env', key: 'NOWHERE', side: 'consume', file: 'gone.ts', line: 9 }
    const stray: Boundary = { ...main.boundaries[0], line: 999 }
    const tampered: StageCache = {
      ...first.cache,
      grouping: {
        ...g,
        buildings: g.buildings.map((b) => (b.id === MAIN ? { ...b, boundaries: [...b.boundaries, b.boundaries[0], lost, stray, lost] } : b)),
        edges: g.edges.map((e) => ({ ...e, via: [...e.via, ...e.via] }))
      }
    }
    const out = await staged(FIXTURE, { cache: tampered, reread: [] })
    const got = out.cache.grouping?.buildings.find((b) => b.id === MAIN)?.boundaries ?? []
    expect(got).toEqual([...main.boundaries, lost, stray].sort((a, z) => a.file.localeCompare(z.file) || a.line - z.line))
    expect(out.cache.grouping?.edges.map((e) => e.via)).toEqual(g.edges.map((e) => e.via))
  })

  it('two boundaries with the same signature on one line each move to their own new line', async () => {
    const twin = { ...FIXTURE, 'src/main/twin.ts': "spawn('git', ['a']); spawn('git', ['b'])\n" }
    const first = await staged(twin)
    const own = (c: StageCache): Boundary[] => (c.grouping?.buildings ?? []).flatMap((b) => b.boundaries).filter((b) => b.file === 'src/main/twin.ts')
    // The detector finds both calls on line 1, with one signature.
    expect(own(first.cache).map((b) => b.line)).toEqual([1, 1])
    const moved = { ...twin, 'src/main/twin.ts': '\n\n' + twin['src/main/twin.ts'] }
    const out = await staged(moved, { cache: first.cache, changed: ['src/main/twin.ts'] })
    expect(out.cache.grouping?.districts).toBe(first.cache.grouping?.districts)
    expect(own(out.cache).map((b) => b.line)).toEqual([3, 3])
    expect(out.cache.grouping).toEqual((await staged(moved)).cache.grouping)
    expect(out.doc).toEqual((await staged(moved)).doc)
  })

  it('a cache from an older compiler version is no cache: every file is read and grouped afresh', async () => {
    const first = await staged(FIXTURE)
    expect(first.cache.version).toBe(STAGE_CACHE_VERSION)
    const old = { ...first.cache, version: STAGE_CACHE_VERSION - 1 }
    const deps = mkDeps()
    const out = await staged(FIXTURE, { cache: old, changed: ['src/main/index.ts'] }, deps)
    expect(sources(deps.reads).sort()).toEqual(Object.keys(FIXTURE).sort())
    expect(out.cache.files['src/main/ipc.ts']).not.toBe(first.cache.files['src/main/ipc.ts'])
    expect(out.cache.grouping?.districts).not.toBe(first.cache.grouping?.districts)
    expect(out.cache.version).toBe(STAGE_CACHE_VERSION)
    expect(out.doc).toEqual(first.doc)
  })

  it('an edit the changed list never named is still found by a full read, and its building is re-labelled', async () => {
    const first = await staged(FIXTURE)
    const edited = { ...FIXTURE, 'src/main/ipc.ts': "export const CHANNEL = 'checkout:run'\nspawn('gemini', [])\n" }
    const prompts: string[] = []
    const deps = mkDeps(edited, { label: labelDeps({ llm: async (q) => (prompts.push(q), null) }) })
    const reread = Object.keys(edited)
    const out = await staged(edited, { previous: first.doc, cache: first.cache, changed: ['src/renderer/view.ts'], reread }, deps)
    expect(out.cache.files['src/main/ipc.ts']).not.toBe(first.cache.files['src/main/ipc.ts'])
    expect(out.cache.files['src/main/ipc.ts'].boundaries.map((b) => b.key)).toContain('gemini')
    expect(prompts.join(' ')).toContain('src/main/ipc.ts')
    // The model answered nothing, so only the tokens it was sent differ from a full compile.
    expect({ ...out.doc, labelTokens: 0 }).toEqual((await staged(edited, { previous: first.doc, changed: Object.keys(edited) })).doc)
  })

  it('refreshes cached status when a new package boundary removes a test link', async () => {
    const member = 'src/search/parser.ts'
    const test = 'tests/parser.test.ts'
    // A second parser.ts in its own package keeps the stem ambiguous, so only the package boundary decides the link.
    const files = { [member]: 'export const search = 1', 'src/billing/parser.ts': 'export const billing = 1', [test]: '' }
    const manifests = [`${ROOT}/package.json`, `${ROOT}/src/billing/package.json`]
    const onProgress = vi.fn()
    const deps = mkDeps(files, {
      glob: async (_root, patterns) => patterns.includes('**/package.json') ? manifests : [],
      transcriptRuns: async () => [{ file: test, passed: true, at: 1, source: 'transcript' }],
      onProgress
    })
    const input = { snap: snapOf(files, {}), projectKey: 'k', head: HEAD }
    const status = (doc: WorldDoc) => doc.buildings.find((b) => b.members.includes(member))?.status
    const first = await compileWorldStaged({ ...input, previous: null }, deps)
    expect(status(first.doc)).toBe('verified')
    manifests.push(`${ROOT}/tests/package.json`)
    vi.useFakeTimers()
    try {
      const delayedGlob: CompileDeps['glob'] = async (_root, patterns) => {
        if (!patterns.includes('**/package.json')) return []
        await new Promise((resolve) => setTimeout(resolve, STATUS_BEAT_MS * 2))
        return manifests
      }
      const next = compileWorldStaged({ ...input, previous: first.doc, cache: first.cache, changed: [] }, { ...deps, glob: delayedGlob })
      await vi.advanceTimersByTimeAsync(STATUS_BEAT_MS)
      // The bar moves while the listing is awaited (by STATUS_BEAT_STEP a beat, WP4a).
      expect(onProgress.mock.calls.some(([stage, pct]) => stage === 'status' && pct > 55)).toBe(true)
      await vi.advanceTimersByTimeAsync(STATUS_BEAT_MS)
      expect(status((await next).doc)).toBe('gap')
    } finally {
      vi.useRealTimers()
    }
  })

  it('status is worked out again only for touched buildings while the grouping, test links and test results stand', async () => {
    const first = await staged(FIXTURE)
    const viewB = (d: WorldDoc) => d.buildings.find((b) => b.members.includes('src/renderer/view.ts')) as WorldDoc['buildings'][number]
    const mainB = (d: WorldDoc) => d.buildings.find((b) => b.id === MAIN) as WorldDoc['buildings'][number]
    const fresh = { status: mainB(first.doc).status, claims: mainB(first.doc).claims }
    const person = { text: 'Ana confirmed it', state: 'verified' as const, evidence: [{ kind: 'person' as const, ref: 'ana' }] }
    const marked = { text: 'marked', state: 'observed' as const, evidence: [] }
    // A previous doc whose untouched building carries a status and claims no compile would give it.
    const previous: WorldDoc = {
      ...first.doc,
      buildings: first.doc.buildings.map((b) => (b.id === MAIN ? { ...b, status: 'proposed' as const, claims: [marked, person] } : b))
    }
    const scoped = await staged(FIXTURE, { previous, cache: first.cache, changed: ['src/renderer/view.ts'] })
    // Untouched: kept from the previous doc (a person's claim is dropped here; annotations add it back).
    expect(mainB(scoped.doc).status).toBe('proposed')
    expect(mainB(scoped.doc).claims).toEqual([marked])
    // Touched: worked out again.
    expect(viewB(scoped.doc).status).toBe(viewB(first.doc).status)
    expect(scoped.cache.tests).toBe(first.cache.tests)

    // New test results: every building again.
    const later = JSON.stringify({ startTime: 50, testResults: [{ name: `${ROOT}/src/renderer/view.test.ts`, status: 'failed', endTime: 60 }] })
    const testsDeps = mkDeps(FIXTURE)
    const readFile = testsDeps.readFile
    testsDeps.readFile = async (q) => (q === REPORT ? later : readFile(q))
    const retested = await staged(FIXTURE, { previous, cache: first.cache, changed: ['src/renderer/view.ts'] }, testsDeps)
    expect(retested.cache.tests).not.toBe(first.cache.tests)
    expect({ status: mainB(retested.doc).status, claims: mainB(retested.doc).claims }).toEqual(fresh)

    // No changed list, or a regrouped project: every building again.
    const full = await staged(FIXTURE, { previous, cache: first.cache })
    expect({ status: mainB(full.doc).status, claims: mainB(full.doc).claims }).toEqual(fresh)
    const linked = { ...FIXTURE, 'src/main/ipc.ts': "import './telemetry'\n" + FIXTURE['src/main/ipc.ts'] }
    const regrouped = await staged(linked, { previous, cache: first.cache, changed: ['src/main/ipc.ts'] }, mkDeps(linked))
    expect({ status: mainB(regrouped.doc).status, claims: mainB(regrouped.doc).claims }).toEqual(fresh)
  })

  it('a reused grouping keeps a boundary as it was when the old scan held more copies of it than the new one', async () => {
    const first = await staged(FIXTURE)
    const g = first.cache.grouping as Grouping
    const main = g.buildings.find((b) => b.id === MAIN) as GroupBuilding
    const b0 = main.boundaries[0]
    const twin: Boundary = { ...b0 }
    // An old scan (whose hash no longer matches, so the file is scanned again) that listed b0 twice.
    const f = first.cache.files[b0.file]
    const tampered: StageCache = {
      ...first.cache,
      files: { ...first.cache.files, [b0.file]: { ...f, hash: 'stale', boundaries: [...f.boundaries, twin] } },
      grouping: { ...g, buildings: g.buildings.map((b) => (b.id === MAIN ? { ...b, boundaries: [...b.boundaries, twin] } : b)) }
    }
    const out = await staged(FIXTURE, { cache: tampered, changed: [b0.file] })
    const got = out.cache.grouping?.buildings.find((b) => b.id === MAIN)?.boundaries ?? []
    expect(got.filter((b) => b.file === b0.file && b.line === b0.line && b.key === b0.key && b.kind === b0.kind)).toEqual([b0, twin])
  })

  it('contentHash tells texts of the same length apart', () => {
    expect(contentHash('ab')).not.toBe(contentHash('ba'))
    expect(contentHash('ab')).toBe(contentHash('ab'))
    expect(contentHash('')).toMatch(/^0\./)
  })
})

describe('isStageCache', () => {
  const b: Boundary = { kind: 'ipc', key: 'k', side: 'provide', file: 'a.ts', line: 1 }
  const file = { hash: 'h', boundaries: [b], imports: ['./b'] }
  const grouping: Grouping = {
    districts: [{ id: 'd', name: 'd', members: ['b'] }],
    buildings: [{ id: 'b', districtId: 'd', name: 'b', members: ['a.ts'], process: '', boundaries: [b] }],
    edges: [{ from: 'b', to: 'b', via: [b] }]
  }
  it('accepts the shape, with and without a grouping or names', () => {
    expect(isStageCache({ files: { 'a.ts': file }, version: STAGE_CACHE_VERSION, structureHash: 's' })).toBe(true)
    expect(isStageCache({ files: { 'a.ts': { ...file, names: ['svc'] } }, version: STAGE_CACHE_VERSION, structureHash: 's', grouping, tests: 't' })).toBe(true)
  })
  it.each([
    ['null', null],
    ['an array', []],
    ['files not an object', { files: [], version: STAGE_CACHE_VERSION, structureHash: 's' }],
    ['no structure hash', { version: STAGE_CACHE_VERSION, files: {} }],
    ['no version (an older layout)', { files: {}, structureHash: 's' }],
    ['an older version', { version: STAGE_CACHE_VERSION - 1, files: {}, structureHash: 's' }],
    ['a tests hash not a string', { version: STAGE_CACHE_VERSION, files: {}, structureHash: 's', tests: 1 }],
    ['a file without a hash', { files: { a: { ...file, hash: 1 } }, version: STAGE_CACHE_VERSION, structureHash: 's' }],
    ['imports not strings', { files: { a: { ...file, imports: [1] } }, version: STAGE_CACHE_VERSION, structureHash: 's' }],
    ['names not strings', { files: { a: { ...file, names: 'x' } }, version: STAGE_CACHE_VERSION, structureHash: 's' }],
    ['an unknown boundary kind', { files: { a: { ...file, boundaries: [{ ...b, kind: 'nope' }] } }, version: STAGE_CACHE_VERSION, structureHash: 's' }],
    ['a boundary key not a string', { files: { a: { ...file, boundaries: [{ ...b, key: 1 }] } }, version: STAGE_CACHE_VERSION, structureHash: 's' }],
    ['a bad side', { files: { a: { ...file, boundaries: [{ ...b, side: 'both' }] } }, version: STAGE_CACHE_VERSION, structureHash: 's' }],
    ['a boundary file not a string', { files: { a: { ...file, boundaries: [{ ...b, file: null }] } }, version: STAGE_CACHE_VERSION, structureHash: 's' }],
    ['a line not a number', { files: { a: { ...file, boundaries: [{ ...b, line: '1' }] } }, version: STAGE_CACHE_VERSION, structureHash: 's' }],
    ['an infinite line', { files: { a: { ...file, boundaries: [{ ...b, line: Infinity }] } }, version: STAGE_CACHE_VERSION, structureHash: 's' }],
    ['boundaries not a list', { files: { a: { ...file, boundaries: {} } }, version: STAGE_CACHE_VERSION, structureHash: 's' }],
    ['a grouping not an object', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: 1 }],
    ['grouping lists missing', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { districts: [], buildings: [] } }],
    ['grouping districts missing', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { buildings: [], edges: [] } }],
    ['grouping buildings missing', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { districts: [], edges: [] } }],
    ['a bad district', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, districts: [{ id: 'd', name: 'd', members: [1] }] } }],
    ['a district not an object', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, districts: [null] } }],
    ['a district without a name', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, districts: [{ id: 'd', members: [] }] } }],
    ['a district without an id', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, districts: [{ name: 'd', members: [] }] } }],
    ['a building not an object', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, buildings: [1] } }],
    ['a building without an id', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, buildings: [{ ...grouping.buildings[0], id: 1 }] } }],
    ['a building without a district', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, buildings: [{ ...grouping.buildings[0], districtId: 1 }] } }],
    ['a building without a name', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, buildings: [{ ...grouping.buildings[0], name: 1 }] } }],
    ['a building with bad members', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, buildings: [{ ...grouping.buildings[0], members: 'a' }] } }],
    ['a building without a process', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, buildings: [{ ...grouping.buildings[0], process: 1 }] } }],
    ['a building with bad boundaries', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, buildings: [{ ...grouping.buildings[0], boundaries: [1] }] } }],
    ['an edge not an object', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, edges: ['e'] } }],
    ['an edge without a source', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, edges: [{ to: 'b', via: [] }] } }],
    ['an edge without a target', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, edges: [{ from: 'b', via: [] }] } }],
    ['an edge with bad via', { files: {}, version: STAGE_CACHE_VERSION, structureHash: 's', grouping: { ...grouping, edges: [{ from: 'b', to: 'b', via: null }] } }]
  ])('rejects %s', (_name, v) => {
    expect(isStageCache(v)).toBe(false)
  })
})

describe('ids and keys (WP5: G09, G10, F03 and the one-time rename)', () => {
  const person = { text: 'Confirmed by a person', state: 'verified' as const, evidence: [{ kind: 'person' as const, ref: 'confirmed in Lumopolis' }] }
  const orb = (kind: string, ascii: string): string => shortHash(`${kind}\0${ascii}`)
  const byId = <T extends { id: string }>(list: T[]): T[] => [...list].sort((p, q) => (p.id < q.id ? -1 : 1))
  const compileFiles = (files: Record<string, string>, over: Partial<CompileDeps> = {}, previous: WorldDoc | null = null): Promise<WorldDoc> =>
    compileWorld({ snap: snapOf(files, {}), projectKey: 'ids', head: HEAD, previous }, mkDeps(files, { glob: async () => [], ...over }))

  it('G09: hosts that slug alike are two orbs, each line on its own host', async () => {
    const doc = await compileFiles({ 'a.ts': "fetch('https://api.foo.com/a')\n", 'z.ts': "fetch('https://api-foo.com/b')\n" })
    expectValid(doc)
    const dot = `x-api-foo-com--${orb('service', 'api.foo.com')}`
    const dash = `x-api-foo-com--${orb('service', 'api-foo.com')}`
    expect(doc.externals).toEqual(
      byId([
        { id: dot, name: 'api.foo.com', kind: 'service' as const, fog: false },
        { id: dash, name: 'api-foo.com', kind: 'service' as const, fog: false }
      ])
    )
    expect(doc.edges.find((e) => e.from === 'b-a')?.to).toBe(dot)
    expect(doc.edges.find((e) => e.from === 'b-z')?.to).toBe(dash)
    // An agent and a host of one name are two orbs too.
    const both = await compileFiles({ 'a.ts': "spawn('claude', [])\nfetch('https://claude/x')\n" })
    expect(both.externals.map((x) => x.id).sort()).toEqual([`x-claude--${orb('agent', 'claude')}`, `x-claude--${orb('service', 'claude')}`].sort())
  })

  it('G10: an IDN host is one readable orb in either spelling, shown in punycode (WP5 fix I4), and hosts made only of unicode never share one', async () => {
    const doc = await compileFiles({
      'a.ts': "fetch('https://日本.jp/a')\nfetch('https://xn--wgv71a.jp/b')\n",
      'b.ts': "fetch('https://中国.cn/a')\nfetch('https://Bücher.de/x')\n"
    })
    expectValid(doc)
    expect(doc.externals).toEqual([
      { id: 'x-xn-bcher-kva-de', name: 'xn--bcher-kva.de', kind: 'service', fog: false },
      { id: 'x-xn-fiqs8s-cn', name: 'xn--fiqs8s.cn', kind: 'service', fog: false },
      { id: 'x-xn-wgv71a-jp', name: 'xn--wgv71a.jp', kind: 'service', fog: false }
    ])
    expect(doc.edges.filter((e) => e.to === 'x-xn-wgv71a-jp').map((e) => e.from)).toEqual(['b-a'])
  })

  it('WP5 fix I4: a look-alike host is shown as its punycode, never as the name it imitates', async () => {
    // "\u0430pple.com" starts with a Cyrillic letter that looks like a Latin "a".
    const doc = await compileFiles({ 'a.ts': "fetch('https://\u0430pple.com/x')\nfetch('https://apple.com/y')\n" })
    expectValid(doc)
    expect(doc.externals.map((x) => x.name).sort()).toEqual(['apple.com', 'xn--pple-43d.com'])
  })

  it('a host url.domainToASCII refuses keeps its own spelling', async () => {
    const doc = await compileFiles({ 'a.ts': "fetch('https://A|B/x')\nfetch('https://%/y')\n" })
    expect(doc.externals).toEqual(
      byId([
        { id: 'x-a-b', name: 'a|b', kind: 'service' as const, fog: false },
        { id: `x-u${shortHash('%')}`, name: '%', kind: 'service' as const, fog: false }
      ])
    )
  })

  it('F03: a file named only in emoji is a readable building, not root', async () => {
    const doc = await compileFiles({ '🚀.ts': 'export const a = 1\n', 'z.ts': 'export const z = 1\n' })
    expectValid(doc)
    expect(doc.buildings.map((b) => [b.id, b.name])).toEqual([[`b-u${shortHash('🚀')}`, '🚀'], ['b-z', 'z']])
  })

  it('a world compiled under the old id rules keeps its notes, positions and names on the renamed parts, and asks the store to move them once', async () => {
    const files = { '🚀.ts': "fetch('https://api.foo.com/a')\n", 'z.ts': "fetch('https://api-foo.com/b')\n" }
    const now = await compileFiles(files)
    const rocket = `b-u${shortHash('🚀')}`
    const dot = `x-api-foo-com--${orb('service', 'api.foo.com')}`
    const dash = `x-api-foo-com--${orb('service', 'api-foo.com')}`
    // The same world as the old rules made it: the rocket was b-root, and both hosts one orb named after the first.
    const back = new Map([
      [rocket, 'b-root'],
      [dot, 'x-api-foo-com'],
      [dash, 'x-api-foo-com'],
      [edgeId({ from: rocket, to: dot }), edgeId({ from: 'b-root', to: 'x-api-foo-com' })],
      [edgeId({ from: 'b-z', to: dash }), edgeId({ from: 'b-z', to: 'x-api-foo-com' })]
    ])
    const m = (id: string): string => back.get(id) ?? id
    const old: WorldDoc = {
      ...now,
      buildings: now.buildings.map((b) => ({ ...b, id: m(b.id), name: b.id === rocket ? 'Launcher' : b.name })),
      edges: now.edges.map((e) => ({ ...e, id: m(e.id), from: m(e.from), to: m(e.to) })),
      externals: [{ id: 'x-api-foo-com', name: 'api.foo.com', kind: 'service', fog: false }],
      layout: {
        ...now.layout,
        positions: { ...Object.fromEntries(Object.entries(now.layout.positions).map(([k, v]) => [m(k), v])), 'x-api-foo-com': [500, 12, 500] }
      }
    }
    const stored = { 'b-root': [person], [edgeId({ from: 'b-z', to: 'x-api-foo-com' })]: [person] }
    const copyAnnotations = vi.fn(async (_renames: Record<string, string>) => undefined)
    const doc = await compileWorld(
      { snap: snapOf(files, {}), projectKey: 'ids', head: HEAD, previous: old, changed: [] },
      mkDeps(files, { glob: async () => [], annotations: async () => stored, copyAnnotations })
    )
    expectValid(doc)
    expect(copyAnnotations).toHaveBeenCalledTimes(1)
    expect(copyAnnotations).toHaveBeenCalledWith({
      'b-root': rocket,
      'x-api-foo-com': dot,
      [edgeId({ from: 'b-root', to: 'x-api-foo-com' })]: edgeId({ from: rocket, to: dot }),
      [edgeId({ from: 'b-z', to: 'x-api-foo-com' })]: edgeId({ from: 'b-z', to: dash })
    })
    // The note follows the part; the orb keeps its place; the untouched building keeps its label.
    expect(doc.buildings.find((b) => b.id === rocket)?.claims.slice(-1)[0]).toEqual(person)
    expect(doc.buildings.find((b) => b.id === rocket)?.name).toBe('Launcher')
    expect(doc.edges.find((e) => e.id === edgeId({ from: 'b-z', to: dash }))?.claims.slice(-1)[0]).toEqual(person)
    expect(doc.layout.positions[dot]).toEqual([500, 12, 500])
    // Compiled again over its own doc, nothing more is renamed.
    const failing = vi.fn(async (_renames: Record<string, string>): Promise<void> => {
      throw new Error('locked')
    })
    const again = await compileWorld(
      { snap: snapOf(files, {}), projectKey: 'ids', head: HEAD, previous: doc },
      mkDeps(files, { glob: async () => [], copyAnnotations: failing })
    )
    expect(failing).not.toHaveBeenCalled()
    expect(again.buildings.map((b) => b.id)).toEqual(doc.buildings.map((b) => b.id))
    // WP5 fix I2: a store that cannot copy them fails the compile, so the renamed world is never saved without its notes, and
    // the next compile over the same old world asks for the same copy again.
    await expect(compileWorld(
      { snap: snapOf(files, {}), projectKey: 'ids', head: HEAD, previous: old },
      mkDeps(files, { glob: async () => [], copyAnnotations: failing })
    )).rejects.toThrow('locked')
    const retry = vi.fn(async (_renames: Record<string, string>) => undefined)
    const retried = await compileWorld(
      { snap: snapOf(files, {}), projectKey: 'ids', head: HEAD, previous: old },
      mkDeps(files, { glob: async () => [], copyAnnotations: retry })
    )
    expect(retry.mock.calls[0][0]).toEqual(failing.mock.calls[0][0])
    expect(retried.layout.positions[dot]).toEqual([500, 12, 500])
  })
})

describe('tooling dot-folders are left out of the world (WP-LOOK Task 6)', () => {
  const TOOLING: Record<string, string> = {
    '.superpowers/sdd/x.md': '# notes\n',
    '.superpowers/sdd/run.ts': "import { a } from '../../src/a'\nfetch('https://api.github.com/x')\nexport const r = a\n",
    '.claude/hooks/h.py': 'import os\n',
    '.github/workflows/ci.yml': 'on: push\n',
    'src/a.ts': "import { r } from '../.superpowers/sdd/run'\nexport const a = 1\nexport const b = r\n",
    '.env.production': 'OTEL_SERVICE_NAME=shop\n'
  }
  const TOOLING_IMPORTS: Record<string, string[]> = {
    '.superpowers/sdd/run.ts': ['../../src/a'],
    'src/a.ts': ['../.superpowers/sdd/run']
  }
  const compileTooling = (files: Record<string, string>, imports: Record<string, string[]>, over: Partial<CompileDeps> = {}): Promise<WorldDoc> =>
    compileWorld({ snap: snapOf(files, imports), projectKey: 'tooling', head: HEAD, previous: null }, mkDeps(files, { glob: async () => [], ...over }))
  const allMembers = (doc: WorldDoc): string[] => [
    ...doc.buildings.flatMap((b) => [...b.members, ...b.floors.flatMap((f) => f.members)]),
    ...doc.districts.flatMap((d) => d.members)
  ]

  it('a top-level dot-folder never becomes a district, even with code files in it', async () => {
    const doc = await compileTooling(TOOLING, TOOLING_IMPORTS)
    expectValid(doc)
    expect(doc.districts.map((d) => d.id).filter((id) => /superpowers|claude|github/.test(id))).toEqual([])
    const members = doc.buildings.flatMap((b) => b.members)
    expect(members.filter((m) => m.startsWith('.') && m.includes('/'))).toEqual([])
    expect(allMembers(doc).some((m) => /^\.(superpowers|claude|github)\//.test(m))).toBe(false)
    // The real code and a top-level dot-file (not a folder) are still parts.
    expect(members).toEqual(expect.arrayContaining(['src/a.ts', '.env.production']))
    // A tooling file's boundaries make no orb.
    expect(doc.externals).toEqual([])
  })

  it('a dot-folder deeper down (src/.generated) is not treated as tooling', async () => {
    const files = { ...TOOLING, 'src/.generated/types.ts': 'export type T = 1\n' }
    const doc = await compileTooling(files, { ...TOOLING_IMPORTS, 'src/a.ts': ['../.superpowers/sdd/run', './.generated/types'] })
    expectValid(doc)
    expect(doc.buildings.flatMap((b) => b.members)).toContain('src/.generated/types.ts')
    expect(isToolingPath('src/.generated/types.ts')).toBe(false)
    expect(isToolingPath('.github/workflows/ci.yml')).toBe(true)
    expect(isToolingPath('.superpowers/sdd/x.md')).toBe(true)
    // A top-level dot-file is not a folder of tooling.
    expect(isToolingPath('.env.production')).toBe(false)
    expect(isToolingPath('.eslintrc.cjs')).toBe(false)
  })

  it('an import from src into .superpowers makes no conduit', async () => {
    const doc = await compileTooling(TOOLING, TOOLING_IMPORTS)
    expect(doc.edges).toEqual([])
    const ends = new Set(doc.edges.flatMap((e) => [e.from, e.to]))
    for (const b of doc.buildings) if (b.members.some((m) => m.startsWith('.superpowers/'))) expect(ends.has(b.id)).toBe(false)
  })

  it('a test kept in a tooling folder links to no part, so it never marks one verified', async () => {
    const files = { 'src/a.ts': 'export const a = 1\n', '.claude/hooks/a.test.ts': "import { a } from '../../src/a'\n" }
    const report = JSON.stringify({ testResults: [{ name: `${ROOT}/.claude/hooks/a.test.ts`, status: 'passed', endTime: 10 }] })
    const doc = await compileTooling(files, { '.claude/hooks/a.test.ts': ['../../src/a'] }, {
      glob: async () => [REPORT],
      readFile: async (p) => (p === REPORT ? report : p === `${ROOT}/src/a.ts` ? files['src/a.ts'] : null)
    })
    expectValid(doc)
    expect(doc.buildings.map((b) => b.members)).toEqual([['src/a.ts']])
    expect(doc.buildings[0].status).toBe('gap')
  })
})

describe('outside orbs: hosts only tests call, and reserved test domains (WP-LOOK Task 7)', () => {
  const HOSTS: Record<string, string> = {
    'tests/a.test.ts': "fetch('https://relay.test/x')\nfetch('https://t.example.com')\nfetch('https://api.github.com/repos')\n",
    'e2e/b.spec.ts': "fetch('https://h.io/x')\n",
    'src/c.ts': "export async function c(): Promise<unknown> {\n  return (await fetch('https://api.github.com/user')).json()\n}\n"
  }
  const compileHosts = (files: Record<string, string>, previous: WorldDoc | null = null, over: Partial<CompileDeps> = {}): Promise<WorldDoc> =>
    compileWorld({ snap: snapOf(files, {}), projectKey: 'hosts', head: HEAD, previous }, mkDeps(files, { glob: async () => [], ...over }))
  const orbNames = (doc: WorldDoc): string[] => doc.externals.map((x) => x.name).sort()

  it('a host called only from test files is not an orb', async () => {
    const doc = await compileHosts(HOSTS)
    expectValid(doc)
    expect(orbNames(doc)).toEqual(['api.github.com'])
    // A test folder counts whatever the file is called: a helper under tests/, test/, __tests__/ or fixtures/.
    const helpers = await compileHosts({
      'test/helpers/net.ts': "fetch('https://one.io/x')\n",
      'src/__tests__/util.ts': "fetch('https://two.io/x')\n",
      'pkg/fixtures/server.ts': "fetch('https://three.io/x')\n",
      'src/e2e.ts': "fetch('https://four.io/x')\n",
      'src/testing/net.ts': "fetch('https://five.io/x')\n"
    })
    expectValid(helpers)
    // A file named e2e, or a folder whose name only starts like one, is source.
    expect(orbNames(helpers)).toEqual(['five.io', 'four.io'])
  })

  it('a host named like a fixture is still an orb when source code calls it', async () => {
    const doc = await compileHosts({ ...HOSTS, 'src/d.ts': "fetch('https://h.io/live')\n" })
    expect(orbNames(doc)).toEqual(['api.github.com', 'h.io'])
    expect(doc.edges.filter((e) => e.to === 'x-h-io').map((e) => e.from)).toEqual(['b-src-d'])
  })

  it('a reserved host is never an orb, even from source', async () => {
    const reserved = ['relay.test', 'test', 'a.b.example', 'svc.invalid', 'app.localhost', 'example.com', 'api.example.com', 'example.net',
      'x.example.org', 'EXAMPLE.COM', 'example.com.']
    const kept = ['example.com.au', 'myexample.com', 'test.com', 'testing.io', 'examples.org', 'invalid.dev']
    const files = { 'src/r.ts': [...reserved, ...kept].map((h) => `fetch('https://${h}/x')`).join('\n') }
    const doc = await compileHosts(files)
    expectValid(doc)
    expect(orbNames(doc)).toEqual([...kept].sort())
    for (const h of reserved) expect(isReservedHost(h), h).toBe(true)
    for (const h of kept) expect(isReservedHost(h), h).toBe(false)
  })

  it('a host called from source and from tests is one orb with only the source conduit', async () => {
    const doc = await compileHosts(HOSTS)
    const orb = doc.externals.find((x) => x.name === 'api.github.com') as WorldDoc['externals'][number]
    const lines = doc.edges.filter((e) => e.to === orb.id)
    expect(lines.map((e) => e.from)).toEqual(['b-src-c'])
    expect(lines[0].claims[0].evidence).toEqual([{ kind: 'file', ref: 'src/c.ts:2' }])
    // A building holding both a test and its source draws the line from the source's call.
    const mixed = await compileHosts({
      'src/net.test.ts': "import { c } from './net'\nfetch('https://api.github.com/a')\n",
      'src/net.ts': "export const c = 1\nfetch('https://api.github.com/b')\n"
    })
    const toOrb = mixed.edges.filter((e) => e.to === 'x-api-github-com')
    expect(toOrb.flatMap((e) => e.claims.flatMap((c) => c.evidence.map((ev) => ev.ref)))).toEqual(['src/net.ts:2'])
  })

  it('orb ids of the remaining hosts are unchanged (no idRenames churn)', async () => {
    const doc = await compileHosts(HOSTS)
    expect(doc.externals.map((x) => x.id)).toEqual(['x-api-github-com'])
    // A world saved by the older compiler, with the test hosts as orbs and lines from the test buildings.
    const tested = doc.buildings.find((b) => b.members.includes('tests/a.test.ts')) as WorldDoc['buildings'][number]
    const old: WorldDoc = structuredClone(doc)
    for (const [id, name] of [['x-relay-test', 'relay.test'], ['x-t-example-com', 't.example.com'], ['x-h-io', 'h.io']]) {
      old.externals.push({ id, name, kind: 'service', fog: false })
      old.edges.push({ ...doc.edges.find((e) => e.to === 'x-api-github-com') as WorldEdge, id: edgeId({ from: tested.id, to: id }), from: tested.id, to: id })
      old.layout.positions[id] = [1, 12, 1]
    }
    const copy = vi.fn(async (_renames: Record<string, string>) => undefined)
    const again = await compileHosts(HOSTS, old, { copyAnnotations: copy })
    expectValid(again)
    expect(copy).not.toHaveBeenCalled()
    expect(again.externals.map((x) => x.id)).toEqual(['x-api-github-com'])
    expect(again.layout.positions['x-api-github-com']).toEqual(doc.layout.positions['x-api-github-com'])
    expect(again.edges.map((e) => e.id).sort()).toEqual(doc.edges.map((e) => e.id).sort())
  })
})

describe('a saved world with an "other" floor (WP-LOOK Task 8)', () => {
  const BIG = Array.from({ length: 15 }, (_, i) => `src/big/order${String.fromCharCode(65 + i)}.ts`)
  const FILES: Record<string, string> = { ...Object.fromEntries(BIG.map((f) => [f, 'export const v = 1\n'])), 'src/small.ts': 'export const s = 1\n' }
  const compileBig = (previous: WorldDoc | null, changed?: string[]): Promise<WorldDoc> =>
    compileWorld({ snap: snapOf(FILES, {}), projectKey: 'floors', head: HEAD, previous, ...(changed ? { changed } : {}) }, mkDeps(FILES, { glob: async () => [] }))

  it('keeps loading, and the next compile, even one that leaves the building untouched, gives it the new floors', async () => {
    const doc = await compileBig(null)
    const big = doc.buildings.find((b) => b.members.length === 15) as WorldDoc['buildings'][number]
    expect(big.floors.map((f) => f.name)).not.toContain('other')
    const legacy = [...big.members.slice(0, 11).map((m) => ({ name: m.slice(m.lastIndexOf('/') + 1, -3), tech: [], members: [m] })), { name: 'other', tech: [], members: big.members.slice(11) }]
    const saved: WorldDoc = { ...doc, buildings: doc.buildings.map((b) => (b.id === big.id ? { ...b, floors: legacy } : b)) }
    expectValid(saved)
    const again = await compileBig(saved, ['src/small.ts'])
    expectValid(again)
    expect(again.buildings.find((b) => b.id === big.id)?.floors).toEqual(big.floors)
    // Floors of any other shape (a model's own) are kept as they were on an untouched building.
    const named = [{ name: 'Entry', tech: [], members: big.members.slice(0, 5) }, { name: 'other', tech: [], members: big.members.slice(5) }]
    const kept = await compileBig({ ...doc, buildings: doc.buildings.map((b) => (b.id === big.id ? { ...b, floors: named } : b)) }, ['src/small.ts'])
    expect(kept.buildings.find((b) => b.id === big.id)?.floors).toEqual(named)
  })
})

describe('message ports are called message ports, not TCP (WP-LOOK Task 9)', () => {
  // The ptyHost shape: the utility process posts on its parentPort, the host side opens the channel.
  const PTY: Record<string, string> = {
    'src/main/ptyHost.ts': "import { parentPort } from 'node:worker_threads'\nparentPort.postMessage({ kind: 'data' })\n",
    'src/host/channel.ts': 'export const parentPort = new MessageChannel()\n'
  }
  const minimalWorld = (): WorldDoc => ({
    version: 1,
    projectKey: 'p',
    generatedAt: 1,
    sourceRevision: { head: 'h', dirty: false },
    districts: [],
    buildings: [
      { id: 'b-a', districtId: 'd-a', name: 'a', techLabel: '', process: '', floors: [], stack: [], how: [], why: [], status: 'gap', members: ['a.ts'], claims: [], nameState: 'observed' }
    ],
    edges: [],
    externals: [],
    glossary: {},
    cargo: {},
    processes: {},
    tours: [],
    layout: { seed: 1, positions: {} },
    runtimeNames: {},
    layers: { plan: [] }
  })
  const edgeOf = (from: string, to: string): WorldEdge => ({
    id: edgeId({ from, to }), from, to, cargo: '', label: '', how: [], why: [], tech: [], rate: '', twoWay: false, claims: []
  })
  const compilePty = (): Promise<WorldDoc> =>
    compileWorld({ snap: snapOf(PTY, {}), projectKey: 'pty', head: HEAD, previous: null }, mkDeps(PTY, { glob: async () => [] }))

  it('parentPort.postMessage gives a Message port tech chip, not TCP', async () => {
    const doc = await compilePty()
    expectValid(doc)
    const host = doc.buildings.find((b) => b.members.includes('src/main/ptyHost.ts')) as WorldDoc['buildings'][number]
    expect(host.techLabel).toBe('Message port')
    const lines = doc.edges.filter((e) => e.label.startsWith('port '))
    expect(lines.length).toBeGreaterThan(0)
    for (const e of lines) expect(e.tech).toEqual(['Message port'])
    expect(JSON.stringify(doc)).not.toContain('TCP')
  })

  it('the glossary explains Message port', async () => {
    const doc = await compilePty()
    expect(doc.glossary['Message port']).toBe('Messages passed over a channel between two parts of the app')
    expect(BUILTIN_GLOSSARY['Message port']).toBe(doc.glossary['Message port'])
    expect(Object.hasOwn(BUILTIN_GLOSSARY, 'TCP')).toBe(false)
    // Every word the code gives a kind of boundary has a builtin definition.
    for (const w of Object.values(KIND_WORD)) expect(Object.hasOwn(BUILTIN_GLOSSARY, w), w).toBe(true)
  })

  it('a saved world with TCP on a port-only building shows Message port', async () => {
    const doc = await compilePty()
    const host = doc.buildings.find((b) => b.members.includes('src/main/ptyHost.ts')) as WorldDoc['buildings'][number]
    const line = doc.edges.find((e) => e.label.startsWith('port ')) as WorldEdge
    const OLD = 'A network connection on a numbered port'
    // A world the older compiler saved: TCP on the part, on its line, and in the glossary.
    const saved: WorldDoc = {
      ...doc,
      buildings: doc.buildings.map((b) => (b.id === host.id ? { ...b, techLabel: 'TCP' } : b)),
      edges: doc.edges.map((e) => (e.id === line.id ? { ...e, tech: ['TCP'] } : e)),
      glossary: Object.fromEntries([...Object.entries(doc.glossary).filter(([k]) => k !== 'Message port'), ['TCP', OLD]])
    }
    expectValid(saved)
    const up = upgradeSavedWords(saved)
    expectValid(up)
    expect(up.buildings.find((b) => b.id === host.id)?.techLabel).toBe('Message port')
    expect(up.edges.find((e) => e.id === line.id)?.tech).toEqual(['Message port'])
    expect(up.glossary['Message port']).toBe(BUILTIN_GLOSSARY['Message port'])
    expect(Object.hasOwn(up.glossary, 'TCP')).toBe(false)
    // Nothing else moves, and the saved copy is left as it was.
    expect({ ...up, buildings: saved.buildings, edges: saved.edges, glossary: saved.glossary }).toEqual(saved)
    expect(saved.buildings.find((b) => b.id === host.id)?.techLabel).toBe('TCP')
    // The next compile, from the loaded world, keeps the new words even on a part and a line it leaves untouched.
    const again = await compileWorld({ snap: snapOf(PTY, {}), projectKey: 'pty', head: HEAD, previous: up, changed: [] }, mkDeps(PTY, { glob: async () => [] }))
    expect(JSON.stringify(again)).not.toContain('TCP')
  })

  it('a code-made label with TCP among other kind words is renamed; a model\'s own TCP is kept, with its definition', () => {
    const base = { ...minimalWorld() }
    const b = base.buildings[0]
    const OLD = 'A network connection on a numbered port'
    const saved: WorldDoc = {
      ...base,
      buildings: [
        { ...b, id: 'b-mixed', techLabel: 'IPC · TCP · Process' },
        { ...b, id: 'b-model', techLabel: 'TCP server' },
        { ...b, id: 'b-stack', techLabel: 'Redis · TCP', stack: ['TCP'] },
        { ...b, id: 'b-plain', techLabel: 'IPC · Worker' }
      ],
      edges: [
        { ...edgeOf('b-mixed', 'b-model'), label: 'ipc a, port b', tech: ['IPC', 'TCP'] },
        { ...edgeOf('b-model', 'b-stack'), label: 'Streams terminal data', tech: ['TCP'] },
        { ...edgeOf('b-stack', 'b-plain'), label: 'http-out h', tech: ['HTTP client', 'TCP'] }
      ],
      glossary: { IPC: 'x', Process: 'x', 'HTTP client': 'x', TCP: OLD }
    }
    const up = upgradeSavedWords(saved)
    expect(up.buildings.map((x) => x.techLabel)).toEqual(['IPC · Message port · Process', 'TCP server', 'Redis · TCP', 'IPC · Worker'])
    expect(up.buildings[2].stack).toEqual(['TCP'])
    // Only a line the code wrote with a port on it had its TCP from the port.
    expect(up.edges.map((e) => e.tech)).toEqual([['IPC', 'Message port'], ['TCP'], ['HTTP client', 'TCP']])
    // TCP is still in use, so its definition stays, and Message port gains one.
    expect(up.glossary).toEqual({ IPC: 'x', Process: 'x', 'HTTP client': 'x', TCP: OLD, 'Message port': BUILTIN_GLOSSARY['Message port'] })
    // A model's own definition of TCP is never dropped; a world with no TCP comes back as the same object.
    const own = upgradeSavedWords({ ...saved, edges: [saved.edges[0]], buildings: [saved.buildings[0]], glossary: { ...saved.glossary, TCP: 'Our wire' } })
    expect(own.glossary.TCP).toBe('Our wire')
    const none = { ...saved, buildings: [saved.buildings[3]], edges: [], glossary: { IPC: 'x' } }
    expect(upgradeSavedWords(none)).toBe(none)
    // An old definition nothing uses any more is dropped even when nothing was renamed.
    expect(upgradeSavedWords({ ...none, glossary: { IPC: 'x', TCP: OLD } }).glossary).toEqual({ IPC: 'x' })
  })
})
