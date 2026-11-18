// threeRenderer: teardown. dispose() frees every geometry, material and texture it made, takes back
// every host listener it added, removes its DOM, and is harmless a second time; a failure during
// construction undoes what was set up and rethrows (the viewer then falls back to the 2D list).
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { createThreeRenderer, type ThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
import type { SceneModel } from '../../../src/renderer/src/world/engine/sceneModel'
import {
  atRatio, bldg, boxCanvas, conduit, DEFAULT_OPTS, district, fake2d, gpu, orb, rendererOf, sceneOf, smallText, trackListeners, withHarness,
} from './threeHarness'

vi.mock('three', async (orig) => ({ ...(await orig<typeof import('three')>()), WebGLRenderer: (await import('./threeHarness')).FakeWebGLRenderer }))
vi.mock('three/examples/jsm/postprocessing/EffectComposer.js', async () => ({ EffectComposer: (await import('./threeHarness')).FakeEffectComposer }))
vi.mock('three/examples/jsm/postprocessing/RenderPass.js', async () => ({ RenderPass: (await import('./threeHarness')).FakeRenderPass }))
vi.mock('three/examples/jsm/postprocessing/UnrealBloomPass.js', async () => ({ UnrealBloomPass: (await import('./threeHarness')).FakeUnrealBloomPass }))
vi.mock('three/examples/jsm/postprocessing/OutputPass.js', async () => ({ OutputPass: (await import('./threeHarness')).FakeOutputPass }))

const h = withHarness()

/** Everything drawable at once: every look, a process shell, a changed part, fogged externals and both line kinds. */
function everything(): SceneModel {
  return {
    districts: [district('d1', [0, 0, 0], 30), district('d2', [70, 0, 0], 20)],
    buildings: [
      bldg('a', [-8, 0, 0], { ring: true, processShell: 'p1' }),
      bldg('b', [8, 0, 4], { look: 'wire', outline: true }),
      bldg('c', [0, 0, -10], { look: 'fog' }),
      bldg('f', [70, 0, 0], { look: 'fading', heat: 0.6 }),
      bldg('m', [62, 0, 6], { look: 'amber', floors: 1, height: 3 }),
    ],
    conduits: [conduit('e1', [-8, 9, 0], [8, 9, 4]), conduit('e2', [8, 9, 4], [40, 2.2, 40], { dashed: true, cargo: 'k' })],
    orbs: [orb('x', [40, 0, 40], true), orb('y', [-40, 0, 40])],
  }
}
const textOf = (): ReturnType<typeof smallText> => ({ ...smallText(), processes: { p1: { label: 'worker', color: '#f472b6' } }, cargoShapes: { k: 'cube' } })

/** Every geometry, material and texture reachable from the scene (materials' maps included). */
function everyResource(scene: THREE.Scene): Set<THREE.BufferGeometry | THREE.Material | THREE.Texture> {
  const out = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>()
  scene.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry) out.add(m.geometry)
    for (const mat of ([] as THREE.Material[]).concat(m.material ?? [])) {
      out.add(mat)
      const map = (mat as THREE.MeshBasicMaterial).map
      if (map) out.add(map)
    }
  })
  return out
}

/** The listener keys added and not taken back (an add and a remove of the same type and phase cancel). */
function unpaired(log: { added: string[]; removed: string[] }): string[] {
  const left = [...log.added]
  for (const r of log.removed) {
    const i = left.indexOf(r)
    if (i >= 0) left.splice(i, 1)
  }
  return left
}

function exercise(r: ThreeRenderer): void {
  boxCanvas(r.canvas, 800, 600)
  r.draw(everything(), textOf(), true)
  h.frames.step()
  atRatio(r, h.frames, 0.5) // the buildings tier: block batches
  atRatio(r, h.frames, 0.2) // the floors tier: floor batches
  r.setExploded('a')
  r.setSelected('a')
  h.frames.run(3)
  atRatio(r, h.frames, 1) // the districts tier: slabs
}

