import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { VoiceSettings } from '../../src/renderer/src/components/SettingsPane/VoiceSettings'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { DEFAULT_VOICE_SETTINGS } from '../../src/renderer/src/lib/voice/voiceTypes'

function stubTermpolis(status: { connected: boolean; hint: string } = { connected: false, hint: '' }) {
  ;(window as unknown as { termpolis: unknown }).termpolis = {
    groqGetKeyStatus: vi.fn(async () => ({ success: true, data: status })),
    openExternal: vi.fn(async () => ({ success: true })),
    groqValidateKey: vi.fn(async () => ({ success: true, data: { ok: true } })),
    groqSetApiKey: vi.fn(async () => ({ success: true, data: { connected: true, hint: 'gsk_••••1234' } })),
    groqClearApiKey: vi.fn(async () => ({ success: true, data: { connected: false, hint: '' } })),
  }
}

describe('VoiceSettings', () => {
  beforeEach(() => {
    useTerminalStore.setState({ voiceSettings: { ...DEFAULT_VOICE_SETTINGS } })
    stubTermpolis()
  })

  it('renders, and voice is opt-in (disabled) by default', () => {
    render(<VoiceSettings />)
    expect(screen.getByTestId('voice-settings')).toBeInTheDocument()
    expect(useTerminalStore.getState().voiceSettings.enabled).toBe(false)
  })

  it('enabling voice updates the store', () => {
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    expect(useTerminalStore.getState().voiceSettings.enabled).toBe(true)
  })

  it('shows a Connect Groq button when no key is stored, and opens the connect modal', async () => {
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    const btn = await screen.findByTestId('groq-connect-open-btn')
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(screen.getByTestId('groq-connect-modal')).toBeInTheDocument()
  })

  it('shows connected status + masked hint when a key is already stored', async () => {
    stubTermpolis({ connected: true, hint: 'gsk_••••9999' })
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    expect(await screen.findByText('gsk_••••9999')).toBeInTheDocument()
    expect(screen.getByTestId('groq-manage-btn')).toBeInTheDocument()
  })

  it('changes the transcription model in the store', () => {
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    fireEvent.change(screen.getByTestId('voice-model-select'), { target: { value: 'whisper-large-v3' } })
    expect(useTerminalStore.getState().voiceSettings.groqModel).toBe('whisper-large-v3')
  })

  it('confirm-before-run defaults ON and can be toggled off', () => {
    render(<VoiceSettings />)
    expect(useTerminalStore.getState().voiceSettings.confirmBeforeRunInShell).toBe(true)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    fireEvent.click(screen.getByTestId('voice-confirm-toggle'))
    expect(useTerminalStore.getState().voiceSettings.confirmBeforeRunInShell).toBe(false)
  })

  it('edits the push-to-talk hotkey', () => {
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    fireEvent.change(screen.getByTestId('voice-hotkey-input'), { target: { value: 'Ctrl+Shift+;' } })
    expect(useTerminalStore.getState().voiceSettings.pushToTalkKey).toBe('Ctrl+Shift+;')
  })

  it('defaults to tap-or-hold and can switch to tap-to-toggle or tap-to-start/send-key', () => {
    render(<VoiceSettings />)
    expect(useTerminalStore.getState().voiceSettings.pushToTalkMode).toBe('tapOrHold')
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    fireEvent.change(screen.getByTestId('voice-mode-select'), { target: { value: 'toggle' } })
    expect(useTerminalStore.getState().voiceSettings.pushToTalkMode).toBe('toggle')
    fireEvent.change(screen.getByTestId('voice-mode-select'), { target: { value: 'tapSpace' } })
    expect(useTerminalStore.getState().voiceSettings.pushToTalkMode).toBe('tapSpace')
    fireEvent.change(screen.getByTestId('voice-mode-select'), { target: { value: 'tapOrHold' } })
    expect(useTerminalStore.getState().voiceSettings.pushToTalkMode).toBe('tapOrHold')
  })

  it('exposes the send/stop key only in tapSpace mode and rebinds it from a captured keypress', () => {
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    // The send-key field is specific to tapSpace — hidden in the other modes.
    expect(screen.queryByTestId('voice-sendkey-input')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('voice-mode-select'), { target: { value: 'tapSpace' } })
    const input = screen.getByTestId('voice-sendkey-input')
    expect(input).toBeInTheDocument()
    expect(useTerminalStore.getState().voiceSettings.sendKey).toBe('Space') // default
    // Pressing a key in the field captures it as the new send key.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useTerminalStore.getState().voiceSettings.sendKey).toBe('Enter')
  })

  it('stays on the Connect button when the key-status IPC rejects', async () => {
    ;(window as unknown as { termpolis: unknown }).termpolis = {
      groqGetKeyStatus: vi.fn(async () => {
        throw new Error('ipc down')
      }),
    }
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    expect(await screen.findByTestId('groq-connect-open-btn')).toBeInTheDocument()
  })

  it('opens the connect modal from Manage when a key is already stored', async () => {
    stubTermpolis({ connected: true, hint: 'gsk_••••9999' })
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    fireEvent.click(await screen.findByTestId('groq-manage-btn'))
    expect(screen.getByTestId('groq-connect-modal')).toBeInTheDocument()
  })

  it('re-reads the key status when the connect modal closes, flipping the card to Connected', async () => {
    let status = { connected: false, hint: '' }
    const groqGetKeyStatus = vi.fn(async () => ({ success: true, data: status }))
    ;(window as unknown as { termpolis: unknown }).termpolis = { groqGetKeyStatus }
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    fireEvent.click(await screen.findByTestId('groq-connect-open-btn'))
    expect(screen.getByTestId('groq-connect-modal')).toBeInTheDocument()
    const callsBeforeClose = groqGetKeyStatus.mock.calls.length
    // A key gets stored while the modal is open — the card only learns about it
    // because closing the modal re-runs the status read.
    status = { connected: true, hint: 'gsk_••••4242' }
    fireEvent.click(screen.getByText('Done'))
    expect(await screen.findByTestId('groq-manage-btn')).toBeInTheDocument()
    expect(screen.getByText('gsk_••••4242')).toBeInTheDocument()
    expect(screen.queryByTestId('groq-connect-modal')).not.toBeInTheDocument()
    expect(groqGetKeyStatus.mock.calls.length).toBeGreaterThan(callsBeforeClose)
  })

  it('treats an unsuccessful key-status response as not connected', async () => {
    const groqGetKeyStatus = vi.fn(async () => ({ success: false, error: 'keychain locked' }))
    ;(window as unknown as { termpolis: unknown }).termpolis = { groqGetKeyStatus }
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    await waitFor(() => expect(groqGetKeyStatus).toHaveBeenCalled())
    expect(screen.getByTestId('groq-connect-open-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('groq-manage-btn')).not.toBeInTheDocument()
  })

  it('treats a successful key-status response with no payload as not connected', async () => {
    const groqGetKeyStatus = vi.fn(async () => ({ success: true }))
    ;(window as unknown as { termpolis: unknown }).termpolis = { groqGetKeyStatus }
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    await waitFor(() => expect(groqGetKeyStatus).toHaveBeenCalled())
    expect(screen.getByTestId('groq-connect-open-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('groq-manage-btn')).not.toBeInTheDocument()
  })

  it('still renders and edits settings when the preload bridge is missing entirely', () => {
    delete (window as unknown as { termpolis?: unknown }).termpolis
    expect(() => render(<VoiceSettings />)).not.toThrow()
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    expect(useTerminalStore.getState().voiceSettings.enabled).toBe(true)
    expect(screen.getByTestId('groq-connect-open-btn')).toBeInTheDocument()
  })

  it('survives a preload bridge that exposes no groqGetKeyStatus method', () => {
    ;(window as unknown as { termpolis: unknown }).termpolis = {}
    expect(() => render(<VoiceSettings />)).not.toThrow()
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    expect(screen.getByTestId('groq-connect-open-btn')).toBeInTheDocument()
  })

  it('shows Connected without a masked-key chip when the status carries no hint', async () => {
    stubTermpolis({ connected: true, hint: '' })
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    expect(await screen.findByTestId('groq-manage-btn')).toBeInTheDocument()
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('· key in OS keychain')).toBeInTheDocument()
    // No hint from the main process => no masked-key chip at all.
    expect(screen.queryByText(/gsk_/)).not.toBeInTheDocument()
  })

  it('ignores a modifier-only keypress when rebinding the send key', () => {
    useTerminalStore.setState({
      voiceSettings: { ...DEFAULT_VOICE_SETTINGS, enabled: true, pushToTalkMode: 'tapSpace' },
    })
    render(<VoiceSettings />)
    const input = screen.getByTestId('voice-sendkey-input')
    // Shift/Control alone are not a binding — the existing send key must survive.
    fireEvent.keyDown(input, { key: 'Shift', shiftKey: true })
    expect(useTerminalStore.getState().voiceSettings.sendKey).toBe('Space')
    fireEvent.keyDown(input, { key: 'Control', ctrlKey: true })
    expect(useTerminalStore.getState().voiceSettings.sendKey).toBe('Space')
    // ...but a real key still rebinds it.
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(useTerminalStore.getState().voiceSettings.sendKey).toBe('Escape')
  })

  it('describes the send key as Space when none is bound', () => {
    useTerminalStore.setState({
      voiceSettings: { ...DEFAULT_VOICE_SETTINGS, enabled: true, pushToTalkMode: 'tapSpace', sendKey: '' },
    })
    render(<VoiceSettings />)
    expect(screen.getByTestId('voice-settings').textContent).toContain('(press Space to send)')
  })

  it('toggles auto-submit and LLM cleanup independently of each other', () => {
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    expect(useTerminalStore.getState().voiceSettings.autoSubmitInAgent).toBe(false)
    fireEvent.click(screen.getByTestId('voice-autosubmit-toggle'))
    expect(useTerminalStore.getState().voiceSettings.autoSubmitInAgent).toBe(true)
    // Cleanup defaults ON and is a separate setting.
    expect(useTerminalStore.getState().voiceSettings.correctionEnabled).toBe(true)
    fireEvent.click(screen.getByTestId('voice-correction-toggle'))
    expect(useTerminalStore.getState().voiceSettings.correctionEnabled).toBe(false)
    expect(useTerminalStore.getState().voiceSettings.autoSubmitInAgent).toBe(true)
  })
})
