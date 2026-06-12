import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  configureOffline,
  createAsrPipeline,
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

  it('routes every model fetch to the loopback asset server (no external egress)', async () => {
    const t = fakeTransformers()
    await configureOffline(t, BASE)
    // v1.12.5: remote loading is ENABLED, but the host is the 127.0.0.1 asset
    // server, so transformers.js's component-existence probe resolves while
    // nothing can leave the box (the CSP also blocks huggingface.co).
    expect(t.env.allowRemoteModels).toBe(true)
    expect(t.env.remoteHost).toBe(BASE)
    expect(t.env.allowLocalModels).toBe(true)
    // remoteHost + remotePathTemplate + filename must resolve to the same
    // /models/<id>/<file> layout that localModelPath serves.
    expect(t.env.remotePathTemplate).toBe('models/{model}')
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
    expect(t.env.allowRemoteModels).toBe(true)
    expect(t.env.remoteHost).toBe(BASE)
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

  it('is actually wired into the Whisper pipeline builder', () => {
    // whisperWorker.ts runs a real Worker/WASM model and is coverage-excluded, so
    // assert its wiring as source text (same approach as downloadVoiceModelScript).
    // The pipeline build (incl. session_options) now lives in the unit-tested
    // createAsrPipeline; the worker must delegate to it so what we test is what
    // ships. createAsrPipeline's own use of VOICE_SESSION_OPTIONS is covered by
    // the behavioural test below.
    const worker = readFileSync(
      resolve(__dirname, '..', '..', 'src', 'renderer', 'src', 'lib', 'voice', 'whisperWorker.ts'),
      'utf8',
    )
    expect(worker).toContain('createAsrPipeline(')
    expect(worker).toContain("import { configureOffline, createAsrPipeline }")
  })
})

describe('createAsrPipeline', () => {
  // configureOffline fixes the v1.12.5 transformers.js 4.x existence-probe bug
  // (it repointed the hub at the loopback asset server), so pipeline() once again
  // loads the processor + tokenizer. createAsrPipeline wraps pipeline() with the
  // load-bearing session options and — as defense-in-depth against a future probe
  // regression — fails LOUD at load if either component is still missing, instead
  // of the cryptic "feature_extractor of null" that only surfaces on transcribe.
  const PROC = { feature_extractor: { config: { sampling_rate: 16000 } } }
  const TOK = { _decode_asr: () => ['', {}] }

  function fakeAsrTransformers(asr: Record<string, unknown>) {
    const calls = { pipeline: [] as any[] }
    return {
      __calls: calls,
      pipeline: async (task: string, model: string, opts: unknown) => {
        calls.pipeline.push({ task, model, opts })
        return asr
      },
    }
  }

  it('builds the ASR pipeline with the load-bearing dtype + session_options', async () => {
    const t = fakeAsrTransformers({ processor: PROC, tokenizer: TOK })
    const asr = await createAsrPipeline(t as any, 'whisper-base', 'wasm')
    expect(asr.processor).toBe(PROC)
    expect(asr.tokenizer).toBe(TOK)
    const call = t.__calls.pipeline[0]
    expect(call.task).toBe('automatic-speech-recognition')
    expect(call.model).toBe('whisper-base')
    expect(call.opts.device).toBe('wasm')
    expect(call.opts.dtype).toBe('q8')
    // The graphOptimizationLevel='basic' workaround MUST reach ORT (v1.12.4).
    expect(call.opts.session_options).toBe(VOICE_SESSION_OPTIONS)
  })

  it('fails LOUD (not a cryptic null deref) when the processor did not load', async () => {
    const t = fakeAsrTransformers({ processor: null, tokenizer: TOK })
    await expect(createAsrPipeline(t as any, 'whisper-base', 'wasm')).rejects.toThrow(
      /components failed to load.*processor=false/,
    )
  })

  it('fails LOUD when the tokenizer did not load', async () => {
    const t = fakeAsrTransformers({ processor: PROC, tokenizer: null })
    await expect(createAsrPipeline(t as any, 'whisper-base', 'wasm')).rejects.toThrow(/tokenizer=false/)
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
