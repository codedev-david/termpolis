import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  configureOffline,
  VOICE_MODELS_URL_PATH,
  VOICE_ORT_URL_PATH,
  VOICE_SESSION_OPTIONS,
} from '../../src/renderer/src/lib/voice/voiceWorkerConfig'

// The Whisper worker's offline configuration is the exact contract that broke in
// v1.12.0-v1.12.2: it must point Transformers.js at the LOCALHOST asset server
// for BOTH the model and the onnxruntime-web wasm runtime, and forbid every
// network fetch. The wasm path (`wasmPaths`) is where ORT dynamically imports its
// backend loader (ort-wasm-simd-threaded.asyncify.mjs); a wrong path → 404 →
// "no available backend found". This logic lived inside whisperWorker.ts (which
// can't run in jsdom and is coverage-excluded), so it was never tested. Now it is.

function fakeTransformers(): { env: any } {
  return { env: { backends: { onnx: { wasm: {} } } } }
}

describe('configureOffline', () => {
  const BASE = 'http://127.0.0.1:54231'

  it('forbids remote models so the strict CSP (no huggingface.co) is never hit', async () => {
    const t = fakeTransformers()
    await configureOffline(t, BASE)
    expect(t.env.allowRemoteModels).toBe(false)
    expect(t.env.allowLocalModels).toBe(true)
  })

  it('points the model path at /models/ on the localhost asset server', async () => {
    const t = fakeTransformers()
    await configureOffline(t, BASE)
    expect(t.env.localModelPath).toBe(`${BASE}/models/`)
  })

  it('points the ORT wasm loader at /voice-runtime/ort/ (the URL that 404d in v1.12.2)', async () => {
    const t = fakeTransformers()
    await configureOffline(t, BASE)
    expect(t.env.backends.onnx.wasm.wasmPaths).toBe(`${BASE}/voice-runtime/ort/`)
  })

  it('forces single-thread, no-proxy wasm (renderer is not cross-origin isolated)', async () => {
    const t = fakeTransformers()
    await configureOffline(t, BASE)
    expect(t.env.backends.onnx.wasm.numThreads).toBe(1)
    expect(t.env.backends.onnx.wasm.proxy).toBe(false)
  })

  it('does not throw when the onnx wasm backend object is absent', async () => {
    const t = { env: {} } as any
    await expect(configureOffline(t, BASE)).resolves.toBeUndefined()
    // The offline flags must still be applied even if the wasm backend is missing.
    expect(t.env.allowRemoteModels).toBe(false)
    expect(t.env.localModelPath).toBe(`${BASE}/models/`)
  })
})

describe('VOICE_SESSION_OPTIONS — the graph-optimization workaround (v1.12.4)', () => {
  // v1.12.3 fixed the wasm 404 but voice STILL failed at session creation:
  // ORT-web's extended-level TransposeDQWeightsForMatMulNBits fusion crashes on
  // whisper-base's q8 merged decoder ("Missing required scale: ...
  // embed_tokens.weight_merged_0_scale"). Reproduced in Chromium; default/'extended'
  // crash, 'basic'/'disabled' load. We ship 'basic'. These tests pin that so the
  // fix can't be silently dropped; `npm run voice:verify` proves the REAL load.
  it("sets graphOptimizationLevel to 'basic' (below the crashing 'extended' level)", () => {
    expect(VOICE_SESSION_OPTIONS.graphOptimizationLevel).toBe('basic')
  })

  it("never ships the levels that crash the merged decoder ('extended'/'all')", () => {
    expect(VOICE_SESSION_OPTIONS.graphOptimizationLevel).not.toBe('extended')
    expect(VOICE_SESSION_OPTIONS.graphOptimizationLevel).not.toBe('all')
  })

  it('is actually passed to the Whisper pipeline as session_options', () => {
    // whisperWorker.ts runs a real Worker/WASM model and is coverage-excluded, so
    // assert its wiring as source text (same approach as downloadVoiceModelScript).
    const worker = readFileSync(
      resolve(__dirname, '..', '..', 'src', 'renderer', 'src', 'lib', 'voice', 'whisperWorker.ts'),
      'utf8',
    )
    expect(worker).toContain('session_options: VOICE_SESSION_OPTIONS')
    expect(worker).toContain("import { configureOffline, VOICE_SESSION_OPTIONS }")
  })
})

describe('voice runtime URL-path contract', () => {
  it('serves the model under the asset server /models/ prefix', () => {
    expect(VOICE_MODELS_URL_PATH).toBe('/models/')
  })

  it('serves the ORT wasm under the asset server /voice-runtime/ prefix', () => {
    // voiceAssetServer.ts serves the "/voice-runtime/" prefix; the worker MUST
    // request its wasm beneath it or every model load fails.
    expect(VOICE_ORT_URL_PATH.startsWith('/voice-runtime/')).toBe(true)
    expect(VOICE_ORT_URL_PATH).toBe('/voice-runtime/ort/')
  })
})
