// threeRenderer: picking and focus. A real Raycaster shot through the real scene at a building, a
// line's pick tube, a district's slab and empty space; the pick tolerance from the buildings' screen
// boxes; where the probe finds a part on screen (screenPoint, linePoints, visibleIds); and how a
// focus, a hover and a selection dim and light the parts.
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { createThreeRenderer, type ThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
import type { SceneModel } from '../../../src/renderer/src/world/engine/sceneModel'
import { focusOpacity } from '../../../src/renderer/src/world/engine/interaction'
import { LABEL_MIN_OPACITY } from '../../../src/renderer/src/world/engine/viewMath'
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import {
  atRatio, bldg, boxCanvas, cameraOf, conduit, DEFAULT_OPTS, district, floorsOf, labelsOf, makeHost, orb, sceneOf, smallCity, smallText,
  withHarness, withData, worldOf,
} from './threeHarness'

vi.mock('three', async (orig) => ({ ...(await orig<typeof import('three')>()), WebGLRenderer: (await import('./threeHarness')).FakeWebGLRenderer }))
vi.mock('three/examples/jsm/postprocessing/EffectComposer.js', async () => ({ EffectComposer: (await import('./threeHarness')).FakeEffectComposer }))
vi.mock('three/examples/jsm/postprocessing/RenderPass.js', async () => ({ RenderPass: (await import('./threeHarness')).FakeRenderPass }))
vi.mock('three/examples/jsm/postprocessing/UnrealBloomPass.js', async () => ({ UnrealBloomPass: (await import('./threeHarness')).FakeUnrealBloomPass }))
vi.mock('three/examples/jsm/postprocessing/OutputPass.js', async () => ({ OutputPass: (await import('./threeHarness')).FakeOutputPass }))

const h = withHarness()

type V = [number, number, number]

/** Where a world point shows on the 800x600 canvas, in client pixels (as the renderer's camera projects it). */
function client(p: THREE.Vector3 | V): { x: number; y: number } {
  const cam = cameraOf()
  cam.updateMatrixWorld()
  const v = (Array.isArray(p) ? new THREE.Vector3(...p) : p.clone()).project(cam)
  return { x: ((v.x + 1) / 2) * 800, y: ((1 - v.y) / 2) * 600 }
}
const dist3 = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const pickAt = (r: ThreeRenderer, p: THREE.Vector3 | V): ReturnType<ThreeRenderer['pick']> => { const c = client(p); return r.pick(c.x, c.y) }

/** Lands the camera at `pos` looking at `target` and draws a frame there. */
function look(r: ThreeRenderer, pos: V, target: V): void {
  void r.flyTo({ pos, target }, true)
  h.frames.step()
}

/**
 * A straight line e at roof height (y 9) from p to q, the tower z behind it (seen from +z), and a
 * dangling line g from q to open ground.
 */
function wall(): SceneModel {
  return {
    districts: [district('d1', [0, 0, 0], 30)],
    buildings: [
      bldg('p', [-20, 0, 0], { floors: 3, height: 9 }),
      bldg('q', [20, 0, 0], { floors: 3, height: 9 }),
      bldg('z', [0, 0, -15], { floors: 10, height: 30 }),
    ],
    conduits: [
      conduit('e', [-20, 0, 0], [20, 0, 0], { ctrl: [0, 0, 0] }), // its ends on p's and q's feet: raised to their roofs, a straight line at y 9
      conduit('g', [20, 0, 0], [40, 0, -30], { ctrl: [30, 0, -15] }), // from q's roof down to open ground
    ],
    orbs: [],
  }
}

function drawn(model: SceneModel = smallCity()): ThreeRenderer {
  const r = createThreeRenderer(h.host, DEFAULT_OPTS)
  boxCanvas(r.canvas, 800, 600)
  r.draw(model, smallText(), false)
  h.frames.step()
  return r
}

const topFloor = (id: string): THREE.Vector3 => {
  const fl = floorsOf(worldOf(sceneOf()), id)
  return fl[fl.length - 1].getWorldPosition(new THREE.Vector3())
}

describe('threeRenderer pick', () => {
  it('nothing is picked, found or seen on a canvas with no box yet', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    expect(r.drawnCounts().districts).toBe(0) // nothing drawn yet
    r.draw(smallCity(), smallText(), false)
    h.frames.step()
    expect(r.pick(400, 300)).toBeNull()
    expect(r.screenPoint('a')).toBeNull()
    expect(r.screenPoint('e1')).toBeNull()
    expect(r.linePoints('e1')).toEqual([])
    boxCanvas(r.canvas, 800, 0)
    expect(r.pick(400, 300)).toBeNull()
    expect(r.screenPoint('a')).toBeNull()
    expect(r.linePoints('e1')).toEqual([])
    boxCanvas(r.canvas, 800, 600)
    expect(r.screenPoint('nope')).toBeNull()
    expect(r.linePoints('nope')).toEqual([])
    r.dispose()
  })

  it('a building, a line and empty space, close up; at the districts tier a slab picks its district', () => {
    const city = smallCity()
    const r = drawn(city)
    look(r, [-6, 14, 12], [-6, 5, 0])
    expect(r.drawnCounts().tier).toBe('floors')
    expect(pickAt(r, topFloor('a'))).toEqual({ kind: 'node', id: 'a' })
    look(r, [-6, 22, 30], [-6, 5, 0])
    expect(r.drawnCounts().tier).toBe('buildings')
    expect(pickAt(r, topFloor('a'))).toEqual({ kind: 'node', id: 'a' })
    expect(pickAt(r, topFloor('b'))).toEqual({ kind: 'node', id: 'b' })
    // the top of e1's arch, well clear of both roofs (its ends are not on a building's foot: no lift)
    const e1 = city.conduits[0]
    const arch = new THREE.QuadraticBezierCurve3(new THREE.Vector3(...e1.from), new THREE.Vector3(...e1.ctrl), new THREE.Vector3(...e1.to))
    expect(pickAt(r, arch.getPoint(0.5))).toEqual({ kind: 'edge', id: 'e1' })
    expect(r.pick(2, 2)).toBeNull() // the sky
    expect(r.pick(2, 2)).toBeNull() // again, the screen boxes kept from the first
    // far out: the districts tier
    look(r, [0, 60, 90], [10, 0, 10])
    expect(r.drawnCounts().tier).toBe('districts')
    expect(pickAt(r, [0, 0.5, 0])).toEqual({ kind: 'district', id: 'd1' })
    expect(pickAt(r, [60, 0.5, 0])).toEqual({ kind: 'district', id: 'd2' })
    // the external stays an orb: it is in no district
    expect(pickAt(r, [30, 2.2, 40])).toEqual({ kind: 'node', id: 'x' })
    r.dispose()
  })

  it('a planned part on no district stays drawn and pickable from far away: a linked build world (round 3 A)', () => {
    // Drawn: its group is shown and a mesh in it (its block, or its floors nearer in) is too.
    const shown = (world: THREE.Object3D, id: string): boolean => {
      const g = floorsOf(world, id)[0].parent!.parent!
      let drawnMesh = false
      g.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) drawnMesh = true })
      return g.visible && drawnMesh
    }
    const planned = (id: string, pos: V): ReturnType<typeof bldg> => bldg(id, pos, { floors: 2, height: 6, look: 'wire' })
    // One built part in its district, and two planned parts on the ring outside every district
    const r = drawn({ districts: [district('d1', [0, 0, 0], 12)], buildings: [bldg('a', [0, 0, 0]), planned('w1', [40, 0, 0]), planned('w2', [-40, 0, 0])], conduits: [], orbs: [] })
    expect(r.drawnCounts().tier).toBe('districts')
    const world = worldOf(sceneOf())
    expect(shown(world, 'a')).toBe(false) // under its district's slab
    expect(shown(world, 'w1')).toBe(true)
    expect(shown(world, 'w2')).toBe(true)
    expect(pickAt(r, topFloor('w1'))).toEqual({ kind: 'node', id: 'w1' })
    // isShown: drawn itself, or stood for by its district's slab
    expect(['a', 'w1', 'w2', 'nope'].map((id) => r.isShown(id))).toEqual([true, true, true, false])
    r.dispose()
    // An empty build folder: nothing built yet, so every part is planned and none has a district
    const empty = drawn({ districts: [], buildings: [planned('p1', [20, 0, 0]), planned('p2', [-20, 0, 0])], conduits: [], orbs: [] })
    expect(empty.drawnCounts().tier).toBe('districts')
    expect(shown(worldOf(sceneOf()), 'p1')).toBe(true)
    expect(shown(worldOf(sceneOf()), 'p2')).toBe(true)
    empty.dispose()
  })

  it('a click a few pixels beside a building far away still picks it (the screen boxes)', () => {
    const r = drawn()
    atRatio(r, h.frames, 0.6)
    expect(r.drawnCounts().tier).toBe('buildings')
    // c's right edge on screen, then a little past it
    const fl = floorsOf(worldOf(sceneOf()), 'c')[0]
    const beside = (): [number, number] => {
      const right = client(fl.localToWorld(new THREE.Vector3(2.5, 0, 2.5)))
      const xs = [-2.5, 2.5].flatMap((x) => [-2.5, 2.5].map((z) => client(fl.localToWorld(new THREE.Vector3(x, 0, z))).x))
      return [Math.max(...xs, right.x), right.y]
    }
    const [edge, y] = beside()
    expect(r.pick(edge + 3, y)).toEqual({ kind: 'node', id: 'c' })
    expect(r.pick(edge + 40, y)).toBeNull()
    // the next frame works the boxes out again (from the geometries' kept bounds)
    h.frames.step()
    const [edge2, y2] = beside()
    expect(r.pick(edge2 + 3, y2)).toEqual({ kind: 'node', id: 'c' })
    r.dispose()
  })

  it('a building behind the camera, or one with a corner inside the near plane, has no screen box', () => {
    const r = drawn({ districts: [district('d1', [0, 0, 0], 20)], buildings: [bldg('s', [0, 0, 0], { floors: 1, height: 3 }), bldg('t', [0, 0, -30])], conduits: [], orbs: [] })
    // turned round: s behind the camera
    look(r, [0, 4, 8], [0, 3, 30])
    expect(r.pick(2, 2)).toBeNull()
    r.dispose()
  })

  it('a line in front of a building takes the click only where the ray touches it; a building in front of a line wins', () => {
    const r = drawn(wall())
    look(r, [0, 12, 40], [0, 9, 0])
    expect(r.drawnCounts().tier).not.toBe('districts')
    expect(pickAt(r, [0, 9, 0])).toEqual({ kind: 'edge', id: 'e' })
    // in the fat pick tube, but 0.7 from the line: the tower behind takes it
    expect(pickAt(r, [0, 9.7, 0])).toEqual({ kind: 'node', id: 'z' })
    // near the line's end over p's roof: the building there
    expect(pickAt(r, [-18.5, 9.2, 0])).toEqual({ kind: 'node', id: 'p' })
    // from behind the tower: the tower, though the line is behind it
    look(r, [0, 14, -40], [0, 9, 0])
    expect(r.drawnCounts().tier).toBe('buildings')
    expect(pickAt(r, [0, 9, -12.5])).toEqual({ kind: 'node', id: 'z' })
    r.dispose()
  })

  it('near the end of a line with no building there, the line itself is picked', () => {
    const r = drawn(wall())
    look(r, [40, 30, -10], [40, 0, -30])
    const g = new THREE.QuadraticBezierCurve3(new THREE.Vector3(20, 9, 0), new THREE.Vector3(30, 4.5, -15), new THREE.Vector3(40, 0, -30))
    expect(pickAt(r, g.getPoint(0.98))).toEqual({ kind: 'edge', id: 'g' })
    r.dispose()
  })
})

