/**
 * Packaged Resources Verifier
 * ---------------------------
 * Asserts that the electron-builder output contains every file the app
 * depends on at runtime. Today this is mostly the MCP stdio adapter —
 * but because v1.11.5 shipped a broken installer (the adapter was
 * missing, the swarm silently failed with zero user-visible errors),
 * we want a hard fail-fast guard that runs on EVERY build.
 *
 * This module is consumed two ways:
 *   1. electron-builder `afterPack` hook (called once per platform
 *      inside scripts/afterPack.cjs). Throws to fail the build.
 *   2. Standalone CLI: `node scripts/verifyPackagedResources.cjs <dir>`
 *      Used by the CI `package-verify` job and for local spot-checks.
 *
 * It is also unit-tested directly in tests/electron/verifyPackagedResources.test.ts.
 */
const fs = require('fs')
const path = require('path')

/**
 * Files that MUST exist under `<resources>/` inside the packaged app.
 * Paths are relative to the platform-specific Resources folder.
 *
 * Runtime references:
 *   - main/index.ts resolves via `path.join(process.resourcesPath, 'mcp-adapter', 'stdio-adapter.cjs')`
 *   - stdio-adapter.cjs is what Claude Code spawns via ~/.mcp.json.
 *     If it's missing, the swarm conductor has no MCP tools and silently
 *     falls back to direct answering.
 */
const REQUIRED_RESOURCE_FILES = ['mcp-adapter/stdio-adapter.cjs']

// The bundled offline embedding model + its WASM runtime. Verified SEPARATELY
// (not in REQUIRED_RESOURCE_FILES) because a build without the model downloaded
// is still valid — the app degrades to keyword search. The package-verify CI
// job downloads the model first, then asserts it shipped.
const EMBEDDING_MODEL_REL = path.join('models', 'bge-small-en-v1.5', 'onnx', 'model_quantized.onnx')
const EMBEDDING_TOKENIZER_REL = path.join('models', 'bge-small-en-v1.5', 'tokenizer.json')

// The bundled offline VOICE model (whisper-base q8) + the onnxruntime-web wasm
// runtime that the renderer's Whisper worker fetches over the localhost asset
// server. Verified SEPARATELY (CI `--voice`), and only when present — a build
// without the voice model downloaded is still valid (voice degrades), same as
// the embedding model above.
const VOICE_MODEL_DIR_REL = path.join('models', 'whisper-base')
const VOICE_ENCODER_REL = path.join(VOICE_MODEL_DIR_REL, 'onnx', 'encoder_model_quantized.onnx')
const VOICE_DECODER_REL = path.join(VOICE_MODEL_DIR_REL, 'onnx', 'decoder_model_merged_quantized.onnx')
const VOICE_MODEL_FILES = [
  path.join(VOICE_MODEL_DIR_REL, 'config.json'),
  path.join(VOICE_MODEL_DIR_REL, 'tokenizer.json'),
  VOICE_ENCODER_REL,
  VOICE_DECODER_REL,
]
// onnxruntime-web ships its wasm backend as a .mjs loader + .wasm pair per
// variant. The renderer's ORT loader DYNAMICALLY imports the variant .mjs it
// selects at runtime (asyncify for our device='wasm', single-thread, no-proxy
// config) from `wasm.wasmPaths`. Shipping a SUBSET — which is exactly what
// v1.12.0-v1.12.2 did (2 of these .wasm, zero .mjs loaders) — makes that import
// 404 and the worker die with "no available backend found". So the COMPLETE
// family must ship. This list is pinned to onnxruntime-web reality by a unit test
// (tests/electron/verifyPackagedResources.test.ts) that reads node_modules.
const VOICE_RUNTIME_ORT_FILES = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jspi.mjs',
  'ort-wasm-simd-threaded.jspi.wasm',
]

/**
 * Resolve the platform-specific "Resources" directory that electron-builder
 * produces inside its unpacked output (e.g. `win-unpacked/resources`,
 * `mac/Termpolis.app/Contents/Resources`, `linux-unpacked/resources`).
 *
 * `appOutDir` is what electron-builder passes to afterPack hooks.
 * `electronPlatformName` is 'win32', 'darwin', or 'linux'.
 */
function resolveResourcesDir(appOutDir, electronPlatformName, productFilename) {
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    const appName = productFilename || 'Termpolis'
    return path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources')
  }
  // Windows + Linux both use <appOutDir>/resources
  return path.join(appOutDir, 'resources')
}

/**
 * Verify a single resources folder contains every required file.
 * Throws an Error with a descriptive message if any are missing.
 */
