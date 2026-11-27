// The Holotable stage (look spec §3.2-3.4): the projector disc under the plates, the track the orbs ride, a beam under
// each plate, the light shafts and the dust. A world's stage is built from its stage marks (holoMarks' stageMarks) at
// the fullest tier, and each tier draws its share (fit, from that tier's marks), so a tier change builds nothing. Its
// clock (tick) turns the disc's arcs, the working sweep and the dust where the tier's marks say they move, and rests
// them at t = 0 wherever they do not (Flat, reduced motion: look spec §3.4). The shaders and their uniforms are
// holoShaders'. Nothing here is picked (the picks test their own lists of objects).
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { BACKDROP_ORDER } from './batching'
import type { StageMark } from './holoMarks'
import { BEAM_FRAG, BEAM_VERT, beamParts, beamUniforms, DISC_FRAG, DISC_VERT, DISC_Y, discGain, discUniforms, MOTION_HZ, SHAFT_FRAG, SHAFT_VERT, shaftParts, shaftUniforms, TRACK_Y } from './holoShaders'
import type { TierName } from './tierBudget'

type Mark<K extends StageMark['kind']> = Extract<StageMark, { kind: K }>
/** The mark of `kind` in `marks`, if there is one. */
const markOf = <K extends StageMark['kind']>(marks: StageMark[], kind: K): Mark<K> | undefined =>
  marks.find((m): m is Mark<K> => m.kind === kind)

/** How high the dust rises (it starts again at DUST_FLOOR) and how fast. */
const DUST_TOP = 58
const DUST_FLOOR = -2
const DUST_RISE = 1.1

/** Where the stage's motions stand (motionState). */
export interface StageMotion {
  /** The dust points the tier draws. */
  dust: number
  /** How far the disc's cyan arcs have turned (radians), the working sweep (turns), and the dust risen (world units). */
  discAngle: number; sweep: number; dustDrift: number
}

/** The part of the grade pass the stage fits: its uniforms (the vignette and the grain). */
export interface GradeLike { uniforms: Record<string, THREE.IUniform> }

export interface HoloStage {
  /** The disc, the track, the beams and the shafts of the world drawn: the renderer adds it to its scene. */
  readonly group: THREE.Group
  /** The dust, built once (the most the fullest marks draw): the renderer adds it to its scene with the backdrop. */
  readonly dust: THREE.Points
  /** Builds the stage of a world from its marks at the fullest tier (High), for plates of `plateRadii`. */
  build(fullest: StageMark[], plateRadii: number[], tier: TierName): void
  /** The share of the stage `marks` (the tier's own) draw: the shafts, the beams, the dust, what moves, and the grade's vignette and grain. */
  fit(marks: StageMark[], tier: TierName, grade: GradeLike | null): void
  /** Whether the stage keeps frames coming while motion is allowed: dust drawn, a disc whose arcs turn, or its sweep while working. */
  looping(working: boolean): boolean
  /** One frame of `dt` seconds: the clocks run where the tier's marks move and motion is allowed, and rest at t = 0 where not. */
  tick(dt: number, working: boolean, reduced: boolean): void
  motion(): StageMotion
  /** Frees the world's stage (a new world, or the view closing). */
  free(): void
  /** Frees all of it, the dust too. */
  dispose(): void
}

