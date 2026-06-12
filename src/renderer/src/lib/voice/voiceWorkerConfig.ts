// Offline configuration for the Whisper ASR worker's Transformers.js /
// onnxruntime-web runtime. Extracted from whisperWorker.ts so the load-bearing
// contract — point BOTH the model and the ORT wasm at the localhost asset server
// and forbid every network fetch — is unit-testable. (whisperWorker.ts itself
// imports a real Worker/WASM model, can't run in jsdom, and is coverage-excluded;
// this logic used to live there and was therefore never tested.)
//
// THE BUG THIS GUARDS: onnxruntime-web does NOT bundle its wasm backend into the
// worker JS. It DYNAMICALLY imports a loader module for the backend variant it
// selects at runtime — for our config (device 'wasm', single-thread, no proxy)
// that is `ort-wasm-simd-threaded.asyncify.mjs` — from `wasm.wasmPaths`. If that
// URL is wrong or the file is missing, ORT fails with "no available backend found
// / Failed to fetch dynamically imported module" and the model never loads. So
// wasmPaths MUST resolve under the asset server's served prefix, and the asset
// server MUST actually have the complete ORT runtime family on disk.
/* eslint-disable @typescript-eslint/no-explicit-any */

/** URL path (under the localhost asset server) for the bundled Whisper model. */
export const VOICE_MODELS_URL_PATH = '/models/'

/**
 * Decode options passed to the ASR pipeline for one utterance.
 *
 * English-only Whisper exports (id ends in `.en`) carry NO language/task tokens,
 * so we pass none — the bare call is correct (and what we ship: whisper-base.en).
 * A MULTILINGUAL model (e.g. plain `whisper-base`) MUST have language+task pinned
 * or Whisper auto-detects the language every clip and, on marginal/quiet audio,
 * mis-detects and emits non-English or hallucinated text. This keeps the worker
 * correct for whichever model is loaded. `return_timestamps:false` returns plain
 * text (we don't surface word timings).
 */
export function buildTranscribeOptions(modelId: string): Record<string, unknown> {
  const opts: Record<string, unknown> = { return_timestamps: false }
  if (!/\.en$/i.test(modelId || '')) {
    opts.language = 'en'
    opts.task = 'transcribe'
  }
  return opts
}

/** URL path for the bundled onnxruntime-web wasm runtime (.mjs loaders + .wasm). */
export const VOICE_ORT_URL_PATH = '/voice-runtime/ort/'

/**
 * ONNX InferenceSession options for the Whisper encoder + (merged) decoder.
 *
 * THE BUG THIS GUARDS (v1.12.3 → v1.12.4): with default graph optimization,
 * onnxruntime-web's EXTENDED-level fusion `TransposeDQWeightsForMatMulNBits`
 * (qdq_actions.cc) crashes loading Xenova/whisper-base's q8 *merged* decoder:
 *   "Can't create a session ... Missing required scale:
 *    model.decoder.embed_tokens.weight_merged_0_scale for node
 *    model.decoder.embed_tokens.weight_transposed_DequantizeLinear"
 * The merged-decoder export is missing the scale initializer that fusion needs.
 *
 * Reproduced in headless Chromium against the EXACT shipped onnxruntime-web
 * (1.26.0-dev.20260416) and the bundled model. Empirical level → outcome:
 *   default('all') → CRASH · 'extended' → CRASH · 'basic' → OK · 'disabled' → OK
 * So the fusion is an extended (Level-2) optimization. We pick 'basic': it keeps
 * Level-1 opts (constant folding, basic int8 handling) while never running the
 * broken fusion. transformers.js spreads `session_options` straight into
 * `InferenceSession.create` (backends/onnx.js), so this reaches ORT verbatim.
 *
 * If onnxruntime-web is ever bumped, re-run `npm run voice:verify` — if default
 * stops crashing, this workaround can be dropped.
 */
export const VOICE_SESSION_OPTIONS = { graphOptimizationLevel: 'basic' } as const

