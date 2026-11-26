// threeRenderer: each theme's palette reaching the materials, and what each zoom tier draws (semantic zoom).
// The GPU boundary is faked (threeHarness.ts); the scene graph, geometries and materials are real.
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { createThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
import { TIER_LOOK } from '../../../src/renderer/src/world/engine/tierBudget'
import { THEMES, type ThemeName } from '../../../src/renderer/src/world/engine/themes'
import { heatMix, type SceneModel } from '../../../src/renderer/src/world/engine/sceneModel'
import {
  atRatio, batchedBoxes, bldg, boxBatches, boxCanvas, conduit, DEFAULT_OPTS, district, emptyText, floorsOf, gpu, orb,
  packetBatches, sceneOf, smallCity, smallText, withHarness, withData, worldOf,
} from './threeHarness'

vi.mock('three', async (orig) => ({ ...(await orig<typeof import('three')>()), WebGLRenderer: (await import('./threeHarness')).FakeWebGLRenderer }))
vi.mock('three/examples/jsm/postprocessing/EffectComposer.js', async () => ({ EffectComposer: (await import('./threeHarness')).FakeEffectComposer }))
vi.mock('three/examples/jsm/postprocessing/RenderPass.js', async () => ({ RenderPass: (await import('./threeHarness')).FakeRenderPass }))
vi.mock('three/examples/jsm/postprocessing/UnrealBloomPass.js', async () => ({ UnrealBloomPass: (await import('./threeHarness')).FakeUnrealBloomPass }))
vi.mock('three/examples/jsm/postprocessing/OutputPass.js', async () => ({ OutputPass: (await import('./threeHarness')).FakeOutputPass }))

const h = withHarness()

/** The palette threeRenderer's EXTRAS lists per theme (prototype values), checked against the materials. */
const PALETTE: Record<ThemeName, { fill: number; fillOpacity: number; fillGlow: number; platformOpacity: number; ghost: number; seal: number; amber: number; grid: number; gridOpacity: number; bloom: number; fogTint: number }> = {
  neon: { fill: 0x0b1220, fillOpacity: 0.88, fillGlow: 0.16, platformOpacity: 0.92, ghost: 0x93c5fd, seal: 0x4ade80, amber: 0xfbbf24, grid: 0x1e3a5f, gridOpacity: 0.35, bloom: 1.05, fogTint: 0xcbd5e1 },
  blueprint: { fill: 0x0b2a4a, fillOpacity: 0.22, fillGlow: 0.06, platformOpacity: 0.45, ghost: 0xbfdbfe, seal: 0x99f6e4, amber: 0xfde68a, grid: 0x60a5fa, gridOpacity: 0.35, bloom: 0.75, fogTint: 0xe0f2fe },
  glass: { fill: 0xcbd5e1, fillOpacity: 0.32, fillGlow: 0.28, platformOpacity: 0.8, ghost: 0xbfdbfe, seal: 0x6ee7b7, amber: 0xfcd34d, grid: 0x374151, gridOpacity: 0.4, bloom: 0.5, fogTint: 0xf1f5f9 },
}

/** One building of every look, a hot one, a changed one, and a fogged external. */
function looks(): SceneModel {
  return {
    districts: [district('d', [0, 0, 0], 40, { hue: 120 })],
    buildings: [
      bldg('solid', [-15, 0, 0], { ring: true }),
      bldg('wire', [-5, 0, 0], { look: 'wire' }),
      bldg('amber', [5, 0, 0], { look: 'amber' }),
      bldg('fog', [15, 0, 0], { look: 'fog' }),
      bldg('fading', [0, 0, 12], { look: 'fading' }),
      bldg('hot', [0, 0, -12], { heat: 1, outline: true }),
      bldg('lone', [200, 0, 0], { floors: 1, height: 3 }), // on no platform: the theme's glow
    ],
    conduits: [conduit('l', [-15, 9, 0], [5, 9, 0]), conduit('g', [5, 9, 0], [90, 2.2, 0], { dashed: true })],
    orbs: [orb('ext', [90, 0, 0], true)],
  }
}

const fillOf = (root: THREE.Object3D, id: string): THREE.MeshStandardMaterial => floorsOf(root, id)[0].material as THREE.MeshStandardMaterial
const seamOf = (root: THREE.Object3D, id: string): THREE.LineBasicMaterial =>
  ((floorsOf(root, id)[0].parent as THREE.Group).children[1] as THREE.LineSegments).material as THREE.LineBasicMaterial

describe('threeRenderer themes', () => {
  for (const name of ['neon', 'blueprint', 'glass'] as const) {
    it(`${name}: the palette reaches the fills, platforms, outlines, rings, grid, fog and bloom`, () => {
      const p = PALETTE[name]
      const th = THEMES[name]
      const r = createThreeRenderer(h.host, DEFAULT_OPTS)
      r.setTheme(name, th) // before a world: only the backdrop changes
      const scene = sceneOf()
      expect((scene.background as THREE.Color).getHex()).toBe(new THREE.Color(th.background).getHex())
      expect((scene.fog as THREE.FogExp2).color.getHex()).toBe(new THREE.Color(th.background).getHex())
      r.draw(looks(), emptyText(), false)
      const world = worldOf(scene)
      const solid = fillOf(world, 'solid')
      expect(solid.color.getHex()).toBe(p.fill)
      expect(solid.opacity).toBeCloseTo(p.fillOpacity)
      expect(solid.emissiveIntensity).toBeCloseTo(p.fillGlow)
      expect(solid.emissive.getHex()).toBe(new THREE.Color().setHSL(120 / 360, 0.75, 0.62).getHex())
      expect(seamOf(world, 'solid').color.getHex()).toBe(solid.emissive.getHex())
      // a building on no platform glows in the theme's colour
      expect(fillOf(world, 'lone').emissive.getHex()).toBe(new THREE.Color(th.glow).getHex())
      // a hot building: brighter, toward the heat colour
      expect(fillOf(world, 'hot').emissiveIntensity).toBeCloseTo(p.fillGlow * heatMix(1).glow)
      // the wireframe: a ghost outline, a nearly clear box that writes no depth
      expect(seamOf(world, 'wire').color.getHex()).toBe(p.ghost)
      expect(fillOf(world, 'wire').opacity).toBeCloseTo(0.07)
      expect(fillOf(world, 'wire').emissiveIntensity).toBeCloseTo(0.05)
      expect(fillOf(world, 'wire').depthWrite).toBe(false)
      expect(seamOf(world, 'amber').color.getHex()).toBe(p.amber)
      // a guessed-at building: thinner, its outline washed toward the fog tint
      expect(fillOf(world, 'fog').opacity).toBeCloseTo(p.fillOpacity * 0.6)
      const washed = new THREE.Color().setHSL(120 / 360, 0.75, 0.62).lerp(new THREE.Color(p.fogTint), 0.4)
      expect(seamOf(world, 'fog').color.getHex()).toBe(washed.getHex())
      expect(fillOf(world, 'fading').depthWrite).toBe(false)
      // the verified ring, the platform, the changed shell
      const ring = world.getObjectsByProperty('type', 'Mesh')
        .find((m) => (m as THREE.Mesh).geometry instanceof THREE.TorusGeometry && (m as THREE.Mesh).geometry.parameters.radius === 1.1) as THREE.Mesh
      expect((ring.material as THREE.MeshBasicMaterial).color.getHex()).toBe(p.seal)
      const plat = world.getObjectsByProperty('type', 'Mesh').find((m) => (m as THREE.Mesh).geometry instanceof THREE.CylinderGeometry && (m as THREE.Mesh).geometry.parameters.radiusTop === 40) as THREE.Mesh
      expect((plat.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(p.platformOpacity)
      expect((plat.material as THREE.MeshStandardMaterial).color.getHex()).toBe(new THREE.Color(th.district).getHex())
      // the dashed line in the ghost colour; the fogged external in the fog tint
      const dashed = world.getObjectsByProperty('type', 'Line').find((l) => (l as THREE.Line).material instanceof THREE.LineDashedMaterial) as THREE.Line
      expect((dashed.material as THREE.LineDashedMaterial).color.getHex()).toBe(p.ghost)
      const ext = withData(world, 'nodeId').find((m) => m.userData.nodeId === 'ext') as THREE.Mesh
      expect((ext.material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(p.fogTint)
      // the grid, and the bloom (a small city glows at full strength)
      const grid = scene.children.find((c) => c instanceof THREE.GridHelper) as THREE.GridHelper
      const gc = grid.geometry.getAttribute('color')
      expect(new THREE.Color(gc.getX(0), gc.getY(0), gc.getZ(0)).getHex()).toBe(p.grid)
      expect((grid.material as THREE.Material).opacity).toBe(p.gridOpacity)
      expect(gpu.bloomPasses[0].strength).toBeCloseTo(p.bloom)
      r.dispose()
    })
  }

  it('a theme change on a drawn world draws it again in the new palette; a busy city glows less', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    const many: SceneModel = { ...smallCity(), conduits: Array.from({ length: 400 }, (_, i) => conduit(`m${i}`, [-6, 9, 0], [6, 6, 4 + i * 0.01])) }
    r.draw(many, smallText(), false)
    const neonStrength = gpu.bloomPasses[0].strength
    expect(neonStrength).toBeLessThan(PALETTE.neon.bloom)
    expect(neonStrength).toBeCloseTo(PALETTE.neon.bloom * 0.5)
    r.setTheme('glass', THEMES.glass)
    const world = worldOf(sceneOf())
    expect(fillOf(world, 'a').color.getHex()).toBe(PALETTE.glass.fill)
    expect(r.drawnCounts().conduits).toBe(400)
    r.dispose()
  })
})

describe('threeRenderer level of detail', () => {
  it('districts: slabs stand for the buildings; buildings: one block each; floors: every floor', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    h.frames.step()
    const scene = sceneOf()
    const world = worldOf(scene)
    const groupOf = (id: string): THREE.Object3D => floorsOf(world, id)[0].parent!.parent!
    // At the overview: the districts tier
    expect(r.drawnCounts().tier).toBe('districts')
    expect(groupOf('a').visible).toBe(false)
    expect(r.drawnCounts().slabs).toBe(2)
    expect(r.drawnCounts().slabLooks.map((s) => s.id)).toEqual(['d1', 'd2'])
    expect(batchedBoxes(scene)).toBe(0)
    // the external stays, and the lines run slab top to slab top
    const ext = withData(world, 'nodeId').find((m) => m.userData.nodeId === 'x')!
    expect(ext.parent!.visible).toBe(true)
    // Nearer: the buildings tier, a block per building
    atRatio(r, h.frames, 0.5)
    expect(r.drawnCounts().tier).toBe('buildings')
    expect(groupOf('a').visible).toBe(true)
    expect(r.drawnCounts().slabs).toBe(0)
    expect(r.drawnCounts().slabLooks).toEqual([])
    expect(batchedBoxes(scene)).toBe(3)
    for (const fl of floorsOf(world, 'a')) expect(fl.visible).toBe(false) // drawn by the batch
    expect(packetBatches(scene).reduce((n, im) => n + (im as THREE.InstancedMesh).count, 0)).toBe(5)
    // Nearer still: every floor
    atRatio(r, h.frames, 0.2)
    expect(r.drawnCounts().tier).toBe('floors')
    expect(batchedBoxes(scene)).toBe(6)
    // An open building draws its own floors (they move): out of the batches
    r.setExploded('a')
    h.frames.step()
    expect(batchedBoxes(scene)).toBe(3)
    for (const fl of floorsOf(world, 'a')) expect(fl.visible).toBe(true)
    for (const b of boxBatches(scene)) expect((b as THREE.InstancedMesh).count).toBeLessThanOrEqual((b as THREE.InstancedMesh).instanceMatrix.count)
    r.dispose()
  })

  it('a slab takes the look of its buildings: fogged, fading, and a changed part outlined', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    const m: SceneModel = {
      districts: [district('f', [0, 0, 0], 15), district('g', [50, 0, 0], 15), district('s', [100, 0, 0], 15)],
      buildings: [
        bldg('f1', [0, 0, 0], { look: 'fog' }),
        bldg('g1', [50, 0, 0], { look: 'fading' }),
        bldg('s1', [100, 0, 0], { outline: true, heat: 0.5 }),
      ],
      conduits: [],
      orbs: [],
    }
    r.draw(m, emptyText(), false)
    h.frames.step()
    const looksNow = r.drawnCounts().slabLooks
    expect(looksNow.map((s) => [s.id, s.fog, s.fading, s.outline, s.hot])).toEqual([
      ['f', true, false, false, false], ['g', false, true, false, false], ['s', false, false, true, true],
    ])
    const world = worldOf(sceneOf())
    const slabs = world.children.filter((c) => Array.isArray(c.userData.slabIds)) as THREE.InstancedMesh[]
    expect(slabs.map((s) => s.userData.slabIds)).toEqual([['f'], ['g'], ['s']])
    const fogSlab = slabs[0].material as THREE.MeshStandardMaterial
    expect(fogSlab.opacity).toBeCloseTo(PALETTE.neon.fillOpacity * 0.6)
    expect((slabs[1].material as THREE.MeshStandardMaterial).depthWrite).toBe(false)
    expect(fogSlab.customProgramCacheKey()).toBe('lw-slab')
    // Every slab's fill steps back in depth, so its outline and seams (on its faces) never z-fight with it (T12).
    for (const s of slabs) {
      const sm = s.material as THREE.MeshStandardMaterial
      expect([sm.polygonOffset, sm.polygonOffsetFactor, sm.polygonOffsetUnits]).toEqual([true, 1, 1])
    }
    for (const l of world.children.filter((c) => c instanceof THREE.LineSegments) as THREE.LineSegments[]) {
      expect((l.material as THREE.LineBasicMaterial).polygonOffset).toBe(false) // the lines keep their true depth
    }
    const sh = { uniforms: {}, vertexShader: '', fragmentShader: '#include <common>\n#include <color_fragment>\n#include <emissivemap_fragment>' }
    fogSlab.onBeforeCompile(sh as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer)
    expect(sh.fragmentShader).not.toContain('#include <color_fragment>')
    expect(sh.fragmentShader).toContain('totalEmissiveRadiance *= vColor')
    // the outlines: one per look, and the ghost shell round the changed district
    const lines = world.children.filter((c) => c instanceof THREE.LineSegments && c.visible && !c.parent!.userData.nodeId) as THREE.LineSegments[]
    const shell = lines.find((l) => !(l.material as THREE.LineBasicMaterial).vertexColors)!
    expect((shell.material as THREE.LineBasicMaterial).color.getHex()).toBe(PALETTE.neon.ghost)
    expect(lines.filter((l) => (l.material as THREE.LineBasicMaterial).vertexColors)).toHaveLength(3)
    r.dispose()
  })

  it('a selection or a focus on parts holds the buildings tier at the overview; a hover does not', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.draw(smallCity(), smallText(), false)
    h.frames.step()
    expect(r.drawnCounts().tier).toBe('districts')
    r.setSelected('a')
    expect(r.drawnCounts().tier).toBe('buildings')
    r.setSelected('nope') // an id not drawn holds nothing
    expect(r.drawnCounts().tier).toBe('districts')
    r.setSelected('e1')
    expect(r.drawnCounts().tier).toBe('buildings')
    r.setSelected(null)
    r.setFocus({ ids: new Set(['a']), edgeIds: new Set(), hover: true })
    expect(r.drawnCounts().tier).toBe('districts')
    r.setFocus({ ids: new Set(['a']), edgeIds: new Set(), hover: true, held: true })
    expect(r.drawnCounts().tier).toBe('buildings')
    r.setFocus(null)
    expect(r.drawnCounts().tier).toBe('districts')
    r.dispose()
  })
})

describe('threeRenderer quality tiers (look spec §5)', () => {
  const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'
  const GEFORCE = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
  /** The dust: the second point cloud (the stars are the first). */
  const dustOf = (): THREE.Points => (sceneOf().children.filter((c) => c instanceof THREE.Points) as THREE.Points[])[1]
  const lastBloomSize = (i = gpu.bloomPasses.length - 1): [number, number] => {
    const s = gpu.bloomPasses[i].sizes
    return s[s.length - 1]
  }

  it('the table: High draws everything; Low the bloom at half size, no grain, one shaft, 600 dust; Flat no composer, shafts, dust or beams', () => {
    expect(TIER_LOOK).toEqual({
      high: { composer: true, bloom: 'full', grain: true, shafts: 2, dust: 1800, discMoving: true, beams: true, scanLinesMoving: true },
      low: { composer: true, bloom: 'half', grain: false, shafts: 1, dust: 600, discMoving: true, beams: true, scanLinesMoving: true },
      flat: { composer: false, bloom: null, grain: false, shafts: 0, dust: 0, discMoving: false, beams: false, scanLinesMoving: false },
    })
  })

  it('High: at most a 2x ratio, the composer with the bloom at full size, 1800 dust', () => {
    vi.stubGlobal('devicePixelRatio', 3)
    const r = createThreeRenderer(h.host, { quality: 'high', reducedMotion: false })
    expect(gpu.renderers[0].pixelRatios).toEqual([2])
    expect(gpu.composers).toHaveLength(1)
    expect(lastBloomSize()).toEqual([1600, 1200])
    expect(dustOf().geometry.getAttribute('position').count).toBe(1800)
    expect(dustOf().geometry.drawRange.count).toBe(1800)
    expect(r.motionState()).toMatchObject({ bloom: true, dust: 1800 })
    expect(r.perf().tier).toBe('high')
    r.dispose()
  })

  it('Low: three quarters of a 1x ratio, the composer with the bloom at half that size, 600 dust', () => {
    vi.stubGlobal('devicePixelRatio', 3)
    const r = createThreeRenderer(h.host, { quality: 'low', reducedMotion: false })
    expect(gpu.renderers[0].pixelRatios).toEqual([0.75])
    expect(gpu.composers).toHaveLength(1)
    expect(lastBloomSize()).toEqual([300, 225]) // 800 x 600 at 0.75 is 600 x 450; the bloom takes half
    expect(dustOf().geometry.drawRange.count).toBe(600)
    expect(dustOf().visible).toBe(true)
    expect(r.motionState()).toMatchObject({ bloom: true, dust: 600 })
    expect(r.perf().tier).toBe('low')
    r.dispose()
  })

  it('Flat: a 1x ratio, no composer and no dust; frames render straight to the canvas', () => {
    vi.stubGlobal('devicePixelRatio', 3)
    const r = createThreeRenderer(h.host, { quality: 'flat', reducedMotion: false })
    const gl = gpu.renderers[0]
    expect(gl.pixelRatios).toEqual([1])
    expect(gpu.composers).toHaveLength(0)
    h.frames.step()
    expect(gl.renders).toHaveLength(1)
    expect(dustOf().visible).toBe(false)
    expect(r.motionState()).toMatchObject({ bloom: false, dust: 0 })
    expect(r.perf().tier).toBe('flat')
    r.dispose()
  })

  it('auto starts at High on a GPU and at Flat in software', () => {
    for (const [name, tier] of [[GEFORCE, 'high'], [null, 'high'], [SWIFTSHADER, 'flat']] as const) {
      gpu.reset()
      gpu.gpuName = name
      const r = createThreeRenderer(h.host, { quality: 'auto', reducedMotion: false })
      expect(r.perf().tier, String(name)).toBe(tier)
      expect(gpu.composers, String(name)).toHaveLength(tier === 'high' ? 1 : 0)
      r.dispose()
    }
  })

  it('setTier changes pixel ratio, composer, bloom size, dust and shafts per the tier table without rebuilding', () => {
    vi.stubGlobal('devicePixelRatio', 2)
    const r = createThreeRenderer(h.host, { quality: 'high', reducedMotion: false })
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    h.frames.step()
    const gl = gpu.renderers[0]
    const scene = sceneOf()
    const built = (): Set<THREE.Object3D> => { const s = new Set<THREE.Object3D>(); scene.traverse((o) => { s.add(o) }); return s }
    const before = built()
    const strength = gpu.bloomPasses[0].strength
    expect(gl.pixelRatios[gl.pixelRatios.length - 1]).toBe(2)
    expect(lastBloomSize()).toEqual([1600, 1200])

    r.setTier('low')
    const composer = gpu.composers[0]
    expect(gpu.composers).toHaveLength(1) // the same composer, its targets resized
    expect(composer.disposed).toBe(0)
    expect(gl.pixelRatios[gl.pixelRatios.length - 1]).toBe(0.75)
    expect(lastBloomSize()).toEqual([300, 225])
    expect(r.motionState()).toMatchObject({ bloom: true, dust: 600 })
    expect(r.perf().tier).toBe('low')

    r.setTier('flat')
    expect(composer.disposed).toBe(1) // its render targets freed
    expect([gpu.bloomPasses[0].disposed, gpu.renderPasses[0].disposed, gpu.outputPasses[0].disposed]).toEqual([1, 1, 1])
    expect(gl.pixelRatios[gl.pixelRatios.length - 1]).toBe(1)
    expect(r.motionState()).toMatchObject({ bloom: false, dust: 0 })
    const straight = gl.renders.length
    const composed = composer.renders
    h.frames.step()
    expect(gl.renders.length).toBe(straight + 1) // drawn straight to the canvas
    expect(composer.renders).toBe(composed)

    r.setTier('high')
    expect(gpu.composers).toHaveLength(2) // a new composer, with the city's bloom strength
    expect(gpu.bloomPasses[1].strength).toBe(strength)
    expect(lastBloomSize(1)).toEqual([1600, 1200])
    expect(gl.pixelRatios[gl.pixelRatios.length - 1]).toBe(2)
    expect(r.motionState()).toMatchObject({ bloom: true, dust: 1800 })
    h.frames.step()
    expect(gpu.composers[1].renders).toBe(1)
    // nothing in the scene was built again or taken away: the dust drawn is a range of the points built once
    const after = built()
    expect([...before].filter((o) => !after.has(o))).toEqual([])
    expect([...after].filter((o) => !before.has(o))).toEqual([])

    // the same tier again changes nothing; after dispose, nothing either
    const sizes = gl.sizes.length
    r.setTier('high')
    expect(gl.sizes.length).toBe(sizes)
    r.dispose()
    r.setTier('low')
    expect(gpu.composers).toHaveLength(2)
    expect(gl.sizes.length).toBe(sizes)
  })

  it('a tier change wakes a sleeping loop, and the frames after it are not counted', () => {
    const r = createThreeRenderer(h.host, { quality: 'flat', reducedMotion: true })
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    for (let i = 0; i < 300 && h.frames.pending() > 0; i++) h.frames.step(16)
    expect(h.frames.pending()).toBe(0)
    r.setTier('low')
    expect(h.frames.pending()).toBe(1)
    r.dispose()
    const m = createThreeRenderer(h.host, { quality: 'high', reducedMotion: false })
    h.frames.run(40, 16)
    const n = m.perf().frames
    expect(n).toBeGreaterThan(30)
    m.setTier('low')
    h.frames.run(5, 16)
    expect(m.perf().frames).toBe(n)
    h.frames.run(1, 16)
    expect(m.perf().frames).toBe(n + 1)
    m.dispose()
  })

  it('cuts the counted frames into windows of 120 frames, or of 2 s of them, whichever comes first; a tier change starts a new one', () => {
    const seen: Array<[number, number, number]> = []
    const r = createThreeRenderer(h.host, { quality: 'high', reducedMotion: false, onFrameWindow: (s, span) => { seen.push([s.frames, s.p95, span]) } })
    h.frames.run(5, 16) // the first five frames (a wake) are not counted
    expect(seen).toEqual([])
    h.frames.run(119, 16)
    expect(seen).toEqual([])
    h.frames.run(1, 16)
    expect(seen).toEqual([[120, 16, 1920]])
    // slow frames: 2 s of them come first (7 of 300 ms is 2100)
    h.frames.run(6, 300)
    expect(seen).toHaveLength(1)
    h.frames.run(1, 300)
    expect(seen[1]).toEqual([7, 300, 2100])
    // half a window, then a tier change: the next window starts after the change's uncounted frames
    h.frames.run(60, 16)
    r.setTier('low')
    h.frames.run(5 + 119, 16)
    expect(seen).toHaveLength(2)
    h.frames.run(1, 16)
    expect(seen[2]).toEqual([120, 16, 1920])
    r.dispose()
  })

  it('a window may change the tier before its frame is drawn: that frame is drawn at the new tier', () => {
    const box: { r: ReturnType<typeof createThreeRenderer> | null } = { r: null }
    const r = createThreeRenderer(h.host, { quality: 'high', reducedMotion: false, onFrameWindow: () => { box.r?.setTier('flat') } })
    box.r = r
    const gl = gpu.renderers[0]
    h.frames.run(124, 16)
    expect(r.perf().tier).toBe('high')
    const straight = gl.renders.length
    const composed = gpu.composers[0].renders
    h.frames.run(1, 16) // the 120th counted frame: its window drops the tier, and the frame is drawn at Flat
    expect(r.perf().tier).toBe('flat')
    expect(gpu.composers[0].disposed).toBe(1)
    expect(gpu.composers[0].renders).toBe(composed)
    expect(gl.renders.length).toBe(straight + 1)
    expect(h.frames.pending()).toBe(1) // one frame asked for, not two
    r.dispose()
  })
})
