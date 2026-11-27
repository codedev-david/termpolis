// The Holotable stage's shaders (look spec §3.2-3.4): the projector disc, the light shafts, the beams and the grade
// pass, with the uniforms each is made with and the pure geometry of the shafts and beams. Pure: no Three.js, no
// clock, no window; threeRenderer makes the objects and feeds the clocks.
//
// GLSL 1 throughout (texture2D, gl_FragColor, attribute, varying) and no #version: three.js writes the version line
// and, on WebGL 2, maps those words to GLSL 3; r160 still falls back to WebGL 1. holoShaders.test.ts pins both.
import { gradeOf, type StageMark } from './holoMarks'
import type { Look } from './sceneModel'
import { TIER_LOOK, type TierName } from './tierBudget'
import { easeShare } from './viewMath'

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

// ---------------- the hologram slab and the district plate (look spec §3.2, §3.3) ----------------

/** A dimmed slab's light, as a share of its lit light (look spec §3.2). */
export const SLAB_DIM = 0.14
/** How fast a slab's fill falls with the floors above it along a view ray (look spec §3.3's white-out budget). */
export const STACK_FALL = 0.12
/** The states a slab's `aState` takes: each inside its band, away from the band edges the shader tests. */
export const SLAB_STATE = { selected: 1.5, hovered: 1, related: 0.5, rest: 0, dimmed: -1 } as const
/** A slab's gain where bloom adds its glow (High and Low), and at Flat, where nothing does (look spec §3.3). */
export const SLAB_GAIN = { bloomed: 0.8, flat: 1.3 } as const
/** Each look's `aLook` code: by it the shader draws a wire with no fill, a fog veil or a fading pulse. */
export const LOOK_CODE: Record<Look, number> = { solid: 0, wire: 1, amber: 2, fog: 3, fading: 4 }
/** The slab's fill at rest (its fresnel, scan lines, sweep and roof are scaled by it). */
export const SLAB_FILL = 0.3

/**
 * A slab's state (the spike's encoding, look spec §3.2): selected 1.5, hovered 1, related 0.5 (in the focus of what is
 * hovered or selected), dimmed -1 (outside a focus), and 0 with no focus. Selection wins over hover, hover over related.
 */
export function slabState(focus: boolean, selected: boolean, hovered: boolean, related: boolean): number {
  if (selected) return SLAB_STATE.selected
  if (hovered) return SLAB_STATE.hovered
  if (!focus) return SLAB_STATE.rest
  return related ? SLAB_STATE.related : SLAB_STATE.dimmed
}

/** What the slab shader makes of a state: `1 + 0.8 hover + 0.35 related + 0.9 selected`, times SLAB_DIM when dimmed. */
export function slabGain(state: number): number {
  const selected = state >= 1.5 ? 1 : 0
  const hover = state >= 0.75 ? 1 - selected : 0
  const related = state >= 0.25 && state < 0.75 ? 1 : 0
  return (1 + 0.8 * hover + 0.35 * related + 0.9 * selected) * (state <= -0.5 ? SLAB_DIM : 1)
}

/** A slab's fill with `stack` floors above it: `1 / (1 + 0.12 * stack)`, so a tall tower's fill never sums to white. */
export const stackFill = (stack: number): number => 1 / (1 + STACK_FALL * stack)

/** The slab's gain at `tier`: higher at Flat, where no bloom adds its glow. */
export const slabTierGain = (tier: TierName): number => (TIER_LOOK[tier].bloom ? SLAB_GAIN.bloomed : SLAB_GAIN.flat)

const LOOK_TEST = 'float lookIs(float l, float c) { return step(c - 0.5, l) * (1.0 - step(c + 0.5, l)); }\n'