describe('threeRenderer probe', () => {
  it('screenPoint: a point that picks the building, the orb or the line; null off screen', () => {
    const r = drawn()
    look(r, [-6, 22, 30], [-6, 5, 0])
    for (const id of ['a', 'b']) {
      const pt = r.screenPoint(id) as { x: number; y: number }
      expect(pt).not.toBeNull()
      expect(r.pick(pt.x, pt.y)).toEqual({ kind: 'node', id })
    }
    const pe = r.screenPoint('e1') as { x: number; y: number }
    expect(pe).not.toBeNull()
    expect(r.pick(pe.x, pe.y)).toEqual({ kind: 'edge', id: 'e1' })
    expect(r.screenPoint('c')).toBeNull() // off the picture
    expect(r.screenPoint('x')).toBeNull()
    // far out, the orb is still an orb (it is in no district); a building stands for its district
    look(r, [0, 60, 90], [10, 0, 10])
    const px = r.screenPoint('x') as { x: number; y: number }
    expect(r.pick(px.x, px.y)).toEqual({ kind: 'node', id: 'x' })
    expect(r.screenPoint('a')).toBeNull()
    // looking away from the city
    look(r, [0, 20, -150], [0, 20, -400])
    expect(r.screenPoint('a')).toBeNull()
    expect(r.screenPoint('x')).toBeNull()
    expect(r.screenPoint('e1')).toBeNull()
    expect(r.linePoints('e1')).toEqual([])
    expect(r.visibleIds()).toEqual([])
    r.dispose()
  })

  it('screenPoint: a building hidden behind a tower has none; a line over a tower is found past it', () => {
    const r = drawn(wall())
    look(r, [0, 12, 40], [0, 9, 0])
    const pe = r.screenPoint('e') as { x: number; y: number }
    expect(pe).not.toBeNull()
    expect(r.pick(pe.x, pe.y)).toEqual({ kind: 'edge', id: 'e' })
    // its middle is over the tower: the point found is off to one side, over open ground
    expect(Math.abs(pe.x - client([0, 9, 0]).x)).toBeGreaterThan(5)
    // from far behind the tower, low: p and q are hidden behind it
    look(r, [0, 10, -160], [0, 9, 0])
    const hiddenIds = ['p', 'q'].filter((id) => r.screenPoint(id) === null)
    expect(hiddenIds.length).toBeGreaterThan(0)
    r.dispose()
  })

  it('linePoints: the points of a line on screen with no building in front, at any tier', () => {
    const r = drawn(wall())
    look(r, [0, 12, 40], [0, 9, 0])
    const front = r.linePoints('e')
    expect(front.length).toBe(19) // every point: the tower is behind the line
    // from behind the tower, the points behind it are hidden
    look(r, [0, 14, -40], [0, 9, 0])
    const behind = r.linePoints('e')
    expect(behind.length).toBeGreaterThan(0)
    expect(behind.length).toBeLessThan(19)
    // the districts tier: the slab, not the hidden buildings, is what stands in the way (e runs over it, g mostly off it)
    look(r, [0, 10, -60], [0, 9, 0])
    expect(r.drawnCounts().tier).toBe('districts')
    expect(r.linePoints('e')).toEqual([])
    expect(r.linePoints('g').length).toBeGreaterThan(0)
    r.dispose()
  })

  it('visibleIds: the parts whose centre is in the picture', () => {
    const r = drawn()
    atRatio(r, h.frames, 1)
    expect(r.visibleIds().sort()).toEqual(['a', 'b', 'c', 'e1', 'e2', 'x'])
    r.dispose()
  })
})

