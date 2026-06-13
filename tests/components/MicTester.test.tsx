// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MicTester } from '../../src/renderer/src/components/SettingsPane/MicTester'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { DEFAULT_VOICE_SETTINGS } from '../../src/renderer/src/lib/voice/voiceTypes'

// Minimal Web Audio stub — enough for the live-meter graph (source → analyser).
class StubAudioContext {
  resume() { return Promise.resolve() }
  createMediaStreamSource() { return { connect: () => {} } }
  createAnalyser() {
    return { fftSize: 1024, connect: () => {}, disconnect: () => {}, getFloatTimeDomainData: (a: Float32Array) => a.fill(0) }
  }
  close() { return Promise.resolve() }
}

beforeEach(() => {
  useTerminalStore.setState({ voiceSettings: { ...DEFAULT_VOICE_SETTINGS, enabled: true } })
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = StubAudioContext
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      enumerateDevices: vi.fn(async () => [
        { kind: 'audioinput', deviceId: 'mic-a', label: 'Headset Mic' },
        { kind: 'audioinput', deviceId: 'mic-b', label: 'Webcam Mic' },
        { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers' },
      ]),
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
    },
    configurable: true,
  })
})

afterEach(() => { vi.restoreAllMocks() })

describe('MicTester', () => {
  it('lists input devices and persists the chosen one to the store', async () => {
    render(<MicTester />)
    await waitFor(() => expect(screen.getByRole('option', { name: 'Headset Mic' })).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('voice-device-select'), { target: { value: 'mic-b' } })
    expect(useTerminalStore.getState().voiceSettings.inputDeviceId).toBe('mic-b')
  })

  it('offers only audio INPUTS (output devices are filtered out)', async () => {
    render(<MicTester />)
    await waitFor(() => expect(screen.getByRole('option', { name: 'Headset Mic' })).toBeInTheDocument())
    expect(screen.queryByRole('option', { name: 'Speakers' })).not.toBeInTheDocument()
    // The system-default escape hatch is always present.
    expect(screen.getByRole('option', { name: /system default/i })).toBeInTheDocument()
  })

  it('Test microphone opens the stream and shows the live meter', async () => {
    render(<MicTester />)
    await act(async () => { fireEvent.click(screen.getByTestId('voice-test-mic-btn')) })
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('voice-test-status')).toBeInTheDocument())
    expect(screen.getByTestId('voice-test-meter')).toBeInTheDocument()
    // Stop the test → releases the (stub) stream + interval.
    await act(async () => { fireEvent.click(screen.getByTestId('voice-test-mic-btn')) })
    await waitFor(() => expect(screen.queryByTestId('voice-test-status')).not.toBeInTheDocument())
  })
})
