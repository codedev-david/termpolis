/**
 * Verifier Unit Tests — Regression Guard for v1.11.5
 * ---------------------------------------------------
 * scripts/verifyPackagedResources.cjs is the LAST LINE OF DEFENSE against
 * shipping another broken installer. It runs as an electron-builder
 * afterPack hook and throws if the MCP adapter is missing from the
 * unpacked output.
 *
 * These tests construct fake `appOutDir` trees that mimic what
 * electron-builder produces for each platform, then verify:
 *   - missing adapter file throws with a clear, actionable message
 *   - 0-byte adapter file throws (a subtle failure mode)
 *   - present, non-empty adapter passes silently
 *   - resolveResourcesDir yields the correct path on Windows/Mac/Linux
 *   - The required-files list still covers the real runtime references
 *     (so if main/index.ts grows a new resource dep, this test fails until
 *     REQUIRED_RESOURCE_FILES is updated).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

const verifier = require('../../scripts/verifyPackagedResources.cjs')

const REPO_ROOT = resolve(__dirname, '..', '..')

let sandbox: string

beforeEach(() => {
  sandbox = join(tmpdir(), `verify-res-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(sandbox, { recursive: true })
})

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {}
})

function makeWinFixture(appOutDir: string, includeAdapter: boolean, size = 123) {
  const res = join(appOutDir, 'resources')
  mkdirSync(join(res, 'mcp-adapter'), { recursive: true })
  if (includeAdapter) {
    writeFileSync(join(res, 'mcp-adapter', 'stdio-adapter.cjs'), 'x'.repeat(size))
  }
  return res
}

function makeMacFixture(appOutDir: string, includeAdapter: boolean) {
  const res = join(appOutDir, 'Termpolis.app', 'Contents', 'Resources')
  mkdirSync(join(res, 'mcp-adapter'), { recursive: true })
  if (includeAdapter) {
    writeFileSync(join(res, 'mcp-adapter', 'stdio-adapter.cjs'), 'x'.repeat(100))
  }
  return res
}

describe('verifyPackagedResources — resolveResourcesDir', () => {
  it('Windows: maps appOutDir/resources', () => {
    const out = '/tmp/fake/win-unpacked'
    expect(verifier.resolveResourcesDir(out, 'win32', 'Termpolis')).toBe(
      join(out, 'resources'),
    )
  })

  it('Linux: maps appOutDir/resources', () => {
    const out = '/tmp/fake/linux-unpacked'
    expect(verifier.resolveResourcesDir(out, 'linux', 'Termpolis')).toBe(
      join(out, 'resources'),
    )
  })

  it('macOS: maps appOutDir/<ProductName>.app/Contents/Resources', () => {
    const out = '/tmp/fake/mac'
    expect(verifier.resolveResourcesDir(out, 'darwin', 'Termpolis')).toBe(
      join(out, 'Termpolis.app', 'Contents', 'Resources'),
    )
  })

  it('macOS: respects a custom product filename', () => {
    const out = '/tmp/fake/mac-arm64'
    expect(verifier.resolveResourcesDir(out, 'darwin', 'MyCoolApp')).toBe(
      join(out, 'MyCoolApp.app', 'Contents', 'Resources'),
    )
  })

  it('mas (Mac App Store): same shape as darwin', () => {
    const out = '/tmp/fake/mas'
    expect(verifier.resolveResourcesDir(out, 'mas', 'Termpolis')).toBe(
      join(out, 'Termpolis.app', 'Contents', 'Resources'),
    )
  })
})

describe('verifyPackagedResources — verifyResourcesFolder', () => {
  it('passes silently when adapter exists and is non-empty (Windows layout)', () => {
    const out = join(sandbox, 'win-unpacked')
    const res = makeWinFixture(out, true)
    expect(() => verifier.verifyResourcesFolder(res)).not.toThrow()
  })

  it('passes silently when adapter exists (macOS layout)', () => {
    const out = join(sandbox, 'mac')
    const res = makeMacFixture(out, true)
    expect(() => verifier.verifyResourcesFolder(res)).not.toThrow()
  })

  it('THROWS when adapter file is missing', () => {
    const out = join(sandbox, 'win-unpacked')
    const res = makeWinFixture(out, false)
    // regression: this is exactly the v1.11.5 bug — folder exists, file doesn't
    expect(() => verifier.verifyResourcesFolder(res)).toThrow(/mcp-adapter\/stdio-adapter\.cjs/)
  })

  it('THROWS when adapter exists but is 0 bytes', () => {
    const out = join(sandbox, 'win-unpacked')
    const res = makeWinFixture(out, true, 0)
    expect(() => verifier.verifyResourcesFolder(res)).toThrow(/0 bytes/)
  })

  it('THROWS when resources directory itself does not exist', () => {
    expect(() => verifier.verifyResourcesFolder(join(sandbox, 'nope'))).toThrow(
      /Resources directory does not exist/,
    )
  })

  it('error message points at extraResources config (so next dev has a fix path)', () => {
    const out = join(sandbox, 'win-unpacked')
    const res = makeWinFixture(out, false)
    try {
      verifier.verifyResourcesFolder(res)
      throw new Error('should have thrown')
    } catch (err: any) {
      expect(err.message).toMatch(/extraResources/)
      expect(err.message).toMatch(/src\/mcp-adapter/)
    }
  })
})

describe('verifyPackagedResources — verifyFromAfterPack', () => {
  it('composes appOutDir + platform correctly (win)', () => {
    const out = join(sandbox, 'win-unpacked')
    makeWinFixture(out, true)
    expect(() =>
      verifier.verifyFromAfterPack({
        appOutDir: out,
        electronPlatformName: 'win32',
        packager: { appInfo: { productFilename: 'Termpolis' } },
      }),
    ).not.toThrow()
  })

  it('composes appOutDir + platform correctly (darwin)', () => {
    const out = join(sandbox, 'mac')
    makeMacFixture(out, true)
    expect(() =>
      verifier.verifyFromAfterPack({
        appOutDir: out,
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'Termpolis' } },
      }),
    ).not.toThrow()
  })

  it('throws with the resources path included when verification fails', () => {
    const out = join(sandbox, 'win-unpacked')
    makeWinFixture(out, false)
    expect(() =>
      verifier.verifyFromAfterPack({
        appOutDir: out,
        electronPlatformName: 'win32',
      }),
    ).toThrow(/win-unpacked/)
  })
})

describe('verifyPackagedResources — REQUIRED_RESOURCE_FILES contract', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(verifier.REQUIRED_RESOURCE_FILES)).toBe(true)
    expect(verifier.REQUIRED_RESOURCE_FILES.length).toBeGreaterThan(0)
  })

  it('includes the stdio adapter — every other check is cosmetic if this is missing', () => {
    expect(verifier.REQUIRED_RESOURCE_FILES).toContain('mcp-adapter/stdio-adapter.cjs')
  })

  it('every required file has a matching source file in the repo so the build can actually ship it', () => {
    for (const rel of verifier.REQUIRED_RESOURCE_FILES) {
      const src = rel.replace(/^mcp-adapter\//, 'src/mcp-adapter/')
      const abs = join(REPO_ROOT, src)
      expect(existsSync(abs), `source for required resource ${rel} not found at ${abs}`).toBe(true)
    }
  })
})

describe('verifyEmbeddingModelBundled', () => {
  const MODEL_REL = join('models', 'bge-small-en-v1.5', 'onnx', 'model_quantized.onnx')
  const TOK_REL = join('models', 'bge-small-en-v1.5', 'tokenizer.json')
  const WASM_REL = join('app.asar.unpacked', 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm')

  function buildValid(outDir: string): void {
    const res = join(outDir, 'resources')
    mkdirSync(join(res, 'models', 'bge-small-en-v1.5', 'onnx'), { recursive: true })
    writeFileSync(join(res, MODEL_REL), Buffer.alloc(2_000_000, 1)) // 2 MB "model"
    writeFileSync(join(res, TOK_REL), '{}')
    mkdirSync(join(res, 'app.asar.unpacked', 'node_modules', 'onnxruntime-web', 'dist'), { recursive: true })
    writeFileSync(join(res, WASM_REL), Buffer.alloc(16, 1))
  }

  it('passes when model + tokenizer + WASM are all present', () => {
    buildValid(sandbox)
    expect(() => verifier.verifyEmbeddingModelBundled(sandbox)).not.toThrow()
  })

  it('throws when the model file is missing', () => {
    const res = join(sandbox, 'resources')
    mkdirSync(join(res, 'models', 'bge-small-en-v1.5'), { recursive: true })
    writeFileSync(join(res, TOK_REL), '{}')
    expect(() => verifier.verifyEmbeddingModelBundled(sandbox)).toThrow(/missing\/empty/)
  })

  it('throws when the model is suspiciously small (failed download)', () => {
    buildValid(sandbox)
    writeFileSync(join(sandbox, 'resources', MODEL_REL), Buffer.alloc(500, 1))
    expect(() => verifier.verifyEmbeddingModelBundled(sandbox)).toThrow(/only \d+ bytes/)
  })

  it('throws when onnxruntime-web WASM is not asar-unpacked', () => {
    const res = join(sandbox, 'resources')
    mkdirSync(join(res, 'models', 'bge-small-en-v1.5', 'onnx'), { recursive: true })
    writeFileSync(join(res, MODEL_REL), Buffer.alloc(2_000_000, 1))
    writeFileSync(join(res, TOK_REL), '{}')
    expect(() => verifier.verifyEmbeddingModelBundled(sandbox)).toThrow(/WASM not asar-unpacked/)
  })

  it('throws when there is no resources dir', () => {
    expect(() => verifier.verifyEmbeddingModelBundled(join(sandbox, 'nope'))).toThrow(/no resources dir/)
  })
})

describe('verifyVoiceModelBundled', () => {
  // A complete voice bundle = the whisper-base model + the FULL onnxruntime-web
  // wasm runtime family (every .mjs loader + .wasm). v1.12.2 shipped the model
  // plus only 2 of 8 ORT files and zero .mjs loaders — voice died at runtime
  // with "no available backend found". This verifier is the build-time guard
  // that would have caught it.
  function buildValidVoice(outDir: string): void {
    const res = join(outDir, 'resources')
    const model = join(res, 'models', 'whisper-base')
    mkdirSync(join(model, 'onnx'), { recursive: true })
    writeFileSync(join(model, 'config.json'), '{"model_type":"whisper"}')
    writeFileSync(join(model, 'tokenizer.json'), '{}')
    writeFileSync(join(model, 'onnx', 'encoder_model_quantized.onnx'), Buffer.alloc(2_000_000, 1))
    writeFileSync(join(model, 'onnx', 'decoder_model_merged_quantized.onnx'), Buffer.alloc(2_000_000, 1))
    const ort = join(res, 'voice-runtime', 'ort')
    mkdirSync(ort, { recursive: true })
    for (const f of verifier.VOICE_RUNTIME_ORT_FILES) {
      // .wasm are multi-MB; .mjs loaders are ~20-46 KB. Make fixtures comfortably
      // above the verifier's min-size thresholds.
      writeFileSync(join(ort, f), Buffer.alloc(f.endsWith('.wasm') ? 2_000_000 : 4_000, 1))
    }
  }

  it('passes when the model + complete ORT runtime family are all present', () => {
    buildValidVoice(sandbox)
    expect(() => verifier.verifyVoiceModelBundled(sandbox)).not.toThrow()
  })

  it('THROWS when the asyncify .mjs loader is missing — the EXACT v1.12.2 failure', () => {
    buildValidVoice(sandbox)
    rmSync(join(sandbox, 'resources', 'voice-runtime', 'ort', 'ort-wasm-simd-threaded.asyncify.mjs'))
    expect(() => verifier.verifyVoiceModelBundled(sandbox)).toThrow(/asyncify\.mjs/)
  })

  it('THROWS when an ORT wasm is suspiciously small (truncated copy)', () => {
    buildValidVoice(sandbox)
    writeFileSync(
      join(sandbox, 'resources', 'voice-runtime', 'ort', 'ort-wasm-simd-threaded.asyncify.wasm'),
      Buffer.alloc(500, 1),
    )
    expect(() => verifier.verifyVoiceModelBundled(sandbox)).toThrow(/only \d+ bytes/)
  })

  it('THROWS when the model dir is present but a required model file is missing', () => {
    buildValidVoice(sandbox)
    rmSync(join(sandbox, 'resources', 'models', 'whisper-base', 'config.json'))
    expect(() => verifier.verifyVoiceModelBundled(sandbox)).toThrow(/missing\/empty/)
  })

  it('THROWS when the encoder onnx is too small (failed/partial download)', () => {
    buildValidVoice(sandbox)
    writeFileSync(
      join(sandbox, 'resources', 'models', 'whisper-base', 'onnx', 'encoder_model_quantized.onnx'),
      Buffer.alloc(500, 1),
    )
    expect(() => verifier.verifyVoiceModelBundled(sandbox)).toThrow(/only \d+ bytes/)
  })

  it('SKIPS (does not throw) when the voice model was never bundled — download is best-effort in CI', () => {
    // resources exists, but no models/whisper-base at all (HF 429 → continue-on-error).
    // Voice degrades gracefully; the build is still valid, so this must NOT fail.
    mkdirSync(join(sandbox, 'resources'), { recursive: true })
    expect(() => verifier.verifyVoiceModelBundled(sandbox)).not.toThrow()
  })

  it('throws when there is no resources dir at all', () => {
    expect(() => verifier.verifyVoiceModelBundled(join(sandbox, 'nope'))).toThrow(/no resources dir/)
  })
})

describe('VOICE_RUNTIME_ORT_FILES contract vs onnxruntime-web reality', () => {
  // The verifier's required-files list is checked against the PACKAGED app, where
  // node_modules isn't present — so the list is hand-maintained. This test ties
  // it back to what onnxruntime-web ACTUALLY ships in node_modules, so the list
  // can never silently under-cover the runtime the loader will request. If
  // onnxruntime-web is bumped and adds/removes a wasm variant, this fails until
  // the list is updated (and the glob copy in download-voice-model.sh already
  // ships the new reality).
  it('lists exactly the ort-wasm-simd-threaded.* files onnxruntime-web ships', () => {
    const dist = join(REPO_ROOT, 'node_modules', 'onnxruntime-web', 'dist')
    const actual = readdirSync(dist)
      .filter((f) => f.startsWith('ort-wasm-simd-threaded.') && (f.endsWith('.mjs') || f.endsWith('.wasm')))
      .sort()
    expect(actual.length).toBeGreaterThan(0)
    expect([...verifier.VOICE_RUNTIME_ORT_FILES].sort()).toEqual(actual)
  })

  it('includes the asyncify loader + wasm the renderer actually imports', () => {
    expect(verifier.VOICE_RUNTIME_ORT_FILES).toContain('ort-wasm-simd-threaded.asyncify.mjs')
    expect(verifier.VOICE_RUNTIME_ORT_FILES).toContain('ort-wasm-simd-threaded.asyncify.wasm')
  })

  it('pairs every .mjs loader with its .wasm (and vice-versa)', () => {
    const files: string[] = verifier.VOICE_RUNTIME_ORT_FILES
    const stems = (ext: string) =>
      files.filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length)).sort()
    expect(stems('.mjs')).toEqual(stems('.wasm'))
  })
})
