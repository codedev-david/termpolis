import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  addSlabAttributes, createPlates, createSlabLook, pulseOf, SLAB_ATTRS, slabsWritten, writeSlab,
} from '../../../src/renderer/src/world/engine/holoSlab'
import {
  easePlate, PLATE_FOCUS, PLATE_FRAG, PLATE_GAIN, PLATE_REACH, PLATE_VERT, PLATE_WAVE_S, SLAB_FRAG, SLAB_GAIN, SLAB_VERT,
} from '../../../src/renderer/src/world/engine/holoShaders'
import { PLATFORM_ORDER } from '../../../src/renderer/src/world/engine/batching'

const COLORS = { heat: '#ff8a3d', ghost: '#88a0b8', fogTint: '#203040' }

describe('holoSlab', () => {
  it('a floor pulses brighter only over its resting glow', () => {
    expect(pulseOf(0.16, 0.16)).toBe(1)
    expect(pulseOf(0.1, 0.16)).toBe(1)
    expect(pulseOf(1.76, 0.16)).toBeCloseTo(2.6)
  })

  it('the box and hex slab materials share one look: tier gain, time, wire and fade reach both', () => {
    const look = createSlabLook('high', '#ff8a3d')
    const box = look.material(true)
    const hex = look.material(false)
    for (const m of [box, hex]) {
      expect(m).toBeInstanceOf(THREE.ShaderMaterial)
      expect([m.vertexShader, m.fragmentShader]).toEqual([SLAB_VERT, SLAB_FRAG])
      expect([m.transparent, m.depthWrite, m.blending, m.side]).toEqual([true, false, THREE.AdditiveBlending, THREE.DoubleSide])
      expect(m.extensions.derivatives).toBe(true)
    }
    expect([box.customProgramCacheKey(), hex.customProgramCacheKey()]).toEqual(['lw-slab-box', 'lw-slab-hex'])
    expect([box.uniforms.uEdges.value, hex.uniforms.uEdges.value]).toEqual([1, 0])
    expect(box.uniforms.uGain.value).toBe(SLAB_GAIN.bloomed)
    look.setTier('flat')
    expect([box.uniforms.uGain.value, hex.uniforms.uGain.value]).toEqual([SLAB_GAIN.flat, SLAB_GAIN.flat])
    look.tick(3, 0.4, 0.7)
    for (const m of [box, hex]) expect([m.uniforms.uTime.value, m.uniforms.uWire.value, m.uniforms.uFade.value]).toEqual([3, 0.4, 0.7])
    expect(look.uniforms.uTime.value).toBe(3)
  })

  it('at Flat a slab keeps the brightest layer under it, not their sum, as no composer tone-maps the sum there', () => {
    const look = createSlabLook('flat', '#ff8a3d')
    const mats = [look.material(true), look.material(false)]
    const blend = (m: THREE.Material): unknown[] => [m.blending, m.blendEquation, m.blendSrc, m.blendDst]
    const max = [THREE.CustomBlending, THREE.MaxEquation, THREE.OneFactor, THREE.OneFactor]
    for (const m of mats) expect(blend(m)).toEqual(max)
    look.setTier('low')
    for (const m of mats) expect(m.blending).toBe(THREE.AdditiveBlending)
    look.setTier('flat')
    for (const m of mats) expect(blend(m)).toEqual(max)
    look.setTier('high')
    expect(mats.map((m) => m.blending)).toEqual([THREE.AdditiveBlending, THREE.AdditiveBlending])
    // A material made after the tier changed starts in that tier's blend, not the one the look was made at.
    expect(look.material(true).blending).toBe(THREE.AdditiveBlending)
    // A disposed material is let go: the look holds no batch's material past its batch.
    mats[0].dispose()
    look.setTier('flat')
    expect(mats.map((m) => m.blending)).toEqual([THREE.AdditiveBlending, THREE.CustomBlending])
  })

  it('every slab material adds at High and Low and keeps the brightest layer at Flat, live on setTier; the plates add at every tier', () => {
    const blend = (m: THREE.Material): unknown[] => [m.blending, m.blendEquation, m.blendSrc, m.blendDst]
    const max = [THREE.CustomBlending, THREE.MaxEquation, THREE.OneFactor, THREE.OneFactor]
    const tiers = ['high', 'low', 'flat'] as const
    for (const first of tiers) {
      const look = createSlabLook(first, '#ff8a3d')
      const plates = createPlates(specs, first, COLORS)
      const mats = [look.material(true), look.material(false), look.material(true)]
      for (const t of [...tiers, ...tiers].reverse()) {
        look.setTier(t)
        plates.setTier(t)
        mats.push(look.material(false)) // one made at this tier
        for (const m of mats) {
          if (t === 'flat') expect(blend(m)).toEqual(max)
          else expect(m.blending).toBe(THREE.AdditiveBlending)
        }
        expect((plates.mesh.material as THREE.Material).blending).toBe(THREE.AdditiveBlending)
      }
      plates.dispose()
    }
  })

  it('without a MAX blend equation (WebGL 1 with no EXT_blend_minmax) the Flat slabs add, on the cut gain', () => {
    const look = createSlabLook('flat', '#ff8a3d', false)
    const mats = [look.material(true), look.material(false)]
    expect(mats.map((m) => m.blending)).toEqual([THREE.AdditiveBlending, THREE.AdditiveBlending])
    expect(look.uniforms.uGain.value).toBe(SLAB_GAIN.flatAdded)
    expect(SLAB_GAIN.flatAdded).toBeLessThan(SLAB_GAIN.flat)
    look.setTier('high')
    expect(look.uniforms.uGain.value).toBe(SLAB_GAIN.bloomed)
    look.setTier('flat')
    expect([...mats, look.material(true)].map((m) => m.blending)).toEqual([THREE.AdditiveBlending, THREE.AdditiveBlending, THREE.AdditiveBlending])
    expect(look.uniforms.uGain.value).toBe(SLAB_GAIN.flatAdded)
    // With the equation (the default) the same look at Flat is max, on the full Flat gain.
    const withMax = createSlabLook('flat', '#ff8a3d', true)
    expect([withMax.material(true).blending, withMax.uniforms.uGain.value]).toEqual([THREE.CustomBlending, SLAB_GAIN.flat])
  })

  it('a slab instance carries its state, heat, stack, look and edge colour', () => {
    const g = addSlabAttributes(new THREE.BoxGeometry(1, 1, 1), 4, true)
    for (const a of SLAB_ATTRS) {
      const b = g.attributes[a] as THREE.InstancedBufferAttribute
      expect(b).toBeInstanceOf(THREE.InstancedBufferAttribute)
      expect([b.count, b.itemSize, b.usage]).toEqual([4, 1, THREE.DynamicDrawUsage])
    }
    expect((g.attributes.lineColor as THREE.InstancedBufferAttribute).itemSize).toBe(3)
    writeSlab(g, 2, { state: 1.5, heat: 0.4, stack: 3, look: 1, line: new THREE.Color(0.1, 0.2, 0.3) })
    expect(SLAB_ATTRS.map((a) => g.attributes[a].getX(2))).toEqual([1.5, Math.fround(0.4), 3, 1])
    expect([g.attributes.lineColor.getX(2), g.attributes.lineColor.getY(2), g.attributes.lineColor.getZ(2)]).toEqual([0.1, 0.2, 0.3].map(Math.fround))
    const sent = [...SLAB_ATTRS, 'lineColor']
    const v0 = sent.map((a) => (g.attributes[a] as THREE.BufferAttribute).version)
    slabsWritten(g)
    // Each slab attribute and the edge colour go to the GPU, once a call.
    expect(sent.map((a, i) => (g.attributes[a] as THREE.BufferAttribute).version - v0[i])).toEqual([1, 1, 1, 1, 1])
    // A hexagonal slab has no edge colour (its edges are lines): none is asked for, and one given is ignored.
    const h = addSlabAttributes(new THREE.CylinderGeometry(1, 1, 1, 6), 2, false)
    expect(h.attributes.lineColor).toBeUndefined()
    writeSlab(h, 1, { state: -1, heat: 0, stack: 0, look: 4, line: new THREE.Color(1, 1, 1) })
    writeSlab(h, 0, { state: 0, heat: 0, stack: 0, look: 3 })
    slabsWritten(h)
    expect([h.attributes.aState.getX(1), h.attributes.aLook.getX(1), h.attributes.aLook.getX(0)]).toEqual([-1, 4, 3])
  })

  const specs = [
    { id: 'a', pos: [10, 0, -5], radius: 20, color: '#2ad4ff', gain: 0.5 },
    { id: 'b', pos: [-30, 0, 8], radius: 12, color: '#ff40a0', gain: 1 },
  ]

  it('the plates are one instanced quad of the plate shader, each scaled by its radius, coloured by its share', () => {
    const p = createPlates(specs, 'high', COLORS)
    const m = p.mesh.material as THREE.ShaderMaterial
    expect([m.vertexShader, m.fragmentShader, m.customProgramCacheKey()]).toEqual([PLATE_VERT, PLATE_FRAG, 'lw-plate'])
    expect([m.blending, m.depthWrite]).toEqual([THREE.AdditiveBlending, false])
    expect(p.mesh.count).toBe(2)
    expect(p.mesh.userData.plateIds).toEqual(['a', 'b'])
    expect(p.mesh.renderOrder).toBe(PLATFORM_ORDER)
    const mt = new THREE.Matrix4()
    p.mesh.getMatrixAt(0, mt)
    const pos = new THREE.Vector3(); const q = new THREE.Quaternion(); const s = new THREE.Vector3()
    mt.decompose(pos, q, s)
    expect([pos.x, pos.z]).toEqual([10, -5])
    expect(pos.y).toBeCloseTo(-0.05) // just under the buildings' feet
    expect([s.x, s.y, s.z]).toEqual([20, 1, 20])
    const c = new THREE.Color()
    p.mesh.getColorAt(0, c)
    const want = new THREE.Color('#2ad4ff').multiplyScalar(0.5)
    expect(c.r).toBeCloseTo(want.r)
    // The quad reaches past the hexagon's corners (radius 1) to hold its halo.
    p.mesh.geometry.computeBoundingBox()
    expect((p.mesh.geometry.boundingBox as THREE.Box3).max.x).toBeCloseTo(PLATE_REACH)
    expect(m.uniforms.uGain.value).toBe(PLATE_GAIN.bloomed)
    p.setTier('flat')
    expect(m.uniforms.uGain.value).toBe(PLATE_GAIN.flat)
    p.setFar(true)
    expect(m.uniforms.uFar.value).toBe(1)
    p.setFar(false)
    expect(m.uniforms.uFar.value).toBe(0)
    p.pulse(0.3, 0.6)
    expect([m.uniforms.uWire.value, m.uniforms.uFade.value]).toEqual([0.3, 0.6])
    p.setSignals(new Map([['b', { heat: 0.8, look: 3, outline: true }]]))
    const at = p.mesh.geometry.attributes
    expect([at.aHeat.getX(0), at.aLook.getX(0), at.aOutline.getX(0)]).toEqual([0, 0, 0])
    expect([at.aHeat.getX(1), at.aLook.getX(1), at.aOutline.getX(1)]).toEqual([Math.fround(0.8), 3, 1])
    p.setSignals(new Map([['b', { heat: 0, look: 0, outline: false }]]))
    expect(at.aOutline.getX(1)).toBe(0)
    p.dispose()
  })

  it('a plate focus eases by time, not per frame', () => {
    const run = (fps: number): number => {
      const p = createPlates(specs, 'high', COLORS)
      p.setTargets((id) => (id === 'a' ? PLATE_FOCUS.lit : PLATE_FOCUS.dimmed))
      for (let i = 0; i < fps / 4; i++) p.tick(1 / fps, false)
      return p.focusOf('a') as number
    }
    expect(run(32)).toBeCloseTo(run(144), 6)
    expect(run(60)).toBeCloseTo(easePlate(0, PLATE_FOCUS.lit, 0.25), 6)
    const p = createPlates(specs, 'high', COLORS)
    p.setTargets(() => PLATE_FOCUS.lit)
    expect(p.tick(1 / 60, false)).toBe(true) // still easing
    for (let i = 0; i < 300; i++) p.tick(1 / 60, false)
    expect(p.focusOf('a')).toBe(PLATE_FOCUS.lit) // snapped on arrival
    expect(p.tick(1 / 60, false)).toBe(false) // nothing moves: the loop may sleep
    expect(p.mesh.geometry.attributes.aFocus.getX(1)).toBe(PLATE_FOCUS.lit)
    // Reduced motion: the focus lands at once.
    p.setTargets(() => PLATE_FOCUS.dimmed)
    expect(p.tick(1 / 60, true)).toBe(false)
    expect(p.focusOf('b')).toBe(PLATE_FOCUS.dimmed)
    expect(p.focusOf('nowhere')).toBeUndefined()
    expect(p.waveOf('nowhere')).toBeUndefined()
  })

  it('a plate sends its focus and its wave only on a frame that changed them', () => {
    const p = createPlates(specs, 'high', COLORS)
    const at = p.mesh.geometry.attributes as Record<string, THREE.BufferAttribute>
    const sent = (): number[] => [at.aFocus.version, at.aWave.version]
    let v = sent()
    p.tick(1 / 60, false) // every focus at its target (0), no wave: nothing to send
    expect(sent()).toEqual(v)
    p.setTargets((id) => (id === 'a' ? PLATE_FOCUS.lit : PLATE_FOCUS.rest))
    p.tick(1 / 60, false)
    expect(sent()).toEqual([v[0] + 1, v[1]]) // the focus eased; still no wave
    for (let i = 0; i < 300; i++) p.tick(1 / 60, false)
    v = sent()
    p.tick(1 / 60, false) // arrived: the focus holds
    expect(sent()).toEqual(v)
    p.wave(['b'])
    p.tick(PLATE_WAVE_S / 2, false)
    expect(sent()).toEqual([v[0], v[1] + 1]) // the wave ran; no focus moved
    p.tick(PLATE_WAVE_S, false)
    expect([at.aWave.getX(1), at.aWave.version]).toEqual([0, v[1] + 2]) // its end is sent, as 0
    p.tick(1 / 60, false)
    expect(sent()).toEqual([v[0], v[1] + 2])
  })

  it('the plates free their quad and material once and leave the scene', () => {
    const p = createPlates(specs, 'high', COLORS)
    const parent = new THREE.Group()
    parent.add(p.mesh)
    const freed = { geometry: 0, material: 0, mesh: 0 }
    p.mesh.geometry.addEventListener('dispose', () => { freed.geometry++ })
    ;(p.mesh.material as THREE.Material).addEventListener('dispose', () => { freed.material++ })
    p.mesh.addEventListener('dispose', () => { freed.mesh++ })
    p.dispose()
    expect(freed).toEqual({ geometry: 1, material: 1, mesh: 1 })
    expect(p.mesh.parent).toBeNull()
    expect(parent.children).toEqual([])
  })

  it('a wave crosses a plate once, on a change or a selection, and none runs under reduced motion', () => {
    const p = createPlates(specs, 'high', COLORS)
    p.wave(['a', 'nowhere'])
    expect(p.waveOf('a')).toBeGreaterThan(0)
    expect(p.waveOf('b')).toBe(0)
    expect(p.tick(PLATE_WAVE_S / 2, false)).toBe(true)
    expect(p.waveOf('a')).toBeCloseTo(0.5, 2)
    expect(p.mesh.geometry.attributes.aWave.getX(0)).toBeCloseTo(0.5, 2)
    expect(p.tick(PLATE_WAVE_S, false)).toBe(false) // done: back to no wave
    expect(p.waveOf('a')).toBe(0)
    // Selecting a plate starts its wave; it does not start again while it stays selected.
    p.setTargets((id) => (id === 'b' ? PLATE_FOCUS.selected : PLATE_FOCUS.dimmed))
    expect(p.waveOf('b')).toBeGreaterThan(0)
    for (let i = 0; i < 200; i++) p.tick(1 / 60, false)
    expect(p.waveOf('b')).toBe(0)
    p.setTargets((id) => (id === 'b' ? PLATE_FOCUS.selected : PLATE_FOCUS.dimmed))
    expect(p.waveOf('b')).toBe(0)
    p.wave(['a'])
    p.tick(1 / 60, true)
    expect(p.waveOf('a')).toBe(0)
  })
})

