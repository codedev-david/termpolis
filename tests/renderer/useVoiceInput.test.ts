// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Control the engine + terminal write from the tests.
const h = vi.hoisted(() => ({
  transcribe: vi.fn(async () => ({ text: 'hello world' })),
  writeToTerminal: vi.fn(),
  focusActiveTerminal: vi.fn(),
  // Mutable so a test can set inputDeviceId before calling start().
  settings: {
    enabled: true,
    consentAccepted: true,
    groqModel: 'whisper-large-v3-turbo',
    inputDeviceId: '',
    pushToTalkKey: 'Ctrl+Shift+Period',
    pushToTalkMode: 'hold',
    autoSubmitInAgent: false,
    correctionEnabled: true,
    confirmBeforeRunInShell: true,
  },
}))

vi.mock('../../src/renderer/src/lib/voice/voiceEngines', () => ({
  createVoiceEngine: () => ({ transcribe: h.transcribe, warm: vi.fn(async () => {}), dispose: vi.fn() }),
}))

// Hook reads voiceSettings via the store selector; return the mutable config.
vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: (selector: (s: unknown) => unknown) =>
    selector({ voiceSettings: h.settings, focusActiveTerminal: h.focusActiveTerminal }),
}))

import { useVoiceInput, MAX_RECORDING_MS, MIC_DISCONNECTED_MESSAGE, RECORDING_CAP_MESSAGE } from '../../src/renderer/src/hooks/useVoiceInput'

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
  createAnalyser() {
    return { fftSize: 2048, connect: vi.fn(), disconnect: vi.fn(), getFloatTimeDomainData: (a: Float32Array) => a.fill(0) }
  }
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
  h.settings.inputDeviceId = ''
  ;(window as unknown as { termpolis: unknown }).termpolis = {
    writeToTerminal: h.writeToTerminal,
    voiceTranscribe: vi.fn(async () => ({ success: true, data: { text: 'hello world' } })),
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

  it('Groq no-speech result (a bare ".") is NOT pasted — surfaces a mic notice instead', async () => {
    // The capture passed the energy gate (real-level audio) and reached Groq, but
    // Groq returned its no-speech token. We must never inject that phantom period.
    h.transcribe.mockResolvedValue({ text: ' .' })
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await act(async () => { await result.current.start() })
    feedAudio()
    await act(async () => { await result.current.stop() })
    expect(h.transcribe).toHaveBeenCalledTimes(1) // audio DID reach the engine
    expect(h.writeToTerminal).not.toHaveBeenCalled() // but the "." is never injected
    expect(result.current.status).toBe('error')
    expect(result.current.errorMsg).toMatch(/no speech|microphone/i)
    expect(h.focusActiveTerminal).toHaveBeenCalled()
  })

  it('Groq filler-word hallucination (a lone "The") is NOT pasted — surfaces a mic notice instead', async () => {
    // David's exact recurring symptom: real-level audio passes the capture gate and
    // reaches Groq, but the mic caught only room noise so Groq returns the stock
    // no-speech filler word "The". It has letters (slips past the "." backstop) yet
    // is still a phantom — it must be gated, never injected.
    h.transcribe.mockResolvedValue({ text: 'The' })
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await act(async () => { await result.current.start() })
    feedAudio()
    await act(async () => { await result.current.stop() })
    expect(h.transcribe).toHaveBeenCalledTimes(1) // audio DID reach the engine
    expect(h.writeToTerminal).not.toHaveBeenCalled() // but "The" is never injected
    expect(result.current.status).toBe('error')
    expect(result.current.errorMsg).toMatch(/no speech|microphone/i)
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

  it('uses the explicitly chosen input device', async () => {
    h.settings.inputDeviceId = 'mic-42'
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await act(async () => { await result.current.start() })
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: expect.objectContaining({ deviceId: { exact: 'mic-42' } }) }),
    )
  })

  it('falls back to the system default mic when the chosen device is unavailable', async () => {
    h.settings.inputDeviceId = 'unplugged'
    const gum = navigator.mediaDevices.getUserMedia as unknown as ReturnType<typeof vi.fn>
    gum.mockReset()
    gum.mockRejectedValueOnce(new Error('OverconstrainedError'))
    gum.mockResolvedValueOnce({ getTracks: () => [{ stop: vi.fn() }] })
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await act(async () => { await result.current.start() })
    expect(gum).toHaveBeenCalledTimes(2)
    // The retry drops the deviceId constraint so a stale id can't brick dictation.
    expect(gum.mock.calls[1][0]).toEqual({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    expect(result.current.status).toBe('listening')
  })

  it('exposes the capture analysis (verdict + level) so a failure is legible', async () => {
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    expect(result.current.lastCapture).toBeNull()
    await act(async () => { await result.current.start() })
    feedAudio()
    await act(async () => { await result.current.stop() })
    expect(result.current.lastCapture?.verdict).toBe('speech')
    expect(result.current.lastCapture?.peak).toBeGreaterThan(0)
  })

  it('steady background noise is gated as noise (NOT transcribed → no "the" hallucination)', async () => {
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await act(async () => { await result.current.start() })
    // Flat, mid-level hum: above the silence floor but no speech dynamics — the
    // exact dead-zone that made Whisper emit "the".
    act(() => {
      const pcm = new Float32Array(8000)
      for (let i = 0; i < pcm.length; i++) pcm[i] = 0.007 * Math.sin((2 * Math.PI * 120 * i) / 16000)
      createdProcessor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => pcm } })
    })
    await act(async () => { await result.current.stop() })
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(h.writeToTerminal).not.toHaveBeenCalled()
    expect(result.current.status).toBe('error')
    expect(result.current.errorMsg).toMatch(/background noise/i)
    expect(result.current.lastCapture?.verdict).toBe('noise')
  })

  it('runs the live level meter while listening (samples the analyser)', async () => {
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await act(async () => { await result.current.start() })
    expect(result.current.listening).toBe(true)
    // Let the ~33ms meter interval fire against the fake analyser a few times.
    await act(async () => { await new Promise((r) => setTimeout(r, 90)) })
    await act(async () => { await result.current.stop() })
    expect(result.current.listening).toBe(false)
  })

  it('toggle() starts when idle and stops when listening', async () => {
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await act(async () => { result.current.toggle() }) // idle → start
    expect(result.current.listening).toBe(true)
    await act(async () => { result.current.toggle() }) // listening → stop
    expect(result.current.listening).toBe(false)
  })

  it('cancelConfirm dismisses the confirm bar without injecting', async () => {
    const { result } = renderHook(() => useVoiceInput('term-1', false)) // shell → confirm path
    await act(async () => { await result.current.start() })
    feedAudio()
    await act(async () => { await result.current.stop() })
    expect(result.current.confirm?.text).toBe('hello world')
    act(() => { result.current.cancelConfirm() })
    expect(result.current.confirm).toBeNull()
    expect(h.writeToTerminal).not.toHaveBeenCalled()
  })
})

