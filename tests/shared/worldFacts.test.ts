// Facts the Lumopolis spec states about the code as a whole: the pinned three.js, the live layer kept as
// given, no network calls from the renderer, and a scene model built from the world data alone.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateWorld } from '../../src/shared/world/validate'
import { buildSceneModel, DEFAULT_LAYERS } from '../../src/renderer/src/world/engine/sceneModel'
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
    const offenders = files.filter((f) => /\bfetch\(|XMLHttpRequest|WebSocket|EventSource/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the scene model depends only on world data, not on generatedAt', () => {
    const a = rich()
    const b = { ...rich(), generatedAt: a.generatedAt + 86_400_000 }
    expect(buildSceneModel(b, DEFAULT_LAYERS)).toEqual(buildSceneModel(a, DEFAULT_LAYERS))
  })
})