/** The stage, its dust drawn with `dotTex` and as many points as the `fullest` marks' dust. */
export function createHoloStage(dotTex: THREE.Texture, fullest: StageMark[]): HoloStage {
  const group = new THREE.Group()
  group.name = 'holo-stage'
  let discMat: THREE.ShaderMaterial | null = null
  let beams: THREE.Mesh | null = null
  let shafts: THREE.Mesh | null = null
  /** The index count that draws the first shaft, then both. */
  let shaftEnds: number[] = []
  /** The stage's materials whose light moves (uTime). */
  let timed: THREE.ShaderMaterial[] = []
  /** What the tier's marks move: the disc's arcs (with the shafts and beams), and the working sweep. */
  let discMoving = false
  let sweepMoving = false
  /** The stage's clock and the working sweep's (each rests at 0 where it does not move). */
  let stageT = 0
  let sweepT = 0

  // Dust drifting upward through the city: the most the fullest marks draw is built once, and each tier draws its
  // share of it. Where it is at rest it stands at its first places (dustHome), as it stood at t = 0.
  const most = (markOf(fullest, 'dust') as Mark<'dust'>).count
  const dustHome = new Float32Array(most * 3)
  for (let i = 0; i < most; i++) {
    dustHome[i * 3] = (Math.random() - 0.5) * 200
    dustHome[i * 3 + 1] = Math.random() * 60 + DUST_FLOOR
    dustHome[i * 3 + 2] = (Math.random() - 0.5) * 200
  }
  const dustPos = dustHome.slice()
  const dustGeo = new THREE.BufferGeometry()
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3))
  const dustMat = new THREE.PointsMaterial({ color: 0x7dd3fc, size: 0.6, map: dotTex, transparent: true, opacity: 0.5, alphaTest: 0.02, depthWrite: false })
  const dust = new THREE.Points(dustGeo, dustMat)
  dust.name = 'holo-dust'
  dust.renderOrder = BACKDROP_ORDER // shows through the platforms
  /** The dust points the tier draws (the first of them), and how far they have risen in all. */
  let dustDrawn = 0
  let dustDrift = 0

  const material = (uniforms: Record<string, THREE.IUniform>, vertexShader: string, fragmentShader: string): THREE.ShaderMaterial => {
    const m = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
    timed.push(m)
    return m
  }
  const add = (o: THREE.Mesh | THREE.LineLoop, kind: string, at: [number, number] | null): void => {
    o.userData.stage = kind
    o.renderOrder = BACKDROP_ORDER // under the plates, as the grid and the stars
    if (at) o.position.set(at[0], DISC_Y, at[1])
    group.add(o)
  }
  const free = (): void => {
    for (const o of group.children) {
      const m = o as THREE.Mesh
      m.geometry.dispose()
      ;(m.material as THREE.Material).dispose()
    }
    group.clear()
    discMat = null
    beams = null
    shafts = null
    timed = []
  }
  /** The dust back at its first places, where it stood at t = 0. */
  const restDust = (): void => {
    if (dustDrift === 0) return
    dustPos.set(dustHome)
    dustDrift = 0
    dustGeo.attributes.position.needsUpdate = true
  }

  return {
    group,
    dust,
    build(marks, plateRadii, tier) {
      free()
      let at: [number, number] = [0, 0]
      let radius = 0
      for (const mark of marks) {
        if (mark.kind === 'disc') {
          at = mark.center
          radius = mark.radius
          // A square round the disc a little past its outer ring of dots (the shader discards past 1.12 radii).
          discMat = material({ ...discUniforms(mark, tier) }, DISC_VERT, DISC_FRAG)
          discMat.side = THREE.FrontSide
          discMat.extensions.derivatives = true // fwidth, for the rings' widths (WebGL 1)
          add(new THREE.Mesh(new THREE.PlaneGeometry(radius * 2.3, radius * 2.3).rotateX(-Math.PI / 2), discMat), 'disc', at)
        } else if (mark.kind === 'track') {
          const pts: number[] = []
          for (let i = 0; i < mark.segments; i++) {
            const a = (i / mark.segments) * Math.PI * 2
            pts.push(Math.cos(a) * mark.radius, TRACK_Y, Math.sin(a) * mark.radius)
          }
          const geo = new THREE.BufferGeometry()
          geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
          const mat = new THREE.LineBasicMaterial({ color: mark.color, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })
          add(new THREE.LineLoop(geo, mat), 'track', null)
        } else if (mark.kind === 'beams' && mark.to.length > 0) {
          const parts = beamParts(mark.to, plateRadii)
            .map((b) => new THREE.CylinderGeometry(b.radius, b.radius, 1, 6, 1, true).scale(1, b.y1 - b.y0, 1).translate(b.x, (b.y0 + b.y1) / 2, b.z))
          beams = new THREE.Mesh(mergeGeometries(parts), material({ ...beamUniforms(mark.color) }, BEAM_VERT, BEAM_FRAG))
          for (const g of parts) g.dispose()
          add(beams, 'beams', null)
        } else if (mark.kind === 'shafts') {
          const parts = shaftParts(radius, mark.count).map((p) => {
            const g = new THREE.CylinderGeometry(p.radius, p.radius * 1.02, p.height, 96, 1, true).translate(0, p.height / 2, 0)
            g.setAttribute('aK', new THREE.Float32BufferAttribute(new Array<number>(g.getAttribute('position').count).fill(p.k), 1))
            return g
          })
          let end = 0
          shaftEnds = parts.map((g) => (end += (g.index as THREE.BufferAttribute).count))
          // The shafts take the disc's colour (the palette's holo, as every stage light).
          shafts = new THREE.Mesh(mergeGeometries(parts), material({ ...shaftUniforms((markOf(marks, 'disc') as Mark<'disc'>).color) }, SHAFT_VERT, SHAFT_FRAG))
          for (const g of parts) g.dispose()
          add(shafts, 'shafts', at)
        }
      }
    },
    fit(marks, tier, grade) {
      const shaftCount = (markOf(marks, 'shafts') as Mark<'shafts'>).count
      discMoving = (markOf(marks, 'disc') as Mark<'disc'>).moving
      sweepMoving = (markOf(marks, 'discSweep') as Mark<'discSweep'>).moving
      if (discMat) discMat.uniforms.uGain.value = discGain(tier)
      if (beams) beams.visible = markOf(marks, 'beams') !== undefined
      if (shafts) {
        shafts.visible = shaftCount > 0
        shafts.geometry.setDrawRange(0, shaftEnds[Math.max(0, shaftCount - 1)])
      }
      dustDrawn = (markOf(marks, 'dust') as Mark<'dust'>).count
      dustGeo.setDrawRange(0, dustDrawn)
      dust.visible = dustDrawn > 0
      if (grade) {
        const g = markOf(marks, 'vignetteGrain') as Mark<'vignetteGrain'>
        grade.uniforms.uVignette.value = g.vignette
        grade.uniforms.uGrain.value = g.grain
      }
    },
    looping: (working) => dustDrawn > 0 || (discMat !== null && (discMoving || (sweepMoving && working))),
    tick(dt, working, reduced) {
      if (dustDrawn > 0 && !reduced) {
        for (let i = 1; i < dustDrawn * 3; i += 3) { dustPos[i] += dt * DUST_RISE; if (dustPos[i] > DUST_TOP) dustPos[i] = DUST_FLOOR }
        dustDrift += dt * DUST_RISE
        dustGeo.attributes.position.needsUpdate = true
      } else restDust()
      // The arcs, shafts and beams turn at the tiers whose disc moves; the sweep only while the world works, and holds
      // where it was while it does not (it is not drawn then). Where either does not move, it rests at t = 0.
      stageT = discMat !== null && discMoving && !reduced ? stageT + dt : 0
      const sweepOn = discMat !== null && working && sweepMoving && !reduced
      sweepT = sweepMoving && !reduced ? (sweepOn ? sweepT + dt : sweepT) : 0
      for (const m of timed) m.uniforms.uTime.value = stageT
      if (discMat) {
        discMat.uniforms.uSweep.value = sweepT * MOTION_HZ.sweep
        discMat.uniforms.uSweepOn.value = sweepOn ? 1 : 0
      }
    },
    motion: () => ({ dust: dustDrawn, discAngle: stageT * MOTION_HZ.arcA * Math.PI * 2, sweep: sweepT * MOTION_HZ.sweep, dustDrift }),
    free,
    dispose() {
      free()
      dustGeo.dispose()
      dustMat.dispose()
    },
  }
}