/** smallCity with a wireframe building w (its seams pulse: their opacity is the pulse's, not the focus's). */
function cityWithWire(): SceneModel {
  const m = smallCity()
  m.buildings.push(bldg('w', [-6, 0, -10], { look: 'wire' }))
  return m
}
const tubeOf = (id: string): THREE.Material => {
  const pick = withData(worldOf(sceneOf()), 'edgeId').find((o) => o.userData.edgeId === id) as THREE.Mesh
  // the drawn line shares the pick tube's course: the world child just before it
  const world = worldOf(sceneOf())
  return (world.children[world.children.indexOf(pick) - 1] as THREE.Mesh).material as THREE.Material
}
const packetsOf = (id: string): THREE.Material[] => {
  const world = worldOf(sceneOf())
  const pick = withData(world, 'edgeId').find((o) => o.userData.edgeId === id) as THREE.Mesh
  const i = world.children.indexOf(pick)
  return world.children.slice(i + 1, i + 4).filter((c) => (c as THREE.Mesh).isMesh && !(c as unknown as { isCSS2DObject?: boolean }).isCSS2DObject)
    .map((c) => (c as THREE.Mesh).material as THREE.Material)
}

describe('threeRenderer focus', () => {
  it('dims the parts outside the focus (x0.12, labels 0.2, packets x0.06), lights those in it (packets x1.9, tubes by focusOpacity), and clears', () => {
    const r = drawn(cityWithWire())
    look(r, [-6, 22, 30], [-6, 5, 0])
    const world = worldOf(sceneOf())
    const fillOf = (id: string): THREE.MeshStandardMaterial => floorsOf(world, id)[0].material as THREE.MeshStandardMaterial
    const base = fillOf('a').opacity
    const wireSeam = (floorsOf(world, 'w')[0].parent as THREE.Object3D).children[1] as THREE.LineSegments
    const tube1 = tubeOf('e1')
    const tube2 = tubeOf('e2')
    const tb1 = tube1.userData.base as number
    const tb2 = tube2.userData.base as number
    const [p1] = packetsOf('e1')
    const [p2] = packetsOf('e2')
    const pb1 = p1.userData.base as number
    const pb2 = p2.userData.base as number
    r.setFocus({ ids: new Set(['a']), edgeIds: new Set(['e1']) })
    expect(fillOf('a').opacity).toBeCloseTo(base)
    expect(fillOf('b').opacity).toBeCloseTo(base * 0.12)
    expect(fillOf('b').userData.f).toBe(0.12)
    expect(tube1.opacity).toBeCloseTo(focusOpacity(tb1, true))
    expect(tube2.userData.f).toBeCloseTo(focusOpacity(tb2, false) / tb2) // dashed: its opacity is the pulse's
    expect(p1.opacity).toBeCloseTo(Math.min(1, pb1 * 1.9))
    expect(p2.opacity).toBeCloseTo(pb2 * 0.06)
    const wireBefore = (wireSeam.material as THREE.Material).opacity
    expect((wireSeam.material as THREE.Material).userData.f).toBe(0.12)
    expect((wireSeam.material as THREE.Material).opacity).toBe(wireBefore) // the pulse sets it, not the focus
    h.frames.step()
    expect((wireSeam.material as THREE.Material).opacity).toBeLessThan(0.12 + 1e-9)
    // b's name, dimmed to 0.2 by the focus, is too faint to read: it is not drawn at all (F8), and a's (lit) reads in full
    const label = (id: string): CSS2DObject => labelsOf(world, 'bldg').find((l) => l.parent === floorsOf(world, id)[0].parent?.parent) as CSS2DObject
    const name = (id: string): HTMLElement => label(id).element
    expect(label('b').visible).toBe(false)
    expect(label('a').visible).toBe(true)
    expect(name('a').style.opacity).toBe('1')
    // no name on show is drawn fainter than the readable floor
    for (const l of labelsOf(world, 'bldg')) if (l.visible) expect(Number(l.element.style.opacity)).toBeGreaterThanOrEqual(LABEL_MIN_OPACITY)
    // a hovered building's name reads in full, dimmed or not; an unknown id or none hovers nothing
    r.setHovered('b')
    h.frames.step()
    expect(label('b').visible).toBe(true)
    expect(name('b').style.opacity).toBe('1')
    r.setHovered('nope')
    h.frames.step()
    expect(label('b').visible).toBe(false)
    r.setHovered(null)
    // cleared
    r.setFocus(null)
    expect(fillOf('b').opacity).toBeCloseTo(base)
    expect(tube1.opacity).toBeCloseTo(tb1)
    expect(p1.opacity).toBeCloseTo(pb1)
    expect(p2.opacity).toBeCloseTo(pb2)
    r.dispose()
  })

  it("a hover's passive lines let the click through to the building; the lit lines' labels show, nearest first", () => {
    const r = drawn()
    look(r, [-6, 22, 30], [-6, 5, 0])
    const world = worldOf(sceneOf())
    const label = (id: string): HTMLElement => labelsOf(world, 'edge').find((l) => l.element.textContent === (id === 'e1' ? 'calls' : 'reads'))?.element as HTMLElement
    r.setFocus({ ids: new Set(['a', 'b', 'x']), edgeIds: new Set(['e1', 'e2']), hover: true, passive: new Set(['e1']) })
    expect(label('e1').style.pointerEvents).toBe('none')
    expect(label('e2').style.pointerEvents).toBe('')
    h.frames.step()
    const lit = labelsOf(world, 'edge').filter((l) => l.visible)
    expect(lit.length).toBeGreaterThan(0)
    // a selection's focus (no hover) lights them too
    r.setFocus({ ids: new Set(['a', 'b', 'x']), edgeIds: new Set(['e1', 'e2']) })
    expect(label('e1').style.pointerEvents).toBe('')
    h.frames.step()
    expect(labelsOf(world, 'edge').filter((l) => l.visible).length).toBeGreaterThan(0)
    r.dispose()
  })
})

