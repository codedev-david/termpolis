export type Mode = 'conservative' | 'balanced' | 'aggressive'
export interface HeadroomSettings { enabled: boolean; mode: Mode; steering: boolean }
export interface Thresholds {
  floorTokens: number
  topK: number
  maxFieldChars: number
  headLines: number
  tailLines: number
}

export const MAX_COMPRESS_BYTES = 4_000_000
const MODES: Mode[] = ['conservative', 'balanced', 'aggressive']
// Default 'aggressive': Token Headroom is the product's core value, so out of the box it
// compresses the tool-output slice as hard as the profile allows (keeps the head + tail an
// agent needs; the rest is recoverable via retrieve_full). Users who want more inline context
// can dial to balanced/conservative — the selector now drives the live wire (see proxySupervisor).
const DEFAULTS: HeadroomSettings = { enabled: true, mode: 'aggressive', steering: true }

let current: HeadroomSettings = { ...DEFAULTS }

export function getSettings(): HeadroomSettings {
  return { ...current }
}

export function setSettings(p: Partial<HeadroomSettings>): HeadroomSettings {
  const next: HeadroomSettings = { ...current }
  if (typeof p.enabled === 'boolean') next.enabled = p.enabled
  if (typeof p.steering === 'boolean') next.steering = p.steering
  if (p.mode && MODES.includes(p.mode)) next.mode = p.mode
  current = next
  return { ...current }
}

export function resetSettings(): void {
  current = { ...DEFAULTS }
}

const TABLE: Record<Mode, Thresholds> = {
  conservative: { floorTokens: 1500, topK: 25, maxFieldChars: 4000, headLines: 40, tailLines: 20 },
  balanced:     { floorTokens: 800,  topK: 12, maxFieldChars: 2000, headLines: 24, tailLines: 12 },
  aggressive:   { floorTokens: 400,  topK: 6,  maxFieldChars: 1000, headLines: 12, tailLines: 6 },
}

export function thresholdsFor(mode: Mode): Thresholds {
  return TABLE[mode] ?? TABLE.balanced
}
