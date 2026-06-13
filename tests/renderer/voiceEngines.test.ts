// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { GroqWhisperEngine, createVoiceEngine } from '../../src/renderer/src/lib/voice/voiceEngines'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '../../src/renderer/src/lib/voice/voiceTypes'

function settings(overrides: Partial<VoiceSettings> = {}): VoiceSettings {
  return { ...DEFAULT_VOICE_SETTINGS, ...overrides }
}

afterEach(() => {
  delete (window as unknown as { termpolis?: unknown }).termpolis
})

describe('GroqWhisperEngine', () => {
  it('sends the PCM + model through the transport and returns the transcript', async () => {
    const transport = vi.fn(async () => ({ text: 'hello there' }))
    const engine = new GroqWhisperEngine('whisper-large-v3-turbo', transport)
    const pcm = new Float32Array([0.1, -0.1])
    const res = await engine.transcribe(pcm)
    expect(res.text).toBe('hello there')
    expect(transport).toHaveBeenCalledWith(pcm, 'whisper-large-v3-turbo')
  })

  it('propagates transport errors', async () => {
    const transport = vi.fn(async () => {
      throw new Error('Groq transcription failed')
    })
    const engine = new GroqWhisperEngine('m', transport)
    await expect(engine.transcribe(new Float32Array([0]))).rejects.toThrow(/Groq/)
  })

  it('warm() and dispose() are no-ops that never throw', async () => {
    const engine = new GroqWhisperEngine('m', vi.fn())
    await expect(engine.warm()).resolves.toBeUndefined()
    expect(() => engine.dispose()).not.toThrow()
  })
})

describe('createVoiceEngine', () => {
  it('builds a Groq engine that uses the settings model + injected transport', async () => {
    const transport = vi.fn(async () => ({ text: 'x' }))
    const engine = createVoiceEngine(settings({ groqModel: 'whisper-large-v3' }), { transport })
    await engine.transcribe(new Float32Array([0]))
    expect(transport).toHaveBeenCalledWith(expect.any(Float32Array), 'whisper-large-v3')
  })
})

describe('default IPC transport', () => {
  it('round-trips through window.termpolis.voiceTranscribe and returns its text', async () => {
    const voiceTranscribe = vi.fn(async () => ({ success: true, data: { text: 'via ipc' } }))
    ;(window as unknown as { termpolis: unknown }).termpolis = { voiceTranscribe }
    const pcm = new Float32Array([0.2])
    const res = await createVoiceEngine(settings({ groqModel: 'whisper-large-v3-turbo' })).transcribe(pcm)
    expect(res.text).toBe('via ipc')
    expect(voiceTranscribe).toHaveBeenCalledWith(pcm, 'whisper-large-v3-turbo')
  })

  it('throws with the IPC error message when the transcribe call fails', async () => {
    ;(window as unknown as { termpolis: unknown }).termpolis = {
      voiceTranscribe: vi.fn(async () => ({ success: false, error: 'Groq is not connected' })),
    }
    await expect(createVoiceEngine(settings()).transcribe(new Float32Array([0]))).rejects.toThrow(/not connected/)
  })

  it('defaults the transcript to empty string when the response omits data', async () => {
    ;(window as unknown as { termpolis: unknown }).termpolis = {
      voiceTranscribe: vi.fn(async () => ({ success: true, data: {} })),
    }
    const res = await createVoiceEngine(settings()).transcribe(new Float32Array([0]))
    expect(res.text).toBe('')
  })
})
