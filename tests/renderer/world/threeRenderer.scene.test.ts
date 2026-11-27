// threeRenderer: building the scene (counts, positions, batching, rebuilds without leaks).
// The GPU boundary is faked (threeHarness.ts); the scene graph, geometries and materials are real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { createThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
import type { SceneModel } from '../../../src/renderer/src/world/engine/sceneModel'
import { batchCapacity, PLATFORM_ORDER } from '../../../src/renderer/src/world/engine/batching'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { DISC_MIN_RADIUS, DISC_SCALE, holoMarks, layoutExtent, TRACK_SEGMENTS } from '../../../src/renderer/src/world/engine/holoMarks'
import { memberGain, PALETTES, plateColor } from '../../../src/renderer/src/world/engine/holoPalette'
import { DISC_GAIN, DISC_Y, GRADE_FRAG, linearRgb, LOOK_CODE, PLATE_FOCUS, PLATE_FOOT, PLATE_FRAG, SLAB_FRAG, SLAB_GAIN, SLAB_STATE, SLAB_VERT, TRACK_Y } from '../../../src/renderer/src/world/engine/holoShaders'
import { THEMES } from '../../../src/renderer/src/world/engine/themes'
import { atRatio, bldg, boxBatches, boxCanvas, conduit, DEFAULT_OPTS, district, emptyText, gpu, installFrames, makeHost, orb, rendererOf, sceneOf, smallCity, smallText, stageOf, stagePart, withData, type Frames } from './threeHarness'

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
    expect(gl.toneMappingExposure).toBe(0.95) // look spec §3.3: the white-out budget
    expect(gl.info.autoReset).toBe(false)
    expect(gl.transparentSort).toBeTypeOf('function')
    expect(host.contains(r.canvas)).toBe(true)
    expect(host.querySelector('.lw-labels')).not.toBeNull()
    const [composer] = gpu.composers
    expect(composer.passes.slice(0, 3)).toEqual([gpu.renderPasses[0], gpu.bloomPasses[0], gpu.outputPasses[0]])
    expect(composer.passes).toHaveLength(4)
    expect(composer.passes[3]).toBeInstanceOf(ShaderPass) // the grade, last: on the finished picture, as the spike's
    const bloom = gpu.bloomPasses[0]
    expect([bloom.resolution.x, bloom.resolution.y, bloom.strength, bloom.radius, bloom.threshold]).toEqual([800, 600, 0.6, 0.5, 0.3])
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

  it("a box batch draws through the hologram slab shader, its outline in the shader from each instance's edge colour", () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    r.setFocus({ ids: new Set(['a']), edgeIds: new Set() }) // holds the buildings tier: block batches
    frames.run(2)
    const batches = boxBatches(sceneOf())
    expect(batches.length).toBeGreaterThan(0)
    for (const im of batches) {
      const m = im.material as THREE.ShaderMaterial
      expect([m.customProgramCacheKey(), m.vertexShader, m.fragmentShader]).toEqual(['lw-slab-box', SLAB_VERT, SLAB_FRAG])
      expect(SLAB_VERT).toContain('attribute vec3 lineColor;')
      expect(SLAB_VERT).toContain('vLine = lineColor;')
      expect(im.geometry.attributes.lineColor.itemSize).toBe(3)
      // Additive light, writing no depth: a floor behind another shows through it.
      expect([m.blending, m.depthWrite]).toEqual([THREE.AdditiveBlending, false])
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

describe('threeRenderer Holotable stage', () => {
  /** The disc's uniform values. */
  const discU = (scene: THREE.Scene): Record<string, { value: unknown }> => (stagePart(scene, 'disc')!.material as THREE.ShaderMaterial).uniforms
  /** How many shafts the shafts' mesh draws (each open cylinder of 96 sides is 576 indices), 0 when hidden. */
  const shaftsDrawn = (scene: THREE.Scene): number => {
    const m = stagePart(scene, 'shafts')
    return m && m.visible ? m.geometry.drawRange.count / 576 : 0
  }
  /** The stage parts drawn (each one draw call). */
  const stageDraws = (scene: THREE.Scene): string[] => stageOf(scene).children.filter((c) => c.visible).map((c) => c.userData.stage as string)

  it('the disc radius follows the layout extent', () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    const scene = sceneOf()
    expect(stageOf(scene).children).toEqual([]) // no world, no table
    const m: SceneModel = { districts: [district('a', [0, 0, 0], 20), district('b', [40, 0, 0], 10)], buildings: [], conduits: [], orbs: [] }
    r.draw(m, emptyText(), false)
    frames.step()
    // The box round the plates runs -20..50 across and -20..20 down: centre (15, 0), each plate's edge 35 from it.
    expect(layoutExtent(m)).toMatchObject({ center: [15, 0], reach: 35 })
    const disc = stagePart(scene, 'disc')!
    const R = 35 * DISC_SCALE
    expect(discU(scene).uR.value).toBeCloseTo(R, 10)
    expect(disc.position.toArray()).toEqual([15, DISC_Y, 0])
    expect((disc.geometry as THREE.PlaneGeometry).parameters).toMatchObject({ width: R * 2.3, height: R * 2.3 })
    expect(disc.geometry.getAttribute('position').getY(0)).toBeCloseTo(0, 10) // laid flat on the table
    expect(disc.renderOrder).toBeLessThan(0) // drawn first, under the plates (BACKDROP_ORDER)
    const mat = disc.material as THREE.ShaderMaterial
    expect([mat.transparent, mat.depthWrite, mat.blending, mat.extensions.derivatives]).toEqual([true, false, THREE.AdditiveBlending, true])
    // The marks' own disc, in the Holotable palette.
    const mark = holoMarks(m, PALETTES.holotable).stage.find((s) => s.kind === 'disc')
    expect(mark).toMatchObject({ radius: R, center: [15, 0] })
    expect(discU(scene).uCyan.value).toEqual(linearRgb(PALETTES.holotable.holo))
    expect(discU(scene).uAmber.value).toEqual(linearRgb(PALETTES.holotable.attention))
    expect(discU(scene).uGain.value).toBe(DISC_GAIN.bloomed)
    // A world twice as wide: a disc twice the size, and the old one freed.
    const freed: string[] = []
    disc.geometry.addEventListener('dispose', () => { freed.push('geo') })
    mat.addEventListener('dispose', () => { freed.push('mat') })
    r.draw({ ...m, districts: [district('a', [0, 0, 0], 40), district('b', [80, 0, 0], 20)] }, emptyText(), false)
    expect(freed).toEqual(['geo', 'mat'])
    expect(discU(scene).uR.value).toBeCloseTo(70 * DISC_SCALE, 10)
    expect(stagePart(scene, 'disc')!.position.x).toBe(30)
    // A world without plates still stands on the smallest table; another palette colours it.
    r.setTheme('blueprint', THEMES.blueprint)
    r.draw({ districts: [], buildings: [], conduits: [], orbs: [] }, emptyText(), false)
    expect(discU(scene).uR.value).toBe(DISC_MIN_RADIUS)
    expect(discU(scene).uCyan.value).toEqual(linearRgb(PALETTES.blueprint.holo))
    expect(stagePart(scene, 'disc')!.position.toArray()).toEqual([0, DISC_Y, 0])
    // Dispose frees the stage with the rest.
    const last = stagePart(scene, 'disc')!
    let gone = 0
    last.geometry.addEventListener('dispose', () => { gone++ })
    r.dispose()
    expect(gone).toBe(1)
  })

  it('no track without orbs; the track sits at the orb ring radius', () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    const scene = sceneOf()
    r.draw({ ...smallCity(), orbs: [] }, smallText(), false)
    expect(stagePart(scene, 'track')).toBeUndefined()
    // smallCity's one orb stands at (30, 40): 50 from the origin the compiler rings the orbs round.
    r.draw(smallCity(), smallText(), false)
    const track = stagePart(scene, 'track') as unknown as THREE.LineLoop
    expect(track).toBeInstanceOf(THREE.LineLoop)
    const pos = track.geometry.getAttribute('position')
    expect(pos.count).toBe(TRACK_SEGMENTS)
    for (let i = 0; i < pos.count; i += 37) {
      expect(Math.hypot(pos.getX(i), pos.getZ(i))).toBeCloseTo(50, 4)
      expect(pos.getY(i)).toBeCloseTo(TRACK_Y, 6)
    }
    const mat = track.material as THREE.LineBasicMaterial
    expect([mat.transparent, mat.depthWrite, mat.blending]).toEqual([true, false, THREE.AdditiveBlending])
    expect(mat.color.getHex()).toBe(new THREE.Color(PALETTES.holotable.holo).getHex())
    expect(track.renderOrder).toBeLessThan(0)
    // The farthest orb sets the ring.
    r.draw({ ...smallCity(), orbs: [orb('x', [30, 0, 40]), orb('y', [0, 0, -90])] }, smallText(), false)
    const far = (stagePart(scene, 'track') as unknown as THREE.LineLoop).geometry.getAttribute('position')
    expect(Math.hypot(far.getX(0), far.getZ(0))).toBeCloseTo(90, 4)
    r.dispose()
  })

  it('one beam per district rises from the disc to the underside of its plate', () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    const scene = sceneOf()
    r.draw(smallCity(), smallText(), false)
    const beams = stagePart(scene, 'beams')!
    const pos = beams.geometry.getAttribute('position')
    expect(pos.count).toBe(2 * 2 * 7) // two open hexagonal prisms (7 vertices round, top and bottom), merged into one draw
    const ys = new Set<number>()
    for (let i = 0; i < pos.count; i++) ys.add(Math.round(pos.getY(i) * 1e5) / 1e5)
    expect([...ys].sort((a, b) => a - b)).toEqual([DISC_Y, PLATE_FOOT])
    // The first prism stands on d1 at the origin inside its rim (radius 20), the second on d2 at (60, 0).
    expect(Math.hypot(pos.getX(0), pos.getZ(0))).toBeCloseTo(20 * 0.86, 4)
    expect(Math.hypot(pos.getX(14) - 60, pos.getZ(14))).toBeCloseTo(16 * 0.86, 4)
    const mat = beams.material as THREE.ShaderMaterial
    expect([mat.transparent, mat.depthWrite, mat.blending, mat.side]).toEqual([true, false, THREE.AdditiveBlending, THREE.DoubleSide])
    // No districts, no beams.
    r.draw({ districts: [], buildings: [], conduits: [], orbs: [orb('x', [5, 0, 5])] }, emptyText(), false)
    expect(stagePart(scene, 'beams')).toBeUndefined()
    r.dispose()
  })

  it('High draws 2 shafts and 1800 dust, Low 1 and 600, Flat none', () => {
    for (const tier of ['high', 'low', 'flat'] as const) {
      gpu.reset()
      const r = createThreeRenderer(host, { quality: tier, reducedMotion: false })
      r.draw(smallCity(), smallText(), false)
      frames.step()
      const scene = sceneOf() // the last frame's (Flat has no composer to read it from before one is drawn)
      const want = { high: [2, 1800], low: [1, 600], flat: [0, 0] }[tier]
      expect([shaftsDrawn(scene), r.motionState().dust], tier).toEqual(want)
      // The disc, the track, the beams and the shafts: one draw each; Flat draws the disc and the track only.
      expect(stageDraws(scene), tier).toEqual(tier === 'flat' ? ['disc', 'track'] : ['disc', 'track', 'beams', 'shafts'])
      r.dispose()
    }
    // The shafts stand on the disc: the wide one as wide as the disc, the narrow one at 62%, their strength per vertex.
    gpu.reset()
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    const scene = sceneOf()
    r.draw(smallCity(), smallText(), false)
    const shafts = stagePart(scene, 'shafts')!
    const R = discU(scene).uR.value as number
    expect(shafts.position.toArray()).toEqual(stagePart(scene, 'disc')!.position.toArray())
    const pos = shafts.geometry.getAttribute('position')
    const k = shafts.geometry.getAttribute('aK')
    expect(k.count).toBe(pos.count)
    expect(Math.hypot(pos.getX(0), pos.getZ(0))).toBeCloseTo(R, 4)
    expect(pos.getY(0)).toBeCloseTo(R * 0.55, 4) // the top ring first; the shaft stands on the disc (its foot at 0)
    expect(k.getX(0)).toBe(1)
    expect(k.getX(pos.count - 1)).toBeCloseTo(0.6, 6)
    expect(Math.hypot(pos.getX(pos.count - 1), pos.getZ(pos.count - 1))).toBeCloseTo(R * 0.62 * 1.02, 4) // the narrow one's foot
    expect(pos.getY(pos.count - 1)).toBeCloseTo(0, 6)
    const mat = shafts.material as THREE.ShaderMaterial
    expect([mat.transparent, mat.depthWrite, mat.blending, mat.side]).toEqual([true, false, THREE.AdditiveBlending, THREE.DoubleSide])
    // A tier change draws its share of the same shafts, and hides the beams at Flat, building nothing again.
    const built = shafts.geometry
    r.setTier('low')
    expect(shaftsDrawn(scene)).toBe(1)
    expect(discU(scene).uGain.value).toBe(DISC_GAIN.bloomed)
    r.setTier('flat')
    expect(stageDraws(scene)).toEqual(['disc', 'track'])
    expect(discU(scene).uGain.value).toBe(DISC_GAIN.flat) // brighter where no bloom adds its glow
    r.setTier('high')
    expect(shaftsDrawn(scene)).toBe(2)
    expect(stageDraws(scene)).toEqual(['disc', 'track', 'beams', 'shafts'])
    expect(stagePart(scene, 'shafts')!.geometry).toBe(built)
    r.dispose()
  })

  it('the grade pass has grain only at High', () => {
    const gradeAt = (i: number): ShaderPass => gpu.composers[i].passes[3] as unknown as ShaderPass
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    const grade = gradeAt(0)
    expect(grade.material.fragmentShader).toBe(GRADE_FRAG)
    expect([grade.uniforms.uVignette.value, grade.uniforms.uGrain.value]).toEqual([0.5, 0.03])
    r.setTier('low')
    expect(gradeAt(0)).toBe(grade) // the same pass
    expect([grade.uniforms.uVignette.value, grade.uniforms.uGrain.value]).toEqual([0.5, 0])
    let freed = 0
    grade.material.addEventListener('dispose', () => { freed++ })
    r.setTier('flat')
    expect(freed).toBe(1) // freed with the composer
    r.setTier('high')
    expect([gradeAt(1).uniforms.uVignette.value, gradeAt(1).uniforms.uGrain.value]).toEqual([0.5, 0.03])
    r.dispose()
    gpu.reset()
    const low = createThreeRenderer(host, { quality: 'low', reducedMotion: false })
    expect([gradeAt(0).uniforms.uVignette.value, gradeAt(0).uniforms.uGrain.value]).toEqual([0.5, 0])
    low.dispose()
  })

  it('the grain changes at most 2.5 times a second, and never under reduced motion', () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    r.draw(smallCity(), smallText(), false)
    const grade = gpu.composers[0].passes[3] as unknown as ShaderPass
    const seeds = new Set<number>()
    for (let i = 0; i < 125; i++) { frames.step(16); seeds.add(grade.uniforms.uSeed.value as number) } // 2 s
    expect(seeds.size).toBeGreaterThan(1)
    expect(seeds.size).toBeLessThanOrEqual(2 * 2.5 + 1)
    r.setReducedMotion(true)
    frames.step(16)
    expect(grade.uniforms.uSeed.value).toBe(0)
    r.dispose()
  })

  it('counts the shader programs that fail to link, in test mode only', () => {
    const plain = createThreeRenderer(host, DEFAULT_OPTS)
    expect(rendererOf().debug.onShaderError).toBeNull() // three's own report (console.error), untouched
    expect(plain.drawnCounts().shaderErrors).toBe(0)
    plain.dispose()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = createThreeRenderer(host, { ...DEFAULT_OPTS, countShaderErrors: true })
    const { debug } = rendererOf()
    expect(debug.checkShaderErrors).toBe(true)
    debug.onShaderError!({ getProgramInfoLog: () => 'ERROR: 0:12: undeclared identifier' }, {}, {}, {})
    debug.onShaderError!({ getProgramInfoLog: () => null }, {}, {}, {})
    expect(r.drawnCounts().shaderErrors).toBe(2)
    expect(err.mock.calls).toEqual([
      ['[world] a shader program did not link:', 'ERROR: 0:12: undeclared identifier'],
      ['[world] a shader program did not link:', null],
    ])
    r.dispose()
  })
})

