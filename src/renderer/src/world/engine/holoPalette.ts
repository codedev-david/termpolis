// The Holotable look's palette (look spec §3.1): the colour tokens of each theme, and the two folds a district's plate
// takes, its hue into the blue family and its brightness by member count. Plain data and arithmetic: no Three.js.
import { HEAT_COLOR } from './sceneModel'
import type { ThemeName } from './themes'

/** The colour tokens one palette holds (look spec §3.1). */
export interface HoloPalette {
  /** Clear colour, pane and canvas host background, export page body. */
  background: string
  /** The cyan family: plates, slab edges, the disc, a conduit's base glow. */
  holo: string
  /** Label and card text. */
  ink: string
  /** Secondary text. */
  muted: string
  /** Amber: built parts with no tests, hot links, the travelling pulse head, the focus ring. */
  attention: string
  /** Outside orbs. */
  orb: string
  /** Live latency (heat): HEAT_COLOR in every palette. */
  heat: string
  /** The verified ring. */
  seal: string
  /** The selection mark (D1). */
  select: string
}

/** The selection colour, ice-white in every palette (look spec §10, D1): amber already means "built, no tests". */
export const selectColor = '#eafaff'

/**
 * Holotable is look spec §3.1's table. Blueprint and Glass keep their backgrounds, glow and text from the older themes
 * (themes.ts) and their verified-ring greens from the renderer's tuning; amber, heat and selection are shared.
 */
export const PALETTES: Record<ThemeName, HoloPalette> = {
  holotable: { background: '#010409', holo: '#3fd0ff', ink: '#d6f3ff', muted: 'rgba(150,205,230,.55)', attention: '#ffae42', orb: '#7fdcff', heat: HEAT_COLOR, seal: '#4ade80', select: selectColor },
  blueprint: { background: '#061a33', holo: '#7dd3fc', ink: '#f0f9ff', muted: 'rgba(186,230,253,.6)', attention: '#ffae42', orb: '#bae6fd', heat: HEAT_COLOR, seal: '#99f6e4', select: selectColor },
  glass: { background: '#111827', holo: '#67e8f9', ink: '#f8fafc', muted: 'rgba(203,213,225,.6)', attention: '#ffae42', orb: '#93c5fd', heat: HEAT_COLOR, seal: '#6ee7b7', select: selectColor },
}

/** A district's hue folded into the blue family: 186 + ((h * 0.37) mod 38) degrees, in [186, 224). */
export function foldHue(h: number): number {
  return 186 + ((((h * 0.37) % 38) + 38) % 38)
}

/** A plate's brightness by its member count: min(1, 2.2 / sqrt(n)), so a big district does not outshine the rest. */
export function memberGain(n: number): number {
  return Math.min(1, 2.2 / Math.sqrt(n))
}

/** `#rrggbb` of an HSL colour: hue in degrees (any angle), saturation and lightness 0..1. */
export function hslHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l)
  const channel = (n: number): string => {
    const k = (((n + h / 30) % 12) + 12) % 12
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(v * 255).toString(16).padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

/** A district plate's colour: its folded hue at saturation 0.9 and lightness 0.56 (look spec §3.1). */
export const plateColor = (h: number): string => hslHex(foldHue(h), 0.9, 0.56)

/** A `#rrggbb` token as the number three.js colours take. */
export const hexNumber = (hex: string): number => parseInt(hex.slice(1), 16)

/** A label's text halo (look spec §3.6): a 1px black edge, then 2px of the background, so text keeps 4.5:1 on a lit slab. */
export const labelHalo = (p: HoloPalette): string => `0 0 1px #000, 0 0 2px ${p.background}`
