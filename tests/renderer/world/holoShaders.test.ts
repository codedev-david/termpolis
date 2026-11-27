// holoShaders: the Holotable stage's GLSL and the uniforms each one is made with (look spec §3.2-3.4, §7).
import { describe, expect, it } from 'vitest'
import {
  BEAM_FRAG, BEAM_K, BEAM_VERT, beamParts, beamUniforms, DISC_FRAG, DISC_GAIN, DISC_VERT, DISC_Y, discUniforms, glf, GRADE_FRAG, GRADE_VERT,
  gradeUniforms, HOLO_SLAB, linearRgb, MOTION_HZ, PLATE_FOOT, SHAFT_FRAG, SHAFT_VERT, shaftParts, shaftUniforms, STAGE_MAX, TRACK_Y,
  easePlate, LOOK_CODE, PLATE_EASE_RATE, PLATE_FOCUS, PLATE_FRAG, PLATE_GAIN, PLATE_REACH, PLATE_VERT, plateFocusTarget, plateTierGain, plateUniforms,
  SLAB_DIM, SLAB_FILL, SLAB_FRAG, SLAB_GAIN, SLAB_STATE, SLAB_VERT, slabGain, slabState, slabTierGain, slabUniforms, stackFill, STACK_FALL,
} from '../../../src/renderer/src/world/engine/holoShaders'
import { gradeOf, type StageMark } from '../../../src/renderer/src/world/engine/holoMarks'

const SHADERS = { DISC_VERT, DISC_FRAG, SHAFT_VERT, SHAFT_FRAG, BEAM_VERT, BEAM_FRAG, GRADE_VERT, GRADE_FRAG, SLAB_VERT, SLAB_FRAG, PLATE_VERT, PLATE_FRAG }
/** The fragments that light the world: each tone mapped, in the output's colour space, and clamped below white. */
const LIT = [DISC_FRAG, SHAFT_FRAG, BEAM_FRAG, SLAB_FRAG, PLATE_FRAG]
const disc: Extract<StageMark, { kind: 'disc' }> = { kind: 'disc', center: [1, 2], radius: 40, color: '#3fd0ff', arcColor: '#ffae42', moving: true }

/** The uniforms a GLSL string declares, by name. */
const declared = (src: string): string[] => Array.from(src.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g), (m) => m[1]).sort()