function verifyResourcesFolder(resourcesDir) {
  if (!fs.existsSync(resourcesDir)) {
    throw new Error(
      `[verifyPackagedResources] Resources directory does not exist: ${resourcesDir}\n` +
        `This means electron-builder did not produce the expected unpacked output — ` +
        `inspect the dist-electron-builder/ layout.`,
    )
  }

  const missing = []
  for (const rel of REQUIRED_RESOURCE_FILES) {
    const full = path.join(resourcesDir, rel)
    if (!fs.existsSync(full)) {
      missing.push(rel)
    } else {
      // extra sanity: file must be non-empty. A 0-byte stdio adapter would
      // be even more confusing than a missing one.
      const stat = fs.statSync(full)
      if (stat.size === 0) {
        missing.push(`${rel} (exists but is 0 bytes)`)
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `[verifyPackagedResources] FATAL: the packaged app is missing ${missing.length} ` +
        `required resource file(s) — the swarm conductor will silently fail at runtime.\n` +
        `Resources dir: ${resourcesDir}\n` +
        `Missing:\n  - ${missing.join('\n  - ')}\n\n` +
        `Likely cause: package.json "build.extraResources" is misconfigured. ` +
        `It MUST include { from: "src/mcp-adapter", to: "mcp-adapter", filter: ["**/*.cjs"] }.`,
    )
  }
}

/**
 * Main entrypoint for the electron-builder afterPack hook.
 * Throws if verification fails (which fails the build).
 */
function verifyFromAfterPack(context) {
  const resourcesDir = resolveResourcesDir(
    context.appOutDir,
    context.electronPlatformName,
    context.packager?.appInfo?.productFilename,
  )
  // eslint-disable-next-line no-console
  console.log(`[verifyPackagedResources] Checking: ${resourcesDir}`)
  verifyResourcesFolder(resourcesDir)
  // eslint-disable-next-line no-console
  console.log(
    `[verifyPackagedResources] OK — all ${REQUIRED_RESOURCE_FILES.length} required file(s) present`,
  )
}

/**
 * Standalone CLI entrypoint. Accepts one of:
 *   - an `appOutDir` (we infer platform from platform-specific subfolders)
 *   - a direct resources folder
 *
 * Used by CI and local spot-checks.
 */
function verifyFromCLI(target) {
  if (!target) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage: node scripts/verifyPackagedResources.cjs <appOutDir-or-resources-dir>\n' +
        '  e.g. node scripts/verifyPackagedResources.cjs dist-electron-builder/win-unpacked',
    )
    process.exit(2)
  }

  const abs = path.resolve(target)
  if (!fs.existsSync(abs)) {
    // eslint-disable-next-line no-console
    console.error(`[verifyPackagedResources] Path does not exist: ${abs}`)
    process.exit(2)
  }

  // Try the path as a resources dir directly; otherwise, try common subfolders.
  const candidates = [
    abs,
    path.join(abs, 'resources'),
    path.join(abs, 'Contents', 'Resources'),
    // look for a .app bundle inside abs
    ...safeListDir(abs)
      .filter((name) => name.endsWith('.app'))
      .map((name) => path.join(abs, name, 'Contents', 'Resources')),
  ]

  const triedWithErrors = []
  for (const cand of candidates) {
    if (fs.existsSync(path.join(cand, 'mcp-adapter'))) {
      try {
        verifyResourcesFolder(cand)
        // eslint-disable-next-line no-console
        console.log(`[verifyPackagedResources] OK — verified ${cand}`)
        return
      } catch (err) {
        triedWithErrors.push({ dir: cand, err: err.message })
      }
    }
  }

  // If we got here, either no candidate had a mcp-adapter/ folder, or the
  // one that did failed verification. Surface the most informative message.
  if (triedWithErrors.length > 0) {
    // At least one candidate had mcp-adapter/ but failed verification —
    // print that error directly (it already names the missing files).
    for (const { err } of triedWithErrors) {
      // eslint-disable-next-line no-console
      console.error(err)
    }
  } else {
    // eslint-disable-next-line no-console
    console.error(
      `[verifyPackagedResources] FATAL: could not find mcp-adapter/ under any candidate under ${abs}\n` +
        `Looked at:\n  - ${candidates.join('\n  - ')}`,
    )
  }
  process.exit(1)
}

function safeListDir(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Verify the bundled embedding model + onnxruntime-web WASM made it into the
 * packaged output, so semantic memory search works offline in shipped builds.
 * `appOutDir` is an electron-builder unpacked dir (e.g. linux-unpacked).
 * Throws on any problem. Used by the package-verify CI job after the model
 * download step.
 */
function verifyEmbeddingModelBundled(appOutDir) {
  const resourcesDir = [
    path.join(appOutDir, 'resources'),
    ...safeListDir(appOutDir)
      .filter((n) => n.endsWith('.app'))
      .map((n) => path.join(appOutDir, n, 'Contents', 'Resources')),
  ].find((d) => fs.existsSync(d))
  if (!resourcesDir) {
    throw new Error(`[verifyPackagedResources] no resources dir under ${appOutDir}`)
  }

  for (const rel of [EMBEDDING_MODEL_REL, EMBEDDING_TOKENIZER_REL]) {
    const full = path.join(resourcesDir, rel)
    if (!fs.existsSync(full) || fs.statSync(full).size === 0) {
      throw new Error(`[verifyPackagedResources] FATAL: bundled embedding file missing/empty: ${full}`)
    }
  }

  const modelSize = fs.statSync(path.join(resourcesDir, EMBEDDING_MODEL_REL)).size
  if (modelSize < 1_000_000) {
    throw new Error(`[verifyPackagedResources] embedding model is only ${modelSize} bytes (download failed?)`)
  }

  const ortDist = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'onnxruntime-web', 'dist')
  if (!safeListDir(ortDist).some((f) => f.endsWith('.wasm'))) {
    throw new Error(`[verifyPackagedResources] onnxruntime-web WASM not asar-unpacked under ${ortDist}`)
  }

  // eslint-disable-next-line no-console
  console.log(
    `[verifyPackagedResources] OK — embedding model (${(modelSize / 1e6).toFixed(1)} MB) + onnxruntime-web WASM bundled`,
  )
}

