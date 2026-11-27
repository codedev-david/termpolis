// The Holotable stage's shaders (look spec §3.2-3.4): the projector disc, the light shafts, the beams and the grade
// pass, with the uniforms each is made with and the pure geometry of the shafts and beams. Pure: no Three.js, no
// clock, no window; threeRenderer makes the objects and feeds the clocks.
//
// GLSL 1 throughout (texture2D, gl_FragColor, attribute, varying) and no #version: three.js writes the version line
// and, on WebGL 2, maps those words to GLSL 3; r160 still falls back to WebGL 1. holoShaders.test.ts pins both.
import { gradeOf, type StageMark } from './holoMarks'
import { TIER_LOOK, type TierName } from './tierBudget'

/** The define every Holotable shader carries, which the bundle check (plan Task 16) looks for in the built viewers. */
export const HOLO_SLAB = 'HOLO_SLAB'

/** The disc's height at rest (the spike's), under the grid (-1.3) and the plates, whose foot is at PLATE_FOOT. */
export const DISC_Y = -1.4
/** The underside of a district plate (its 1.2-tall prism stands at y -0.6). */
export const PLATE_FOOT = -1.2
/** The outside-ring track lies just above the disc. */
export const TRACK_Y = DISC_Y + 0.05
/** The beams' strength (the spike's uK). */
export const BEAM_K = 0.15
/** A beam's radius, as a share of its plate's. */
const BEAM_SHARE = 0.86
/** The brightest any light the stage adds may be, per channel: never white (world-visual's MAX_WHITE_FRACTION). */
export const STAGE_MAX = 0.9
/** The disc's gain where bloom adds its glow (High and Low), and at Flat, where nothing does. */
export const DISC_GAIN = { bloomed: 0.6, flat: 0.8 } as const

/** How fast each moving part of the stage goes, in Hz (turns or cycles a second). Nothing exceeds 3 Hz (look spec §7). */
export const MOTION_HZ = {
  /** The cyan arcs round the disc's rim. */
  arcA: 0.012,
  /** The amber arcs, the other way. */
  arcB: 0.02,
  /** The sweep, while the world is working. */
  sweep: 0.045,
  /** The two ripples in the light shafts (the spike's 0.35 and 0.22 rad/s). */
  shaftA: 0.056,
  shaftB: 0.035,
  /** The light rising up the beams (the spike's 6 rad/s). */
  beam: 0.95,
  /** How often the grain changes. */
  grain: 2.5,
} as const

/** A number as a GLSL float literal. */
export const glf = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n))

const HEAD = `#define ${HOLO_SLAB} 1\n#define HOLO_TAU 6.28318531\n#define HOLO_MAX ${glf(STAGE_MAX)}\n`
/** Every lit fragment ends the way three.js's own materials do: tone mapped (on screen) and in the output's colour space. */
const TAIL = '  #include <tonemapping_fragment>\n  #include <colorspace_fragment>\n'

export const DISC_VERT = `${HEAD}varying vec3 vL;
void main() {
  vL = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const DISC_FRAG = `${HEAD}uniform float uR;
uniform float uTime;
uniform float uSweep;
uniform float uSweepOn;
uniform vec3 uCyan;
uniform vec3 uAmber;
uniform float uGain;
varying vec3 vL;
float ringL(float r, float at, float fr, float px) { return 1.0 - smoothstep(0.0, px * fr, abs(r - at)); }
float band(float r, float a, float b, float fr) { return smoothstep(a - fr, a, r) * (1.0 - smoothstep(b, b + fr, r)); }
float tick(float a, float n, float fa) { float t = fract(a * n); return 1.0 - smoothstep(0.5, 1.5, min(t, 1.0 - t) / max(fa * n, 1e-5)); }
void main() {
  float r = length(vL.xz) / uR;
  if (r > 1.12) discard;
  float fr = max(fwidth(r), 1e-5);
  float a = atan(vL.z, vL.x + 1e-4) / HOLO_TAU + 0.5;
  float fa = min(max(fwidth(a), 1e-6), 0.002);
  float k = 0.09 * exp(-r * r * 2.6) + 0.035 * (1.0 - smoothstep(0.15, 1.0, r));
  k += ringL(r, 1.0, fr, 1.6) + 0.4 * ringL(r, 0.986, fr, 1.0) + 0.32 * ringL(r, 0.9, fr, 1.0) + 0.16 * ringL(r, 0.62, fr, 1.0) + 0.12 * ringL(r, 0.34, fr, 1.0);
  float t10 = tick(a, 36.0, fa) * band(r, 0.918, 0.975, fr);
  float t2 = tick(a, 180.0, fa) * band(r, 0.952, 0.975, fr);
  k += 0.5 * t10 + 0.26 * t2;
  float spokes = tick(a, 24.0, fa) * step(0.34, r) * step(r, 0.9) * 0.05;
  float cr = fract(r * 18.0);
  float conc = (1.0 - smoothstep(0.5, 1.5, min(cr, 1.0 - cr) / (fr * 18.0))) * step(r, 0.9) * 0.035;
  float arcs = band(r, 1.022, 1.036, fr) * step(fract(fract(a + uTime * ${glf(MOTION_HZ.arcA)}) * 3.0), 0.21);
  float arcB = band(r, 1.056, 1.062, fr) * step(fract(fract(a - uTime * ${glf(MOTION_HZ.arcB)}) * 2.0), 0.07);
  float dots = tick(a, 90.0, fa * 2.0) * band(r, 1.08, 1.086, fr) * 0.5;
  float sweep = exp(-fract(a - uSweep) * 18.0) * step(r, 0.9) * 0.06 * uSweepOn;
  vec3 col = uCyan * (k + spokes + conc + arcs * 0.75 + dots + sweep) + uAmber * (arcB * 0.7 + t10 * step(0.99, fract(a * 4.0 + 0.005)) * 1.2);
  gl_FragColor = vec4(min(col * uGain, vec3(HOLO_MAX)), 1.0);
${TAIL}}
`

export const SHAFT_VERT = `${HEAD}attribute float aK;
varying float vK;
varying vec2 vUv;
void main() {
  vK = aK;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const SHAFT_FRAG = `${HEAD}uniform float uTime;
uniform vec3 uCyan;
varying float vK;
varying vec2 vUv;
void main() {
  float fall = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 2.4);
  float s = 0.5 + 0.5 * sin(vUv.x * HOLO_TAU * 29.0 + uTime * HOLO_TAU * ${glf(MOTION_HZ.shaftA)}) * sin(vUv.x * HOLO_TAU * 9.0 - uTime * HOLO_TAU * ${glf(MOTION_HZ.shaftB)});
  s = s * s * s;
  float k = fall * (0.02 + 0.11 * s) * vK;
  gl_FragColor = vec4(min(uCyan * k, vec3(HOLO_MAX)), 1.0);
${TAIL}}
`

export const BEAM_VERT = `${HEAD}varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const BEAM_FRAG = `${HEAD}uniform float uTime;
uniform float uK;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float h = vUv.y;
  float k = (0.05 + 0.25 * pow(clamp(1.0 - h, 0.0, 1.0), 3.0)) * uK * (0.8 + 0.2 * sin(h * 40.0 - uTime * HOLO_TAU * ${glf(MOTION_HZ.beam)}));
  gl_FragColor = vec4(min(uColor * k, vec3(HOLO_MAX)), 1.0);
${TAIL}}
`

export const GRADE_VERT = `${HEAD}varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