/**
 * Point Transformers.js at the bundled model + ORT wasm on the localhost asset
 * server (`assetBase` = "http://127.0.0.1:<port>") so dictation is fully offline.
 * Tolerates a missing wasm backend object (older/odd builds) without throwing.
 *
 * THE BUG THIS GUARDS (v1.12.5): transformers.js 4.x runs a pre-flight existence
 * probe (`get_pipeline_files`/`loadTokenizer` → `get_file_metadata`) to decide
 * whether to load the tokenizer/processor. That probe only does a LOCAL check
 * when the path is NOT an http URL, and only a REMOTE check when
 * `allowRemoteModels` is true. The previous config — an http `localModelPath`
 * with `allowRemoteModels=false` — satisfies NEITHER branch, so the probe reports
 * `preprocessor_config.json` / `tokenizer.json` as missing, `pipeline()` leaves
 * `processor`/`tokenizer` null, construction still succeeds (worker posts
 * 'ready'), and the first transcribe throws
 *   "Cannot read properties of null (reading 'feature_extractor')".
 *
 * The fix: repoint the hub's "remote" host at the SAME loopback asset server and
 * enable remote loading. Now the probe's remote branch resolves
 * (http://127.0.0.1:<port>/models/<id>/<file> → 200 → exists), and the actual
 * loaders still fetch locally first. This is NOT an egress regression: every
 * resolved URL is loopback (127.0.0.1), and the app's strict CSP independently
 * blocks huggingface.co — so audio/transcripts still never leave the box.
 */
export async function configureOffline(transformers: any, assetBase: string): Promise<void> {
  const env = transformers.env
  env.allowLocalModels = true
  // → fetches /models/<id>/config.json, onnx weights, tokenizer, etc. locally.
  env.localModelPath = `${assetBase}${VOICE_MODELS_URL_PATH}`
  // Repoint "remote" at the loopback asset server (see doc above). remoteHost +
  // remotePathTemplate are joined with the filename, so this must resolve to the
  // same /models/<id>/<file> layout localModelPath serves.
  env.allowRemoteModels = true
  env.remoteHost = assetBase
  env.remotePathTemplate = `${VOICE_MODELS_URL_PATH.replace(/^\/|\/$/g, '')}/{model}`
  const wasm = env.backends?.onnx?.wasm
  if (wasm) {
    // Without this, ORT would fetch its wasm from a jsdelivr CDN — blocked by CSP.
    wasm.wasmPaths = `${assetBase}${VOICE_ORT_URL_PATH}`
    // No SharedArrayBuffer (renderer isn't cross-origin isolated) → single thread.
    wasm.numThreads = 1
    wasm.proxy = false
  }
}

/**
 * Build the Whisper ASR pipeline with the load-bearing offline session options,
 * and fail LOUD if the model's processor/tokenizer didn't load.
 *
 * `configureOffline` already works around the transformers.js 4.x existence-probe
 * bug that used to leave `processor`/`tokenizer` null (see its doc). This guard is
 * defense-in-depth: if a future transformers/probe change ever regresses that,
 * surface a clear load-time error here instead of the cryptic
 *   "Cannot read properties of null (reading 'feature_extractor')"
 * that only appears on the first transcribe. The worker's load() try/catch turns
 * this into a "model load failed (…)" message the user can actually act on, and
 * `npm run voice:verify-pipeline` catches it in CI before it ever ships.
 */
export async function createAsrPipeline(transformers: any, model: string, device: string): Promise<any> {
  // session_options.graphOptimizationLevel='basic' is LOAD-BEARING (see
  // VOICE_SESSION_OPTIONS): default/'extended' optimization crashes on the q8
  // merged decoder. transformers.js forwards it to InferenceSession.create.
  const asr = await transformers.pipeline('automatic-speech-recognition', model, {
    device,
    dtype: 'q8',
    session_options: VOICE_SESSION_OPTIONS,
  })
  if (!asr || !asr.processor || !asr.tokenizer) {
    throw new Error(
      `voice model components failed to load (processor=${!!asr?.processor}, ` +
        `tokenizer=${!!asr?.tokenizer}) — offline hub/probe config issue`,
    )
  }
  return asr
}
