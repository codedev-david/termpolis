// @vitest-environment jsdom
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TokenSavingsSettings } from '../../src/renderer/src/components/SettingsPane/TokenSavingsSettings'

const proxyTotals = (over: Record<string, number> = {}) => ({
  requests: 40, textOrigTokens: 200000, textSavedTokens: 100000, savedPct: 50,
  images: 3, imageOrigBytes: 0, imageSavedBytes: 0,
  cacheReadTokens: 900000, cacheCreationTokens: 20000, inputTokens: 500, outputTokens: 8000, ...over,
})

beforeEach(() => {
  ;(window as unknown as { termpolis: Record<string, ReturnType<typeof vi.fn>> }).termpolis = {
    tokenSavingsGetSettings: vi.fn().mockResolvedValue({ success: true, data: { enabled: true, mode: 'balanced', steering: true } }),
    tokenSavingsSetSettings: vi.fn().mockResolvedValue({ success: true, data: { enabled: false, mode: 'balanced', steering: true } }),
    tokenSavingsGetReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: { netSaved: 12345, events: 3, byTool: {} }, cumulative: { netSaved: 99999, events: 40, byTool: {} } } }),
    tokenSavingsGetProxyReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: proxyTotals({ savedPct: 50, textSavedTokens: 100000 }), cumulative: proxyTotals({ savedPct: 47, textSavedTokens: 2500000 }) } }),
  }
})

describe('TokenSavingsSettings', () => {
  it('shows the always-on Claude proxy compression headline (% saved + tokens + cache health)', async () => {
    render(<TokenSavingsSettings />)
    await waitFor(() => expect(screen.getByTestId('hr-proxy-session-pct')).toHaveTextContent('50%'))
    expect(screen.getByTestId('hr-proxy-cumulative-pct')).toHaveTextContent('47%')
    expect(screen.getByTestId('hr-proxy-cumulative-saved')).toHaveTextContent('2,500,000')
    expect(screen.getByTestId('hr-proxy-cache-health')).toHaveTextContent('healthy')
  })

  it('still renders the tool-output receipt and toggle', async () => {
    render(<TokenSavingsSettings />)
    await waitFor(() => expect(screen.getByTestId('hr-session-saved')).toHaveTextContent('12,345'))
    expect(screen.getByTestId('hr-cumulative-saved')).toHaveTextContent('99,999')
  })

  it('toggling tool-output compression calls setSettings with the inverse', async () => {
    render(<TokenSavingsSettings />)
    await waitFor(() => screen.getByTestId('hr-toggle-enabled'))
    fireEvent.click(screen.getByTestId('hr-toggle-enabled'))
    await waitFor(() => expect(
      (window as unknown as { termpolis: { tokenSavingsSetSettings: ReturnType<typeof vi.fn> } }).termpolis.tokenSavingsSetSettings,
    ).toHaveBeenCalledWith({ enabled: false }))
  })

  it('gives the aggressiveness select an explicit dark bg + light text (readable contrast, not grey-on-white)', async () => {
    render(<TokenSavingsSettings />)
    const sel = await screen.findByTestId('hr-mode')
    // An unstyled native select inherited light-grey text on the OS-default light background.
    expect(sel.className).toContain('bg-[#2d2d2d]')
    expect(sel.className).toContain('text-[#d4d4d4]')
    // Options carry the dark bg too so the OPEN dropdown list stays legible on Electron/Windows.
    sel.querySelectorAll('option').forEach((o) => expect(o.className).toContain('bg-[#2d2d2d]'))
  })
})
