// Facts the Lumopolis spec states about the code as a whole: the pinned three.js, the live layer kept as
// given, no network calls from the renderer, and a scene model built from the world data alone.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateWorld } from '../../src/shared/world/validate'
import { buildSceneModel, DEFAULT_LAYERS } from '../../src/renderer/src/world/engine/sceneModel'
import { holoMarks, layoutExtent, STAGE_MARKS } from '../../src/renderer/src/world/engine/holoMarks'
import { PALETTES } from '../../src/renderer/src/world/engine/holoPalette'
import { minimal, rich } from '../renderer/world/helpers'

const ROOT = resolve(__dirname, '../..')

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(ts|tsx|js|jsx)$/.test(name) ? [p] : []
  })
}

describe('Lumopolis facts', () => {
  it('three is pinned at 0.160.0 in package.json and the lockfile', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    expect(pkg.dependencies?.three ?? pkg.devDependencies?.three).toBe('0.160.0')
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
    expect(lock.packages['node_modules/three']?.version).toBe('0.160.0')
  })

  it('validateWorld keeps layers.live as given', () => {
    const live = { b1: { latencyMs: 250, rate: 3 }, extra: ['kept', { deep: true }] }
    const doc = { ...minimal(), layers: { plan: [], live } }
    const res = validateWorld(JSON.parse(JSON.stringify(doc)))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.doc.layers.live).toEqual(live)
  })

  it('the Lumopolis renderer makes no network calls', () => {
    const files = [join(ROOT, 'src/renderer/src/world'), join(ROOT, 'src/renderer/src/components/World')].flatMap(filesUnder)
    expect(files.length).toBeGreaterThan(10)
    const offenders = files.filter((f) => /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the scene model depends only on world data, not on generatedAt', () => {
    const a = rich()
    const b = { ...rich(), generatedAt: a.generatedAt + 86_400_000 }
    expect(buildSceneModel(b, DEFAULT_LAYERS)).toEqual(buildSceneModel(a, DEFAULT_LAYERS))
  })

  // #12 extended to every mark (look spec §4): a data mark varies with doc fields only, a stage mark only with the
  // layout's extent (and the tier and time, which no doc holds).
  it('holoMarks is identical for two docs that differ only in generatedAt', () => {
    const a = rich()
    const b = { ...rich(), generatedAt: a.generatedAt + 86_400_000 }
    for (const p of Object.values(PALETTES)) {
      for (const tier of ['high', 'low', 'flat'] as const) {
        expect(holoMarks(buildSceneModel(b, DEFAULT_LAYERS), p, tier)).toEqual(holoMarks(buildSceneModel(a, DEFAULT_LAYERS), p, tier))
      }
    }
  })

  it('every stage mark is identical for two docs with the same layout extent and different contents', () => {
    const a = rich()
    const b = rich()
    // Same layout (so the same plates and extent); everything else differs: names, hues, floors, statuses, the
    // cargo and its colours, rates, the live layer, the plan.
    b.projectKey = 'other'
    b.districts[0] = { ...b.districts[0], name: 'Elsewhere', hue: 333, subtitle: 'changed' }
    b.buildings = b.buildings.map((x, i) => ({ ...x, name: `${x.name} two`, status: i === 0 ? 'verified' : x.status, floors: [...x.floors, { name: 'G', tech: ['db'], members: [] }] }))
    b.externals = b.externals.map((x) => ({ ...x, name: 'Someone', fog: !x.fog }))
    b.edges = b.edges.map((e) => ({ ...e, label: 'other', rate: '900/s' }))
    b.cargo = { memory: { ...b.cargo.memory, color: '#ff00aa' } }
    b.layers.live = { b1: { latencyMs: 800 } }
    b.layers.plan = []
    const sa = buildSceneModel(a, DEFAULT_LAYERS)
    const sb = buildSceneModel(b, DEFAULT_LAYERS)
    expect(layoutExtent(sb)).toEqual(layoutExtent(sa))
    for (const p of Object.values(PALETTES)) {
      for (const tier of ['high', 'low', 'flat'] as const) {
        const ma = holoMarks(sa, p, tier)
        const mb = holoMarks(sb, p, tier)
        expect(mb.stage).toEqual(ma.stage)
        expect(mb.data).not.toEqual(ma.data) // the contents did change what the data marks show
        for (const m of mb.stage) expect(STAGE_MARKS).toContain(m.kind)
      }
    }
  })
})
