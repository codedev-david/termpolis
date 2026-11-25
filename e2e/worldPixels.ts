// The pixel metrics the Lumopolis e2e specs measure a screenshot of the map's canvas by (moved out of
// world-visual.spec.ts, thresholds unchanged; look plan Task 0). Metrics, never golden images.
import { PNG } from 'pngjs'

/**
 * Thresholds, from luminance Y = 0.2126 R + 0.7152 G + 0.0722 B (0 to 255) over the canvas with the
 * labels and panels hidden. The background is the canvas's most common Y; a pixel is "lit" when its
 * Y is LIT_MARGIN above it, and the mean is taken over the background's Y, so the lighter Blueprint
 * and Glass backgrounds never pass on their colour alone. A pixel is "white" when its darkest
 * channel is at least WHITE_MIN: saturated white, what a bloomed-out fog cloud or a knot of
 * lines turns into.
 *
 * Measured locally (SwiftShader, 1280x800 window), mean over background / lit / white:
 *
 *   | case                         | neon                     | blueprint                | glass                    |
 *   |------------------------------|--------------------------|--------------------------|--------------------------|
 *   | small, after fix round 1     | 11.6 / 8.23 % / 0.000 %  | 12.4 / 11.32 % / 0.000 % | 7.6 / 4.89 % / 0.004 %   |
 *   | big, after fix round 1       | 35.4 / 32.31 % / 0.000 % | 33.3 / 32.28 % / 0.000 % | 20.4 / 14.08 % / 0.002 % |
 *   | big, first pass (whited out) | 29.1 / 24.1 % / -        | 32.8 / 35.9 % / -        | 16.2 / 12.9 % / -        |
 *   | big, before Task 7 (fogged)  | 0.7 / 0.2 % / -          |                          |                          |
 *
 * The approved prototype's page measures 10.5 / 5.8 % (labels and panels included).
 * The floors sit under the dimmest fixed case and over the fogged one; the white cap sits over the
 * fixed cases and under the first pass's whiteout.
 */
export const LIT_MARGIN = 32
export const MIN_MEAN_OVER_BACKGROUND = 3.5
export const MIN_LIT_FRACTION = 0.01
export const WHITE_MIN = 235
export const MAX_WHITE_FRACTION = 0.005
/** How far, in levels of any channel, a corner of the canvas may lie from the theme's background (look spec §5.3). */
export const CORNER_MAX_LEVELS = 8

export interface PngMetrics {
  /** Mean luminance over the whole shot. */
  mean: number
  /** The share of pixels lit: LIT_MARGIN over the background's luminance. */
  lit: number
  /** The share of pixels saturated white (WHITE_MIN). */
  white: number
  /** The background's luminance: the shot's most common one. */
  bgY: number
}

/** Mean luminance, lit and white fractions of a PNG shot, against its own background (its most common luminance). */
export function pngMetrics(buf: Buffer): PngMetrics {
  const png = PNG.sync.read(buf)
  const n = png.width * png.height
  const ys = new Float32Array(n)
  const hist = new Array<number>(256).fill(0)
  let sum = 0
  let white = 0
  for (let p = 0; p < n; p++) {
    const i = p * 4
    if (Math.min(png.data[i], png.data[i + 1], png.data[i + 2]) >= WHITE_MIN) white++
    const y = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]
    ys[p] = y
    sum += y
    hist[Math.round(y)]++
  }
  const bgY = hist.indexOf(Math.max(...hist))
  let lit = 0
  for (const y of ys) if (y > bgY + LIT_MARGIN) lit++
  return { mean: sum / n, lit: lit / n, white: white / n, bgY }
}

/**
 * The colour of each `size` x `size` corner patch of a PNG shot, top left, top right, bottom left, bottom right: each
 * channel's median over the patch, so a star that lands in a corner does not move it.
 */
export function cornerPatches(buf: Buffer, size = 8): Array<[number, number, number]> {
  const png = PNG.sync.read(buf)
  const s = Math.min(size, png.width, png.height)
  const at = (x0: number, y0: number): [number, number, number] => {
    const ch: number[][] = [[], [], []]
    for (let y = y0; y < y0 + s; y++) {
      for (let x = x0; x < x0 + s; x++) {
        const i = (y * png.width + x) * 4
        for (let c = 0; c < 3; c++) ch[c].push(png.data[i + c])
      }
    }
    const median = (v: number[]): number => v.sort((a, b) => a - b)[v.length >> 1]
    return [median(ch[0]), median(ch[1]), median(ch[2])]
  }
  return [at(0, 0), at(png.width - s, 0), at(0, png.height - s), at(png.width - s, png.height - s)]
}

/** A CSS colour '#rrggbb' (as themes.ts writes them) as [r, g, b]. */
export function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`)
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

/**
 * A theme background as the 3D map draws it: the clear colour goes through the High tier's OutputPass, so ACESFilmic tone
 * mapping (exposure 1) and the sRGB encoding apply to it as to everything else in the frame. This mirrors three 0.160's
 * `ACESFilmicToneMapping` (tonemapping_pars_fragment) and its sRGB transfer, in bytes. Neon's #03050a draws as about
 * rgb(0, 0, 1): 9 levels from the theme colour, so the corners are held to this, not to the raw colour.
 */
export function drawnBackground(hex: string, exposure = 1): [number, number, number] {
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const enc = (l: number): number => {
    const v = Math.min(1, Math.max(0, l))
    return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055))
  }
  const IN = [[0.59719, 0.35458, 0.04823], [0.076, 0.90834, 0.01566], [0.0284, 0.13383, 0.83777]]
  const OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]]
  const mul = (m: number[][], v: number[]): number[] => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])
  const fit = (v: number): number => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081)
  const c = hexRgb(hex).map((b) => (lin(b / 255) * exposure) / 0.6)
  const out = mul(OUT, mul(IN, c).map(fit)).map(enc)
  return [out[0], out[1], out[2]]
}

/** The most any channel of `a` lies from `b`'s. */
export const levelsApart = (a: readonly number[], b: readonly number[]): number => Math.max(...a.map((v, i) => Math.abs(v - b[i])))
