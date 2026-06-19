import { describe, it, expect, beforeEach } from 'vitest'
import { setPendingSettingsTab, consumePendingSettingsTab } from '../../src/renderer/src/lib/settingsNav'

describe('settingsNav pending tab', () => {
  // Clear any leftover request between tests so they don't bleed.
  beforeEach(() => { consumePendingSettingsTab() })

  it('returns null when no tab has been requested', () => {
    expect(consumePendingSettingsTab()).toBeNull()
  })

  it('returns the requested tab exactly once, then clears it', () => {
    setPendingSettingsTab('voice')
    expect(consumePendingSettingsTab()).toBe('voice')
    // Consumed — a later plain "open Settings" must NOT be hijacked to voice.
    expect(consumePendingSettingsTab()).toBeNull()
  })

  it('keeps only the most recently requested tab', () => {
    setPendingSettingsTab('security')
    setPendingSettingsTab('voice')
    expect(consumePendingSettingsTab()).toBe('voice')
  })
})