describe('holoShaders', () => {
  it('every shader carries the Holotable marker, and none names a GLSL version', () => {
    expect(HOLO_SLAB).toBe('HOLO_SLAB')
    for (const [name, src] of Object.entries(SHADERS)) {
      expect(src, name).toContain(`#define ${HOLO_SLAB} 1`)
      // three.js writes the version line itself (300 es on WebGL 2, none on WebGL 1): one of ours would come second and fail.
      expect(src, name).not.toMatch(/#version/)
    }
  })

  it('every shader is written in the GLSL 1 dialect three.js maps to either context', () => {
    // three.js compiles a ShaderMaterial as GLSL 1 unless told otherwise, and on WebGL 2 it #defines texture2D,
    // gl_FragColor, attribute and varying to their GLSL 3 names. A GLSL 3 word of our own (texture(), an out variable,
    // in/out qualifiers) would compile on WebGL 2 and fail on WebGL 1, which r160 still falls back to.
    for (const [name, src] of Object.entries(SHADERS)) {
      expect(src, name).not.toMatch(/\btexture\s*\(/)
      expect(src, name).not.toMatch(/^\s*(?:out|in)\s+(?:vec|float|mat|highp|mediump|lowp)/m)
      expect(src, name).not.toMatch(/\btexelFetch\b|\btextureSize\b/)
    }
    // Only the grade reads a texture (the frame drawn so far), and only through texture2D.
    expect(GRADE_FRAG).toMatch(/texture2D\(tDiffuse, vUv\)/)
    for (const src of LIT) expect(src).not.toMatch(/texture2D|sampler2D/)
    // The fragments that light the table are tone mapped and put in the output's colour space like three's own materials.
    for (const src of LIT) {
      expect(src).toContain('#include <tonemapping_fragment>')
      expect(src).toContain('#include <colorspace_fragment>')
    }
  })

  it('each fragment declares the uniforms its factory makes, no more and no fewer', () => {
    expect(declared(DISC_FRAG)).toEqual(Object.keys(discUniforms(disc, 'high')).sort())
    expect(declared(SHAFT_FRAG)).toEqual(Object.keys(shaftUniforms('#3fd0ff')).sort())
    expect(declared(BEAM_FRAG)).toEqual(Object.keys(beamUniforms('#3fd0ff')).sort())
    expect(declared(GRADE_FRAG)).toEqual(Object.keys(gradeUniforms('high')).sort())
    expect(declared(SLAB_FRAG)).toEqual(Object.keys(slabUniforms('high', '#ff8a3d', true)).sort())
    expect(declared(PLATE_FRAG)).toEqual(Object.keys(plateUniforms('high', { heat: '#ff8a3d', ghost: '#88a0b8', fogTint: '#203040' })).sort())
    for (const src of [SLAB_VERT, PLATE_VERT]) expect(declared(src)).toEqual([])
    for (const a of ['aState', 'aHeat', 'aStack', 'aLook']) expect(SLAB_VERT).toMatch(new RegExp(`attribute float ${a};`))
    for (const a of ['aFocus', 'aWave', 'aHeat', 'aLook', 'aOutline']) expect(PLATE_VERT).toMatch(new RegExp(`attribute float ${a};`))
    // three declares instanceMatrix and instanceColor itself, only when the mesh has them: each read stays behind its define.
    for (const src of [SLAB_VERT, PLATE_VERT]) {
      expect(src).toMatch(/#ifdef USE_INSTANCING\n\s*inst = instanceMatrix;/)
      expect(src).toMatch(/#ifdef USE_INSTANCING_COLOR\n\s*\w+ = instanceColor;/)
      expect(src).not.toMatch(/attribute mat4 instanceMatrix|attribute vec3 instanceColor/)
    }
    // The vertex shaders take three's own matrices and attributes, and the shafts' strength as an attribute.
    for (const src of [DISC_VERT, SHAFT_VERT, BEAM_VERT, GRADE_VERT]) expect(declared(src)).toEqual([])
    expect(SHAFT_VERT).toMatch(/attribute float aK;/)
  })

  it('the disc factory takes the radius and colours from the disc mark, with more gain where no bloom adds glow', () => {
    const u = discUniforms(disc, 'high')
    expect(u.uR.value).toBe(40)
    expect(u.uCyan.value).toEqual(linearRgb('#3fd0ff'))
    expect(u.uAmber.value).toEqual(linearRgb('#ffae42'))
    expect([u.uTime.value, u.uSweep.value, u.uSweepOn.value]).toEqual([0, 0, 0])
    expect(u.uGain.value).toBe(DISC_GAIN.bloomed)
    expect(discUniforms(disc, 'low').uGain.value).toBe(DISC_GAIN.bloomed)
    expect(discUniforms(disc, 'flat').uGain.value).toBe(DISC_GAIN.flat)
    expect(DISC_GAIN.flat).toBeGreaterThan(DISC_GAIN.bloomed)
    // Fresh objects each time: two materials never share a uniform by accident.
    expect(discUniforms(disc, 'high').uCyan.value).not.toBe(u.uCyan.value)
  })

  it('the grade factory has the vignette at High and Low, grain only at High, and nothing at Flat', () => {
    for (const tier of ['high', 'low', 'flat'] as const) {
      const u = gradeUniforms(tier)
      expect({ vignette: u.uVignette.value, grain: u.uGrain.value }).toEqual(gradeOf(tier))
      expect(u.tDiffuse.value).toBeNull()
      expect(u.uSeed.value).toBe(0)
    }
    expect(gradeOf('high')).toEqual({ vignette: 0.5, grain: 0.03 })
    expect(gradeOf('low')).toEqual({ vignette: 0.5, grain: 0 })
    expect(gradeOf('flat')).toEqual({ vignette: 0, grain: 0 })
  })

  it('the shaft and beam factories take the colour, and the beams their spike strength', () => {
    expect(shaftUniforms('#ffffff')).toEqual({ uTime: { value: 0 }, uCyan: { value: [1, 1, 1] } })
    expect(beamUniforms('#000000')).toEqual({ uTime: { value: 0 }, uK: { value: BEAM_K }, uColor: { value: [0, 0, 0] } })
  })

  it('converts a colour to linear light as three.js does for its own colours', () => {
    expect(linearRgb('#ffffff')).toEqual([1, 1, 1])
    expect(linearRgb('#000000')).toEqual([0, 0, 0])
    const [r, g, b] = linearRgb('#3fd0ff')
    expect(r).toBeCloseTo(0.0497, 3) // 0x3f: past the sRGB curve's linear toe
    expect(g).toBeCloseTo(0.6308, 3)
    expect(b).toBe(1)
    expect(linearRgb('#0a0a0a')[0]).toBeCloseTo(10 / 255 / 12.92, 6) // inside the toe
  })

  it('the shafts stand on the disc, the second only where the tier has two', () => {
    expect(shaftParts(40, 2)).toEqual([{ radius: 40, height: 22, k: 1 }, { radius: 24.8, height: 12.8, k: 0.6 }])
    expect(shaftParts(40, 1)).toEqual([{ radius: 40, height: 22, k: 1 }])
    expect(shaftParts(40, 0)).toEqual([])
  })

  it('a beam rises from the disc to the underside of each plate, inside its rim', () => {
    expect(beamParts([[3, 4], [-5, 6]], [10, 20])).toEqual([
      { x: 3, z: 4, radius: 8.6, y0: DISC_Y, y1: PLATE_FOOT },
      { x: -5, z: 6, radius: 17.2, y0: DISC_Y, y1: PLATE_FOOT },
    ])
    expect(beamParts([], [])).toEqual([])
    // Under the plates (whose foot is at -1.2) and the grid (at -1.3); the track just above the disc.
    expect(DISC_Y).toBeLessThan(PLATE_FOOT)
    expect(TRACK_Y).toBeGreaterThan(DISC_Y)
    expect(TRACK_Y).toBeLessThan(-1.3)
  })

  it('nothing on the stage moves faster than 3 Hz (look spec §7), and the shaders run at those rates', () => {
    for (const [name, hz] of Object.entries(MOTION_HZ)) {
      expect(hz, name).toBeGreaterThan(0)
      expect(hz, name).toBeLessThanOrEqual(3)
    }
    // The grain changes at a stepped seed (uSeed), never per frame.
    expect(GRADE_FRAG).toMatch(/uSeed/)
    expect(GRADE_FRAG).not.toMatch(/uTime/)
    expect(DISC_FRAG).toContain(String(MOTION_HZ.arcA))
    expect(DISC_FRAG).toContain(String(MOTION_HZ.arcB))
    expect(SHAFT_FRAG).toContain(String(MOTION_HZ.shaftA))
    expect(SHAFT_FRAG).toContain(String(MOTION_HZ.shaftB))
    expect(BEAM_FRAG).toContain(String(MOTION_HZ.beam))
  })

  it('writes every number into GLSL as a float literal', () => {
    // GLSL 1 has no implicit int-to-float conversion: `uTime * 1` fails to compile where `uTime * 1.0` does not.
    expect([glf(1), glf(0), glf(-2), glf(0.012), glf(2.5)]).toEqual(['1.0', '0.0', '-2.0', '0.012', '2.5'])
  })

  it('every light the stage adds is clamped below white', () => {
    // The table never whites out the picture (world-visual's MAX_WHITE_FRACTION): each fragment caps its colour.
    expect(STAGE_MAX).toBeLessThan(1)
    for (const src of LIT) expect(src).toMatch(/min\([^;]*vec3\(HOLO_MAX\)\)/)
    for (const src of LIT) expect(src).toContain(`#define HOLO_MAX ${STAGE_MAX}`)
    // The grade only darkens (the vignette) and adds grain round zero, kept from going below black.
    expect(GRADE_FRAG).toMatch(/max\(c\.rgb, vec3\(0\.0\)\)/)
  })

  it('slabState encodes selected ≥1.5, hovered ≥0.75, related 0.25..0.75, dimmed ≤ -0.5', () => {
    // No focus: every slab rests at 0, apart from the selected and the hovered one.
    expect(slabState(false, false, false, false)).toBe(SLAB_STATE.rest)
    expect(slabState(false, false, false, true)).toBe(SLAB_STATE.rest)
    expect(slabState(true, true, false, false)).toBeGreaterThanOrEqual(1.5)
    expect(slabState(false, true, true, true)).toBeGreaterThanOrEqual(1.5)
    const hov = slabState(true, false, true, true)
    expect(hov).toBeGreaterThanOrEqual(0.75)
    expect(hov).toBeLessThan(1.5)
    expect(slabState(false, false, true, false)).toBe(hov)
    const rel = slabState(true, false, false, true)
    expect(rel).toBeGreaterThanOrEqual(0.25)
    expect(rel).toBeLessThan(0.75)
    expect(slabState(true, false, false, false)).toBeLessThanOrEqual(-0.5)
    const rest = slabState(false, false, false, false)
    expect(rest > -0.5 && rest < 0.25).toBe(true)
    // The gain the shader makes of each: 1 + 0.8 hover + 0.35 related + 0.9 selected, and 0.14 of that when dimmed.
    expect(slabGain(SLAB_STATE.selected)).toBeCloseTo(1.9)
    expect(slabGain(SLAB_STATE.hovered)).toBeCloseTo(1.8)
    expect(slabGain(SLAB_STATE.related)).toBeCloseTo(1.35)
    expect(slabGain(SLAB_STATE.rest)).toBe(1)
    expect(slabGain(SLAB_STATE.dimmed)).toBeCloseTo(SLAB_DIM)
    expect(SLAB_DIM).toBe(0.14)
    // The band edges are the shader's: step(1.5), step(0.75), step(0.25), and 1 - step(-0.5).
    expect([slabGain(1.5), slabGain(1.49), slabGain(0.75), slabGain(0.74), slabGain(0.25), slabGain(0.24), slabGain(-0.5), slabGain(-0.49)].map((g) => +g.toFixed(3)))
      .toEqual([1.9, 1.8, 1.8, 1.35, 1.35, 1, 0.14, 1])
    expect(SLAB_FRAG).toMatch(/step\(1\.5, vState\)/)
    expect(SLAB_FRAG).toMatch(/step\(0\.75, vState\)/)
    expect(SLAB_FRAG).toMatch(/step\(0\.25, vState\)/)
    expect(SLAB_FRAG).toMatch(/step\(-0\.5, vState\)/)
    expect(SLAB_FRAG).toContain('1.0 + 0.8 * hov + 0.35 * rel + 0.9 * sel')
    expect(SLAB_FRAG).toContain(`mix(1.0, ${glf(SLAB_DIM)}`)
  })

  it('fill falls as 1/(1+0.12*stack)', () => {
    expect(STACK_FALL).toBe(0.12)
    for (const stack of [0, 1, 4, 12, 40]) expect(stackFill(stack)).toBeCloseTo(1 / (1 + 0.12 * stack), 12)
    expect(stackFill(0)).toBe(1)
    // The shader divides the fill the same way, by the stack each instance carries.
    expect(SLAB_FRAG).toContain(`/ (1.0 + ${glf(STACK_FALL)} * vStack)`)
    // A tower's summed fill grows ever slower: forty floors light about as much as fifteen.
    let sum = 0
    for (let k = 0; k < 40; k++) sum += stackFill(k)
    expect(sum).toBeLessThan(16)
  })

  it('the slab draws each look by its code: a wire with no fill and a pulsing edge, the fog veiled, the fading pulsed', () => {
    expect(LOOK_CODE).toEqual({ solid: 0, wire: 1, amber: 2, fog: 3, fading: 4 })
    expect(SLAB_FRAG).toContain(`lookIs(vLook, ${glf(LOOK_CODE.wire)})`)
    expect(SLAB_FRAG).toContain('fill *= (1.0 - wire)')
    expect(SLAB_FRAG).toContain('mix(1.0, uWire, wire)')
    expect(SLAB_FRAG).toContain('mix(1.0, uFade, fading)')
    // No per-slab flicker (look spec §7): the scan lines and the sweep run on world height and time alone.
    expect(SLAB_FRAG).toContain('sin(vY * 6.5 - uTime * 2.2)')
    expect(SLAB_FRAG).not.toMatch(/fract\(sin|hash|rand/)
  })

  it('the slab and plate factories carry the tier gain, higher at Flat where no bloom adds glow', () => {
    const s = slabUniforms('high', '#ff8a3d', true)
    expect([s.uTime.value, s.uWire.value, s.uFade.value, s.uEdges.value, s.uFill.value]).toEqual([0, 1, 1, 1, SLAB_FILL])
    expect(s.uHeatColor.value).toEqual(linearRgb('#ff8a3d'))
    expect(slabUniforms('flat', '#ff8a3d', false).uEdges.value).toBe(0)
    expect([slabTierGain('high'), slabTierGain('low'), slabTierGain('flat')]).toEqual([SLAB_GAIN.bloomed, SLAB_GAIN.bloomed, SLAB_GAIN.flat])
    expect(SLAB_GAIN.flat).toBeGreaterThan(SLAB_GAIN.bloomed)
    expect(slabUniforms('flat', '#000000', true).uGain.value).toBe(SLAB_GAIN.flat)
    const p = plateUniforms('low', { heat: '#ff8a3d', ghost: '#88a0b8', fogTint: '#203040' })
    expect([p.uFar.value, p.uWire.value, p.uFade.value, p.uGain.value]).toEqual([0, 1, 1, PLATE_GAIN.bloomed])
    expect([p.uHeatColor.value, p.uGhost.value, p.uFogTint.value]).toEqual([linearRgb('#ff8a3d'), linearRgb('#88a0b8'), linearRgb('#203040')])
    expect([plateTierGain('high'), plateTierGain('flat')]).toEqual([PLATE_GAIN.bloomed, PLATE_GAIN.flat])
    expect(PLATE_GAIN.flat).toBeGreaterThan(PLATE_GAIN.bloomed)
  })

  it('the slab fill and gains are the levels that hold a selected busy district under the white-out budget', () => {
    // Measured (look spec §3.3): at fill 0.55 and gain 1, the Termpolis close-up with its busiest building selected
    // was 2.6% white at High; at fill 0.3 and gain 0.8 it is under 0.2% in every palette and tier. Flat keeps its
    // raised gain: there the slabs keep their brightest layer (slabBlend), so overlaps never sum to white.
    expect(SLAB_FILL).toBe(0.3)
    expect(SLAB_GAIN).toEqual({ bloomed: 0.8, flat: 1.3 })
  })

  it('a plate focus eases by time, not per frame', () => {
    expect(PLATE_FOCUS).toEqual({ rest: 0, lit: 0.5, selected: 0.7, dimmed: -0.5 })
    expect(plateFocusTarget(false, false, false)).toBe(0)
    expect(plateFocusTarget(false, true, false)).toBe(0)
    expect(plateFocusTarget(true, true, false)).toBe(0.5)
    expect(plateFocusTarget(true, false, false)).toBe(-0.5)
    expect(plateFocusTarget(true, true, true)).toBe(0.7)
    expect(plateFocusTarget(false, false, true)).toBe(0.7)
    // One second at 30 fps and at 144 fps lands at the same focus: the ease is in time, not in frames.
    const run = (fps: number): number => {
      let v = 0
      for (let i = 0; i < fps; i++) v = easePlate(v, 0.7, 1 / fps)
      return v
    }
    expect(run(30)).toBeCloseTo(run(144), 9)
    expect(run(30)).toBeCloseTo(0.7 * (1 - Math.exp(-PLATE_EASE_RATE)), 9)
    // At 60 fps a frame moves 0.15 of the way, the spike's step; no time moves nothing, and a long one arrives.
    expect(easePlate(0, 1, 1 / 60)).toBeCloseTo(0.15, 9)
    expect(easePlate(0.3, 1, 0)).toBe(0.3)
    expect(easePlate(0.3, -0.5, 10)).toBeCloseTo(-0.5, 6)
  })

  it('the plate is a hexagon with its corners where CylinderGeometry puts them, its wave only while one runs', () => {
    expect(PLATE_FRAG).toContain('max(p.x, dot(p, vec2(0.5, 0.8660254))) - 0.8660254')
    expect(PLATE_FRAG).toMatch(/vWave > 0\.0 \?/)
    expect(PLATE_FRAG).toMatch(/fract\(vW \/ 5\.0/)
    // The slab signals show on the plate only at the districts tier.
    expect(PLATE_FRAG).toContain('step(0.5, uFar)')
    expect(PLATE_FRAG).toMatch(/vOutline \* far/)
  })

  it('a plate halo fades out before the edge of its quad, so no square edge shows', () => {
    expect(PLATE_REACH).toBeGreaterThan(1)
    expect(PLATE_FRAG).toContain(`* (1.0 - smoothstep(1.0, ${PLATE_REACH.toFixed(1)}, length(vP)))`)
    expect(PLATE_FRAG).toMatch(/float halo = [^;]*length\(vP\)/)
  })
})
