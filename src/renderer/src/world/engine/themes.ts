// Lumopolis themes: plain colour data, no Three.js. The renderer (Task 12) turns these strings
// into materials. Values follow the prototype's neon / blueprint / glass palettes.

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

export type ThemeName = 'neon' | 'blueprint' | 'glass'

export const THEMES: Record<ThemeName, Theme> = {
  neon: { background: '#03050a', district: '#0a0f1c', conduit: '#60a5fa', glow: '#22d3ee', text: '#e2e8f0', fogDensity: 0.006 },
  blueprint: { background: '#061a33', district: '#0a2647', conduit: '#bae6fd', glow: '#7dd3fc', text: '#f0f9ff', fogDensity: 0.005 },
  glass: { background: '#111827', district: '#1f2937', conduit: '#93c5fd', glow: '#67e8f9', text: '#f8fafc', fogDensity: 0.0045 },
}
