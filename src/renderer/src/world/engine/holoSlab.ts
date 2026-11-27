/**
 * The hologram slabs and the district plates as three.js objects (look spec §3.2, §3.3), so threeRenderer only wires
 * them: one slab look (its uniforms shared by the batched floors, a unit box each, and the districts' hexagonal slabs),
 * the per-instance attributes the slab shader reads (aState, aHeat, aStack, aLook and the edge colour), and the
 * district plates, one instanced quad each drawn by the plate shader, whose focus eases by time and whose wave runs
 * once across a plate on a change.
 */
import * as THREE from 'three'
import { PLATFORM_ORDER } from './batching'
import {
  easePlate, PLATE_FOCUS, PLATE_FRAG, PLATE_REACH, PLATE_VERT, PLATE_WAVE_S, plateTierGain, plateUniforms, SLAB_FRAG, SLAB_VERT, slabTierGain,
  slabUniforms, type PlateUniforms, type SlabUniforms,
} from './holoShaders'
import type { TierName } from './tierBudget'

/** A floor's light while a change pulses it: its glow over its resting glow (changeAnimation's pulse), never below 1. */
export const pulseOf = (intensity: number, base: number): number => 1 + Math.max(0, intensity - base)

/** A hologram material: added onto what is behind it, writing no depth, both faces drawn. */
function holoMaterial(key: string, uniforms: Record<string, THREE.IUniform>, vertexShader: string, fragmentShader: string): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  })
  m.extensions.derivatives = true // the edges and the hexagon's rim from fwidth
  m.customProgramCacheKey = () => key
  return m
}

export interface SlabLook {
  uniforms: SlabUniforms
  /** A slab material on the shared uniforms: `edges` for the unit-box floors, without for the hexagonal slabs (their edges are lines). */
  material(edges: boolean): THREE.ShaderMaterial
  setTier(tier: TierName): void
  /** A frame's time (0 holds the scan lines still), the wireframe's pulse and the fading look's, 0..1 each. */
  tick(time: number, wire: number, fade: number): void
}

/**
 * How a slab adds onto what is behind it at `tier`. Bloomed (High, Low), the layers sum in the linear target the
 * composer tone-maps once. At Flat each layer is tone-mapped and encoded on its own straight to the screen, where a sum
 * of encoded layers runs to white wherever floors overlap: there the slab keeps the brightest layer (look spec §3.3).
 */
export function slabBlend(m: THREE.Material, tier: TierName): void {
  if (tier !== 'flat') {
    m.blending = THREE.AdditiveBlending
    return
  }
  m.blending = THREE.CustomBlending
  m.blendEquation = THREE.MaxEquation
  m.blendSrc = THREE.OneFactor
  m.blendDst = THREE.OneFactor
}

/** The slab look at `tier`, its heat colour `heat` (`#rrggbb`). */
export function createSlabLook(tier: TierName, heat: string): SlabLook {
  const u = slabUniforms(tier, heat, true)
  const made = new Set<THREE.ShaderMaterial>()
  let now = tier
  return {
    uniforms: u,
    material: (edges) => {
      const m = holoMaterial(edges ? 'lw-slab-box' : 'lw-slab-hex', { ...u, uEdges: { value: edges ? 1 : 0 } }, SLAB_VERT, SLAB_FRAG)
      slabBlend(m, now)
      made.add(m)
      // A batch's material goes with its batch: once disposed, the look lets it go.
      m.addEventListener('dispose', () => made.delete(m))
      return m
    },
    setTier: (t) => {
      now = t
      u.uGain.value = slabTierGain(t)
      for (const m of made) slabBlend(m, t)
    },
    tick: (time, wire, fade) => {
      u.uTime.value = time
      u.uWire.value = wire
      u.uFade.value = fade
    },
  }
}

/** The per-instance attributes of a slab, in the order writeSlab fills them. */
export const SLAB_ATTRS = ['aState', 'aHeat', 'aStack', 'aLook'] as const

/** One slab instance: its state (slabState), heat (0..1), the floors above it, its look's code, and its edge colour when it has edges. */
export interface SlabInstance { state: number; heat: number; stack: number; look: number; line?: THREE.Color }

const dynamic = (cap: number, size: number): THREE.InstancedBufferAttribute =>
  new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size).setUsage(THREE.DynamicDrawUsage)

/** Gives `g` room for `cap` slab instances; `lines`: an edge colour each too (`lineColor`, the floors' outlines). */
export function addSlabAttributes(g: THREE.BufferGeometry, cap: number, lines: boolean): THREE.BufferGeometry {
  for (const a of SLAB_ATTRS) g.setAttribute(a, dynamic(cap, 1))
  if (lines) g.setAttribute('lineColor', dynamic(cap, 3))
  return g
}

/** Writes instance `k`'s slab attributes. */
export function writeSlab(g: THREE.BufferGeometry, k: number, s: SlabInstance): void {
  const at = g.attributes
  ;(at.aState as THREE.BufferAttribute).setX(k, s.state)
  ;(at.aHeat as THREE.BufferAttribute).setX(k, s.heat)
  ;(at.aStack as THREE.BufferAttribute).setX(k, s.stack)
  ;(at.aLook as THREE.BufferAttribute).setX(k, s.look)
  if (s.line && at.lineColor) (at.lineColor as THREE.BufferAttribute).setXYZ(k, s.line.r, s.line.g, s.line.b)
}

/** Sends the slab attributes written since the last frame. */
export function slabsWritten(g: THREE.BufferGeometry): void {
  for (const a of [...SLAB_ATTRS, 'lineColor']) {
    const b = g.attributes[a] as THREE.BufferAttribute | undefined
    if (b) b.needsUpdate = true
  }
}