describe('threeRenderer framing', () => {
  it('a line is framed from its side with both ends in view; a building with or without neighbours; straight down', async () => {
    const r = drawn()
    atRatio(r, h.frames, 1)
    await r.frame(['e1'], true)
    h.frames.step()
    for (const id of ['a', 'b']) expect(r.screenPoint(id)).not.toBeNull()
    await r.frame(['a'], true)
    h.frames.step()
    expect(r.screenPoint('a')).not.toBeNull()
    await r.frame(['a'], true, ['b', 'nope'])
    h.frames.step()
    expect(r.screenPoint('b')).not.toBeNull()
    // the camera straight over its target (OrbitControls keeps it a hair off; set here exactly): the framing looks from +z
    void r.flyTo({ pos: [0, 120, 0], target: [0, 0, 0] }, true)
    cameraOf().position.set(0, 120, 0)
    await r.frame(['a'], true)
    const cam = r.getCamera()
    expect(cam.pos[2]).toBeGreaterThan(cam.target[2])
    expect(Math.abs(cam.pos[0] - cam.target[0])).toBeLessThan(1e-6)
    r.dispose()
  })

  it('a line whose ends show nowhere beside the panels (a free strip narrower than the inset) is seen from high above', async () => {
    const r = drawn()
    r.setRightReserve(780, 0) // 20 px left free: no end is END_INSET_PX inside both its edges
    h.frames.step()
    await r.frame(['e1'], true)
    h.frames.step()
    const cam = r.getCamera()
    // the overhead view: high over the line's middle
    expect(cam.pos[1] - cam.target[1]).toBeGreaterThan(Math.hypot(cam.pos[0] - cam.target[0], cam.pos[2] - cam.target[2]))
    r.dispose()
  })

  it.each([120, 80, 60, 48])("frames a clicked building with its name's whole box in the picture, even in a short view %i px tall (F5, M2)", async (tall) => {
    const short = makeHost(800, tall)
    const r = createThreeRenderer(short, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, tall)
    // A wide district, so the close-up is not held in by its cap (most of the overview).
    r.draw({ districts: [district('d', [0, 0, 0], 600)], buildings: [bldg('t', [0, 0, 0], { floors: 10, height: 60 })], conduits: [], orbs: [] }, smallText(), false)
    h.frames.step()
    await r.frame(['t'], true)
    h.frames.step()
    const cam = cameraOf()
    cam.updateMatrixWorld()
    // The name's point (3 over the roof) lies at least the name's half height and the view's inset below the top:
    // the room is reserved at the distance the camera ends at, and as it looks on screen from a camera pitched down.
    const y = ((1 - new THREE.Vector3(0, 63, 0).project(cam).y) / 2) * tall
    expect(y).toBeGreaterThanOrEqual(16 - 0.5)
    r.dispose()
    short.remove()
  })
})