export const SLAB_VERT = `${HEAD}attribute float aState;
attribute float aHeat;
attribute float aStack;
attribute float aLook;
attribute vec3 lineColor;
varying vec3 vBox;
varying vec3 vBoxN;
varying vec3 vN;
varying vec3 vView;
varying float vY;
varying vec3 vFill;
varying vec3 vLine;
varying float vState;
varying float vHeat;
varying float vStack;
varying float vLook;
void main() {
  mat4 inst = mat4(1.0);
  #ifdef USE_INSTANCING
  inst = instanceMatrix;
  #endif
  vec4 wp = modelMatrix * inst * vec4(position, 1.0);
  vBox = position;
  vBoxN = normal;
  vN = normalize(mat3(modelMatrix * inst) * normal);
  vView = cameraPosition - wp.xyz;
  vY = wp.y;
  vFill = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
  vFill = instanceColor;
  #endif
  vLine = lineColor;
  vState = aState;
  vHeat = aHeat;
  vStack = aStack;
  vLook = aLook;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

/**
 * The hologram slab: a fresnel fill, edges from fwidth (on a unit box: uEdges), scan lines sin(worldY * 6.5 - t * 2.2),
 * a slow sweep band and a brighter roof, lit by its state and its look, clamped to HOLO_MAX. No per-slab flicker (§7).
 */
export const SLAB_FRAG = `${HEAD}uniform float uTime;
uniform float uGain;
uniform float uFill;
uniform float uWire;
uniform float uFade;
uniform float uEdges;
uniform vec3 uHeatColor;
varying vec3 vBox;
varying vec3 vBoxN;
varying vec3 vN;
varying vec3 vView;
varying float vY;
varying vec3 vFill;
varying vec3 vLine;
varying float vState;
varying float vHeat;
varying float vStack;
varying float vLook;
${LOOK_TEST}void main() {
  float sel = step(1.5, vState);
  float hov = step(0.75, vState) * (1.0 - sel);
  float rel = step(0.25, vState) * (1.0 - step(0.75, vState));
  float gain = (1.0 + 0.8 * hov + 0.35 * rel + 0.9 * sel) * mix(1.0, ${glf(SLAB_DIM)}, 1.0 - step(-0.5, vState));
  float wire = lookIs(vLook, ${glf(LOOK_CODE.wire)});
  float fog = lookIs(vLook, ${glf(LOOK_CODE.fog)});
  float fading = lookIs(vLook, ${glf(LOOK_CODE.fading)});
  float edge = 0.0;
  if (uEdges > 0.5) {
    vec3 axis = abs(vBoxN);
    vec3 px = (0.5 - abs(vBox)) / max(fwidth(vBox), vec3(1e-6));
    float e = 1e6;
    if (axis.x < 0.5) e = min(e, px.x);
    if (axis.y < 0.5) e = min(e, px.y);
    if (axis.z < 0.5) e = min(e, px.z);
    edge = 1.0 - smoothstep(0.0, 1.0, e);
  }
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 2.0);
  float scan = 0.5 + 0.5 * sin(vY * 6.5 - uTime * 2.2);
  float band = exp(-pow(vY - mod(uTime * 4.0, 80.0) + 10.0, 2.0) * 0.08);
  float roof = step(0.5, vBoxN.y);
  float fill = (0.25 + 0.45 * fres + 0.1 * scan + 0.2 * band + 0.3 * roof) * uFill / (1.0 + ${glf(STACK_FALL)} * vStack);
  fill *= (1.0 - wire) * mix(1.0, 0.6, fog);
  vec3 col = mix(vFill, uHeatColor, vHeat * 0.5) * fill + vLine * edge * mix(1.0, uWire, wire);
  col *= mix(1.0, uFade, fading);
  gl_FragColor = vec4(min(col * gain * uGain, vec3(HOLO_MAX)), 1.0);
