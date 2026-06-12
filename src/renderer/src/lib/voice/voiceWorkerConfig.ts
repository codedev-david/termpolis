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

/** URL path for the bundled onnxruntime-web wasm runtime (.mjs loaders + .wasm). */
export const VOICE_ORT_URL_PATH = '/voice-runtime/ort/'

/**
 * Point Transformers.js at the bundled model + ORT wasm on the localhost asset
 * server (`assetBase` = "http://127.0.0.1:<port>"), and forbid any network fetch.
 * Tolerates a missing wasm backend object (older/odd builds) without throwing.
 */
export async function configureOffline(transformers: any, assetBase: string): Promise<void> {
  const env = transformers.env
  env.allowRemoteModels = false
  env.allowLocalModels = true
  // → fetches /models/<id>/config.json, onnx weights, tokenizer, etc.
  env.localModelPath = `${assetBase}${VOICE_MODELS_URL_PATH}`
  const wasm = env.backends?.onnx?.wasm
  if (wasm) {
    // Without this, ORT would fetch its wasm from a jsdelivr CDN — blocked by CSP.
    wasm.wasmPaths = `${assetBase}${VOICE_ORT_URL_PATH}`
    // No SharedArrayBuffer (renderer isn't cross-origin isolated) → single thread.
    wasm.numThreads = 1
    wasm.proxy = false
  }
}
