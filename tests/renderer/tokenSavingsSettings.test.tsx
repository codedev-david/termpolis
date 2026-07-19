// @vitest-environment jsdom
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TokenSavingsSettings } from '../../src/renderer/src/components/SettingsPane/TokenSavingsSettings'

beforeEach(() => {
  ;(window as unknown as { termpolis: Record<string, ReturnType<typeof vi.fn>> }).termpolis = {
    tokenSavingsGetSettings: vi.fn().mockResolvedValue({ success: true, data: { enabled: true, mode: 'balanced', steering: true } }),
    tokenSavingsSetSettings: vi.fn().mockResolvedValue({ success: true, data: { enabled: false, mode: 'balanced', steering: true } }),
    tokenSavingsGetReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: { netSaved: 12345, events: 3, byTool: { code_search: 12000 } }, cumulative: { netSaved: 99999, events: 40, byTool: {} } } }),
  }
})

describe('TokenSavingsSettings', () => {
  it('renders the measured session + cumulative savings from the receipt', async () => {
    render(<TokenSavingsSettings />)
    await waitFor(() => expect(screen.getByTestId('hr-session-saved')).toHaveTextContent('12,345'))
    expect(screen.getByTestId('hr-cumulative-saved')).toHaveTextContent('99,999')
    expect(screen.getByText(/code_search: 12,000/)).toBeInTheDocument()
  })

  it('toggling compression calls setSettings with the inverse', async () => {
    render(<TokenSavingsSettings />)
    await waitFor(() => screen.getByTestId('hr-toggle-enabled'))
    fireEvent.click(screen.getByTestId('hr-toggle-enabled'))
    await waitFor(() => expect(
      (window as unknown as { termpolis: { tokenSavingsSetSettings: ReturnType<typeof vi.fn> } }).termpolis.tokenSavingsSetSettings,
    ).toHaveBeenCalledWith({ enabled: false }))
  })
})
