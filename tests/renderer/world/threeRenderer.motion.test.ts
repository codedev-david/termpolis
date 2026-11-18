// threeRenderer: motion and frames. Packets and pulses along the lines, the verified ring, opening a
// building, camera flights, reduced motion, change animations and pausing, at exact times (the frame
// stepper drives performance.now, which THREE.Clock, the camera rig and the change animator read).
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { createThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
import type { SceneModel } from '../../../src/renderer/src/world/engine/sceneModel'
import {
  bldg, boxCanvas, cameraOf, DEFAULT_OPTS, district, emptyText, floorsOf, orb, packetBatches, rendererOf, sceneOf,
  smallCity, smallText, withHarness, withData, worldOf,
} from './threeHarness'

vi.mock('three', async (orig) => ({ ...(await orig<typeof import('three')>()), WebGLRenderer: (await import('./threeHarness')).FakeWebGLRenderer }))
vi.mock('three/examples/jsm/postprocessing/EffectComposer.js', async () => ({ EffectComposer: (await import('./threeHarness')).FakeEffectComposer }))
vi.mock('three/examples/jsm/postprocessing/RenderPass.js', async () => ({ RenderPass: (await import('./threeHarness')).FakeRenderPass }))
vi.mock('three/examples/jsm/postprocessing/UnrealBloomPass.js', async () => ({ UnrealBloomPass: (await import('./threeHarness')).FakeUnrealBloomPass }))
vi.mock('three/examples/jsm/postprocessing/OutputPass.js', async () => ({ OutputPass: (await import('./threeHarness')).FakeOutputPass }))

const h = withHarness()

/** The packets of the lines: the small shapes riding them (GEO's sphere, as no cargo shape is set). */
const packets = (world: THREE.Object3D): THREE.Mesh[] =>
  world.children.filter((c) => (c as THREE.Mesh).isMesh && (c as THREE.Mesh).geometry.type === 'SphereGeometry' && ((c as THREE.Mesh).geometry as THREE.SphereGeometry).parameters.radius === 0.6) as THREE.Mesh[]
const pulseBalls = (world: THREE.Object3D): THREE.Mesh[] =>
  world.children.filter((c) => (c as THREE.Mesh).isMesh && (c as THREE.Mesh).geometry.type === 'SphereGeometry' && (((c as THREE.Mesh).geometry as THREE.SphereGeometry).parameters.widthSegments === 16)) as THREE.Mesh[]
const sealOf = (world: THREE.Object3D): THREE.Mesh =>
  world.getObjectsByProperty('type', 'Mesh').find((m) => (m as THREE.Mesh).geometry instanceof THREE.TorusGeometry && ((m as THREE.Mesh).geometry as THREE.TorusGeometry).parameters.radius === 1.1) as THREE.Mesh
const selRingOf = (world: THREE.Object3D): THREE.Mesh =>
  world.children.find((m) => (m as THREE.Mesh).geometry instanceof THREE.TorusGeometry && ((m as THREE.Mesh).geometry as THREE.TorusGeometry).parameters.radius === 4.8) as THREE.Mesh
/** The roof-to-roof course of a line, as edgeShape builds it (from and to raised by their buildings' heights). */
const tallCurve = (from: [number, number, number], to: [number, number, number], ctrl: [number, number, number], hf: number, ht: number): THREE.QuadraticBezierCurve3 =>
  new THREE.QuadraticBezierCurve3(new THREE.Vector3(from[0], from[1] + hf, from[2]), new THREE.Vector3(ctrl[0], ctrl[1] + (hf + ht) / 2, ctrl[2]), new THREE.Vector3(to[0], to[1] + ht, to[2]))

const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('threeRenderer motion', () => {
  it('packets ride their lines every frame, and the packet batches follow them', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    const city = smallCity()
    r.draw(city, smallText(), false)
    r.setFocus({ ids: new Set(['a']), edgeIds: new Set() }) // the buildings tier: lines run roof to roof
    h.frames.step()
    const world = worldOf(sceneOf())
    const e1 = city.conduits[0]
    const curve = tallCurve(e1.from as [number, number, number], e1.to as [number, number, number], e1.ctrl as [number, number, number], 0, 0) // the line's ends are not on a building's foot: no lift
    const ps = packets(world).slice(0, 3) // e1's three
    const before = ps.map((p) => p.position.clone())
    h.frames.run(5, 20)
    ps.forEach((p, k) => {
      expect(p.position.distanceTo(before[k])).toBeGreaterThan(0)
      // still on the line: the nearest of 400 points along it is within a hair
      const near = Math.min(...curve.getPoints(400).map((q) => q.distanceTo(p.position)))
      expect(near).toBeLessThan(0.2)
    })
    const batch = packetBatches(sceneOf()).find((im) => (im as THREE.InstancedMesh).count === 3) as THREE.InstancedMesh
    const m = new THREE.Matrix4()
    batch.getMatrixAt(0, m)
    expect(new THREE.Vector3().setFromMatrixPosition(m).distanceTo(ps[0].position)).toBeLessThan(1e-4)
    r.dispose()
  })

  it('a pulse runs balls along each line in turn and settles when the last lands; stopPulses settles it early', async () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.draw(smallCity(), smallText(), false)
    r.setFocus({ ids: new Set(['a']), edgeIds: new Set() })
    h.frames.step()
    const world = worldOf(sceneOf())
    const balls = pulseBalls(world)
    expect(balls).toHaveLength(10)
    let done = false
    const p = r.pulse(['nope', 'e1', 'e2'], false).then(() => { done = true })
    await Promise.resolve()
    h.frames.run(10, 50)
    expect(balls[0].visible).toBe(true)
    // the lead ball's colour is the line's packet colour
    expect((balls[0].material as THREE.MeshBasicMaterial).color.getHexString()).toBe('60a5fa')
    const t0 = balls[0].position.clone()
    h.frames.step(50)
    expect(balls[0].position.distanceTo(t0)).toBeGreaterThan(0)
    for (let i = 0; i < 120 && !done; i++) { h.frames.step(50); await Promise.resolve(); await Promise.resolve() }
    await p
    expect(done).toBe(true)
    for (const b of balls) expect(b.visible).toBe(false)
    // cut short: the promise settles, the balls hide
    let early = false
    const q = r.pulse(['e1', 'e2'], false).then(() => { early = true })
    await Promise.resolve()
    h.frames.run(5, 50)
    r.stopPulses()
    await q
    expect(early).toBe(true)
    for (const b of balls) expect(b.visible).toBe(false)
    // an instant pulse does nothing
    await r.pulse(['e1'], true)
    r.dispose()
  })

  it('a pulse on a line with no packets (none drawn) runs white', async () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.draw(smallCity(), smallText(), false)
    h.frames.step()
    const world = worldOf(sceneOf())
    // strip e1's packets as a line without cargo would have them
    for (const p of packets(world).slice(0, 3)) p.removeFromParent()
    const p = r.pulse(['e1'], false)
    await Promise.resolve()
    h.frames.run(3, 50)
    const balls = pulseBalls(world)
    expect((balls[0].material as THREE.MeshBasicMaterial).color.getHexString()).toBe('60a5fa')
    r.stopPulses()
    await p
    r.dispose()
  })

  it('the verified ring turns, the wireframe pulses, a fading part breathes, fog drifts and dust rises', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    const m: SceneModel = {
      districts: [district('d', [0, 0, 0], 30)],
      buildings: [bldg('v', [-8, 0, 0], { ring: true }), bldg('w', [0, 0, 0], { look: 'wire' }), bldg('f', [8, 0, 0], { look: 'fading' })],
      conduits: [],
      orbs: [orb('o', [40, 0, 0], true)],
    }
    r.draw(m, emptyText(), false)
    h.frames.step() // the clock's first frame: no time has passed for it
    const world = worldOf(sceneOf())
    const seal = sealOf(world)
    expect(r.motionState().ringAngle).toBe(0)
    h.frames.run(10, 20)
    expect(seal.rotation.z).toBeCloseTo(10 * 0.02 * 0.8, 6)
    expect(r.motionState().ringAngle).toBe(seal.rotation.z)
    // fog drift: the first sprite's angle moved on, and motionState reports it
    expect(r.motionState().fogDrift).toBeGreaterThan(0)
    // the wireframe's outline pulses with the ghost level
    const ws = r.motionState().wirePulse
    expect(ws).toBeCloseTo(0.55 + 0.45 * Math.sin(0.2 * 2.2), 5)
    const wireLine = (floorsOf(world, 'w')[0].parent!.children[1] as THREE.LineSegments).material as THREE.LineBasicMaterial
    expect(wireLine.opacity).toBeCloseTo(0.6 * ws, 5)
    // the fading building breathes round FADE_MID (0.3) by FADE_AMP (0.15)
    const fadeFill = floorsOf(world, 'f')[0].material as THREE.Material
    expect(fadeFill.opacity).toBeCloseTo(0.3 + 0.15 * Math.sin(0.2 * Math.PI), 5)
    // dust rises, and wraps under the city past its top
    const dust = sceneOf().children.filter((c) => c instanceof THREE.Points)[1] as THREE.Points
    const ys = dust.geometry.getAttribute('position')
    const y0 = ys.getY(5)
    h.frames.step(20)
    expect(ys.getY(5) === -2 || ys.getY(5) > y0).toBe(true)
    h.frames.run(80, 50)
    for (let i = 0; i < ys.count; i++) expect(ys.getY(i)).toBeLessThanOrEqual(58.1)
    r.dispose()
  })

  it('opening a building spreads its floors and turns them, and runs its flow column; closing settles them', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.draw(smallCity(), smallText(), false)
    h.frames.step()
    const world = worldOf(sceneOf())
    expect(r.motionState().explodeGap).toBe(0)
    r.setExploded('x') // an orb never opens
    expect(r.motionState().exploded).toBeNull()
    r.setExploded('a')
    h.frames.run(80, 50)
    const ms = r.motionState()
    expect(ms.exploded).toBe('a')
    // top floor (k = 2, floor height 3): from 3*2 + 1.5 to 3*2*2.4 + 1.5 + 0.8
    expect(ms.explodeGap).toBeCloseTo(3 * 2 * 1.4 + 0.8, 3)
    const floors = floorsOf(world, 'a').map((m) => m.parent!)
    expect(floors.map((f) => f.rotation.y)).toEqual([expect.closeTo(-0.12, 3), expect.closeTo(0.12, 3), expect.closeTo(-0.12, 3)])
    const group = floors[0].parent!
    const flowLine = group.children.find((c) => c.type === 'Line')!
    expect(flowLine.visible).toBe(true)
    const dot = group.children.find((c) => (c as THREE.Mesh).isMesh && (c as THREE.Mesh).scale.x === 0.45) as THREE.Mesh
    expect(dot.visible).toBe(true)
    const y = dot.position.y
    h.frames.step(50)
    expect(dot.position.y).not.toBe(y)
    // the open building's floor labels show
    const fl = (floors[2].children.find((c) => (c as unknown as { isCSS2DObject?: boolean }).isCSS2DObject) as unknown as { element: HTMLElement })
    expect(fl.element.style.opacity).toBe('1')
    r.setExploded(null)
    h.frames.run(80, 50)
    expect(r.motionState().explodeGap).toBeCloseTo(0, 3)
    expect(flowLine.visible).toBe(false)
    expect(fl.element.style.opacity).toBe('0')
    // a redraw without the open building drops it; one with it keeps it open
    r.setExploded('a')
    r.draw(smallCity(), smallText(), false)
    expect(r.motionState().exploded).toBe('a')
    r.draw({ ...smallCity(), buildings: smallCity().buildings.filter((b) => b.id !== 'a') }, smallText(), false)
    expect(r.motionState().exploded).toBeNull()
    r.dispose()
  })

  it('camera flights land on their targets: a pose, the overview and a framing', async () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    await r.overview(true)
    const home = r.getCamera()
    const pose = { pos: [30, 40, 50] as [number, number, number], target: [1, 2, 3] as [number, number, number] }
    let landed = false
    const fly = r.flyTo(pose, false).then(() => { landed = true })
    h.frames.step(16)
    expect(r.motionState().flight.active).toBe(true)
    for (let i = 0; i < 200 && !landed; i++) { h.frames.step(20); await Promise.resolve() }
    await fly
    const at = r.getCamera()
    expect(dist(at.pos, pose.pos)).toBeLessThan(1e-3)
    expect(dist(at.target, pose.target)).toBeLessThan(1e-3)
    expect(r.motionState().flight.active).toBe(false)
    // back home
    const back = r.overview(false)
    for (let i = 0; i < 200; i++) h.frames.step(20)
    await back
    expect(dist(r.getCamera().pos, home.pos)).toBeLessThan(1e-3)
    // a building's framing, and a line's, and several parts together
    const fa = r.frame(['a'], false, ['b', 'nope'])
    for (let i = 0; i < 200; i++) h.frames.step(20)
    await fa
    const ca = r.getCamera()
    expect(dist(ca.target, [-6, 9 - 9 * 0.45, 0])).toBeLessThan(1e-3)
    await r.frame(['a', 'b', 'e1'], true)
    const cm = r.getCamera()
    expect(dist(cm.pos, cm.target)).toBeGreaterThanOrEqual(Math.hypot(30, 15) - 1e-6)
    await r.frame(['nope'], true) // nothing to frame: nothing changes
    expect(r.getCamera()).toEqual(cm)
    // an open building's framing stands back with its floors
    r.setExploded('a')
    await r.frame(['a'], true)
    const ce = r.getCamera()
    expect(dist(ce.pos, ce.target)).toBeCloseTo(Math.hypot(22 + 3 * 2.5, (22 + 3 * 2.5) * 0.5), 3)
    r.dispose()
  })

  it('reduced motion freezes the ring, the fog, the wireframe pulse and the selection ring; packets stand still', async () => {
    const r = createThreeRenderer(h.host, { quality: 'high', reducedMotion: true })
    const m: SceneModel = {
      ...smallCity(),
      buildings: [...smallCity().buildings, bldg('w', [0, 0, -10], { look: 'wire' }), bldg('f', [-10, 0, -10], { look: 'fading' })],
      orbs: [orb('x', [30, 0, 40], true)],
    }
    r.draw(m, smallText(), false)
    r.setSelected('a')
    const world = worldOf(sceneOf())
    const ps = packets(world)
    const at = ps.map((p) => p.position.clone())
    const fadeFill = floorsOf(world, 'f')[0].material as THREE.Material
    h.frames.run(30, 50)
    const ms = r.motionState()
    expect(ms.ringAngle).toBe(0)
    expect(ms.fogDrift).toBe(0)
    expect(ms.wirePulse).toBeCloseTo(0.55, 10)
    expect(ms.selectionRingAngle).toBe(0)
    expect(selRingOf(world).visible).toBe(true)
    ps.forEach((p, k) => expect(p.position.equals(at[k])).toBe(true))
    expect(fadeFill.opacity).toBeCloseTo(0.3, 10)
    // a pulse under reduced motion settles at once
    await r.pulse(['e1'], false)
    expect(pulseBalls(world).every((b) => !b.visible)).toBe(true)
    r.dispose()
  })

  it('motionState reports what is drawn: the selection ring turns, line labels count, no world reads zero', () => {
    const r = createThreeRenderer(h.host, { quality: 'low', reducedMotion: false })
    expect(r.motionState()).toMatchObject({ ringAngle: 0, fogDrift: 0, selectionRingAngle: 0, dust: 0, bloom: false, explodeGap: 0, lineLabels: 0 })
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), true)
    r.setSelected('a')
    h.frames.run(6, 20)
    const world = worldOf(sceneOf())
    const ring = selRingOf(world)
    expect(r.motionState().selectionRingAngle).toBe(ring.rotation.z)
    expect(ring.rotation.z).toBeGreaterThan(0)
    expect(ring.position.toArray()).toEqual([-6, 0.15, 0])
    const labelsShown = world.children.filter((c) => (c as unknown as { isCSS2DObject?: boolean }).isCSS2DObject && c.visible && (c as unknown as { element: HTMLElement }).element.className === 'lw-edge').length
    expect(r.motionState().lineLabels).toBe(labelsShown)
    // selecting the orb puts the ring under it; at the districts tier a building's ring hides
    r.setSelected('x')
    expect(ring.position.y).toBeCloseTo(-0.2)
    expect(ring.visible).toBe(true)
    r.setSelected(null)
    expect(ring.visible).toBe(false)
    expect(rendererOf().renders.length).toBeGreaterThan(0)
    r.dispose()
  })

  it('change animations rise and pulse the named parts, kept ghosts fade, and stopChanges ends them', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.draw(smallCity(), smallText(), false)
    h.frames.step()
    r.animateChanges({ rise: ['a', 'nope'], pulse: ['b', 'nope'] })
    expect(r.drawnCounts().changing).toBeGreaterThan(0)
    h.frames.run(3, 50)
    expect(r.drawnCounts().changing).toBeGreaterThan(0)
    h.frames.run(40, 50) // past RISE_MS and PULSE_MS
    expect(r.drawnCounts().changing).toBe(0)
    r.animateChanges({ rise: ['a'], pulse: [] })
    r.stopChanges()
    expect(r.drawnCounts().changing).toBe(0)
    r.keepGhosts(['c', 'nope'])
    expect(r.drawnCounts().changing).toBeGreaterThan(0)
    h.frames.run(40, 50)
    expect(r.drawnCounts().changing).toBe(0)
    r.dispose()
  })

  it('pausing stops the frames and resuming starts them again without a jump; a repeat or a disposed renderer does nothing', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.draw(smallCity(), smallText(), false)
    h.frames.run(3, 20)
    const seal = sealOf(worldOf(sceneOf()))
    const a = seal.rotation.z
    r.setPaused(true)
    expect(h.frames.pending()).toBe(0)
    r.setPaused(true)
    h.frames.advance(5000)
    h.frames.step(20)
    expect(seal.rotation.z).toBe(a)
    r.setPaused(false)
    r.setPaused(false)
    expect(h.frames.pending()).toBe(1)
    h.frames.step(20)
    expect(seal.rotation.z).toBeCloseTo(a + 0.02 * 0.8, 6) // not five seconds' worth
    r.dispose()
    r.setPaused(true)
    r.setPaused(false)
    expect(h.frames.pending()).toBe(0)
  })

  it('a panel opening eases the picture to the free area over frames (at once under reduced motion)', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.draw(smallCity(), smallText(), false)
    h.frames.step()
    const cam = cameraOf()
    const before = cam.aspect
    r.setRightReserve(200)
    r.setRightReserve(200) // unchanged: nothing
    h.frames.step(16)
    const mid = cam.aspect
    h.frames.run(60, 20)
    const end = cam.aspect
    expect(mid).not.toBe(before)
    expect(end).not.toBe(mid)
    r.setBottomReserve(80)
    r.setBottomReserve(80)
    h.frames.run(60, 20)
    // a card: a framing fits around it; closing it drops the framing where it is
    r.setCardReserve(300, 200)
    r.setCardReserve(300, 200)
    r.setCardReserve(0, 0)
    r.setCardReserve(-1, 5)
    r.dispose()

    const rr = createThreeRenderer(h.host, { quality: 'low', reducedMotion: true })
    rr.setRightReserve(200) // no world yet: only the picture moves, at once
    const c2 = cameraOf()
    expect(c2.view?.enabled).toBe(true)
    expect(c2.view!.fullWidth).toBeGreaterThan(800)
    rr.dispose()
  })

  it('floors in a closing building settle back into their batch; meanwhile the batch is refilled', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.draw(smallCity(), smallText(), false)
    r.setFocus({ ids: new Set(['a', 'b', 'c']), edgeIds: new Set() })
    h.frames.step()
    r.setExploded('a')
    h.frames.run(5, 50)
    r.setExploded(null)
    h.frames.run(80, 50)
    const world = worldOf(sceneOf())
    for (const fl of floorsOf(world, 'a')) expect(fl.visible).toBe(false) // drawn by the batch again
    expect(withData(world, 'nodeId').length).toBeGreaterThan(0)
    r.dispose()
  })
})
