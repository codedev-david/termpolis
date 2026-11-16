// "Watch it grow" animations on real Three.js objects (no WebGL needed: only scene graph, scale,
// material fields and dispose are touched). The renderer drives tick() from its frame loop.
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { createChangeAnimator, FADE_MS, PULSE_MS, RISE_MS } from '../../../src/renderer/src/world/engine/changeAnimation'

/** A building-like group: one floor mesh (standard material), its edge lines, a label and a shared-geometry dot. */
function part(sharedGeo: THREE.BufferGeometry) {
  const g = new THREE.Group()
  const geo = new THREE.BoxGeometry(1, 1, 1)
  const floorMat = new THREE.MeshStandardMaterial({ emissiveIntensity: 0.16, transparent: true, opacity: 0.88 })
  const lineMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 1 })
  const dotMat = new THREE.MeshBasicMaterial() // not transparent: fading must switch it on
  g.add(new THREE.Mesh(geo, floorMat))
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), lineMat))
  g.add(new THREE.Mesh(sharedGeo, dotMat))
  const el = document.createElement('div')
  document.body.appendChild(el)
  const label = new CSS2DObject(el)
  g.add(label)
  return { g, geo, floorMat, lineMat, dotMat, label, el }
}

function setup() {
  const world = new THREE.Group()
  const layer = new THREE.Group()
  const sharedGeo = new THREE.SphereGeometry(1)
  const anim = createChangeAnimator(layer, new Set([sharedGeo]))
  return { world, layer, sharedGeo, anim }
}

describe('createChangeAnimator', () => {
  it('rises a part from flat to full height over RISE_MS, easing out', () => {
    const { world, anim } = setup()
    const a = part(new THREE.SphereGeometry(1))
    world.add(a.g)
    anim.start([a.g], [], 1000)
    expect(a.g.scale.y).toBeGreaterThan(0)
    expect(a.g.scale.y).toBeLessThan(0.01) // flat before the first frame draws
    expect(anim.active()).toBe(1)
    anim.tick(1000 + RISE_MS / 2)
    expect(a.g.scale.y).toBeCloseTo(1 - 0.5 ** 3) // ease-out cubic: past halfway at half time
    expect(a.g.scale.x).toBe(1)
    anim.tick(1000 + RISE_MS)
    expect(a.g.scale.y).toBe(1)
    expect(anim.active()).toBe(0)
    expect(RISE_MS).toBe(900)
  })

  it('pulses the emissive glow of standard materials for PULSE_MS, then restores it', () => {
    const { anim } = setup()
    const a = part(new THREE.SphereGeometry(1))
    anim.start([], [a.floorMat, a.lineMat], 0)
    expect(anim.active()).toBe(1) // the line material has no glow to pulse
    anim.tick(PULSE_MS / 2)
    expect(a.floorMat.emissiveIntensity).toBeGreaterThan(1)
    anim.tick(PULSE_MS)
    expect(a.floorMat.emissiveIntensity).toBe(0.16)
    expect(anim.active()).toBe(0)
    expect(PULSE_MS).toBe(1200)
  })

  it('keeps a removed part out of the world, fades it, then frees it (never the shared geometry)', () => {
    const { world, layer, sharedGeo, anim } = setup()
    const a = part(sharedGeo)
    world.add(a.g)
    const geoDispose = vi.spyOn(a.geo, 'dispose')
    const sharedDispose = vi.spyOn(sharedGeo, 'dispose')
    const matDispose = vi.spyOn(a.floorMat, 'dispose')
    anim.keep([a.g], 0)
    expect(a.g.parent).toBe(layer)
    expect(world.children).toHaveLength(0)
    // Its label leaves at once: a fading caption would float over the city.
    expect(a.label.parent).toBeNull()
    expect(a.el.isConnected).toBe(false)
    expect(a.dotMat.transparent).toBe(true)
    expect(anim.active()).toBe(1)
    anim.tick(FADE_MS / 2)
    expect(a.floorMat.opacity).toBeCloseTo(0.44)
    expect(a.lineMat.opacity).toBeCloseTo(0.5)
    anim.tick(FADE_MS)
    expect(layer.children).toHaveLength(0)
    expect(geoDispose).toHaveBeenCalled()
    expect(matDispose).toHaveBeenCalled()
    expect(sharedDispose).not.toHaveBeenCalled()
    expect(anim.active()).toBe(0)
    expect(FADE_MS).toBe(900)
  })

  it('settle ends rises and pulses at once but lets kept parts go on fading (a redraw mid-change)', () => {
    const { layer, anim } = setup()
    const rising = part(new THREE.SphereGeometry(1))
    const gone = part(new THREE.SphereGeometry(1))
    anim.keep([gone.g], 0)
    anim.start([rising.g], [rising.floorMat], 0)
    anim.tick(100)
    anim.settle()
    expect(rising.g.scale.y).toBe(1)
    expect(rising.floorMat.emissiveIntensity).toBe(0.16)
    expect(anim.active()).toBe(1)
    expect(layer.children).toEqual([gone.g])
  })

  it('stop ends everything: risen, glow restored, kept parts freed, nothing left running', () => {
    const { layer, anim } = setup()
    const rising = part(new THREE.SphereGeometry(1))
    const gone = part(new THREE.SphereGeometry(1))
    const matDispose = vi.spyOn(gone.lineMat, 'dispose')
    anim.keep([gone.g], 0)
    anim.start([rising.g], [rising.floorMat], 0)
    anim.tick(300)
    anim.stop()
    expect(rising.g.scale.y).toBe(1)
    expect(rising.floorMat.emissiveIntensity).toBe(0.16)
    expect(layer.children).toHaveLength(0)
    expect(matDispose).toHaveBeenCalled()
    expect(anim.active()).toBe(0)
    anim.tick(5000) // nothing to do
    anim.stop()
  })

  it('frees a kept mesh that carries an array of materials', () => {
    const { anim } = setup()
    const g = new THREE.Group()
    const m1 = new THREE.MeshBasicMaterial()
    const m2 = new THREE.MeshBasicMaterial()
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [m1, m2]))
    const d1 = vi.spyOn(m1, 'dispose')
    const d2 = vi.spyOn(m2, 'dispose')
    anim.keep([g], 0)
    anim.stop()
    expect(d1).toHaveBeenCalled()
    expect(d2).toHaveBeenCalled()
  })
})
