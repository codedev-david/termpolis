import { describe, it, expect, beforeEach } from 'vitest'
const { getSettings, setSettings, resetSettings, thresholdsFor, MAX_COMPRESS_BYTES } =
  await import('../../src/main/headroom/config')

describe('headroom config', () => {
  beforeEach(() => resetSettings())

  it('defaults to enabled + aggressive + steering on, thinking cap OFF', () => {
    // thinkingCap defaults to 0 on purpose: it is the one control that trades reasoning depth
    // rather than recoverable inline context, so it never turns itself on.
    expect(getSettings()).toEqual({ enabled: true, mode: 'aggressive', steering: true, thinkingCap: 0, adaptiveSteering: true, floorControl: true, prefixDecay: false })
  })

  it('accepts a thinking cap and adaptive-steering toggle, rejecting garbage caps', () => {
    expect(setSettings({ thinkingCap: 8000 }).thinkingCap).toBe(8000)
    expect(setSettings({ thinkingCap: 4000.9 }).thinkingCap).toBe(4000) // floored, never rounded up
    expect(setSettings({ thinkingCap: -1 }).thinkingCap).toBe(4000) // negative rejected outright
    expect(setSettings({ thinkingCap: NaN }).thinkingCap).toBe(4000)
    expect(setSettings({ thinkingCap: 'lots' as unknown as number }).thinkingCap).toBe(4000)
    expect(setSettings({ thinkingCap: 0 }).thinkingCap).toBe(0) // 0 is a real value: off
    expect(setSettings({ adaptiveSteering: false }).adaptiveSteering).toBe(false)
  })

  it('setSettings merges partials and returns the new state', () => {
    expect(setSettings({ enabled: false })).toEqual({ enabled: false, mode: 'aggressive', steering: true, thinkingCap: 0, adaptiveSteering: true, floorControl: true, prefixDecay: false })
    expect(setSettings({ mode: 'conservative' })).toEqual({ enabled: false, mode: 'conservative', steering: true, thinkingCap: 0, adaptiveSteering: true, floorControl: true, prefixDecay: false })
    expect(getSettings().mode).toBe('conservative')
  })

  it('setSettings ignores an invalid mode', () => {
    setSettings({ mode: 'nonsense' as unknown as 'balanced' })
    expect(getSettings().mode).toBe('aggressive')
  })

  it('thresholds get stricter as mode escalates', () => {
    expect(thresholdsFor('conservative').floorTokens).toBeGreaterThan(thresholdsFor('balanced').floorTokens)
    expect(thresholdsFor('aggressive').topK).toBeLessThan(thresholdsFor('balanced').topK)
    expect(MAX_COMPRESS_BYTES).toBe(4_000_000)
  })
})

/**
 * The two v1.34.0 controls. Both change how hard the app compresses without the user touching the
 * mode selector, so both need the same rejection-of-garbage discipline as the thinking cap: a
 * malformed IPC payload must never be able to turn compression up, or decay on, by accident.
 */
describe('headroom config — floor control and prefix decay', () => {
  beforeEach(() => resetSettings())

  it('holds the savings floor by default, and leaves prefix decay off', () => {
    // Floor control is free — it only picks a tier at launch. Decay pays a real cache break, so it
    // is the one control here that can cost money, and it does not ship on.
    expect(getSettings().floorControl).toBe(true)
    expect(getSettings().prefixDecay).toBe(false)
  })

  it('accepts the max tier the floor controller escalates into', () => {
    expect(setSettings({ mode: 'max' }).mode).toBe('max')
  })

  it('still rejects a mode that is not on the ladder', () => {
    setSettings({ mode: 'balanced' })
    expect(setSettings({ mode: 'sideways' as never }).mode).toBe('balanced')
  })

  it('ignores non-boolean values rather than coercing them', () => {
    setSettings({ floorControl: true, prefixDecay: false })
    expect(setSettings({ floorControl: 'yes' as never }).floorControl).toBe(true)
    expect(setSettings({ prefixDecay: 1 as never }).prefixDecay).toBe(false)
    expect(setSettings({ prefixDecay: null as never }).prefixDecay).toBe(false)
  })

  it('round-trips both flags when set explicitly', () => {
    const s = setSettings({ floorControl: false, prefixDecay: true })
    expect(s.floorControl).toBe(false)
    expect(s.prefixDecay).toBe(true)
  })
})
