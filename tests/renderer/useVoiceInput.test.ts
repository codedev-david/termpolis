// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Control the engine + terminal write from the tests.
const h = vi.hoisted(() => ({
  transcribe: vi.fn(async () => ({ text: 'hello world' })),
  writeToTerminal: vi.fn(),
  focusActiveTerminal: vi.fn(),
}))

vi.mock('../../src/renderer/src/lib/voice/voiceEngines', () => ({
  createVoiceEngine: () => ({ kind: 'local', transcribe: h.transcribe, dispose: vi.fn() }),
}))

// Hook reads voiceSettings via the store selector; return an enabled config.
vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: (selector: (s: unknown) => unknown) =>
    selector({
      voiceSettings: {
        enabled: true,
        engine: 'local',
        model: 'm',
        pushToTalkKey: 'Ctrl+Shift+Period',
        autoSubmitInAgent: false,
        correctionEnabled: true,
        confirmBeforeRunInShell: true,
        cloudEndpoint: '',
      },
      focusActiveTerminal: h.focusActiveTerminal,
    }),
}))

import { useVoiceInput } from '../../src/renderer/src/hooks/useVoiceInput'

let createdProcessor: { onaudioprocess: ((e: unknown) => void) | null; connect: () => void; disconnect: () => void } | null = null

class FakeAudioContext {
  sampleRate = 48000
  destination = {}
  createMediaStreamSource() { return { connect: vi.fn() } }
  createScriptProcessor() {
    createdProcessor = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() }
    return createdProcessor
  }
  close() { return Promise.resolve() }
}

beforeEach(() => {
  h.transcribe.mockClear()
  h.transcribe.mockResolvedValue({ text: 'hello world' })
  h.writeToTerminal.mockClear()
  h.focusActiveTerminal.mockClear()
  createdProcessor = null
  ;(window as unknown as { termpolis: unknown }).termpolis = {
    writeToTerminal: h.writeToTerminal,
    getVoiceAssetBase: async () => ({ success: true, data: 'http://127.0.0.1:1' }),
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    configurable: true,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// Simulate the audio callback firing once so there is captured PCM to transcribe.
function feedAudio() {
  act(() => {
    createdProcessor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array([0.1, 0.2, 0.3]) } })
  })
}

describe('useVoiceInput (orchestration)', () => {
  it('start() requests the microphone and enters the listening state', async () => {
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await act(async () => { await result.current.start() })
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled()
    expect(result.current.status).toBe('listening')
    expect(result.current.listening).toBe(true)
  })

  it('stop() requested while the mic is still starting aborts cleanly instead of getting stuck listening', async () => {
    // A getUserMedia we resolve on demand, to model the async permission/startup
    // gap where a key-release (or button click) lands before the mic is up.
    const stopTrack = vi.fn()
    let resolveMic!: (stream: unknown) => void
    const pending = new Promise((res) => { resolveMic = res })
    ;(navigator.mediaDevices.getUserMedia as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(pending)

    const { result } = renderHook(() => useVoiceInput('term-1', true))

    // Begin starting — the mic has NOT come up yet. Do not await.
    let startCall!: Promise<void>
    act(() => { startCall = result.current.start() })

    // User releases the key / clicks stop before the mic finishes initialising.
    await act(async () => { await result.current.stop() })
    expect(result.current.listening).toBe(false)

    // The mic finally resolves: it must NOT flip into a stuck "listening" state,
    // and the late stream must be released (mic indicator off).
    await act(async () => {
      resolveMic({ getTracks: () => [{ stop: stopTrack }] })
      await startCall
    })

    expect(result.current.status).toBe('idle')
    expect(result.current.listening).toBe(false)
    expect(stopTrack).toHaveBeenCalled()
  })

  it('agent terminal: stop() transcribes and injects the prompt (no auto-submit by default)', async () => {
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await act(async () => { await result.current.start() })
    feedAudio()
    await act(async () => { await result.current.stop() })
    expect(h.transcribe).toHaveBeenCalledTimes(1)
    expect(h.writeToTerminal).toHaveBeenCalledWith('term-1', 'hello world') // no trailing \r
    expect(result.current.confirm).toBeNull()
    // Focus returns to the terminal input line so the user can keep typing/talking.
    expect(h.focusActiveTerminal).toHaveBeenCalled()
  })

  it('shell terminal: stop() surfaces a confirm bar instead of running anything', async () => {
    const { result } = renderHook(() => useVoiceInput('term-1', false))
    await act(async () => { await result.current.start() })
    feedAudio()
    await act(async () => { await result.current.stop() })
    expect(h.writeToTerminal).not.toHaveBeenCalled()
    expect(result.current.confirm?.text).toBe('hello world')
    // Confirm bar is pending — focus stays on it, NOT yanked back to the terminal yet.
    expect(h.focusActiveTerminal).not.toHaveBeenCalled()
  })

  it('confirmRun(true) runs the dictated command (appends Enter) and clears the bar', async () => {
    const { result } = renderHook(() => useVoiceInput('term-1', false))
    await act(async () => { await result.current.start() })
    feedAudio()
    await act(async () => { await result.current.stop() })
    act(() => { result.current.confirmRun(true) })
    expect(h.writeToTerminal).toHaveBeenCalledWith('term-1', 'hello world\r')
    expect(result.current.confirm).toBeNull()
    // After resolving the confirm bar, focus goes back to the terminal input line.
    expect(h.focusActiveTerminal).toHaveBeenCalled()
  })

  it('confirmRun(false) inserts the command without running it', async () => {
    const { result } = renderHook(() => useVoiceInput('term-1', false))
    await act(async () => { await result.current.start() })
    feedAudio()
    await act(async () => { await result.current.stop() })
    act(() => { result.current.confirmRun(false) })
    expect(h.writeToTerminal).toHaveBeenCalledWith('term-1', 'hello world') // inserted, no \r
  })

  it('empty/blank transcript injects nothing', async () => {
    h.transcribe.mockResolvedValue({ text: '   ' })
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await act(async () => { await result.current.start() })
    feedAudio()
    await act(async () => { await result.current.stop() })
    expect(h.writeToTerminal).not.toHaveBeenCalled()
    // Even with nothing to inject, stopping returns focus to the terminal.
    expect(h.focusActiveTerminal).toHaveBeenCalled()
  })

  it('reports an error when no microphone API is available', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await act(async () => { await result.current.start() })
    expect(result.current.status).toBe('error')
    expect(result.current.errorMsg).toBeTruthy()
  })

  it('surfaces a clear error (not silence) when transcription fails, and clearError resets it', async () => {
    h.transcribe.mockRejectedValueOnce(new Error('model load failed: boom'))
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await act(async () => { await result.current.start() })
    feedAudio()
    await act(async () => { await result.current.stop() })
    expect(result.current.status).toBe('error')
    expect(result.current.errorMsg).toMatch(/model load failed/)
    act(() => { result.current.clearError() })
    expect(result.current.errorMsg).toBeNull()
  })
})
