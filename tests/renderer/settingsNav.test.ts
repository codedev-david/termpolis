import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  setPendingSettingsTab,
  consumePendingSettingsTab,
  requestSettingsTab,
  useSettingsTab,
  SETTINGS_TAB_REQUESTED,
} from '../../src/renderer/src/lib/settingsNav'

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

  it('can send Settings straight to the Linked machines tab', () => {
    setPendingSettingsTab('linked')
    expect(consumePendingSettingsTab()).toBe('linked')
  })
})

describe('requestSettingsTab and useSettingsTab', () => {
  beforeEach(() => { consumePendingSettingsTab() })

  it('with Settings closed, leaves the request for the pane that mounts next, and tells no one', () => {
    const heard = vi.fn()
    window.addEventListener(SETTINGS_TAB_REQUESTED, heard)
    requestSettingsTab('linked', false)
    window.removeEventListener(SETTINGS_TAB_REQUESTED, heard)
    expect(heard).not.toHaveBeenCalled()
    const { result } = renderHook(() => useSettingsTab())
    expect(result.current[0]).toBe('linked')
    expect(consumePendingSettingsTab()).toBeNull()
  })

  it('with Settings open, switches the mounted pane at once and spends the request there', () => {
    const { result, unmount } = renderHook(() => useSettingsTab())
    expect(result.current[0]).toBe('general')
    act(() => requestSettingsTab('linked', true))
    expect(result.current[0]).toBe('linked')
    expect(consumePendingSettingsTab()).toBeNull()
    // The pane's own tab clicks still work.
    act(() => result.current[1]('voice'))
    expect(result.current[0]).toBe('voice')
    unmount()
    // Gone, it hears nothing more: the request waits for the next one.
    requestSettingsTab('remote', true)
    expect(consumePendingSettingsTab()).toBe('remote')
  })

  it('with Settings open but still loading, starts the pane on the tab once it mounts', () => {
    requestSettingsTab('linked', true)
    const { result } = renderHook(() => useSettingsTab())
    expect(result.current[0]).toBe('linked')
  })

  it('ignores a stray event with no request behind it', () => {
    const { result } = renderHook(() => useSettingsTab())
    act(() => { window.dispatchEvent(new Event(SETTINGS_TAB_REQUESTED)) })
    expect(result.current[0]).toBe('general')
  })
})
