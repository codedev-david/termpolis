// Lumopolis themes: plain colour data, no Three.js. The renderer turns these strings into materials. Holotable (look
// spec §3.1) replaced Neon (D2); Blueprint and Glass keep the prototype's palettes. Background, glow and text come
// from the theme's palette (holoPalette.ts), so the two never disagree.
import { PALETTES } from './holoPalette'

export interface Theme {
  background: string
  /** Platform and rim colour of a district. */
  district: string
  conduit: string
  glow: string
  text: string
  /** Exponential fog density; the renderer scales it up while a building is open. */
  fogDensity: number
}

// The theme pickers (the toolbar's and the exported page's) show each name capitalized: "Holotable" where "Neon" was.
export type ThemeName = 'holotable' | 'blueprint' | 'glass' // PENDING SIGN-OFF

/** The theme the map opens in. */
export const DEFAULT_THEME: ThemeName = 'holotable'

const H = PALETTES.holotable
const B = PALETTES.blueprint
const G = PALETTES.glass

/**
 * Holotable's district colour is its background lifted 8% toward holo (#06141d), a dark navy platform just above the
 * table, as Neon's was above its own background; its fog is Neon's 0.006, as the layout's scale did not change.
 */
export const THEMES: Record<ThemeName, Theme> = {
  holotable: { background: H.background, district: '#06141d', conduit: H.holo, glow: H.holo, text: H.ink, fogDensity: 0.006 },
  blueprint: { background: B.background, district: '#0a2647', conduit: '#bae6fd', glow: B.holo, text: B.ink, fogDensity: 0.005 },
  glass: { background: G.background, district: '#1f2937', conduit: '#93c5fd', glow: G.holo, text: G.ink, fogDensity: 0.0045 },
}

/** The names a theme was saved or passed under before it was renamed: Neon became Holotable (D2). */
const RENAMED: ReadonlyArray<readonly [string, ThemeName]> = [['neon', 'holotable']]

/**
 * A theme name as the map knows it: a current name as it is, a renamed one (`neon`) as its new name, anything else
 * null (left alone by the caller, as an unknown theme always was).
 */
export function normalizeTheme(name: unknown): ThemeName | null {
  if (typeof name !== 'string') return null
  if (Object.keys(THEMES).includes(name)) return name as ThemeName
  const renamed = RENAMED.find(([old]) => old === name)
  return renamed ? renamed[1] : null
}
