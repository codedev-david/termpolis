import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
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
})
