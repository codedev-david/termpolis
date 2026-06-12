import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Guards scripts/download-voice-model.sh — the CI build step that bundles the
// onnxruntime-web wasm runtime for offline voice. v1.12.0-v1.12.2 shipped broken
// voice because this script cherry-picked just two `.wasm` files and copied ZERO
// `.mjs` loader modules, so at runtime ORT's dynamic import of
// ort-wasm-simd-threaded.asyncify.mjs 404'd ("no available backend found").
// These tests pin the fix: copy the COMPLETE family (both extensions) so the set
// can never drift from what onnxruntime-web's loader requests.

const SCRIPT = readFileSync(
  resolve(__dirname, '..', '..', 'scripts', 'download-voice-model.sh'),
  'utf8',
)

describe('download-voice-model.sh — ORT runtime copy', () => {
  it('copies the COMPLETE ort-wasm-simd-threaded family via glob, not a curated subset', () => {
    expect(SCRIPT).toMatch(/ort-wasm-simd-threaded\.\*/)
  })

  it('no longer hard-codes copying ONLY the jsep .wasm (the v1.12.2 partial bundle)', () => {
    // The old script ran exactly: cp ".../ort-wasm-simd-threaded.jsep.wasm" "$RT/"
    // and nothing for the .mjs loaders. That cherry-pick must be gone.
    expect(SCRIPT).not.toMatch(/cp\s+"\$ORT_DIST\/ort-wasm-simd-threaded\.jsep\.wasm"/)
  })

  it('fails the build if the asyncify .mjs loader + .wasm the renderer imports did not land', () => {
    expect(SCRIPT).toContain('ort-wasm-simd-threaded.asyncify.mjs')
    expect(SCRIPT).toContain('ort-wasm-simd-threaded.asyncify.wasm')
  })

  it('aborts if onnxruntime-web shipped no wasm runtime files at all', () => {
    // A correct fix copies whatever ort-wasm-simd-threaded.* exists, but must
    // hard-fail (not silently ship voice-less) if the glob matched nothing.
    expect(SCRIPT).toMatch(/exit 1/)
    expect(SCRIPT.toLowerCase()).toMatch(/no .*ort-wasm.* (files|runtime)|nullglob/)
  })

  it('still bundles the whisper-base model weights', () => {
    expect(SCRIPT).toContain('encoder_model_quantized.onnx')
    expect(SCRIPT).toContain('decoder_model_merged_quantized.onnx')
  })
})
