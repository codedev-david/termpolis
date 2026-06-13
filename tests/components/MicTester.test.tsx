// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MicTester } from '../../src/renderer/src/components/SettingsPane/MicTester'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { DEFAULT_VOICE_SETTINGS } from '../../src/renderer/src/lib/voice/voiceTypes'

// Minimal Web Audio stub — enough for the live-meter graph (source → analyser).
// stubSignal lets a test feed a non-silent level so the meter loop produces output.
let stubSignal = 0
class StubAudioContext {
  resume() { return Promise.resolve() }
  createMediaStreamSource() { return { connect: () => {} } }
  createAnalyser() {
    return { fftSize: 1024, connect: () => {}, disconnect: () => {}, getFloatTimeDomainData: (a: Float32Array) => a.fill(stubSignal) }
  }
  close() { return Promise.resolve() }
}

beforeEach(() => {
  stubSignal = 0
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

  it('the live meter samples the analyser and shows "hearing you" when sound arrives', async () => {
    stubSignal = 0.3 // non-silent → meter rises past the speech tick
    render(<MicTester />)
    await act(async () => { fireEvent.click(screen.getByTestId('voice-test-mic-btn')) })
    await waitFor(() => expect(screen.getByTestId('voice-test-status')).toBeInTheDocument())
    // Let the ~33ms meter interval fire a couple of times against the stub signal.
    await act(async () => { await new Promise((r) => setTimeout(r, 90)) })
    await waitFor(() => expect(screen.getByTestId('voice-test-status')).toHaveTextContent(/hearing you/i))
    await act(async () => { fireEvent.click(screen.getByTestId('voice-test-mic-btn')) })
  })

  it('shows an error when the microphone cannot be opened', async () => {
    ;(navigator.mediaDevices.getUserMedia as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('NotAllowedError'))
    render(<MicTester />)
    await act(async () => { fireEvent.click(screen.getByTestId('voice-test-mic-btn')) })
    await waitFor(() => expect(screen.getByTestId('voice-test-error')).toBeInTheDocument())
    // Not stuck in a testing state after the failure.
    expect(screen.queryByTestId('voice-test-status')).not.toBeInTheDocument()
  })

  it('falls back to the system default mic when the chosen device fails', async () => {
    useTerminalStore.setState({ voiceSettings: { ...DEFAULT_VOICE_SETTINGS, enabled: true, inputDeviceId: 'gone' } })
    const gum = navigator.mediaDevices.getUserMedia as unknown as ReturnType<typeof vi.fn>
    gum.mockReset()
    gum.mockRejectedValueOnce(new Error('OverconstrainedError'))
    gum.mockResolvedValueOnce({ getTracks: () => [{ stop: vi.fn() }] })
    render(<MicTester />)
    await act(async () => { fireEvent.click(screen.getByTestId('voice-test-mic-btn')) })
    await waitFor(() => expect(screen.getByTestId('voice-test-status')).toBeInTheDocument())
    expect(gum).toHaveBeenCalledTimes(2) // exact failed → retried with the default
    await act(async () => { fireEvent.click(screen.getByTestId('voice-test-mic-btn')) })
  })

  it('releases the mic if the panel unmounts before getUserMedia resolves (no leak)', async () => {
    let resolveMic!: (s: unknown) => void
    const stopTrack = vi.fn()
    ;(navigator.mediaDevices.getUserMedia as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValue(new Promise((res) => { resolveMic = res }))
    const { unmount } = render(<MicTester />)
    await act(async () => { fireEvent.click(screen.getByTestId('voice-test-mic-btn')) })
    // Unmount while the mic is still coming up → cancellation is flagged.
    unmount()
    // The mic resolves late: startTest must stop its tracks instead of building on it.
    await act(async () => { resolveMic({ getTracks: () => [{ stop: stopTrack }] }); await Promise.resolve() })
    expect(stopTrack).toHaveBeenCalled()
  })

  it('labels an unnamed input device with a positional fallback', async () => {
    ;(navigator.mediaDevices.enumerateDevices as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { kind: 'audioinput', deviceId: 'x', label: '' },
    ])
    render(<MicTester />)
    await waitFor(() => expect(screen.getByRole('option', { name: /microphone 1/i })).toBeInTheDocument())
  })

  it('ignores a second Test click while the first is still starting (no double-start)', async () => {
    let resolveMic!: (s: unknown) => void
    const gum = navigator.mediaDevices.getUserMedia as unknown as ReturnType<typeof vi.fn>
    gum.mockReturnValue(new Promise((res) => { resolveMic = res }))
    render(<MicTester />)
    const btn = screen.getByTestId('voice-test-mic-btn')
    await act(async () => { fireEvent.click(btn) }) // first start: getUserMedia pending, startingRef set
    await act(async () => { fireEvent.click(btn) }) // second click is guarded out
    await act(async () => { resolveMic({ getTracks: () => [{ stop: vi.fn() }] }); await Promise.resolve() })
    expect(gum).toHaveBeenCalledTimes(1) // only one acquisition despite two clicks
    await act(async () => { fireEvent.click(btn) }) // stop → cleanup
  })
})
