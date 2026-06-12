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
// Lets a test hold AudioContext.resume() pending to model a stop() that lands
// DURING context startup (not just during getUserMedia).
let resumeGate: { promise: Promise<void>; resolve: () => void } | null = null

class FakeAudioContext {
  // We now request a 16kHz context (Chromium honors it) so capture needs no
  // resampling; the mock reflects that.
  sampleRate = 16000
  destination = {}
  constructor(_opts?: unknown) { /* options (sampleRate) ignored by the fake */ }
  resume() { return resumeGate ? resumeGate.promise : Promise.resolve() }
  createMediaStreamSource() { return { connect: vi.fn() } }
  createScriptProcessor() {
    createdProcessor = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() }
    return createdProcessor
  }
  // Muted sink the ScriptProcessor drains into (so the mic isn't routed to speakers).
  createGain() { return { gain: { value: 0 }, connect: vi.fn() } }
  close() { return Promise.resolve() }
}

beforeEach(() => {
  h.transcribe.mockClear()
  h.transcribe.mockResolvedValue({ text: 'hello world' })
  h.writeToTerminal.mockClear()
  h.focusActiveTerminal.mockClear()
  createdProcessor = null
  resumeGate = null
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

// Simulate the audio callback firing with ~0.5s of real-level speech, so the
// captured PCM clears the no-speech gate (≥0.2s AND above the RMS floor) and is
// actually transcribed.
function feedAudio() {
  const pcm = new Float32Array(8000) // 0.5s @ 16kHz
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.2 * Math.sin((2 * Math.PI * 180 * i) / 16000)
  act(() => {
    createdProcessor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => pcm } })
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

  it('stop() during the async AudioContext.resume() also aborts cleanly (no stuck listening)', async () => {
    // getUserMedia resolves fast, but the context resume() pends — modelling a
    // quick push-to-talk tap whose key-release lands while the context starts up.
    const stopTrack = vi.fn()
    ;(navigator.mediaDevices.getUserMedia as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] })
    let resolveResume!: () => void
    resumeGate = { promise: new Promise<void>((r) => { resolveResume = r }), resolve: () => {} }

    const { result } = renderHook(() => useVoiceInput('term-1', true))
    let startCall!: Promise<void>
    act(() => { startCall = result.current.start() })
    // Let start() progress past getUserMedia and park inside ctx.resume().
    await act(async () => {})

    // Key released before the mic is fully up.
    await act(async () => { await result.current.stop() })
    expect(result.current.listening).toBe(false)

    // resume() resolves: start() must NOT flip into listening, and must release
    // the mic + close the context instead of getting stuck.
    await act(async () => { resolveResume(); await startCall })
    expect(result.current.status).toBe('idle')
    expect(result.current.listening).toBe(false)
    expect(stopTrack).toHaveBeenCalled() // mic actually released
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

  it('no-speech gate: captured silence shows a notice and does NOT transcribe (no hallucination injected)', async () => {
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await act(async () => { await result.current.start() })
    // Feed 0.5s of SILENCE (zeros) — real length, but no speech content. This is
    // exactly the audio that made Whisper emit "I'm sorry. What is that?".
    act(() => {
      createdProcessor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(8000) } })
    })
    await act(async () => { await result.current.stop() })
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(h.writeToTerminal).not.toHaveBeenCalled()
    expect(result.current.status).toBe('error')
    expect(result.current.errorMsg).toMatch(/no speech/i)
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
