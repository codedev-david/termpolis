// threeRenderer: each theme's palette reaching the materials, and what each zoom tier draws (semantic zoom).
// The GPU boundary is faked (threeHarness.ts); the scene graph, geometries and materials are real.
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { createThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
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
