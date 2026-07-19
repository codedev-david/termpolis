import { describe, it, expect, beforeEach } from 'vitest'
const { getSettings, setSettings, resetSettings, thresholdsFor, MAX_COMPRESS_BYTES } =
  await import('../../src/main/headroom/config')

describe('headroom config', () => {
  beforeEach(() => resetSettings())

  it('defaults to enabled + balanced + steering on', () => {
    expect(getSettings()).toEqual({ enabled: true, mode: 'balanced', steering: true })
  })

  it('setSettings merges partials and returns the new state', () => {
    expect(setSettings({ enabled: false })).toEqual({ enabled: false, mode: 'balanced', steering: true })
    expect(setSettings({ mode: 'aggressive' })).toEqual({ enabled: false, mode: 'aggressive', steering: true })
    expect(getSettings().mode).toBe('aggressive')
  })

  it('setSettings ignores an invalid mode', () => {
    setSettings({ mode: 'nonsense' as unknown as 'balanced' })
    expect(getSettings().mode).toBe('balanced')
  })

  it('thresholds get stricter as mode escalates', () => {
    expect(thresholdsFor('conservative').floorTokens).toBeGreaterThan(thresholdsFor('balanced').floorTokens)
    expect(thresholdsFor('aggressive').topK).toBeLessThan(thresholdsFor('balanced').topK)
    expect(MAX_COMPRESS_BYTES).toBe(4_000_000)
  })
})
