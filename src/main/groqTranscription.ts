// Groq hosted speech-to-text (OpenAI-compatible Whisper API). Runs in the MAIN
// process so the API key never enters the renderer: the renderer hands raw 16kHz
// PCM over IPC, main encodes a WAV, posts it to Groq with the Bearer key read
// from the OS keychain, and returns only the transcript text.
//
// Everything here is pure/injectable (fetch is a parameter) so the WAV encoding,
// multipart framing, auth header, and error handling are fully unit-testable
// without a network or an Electron runtime.

export const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
export const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models'
// whisper-large-v3-turbo: ~$0.04/hr, 216x real-time, far more accurate than the
// old bundled whisper-base.en — and nothing to bundle or load locally.
export const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo'

/**
 * Encode mono Float32 PCM (samples in [-1,1]) as a 16-bit PCM WAV Buffer.
 * Out-of-range samples are clamped. Pure.
 */
export function encodeWav(pcm: Float32Array, sampleRate = 16000): Buffer {
  const numSamples = pcm.length
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  // RIFF header
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  // fmt chunk
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // PCM fmt chunk size
  buf.writeUInt16LE(1, 20) // audio format = PCM
  buf.writeUInt16LE(1, 22) // channels = mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byte rate (mono, 16-bit = 2 bytes/sample)
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  // data chunk
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < numSamples; i++) {
    let s = pcm[i]
    if (Number.isNaN(s)) s = 0 // a glitched sample must not poison the buffer
    else if (s < -1) s = -1
    else if (s > 1) s = 1
    const v = s < 0 ? s * 0x8000 : s * 0x7fff
    buf.writeInt16LE(Math.round(v), 44 + i * 2)
  }
  return buf
}

function randomBoundary(): string {
  return `----termpolis${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

/**
 * Frame a WAV blob + model field as multipart/form-data by hand (no FormData/Blob
 * dependency), so the exact bytes on the wire are deterministic and testable.
 */
export function buildMultipartBody(
  wav: Buffer,
  model: string,
  opts: { filename?: string; boundary?: string } = {},
): { body: Buffer; contentType: string } {
  const boundary = opts.boundary || randomBoundary()
  const filename = opts.filename || 'audio.wav'
  const filePart = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`,
    'utf8',
  )
  const modelPart = Buffer.from(
    `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `${model}\r\n` +
      `--${boundary}--\r\n`,
    'utf8',
  )
  return {
    body: Buffer.concat([filePart, wav, modelPart]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

export interface GroqTranscribeOptions {
  apiKey: string
  model?: string
  fetchImpl?: typeof fetch
  endpoint?: string
  boundary?: string
}

/** Transcribe 16kHz mono PCM via Groq. Throws on missing key, non-2xx, or network error. */
export async function transcribeWithGroq(
  pcm16k: Float32Array,
  opts: GroqTranscribeOptions,
): Promise<{ text: string }> {
  if (!opts.apiKey || !opts.apiKey.trim()) {
    throw new Error('No Groq API key configured. Connect Groq in Settings → Voice.')
  }
  const f = opts.fetchImpl ?? (globalThis.fetch as typeof fetch)
  const model = opts.model || DEFAULT_GROQ_MODEL
  const wav = encodeWav(pcm16k, 16000)
  const { body, contentType } = buildMultipartBody(wav, model, { boundary: opts.boundary })
  const res = await f(opts.endpoint || GROQ_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': contentType },
    body: body as unknown as BodyInit,
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = await res.text()
    } catch {
      /* body unreadable */
    }
    throw new Error(`Groq transcription failed: ${res.status}${detail ? ` ${detail}` : ''}`)
  }
  const data = (await res.json()) as { text?: string }
  return { text: String(data?.text ?? '').trim() }
}

export interface GroqValidateResult {
  ok: boolean
  status?: number
  error?: string
}

/**
 * Verify an API key by hitting Groq's models endpoint. Never throws — returns a
 * result the connect UI can render (so a bad key / no network fails *here*, with
 * a clear message, rather than silently at first dictation).
 */
export async function validateGroqKey(
  apiKey: string,
  opts: { fetchImpl?: typeof fetch; endpoint?: string } = {},
): Promise<GroqValidateResult> {
  if (!apiKey || !apiKey.trim()) return { ok: false, error: 'No API key provided' }
  const f = opts.fetchImpl ?? (globalThis.fetch as typeof fetch)
  try {
    const res = await f(opts.endpoint || GROQ_MODELS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (res.ok) return { ok: true, status: res.status }
    let detail = ''
    try {
      detail = await res.text()
    } catch {
      /* ignore */
    }
    return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