/** The last pass, on the finished picture: a vignette, and grain whose pattern changes only when uSeed steps. */
export const GRADE_FRAG = `${HEAD}uniform sampler2D tDiffuse;
uniform float uSeed;
uniform float uGrain;
uniform float uVignette;
varying vec2 vUv;
float holoHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec2 d = (vUv - 0.5) * vec2(1.0, 0.82);
  float v = 1.0 - smoothstep(0.18, 0.78, length(d));
  c.rgb *= mix(1.0 - uVignette, 1.0, v);
  c.rgb += (holoHash(vUv * vec2(1931.0, 1213.0) + fract(uSeed * 0.618034)) - 0.5) * uGrain;
  c.rgb = max(c.rgb, vec3(0.0));
  gl_FragColor = c;
}
`

/** A `#rrggbb` colour in linear light, as three.js keeps its own colours (sRGB decoded). */
export function linearRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  const lin = (byte: number): number => {
    const c = byte / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)]
}

interface Uniform<T> { value: T }
export interface DiscUniforms {
  uR: Uniform<number>; uTime: Uniform<number>; uSweep: Uniform<number>; uSweepOn: Uniform<number>
  uCyan: Uniform<number[]>; uAmber: Uniform<number[]>; uGain: Uniform<number>
}
export interface GradeUniforms { tDiffuse: Uniform<null>; uSeed: Uniform<number>; uGrain: Uniform<number>; uVignette: Uniform<number> }

/** The disc's gain at `tier`: lower where bloom adds its glow (High and Low) than at Flat, where nothing does. */
export const discGain = (tier: TierName): number => (TIER_LOOK[tier].bloom ? DISC_GAIN.bloomed : DISC_GAIN.flat)

/** The disc's uniforms: its radius and colours from the disc mark, its gain from whether the tier blooms. */
export function discUniforms(disc: Extract<StageMark, { kind: 'disc' }>, tier: TierName): DiscUniforms {
  return {
    uR: { value: disc.radius },
    uTime: { value: 0 },
    uSweep: { value: 0 },
    uSweepOn: { value: 0 },
    uCyan: { value: linearRgb(disc.color) },
    uAmber: { value: linearRgb(disc.arcColor) },
    uGain: { value: discGain(tier) },
  }
}

/** The grade pass's uniforms at `tier` (gradeOf: the vignette at High and Low, grain only at High). */
export function gradeUniforms(tier: TierName): GradeUniforms {
  const g = gradeOf(tier)
  return { tDiffuse: { value: null }, uSeed: { value: 0 }, uGrain: { value: g.grain }, uVignette: { value: g.vignette } }
}

export function shaftUniforms(color: string): { uTime: Uniform<number>; uCyan: Uniform<number[]> } {
  return { uTime: { value: 0 }, uCyan: { value: linearRgb(color) } }
}

export function beamUniforms(color: string): { uTime: Uniform<number>; uK: Uniform<number>; uColor: Uniform<number[]> } {
  return { uTime: { value: 0 }, uK: { value: BEAM_K }, uColor: { value: linearRgb(color) } }
}

/** The light shafts standing on a disc of radius `r`: the wide one, then (where the tier draws two) the narrow one. */
export function shaftParts(r: number, count: number): Array<{ radius: number; height: number; k: number }> {
  return [{ radius: r, height: r * 0.55, k: 1 }, { radius: r * 0.62, height: r * 0.32, k: 0.6 }].slice(0, count)
}

/** One beam per plate, from the disc up to the plate's underside, inside its rim. `radii[i]` is plate `to[i]`'s radius. */
export function beamParts(to: ReadonlyArray<readonly [number, number]>, radii: readonly number[]): Array<{ x: number; z: number; radius: number; y0: number; y1: number }> {
  return to.map(([x, z], i) => ({ x, z, radius: radii[i] * BEAM_SHARE, y0: DISC_Y, y1: PLATE_FOOT }))
}
