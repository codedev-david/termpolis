import { describe, it, expect, vi, afterEach } from 'vitest'
import { GROQ_DEADLINE_MS, GROQ_TIMEOUT_MESSAGE } from '../../src/shared/voiceDeadline'
import {
  encodeWav,
  buildMultipartBody,
  transcribeWithGroq,
  validateGroqKey,
  GROQ_TRANSCRIBE_URL,
  GROQ_MODELS_URL,
  DEFAULT_GROQ_MODEL,
} from '../../src/main/groqTranscription'

// A minimal fetch double: returns whatever {ok,status,json,text} we configure and
// records the call so we can assert URL/headers/body without a network.
function fakeFetch(impl: (url: string, init: any) => any) {
  return vi.fn((url: string, init: any) => Promise.resolve(impl(url, init))) as unknown as typeof fetch
}

describe('encodeWav', () => {
  it('writes a valid 16kHz mono 16-bit PCM WAV header', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5]), 16000)
    expect(wav.length).toBe(44 + 3 * 2) // 44-byte header + 3 samples * 2 bytes
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ')
    expect(wav.readUInt16LE(20)).toBe(1) // PCM format
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(16000) // sample rate
    expect(wav.readUInt32LE(28)).toBe(16000 * 2) // byte rate (mono, 16-bit)
    expect(wav.readUInt16LE(32)).toBe(2) // block align
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(3 * 2) // data size
  })

  it('converts float samples to clamped 16-bit integers', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2, -2]), 16000)
    expect(wav.readInt16LE(44)).toBe(0)
    expect(wav.readInt16LE(46)).toBe(32767) // +1.0 → max
    expect(wav.readInt16LE(48)).toBe(-32768) // -1.0 → min
    expect(wav.readInt16LE(50)).toBe(32767) // +2.0 clamps to max
    expect(wav.readInt16LE(52)).toBe(-32768) // -2.0 clamps to min
  })

  it('handles empty input (header only)', () => {
    const wav = encodeWav(new Float32Array([]), 16000)
    expect(wav.length).toBe(44)
    expect(wav.readUInt32LE(40)).toBe(0)
  })

  it('respects a non-default sample rate', () => {
    const wav = encodeWav(new Float32Array([0]), 48000)
    expect(wav.readUInt32LE(24)).toBe(48000)
  })
})

describe('buildMultipartBody', () => {
  it('builds multipart/form-data with file + model parts and a matching boundary', () => {
    const wav = encodeWav(new Float32Array([0, 0.1]), 16000)
    const { body, contentType } = buildMultipartBody(wav, 'whisper-large-v3-turbo', { boundary: 'BOUNDARY123' })
    expect(contentType).toBe('multipart/form-data; boundary=BOUNDARY123')
    const text = body.toString('latin1')
    expect(text).toContain('--BOUNDARY123')
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="audio.wav"')
    expect(text).toContain('Content-Type: audio/wav')
    expect(text).toContain('name="model"')
    expect(text).toContain('whisper-large-v3-turbo')
    expect(text.trimEnd().endsWith('--BOUNDARY123--')).toBe(true)
  })

  it('embeds the raw wav bytes intact', () => {
    const wav = encodeWav(new Float32Array([0.25, -0.25]), 16000)
    const { body } = buildMultipartBody(wav, 'm', { boundary: 'B' })
    // The wav bytes must appear verbatim inside the multipart body.
    expect(body.includes(wav)).toBe(true)
  })
})

