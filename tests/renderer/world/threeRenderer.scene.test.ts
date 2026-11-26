// threeRenderer: building the scene (counts, positions, batching, rebuilds without leaks).
// The GPU boundary is faked (threeHarness.ts); the scene graph, geometries and materials are real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { createThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
import type { SceneModel } from '../../../src/renderer/src/world/engine/sceneModel'
import { batchCapacity } from '../../../src/renderer/src/world/engine/batching'
import { bldg, boxBatches, boxCanvas, conduit, DEFAULT_OPTS, district, emptyText, gpu, installFrames, makeHost, orb, rendererOf, sceneOf, smallCity, smallText, type Frames } from './threeHarness'

vi.mock('three', async (orig) => ({ ...(await orig<typeof import('three')>()), WebGLRenderer: (await import('./threeHarness')).FakeWebGLRenderer }))
vi.mock('three/examples/jsm/postprocessing/EffectComposer.js', async () => ({ EffectComposer: (await import('./threeHarness')).FakeEffectComposer }))
vi.mock('three/examples/jsm/postprocessing/RenderPass.js', async () => ({ RenderPass: (await import('./threeHarness')).FakeRenderPass }))
vi.mock('three/examples/jsm/postprocessing/UnrealBloomPass.js', async () => ({ UnrealBloomPass: (await import('./threeHarness')).FakeUnrealBloomPass }))
vi.mock('three/examples/jsm/postprocessing/OutputPass.js', async () => ({ OutputPass: (await import('./threeHarness')).FakeOutputPass }))