/** A district's plate: where it stands, its radius, its colour (`#rrggbb`) and the share of it lit (memberGain). */
export interface PlateSpec { id: string; pos: readonly number[]; radius: number; color: string; gain: number }

/** What a plate shows of its district at the districts tier (slabSignals): its heat, its look's code, a proposed outline. */
export interface PlateSignal { heat: number; look: number; outline: boolean }

export interface Plates {
  mesh: THREE.InstancedMesh
  uniforms: PlateUniforms
  /** Each plate's focus target (plateFocusTarget): a plate newly selected starts a wave. */
  setTargets(target: (id: string) => number): void
  setSignals(signals: ReadonlyMap<string, PlateSignal>): void
  /** The districts tier: the plates carry the slab signals. */
  setFar(far: boolean): void
  setTier(tier: TierName): void
  /** The wireframe's pulse and the fading look's, as the slabs have them. */
  pulse(wire: number, fade: number): void
  /** A change rose in these districts: a wave crosses each of their plates once. */
  wave(ids: Iterable<string>): void
  /** Eases each focus by `dt` seconds and runs the waves; reduced motion snaps the focus and holds no wave. True while anything moves. */
  tick(dt: number, reduced: boolean): boolean
  focusOf(id: string): number | undefined
  waveOf(id: string): number | undefined
  dispose(): void
}

/** Where a wave starts: above 0, so the shader (which draws one while aWave > 0) draws it from the first frame. */
const WAVE_START = 1e-3
/** How near its target a focus snaps to it, so an ease ends. */
const FOCUS_SNAP = 1e-3

/** The plates of `specs`, one instanced quad, its hexagon from the plate shader's distance field. */
export function createPlates(specs: readonly PlateSpec[], tier: TierName, colors: { heat: string; ghost: string; fogTint: string }): Plates {
  const n = specs.length
  const u = plateUniforms(tier, colors)
  // A quad past the hexagon's corners (radius 1, the instance scaled by the district's radius) that holds its halo.
  const g = new THREE.PlaneGeometry(PLATE_REACH * 2, PLATE_REACH * 2).rotateX(-Math.PI / 2)
  const attr: Record<'aFocus' | 'aWave' | 'aHeat' | 'aLook' | 'aOutline', THREE.InstancedBufferAttribute> = {
    aFocus: dynamic(n, 1), aWave: dynamic(n, 1), aHeat: dynamic(n, 1), aLook: dynamic(n, 1), aOutline: dynamic(n, 1),
  }
  for (const [k, a] of Object.entries(attr)) g.setAttribute(k, a)
  const mesh = new THREE.InstancedMesh(g, holoMaterial('lw-plate', { ...u }, PLATE_VERT, PLATE_FRAG), n)
  const m = new THREE.Matrix4()
  const c = new THREE.Color()
  specs.forEach((s, i) => {
    m.makeScale(s.radius, 1, s.radius).setPosition(s.pos[0], s.pos[1] - 0.05, s.pos[2])
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, c.set(s.color).multiplyScalar(s.gain))
  })
  mesh.userData.plateIds = specs.map((s) => s.id) // which district each instance is
  mesh.computeBoundingSphere()
  mesh.renderOrder = PLATFORM_ORDER // under the buildings, over the grid
  const index = new Map(specs.map((s, i) => [s.id, i]))
  const focus = new Float64Array(n)
  const target = new Float64Array(n)
  const waves = new Float64Array(n)
  const sent = (a: THREE.InstancedBufferAttribute): void => { a.needsUpdate = true }
  return {
    mesh,
    uniforms: u,
    setTargets(to) {
      specs.forEach((s, i) => {
        const t = to(s.id)
        if (t === PLATE_FOCUS.selected && target[i] !== PLATE_FOCUS.selected) waves[i] = WAVE_START
        target[i] = t
      })
    },
    setSignals(signals) {
      specs.forEach((s, i) => {
        const sg = signals.get(s.id)
        attr.aHeat.setX(i, sg ? sg.heat : 0)
        attr.aLook.setX(i, sg ? sg.look : 0)
        attr.aOutline.setX(i, sg?.outline ? 1 : 0)
      })
      sent(attr.aHeat); sent(attr.aLook); sent(attr.aOutline)
    },
    setFar: (far) => { u.uFar.value = far ? 1 : 0 },
    setTier: (t) => { u.uGain.value = plateTierGain(t) },
    pulse: (wire, fade) => {
      u.uWire.value = wire
      u.uFade.value = fade
    },
    wave(ids) {
      for (const id of ids) {
        const i = index.get(id)
        if (i !== undefined) waves[i] = WAVE_START
      }
    },
    tick(dt, reduced) {
      let moving = false
      for (let i = 0; i < n; i++) {
        let v = reduced ? target[i] : easePlate(focus[i], target[i], dt)
        if (Math.abs(target[i] - v) < FOCUS_SNAP) v = target[i]
        else moving = true
        focus[i] = v
        attr.aFocus.setX(i, v)
        if (waves[i] > 0) {
          const w = reduced ? 0 : waves[i] + dt / PLATE_WAVE_S
          waves[i] = w >= 1 ? 0 : w
          if (waves[i] > 0) moving = true
        }
        attr.aWave.setX(i, waves[i])
      }
      sent(attr.aFocus); sent(attr.aWave)
      return moving
    },
    focusOf: (id) => { const i = index.get(id); return i === undefined ? undefined : focus[i] },
    waveOf: (id) => { const i = index.get(id); return i === undefined ? undefined : waves[i] },
    dispose() {
      g.dispose()
      ;(mesh.material as THREE.Material).dispose()
      mesh.dispose()
    },
  }
}
