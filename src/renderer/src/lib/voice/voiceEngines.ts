// Speech-to-text engines behind a single interface. Local Whisper (worker) is
// the default; a cloud endpoint is the opt-in "turbo". The worker factory and
// fetch are injectable so the orchestration is unit-testable without a real
// model, audio device, or network.

import type { VoiceEngine, VoiceSettings, TranscriptResult } from './voiceTypes'

interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

/** Local engine: drives the Whisper worker; lazy-loads the model on first use. */
export class LocalWhisperEngine implements VoiceEngine {
  readonly kind = 'local' as const
  private worker: WorkerLike | null = null
  private ready: Promise<void> | null = null
  private seq = 0
  private pending = new Map<number, { resolve: (r: TranscriptResult) => void; reject: (e: Error) => void }>()

  constructor(
    private model: string,
    private makeWorker: () => WorkerLike = defaultWorkerFactory,
    // Localhost base URL ("http://127.0.0.1:<port>") for the bundled model + ORT
    // wasm. Empty → the worker falls back to relative paths and will fail loudly
    // (we never want a silent network fetch).
    private assetBase: string = '',
  ) {}

  private ensure(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const w = this.makeWorker()
      this.worker = w
      w.onmessage = (ev: { data: unknown }) => {
        const m = ev.data as { type?: string; id?: number; text?: string; nbest?: string[]; error?: string }
        if (m?.type === 'ready') resolve()
        else if (m?.type === 'load-error') reject(new Error(m.error || 'model load failed'))
        else if (m?.type === 'result' && typeof m.id === 'number') {
          this.pending.get(m.id)?.resolve({ text: m.text ?? '', nbest: m.nbest })
          this.pending.delete(m.id)
        } else if (m?.type === 'error' && typeof m.id === 'number') {
          this.pending.get(m.id)?.reject(new Error(m.error || 'transcription failed'))
          this.pending.delete(m.id)
        }
      }
      w.onerror = () => reject(new Error('voice worker crashed'))
      // device 'wasm' (CPU): reliable + offline. We only bundle q8 weights, and
      // the wasm path needs no GPU/driver or cross-origin isolation. assetBase
      // tells the worker where to fetch the bundled model + ORT wasm.
      w.postMessage({ type: 'load', model: this.model, device: 'wasm', assetBase: this.assetBase })
    })
    return this.ready
  }

  async transcribe(pcm16k: Float32Array): Promise<TranscriptResult> {
    await this.ensure()
    const id = ++this.seq
    return new Promise<TranscriptResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ type: 'transcribe', id, pcm: pcm16k }, [pcm16k.buffer])
    })
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    this.ready = null
    this.pending.clear()
  }
}

function defaultWorkerFactory(): WorkerLike {
  // Vite resolves the worker module + its dependency graph at build time.
  return new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike
}

/** Cloud engine (opt-in turbo): POST 16kHz PCM to a user-configured endpoint. */
export class CloudWhisperEngine implements VoiceEngine {
  readonly kind = 'cloud' as const
  constructor(
    private endpoint: string,
    private fetchImpl: typeof fetch = (...a: Parameters<typeof fetch>) => fetch(...a),
  ) {}

  async transcribe(pcm16k: Float32Array): Promise<TranscriptResult> {
    if (!this.endpoint) throw new Error('no cloud STT endpoint configured')
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: pcm16k.buffer as ArrayBuffer,
    })
    if (!res.ok) throw new Error(`cloud STT failed: ${res.status}`)
    const data = (await res.json()) as { text?: string; nbest?: string[] }
    return { text: String(data?.text ?? '').trim(), nbest: Array.isArray(data?.nbest) ? data.nbest : undefined }
  }

  dispose(): void {}
}

/** Build the engine for the current settings. Deps are injectable for tests. */
export function createVoiceEngine(
  settings: VoiceSettings,
  deps: { makeWorker?: () => WorkerLike; fetchImpl?: typeof fetch; assetBase?: string } = {},
): VoiceEngine {
  if (settings.engine === 'cloud') return new CloudWhisperEngine(settings.cloudEndpoint, deps.fetchImpl)
  return new LocalWhisperEngine(settings.model, deps.makeWorker, deps.assetBase)
}

export type { WorkerLike }