let frames: Frames
let host: HTMLDivElement
beforeEach(() => {
  gpu.reset()
  frames = installFrames()
  host = makeHost(800, 600)
})
afterEach(() => {
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const worldOf = (scene: THREE.Scene): THREE.Group => scene.children.filter((c) => c instanceof THREE.Group)[0] as THREE.Group
const meshesWith = (root: THREE.Object3D, key: string): THREE.Object3D[] => {
  const out: THREE.Object3D[] = []
  root.traverse((o) => { if (o.userData[key] !== undefined) out.push(o) })
  return out
}

const labelTexts = (root: THREE.Object3D, kind: string): string[] => {
  const out: string[] = []
  root.traverse((o) => { if (o instanceof CSS2DObject && o.element.className === 'lw-' + kind) out.push(o.element.textContent ?? '') })
  return out
}

describe('threeRenderer scene build', () => {
  it('sets up the renderer, the composer chain, the lights and the backdrop', () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    const gl = rendererOf()
    expect(gl.args).toEqual([{ antialias: false }]) // the city is drawn into the composer's targets, never the canvas
    expect(gl.pixelRatios).toEqual([1])
    expect(gl.sizes[0]).toEqual([800, 600])
    expect(gl.toneMapping).toBe(THREE.ACESFilmicToneMapping)
    expect(gl.info.autoReset).toBe(false)
    expect(gl.transparentSort).toBeTypeOf('function')
    expect(host.contains(r.canvas)).toBe(true)
    expect(host.querySelector('.lw-labels')).not.toBeNull()
    const [composer] = gpu.composers
    expect(composer.passes).toEqual([gpu.renderPasses[0], gpu.bloomPasses[0], gpu.outputPasses[0]])
    const bloom = gpu.bloomPasses[0]
    expect([bloom.resolution.x, bloom.resolution.y, bloom.strength, bloom.radius, bloom.threshold]).toEqual([800, 600, 1, 0.55, 0.12])
    const scene = sceneOf()
    expect(scene.children.some((c) => c instanceof THREE.AmbientLight)).toBe(true)
    const sun = scene.children.find((c) => c instanceof THREE.DirectionalLight) as THREE.DirectionalLight
    expect(sun.position.toArray()).toEqual([40, 80, 30])
    const points = scene.children.filter((c) => c instanceof THREE.Points) as THREE.Points[]
    expect(points.map((p) => p.geometry.getAttribute('position').count)).toEqual([3500, 1800])
    expect(r.motionState()).toMatchObject({ bloom: true, stars: 3500, dust: 1800 })
    expect(document.getElementById('lumopolis-world-style')).not.toBeNull()
    r.dispose()
  })

  it("draws the city into render targets without samples, so a multisampled canvas would smooth none of it", async () => {
    // The premise of a canvas without multisampling at high quality: three's EffectComposer makes its targets without
    // samples, and the passes draw the city there. Were that to change, the canvas's setting would be worth a new look.
    const { EffectComposer } = await vi.importActual<typeof import('three/examples/jsm/postprocessing/EffectComposer.js')>('three/examples/jsm/postprocessing/EffectComposer.js')
    const stub = { getPixelRatio: () => 1, getSize: (v: THREE.Vector2) => v.set(8, 8) } as unknown as THREE.WebGLRenderer
    const composer = new EffectComposer(stub)
    expect(composer.renderTarget1.samples).toBe(0)
    expect(composer.renderTarget2.samples).toBe(0)
  })

  it('at Flat: no antialias, a 1x ratio, no composer and no dust; frames render straight', () => {
    vi.stubGlobal('devicePixelRatio', 3)
    const r = createThreeRenderer(host, { quality: 'flat', reducedMotion: false })
    const gl = rendererOf()
    expect(gl.args).toEqual([{ antialias: false }])
    expect(gl.pixelRatios).toEqual([1]) // min(3, 1) (look spec §5)
    expect(gpu.composers).toHaveLength(0)
    frames.step()
    expect(gl.renders).toHaveLength(1)
    expect(r.motionState()).toMatchObject({ bloom: false, dust: 0 })
    r.dispose()
  })

  it('draws districts, buildings, lines and orbs with the right counts and positions', () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    frames.step()
    const counts = r.drawnCounts()
    expect(counts).toMatchObject({ buildings: 3, districts: 2, conduits: 2, processShells: 0 })
    const ms = r.motionState()
    expect(ms.platformSides).toEqual({ d1: 6, d2: 6 })
    expect(ms.platformLights).toBe(2)
    expect(ms.orbs).toEqual(['x'])
    expect(ms.floorOrder).toEqual({ a: ['a0', 'a1', 'a2'], b: ['b0', 'b1'], c: [] })
    const world = worldOf(sceneOf())
    const nodeMeshes = meshesWith(world, 'nodeId') as THREE.Mesh[]
    expect(new Set(nodeMeshes.map((m) => m.userData.nodeId))).toEqual(new Set(['a', 'b', 'c', 'x']))
    // a stands at (-6, 0, 0): its three floors' groups sit at the floor centres
    const aFloors = nodeMeshes.filter((m) => m.userData.nodeId === 'a')
    expect(aFloors).toHaveLength(3)
    expect(aFloors.map((m) => m.parent!.position.y)).toEqual([1.5, 4.5, 7.5])
    expect(aFloors[0].parent!.parent!.position.toArray()).toEqual([-6, 0, 0])
    const orbMesh = nodeMeshes.find((m) => m.userData.nodeId === 'x')!
    expect(orbMesh.position.y).toBeCloseTo(2.2)
    const edgeIds = meshesWith(world, 'edgeId').map((o) => o.userData.edgeId)
    expect(new Set(edgeIds)).toEqual(new Set(['e1', 'e2']))
    // labels: buildings, floors, districts, lines
    expect(labelTexts(world, 'bldg').sort()).toEqual(['Alpha', 'Beta', 'External', 'Gamma'])
    expect(labelTexts(world, 'floor')).toEqual(['a0', 'a1', 'a2', 'b0', 'b1'])
    expect(labelTexts(world, 'district')).toEqual(['D1first', 'D2second'])
    expect(labelTexts(world, 'edge')).toEqual(['calls', 'reads'])
    r.dispose()
  })

  it('a backdrop grid sized to the world sits under it', () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    r.draw(smallCity(), smallText(), false)
    const grid = sceneOf().children.find((c) => c instanceof THREE.GridHelper) as THREE.GridHelper
    expect(grid.position.y).toBe(-1.3)
    expect((grid.material as THREE.Material).opacity).toBe(0.35)
    r.draw(smallCity(), smallText(), false)
    expect(sceneOf().children.filter((c) => c instanceof THREE.GridHelper)).toHaveLength(1)
    r.dispose()
  })

  it('rebuilding with a changed model adds, removes and updates objects and frees the old ones', () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    const scene = sceneOf()
    const baseline = scene.children.length
    r.draw(smallCity(), smallText(), false)
    frames.run(3)
    const withWorld = scene.children.length
    const world = worldOf(scene)
    const old: Array<THREE.BufferGeometry | THREE.Material> = []
    world.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) old.push(m.geometry)
      if (m.material) old.push(...([] as THREE.Material[]).concat(m.material))
    })
    const freed = new Set<unknown>()
    for (const x of old) x.addEventListener('dispose', () => freed.add(x))
    const next: SceneModel = { ...smallCity(), buildings: [bldg('a', [-6, 0, 0], { floors: 5, height: 15 }), bldg('n', [4, 0, -4])], conduits: [] }
    r.draw(next, smallText(), false)
    frames.run(3)
    // the old objects are gone and freed (shared unit geometry excepted)
    const kept = old.filter((x) => !freed.has(x))
    for (const x of kept) expect((x as THREE.BufferGeometry).isBufferGeometry).toBe(true)
    expect(r.drawnCounts()).toMatchObject({ buildings: 2, conduits: 0 })
    expect(r.motionState().floorOrder.a).toEqual(['a0', 'a1', 'a2']) // five floors, three captions
    expect(labelTexts(worldOf(scene), 'edge')).toEqual([])
    expect(host.querySelectorAll('.lw-edge')).toHaveLength(0)
    // the scene's top level holds what it held after the first draw (no stray groups or grids)
    expect(scene.children.length).toBe(withWorld)
    r.draw({ districts: [], buildings: [], conduits: [], orbs: [] }, emptyText(), false)
    frames.step()
    // nothing of the city is left: only the ten (hidden) pulse balls and the selection ring
    expect(meshesWith(worldOf(scene), 'nodeId')).toHaveLength(0)
    expect(worldOf(scene).children.filter((c) => c.visible)).toHaveLength(0)
    expect(worldOf(scene).children).toHaveLength(11)
    expect(scene.children.length).toBeGreaterThanOrEqual(baseline)
    r.dispose()
  })

  it('batching stays within batchCapacity, and a 600-file model uses the same few draw groups', () => {
    const big = (floors: number): SceneModel => {
      const buildings = Array.from({ length: 60 }, (_, i) => bldg(`b${i}`, [(i % 10) * 12 - 54, 0, Math.floor(i / 10) * 12 - 30], { floors, height: floors * 3 }))
      const conduits = Array.from({ length: 40 }, (_, i) => conduit(`e${i}`, [buildings[i].pos[0], floors * 3, buildings[i].pos[2]], [buildings[i + 1].pos[0], floors * 3, buildings[i + 1].pos[2]]))
      return { districts: [district('d', [0, 0, 0], 80)], buildings, conduits, orbs: [orb('o', [90, 0, 0])] }
    }
    const run = (floors: number): { calls: number; batches: THREE.InstancedMesh[] } => {
      const r = createThreeRenderer(host, DEFAULT_OPTS)
      boxCanvas(r.canvas, 800, 600)
      r.draw(big(floors), emptyText(), false)
      r.setFocus({ ids: new Set(['b0']), edgeIds: new Set() }) // holds the buildings tier
      frames.run(2)
      const scene = sceneOf()
      const batches: THREE.InstancedMesh[] = []
      scene.traverse((o) => { if (o instanceof THREE.InstancedMesh && o.userData.batchRank !== undefined) batches.push(o) })
      const calls = r.drawnCounts().drawCalls
      r.dispose()
      return { calls, batches }
    }
    const tenFloors = run(10) // 600 floors: a 600-file model
    for (const im of tenFloors.batches) {
      expect(im.count).toBeLessThanOrEqual(im.instanceMatrix.count)
      expect(im.instanceMatrix.count).toBe(batchCapacity(im.count, 0))
    }
    expect(tenFloors.calls).toBeLessThan(150)
    expect(tenFloors.calls).toBeGreaterThanOrEqual(40)
    const twoFloors = run(2)
    expect(twoFloors.batches.length).toBe(tenFloors.batches.length)
  })

  it('a device pixel ratio the window does not give (0) counts as 1', () => {
    vi.stubGlobal('devicePixelRatio', 0)
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    expect(rendererOf().pixelRatios).toEqual([1])
    r.dispose()
  })

  it("a box batch's material draws its outline in the shader: three's own chunks are found and replaced", () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    r.setFocus({ ids: new Set(['a']), edgeIds: new Set() }) // holds the buildings tier: block batches
    frames.run(2)
    const batches = boxBatches(sceneOf())
    expect(batches.length).toBeGreaterThan(0)
    for (const im of batches) {
      const m = im.material as THREE.MeshStandardMaterial
      expect(m.customProgramCacheKey()).toBe('lw-box-batch')
      const sh = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader }
      m.onBeforeCompile(sh as unknown as THREE.WebGLProgramParametersWithUniforms, rendererOf() as unknown as THREE.WebGLRenderer)
      expect(typeof sh.uniforms.lineOpacity.value).toBe('number')
      expect(sh.vertexShader).toContain('attribute vec3 lineColor;')
      expect(sh.vertexShader).toContain('vLineColor = lineColor;')
      expect(sh.fragmentShader).toContain('uniform float lineOpacity;')
      expect(sh.fragmentShader).not.toContain('#include <color_fragment>')
      expect(sh.fragmentShader).toContain('totalEmissiveRadiance *= vColor;') // the glow tinted per instance, after three's emissive map
      expect(sh.fragmentShader).toContain('outgoingLight = mix( outgoingLight, vLineColor, edge );')
      expect(sh.fragmentShader.split('#include <opaque_fragment>')).toHaveLength(2) // kept once, after the outline
    }
    r.dispose()
  })

  it('a batch outgrown by a redraw is replaced by a bigger one and freed', () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    r.setFocus({ ids: new Set(['a']), edgeIds: new Set() })
    frames.run(2)
    const before = boxBatches(sceneOf())
    expect(before.every((im) => im.instanceMatrix.count === 16)).toBe(true)
    const freed: THREE.InstancedMesh[] = []
    for (const im of before) im.addEventListener('dispose', () => freed.push(im))
    const many = smallCity()
    many.buildings = [...many.buildings, ...Array.from({ length: 40 }, (_, i) => bldg(`n${i}`, [(i % 8) * 6 - 21, 0, Math.floor(i / 8) * 6 - 30]))]
    r.draw(many, smallText(), false)
    r.setFocus({ ids: new Set(['a']), edgeIds: new Set() })
    frames.run(2)
    const after = boxBatches(sceneOf())
    const grown = after.filter((im) => im.instanceMatrix.count > 16)
    expect(grown.length).toBeGreaterThan(0)
    for (const im of grown) expect(im.instanceMatrix.count).toBe(batchCapacity(im.count, 16))
    expect(freed.length).toBeGreaterThan(0)
    for (const im of freed) expect(after).not.toContain(im)
    r.dispose()
  })
})

