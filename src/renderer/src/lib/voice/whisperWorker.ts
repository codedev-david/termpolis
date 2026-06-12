// Whisper ASR Web Worker (Transformers.js / onnxruntime-web WASM). Runs OFF the
// main thread so inference never freezes the UI (the lesson from the memory-brain
// in-process-embedding freeze).
//
// Loads a LOCALLY-BUNDLED model (whisper-base q8) + version-matched ORT wasm,
// both served over localhost by the main process (see voiceAssetServer.ts).
// Fully offline: env.allowRemoteModels=false means it NEVER touches the network,
// so the app's strict CSP (no huggingface.co) is respected and audio/transcripts
// never leave the box. The wasm CPU backend needs no GPU/driver and no
// cross-origin isolation.
//
// NOTE: requires a real browser/Electron runtime; the headless unit suite injects
// a fake worker. The load/transcribe message protocol is exercised by the engine
// unit tests; real transcription is covered by manual/e2e smoke.
/* eslint-disable @typescript-eslint/no-explicit-any */

const ctx: any = self as any
let asr: any = null

function errStr(e: unknown): string {
  if (e instanceof Error) return e.message || String(e)
  return String(e)
}

// Point Transformers.js at the bundled model + ORT wasm on the localhost asset
// server, and forbid any network fetch.
async function configureOffline(transformers: any, assetBase: string): Promise<void> {
  const env = transformers.env
  env.allowRemoteModels = false
  env.allowLocalModels = true
  // assetBase = "http://127.0.0.1:<port>"; → fetches /models/<id>/config.json etc.
  env.localModelPath = `${assetBase}/models/`
  const wasm = env.backends?.onnx?.wasm
  if (wasm) {
    // Without this, ORT would fetch its wasm from a jsdelivr CDN — blocked by CSP.
    wasm.wasmPaths = `${assetBase}/voice-runtime/ort/`
    // No SharedArrayBuffer (renderer isn't cross-origin isolated) → single thread.
    wasm.numThreads = 1
    wasm.proxy = false
  }
}

async function load(model: string, device: string, assetBase: string): Promise<void> {
  if (!assetBase) {
    ctx.postMessage({ type: 'load-error', error: 'voice asset server unavailable (no base URL from main process)' })
    return
  }
  // The dynamic import is INSIDE the try so a missing/broken module reports a
  // load-error instead of rejecting silently and leaving the engine hung forever.
  try {
    const transformers: any = await import('@huggingface/transformers')
    await configureOffline(transformers, assetBase)
    asr = await transformers.pipeline('automatic-speech-recognition', model, { device, dtype: 'q8' })
    ctx.postMessage({ type: 'ready', device })
  } catch (e) {
    ctx.postMessage({ type: 'load-error', error: `model load failed (${model} @ ${assetBase}): ${errStr(e)}` })
  }
}

ctx.onmessage = async (ev: any): Promise<void> => {
  const msg = ev?.data
  if (msg?.type === 'load') {
    await load(msg.model, msg.device || 'wasm', msg.assetBase || '')
    return
  }
  if (msg?.type === 'transcribe') {
    if (!asr) {
      ctx.postMessage({ type: 'error', id: msg.id, error: 'model not loaded' })
      return
    }
    try {
      const out = await asr(msg.pcm, { return_timestamps: false })
      const text = Array.isArray(out) ? out.map((o: any) => o.text).join(' ') : (out?.text ?? '')
      ctx.postMessage({ type: 'result', id: msg.id, text: String(text).trim() })
    } catch (e) {
      ctx.postMessage({ type: 'error', id: msg.id, error: errStr(e) })
    }
  }
}

export {}
