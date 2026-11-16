// Lumopolis "watch it grow": the rise, pulse and fade the renderer plays when a newer world of the
// same project loads. It works on scene-graph objects and material fields only (no WebGL), and its
// clock is the caller's: threeRenderer.ts calls tick(performance.now()) once per frame, so a slow
// frame rate never stretches an animation. Nothing here owns a timer.
import * as THREE from 'three'

/** A new part grows from flat to full height (scale y 0 → 1). */
export const RISE_MS = 900
/** A changed part's emissive glow flashes up and back. */
export const PULSE_MS = 1200
/** A removed part, kept from the previous scene, fades out and is then freed. */
export const FADE_MS = 900
const PULSE_GAIN = 1.6
/** Scale y at the start of a rise: not 0, so the object's matrix stays invertible for picking. */
const FLAT = 0.001

interface Rise { obj: THREE.Object3D; t0: number }
interface Pulse { m: THREE.MeshStandardMaterial; base: number; t0: number }
interface Fade { obj: THREE.Object3D; mats: { m: THREE.Material; base: number }[]; t0: number }

export interface ChangeAnimator {
  /** Moves removed parts out of the world into the fade layer (before the world is cleared); they fade from `now`. */
  keep(objs: THREE.Object3D[], now: number): void
  /** Starts a rise for each object and a glow pulse for each standard material. */
  start(rise: THREE.Object3D[], pulse: THREE.Material[], now: number): void
  tick(now: number): void
  /** Ends rises and pulses at once (their objects are about to be redrawn); kept parts go on fading. */
  settle(): void
  /** Ends everything at once and frees the kept parts. */
  stop(): void
  /** How many rises, pulses and fades are running. */
  active(): number
}

const materialsOf = (o: THREE.Object3D): THREE.Material[] => {
  const m = (o as THREE.Mesh).material
  return m ? ([] as THREE.Material[]).concat(m) : []
}

export function createChangeAnimator(layer: THREE.Object3D, shared: Set<THREE.BufferGeometry>): ChangeAnimator {
  let rises: Rise[] = []
  let pulses: Pulse[] = []
  let fades: Fade[] = []

  function free(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      const g = (o as THREE.Mesh).geometry
      if (g && !shared.has(g)) g.dispose()
      for (const m of materialsOf(o)) m.dispose()
    })
    obj.removeFromParent()
  }

  function settle(): void {
    for (const r of rises) r.obj.scale.y = 1
    for (const p of pulses) p.m.emissiveIntensity = p.base
    rises = []
    pulses = []
  }

  return {
    keep(objs, now) {
      for (const obj of objs) {
        const captions: THREE.Object3D[] = []
        obj.traverse((o) => { if ((o as { isCSS2DObject?: boolean }).isCSS2DObject) captions.push(o) })
        for (const c of captions) {
          ;(c as unknown as { element: HTMLElement }).element.remove()
          c.removeFromParent()
        }
        const mats: Fade['mats'] = []
        obj.traverse((o) => {
          for (const m of materialsOf(o)) {
            if (!m.transparent) { m.transparent = true; m.needsUpdate = true }
            mats.push({ m, base: m.opacity })
          }
        })
        layer.add(obj) // add() takes it out of its old parent
        fades.push({ obj, mats, t0: now })
      }
    },
    start(rise, pulse, now) {
      for (const obj of rise) {
        obj.scale.y = FLAT
        rises.push({ obj, t0: now })
      }
      for (const m of pulse) {
        if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
          const sm = m as THREE.MeshStandardMaterial
          pulses.push({ m: sm, base: sm.emissiveIntensity, t0: now })
        }
      }
    },
    tick(now) {
      rises = rises.filter((r) => {
        const k = (now - r.t0) / RISE_MS
        r.obj.scale.y = k >= 1 ? 1 : Math.max(FLAT, 1 - (1 - k) ** 3)
        return k < 1
      })
      pulses = pulses.filter((p) => {
        const k = (now - p.t0) / PULSE_MS
        p.m.emissiveIntensity = k >= 1 ? p.base : p.base + PULSE_GAIN * Math.sin(Math.PI * k)
        return k < 1
      })
      fades = fades.filter((f) => {
        const k = (now - f.t0) / FADE_MS
        if (k >= 1) { free(f.obj); return false }
        for (const { m, base } of f.mats) m.opacity = base * (1 - k)
        return true
      })
    },
    settle,
    stop() {
      settle()
      for (const f of fades) free(f.obj)
      fades = []
    },
    active: () => rises.length + pulses.length + fades.length,
  }
}
