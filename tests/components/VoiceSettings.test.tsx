import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { VoiceSettings } from '../../src/renderer/src/components/SettingsPane/VoiceSettings'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { DEFAULT_VOICE_SETTINGS } from '../../src/renderer/src/lib/voice/voiceTypes'

describe('VoiceSettings', () => {
  beforeEach(() => {
    useTerminalStore.setState({ voiceSettings: { ...DEFAULT_VOICE_SETTINGS } })
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

  it('local engine by default; switching to cloud reveals the endpoint field', () => {
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle')) // un-disable the fieldset
    expect(useTerminalStore.getState().voiceSettings.engine).toBe('local')
    expect(screen.queryByTestId('voice-endpoint-input')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('voice-engine-select'), { target: { value: 'cloud' } })
    expect(useTerminalStore.getState().voiceSettings.engine).toBe('cloud')
    expect(screen.getByTestId('voice-endpoint-input')).toBeInTheDocument()
  })

  it('confirm-before-run defaults ON and can be toggled off', () => {
    render(<VoiceSettings />)
    expect(useTerminalStore.getState().voiceSettings.confirmBeforeRunInShell).toBe(true)
    fireEvent.click(screen.getByTestId('voice-enable-toggle')) // enable so the fieldset is interactive
    fireEvent.click(screen.getByTestId('voice-confirm-toggle'))
    expect(useTerminalStore.getState().voiceSettings.confirmBeforeRunInShell).toBe(false)
  })

  it('edits the push-to-talk hotkey', () => {
    render(<VoiceSettings />)
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    fireEvent.change(screen.getByTestId('voice-hotkey-input'), { target: { value: 'Ctrl+Shift+;' } })
    expect(useTerminalStore.getState().voiceSettings.pushToTalkKey).toBe('Ctrl+Shift+;')
  })

  it('defaults to hold-to-talk and can switch to tap-to-toggle', () => {
    render(<VoiceSettings />)
    expect(useTerminalStore.getState().voiceSettings.pushToTalkMode).toBe('hold')
    fireEvent.click(screen.getByTestId('voice-enable-toggle'))
    fireEvent.change(screen.getByTestId('voice-mode-select'), { target: { value: 'toggle' } })
    expect(useTerminalStore.getState().voiceSettings.pushToTalkMode).toBe('toggle')
  })
})
