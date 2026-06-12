// Whisper ASR Web Worker (Transformers.js / onnxruntime-web WASM). Runs OFF the
// main thread so inference never freezes the UI (the lesson from the memory-brain
// in-process-embedding freeze).
//
// Loads a LOCALLY-BUNDLED model (whisper-base q8) + version-matched ORT wasm,
// both served over localhost by the main process (see voiceAssetServer.ts).
// Fully offline: configureOffline points BOTH the local and "remote" hub at the
// 127.0.0.1 asset server (the remoteHost trick that fixes the v1.12.5 component
// probe — see voiceWorkerConfig.ts), so every fetch is loopback and the app's
// strict CSP (no huggingface.co) is respected — audio/transcripts never leave the
// box. The wasm CPU backend needs no GPU/driver and no cross-origin isolation.
//
// NOTE: requires a real browser/Electron runtime; the headless unit suite injects
// a fake worker. The load/transcribe message protocol is exercised by the engine
// unit tests; real transcription is covered by manual/e2e smoke.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { configureOffline, createAsrPipeline } from './voiceWorkerConfig'

const ctx: any = self as any
let asr: any = null

function errStr(e: unknown): string {
  if (e instanceof Error) return e.message || String(e)
  return String(e)
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
    // createAsrPipeline builds the pipeline with the load-bearing
    // graphOptimizationLevel='basic' session option AND repairs the
    // transformers.js 4.x null-processor/tokenizer bug (the probe wrongly treats
    // our http-served offline model as missing → "feature_extractor of null" on
    // first transcribe). See voiceWorkerConfig.ts for the full root cause.
    asr = await createAsrPipeline(transformers, model, device)
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
