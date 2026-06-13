import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GroqConnectModal } from '../../src/renderer/src/components/SettingsPane/GroqConnectModal'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { DEFAULT_VOICE_SETTINGS } from '../../src/renderer/src/lib/voice/voiceTypes'

function stub(over: Record<string, unknown> = {}) {
  const api = {
    groqGetKeyStatus: vi.fn(async () => ({ success: true, data: { connected: false, hint: '' } })),
    groqValidateKey: vi.fn(async () => ({ success: true, data: { ok: true } })),
    groqSetApiKey: vi.fn(async () => ({ success: true, data: { connected: true, hint: 'gsk_••••1234' } })),
    groqClearApiKey: vi.fn(async () => ({ success: true, data: { connected: false, hint: '' } })),
    openExternal: vi.fn(async () => ({ success: true })),
    ...over,
  }
  ;(window as unknown as { termpolis: unknown }).termpolis = api
  return api
}

describe('GroqConnectModal', () => {
  beforeEach(() => {
    useTerminalStore.setState({ voiceSettings: { ...DEFAULT_VOICE_SETTINGS } })
    stub()
  })

  it('disables Connect until consent is given AND a key is entered', () => {
    render(<GroqConnectModal onClose={() => {}} />)
    const connect = screen.getByTestId('groq-connect-btn') as HTMLButtonElement
    expect(connect.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('groq-key-input'), { target: { value: 'gsk_abc' } })
    expect(connect.disabled).toBe(true) // still need consent
    fireEvent.click(screen.getByTestId('groq-consent-checkbox'))
    expect(connect.disabled).toBe(false)
  })

  it('validates + stores the key, records consent, and shows connected status', async () => {
    const api = stub()
    render(<GroqConnectModal onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('groq-consent-checkbox'))
    fireEvent.change(screen.getByTestId('groq-key-input'), { target: { value: 'gsk_realkey' } })
    fireEvent.click(screen.getByTestId('groq-connect-btn'))
    expect(await screen.findByTestId('groq-connected-status')).toBeInTheDocument()
    expect(api.groqValidateKey).toHaveBeenCalledWith('gsk_realkey')
    expect(api.groqSetApiKey).toHaveBeenCalledWith('gsk_realkey')
    expect(useTerminalStore.getState().voiceSettings.consentAccepted).toBe(true)
  })

  it('shows an error and does NOT store the key when validation fails', async () => {
    const api = stub({ groqValidateKey: vi.fn(async () => ({ success: true, data: { ok: false, status: 401, error: 'unauthorized' } })) })
    render(<GroqConnectModal onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('groq-consent-checkbox'))
    fireEvent.change(screen.getByTestId('groq-key-input'), { target: { value: 'gsk_bad' } })
    fireEvent.click(screen.getByTestId('groq-connect-btn'))
    expect(await screen.findByTestId('groq-error')).toBeInTheDocument()
    expect(api.groqSetApiKey).not.toHaveBeenCalled()
    expect(screen.queryByTestId('groq-connected-status')).not.toBeInTheDocument()
    expect(useTerminalStore.getState().voiceSettings.consentAccepted).toBe(false)
  })

  it('opens the Groq console + Zero-Data-Retention links in the browser', () => {
    const api = stub()
    render(<GroqConnectModal onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('groq-open-console'))
    fireEvent.click(screen.getByTestId('groq-open-zdr'))
    expect(api.openExternal).toHaveBeenCalledWith(expect.stringContaining('console.groq.com'))
    expect(api.openExternal).toHaveBeenCalledTimes(2)
  })

  it('shows connected state on mount when a key exists, and Disconnect clears it', async () => {
    const api = stub({ groqGetKeyStatus: vi.fn(async () => ({ success: true, data: { connected: true, hint: 'gsk_••••7777' } })) })
    render(<GroqConnectModal onClose={() => {}} />)
    expect(await screen.findByTestId('groq-connected-status')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('groq-disconnect-btn'))
    await waitFor(() => expect(api.groqClearApiKey).toHaveBeenCalled())
    expect(await screen.findByTestId('groq-consent-checkbox')).toBeInTheDocument()
  })
})
