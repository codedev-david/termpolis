#!/usr/bin/env node
// REAL end-to-end ACCURACY guard for offline voice. Loads the bundled
// whisper-base.en model into the SHIPPED transformers.js + onnxruntime-web inside
// a real headless Chromium (the same engine as the Electron renderer), builds the
// FULL automatic-speech-recognition pipeline EXACTLY as the renderer does
// (offline, localhost-http localModelPath), decodes a REAL speech clip, and
// asserts the transcript is CORRECT — not merely "a string".
//
// WHY THIS EXISTS: voice shipped broken across v1.12.0–v1.12.5. Every gate we had
// stopped at "did it return a string" — none ever checked the WORDS. That is
// exactly how "I'm sorry. What is that?" reached users: the pipeline returned a
// (hallucinated) string and went green. This gate:
//   1. transcribes tests/fixtures/jfk.wav and requires the known words back, and
//   2. proves the no-speech gate (isNoSpeech, pinned to production constants)
//      classifies silence as no-speech and real speech as speech — the mechanism
//      that stops a hallucination from ever being injected.
// It also still asserts processor+tokenizer load (the v1.12.5 probe regression).
//
// Skips cleanly (exit 0) when the model isn't on disk — HuggingFace rate-limits
// CI (the download step is continue-on-error), and a transient 429 must not red
// the build. It only FAILS when the model IS present but won't assemble/transcribe
// or gets the words wrong. Run locally via `npm run voice:verify-pipeline`.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const MODELS = path.join(ROOT, 'resources', 'models')
const ORT = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist')
const TF = path.join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist')
const ORTC = path.join(ROOT, 'node_modules', 'onnxruntime-common', 'dist', 'esm')
const FIXTURES = path.join(ROOT, 'tests', 'fixtures')
const MODEL = 'whisper-base.en'
const DECODER = path.join(MODELS, MODEL, 'onnx', 'decoder_model_merged_quantized.onnx')
const JFK = path.join(FIXTURES, 'jfk.wav')
const PIPELINE_TS = path.join(ROOT, 'src', 'renderer', 'src', 'lib', 'voice', 'voicePipeline.ts')

if (!fs.existsSync(DECODER)) {
  console.log(`[voice:verify-pipeline] model not on disk (${DECODER}) — skipping (transient HF download?).`)
  process.exit(0)
}
if (!fs.existsSync(JFK)) {
  console.error(`[voice:verify-pipeline] FAIL: speech fixture missing (${JFK}).`)
  process.exit(1)
}
for (const [name, dir] of [['onnxruntime-web', ORT], ['@huggingface/transformers', TF], ['onnxruntime-common', ORTC]]) {
  if (!fs.existsSync(dir)) {
    console.error(`[voice:verify-pipeline] FAIL: ${name} dist missing (${dir}) — run \`npm ci\`.`)
    process.exit(1)
  }
}

// Pin the no-speech gate to the SAME constants the app ships, parsed from source,
// so this gate can never drift from production behavior.
function parseConst(src, name) {
  const m = src.match(new RegExp(`${name}\\s*=\\s*([0-9.]+)`))
  if (!m) throw new Error(`could not parse ${name} from voicePipeline.ts`)
  return parseFloat(m[1])
}
const PSRC = fs.readFileSync(PIPELINE_TS, 'utf8')
const SILENCE_RMS_THRESHOLD = parseConst(PSRC, 'SILENCE_RMS_THRESHOLD')
const MIN_SPEECH_SECONDS = parseConst(PSRC, 'MIN_SPEECH_SECONDS')
console.log(`[voice:verify-pipeline] gate constants: SILENCE_RMS_THRESHOLD=${SILENCE_RMS_THRESHOLD} MIN_SPEECH_SECONDS=${MIN_SPEECH_SECONDS}`)

