import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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

  it('shows an error and does not store the key when validation throws', async () => {
    const api = stub({
      groqValidateKey: vi.fn(async () => {
        throw new Error('network down')
      }),
    })
    render(<GroqConnectModal onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('groq-consent-checkbox'))
    fireEvent.change(screen.getByTestId('groq-key-input'), { target: { value: 'gsk_x' } })
    fireEvent.click(screen.getByTestId('groq-connect-btn'))
    expect(await screen.findByTestId('groq-error')).toHaveTextContent(/network down/)
    expect(api.groqSetApiKey).not.toHaveBeenCalled()
  })

  it('shows an error when storing the validated key fails', async () => {
    stub({ groqSetApiKey: vi.fn(async () => ({ success: false, error: 'keychain locked' })) })
    render(<GroqConnectModal onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('groq-consent-checkbox'))
    fireEvent.change(screen.getByTestId('groq-key-input'), { target: { value: 'gsk_x' } })
    fireEvent.click(screen.getByTestId('groq-connect-btn'))
    expect(await screen.findByTestId('groq-error')).toHaveTextContent(/keychain locked/)
    expect(screen.queryByTestId('groq-connected-status')).not.toBeInTheDocument()
  })

  it('shows a generic error when validation fails with no message', async () => {
    stub({ groqValidateKey: vi.fn(async () => ({ success: false })) })
    render(<GroqConnectModal onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('groq-consent-checkbox'))
    fireEvent.change(screen.getByTestId('groq-key-input'), { target: { value: 'gsk_x' } })
    fireEvent.click(screen.getByTestId('groq-connect-btn'))
    expect(await screen.findByTestId('groq-error')).toBeInTheDocument()
  })

  it('survives groqGetKeyStatus rejecting on mount (stays on the connect form)', async () => {
    stub({
      groqGetKeyStatus: vi.fn(async () => {
        throw new Error('ipc down')
      }),
    })
    render(<GroqConnectModal onClose={() => {}} />)
    expect(await screen.findByTestId('groq-consent-checkbox')).toBeInTheDocument()
  })

  it('does not crash if disconnect itself fails', async () => {
    const api = stub({
      groqGetKeyStatus: vi.fn(async () => ({ success: true, data: { connected: true, hint: 'gsk_••••1' } })),
      groqClearApiKey: vi.fn(async () => {
        throw new Error('clear failed')
      }),
    })
    render(<GroqConnectModal onClose={() => {}} />)
    expect(await screen.findByTestId('groq-disconnect-btn')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('groq-disconnect-btn'))
    await waitFor(() => expect(api.groqClearApiKey).toHaveBeenCalled())
  })

  it('opens the Groq data-settings page from the connected state', async () => {
    const api = stub({
      groqGetKeyStatus: vi.fn(async () => ({ success: true, data: { connected: true, hint: 'gsk_••••7777' } })),
    })
    render(<GroqConnectModal onClose={() => {}} />)
    await screen.findByTestId('groq-connected-status')
    fireEvent.click(screen.getByText(/Review Groq data settings/))
    expect(api.openExternal).toHaveBeenCalledWith('https://console.groq.com/docs/your-data')
  })

  it('counts the key as connected when the store succeeds without a payload', async () => {
    stub({ groqSetApiKey: vi.fn(async () => ({ success: true })) })
    render(<GroqConnectModal onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('groq-consent-checkbox'))
    fireEvent.change(screen.getByTestId('groq-key-input'), { target: { value: 'gsk_nodata' } })
    fireEvent.click(screen.getByTestId('groq-connect-btn'))
    const status = await screen.findByTestId('groq-connected-status')
    expect(status).toHaveTextContent('Connected to Groq')
    // No hint came back, so no masked-key chip is rendered.
    expect(status.querySelector('.font-mono')).toBeNull()
    expect(useTerminalStore.getState().voiceSettings.consentAccepted).toBe(true)
  })

  it('reports the top-level error when validation fails with no data payload', async () => {
    const api = stub({ groqValidateKey: vi.fn(async () => ({ success: false, error: 'rate limited' })) })
    render(<GroqConnectModal onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('groq-consent-checkbox'))
    fireEvent.change(screen.getByTestId('groq-key-input'), { target: { value: 'gsk_x' } })
    fireEvent.click(screen.getByTestId('groq-connect-btn'))
    expect(await screen.findByTestId('groq-error')).toHaveTextContent(/rate limited/)
    expect(api.groqSetApiKey).not.toHaveBeenCalled()
  })

  it('falls back to a generic message when storing the key fails with no reason', async () => {
    stub({ groqSetApiKey: vi.fn(async () => ({ success: false })) })
    render(<GroqConnectModal onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('groq-consent-checkbox'))
    fireEvent.change(screen.getByTestId('groq-key-input'), { target: { value: 'gsk_x' } })
    fireEvent.click(screen.getByTestId('groq-connect-btn'))
    expect(await screen.findByTestId('groq-error')).toHaveTextContent('Failed to store the key.')
    expect(screen.queryByTestId('groq-connected-status')).not.toBeInTheDocument()
  })

  it('surfaces a non-Error rejection from validation as its string form', async () => {
    const api = stub({ groqValidateKey: vi.fn(() => Promise.reject('gateway exploded')) })
    render(<GroqConnectModal onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('groq-consent-checkbox'))
    fireEvent.change(screen.getByTestId('groq-key-input'), { target: { value: 'gsk_x' } })
    fireEvent.click(screen.getByTestId('groq-connect-btn'))
    expect(await screen.findByTestId('groq-error')).toHaveTextContent('gateway exploded')
    expect(api.groqSetApiKey).not.toHaveBeenCalled()
  })

  it('returns to the setup form when clearing the key reports no payload', async () => {
    const api = stub({
      groqGetKeyStatus: vi.fn(async () => ({ success: true, data: { connected: true, hint: 'gsk_••••1' } })),
      groqClearApiKey: vi.fn(async () => ({ success: true })),
    })
    render(<GroqConnectModal onClose={() => {}} />)
    fireEvent.click(await screen.findByTestId('groq-disconnect-btn'))
    expect(await screen.findByTestId('groq-consent-checkbox')).toBeInTheDocument()
    expect(api.groqClearApiKey).toHaveBeenCalled()
    expect(screen.queryByTestId('groq-connected-status')).not.toBeInTheDocument()
  })

  it('keeps the key connected when disconnecting rejects with a non-Error', async () => {
    const api = stub({
      groqGetKeyStatus: vi.fn(async () => ({ success: true, data: { connected: true, hint: 'gsk_••••2' } })),
      groqClearApiKey: vi.fn(() => Promise.reject('keychain busy')),
    })
    render(<GroqConnectModal onClose={() => {}} />)
    fireEvent.click(await screen.findByTestId('groq-disconnect-btn'))
    await waitFor(() => expect(api.groqClearApiKey).toHaveBeenCalled())
    // The removal failed, so the modal must stay in its connected state and
    // release the busy lock (the button is clickable again for a retry).
    await waitFor(() =>
      expect((screen.getByTestId('groq-disconnect-btn') as HTMLButtonElement).disabled).toBe(false),
    )
    expect(screen.getByTestId('groq-connected-status')).toBeInTheDocument()
  })

  it('stays on the setup form when the key status resolves without a payload', async () => {
    const api = stub({ groqGetKeyStatus: vi.fn(async () => ({ success: true })) })
    render(<GroqConnectModal onClose={() => {}} />)
    await waitFor(() => expect(api.groqGetKeyStatus).toHaveBeenCalled())
    expect(screen.getByTestId('groq-consent-checkbox')).toBeInTheDocument()
    expect(screen.queryByTestId('groq-connected-status')).not.toBeInTheDocument()
  })

  it('closes from both the × and the Done button', () => {
    const onClose = vi.fn()
    render(<GroqConnectModal onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Close'))
    fireEvent.click(screen.getByText('Done'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('shows a verifying state and refuses a second submit while the key is in flight', async () => {
    let release: (v: unknown) => void = () => {}
    const gate = new Promise((r) => {
      release = r
    })
    const api = stub({
      groqValidateKey: vi.fn(async () => {
        await gate
        return { success: true, data: { ok: true } }
      }),
    })
    render(<GroqConnectModal onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('groq-consent-checkbox'))
    fireEvent.change(screen.getByTestId('groq-key-input'), { target: { value: 'gsk_slow' } })
    fireEvent.click(screen.getByTestId('groq-connect-btn'))
    const btn = (await screen.findByText('Verifying…')) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    // Clicking again mid-flight must not fire a second validation.
    fireEvent.click(btn)
    expect(api.groqValidateKey).toHaveBeenCalledTimes(1)
    await act(async () => {
      release(null)
      await gate
    })
    expect(await screen.findByTestId('groq-connected-status')).toBeInTheDocument()
  })

  it('stays usable when the shell refuses to open an external link', async () => {
    const api = stub({ openExternal: vi.fn(() => Promise.reject(new Error('no browser'))) })
    render(<GroqConnectModal onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('groq-open-console'))
    await waitFor(() => expect(api.openExternal).toHaveBeenCalledWith('https://console.groq.com/keys'))
    // The rejection is swallowed, so the setup flow still works afterwards.
    fireEvent.click(screen.getByTestId('groq-consent-checkbox'))
    fireEvent.change(screen.getByTestId('groq-key-input'), { target: { value: 'gsk_ok' } })
    expect((screen.getByTestId('groq-connect-btn') as HTMLButtonElement).disabled).toBe(false)
  })
})
