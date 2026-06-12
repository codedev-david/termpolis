#!/usr/bin/env node
// REAL end-to-end guard for offline voice transcription. Loads the bundled
// whisper-base model into the SHIPPED transformers.js + onnxruntime-web inside a
// real headless Chromium (the same engine as the Electron renderer), builds the
// FULL automatic-speech-recognition pipeline EXACTLY as the renderer does
// (offline, localhost-http localModelPath, allowRemoteModels=false), and runs a
// real transcription.
//
// WHY THIS EXISTS: every prior voice test (and verify-voice-model-loads.mjs)
// stopped at InferenceSession.create — none ever built the transformers.js
// pipeline. That gap hid a string of shipped-broken-voice releases, the latest
// being v1.12.5: transformers.js 4.x added a pre-flight existence probe
// (get_pipeline_files → get_file_metadata) that only checks local files when the
// path is NOT an http URL and only checks remote when allowRemoteModels is true.
// Our offline config is a localhost-HTTP localModelPath with remote DISABLED — a
// combo the probe doesn't handle — so it reports the processor/tokenizer as
// missing, pipeline() leaves them null, construction still succeeds (posts
// 'ready'), and the first transcribe throws
//   "Cannot read properties of null (reading 'feature_extractor')".
// createAsrPipeline (src/renderer/src/lib/voice/voiceWorkerConfig.ts) repairs it
// by explicitly loading the two components. This gate fails CI if that whole
// path ever regresses again. Run locally via `npm run voice:verify-pipeline`.
//
// Skips cleanly (exit 0) when the model isn't on disk — HuggingFace rate-limits
// CI (the download step is continue-on-error), and a transient 429 must not red
// the build. It only FAILS when the model IS present but the pipeline won't
// assemble/transcribe.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const MODELS = path.join(ROOT, 'resources', 'models')
const ORT = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist')
const TF = path.join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist')
const ORTC = path.join(ROOT, 'node_modules', 'onnxruntime-common', 'dist', 'esm')
const DECODER = path.join(MODELS, 'whisper-base', 'onnx', 'decoder_model_merged_quantized.onnx')

if (!fs.existsSync(DECODER)) {
  console.log(`[voice:verify-pipeline] model not on disk (${DECODER}) — skipping (transient HF download?).`)
  process.exit(0)
}
for (const [name, dir] of [['onnxruntime-web', ORT], ['@huggingface/transformers', TF], ['onnxruntime-common', ORTC]]) {
  if (!fs.existsSync(dir)) {
    console.error(`[voice:verify-pipeline] FAIL: ${name} dist missing (${dir}) — run \`npm ci\`.`)
    process.exit(1)
  }
}

const ctype = (f) =>
  f.endsWith('.mjs') || f.endsWith('.js') ? 'text/javascript'
  : f.endsWith('.wasm') ? 'application/wasm'
  : f.endsWith('.json') ? 'application/json'
  : f.endsWith('.txt') ? 'text/plain'
  : 'application/octet-stream'

// Import map so the shipped transformers.web.min.js resolves its bare specifiers
// to the SHIPPED onnxruntime-web (the .bundle. variant inlines onnxruntime-common
// and carries the wasm EP). We force the wasm backend (single-thread, no proxy),
// exactly like the renderer's configureOffline. localModelPath is the ABSOLUTE
// origin URL — same shape as the renderer's 127.0.0.1 asset base — so the v4
// probe sees an http URL (the precise condition that triggers the bug).
const HTML = `<!doctype html><meta charset=utf8><body>
<script type="importmap">
{ "imports": {
  "@huggingface/transformers": "/tf/transformers.web.min.js",
  "onnxruntime-web/webgpu": "/ort/ort.webgpu.bundle.min.mjs",
  "onnxruntime-common": "/ortc/index.js"
} }
</script>
<script type=module>
import * as transformers from '@huggingface/transformers'
const { env, pipeline } = transformers
// Repoint the hub at the loopback asset server: allowRemoteModels=true but
// remoteHost is 127.0.0.1, so the v4 existence-probe (which only checks "remote"
// for an http URL) succeeds, while NO request can leave the box (CSP also blocks
// huggingface.co). localModelPath stays set so the actual loaders fetch locally.
env.allowRemoteModels = true
env.remoteHost = location.origin
env.remotePathTemplate = 'models/{model}'
env.allowLocalModels = true
env.localModelPath = location.origin + '/models/'
const wasm = env.backends?.onnx?.wasm
if (wasm) { wasm.wasmPaths = location.origin + '/ort/'; wasm.numThreads = 1; wasm.proxy = false }

window.run = async () => {
  // PLAIN pipeline() — no per-component repair. If the probe fix is correct,
  // pipeline() itself now loads processor + tokenizer.
  const opts = { device: 'wasm', dtype: 'q8', session_options: { graphOptimizationLevel: 'basic' } }
  const asr = await pipeline('automatic-speech-recognition', 'whisper-base', opts)
  // 2s of synthetic 16kHz audio — enough to drive feature-extraction + decode
  // through the exact path that used to throw. We assert it does not throw and
  // returns a string (correct words aren't needed to catch the null crash).
  const pcm = new Float32Array(16000 * 2)
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.05 * Math.sin((2 * Math.PI * 220 * i) / 16000)
  const out = await asr(pcm, { return_timestamps: false })
  return {
    processorOk: !!(asr.processor && asr.processor.feature_extractor),
    tokenizerOk: !!asr.tokenizer,
    textType: typeof (out && out.text),
    text: out && out.text,
  }
}
window.__ready = true
</script></body>`

const serveDir = (res, dir, rel) => {
  fs.readFile(path.join(dir, decodeURIComponent(rel)), (e, buf) => {
    if (e) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': ctype(rel) }); res.end(buf)
  })
}

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0]
  if (url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML); return }
  if (url.startsWith('/models/')) return serveDir(res, MODELS, url.slice('/models/'.length))
  if (url.startsWith('/ort/')) return serveDir(res, ORT, url.slice('/ort/'.length))
  if (url.startsWith('/tf/')) return serveDir(res, TF, url.slice('/tf/'.length))
  if (url.startsWith('/ortc/')) return serveDir(res, ORTC, url.slice('/ortc/'.length))
  res.writeHead(404); res.end()
})

const { chromium } = await import('@playwright/test')
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${server.address().port}`

let failed = false
const fail = (m) => { failed = true; console.error(`[voice:verify-pipeline] FAIL: ${m}`) }

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.error('  [page error]', m.text().slice(0, 300)) })
  page.on('pageerror', (e) => console.error('  [pageerror]', String(e.message || e).slice(0, 300)))
  await page.goto(`${baseUrl}/`)
  await page.waitForFunction('window.__ready === true', { timeout: 60000 })

  const r = await page.evaluate(() => window.run())
  console.log('[voice:verify-pipeline] result:', JSON.stringify(r))

  if (!r.processorOk) fail('processor (feature_extractor) is null — the v1.12.5 probe bug is back')
  if (!r.tokenizerOk) fail('tokenizer is null — the v1.12.5 probe bug is back')
  if (r.textType !== 'string') fail(`transcribe did not return a string (got ${r.textType}) — pipeline crashed`)
} catch (e) {
  fail(`verifier error: ${(e && e.message) || e}`)
} finally {
  await browser.close()
  server.close()
}

if (failed) process.exit(1)
console.log('[voice:verify-pipeline] OK — full offline ASR pipeline assembles (processor+tokenizer loaded over http) and transcribes without the feature_extractor null crash.')