describe('threeRenderer hologram slabs and plates', () => {
  const LOOKS = ['solid', 'wire', 'amber', 'fog', 'fading'] as const
  /** One district, a building of each look in it, and a second solid one. */
  const looks = (): SceneModel => ({
    districts: [district('d', [0, 0, 0], 40, { hue: 200, members: 6 })],
    buildings: [
      ...LOOKS.map((look, i) => bldg(look, [i * 10 - 20, 0, 0], { look, floors: 2, height: 6 })),
      bldg('solid2', [0, 0, 12], { floors: 3, height: 9 }),
    ],
    conduits: [],
    orbs: [],
  })
  const slabMat = (im: THREE.InstancedMesh): THREE.ShaderMaterial => im.material as THREE.ShaderMaterial
  const lookOf = (im: THREE.InstancedMesh): number => im.geometry.attributes.aLook.getX(0)
  const holdBuildings = (r: ReturnType<typeof createThreeRenderer>): void => {
    r.setFocus({ ids: new Set(LOOKS), edgeIds: new Set() }) // holds the buildings tier
    frames.run(2)
  }

  it('each Look maps to its own instance pool and draw call', () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(looks(), emptyText(), false)
    holdBuildings(r)
    const pools = boxBatches(sceneOf())
    expect(pools).toHaveLength(LOOKS.length)
    expect(pools.map(lookOf).sort()).toEqual(LOOKS.map((l) => LOOK_CODE[l]).sort())
    for (const im of pools) {
      const m = slabMat(im)
      expect(m).toBeInstanceOf(THREE.ShaderMaterial)
      expect([m.fragmentShader, m.customProgramCacheKey(), m.uniforms.uEdges.value]).toEqual([SLAB_FRAG, 'lw-slab-box', 1])
      // Every instance in a pool is of its look.
      for (let k = 0; k < im.count; k++) expect(im.geometry.attributes.aLook.getX(k)).toBe(lookOf(im))
    }
    // The two solid buildings share one pool (one draw call); the wire and the fading one, whose looks move, are batched too.
    const solid = pools.find((im) => lookOf(im) === LOOK_CODE.solid) as THREE.InstancedMesh
    expect(solid.count).toBe(2)
    for (const id of LOOKS) for (const p of withData(worldOf(sceneOf()), 'nodeId').filter((m) => m.userData.nodeId === id)) expect(p.visible).toBe(false)
    // The pools share one look: the tier's gain reaches them all, and a tier change moves it.
    for (const im of pools) expect(slabMat(im).uniforms.uGain.value).toBe(SLAB_GAIN.bloomed)
    r.setTier('flat')
    for (const im of pools) expect(slabMat(im).uniforms.uGain.value).toBe(SLAB_GAIN.flat)
    r.dispose()
  })

  it('a slab carries its state, its stack, its heat and its edge colour per instance', () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    const m = looks()
    m.buildings[0].heat = 1
    r.draw(m, emptyText(), false)
    atRatio(r, frames, 0.2) // the floors tier: a floor per instance
    const solid = (): THREE.InstancedMesh => boxBatches(sceneOf()).find((im) => lookOf(im) === LOOK_CODE.solid) as THREE.InstancedMesh
    const column = (name: string): number[] => Array.from({ length: solid().count }, (_, k) => solid().geometry.attributes[name].getX(k))
    expect(solid().count).toBe(5) // 2 + 3 floors
    // The floors above each floor along its tower: 1, 0 for the two-floor one; 2, 1, 0 for the three.
    expect(column('aStack').sort()).toEqual([0, 0, 1, 1, 2])
    expect(column('aState').every((s) => s === SLAB_STATE.rest)).toBe(true)
    expect(column('aHeat').filter((v) => v > 0)).toHaveLength(2) // the hot building's two floors
    // The amber look's edges are amber.
    const amber = boxBatches(sceneOf()).find((im) => lookOf(im) === LOOK_CODE.amber) as THREE.InstancedMesh
    const lc = amber.geometry.attributes.lineColor
    const want = new THREE.Color(PALETTES.holotable.attention)
    expect([lc.getX(0), lc.getY(0), lc.getZ(0)].map((v) => +v.toFixed(4))).toEqual([want.r, want.g, want.b].map((v) => +Math.fround(v).toFixed(4)))
    // Selected, hovered, related (in the focus), dimmed (out of it).
    r.setFocus({ ids: new Set(['solid', 'solid2']), edgeIds: new Set() })
    r.setSelected('solid')
    frames.step()
    expect(column('aState').sort()).toEqual([SLAB_STATE.related, SLAB_STATE.related, SLAB_STATE.related, SLAB_STATE.selected, SLAB_STATE.selected])
    r.setHovered('solid2')
    frames.step()
    expect(column('aState').sort()).toEqual([SLAB_STATE.hovered, SLAB_STATE.hovered, SLAB_STATE.hovered, SLAB_STATE.selected, SLAB_STATE.selected])
    const wire = boxBatches(sceneOf()).find((im) => lookOf(im) === LOOK_CODE.wire) as THREE.InstancedMesh
    expect(wire.geometry.attributes.aState.getX(0)).toBe(SLAB_STATE.dimmed)
    // The selection alone moving (the focus as it was) moves the states too.
    r.setHovered(null)
    frames.step()
    r.setSelected('solid2')
    frames.step()
    expect(column('aState').sort()).toEqual([SLAB_STATE.related, SLAB_STATE.related, SLAB_STATE.selected, SLAB_STATE.selected, SLAB_STATE.selected])
    r.dispose()
  })

  it('the scan lines move with time at High and Low, stand still at Flat and under reduced motion; the wire and the fading pulse', () => {
    const run = (opts: typeof DEFAULT_OPTS): THREE.ShaderMaterial => {
      const r = createThreeRenderer(host, opts)
      boxCanvas(r.canvas, 800, 600)
      r.draw(looks(), emptyText(), false)
      holdBuildings(r)
      frames.run(3, 200)
      // At Flat there is no render pass: its scene is the renderer's last render (sceneOf would find the earlier run's pass).
      const gl = rendererOf()
      const m = slabMat(boxBatches(opts.quality === 'flat' ? gl.renders[gl.renders.length - 1].scene as THREE.Scene : sceneOf())[0])
      r.dispose()
      return m
    }
    const high = run(DEFAULT_OPTS)
    expect(high.uniforms.uTime.value).toBeGreaterThan(0)
    expect(high.uniforms.uWire.value).toBeGreaterThan(0.1)
    expect(high.uniforms.uWire.value).toBeLessThanOrEqual(1)
    expect(high.uniforms.uFade.value).toBeGreaterThan(0)
    expect(high.uniforms.uFade.value).toBeLessThanOrEqual(1)
    expect(run({ ...DEFAULT_OPTS, quality: 'flat' }).uniforms.uTime.value).toBe(0)
    const still = run({ ...DEFAULT_OPTS, reducedMotion: true })
    expect(still.uniforms.uTime.value).toBe(0)
    expect(still.uniforms.uFade.value).toBeCloseTo(0.3 / 0.45, 6) // the fading look's rest (FADE_MID) over its peak
  })

  it('hex plates replace the platforms: one instanced plate per district, six sides each, its lamp kept', () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    frames.step()
    const world = worldOf(sceneOf())
    const plates = meshesWith(world, 'plateIds') as THREE.InstancedMesh[]
    expect(plates).toHaveLength(1)
    const p = plates[0]
    expect(p.userData.plateIds).toEqual(['d1', 'd2'])
    expect(p.count).toBe(2)
    expect([(p.material as THREE.ShaderMaterial).fragmentShader, p.renderOrder]).toEqual([PLATE_FRAG, PLATFORM_ORDER])
    // No platform cylinder is left, and no rim of one.
    const cylinders: THREE.Object3D[] = []
    world.traverse((o) => { if ((o as THREE.Mesh).geometry instanceof THREE.CylinderGeometry && !(o instanceof THREE.InstancedMesh)) cylinders.push(o) })
    expect(cylinders).toHaveLength(0)
    expect(r.motionState().platformSides).toEqual({ d1: 6, d2: 6 })
    expect(r.motionState().platformLights).toBe(2)
    // Coloured as the stage's plate marks are: the district's plate colour by its member gain.
    const c = new THREE.Color()
    p.getColorAt(0, c)
    const want = new THREE.Color(plateColor(200)).multiplyScalar(memberGain(1))
    expect(c.g).toBeCloseTo(want.g, 5)
    r.dispose()
  })

  it('a plate lights with its selected building, eases there by time, and carries the slab signals at the districts tier', () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    const city = smallCity()
    city.buildings[2].look = 'fog'
    city.buildings[0].outline = true
    r.draw(city, smallText(), false)
    frames.step()
    const p = meshesWith(worldOf(sceneOf()), 'plateIds')[0] as THREE.InstancedMesh
    const at = p.geometry.attributes
    const pm = p.material as THREE.ShaderMaterial
    expect([at.aLook.getX(1), at.aOutline.getX(0), at.aOutline.getX(1)]).toEqual([LOOK_CODE.fog, 1, 0])
    r.setFocus({ ids: new Set(['a', 'b']), edgeIds: new Set() }) // the selection's focus: d2's part is out of it
    r.setSelected('a')
    frames.step(16)
    const early = at.aFocus.getX(0)
    expect(early).toBeGreaterThan(0)
    expect(early).toBeLessThan(PLATE_FOCUS.selected)
    expect(at.aWave.getX(0)).toBeGreaterThan(0) // a newly selected plate's wave
    frames.run(120)
    expect(at.aFocus.getX(0)).toBeCloseTo(PLATE_FOCUS.selected, 5)
    expect(at.aFocus.getX(1)).toBeCloseTo(PLATE_FOCUS.dimmed, 5) // in no focus of the selection
    // A hovered part lights its plate, out of the focus or not; let go, the plate dims again.
    r.setHovered('c')
    frames.run(120)
    expect(at.aFocus.getX(1)).toBeCloseTo(PLATE_FOCUS.lit, 5)
    r.setHovered(null)
    frames.run(120)
    expect(at.aFocus.getX(1)).toBeCloseTo(PLATE_FOCUS.dimmed, 5)
    r.setFocus(null)
    r.setSelected(null)
    frames.run(120)
    expect(at.aFocus.getX(0)).toBeCloseTo(PLATE_FOCUS.rest, 5)
    // The signals show on the plate only from far away.
    atRatio(r, frames, 0.2)
    expect(pm.uniforms.uFar.value).toBe(0)
    atRatio(r, frames, 3)
    expect(r.drawnCounts().tier).toBe('districts')
    expect(pm.uniforms.uFar.value).toBe(1)
    // The districts' slabs draw through the slab shader too, without box edges (theirs are lines).
    const slabs = worldOf(sceneOf()).children.filter((c) => Array.isArray(c.userData.slabIds)) as THREE.InstancedMesh[]
    for (const s of slabs) {
      expect((s.material as THREE.ShaderMaterial).customProgramCacheKey()).toBe('lw-slab-hex')
      expect((s.material as THREE.ShaderMaterial).uniforms.uEdges.value).toBe(0)
    }
    r.dispose()
  })

  it('a change rising in a district sends a wave across its plate; an empty city builds no plate', () => {
    const r = createThreeRenderer(host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    frames.step()
    const p = meshesWith(worldOf(sceneOf()), 'plateIds')[0] as THREE.InstancedMesh
    r.animateChanges({ rise: ['c'], pulse: [] })
    frames.step()
    expect(p.geometry.attributes.aWave.getX(1)).toBeGreaterThan(0)
    expect(p.geometry.attributes.aWave.getX(0)).toBe(0)
    r.draw({ districts: [], buildings: [], conduits: [], orbs: [] }, emptyText(), false)
    frames.step()
    expect(meshesWith(worldOf(sceneOf()), 'plateIds')).toHaveLength(0)
    r.dispose()
  })
})
