// Whisper ASR Web Worker (Transformers.js / onnxruntime-web). Runs OFF the main
// thread so inference never freezes the UI (the lesson from the memory-brain
// in-process-embedding freeze). Tries WebGPU, falls back to WASM on failure.
//
// NOTE: requires a real browser/Electron runtime + the ONNX model; it is not
// exercised by the headless unit suite (which injects a fake worker). Behaviour
// here is covered by manual/e2e smoke testing.
/* eslint-disable @typescript-eslint/no-explicit-any */

const ctx: any = self as any
let asr: any = null

async function load(model: string, device: string): Promise<void> {
  const transformers: any = await import('@huggingface/transformers')
  try {
    asr = await transformers.pipeline('automatic-speech-recognition', model, {
      device,
      dtype: device === 'webgpu' ? 'fp16' : 'q8',
    })
    ctx.postMessage({ type: 'ready', device })
  } catch (e) {
    // WebGPU can fail (driver / dtype / decoder gibberish) — fall back to WASM once.
    if (device === 'webgpu') {
      await load(model, 'wasm')
      return
    }
    ctx.postMessage({ type: 'load-error', error: String(e) })
  }
}

ctx.onmessage = async (ev: any): Promise<void> => {
  const msg = ev?.data
  if (msg?.type === 'load') {
    await load(msg.model, msg.device || 'webgpu')
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
      ctx.postMessage({ type: 'error', id: msg.id, error: String(e) })
    }
  }
}

export {}
