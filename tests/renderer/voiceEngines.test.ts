import { describe, it, expect, vi } from 'vitest'
import { LocalWhisperEngine, CloudWhisperEngine, createVoiceEngine, type WorkerLike } from '../../src/renderer/src/lib/voice/voiceEngines'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '../../src/renderer/src/lib/voice/voiceTypes'

const settings = (over: Partial<VoiceSettings> = {}): VoiceSettings => ({ ...DEFAULT_VOICE_SETTINGS, ...over })

// A fake worker that scripts the responses the real Whisper worker would post.
class FakeWorker implements WorkerLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  posted: any[] = []
  terminated = false
  constructor(private behavior: 'ok' | 'loadError' | 'txError' = 'ok') {}
  postMessage(msg: any): void {
    this.posted.push(msg)
    queueMicrotask(() => {
      if (msg.type === 'load') {
        if (this.behavior === 'loadError') this.onmessage?.({ data: { type: 'load-error', error: 'no webgpu' } })
        else this.onmessage?.({ data: { type: 'ready', device: 'wasm' } })
      } else if (msg.type === 'transcribe') {
        if (this.behavior === 'txError') this.onmessage?.({ data: { type: 'error', id: msg.id, error: 'decode boom' } })
        else this.onmessage?.({ data: { type: 'result', id: msg.id, text: 'hello world', nbest: ['hello word'] } })
      }
    })
  }
  terminate(): void { this.terminated = true }
}

describe('voiceEngines', () => {
  describe('createVoiceEngine', () => {
    it('builds a local engine by default and a cloud engine when selected', () => {
      expect(createVoiceEngine(settings({ engine: 'local' })).kind).toBe('local')
      expect(createVoiceEngine(settings({ engine: 'cloud', cloudEndpoint: 'http://x' })).kind).toBe('cloud')
    })
  })

  describe('LocalWhisperEngine', () => {
    it('loads the model once, then transcribes via the worker', async () => {
      const fake = new FakeWorker('ok')
      const engine = new LocalWhisperEngine('model-x', () => fake)
      const r1 = await engine.transcribe(new Float32Array([0.1, 0.2]))
      expect(r1).toEqual({ text: 'hello world', nbest: ['hello word'] })
      // A second call reuses the same (already-loaded) worker — only one 'load' message.
      await engine.transcribe(new Float32Array([0.3]))
      expect(fake.posted.filter((m) => m.type === 'load')).toHaveLength(1)
    })

    it('rejects when the model fails to load', async () => {
      const engine = new LocalWhisperEngine('model-x', () => new FakeWorker('loadError'))
      await expect(engine.transcribe(new Float32Array([0]))).rejects.toThrow(/no webgpu/)
    })

    it('rejects when transcription errors', async () => {
      const engine = new LocalWhisperEngine('model-x', () => new FakeWorker('txError'))
      await expect(engine.transcribe(new Float32Array([0]))).rejects.toThrow(/decode boom/)
    })

    it('terminates the worker on dispose', async () => {
      const fake = new FakeWorker('ok')
      const engine = new LocalWhisperEngine('model-x', () => fake)
      await engine.transcribe(new Float32Array([0]))
      engine.dispose()
      expect(fake.terminated).toBe(true)
    })
  })

  describe('CloudWhisperEngine', () => {
    it('POSTs audio to the endpoint and returns the transcript', async () => {
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: 'cloud text', nbest: ['c'] }) })) as any
      const engine = new CloudWhisperEngine('https://stt.example/transcribe', fetchImpl)
      const r = await engine.transcribe(new Float32Array([0.1]))
      expect(r).toEqual({ text: 'cloud text', nbest: ['c'] })
      expect(fetchImpl).toHaveBeenCalledWith('https://stt.example/transcribe', expect.objectContaining({ method: 'POST' }))
    })

    it('throws without an endpoint', async () => {
      const engine = new CloudWhisperEngine('')
      await expect(engine.transcribe(new Float32Array([0]))).rejects.toThrow(/no cloud STT endpoint/)
    })

    it('throws on a non-OK response', async () => {
      const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as any
      const engine = new CloudWhisperEngine('https://stt.example', fetchImpl)
      await expect(engine.transcribe(new Float32Array([0]))).rejects.toThrow(/503/)
    })
  })
})