describe('useVoiceInput onTranscript sink', () => {
  async function speak(result: { current: ReturnType<typeof useVoiceInput> }) {
    await act(async () => { await result.current.start() })
    feedAudio()
    await act(async () => { await result.current.stop() })
  }

  it('with onTranscript, transcript goes to the sink and writeToTerminal is never called', async () => {
    const sink = vi.fn()
    const { result } = renderHook(() => useVoiceInput('term-1', true, { onTranscript: sink }))
    await speak(result)
    expect(sink).toHaveBeenCalledWith('hello world')
    expect(h.writeToTerminal).not.toHaveBeenCalled()
    expect(result.current.confirm).toBeNull()
    expect(h.focusActiveTerminal).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
  })

  it('terminalId null + onTranscript works, even for shell-mode text that would need confirming', async () => {
    const sink = vi.fn()
    const { result } = renderHook(() => useVoiceInput(null, false, { onTranscript: sink }))
    await speak(result)
    expect(sink).toHaveBeenCalledWith('hello world')
    expect(result.current.confirm).toBeNull()
    expect(h.writeToTerminal).not.toHaveBeenCalled()
  })

  it('terminalId null without a sink drops the transcript', async () => {
    const { result } = renderHook(() => useVoiceInput(null, true))
    await speak(result)
    expect(h.writeToTerminal).not.toHaveBeenCalled()
  })

  it('sink path keeps the no-speech handling and does not touch terminal focus', async () => {
    h.transcribe.mockResolvedValue({ text: '.' })
    const sink = vi.fn()
    const { result } = renderHook(() => useVoiceInput(null, false, { onTranscript: sink }))
    await speak(result)
    expect(sink).not.toHaveBeenCalled()
    expect(result.current.status).toBe('error')
    expect(result.current.errorMsg).toMatch(/no speech/i)
    expect(h.focusActiveTerminal).not.toHaveBeenCalled()
  })

})