/**
 * Verify the bundled VOICE model + the COMPLETE onnxruntime-web wasm runtime made
 * it into the packaged output, so local Whisper dictation works offline. The
 * voice download is best-effort in CI (continue-on-error on HF 429): if the model
 * was skipped entirely, this is a no-op (voice degrades, build still valid). But
 * if ANY of it shipped, the WHOLE set must be complete — that's what catches a
 * partial ORT runtime (the v1.12.2 bug: model present, .mjs loaders missing).
 * Throws on any problem. Used by the package-verify CI job (`--voice`).
 */
function verifyVoiceModelBundled(appOutDir) {
  const resourcesDir = [
    path.join(appOutDir, 'resources'),
    ...safeListDir(appOutDir)
      .filter((n) => n.endsWith('.app'))
      .map((n) => path.join(appOutDir, n, 'Contents', 'Resources')),
  ].find((d) => fs.existsSync(d))
  if (!resourcesDir) {
    throw new Error(`[verifyPackagedResources] no resources dir under ${appOutDir}`)
  }

  // Best-effort: nothing bundled at all → skip (do NOT fail the build).
  const modelDir = path.join(resourcesDir, VOICE_MODEL_DIR_REL)
  if (!fs.existsSync(modelDir)) {
    // eslint-disable-next-line no-console
    console.log(
      '[verifyPackagedResources] voice model not bundled (download skipped/failed) — skipping voice verification',
    )
    return
  }

  // Model present → the full model file set must be there and non-empty.
  for (const rel of VOICE_MODEL_FILES) {
    const full = path.join(resourcesDir, rel)
    if (!fs.existsSync(full) || fs.statSync(full).size === 0) {
      throw new Error(`[verifyPackagedResources] FATAL: bundled voice file missing/empty: ${full}`)
    }
  }
  // The onnx weights must be real multi-MB models, not truncated/HTML error pages.
  for (const rel of [VOICE_ENCODER_REL, VOICE_DECODER_REL]) {
    const size = fs.statSync(path.join(resourcesDir, rel)).size
    if (size < 1_000_000) {
      throw new Error(`[verifyPackagedResources] voice model file ${rel} is only ${size} bytes (download failed?)`)
    }
  }

  // The bit that broke: the COMPLETE ORT wasm runtime (every .mjs loader + .wasm).
  const ortDir = path.join(resourcesDir, 'voice-runtime', 'ort')
  for (const f of VOICE_RUNTIME_ORT_FILES) {
    const full = path.join(ortDir, f)
    if (!fs.existsSync(full)) {
      throw new Error(
        `[verifyPackagedResources] FATAL: ORT speech-runtime file missing: ${full}\n` +
          `onnxruntime-web dynamically imports this at runtime; without it the voice worker fails ` +
          `with "no available backend found / Failed to fetch dynamically imported module".\n` +
          `Fix: scripts/download-voice-model.sh must copy the COMPLETE ort-wasm-simd-threaded.* family.`,
      )
    }
    // .wasm are multi-MB; .mjs loaders are ~20-46 KB. Catch truncated copies.
    const size = fs.statSync(full).size
    const min = f.endsWith('.wasm') ? 1_000_000 : 1_000
    if (size < min) {
      throw new Error(`[verifyPackagedResources] ORT speech-runtime file ${f} is only ${size} bytes (truncated copy?)`)
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[verifyPackagedResources] OK — voice model + complete ORT speech runtime (${VOICE_RUNTIME_ORT_FILES.length} files) bundled`,
  )
}

module.exports = {
  REQUIRED_RESOURCE_FILES,
  VOICE_MODEL_FILES,
  VOICE_RUNTIME_ORT_FILES,
  resolveResourcesDir,
  verifyResourcesFolder,
  verifyFromAfterPack,
  verifyEmbeddingModelBundled,
  verifyVoiceModelBundled,
}

// If invoked directly, run CLI mode. `--model <appOutDir>` verifies the bundled
// embedding model; `--voice <appOutDir>` verifies the bundled voice model + ORT
// speech runtime; otherwise verify the required resource files.
if (require.main === module) {
  try {
    if (process.argv[2] === '--model') {
      verifyEmbeddingModelBundled(process.argv[3])
    } else if (process.argv[2] === '--voice') {
      verifyVoiceModelBundled(process.argv[3])
    } else {
      verifyFromCLI(process.argv[2])
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err.message || err)
    process.exit(1)
  }
}
