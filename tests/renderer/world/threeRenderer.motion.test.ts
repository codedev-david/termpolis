// threeRenderer: motion and frames. Packets and pulses along the lines, the verified ring, opening a
// building, camera flights, reduced motion, change animations and pausing, at exact times (the frame
// stepper drives performance.now, which THREE.Clock, the camera rig and the change animator read).
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { createThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
import type { SceneModel } from '../../../src/renderer/src/world/engine/sceneModel'
import {
  bldg, boxCanvas, cameraOf, DEFAULT_OPTS, district, emptyText, floorsOf, makeHost, orb, packetBatches, rendererOf, sceneOf,
  smallCity, smallText, stagePart, withHarness, withData, worldOf,
} from './threeHarness'
import { MOTION_HZ } from '../../../src/renderer/src/world/engine/holoShaders'

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

  it('in a very tall, narrow view the overview stands far back, and the city and the stars stay nearer than the far plane (5120x2880 pane 480)', async () => {
    // A pane 480 wide at 5K draws at twice the size: a view 240 by 1350, where the overview of a wide
    // city stands thousands of units back. Past the camera's far plane the whole picture was black.
    const tall = makeHost(240, 1350)
    const r = createThreeRenderer(tall, DEFAULT_OPTS)
    boxCanvas(r.canvas, 240, 1350)
    const at = (k: number): [number, number, number] => [(k % 6) * 90 - 225, 0, Math.floor(k / 6) * 90 - 180]
    const ks = Array.from({ length: 30 }, (_, k) => k)
    r.draw({ districts: ks.map((k) => district(`d${k}`, at(k), 35)), buildings: ks.map((k) => bldg(`b${k}`, at(k))), conduits: [], orbs: [] }, smallText(), false)
    await r.overview(true)
    h.frames.step()
    const cam = cameraOf()
    cam.updateMatrixWorld()
    expect(cam.position.length()).toBeGreaterThan(3000) // the case: far past the old fixed far plane
    // every district's middle is in the picture, nearer than the far plane
    for (const k of ks) {
      const v = new THREE.Vector3(...at(k)).project(cam)
      expect(Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z > -1 && v.z < 1, `d${k}`).toBe(true)
    }
    // and every star, wherever the camera can be zoomed out to, behind the city and before the far plane
    const stars = sceneOf().children.find((o) => o instanceof THREE.Points && !(o.material as THREE.PointsMaterial).fog) as THREE.Points
    stars.updateMatrixWorld()
    const p = stars.geometry.getAttribute('position')
    const v = new THREE.Vector3()
    let inner = Infinity
    let far = 0
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(stars.matrixWorld)
      inner = Math.min(inner, v.length())
      far = Math.max(far, v.distanceTo(cam.position))
    }
    expect(far).toBeLessThan(cam.far)
    // the camera is inside the shell: no star stands between it and the city
    expect(inner).toBeGreaterThan(cam.position.length())
    // pushed out, each star grows with the field (its size attenuates with distance), so the stars still show
    const mat = stars.material as THREE.PointsMaterial
    expect(stars.scale.x).toBeGreaterThan(1)
    expect(mat.size).toBeCloseTo(1.6 * stars.scale.x, 6)
    r.dispose()
    tall.remove()
    // an ordinary world in an ordinary view keeps the far plane, the near plane and the stars as they were
    const plain = createThreeRenderer(h.host, DEFAULT_OPTS)
    boxCanvas(plain.canvas, 800, 600)
    plain.draw(smallCity(), smallText(), false)
    await plain.overview(true)
    const c = cameraOf()
    const s = sceneOf().children.find((o) => o instanceof THREE.Points && !(o.material as THREE.PointsMaterial).fog) as THREE.Points
    expect([c.far, c.near, s.scale.x, (s.material as THREE.PointsMaterial).size]).toEqual([3000, 0.1, 1, 1.6])
    plain.dispose()
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
    const r = createThreeRenderer(h.host, { quality: 'flat', reducedMotion: false })
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

  it('keeps a right strip under three times its width only from the view width its owner names', () => {
    const r = createThreeRenderer(h.host, { quality: 'low', reducedMotion: true })
    r.draw(smallCity(), smallText(), false)
    h.frames.step()
    // A 300 px strip in this 800 px view is under three times the strip: by itself, not kept.
    r.setRightReserve(300)
    h.frames.step()
    expect(cameraOf().view?.enabled ?? false).toBe(false)
    // Its owner (the exported page's Ask box) keeps it clear from 700 px: kept, the picture's centre moves left.
    r.setRightReserve(300, 700)
    r.setRightReserve(300, 700) // unchanged: nothing
    h.frames.step()
    expect(cameraOf().view?.enabled).toBe(true)
    expect(cameraOf().view!.fullWidth).toBe(800 + 300)
    r.dispose()
  })

  it('an opened legend in a 640 px view glides the city clear of its 244 px strip when its owner names 600 px (and not without)', () => {
    // The pane at 1366x768 dragged to 640: the expanded legend's strip is kept from 600 px wide (WorldLegend
    // legendReserveFrom). Followed through the glide to where the camera comes to rest, every building's
    // footprint and roof, and every district's rim, lies left of the strip.
    const rightmost = (reduced: boolean, from?: number): number => {
      const host = makeHost(640, 622)
      const r = createThreeRenderer(host, { quality: 'low', reducedMotion: reduced })
      const city = smallCity()
      r.draw(city, smallText(), false)
      h.frames.run(60, 20)
      r.setRightReserve(244, from)
      h.frames.run(150, 20)
      const cam = cameraOf()
      const world = worldOf(sceneOf())
      world.updateMatrixWorld(true)
      cam.updateMatrixWorld(true)
      const pts: THREE.Vector3[] = []
      for (const b of city.buildings) {
        for (const [dx, dz] of [[2.5, 2.5], [-2.5, 2.5], [2.5, -2.5], [-2.5, -2.5]]) {
          pts.push(new THREE.Vector3(b.pos[0] + dx, b.pos[1], b.pos[2] + dz), new THREE.Vector3(b.pos[0] + dx, b.pos[1] + b.height, b.pos[2] + dz))
        }
      }
      for (const d of city.districts) {
        // The platform's foot as drawn: a hexagon 1.05 times the radius, corners where CylinderGeometry lays them.
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2
          pts.push(new THREE.Vector3(d.pos[0] + Math.sin(a) * d.radius * 1.05, d.pos[1] - 1.2, d.pos[2] + Math.cos(a) * d.radius * 1.05))
        }
      }
      const xs = pts.map((p) => ((world.localToWorld(p.clone()).project(cam).x + 1) / 2) * 640)
      r.dispose()
      host.remove()
      return Math.max(...xs)
    }
    expect(rightmost(true, 600)).toBeLessThanOrEqual(640 - 244)
    expect(rightmost(false, 600)).toBeLessThanOrEqual(640 - 244)
    // Without the owner's width the 3x rule (732 px) drops the strip, and the city runs under the legend.
    expect(rightmost(false)).toBeGreaterThan(640 - 244)
  })

  it('an opening building and a panel glide reach the same state at the same wall time at 10, 30 and 60 fps', () => {
    // Below 20 fps a frame step cut at 0.05 s ran every ease in slow motion; only a tab-switch spike is cut now.
    const at = (fps: number): { gap: number; aspect: number } => {
      const r = createThreeRenderer(h.host, DEFAULT_OPTS)
      r.draw(smallCity(), smallText(), false)
      h.frames.step()
      r.setExploded('a')
      r.setRightReserve(200)
      h.frames.run(Math.round(fps * 0.4), 1000 / fps)
      const out = { gap: r.motionState().explodeGap, aspect: cameraOf().aspect }
      r.dispose()
      return out
    }
    const at60 = at(60)
    expect(at60.gap).toBeGreaterThan(0)
    expect(at60.gap).toBeLessThan(3 * 2 * 1.4 + 0.8 - 0.1) // still on its way: the comparison is mid-ease
    for (const fps of [10, 30]) {
      const got = at(fps)
      expect(got.gap).toBeCloseTo(at60.gap, 2)
      expect(got.aspect).toBeCloseTo(at60.aspect, 3)
    }
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

describe('threeRenderer Holotable stage motion', () => {
  /** The disc's uniforms, as the last frame set them. */
  const discU = (): Record<string, { value: unknown }> => (stagePart(sceneOf(), 'disc')!.material as THREE.ShaderMaterial).uniforms
  const uTime = (kind: string): number => ((stagePart(sceneOf(), kind)!.material as THREE.ShaderMaterial).uniforms.uTime.value as number)
  /** Where the dust points stand now (a copy). */
  const dustAt = (): number[] => Array.from((sceneOf().getObjectByName('holo-dust') as THREE.Points).geometry.getAttribute('position').array)

  it('the sweep runs only while working, and never under reduced motion', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.draw(smallCity(), smallText(), false)
    h.frames.run(20, 50)
    expect(r.motionState().sweep).toBe(0)
    expect(discU().uSweepOn.value).toBe(0)
    // Working: the sweep turns at MOTION_HZ.sweep turns a second, and the disc shows it.
    r.setWorking(true)
    h.frames.run(20, 50) // a second
    const s1 = r.motionState().sweep
    expect(s1).toBeGreaterThan(0.9 * MOTION_HZ.sweep)
    expect(s1).toBeLessThanOrEqual(1.05 * MOTION_HZ.sweep)
    expect(discU().uSweepOn.value).toBe(1)
    expect(discU().uSweep.value).toBe(s1)
    r.setWorking(true) // no change
    // Done: it holds where it was and the disc stops showing it.
    r.setWorking(false)
    h.frames.run(20, 50)
    expect(r.motionState().sweep).toBe(s1)
    expect(discU().uSweepOn.value).toBe(0)
    // Working, then reduced motion turned on mid-session: nothing sweeps, and the sweep rests at t = 0 (look spec §3.4).
    r.setWorking(true)
    h.frames.run(5, 50)
    expect(r.motionState().sweep).toBeGreaterThan(s1)
    r.setReducedMotion(true)
    h.frames.run(20, 50)
    expect(r.motionState().sweep).toBe(0)
    expect(discU().uSweep.value).toBe(0)
    expect(discU().uSweepOn.value).toBe(0)
    // Motion back on at Low: it sweeps again from t = 0; the tier changed to Flat mid-session, the scan lines rest at t = 0.
    r.setReducedMotion(false)
    r.setTier('low')
    h.frames.run(20, 50)
    const s2 = r.motionState().sweep
    expect(s2).toBeGreaterThan(0.9 * MOTION_HZ.sweep)
    expect(s2).toBeLessThanOrEqual(1.05 * MOTION_HZ.sweep)
    r.setTier('flat')
    h.frames.run(20, 50)
    expect(r.motionState().sweep).toBe(0)
    expect(discU().uSweep.value).toBe(0)
    expect(discU().uSweepOn.value).toBe(0)
    r.dispose()
    r.setWorking(false) // after dispose: nothing
  })

  it('the disc arcs, the shafts, the beams and the dust move at High and Low, and rest at t = 0 at Flat and under reduced motion', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    expect(r.motionState()).toMatchObject({ discAngle: 0, sweep: 0, dustDrift: 0 })
    const home = dustAt()
    r.draw(smallCity(), smallText(), false)
    h.frames.run(20, 50)
    const a1 = r.motionState()
    expect(a1.discAngle).toBeGreaterThan(0)
    expect(a1.discAngle).toBeCloseTo(uTime('disc') * MOTION_HZ.arcA * Math.PI * 2, 10)
    expect(a1.dustDrift).toBeGreaterThan(0)
    expect(uTime('shafts')).toBe(uTime('disc'))
    expect(uTime('beams')).toBe(uTime('disc'))
    r.setTier('low')
    h.frames.run(20, 50)
    const a2 = r.motionState()
    expect(a2.discAngle).toBeGreaterThan(a1.discAngle)
    expect(a2.dustDrift).toBeGreaterThan(a1.dustDrift)
    expect(dustAt()).not.toEqual(home)
    // The tier changed to Flat mid-session: the arcs, the shafts, the beams and the dust rest at t = 0 (look spec §3.4).
    r.setTier('flat')
    h.frames.run(20, 50)
    expect(r.motionState()).toMatchObject({ discAngle: 0, dustDrift: 0 })
    for (const kind of ['disc', 'shafts', 'beams']) expect(uTime(kind)).toBe(0)
    expect(dustAt()).toEqual(home)
    // High again: they move from t = 0; reduced motion turned on mid-session rests them at t = 0 again.
    r.setTier('high')
    h.frames.run(20, 50)
    expect(r.motionState().discAngle).toBeGreaterThan(0)
    expect(r.motionState().dustDrift).toBeGreaterThan(0)
    expect(dustAt()).not.toEqual(home)
    r.setReducedMotion(true)
    h.frames.run(20, 50)
    expect(r.motionState()).toMatchObject({ discAngle: 0, sweep: 0, dustDrift: 0 })
    for (const kind of ['disc', 'shafts', 'beams']) expect(uTime(kind)).toBe(0)
    expect(dustAt()).toEqual(home)
    r.dispose()
  })

  it('an idle world at Flat sleeps while working: Flat has no sweep to draw', () => {
    const r = createThreeRenderer(h.host, { quality: 'flat', reducedMotion: false })
    const calm: SceneModel = { districts: [district('d', [0, 0, 0], 20)], buildings: [bldg('p', [-4, 0, 0])], conduits: [], orbs: [] }
    r.draw(calm, smallText(), false)
    void r.overview(true) // ends the opening turn
    r.setWorking(true)
    let n = 0
    while (h.frames.pending() > 0 && n < 2000) { h.frames.step(); n++ }
    expect(h.frames.pending()).toBe(0)
    // At Low the same world keeps drawing (the sweep, the disc's arcs and the dust).
    r.setTier('low')
    h.frames.run(5)
    expect(h.frames.pending()).toBe(1)
    r.dispose()
  })
})