const ctype = (f) =>
  f.endsWith('.mjs') || f.endsWith('.js') ? 'text/javascript'
  : f.endsWith('.wasm') ? 'application/wasm'
  : f.endsWith('.json') ? 'application/json'
  : f.endsWith('.wav') ? 'audio/wav'
  : f.endsWith('.txt') ? 'text/plain'
  : 'application/octet-stream'

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
env.allowRemoteModels = true
env.remoteHost = location.origin
env.remotePathTemplate = 'models/{model}'
env.allowLocalModels = true
env.localModelPath = location.origin + '/models/'
const wasm = env.backends?.onnx?.wasm
if (wasm) { wasm.wasmPaths = location.origin + '/ort/'; wasm.numThreads = 1; wasm.proxy = false }

const MODEL = ${JSON.stringify(MODEL)}
const SILENCE_RMS_THRESHOLD = ${SILENCE_RMS_THRESHOLD}
const MIN_SPEECH_SECONDS = ${MIN_SPEECH_SECONDS}
// Mirror of buildTranscribeOptions: bare call for an English-only (.en) model.
const decodeOpts = /\\.en$/i.test(MODEL) ? { return_timestamps: false } : { return_timestamps: false, language: 'en', task: 'transcribe' }
// Mirror of isNoSpeech (pinned constants above).
function audioRms(a){let s=0;for(let i=0;i<a.length;i++)s+=a[i]*a[i];return a.length?Math.sqrt(s/a.length):0}
function isNoSpeech(a, rate){ if(a.length < MIN_SPEECH_SECONDS*rate) return true; return audioRms(a) < SILENCE_RMS_THRESHOLD }

async function load16k(url) {
  const buf = await (await fetch(url)).arrayBuffer()
  const decoded = await new AudioContext().decodeAudioData(buf)
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000)
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start()
  return (await off.startRendering()).getChannelData(0)
}

window.run = async () => {
  const asr = await pipeline('automatic-speech-recognition', MODEL, { device: 'wasm', dtype: 'q8', session_options: { graphOptimizationLevel: 'basic' } })
  const speech = await load16k('/fixtures/jfk.wav')
  const out = await asr(speech, decodeOpts)
  const silence = new Float32Array(16000 * 2)
  return {
    processorOk: !!(asr.processor && asr.processor.feature_extractor),
    tokenizerOk: !!asr.tokenizer,
    textType: typeof (out && out.text),
    text: out && out.text,
    gate_silence_isNoSpeech: isNoSpeech(silence, 16000),  // expect true
    gate_speech_isNoSpeech: isNoSpeech(speech, 16000),    // expect false
    speech_rms: audioRms(speech),
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
  if (url.startsWith('/fixtures/')) return serveDir(res, FIXTURES, url.slice('/fixtures/'.length))
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
  console.log('[voice:verify-pipeline] result:', JSON.stringify({ ...r, text: r.text }))

  if (!r.processorOk) fail('processor (feature_extractor) is null — the v1.12.5 probe bug is back')
  if (!r.tokenizerOk) fail('tokenizer is null — the v1.12.5 probe bug is back')
  if (r.textType !== 'string') fail(`transcribe did not return a string (got ${r.textType}) — pipeline crashed`)

  // ACCURACY: the known JFK line must come back. Require the load-bearing content
  // words (robust to punctuation/case and trivial ASR variation).
  const norm = String(r.text || '').toLowerCase()
  const REQUIRED = ['fellow', 'country', 'american']
  const missing = REQUIRED.filter((w) => !norm.includes(w))
  if (missing.length) fail(`transcript is WRONG — missing expected word(s) [${missing.join(', ')}] in: "${r.text}"`)

  // NO-SPEECH GATE: silence must be classified no-speech, real speech must not.
  if (r.gate_silence_isNoSpeech !== true) fail('no-speech gate FAILED to flag silence — hallucination could be injected')
  if (r.gate_speech_isNoSpeech !== false) fail(`no-speech gate WRONGLY flagged real speech (rms=${r.speech_rms}) — dictation would be dropped`)
} catch (e) {
  fail(`verifier error: ${(e && e.message) || e}`)
} finally {
  await browser.close()
  server.close()
}

if (failed) process.exit(1)
console.log('[voice:verify-pipeline] OK — whisper-base.en assembles offline, transcribes real speech CORRECTLY, and the no-speech gate separates silence from speech.')
