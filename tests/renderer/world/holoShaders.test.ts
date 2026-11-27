// holoShaders: the Holotable stage's GLSL and the uniforms each one is made with (look spec §3.2-3.4, §7).
import { describe, expect, it } from 'vitest'
import {
  BEAM_FRAG, BEAM_K, BEAM_VERT, beamParts, beamUniforms, DISC_FRAG, DISC_GAIN, DISC_VERT, DISC_Y, discUniforms, glf, GRADE_FRAG, GRADE_VERT,
  gradeUniforms, HOLO_SLAB, linearRgb, MOTION_HZ, PLATE_FOOT, SHAFT_FRAG, SHAFT_VERT, shaftParts, shaftUniforms, STAGE_MAX, TRACK_Y,
} from '../../../src/renderer/src/world/engine/holoShaders'
import { gradeOf, type StageMark } from '../../../src/renderer/src/world/engine/holoMarks'

const SHADERS = { DISC_VERT, DISC_FRAG, SHAFT_VERT, SHAFT_FRAG, BEAM_VERT, BEAM_FRAG, GRADE_VERT, GRADE_FRAG }
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
    for (const src of [DISC_FRAG, SHAFT_FRAG, BEAM_FRAG]) expect(src).not.toMatch(/texture2D|sampler2D/)
    // The fragments that light the table are tone mapped and put in the output's colour space like three's own materials.
    for (const src of [DISC_FRAG, SHAFT_FRAG, BEAM_FRAG]) {
      expect(src).toContain('#include <tonemapping_fragment>')
      expect(src).toContain('#include <colorspace_fragment>')
    }
  })

  it('each fragment declares the uniforms its factory makes, no more and no fewer', () => {
    expect(declared(DISC_FRAG)).toEqual(Object.keys(discUniforms(disc, 'high')).sort())
    expect(declared(SHAFT_FRAG)).toEqual(Object.keys(shaftUniforms('#3fd0ff')).sort())
    expect(declared(BEAM_FRAG)).toEqual(Object.keys(beamUniforms('#3fd0ff')).sort())
    expect(declared(GRADE_FRAG)).toEqual(Object.keys(gradeUniforms('high')).sort())
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
    for (const src of [DISC_FRAG, SHAFT_FRAG, BEAM_FRAG]) expect(src).toMatch(/min\([^;]*vec3\(HOLO_MAX\)\)/)
    for (const src of [DISC_FRAG, SHAFT_FRAG, BEAM_FRAG]) expect(src).toContain(`#define HOLO_MAX ${STAGE_MAX}`)
    // The grade only darkens (the vignette) and adds grain round zero, kept from going below black.
    expect(GRADE_FRAG).toMatch(/max\(c\.rgb, vec3\(0\.0\)\)/)
  })
})
