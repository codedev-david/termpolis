// Speech-to-text via Groq's hosted Whisper API. The actual HTTP request AND the
// API key live in the MAIN process (the key never enters the renderer) — this
// engine is a thin proxy that ships the captured 16kHz PCM over IPC and gets back
// the transcript. The transport is injectable so the orchestration is fully
// unit-testable without Electron/IPC.

import type { VoiceEngine, VoiceSettings, TranscriptResult } from './voiceTypes'
import { GROQ_DEADLINE_MS, GROQ_TIMEOUT_MESSAGE } from '../../../../shared/voiceDeadline'

export type TranscribeTransport = (pcm16k: Float32Array, model?: string) => Promise<TranscriptResult>

/** Main aborts Groq at GROQ_DEADLINE_MS and answers with the timeout error. This grace covers the WAV
 *  encode and the IPC hops, so the renderer gives up on its own only when main never answers at all. */
export const IPC_TRANSCRIBE_GRACE_MS = 5_000

/** Default transport: round-trips through the `voice:transcribe` IPC handler. */
function ipcTransport(): TranscribeTransport {
  return async (pcm16k, model) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const backstop = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(GROQ_TIMEOUT_MESSAGE)), GROQ_DEADLINE_MS + IPC_TRANSCRIBE_GRACE_MS)
    })
    try {
      const res = await Promise.race([window.termpolis.voiceTranscribe(pcm16k, model), backstop])
      if (!res?.success) throw new Error(res?.error || 'Groq transcription failed')
      return { text: res.data?.text ?? '' }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Groq cloud engine. Sends PCM to main → Groq, returns text. */
export class GroqWhisperEngine implements VoiceEngine {
  constructor(
    private model: string,
    private transport: TranscribeTransport = ipcTransport(),
  ) {}

  async transcribe(pcm16k: Float32Array): Promise<TranscriptResult> {
    return this.transport(pcm16k, this.model)
  }

  // No local model to load — warming is a no-op (kept so the hook can call it).
  async warm(): Promise<void> {}

  dispose(): void {}
}

/** Build the engine for the current settings. Transport is injectable for tests. */
export function createVoiceEngine(
  settings: VoiceSettings,
  deps: { transport?: TranscribeTransport } = {},
): VoiceEngine {
  return new GroqWhisperEngine(settings.groqModel, deps.transport)
}