describe('transcribeWithGroq', () => {
  const pcm = new Float32Array([0.1, -0.1, 0.2])

  it('POSTs a multipart request with Bearer auth and returns the trimmed text', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ text: '  hello world  ' }) }))
    const res = await transcribeWithGroq(pcm, { apiKey: 'gsk_test', fetchImpl })
    expect(res.text).toBe('hello world')
    const [url, init] = (fetchImpl as any).mock.calls[0]
    expect(url).toBe(GROQ_TRANSCRIBE_URL)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer gsk_test')
    expect(String(init.headers['Content-Type'])).toMatch(/^multipart\/form-data; boundary=/)
    expect(Buffer.isBuffer(init.body)).toBe(true)
  })

  it('defaults to the turbo model and includes it in the body', async () => {
    let bodyText = ''
    const fetchImpl = fakeFetch((_u, init) => {
      bodyText = (init.body as Buffer).toString('latin1')
      return { ok: true, status: 200, json: async () => ({ text: 'x' }) }
    })
    await transcribeWithGroq(pcm, { apiKey: 'k', fetchImpl })
    expect(bodyText).toContain(DEFAULT_GROQ_MODEL)
  })

  it('uses a custom model when provided', async () => {
    let bodyText = ''
    const fetchImpl = fakeFetch((_u, init) => {
      bodyText = (init.body as Buffer).toString('latin1')
      return { ok: true, status: 200, json: async () => ({ text: 'x' }) }
    })
    await transcribeWithGroq(pcm, { apiKey: 'k', model: 'whisper-large-v3', fetchImpl })
    expect(bodyText).toContain('whisper-large-v3')
  })

  it('throws (with the status) on a non-2xx response', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 401, text: async () => 'invalid api key' }))
    await expect(transcribeWithGroq(pcm, { apiKey: 'bad', fetchImpl })).rejects.toThrow(/401/)
  })

  it('rejects when no API key is supplied (never calls the network)', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ text: 'x' }) }))
    await expect(transcribeWithGroq(pcm, { apiKey: '', fetchImpl })).rejects.toThrow(/key/i)
    expect((fetchImpl as any).mock.calls.length).toBe(0)
  })

  it('propagates a network failure', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('network down'))) as unknown as typeof fetch
    await expect(transcribeWithGroq(pcm, { apiKey: 'k', fetchImpl })).rejects.toThrow(/network down/)
  })

  it('returns empty string when the response omits text', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({}) }))
    const res = await transcribeWithGroq(pcm, { apiKey: 'k', fetchImpl })
    expect(res.text).toBe('')
  })
})

describe('transcribeWithGroq deadline', () => {
  const pcm = new Float32Array([0.1, -0.1])
  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts at 30 s while the reply body is stalled, and says Groq took too long', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    // Headers arrive at once; the body never does, and ignores the signal (the worst case).
    const fetchImpl = fakeFetch((_u, init) => {
      signal = init.signal
      return { ok: true, status: 200, json: () => new Promise(() => {}) }
    })
    const call = transcribeWithGroq(pcm, { apiKey: 'k', fetchImpl })
    const settled = vi.fn()
    call.then(settled, settled)
    await vi.advanceTimersByTimeAsync(GROQ_DEADLINE_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(call).rejects.toThrow(GROQ_TIMEOUT_MESSAGE)
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a request whose headers never arrive, mapping the AbortError to the same message', async () => {
    vi.useFakeTimers()
    // A fetch that honours the signal: it rejects with its own AbortError when aborted.
    const fetchImpl = vi.fn((_u: string, init: any) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })))
    })) as unknown as typeof fetch
    const call = transcribeWithGroq(pcm, { apiKey: 'k', fetchImpl })
    const caught = call.catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(GROQ_DEADLINE_MS)
    const e = await caught
    expect((e as Error).message).toBe(GROQ_TIMEOUT_MESSAGE)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('also covers a stalled error body on a non-2xx reply', async () => {
    vi.useFakeTimers()
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 500, text: () => new Promise(() => {}) }))
    const caught = transcribeWithGroq(pcm, { apiKey: 'k', fetchImpl }).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(GROQ_DEADLINE_MS)
    expect(((await caught) as Error).message).toBe(GROQ_TIMEOUT_MESSAGE)
  })

  it('clears the timer on success and on failure', async () => {
    vi.useFakeTimers()
    const good = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ text: 'hi' }) }))
    await expect(transcribeWithGroq(pcm, { apiKey: 'k', fetchImpl: good })).resolves.toEqual({ text: 'hi' })
    expect(vi.getTimerCount()).toBe(0)
    const bad = fakeFetch(() => ({ ok: false, status: 401, text: async () => 'no' }))
    await expect(transcribeWithGroq(pcm, { apiKey: 'k', fetchImpl: bad })).rejects.toThrow(/401/)
    expect(vi.getTimerCount()).toBe(0)
    const down = vi.fn(() => Promise.reject(new Error('network down'))) as unknown as typeof fetch
    await expect(transcribeWithGroq(pcm, { apiKey: 'k', fetchImpl: down })).rejects.toThrow(/network down/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes an AbortSignal to fetch', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ text: 'x' }) }))
    await transcribeWithGroq(pcm, { apiKey: 'k', fetchImpl })
    const [, init] = (fetchImpl as any).mock.calls[0]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal.aborted).toBe(false)
  })
})

