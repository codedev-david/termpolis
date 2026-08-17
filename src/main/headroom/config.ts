export type Mode = 'conservative' | 'balanced' | 'aggressive' | 'max'
export interface HeadroomSettings {
  enabled: boolean
  mode: Mode
  steering: boolean
  /**
   * Ceiling on `thinking.budget_tokens`, in tokens. 0 = off.
   *
   * Off by default on purpose. Every other Token Headroom control trades inline context for
   * tokens and is recoverable via retrieve_full; this one trades REASONING DEPTH, which isn't
   * recoverable, so it stays an explicit opt-in even though output is the largest untouched slice
   * of spend. Values below Anthropic's 1024 floor are raised to it by the wire clamp.
   */
  thinkingCap: number
  /**
   * Let the launch-time steering strength follow measured output volume instead of sitting at
   * whatever `mode` says. Chosen once per launch (never per turn — the directive rides in the
   * re-sent system prompt, so per-turn variation would bust the prompt cache).
   */
  adaptiveSteering: boolean
  /**
   * Let the launch-time wire tier escalate when the measured ledger shows the 50% savings floor
   * isn't being held. Escalates only — never drops below the configured mode. Like adaptive
   * steering, it is resolved once per launch and frozen, because the compressed history rides in
   * the cached prefix and re-tiering mid-conversation would invalidate it.
   */
  floorControl: boolean
  /**
   * Prefix decay: age the oldest half of a long conversation down to retrievable stubs.
   *
   * ON by default since v1.36.0 — and it is the one control here that is a BET, so the reasoning
   * has to stay written down. Every other control is free: it leaves the cached prefix
   * byte-identical. This one deliberately breaks the cache (~1.15x the prefix, ~78,000 effective
   * units on measured traffic) to buy a smaller prefix on every later turn, so it only comes out
   * ahead if the session keeps going. Break-even is ~44 turns; the first cut waits for 128
   * messages, which is ~3x that margin, and retrieve_full now works, so a decayed stub is
   * recoverable rather than lost. Those two facts are what turned the bet into the default —
   * if either regresses, flip this back to false. See headroomProxy/prefixDecay.ts.
   */
  prefixDecay: boolean
}
export interface Thresholds {
  floorTokens: number
  topK: number
  maxFieldChars: number
  headLines: number
  tailLines: number
}

export const MAX_COMPRESS_BYTES = 4_000_000
const MODES: Mode[] = ['conservative', 'balanced', 'aggressive', 'max']
// Default 'aggressive': Token Headroom is the product's core value, so out of the box it
// compresses the tool-output slice as hard as the profile allows (keeps the head + tail an
// agent needs; the rest is recoverable via retrieve_full). Users who want more inline context
// can dial to balanced/conservative — the selector now drives the live wire (see proxySupervisor).
const DEFAULTS: HeadroomSettings = { enabled: true, mode: 'aggressive', steering: true, thinkingCap: 0, adaptiveSteering: true, floorControl: true, prefixDecay: true }

let current: HeadroomSettings = { ...DEFAULTS }

export function getSettings(): HeadroomSettings {
  return { ...current }
}

export function setSettings(p: Partial<HeadroomSettings>): HeadroomSettings {
  const next: HeadroomSettings = { ...current }
  if (typeof p.enabled === 'boolean') next.enabled = p.enabled
  if (typeof p.steering === 'boolean') next.steering = p.steering
  if (typeof p.adaptiveSteering === 'boolean') next.adaptiveSteering = p.adaptiveSteering
  if (typeof p.floorControl === 'boolean') next.floorControl = p.floorControl
  if (typeof p.prefixDecay === 'boolean') next.prefixDecay = p.prefixDecay
  // Negative / NaN / non-numeric are rejected outright rather than coerced: a garbled cap must
  // never become a real ceiling on someone's reasoning budget.
  if (typeof p.thinkingCap === 'number' && Number.isFinite(p.thinkingCap) && p.thinkingCap >= 0) next.thinkingCap = Math.floor(p.thinkingCap)
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
  // Headroom ABOVE aggressive, so the savings-floor controller has somewhere to escalate to.
  // The decisive knob is floorTokens: at 'aggressive' every block under ~1600 chars is passed
  // through completely untouched, which is the largest untapped slice of the wire. 150 (~600
  // chars) reaches most of it while staying clear of the point where compaction's own footer
  // would outweigh the saving — and compactOrDedup's `best.length < text.length` guard makes
  // that inflation impossible regardless.
  max:          { floorTokens: 150,  topK: 4,  maxFieldChars: 500,  headLines: 6,  tailLines: 3 },
}

export function thresholdsFor(mode: Mode): Thresholds {
  return TABLE[mode] ?? TABLE.balanced
}