// T8/T9: generations, cancel(), the mic's lifetime and the recording cap.
describe('useVoiceInput cancel, generations and mic lifetime', () => {
  type FakeTrack = { stop: ReturnType<typeof vi.fn>; onended: (() => void) | null; readyState: string }
  const makeTrack = (readyState = 'live'): FakeTrack => ({ stop: vi.fn(), onended: null, readyState })
  const streamOf = (...tracks: FakeTrack[]) => ({ getTracks: () => tracks })
  const gum = () => navigator.mediaDevices.getUserMedia as unknown as ReturnType<typeof vi.fn>
  function deferred<T>() {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
  let contextsMade = 0
  beforeEach(() => {
    contextsMade = 0
    // mockClear keeps queued once-implementations; a test that failed early must not leak them.
    h.transcribe.mockReset()
    h.transcribe.mockResolvedValue({ text: 'hello world' })
    vi.stubGlobal('AudioContext', class extends FakeAudioContext {
      constructor(o?: unknown) { super(o); contextsMade++ }
    })
  })
  afterEach(() => { vi.useRealTimers() })

  async function record(result: { current: ReturnType<typeof useVoiceInput> }) {
    await act(async () => { await result.current.start() })
    feedAudio()
  }

  it('exports cancel() on the hook', () => {
    const { result } = renderHook(() => useVoiceInput(null, false, { onTranscript: vi.fn() }))
    expect(typeof result.current.cancel).toBe('function')
    act(() => { expect(result.current.cancel()).toBeUndefined() })
    expect(result.current.status).toBe('idle')
  })

  it('cancel() during a transcription drops its transcript: no delivery and no state change', async () => {
    const sink = vi.fn()
    const pending = deferred<{ text: string }>()
    h.transcribe.mockImplementationOnce(() => pending.promise)
    const { result } = renderHook(() => useVoiceInput(null, false, { onTranscript: sink }))
    await record(result)
    let stopCall!: Promise<void>
    await act(async () => { stopCall = result.current.stop() })
    expect(result.current.status).toBe('transcribing')
    act(() => { result.current.cancel() })
    expect(result.current.status).toBe('idle')
    await act(async () => { pending.resolve({ text: 'late words' }); await stopCall })
    expect(sink).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
    expect(result.current.errorMsg).toBeNull()
  })

  it('cancel() during a transcription also drops its error', async () => {
    const pending = deferred<{ text: string }>()
    h.transcribe.mockImplementationOnce(() => pending.promise)
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await record(result)
    let stopCall!: Promise<void>
    await act(async () => { stopCall = result.current.stop() })
    act(() => { result.current.cancel() })
    await act(async () => { pending.reject(new Error('boom')); await stopCall })
    expect(result.current.status).toBe('idle')
    expect(result.current.errorMsg).toBeNull()
    expect(h.writeToTerminal).not.toHaveBeenCalled()
  })

  it('cancel() right after stop() keeps the audio from ever reaching Groq', async () => {
    const sink = vi.fn()
    const { result } = renderHook(() => useVoiceInput(null, false, { onTranscript: sink }))
    await record(result)
    await act(async () => {
      const stopCall = result.current.stop()
      result.current.cancel()
      await stopCall
    })
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(sink).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
  })

  it('cancel() while listening drops the recording and releases the mic', async () => {
    const track = makeTrack()
    gum().mockResolvedValue(streamOf(track))
    const sink = vi.fn()
    const { result } = renderHook(() => useVoiceInput(null, false, { onTranscript: sink }))
    await record(result)
    expect(result.current.listening).toBe(true)
    act(() => { result.current.cancel() })
    expect(result.current.status).toBe('idle')
    expect(track.stop).toHaveBeenCalled()
    expect(track.onended).toBeNull()
    // The released recording's stop is a no-op: nothing is transcribed.
    await act(async () => { await result.current.stop() })
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(sink).not.toHaveBeenCalled()
  })

  it('cancel() leaves an error on show', async () => {
    h.transcribe.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useVoiceInput(null, false, { onTranscript: vi.fn() }))
    await record(result)
    await act(async () => { await result.current.stop() })
    expect(result.current.status).toBe('error')
    act(() => { result.current.cancel() })
    expect(result.current.status).toBe('error')
    expect(result.current.errorMsg).toMatch(/boom/)
  })

  it('with a sink, a new recording drops the earlier transcription, so results cannot arrive out of order', async () => {
    const sink = vi.fn()
    const first = deferred<{ text: string }>()
    h.transcribe.mockImplementationOnce(() => first.promise)
    h.transcribe.mockImplementationOnce(async () => ({ text: 'second question' }))
    const { result } = renderHook(() => useVoiceInput(null, false, { onTranscript: sink }))
    await record(result)
    let firstStop!: Promise<void>
    await act(async () => { firstStop = result.current.stop() })
    await record(result) // a second recording starts while the first is still with Groq
    expect(result.current.status).toBe('listening')
    await act(async () => { first.resolve({ text: 'first question' }); await firstStop })
    expect(sink).not.toHaveBeenCalled()
    expect(result.current.status).toBe('listening') // the stale result set no state
    await act(async () => { await result.current.stop() })
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith('second question')
  })

  it('terminal dictation still delivers an earlier clip when a new recording starts (unchanged behaviour)', async () => {
    const first = deferred<{ text: string }>()
    h.transcribe.mockImplementationOnce(() => first.promise)
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await record(result)
    let firstStop!: Promise<void>
    await act(async () => { firstStop = result.current.stop() })
    await record(result)
    await act(async () => { first.resolve({ text: 'first words' }); await firstStop })
    expect(h.writeToTerminal).toHaveBeenCalledWith('term-1', 'first words')
  })

  it('dispose() during a transcription drops it with a sink, and still delivers it to a terminal', async () => {
    const sink = vi.fn()
    const a = deferred<{ text: string }>()
    h.transcribe.mockImplementationOnce(() => a.promise)
    const ask = renderHook(() => useVoiceInput(null, false, { onTranscript: sink }))
    await record(ask.result)
    let askStop!: Promise<void>
    await act(async () => { askStop = ask.result.current.stop() })
    ask.unmount()
    await act(async () => { a.resolve({ text: 'after close' }); await askStop })
    expect(sink).not.toHaveBeenCalled()

    const b = deferred<{ text: string }>()
    h.transcribe.mockImplementationOnce(() => b.promise)
    const term = renderHook(() => useVoiceInput('term-1', true))
    await record(term.result)
    let termStop!: Promise<void>
    await act(async () => { termStop = term.result.current.stop() })
    term.unmount()
    await act(async () => { b.resolve({ text: 'still typed' }); await termStop })
    expect(h.writeToTerminal).toHaveBeenCalledWith('term-1', 'still typed')
  })

  it('dispose() during a pending getUserMedia stops the late stream at once and opens no AudioContext', async () => {
    const mic = deferred<unknown>()
    gum().mockReturnValue(mic.promise)
    const track = makeTrack()
    const { result, unmount } = renderHook(() => useVoiceInput(null, false, { onTranscript: vi.fn() }))
    let startCall!: Promise<void>
    act(() => { startCall = result.current.start() })
    unmount()
    await act(async () => { mic.resolve(streamOf(track)); await startCall })
    expect(track.stop).toHaveBeenCalled()
    expect(track.onended).toBeNull()
    expect(contextsMade).toBe(0)
    expect(createdProcessor).toBeNull()
  })

  it('cancel() during a pending getUserMedia stops the late stream, and the next start works', async () => {
    const mic = deferred<unknown>()
    gum().mockReturnValueOnce(mic.promise)
    const late = makeTrack()
    const { result } = renderHook(() => useVoiceInput(null, false, { onTranscript: vi.fn() }))
    let startCall!: Promise<void>
    act(() => { startCall = result.current.start() })
    act(() => { result.current.cancel() })
    expect(result.current.status).toBe('idle')
    await act(async () => { mic.resolve(streamOf(late)); await startCall })
    expect(late.stop).toHaveBeenCalled()
    expect(contextsMade).toBe(0)
    expect(result.current.status).toBe('idle')
    gum().mockResolvedValueOnce(streamOf(makeTrack()))
    await act(async () => { await result.current.start() })
    expect(result.current.status).toBe('listening')
  })

  it('cancel() during AudioContext.resume() releases the mic and the start sets no state afterwards', async () => {
    const track = makeTrack()
    gum().mockResolvedValue(streamOf(track))
    const resume = deferred<void>()
    resumeGate = { promise: resume.promise, resolve: () => {} }
    const { result } = renderHook(() => useVoiceInput(null, false, { onTranscript: vi.fn() }))
    let startCall!: Promise<void>
    act(() => { startCall = result.current.start() })
    await act(async () => {}) // park inside resume()
    act(() => { result.current.cancel() })
    expect(track.stop).toHaveBeenCalled()
    await act(async () => { resume.resolve(); await startCall })
    expect(result.current.status).toBe('idle')
    expect(createdProcessor).toBeNull()
  })

  it('an abandoned start never falls back to the default mic when the chosen one fails', async () => {
    h.settings.inputDeviceId = 'mic-42'
    // Once via dispose (generation moved), once via a stop() during start (the cancel flag).
    for (const end of ['dispose', 'stop'] as const) {
      const chosen = deferred<unknown>()
      gum().mockReset()
      gum().mockReturnValueOnce(chosen.promise)
      const { result, unmount } = renderHook(() => useVoiceInput('term-1', true))
      let startCall!: Promise<void>
      act(() => { startCall = result.current.start() })
      if (end === 'dispose') unmount()
      else await act(async () => { await result.current.stop() })
      await act(async () => { chosen.reject(new Error('OverconstrainedError')); await startCall })
      expect(gum()).toHaveBeenCalledTimes(1)
      if (end === 'stop') {
        expect(result.current.status).toBe('idle')
        // The start is over: a new one may begin.
        gum().mockResolvedValueOnce(streamOf(makeTrack()))
        await act(async () => { await result.current.start() })
        expect(result.current.status).toBe('listening')
        unmount()
      }
    }
  })

  it('a getUserMedia that fails with no cancel still says the mic was blocked', async () => {
    gum().mockRejectedValueOnce(new Error('NotAllowedError'))
    const { result } = renderHook(() => useVoiceInput(null, false, { onTranscript: vi.fn() }))
    await act(async () => { await result.current.start() })
    expect(result.current.status).toBe('error')
    expect(result.current.errorMsg).toMatch(/blocked or no mic/)
  })

  it('a getUserMedia that fails after cancel() raises no error', async () => {
    const mic = deferred<unknown>()
    gum().mockReturnValueOnce(mic.promise)
    const { result } = renderHook(() => useVoiceInput(null, false, { onTranscript: vi.fn() }))
    let startCall!: Promise<void>
    act(() => { startCall = result.current.start() })
    act(() => { result.current.cancel() })
    await act(async () => { mic.reject(new Error('NotAllowedError')); await startCall })
    expect(result.current.status).toBe('idle')
    expect(result.current.errorMsg).toBeNull()
  })

  for (const mode of ['terminal', 'sink'] as const) {
    it('an unplugged mic (track ended) stops capture and says so (' + mode + ')', async () => {
      const track = makeTrack()
      gum().mockResolvedValue(streamOf(track))
      const sink = vi.fn()
      const { result } = renderHook(() => mode === 'sink'
        ? useVoiceInput(null, false, { onTranscript: sink })
        : useVoiceInput('term-1', true))
      await record(result)
      expect(track.onended).toBeTypeOf('function')
      act(() => { track.onended?.() })
      expect(result.current.status).toBe('error')
      expect(result.current.errorMsg).toBe(MIC_DISCONNECTED_MESSAGE)
      expect(track.stop).toHaveBeenCalled()
      expect(h.focusActiveTerminal).toHaveBeenCalledTimes(mode === 'terminal' ? 1 : 0)
      await act(async () => { await result.current.stop() })
      expect(h.transcribe).not.toHaveBeenCalled()
      expect(sink).not.toHaveBeenCalled()
    })
  }

  it('a track that has already ended when listening begins is treated as unplugged', async () => {
    gum().mockResolvedValue(streamOf(makeTrack('ended')))
    const { result } = renderHook(() => useVoiceInput(null, false, { onTranscript: vi.fn() }))
    await act(async () => { await result.current.start() })
    expect(result.current.status).toBe('error')
    expect(result.current.errorMsg).toBe(MIC_DISCONNECTED_MESSAGE)
  })

  it('an ended event after the recording stopped, or from an earlier recording, changes nothing', async () => {
    const first = makeTrack()
    const second = makeTrack()
    gum().mockResolvedValueOnce(streamOf(first)).mockResolvedValueOnce(streamOf(second))
    const sink = vi.fn()
    const { result } = renderHook(() => useVoiceInput(null, false, { onTranscript: sink }))
    await record(result)
    const firstEnded = first.onended!
    await act(async () => { await result.current.stop() })
    act(() => { firstEnded() }) // not listening: ignored
    expect(result.current.status).toBe('idle')
    await record(result)
    act(() => { firstEnded() }) // listening, but to the second recording: ignored
    expect(result.current.status).toBe('listening')
    expect(result.current.errorMsg).toBeNull()
  })

  for (const mode of ['terminal', 'sink'] as const) {
    it('stops a recording at 5 minutes, transcribes what was said and shows the note (' + mode + ')', async () => {
      vi.useFakeTimers()
      const sink = vi.fn()
      const { result } = renderHook(() => mode === 'sink'
        ? useVoiceInput(null, false, { onTranscript: sink })
        : useVoiceInput('term-1', true))
      await record(result)
      await act(async () => { await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS - 1) })
      expect(result.current.listening).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(result.current.listening).toBe(false)
      expect(h.transcribe).toHaveBeenCalledTimes(1)
      if (mode === 'sink') expect(sink).toHaveBeenCalledWith('hello world')
      else expect(h.writeToTerminal).toHaveBeenCalledWith('term-1', 'hello world')
      expect(result.current.status).toBe('idle')
      expect(result.current.errorMsg).toBe(RECORDING_CAP_MESSAGE)
      expect(vi.getTimerCount()).toBe(0)
    })
  }

  it('a recording stopped before the cap leaves no cap timer behind', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useVoiceInput('term-1', true))
    await record(result)
    expect(vi.getTimerCount()).toBe(2) // the level meter and the cap
    await act(async () => { await result.current.stop() })
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS) })
    expect(h.transcribe).toHaveBeenCalledTimes(1)
    expect(result.current.errorMsg).toBeNull()
  })
})