/** Whether a world point is in the picture the renderer last drew. */
function inView(p: V): boolean {
  const cam = cameraOf()
  cam.updateMatrixWorld()
  const v = new THREE.Vector3(...p).project(cam)
  return Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && Math.abs(v.z) <= 1
}
/** Eight towers of `height` in a closed ring of radius 6 around [x, 0, z] (their footprints overlap: no gap to see through). */
const ring = (tag: string, x: number, z: number, height: number): ReturnType<typeof bldg>[] =>
  Array.from({ length: 8 }, (_, k) => bldg(`${tag}${k}`, [x + 6 * Math.cos((k * Math.PI) / 4), 0, z + 6 * Math.sin((k * Math.PI) / 4)], { floors: 10, height }))

describe('threeRenderer line framing', () => {
  it.each([120, 60, 48])("frames a line's close-up with room for both end names over their buildings, in a view %i px tall (F5, M3)", async (tall) => {
    const short = makeHost(800, tall)
    const r = createThreeRenderer(short, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, tall)
    // A wide district, so the close-up is not held in by its cap (most of the overview).
    r.draw({
      districts: [district('d', [0, 0, 0], 600)],
      buildings: [bldg('p', [-90, 0, 0], { floors: 10, height: 60 }), bldg('q', [90, 0, 0], { floors: 10, height: 60 })],
      // A low, flat line: the end names, not the arch, are the highest things in the shot.
      conduits: [conduit('e', [-90, 60, 0], [90, 60, 0], { ctrl: [0, 30, 0] })],
      orbs: [],
    }, smallText(), false)
    h.frames.step()
    await r.frame(['e'], true)
    h.frames.step()
    const cam = cameraOf()
    cam.updateMatrixWorld()
    // Each end's name point (3 over its roof) lies at least the name's half height and the view's inset below the top.
    for (const x of [-90, 90]) {
      const y = ((1 - new THREE.Vector3(x, 63, 0).project(cam).y) / 2) * tall
      expect(y, `end at ${x}`).toBeGreaterThanOrEqual(16 - 0.5)
    }
    r.dispose()
    short.remove()
  })

  it('a line whose close looks are crossed by another line is framed from further out, both ends and its middle in sight', async () => {
    const r = drawn({
      districts: [district('d1', [0, 0, 0], 30)],
      buildings: [bldg('p', [-10, 0, 0]), bldg('q', [10, 0, 0])],
      conduits: [conduit('e', [-10, 0, 0], [10, 0, 0]), conduit('k', [0, 0, 40], [0, 0, -40], { ctrl: [0, 60, 0] })],
      orbs: [],
    })
    await r.frame(['e'], true)
    h.frames.step()
    const cam = r.getCamera()
    const d = dist3(cam.pos, cam.target)
    expect(d).toBeGreaterThan(40)
    // well clear of k's arch (LINE_CLEAR of the way to the target), with both roofs in the picture
    const k = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 40), new THREE.Vector3(0, 60, 0), new THREE.Vector3(0, 0, -40))
    expect(Math.min(...k.getPoints(100).map((q) => q.distanceTo(new THREE.Vector3(...cam.pos))))).toBeGreaterThan(0.45 * d - 3)
    expect([inView([-10, 9, 0]), inView([10, 9, 0])]).toEqual([true, true])
    r.dispose()
  })

  it('a line whose middle runs through towers is framed with both ends in view, the middle hidden wherever the camera stands', async () => {
    // a world 3 km across: the furthest looks tried stand thousands of units back, inside the far plane that goes out with the overview
    const r = drawn({
      districts: [district('d1', [0, 0, 0], 1500)],
      buildings: [bldg('p', [-12, 0, 0]), bldg('q', [12, 0, 0]), ...[-5, 0, 5].map((x, k) => bldg(`t${k}`, [x, 0, 0], { floors: 10, height: 40 }))],
      conduits: [conduit('e', [-12, 0, 0], [12, 0, 0], { ctrl: [0, 0, 0] })],
      orbs: [],
    })
    await r.frame(['e'], true)
    h.frames.step()
    expect([inView([-12, 9, 0]), inView([12, 9, 0])]).toEqual([true, true])
    r.dispose()
  })

  it('a line with one end walled in by towers shows the other end; one with its only building walled in is seen from high above', async () => {
    const r = drawn({
      districts: [district('d1', [0, 0, 0], 40)],
      buildings: [bldg('p', [-12, 0, 0]), bldg('q', [12, 0, 0]), ...ring('w', -12, 0, 200)],
      conduits: [conduit('f', [-12, 0, 0], [12, 0, 0]), conduit('g', [-12, 0, 0], [-12, 0, 30], { ctrl: [-12, 0, 15] })],
      orbs: [],
    })
    await r.frame(['f'], true)
    h.frames.step()
    expect(inView([12, 9, 0])).toBe(true)
    await r.frame(['g'], true)
    const cam = r.getCamera()
    expect(cam.pos[1] - cam.target[1]).toBeGreaterThan(0.8 * Math.hypot(cam.pos[0] - cam.target[0], cam.pos[2] - cam.target[2])) // from above
    r.dispose()
  })

  it('a line whose end shows only through a gap in the towers round it is framed through the gap, both ends clickable (CI: server -> api-foo.com)', async () => {
    // Towers 8 out round p every 22.5 degrees, taller than any lift sees over, with one gap left open on the side away
    // from q: straight across the line p is hidden at every lift and distance, and only a look turned -45 degrees
    // comes through the gap. The clicks spent stepping back along the first look, which hides p from every distance,
    // once used up the whole budget before the camera ever turned, and the close-up showed q beside a p no click
    // could reach (world-visual's server -> api-foo.com in this repository's own world).
    const walls = Array.from({ length: 16 }, (_, k) => k).filter((k) => k < 5 || k > 7)
      .map((k) => bldg(`w${k}`, [8 * Math.cos((k * Math.PI) / 8), 0, 8 * Math.sin((k * Math.PI) / 8)], { floors: 10, height: 200 }))
    const r = drawn({
      districts: [district('d1', [0, 0, 0], 40)],
      buildings: [bldg('p', [0, 0, 0]), bldg('q', [30, 0, 0]), ...walls],
      conduits: [conduit('e', [0, 0, 0], [30, 0, 0])],
      orbs: [],
    })
    r.setSelected('e')
    await r.frame(['e'], true)
    h.frames.step()
    expect(r.screenPoint('q')).not.toBeNull()
    expect(r.screenPoint('p')).not.toBeNull()
    r.dispose()
  })

  it('an upright line (its ends one above the other) is framed from the camera\'s side; a line to an orb, from either side', async () => {
    const m = smallCity()
    m.conduits.push(conduit('v', [-30, 0, 30], [-30, 20, 30]))
    const r = drawn(m)
    await r.frame(['v'], true)
    h.frames.step()
    expect(inView([-30, 10, 30])).toBe(true)
    look(r, [20, 30, 80], [18, 4, 22])
    await r.frame(['e2'], true)
    h.frames.step()
    expect(inView([30, 2.2, 40])).toBe(true)
    look(r, [20, 30, -40], [18, 4, 22])
    await r.frame(['e2'], true)
    h.frames.step()
    expect(inView([30, 2.2, 40])).toBe(true)
    r.dispose()
  })

  it('a line from open ground to open ground through towers, its middle hidden from everywhere, is seen from high above', async () => {
    const r = drawn({
      districts: [district('d1', [0, 0, 0], 30)],
      buildings: [-10, 0, 10].map((x, k) => bldg(`t${k}`, [x, 0, 0], { floors: 10, height: 40 })), // under the line's 30%, 50% and 70%
      conduits: [conduit('e', [-25, 0, 0], [25, 0, 0], { ctrl: [0, 0, 0] })],
      orbs: [],
    })
    await r.frame(['e'], true)
    const cam = r.getCamera()
    const across = Math.hypot(cam.pos[0] - cam.target[0], cam.pos[2] - cam.target[2])
    expect((cam.pos[1] - cam.target[1]) / across).toBeCloseTo(2) // LINE_LIFTS[2]
    r.dispose()
  })
})