describe('threeRenderer dispose', () => {
  it('frees every geometry, material and texture, the GPU objects and the batches, and removes its DOM', () => {
    fake2d()
    const log = trackListeners(h.host)
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    exercise(r)
    const scene = sceneOf()
    const all = everyResource(scene)
    expect(all.size).toBeGreaterThan(50)
    const freed = new Set<unknown>()
    for (const x of all) x.addEventListener('dispose', () => freed.add(x))
    const rendersBefore = rendererOf().renders.length
    r.dispose()
    const missed = [...all].filter((x) => !freed.has(x)).map((x) => `${x.type ?? x.constructor.name}`)
    expect(missed).toEqual([])
    const gl = rendererOf()
    expect([gl.disposed, gl.contextLost]).toEqual([1, 1])
    expect([gpu.composers[0].disposed, gpu.renderPasses[0].disposed, gpu.bloomPasses[0].disposed, gpu.outputPasses[0].disposed]).toEqual([1, 1, 1, 1])
    expect(h.host.querySelector('canvas')).toBeNull()
    expect(h.host.querySelector('.lw-labels')).toBeNull()
    expect(h.host.children).toHaveLength(0)
    expect(log.added.length).toBeGreaterThan(0)
    expect(unpaired(log)).toEqual([])
    // no more frames
    expect(h.frames.pending()).toBe(0)
    h.frames.run(3)
    expect(rendererOf().renders.length).toBe(rendersBefore)
    // keys and the wheel reach nothing now
    h.host.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }))
  })

  it('a GPU step that throws during dispose still leaves no canvas or label layer on the page', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.draw(everything(), textOf(), false)
    gpu.failDispose = new Error('context already lost')
    expect(() => r.dispose()).toThrow('context already lost')
    expect(h.host.querySelector('canvas')).toBeNull()
    expect(h.host.querySelector('.lw-labels')).toBeNull()
  })

  it('a second dispose does nothing', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.draw(everything(), textOf(), false)
    r.dispose()
    r.dispose()
    expect(rendererOf().disposed).toBe(1)
    expect(gpu.composers[0].disposed).toBe(1)
  })

  it('at low quality (no composer, no dust) and with no world drawn, it frees what there is', () => {
    const log = trackListeners(h.host)
    const r = createThreeRenderer(h.host, { quality: 'low', reducedMotion: true })
    h.frames.step() // at low quality the scene is seen on the renderer's first frame
    const all = everyResource(sceneOf())
    const freed = new Set<unknown>()
    for (const x of all) x.addEventListener('dispose', () => freed.add(x))
    r.dispose()
    expect([...all].filter((x) => !freed.has(x))).toEqual([])
    expect(rendererOf().disposed).toBe(1)
    expect(h.host.children).toHaveLength(0)
    expect(unpaired(log)).toEqual([])
  })

  it('a dispose during a pulse and a flight settles both', async () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.draw(everything(), textOf(), false)
    h.frames.step()
    const pulse = r.pulse(['e1'], false)
    const flight = r.flyTo({ pos: [10, 50, 80], target: [0, 0, 0] }, false)
    h.frames.run(2)
    r.dispose()
    await expect(Promise.all([pulse, flight])).resolves.toBeDefined()
  })
})

describe('threeRenderer construction failure', () => {
  it('a WebGLRenderer that cannot be made rethrows, and nothing is left in the host', () => {
    gpu.failRenderer = new Error('WebGL unavailable')
    const log = trackListeners(h.host)
    expect(() => createThreeRenderer(h.host, DEFAULT_OPTS)).toThrow('WebGL unavailable')
    expect(h.host.children).toHaveLength(0)
    expect(gpu.renderers).toHaveLength(0)
    expect(unpaired(log)).toEqual([])
  })

  it('a failure after the canvas is up undoes it all: the GL context, the canvas, the label layer and the listeners', () => {
    gpu.failComposer = new Error('no render target')
    const log = trackListeners(h.host)
    expect(() => createThreeRenderer(h.host, DEFAULT_OPTS)).toThrow('no render target')
    const gl = rendererOf()
    expect([gl.disposed, gl.contextLost]).toEqual([1, 1])
    expect(h.host.children).toHaveLength(0)
    expect(log.added).toContain('wheel:true')
    expect(unpaired(log)).toEqual([])
  })

  it('a failure at the very end (the first frame cannot be asked for) also takes back the keys and the resize observer', () => {
    let disconnected = 0
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void { disconnected++ } })
    vi.stubGlobal('requestAnimationFrame', () => { throw new Error('no frames') })
    const log = trackListeners(h.host)
    expect(() => createThreeRenderer(h.host, DEFAULT_OPTS)).toThrow('no frames')
    expect(log.added).toEqual(expect.arrayContaining(['keydown:false', 'keyup:false', 'blur:true']))
    expect(unpaired(log)).toEqual([])
    expect(disconnected).toBe(1)
    expect(h.host.children).toHaveLength(0)
  })

  it('an undo step that throws does not stop the rest: the canvas and the label layer still go', () => {
    gpu.failComposer = new Error('no render target')
    gpu.failDispose = new Error('context already lost')
    expect(() => createThreeRenderer(h.host, DEFAULT_OPTS)).toThrow('no render target')
    expect(h.host.querySelector('canvas')).toBeNull()
    expect(h.host.querySelector('.lw-labels')).toBeNull()
  })
})

describe('threeRenderer textures', () => {
  it('paints the star dot and the fog puff as soft radial gradients where a 2D canvas exists', () => {
    const seen = fake2d()
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    expect(seen.fills).toEqual([[0, 0, 64, 64], expect.any(Array)])
    expect(seen.stops.slice(0, 3)).toEqual([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,.75)'], [1, 'rgba(255,255,255,0)']])
    expect(seen.stops.length).toBeGreaterThan(3)
    r.dispose()
  })
})