${TAIL}}
`

/** The district plate's focus at rest, lit (its building hovered or in focus), selected, and dimmed (look spec §3.2). */
export const PLATE_FOCUS = { rest: 0, lit: 0.5, selected: 0.7, dimmed: -0.5 } as const
/** The plate focus's ease: 0.15 of the way a frame at 60 fps (the spike's step), as a rate in time. */
export const PLATE_EASE_RATE = -60 * Math.log(1 - 0.15)
/** The plate's gain where bloom adds its glow, and at Flat. */
export const PLATE_GAIN = { bloomed: 0.7, flat: 0.9 } as const
/** How far a plate's quad reaches past its hexagon's corners (radius 1): its halo fades out from the corners to here. */
export const PLATE_REACH = 1.4
/** How long a change animation's wave takes to cross its plate, in seconds (once per rise). */
export const PLATE_WAVE_S = 1.6

/** Where a district plate's focus goes: selected 0.7, lit 0.5, dimmed -0.5 outside a focus, and 0 with none. */
export function plateFocusTarget(focus: boolean, lit: boolean, selected: boolean): number {
  if (selected) return PLATE_FOCUS.selected
  if (!focus) return PLATE_FOCUS.rest
  return lit ? PLATE_FOCUS.lit : PLATE_FOCUS.dimmed
}

/** One step of a plate's focus toward `to` over `dt` seconds: by time (easeShare), the same at any frame rate. */
export const easePlate = (from: number, to: number, dt: number): number => from + (to - from) * easeShare(PLATE_EASE_RATE, dt)

/** The plate's gain at `tier`. */
export const plateTierGain = (tier: TierName): number => (TIER_LOOK[tier].bloom ? PLATE_GAIN.bloomed : PLATE_GAIN.flat)

export const PLATE_VERT = `${HEAD}attribute float aFocus;
attribute float aWave;
attribute float aHeat;
attribute float aLook;
attribute float aOutline;
varying vec2 vP;
varying vec2 vW;
varying float vR;
varying vec3 vColor;
varying float vFocus;
varying float vWave;
varying float vHeat;
varying float vLook;
varying float vOutline;
void main() {
  mat4 inst = mat4(1.0);
  #ifdef USE_INSTANCING
  inst = instanceMatrix;
  #endif
  vec4 wp = modelMatrix * inst * vec4(position, 1.0);
  vP = position.xz;
  vW = wp.xz;
  vR = length(inst[0].xyz);
  vColor = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
  vColor = instanceColor;
  #endif
  vFocus = aFocus;
  vWave = aWave;
  vHeat = aHeat;
  vLook = aLook;
  vOutline = aOutline;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

/**
 * The district plate: a hexagon's distance field on one quad (its corners at ±z, where CylinderGeometry lays a
 * hexagon's), drawn as a rim, an inner rim, a 5-unit grid, a halo and a faint wall band, with a wave out from the centre
 * while aWave runs from 0 to 1 (only on a change animation or a focused district). At the districts tier (uFar) it
 * carries the slab signals: its hottest building's heat on the rim, the proposed-colour outline, the fog veil, the fading pulse.
 */
export const PLATE_FRAG = `${HEAD}uniform float uGain;
uniform float uFar;
uniform float uWire;
uniform float uFade;
uniform vec3 uHeatColor;
uniform vec3 uGhost;
uniform vec3 uFogTint;
varying vec2 vP;
varying vec2 vW;
varying float vR;
varying vec3 vColor;
varying float vFocus;
varying float vWave;
varying float vHeat;
varying float vLook;
varying float vOutline;
${LOOK_TEST}float hexSd(vec2 p) {
  p = abs(p);
  return max(p.x, dot(p, vec2(0.5, 0.8660254))) - 0.8660254;
}
void main() {
  float d = hexSd(vP) * vR;
  float aa = max(fwidth(d), 1e-4);
  float rim = 1.0 - smoothstep(0.0, aa * 1.5, abs(d));
  float inner = 1.0 - smoothstep(0.0, aa * 1.5, abs(d + 1.2));
  vec2 g = abs(fract(vW / 5.0 - 0.5) - 0.5) / max(fwidth(vW / 5.0), vec2(1e-4));
  float inside = 1.0 - step(0.0, d);
  float grid = (1.0 - min(min(g.x, g.y), 1.0)) * inside;
  float wall = smoothstep(-3.0, 0.0, d) * inside;
  float halo = exp(-max(d, 0.0) * 0.6) * (1.0 - inside) * (1.0 - smoothstep(1.0, ${glf(PLATE_REACH)}, length(vP)));
  float r = length(vP) * vR;
  float wave = vWave > 0.0 ? exp(-pow(r - vWave * vR, 2.0) * 0.5) * (1.0 - vWave) * inside : 0.0;
  float far = step(0.5, uFar);
  float fog = lookIs(vLook, ${glf(LOOK_CODE.fog)}) * far;
  float fading = lookIs(vLook, ${glf(LOOK_CODE.fading)}) * far;
  vec3 base = mix(vColor, uFogTint, fog * 0.4);
  vec3 rimCol = mix(base, uHeatColor, vHeat * far);
  float outline = (1.0 - smoothstep(0.0, aa * 1.5, abs(d - 1.0))) * vOutline * far;
  float lit = (1.0 + 0.8 * max(vFocus, 0.0)) * mix(1.0, 0.25, clamp(-vFocus * 2.0, 0.0, 1.0));
  vec3 col = rimCol * rim * 0.9 + base * (inner * 0.4 + grid * 0.12 * (1.0 - fog) + wall * 0.12 + halo * 0.25 + wave * 0.5);
  col = col * lit + uGhost * outline * uWire;
  col *= mix(1.0, uFade, fading);
  if (d > 8.0) discard;
  gl_FragColor = vec4(min(col * uGain, vec3(HOLO_MAX)), 1.0);
${TAIL}}
`

export interface SlabUniforms {
  uTime: Uniform<number>; uGain: Uniform<number>; uFill: Uniform<number>; uWire: Uniform<number>; uFade: Uniform<number>
  uEdges: Uniform<number>; uHeatColor: Uniform<number[]>
}
export interface PlateUniforms {
  uGain: Uniform<number>; uFar: Uniform<number>; uWire: Uniform<number>; uFade: Uniform<number>
  uHeatColor: Uniform<number[]>; uGhost: Uniform<number[]>; uFogTint: Uniform<number[]>
}

/** The slab's uniforms at `tier`, its heat colour `heat` (`#rrggbb`); `edges` draws a unit box's edges (a hexagon's are lines). */
export function slabUniforms(tier: TierName, heat: string, edges: boolean): SlabUniforms {
  return {
    uTime: { value: 0 }, uGain: { value: slabTierGain(tier) }, uFill: { value: SLAB_FILL }, uWire: { value: 1 }, uFade: { value: 1 },
    uEdges: { value: edges ? 1 : 0 }, uHeatColor: { value: linearRgb(heat) },
  }
}

/** The plate's uniforms at `tier`, with the heat colour, the proposed outline's and the fog tint (`#rrggbb` each). */
export function plateUniforms(tier: TierName, colors: { heat: string; ghost: string; fogTint: string }): PlateUniforms {
  return {
    uGain: { value: plateTierGain(tier) }, uFar: { value: 0 }, uWire: { value: 1 }, uFade: { value: 1 },
    uHeatColor: { value: linearRgb(colors.heat) }, uGhost: { value: linearRgb(colors.ghost) }, uFogTint: { value: linearRgb(colors.fogTint) },
  }
}