describe('validateGroqKey', () => {
  it('returns ok for a 200 from the models endpoint with Bearer auth', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: true, status: 200 }))
    const res = await validateGroqKey('gsk_good', { fetchImpl })
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    const [url, init] = (fetchImpl as any).mock.calls[0]
    expect(url).toBe(GROQ_MODELS_URL)
    expect(init.headers.Authorization).toBe('Bearer gsk_good')
  })

  it('returns not-ok with the status for a 401', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 401, text: async () => 'unauthorized' }))
    const res = await validateGroqKey('gsk_bad', { fetchImpl })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(401)
    expect(res.error).toBeTruthy()
  })

  it('returns not-ok (no throw) on a network error', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
    const res = await validateGroqKey('k', { fetchImpl })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/offline/)
  })

  it('rejects an empty key without calling the network', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: true, status: 200 }))
    const res = await validateGroqKey('', { fetchImpl })
    expect(res.ok).toBe(false)
    expect((fetchImpl as any).mock.calls.length).toBe(0)
  })

  it('falls back to "HTTP <status>" when the error body is empty', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 403, text: async () => '' }))
    const res = await validateGroqKey('k', { fetchImpl })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('HTTP 403')
  })

  it('still reports not-ok when reading the error body itself throws', async () => {
    const fetchImpl = fakeFetch(() => ({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('stream broke')
      },
    }))
    const res = await validateGroqKey('k', { fetchImpl })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(500)
  })
})

describe('edge cases', () => {
  it('encodeWav uses a 16kHz default sample rate when none is given', () => {
    const wav = encodeWav(new Float32Array([0, 0.1]))
    expect(wav.readUInt32LE(24)).toBe(16000)
  })

  it('buildMultipartBody generates a unique boundary when none is supplied', () => {
    const wav = encodeWav(new Float32Array([0]))
    const a = buildMultipartBody(wav, 'm')
    const b = buildMultipartBody(wav, 'm')
    expect(a.contentType).toMatch(/^multipart\/form-data; boundary=----termpolis/)
    expect(a.contentType).not.toBe(b.contentType) // fresh boundary each call
    expect(a.body.toString('latin1')).toContain('filename="audio.wav"')
  })

  it('transcribeWithGroq still throws (with status) when reading the error body throws', async () => {
    const fetchImpl = fakeFetch(() => ({
      ok: false,
      status: 502,
      text: async () => {
        throw new Error('no body')
      },
    }))
    await expect(transcribeWithGroq(new Float32Array([0.1]), { apiKey: 'k', fetchImpl })).rejects.toThrow(/502/)
  })

  it('transcribeWithGroq rejects a whitespace-only API key without calling the network', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ text: 'x' }) }))
    await expect(transcribeWithGroq(new Float32Array([0]), { apiKey: '   ', fetchImpl })).rejects.toThrow(/key/i)
    expect((fetchImpl as any).mock.calls.length).toBe(0)
  })
})
