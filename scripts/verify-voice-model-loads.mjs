#!/usr/bin/env node
// REAL load guard for offline voice. Loads the bundled whisper-base model into
// the SHIPPED onnxruntime-web inside a real headless Chromium (same engine as the
// Electron renderer) and asserts `InferenceSession.create` succeeds at the
// graphOptimizationLevel we actually ship.
//
// WHY THIS EXISTS: v1.12.0–v1.12.3 shipped broken voice three times. Every voice
// test we had checked file presence, asset-serving, and config wiring — NONE ever
// instantiated the model. v1.12.3 (wasm 404 fixed) still crashed at session
// creation: ORT-web's extended-level `TransposeDQWeightsForMatMulNBits` fusion
// fails on the q8 *merged* decoder ("Missing required scale:
// model.decoder.embed_tokens.weight_merged_0_scale"). This script reproduces an
// actual load, so that whole class of "bundled but won't instantiate" bug fails
// CI instead of the user. Run in .github/workflows/test.yml (package-verify) and
// locally via `npm run voice:verify`.
//
// Skips cleanly (exit 0) when the model isn't on disk — HuggingFace rate-limits CI
// (the download step is continue-on-error), and a transient 429 must not red the
// build. It only FAILS when the model IS present but won't load at our level.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const ORT = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist')
const MODELS = path.join(ROOT, 'resources', 'models')
const DECODER = 'whisper-base.en/onnx/decoder_model_merged_quantized.onnx'
const ENCODER = 'whisper-base.en/onnx/encoder_model_quantized.onnx'
const CONFIG = path.join(ROOT, 'src', 'renderer', 'src', 'lib', 'voice', 'voiceWorkerConfig.ts')

// Single source of truth: test the level the renderer actually ships, parsed from
// VOICE_SESSION_OPTIONS — so this can never drift from production.
function shippedLevel() {
  const src = fs.readFileSync(CONFIG, 'utf8')
  const m = src.match(/VOICE_SESSION_OPTIONS\s*=\s*\{[^}]*graphOptimizationLevel:\s*'([^']+)'/s)
  if (!m) throw new Error('could not parse graphOptimizationLevel from voiceWorkerConfig.ts')
  return m[1]
}

if (!fs.existsSync(path.join(MODELS, DECODER))) {
  console.log(`[voice:verify] model not on disk (${path.join(MODELS, DECODER)}) — skipping (transient HF download?).`)
  process.exit(0)
}
if (!fs.existsSync(ORT)) {
  console.error('[voice:verify] FAIL: node_modules/onnxruntime-web/dist missing — run `npm ci`.')
  process.exit(1)
}

const LEVEL = shippedLevel()
console.log(`[voice:verify] shipped graphOptimizationLevel = '${LEVEL}'`)

const ctype = (f) =>
  f.endsWith('.mjs') || f.endsWith('.js') ? 'text/javascript'
  : f.endsWith('.wasm') ? 'application/wasm'
  : f.endsWith('.json') ? 'application/json'
  : 'application/octet-stream'

// NO COOP/COEP → not cross-origin isolated → single-thread + asyncify, exactly
// like the renderer (configureOffline forces numThreads=1, proxy=false).
const HTML = `<!doctype html><meta charset=utf8><body>
<script type=module>
import * as ort from '/ort/ort.wasm.min.mjs'
ort.env.wasm.numThreads = 1
ort.env.wasm.proxy = false
ort.env.wasm.wasmPaths = '/ort/'
window.createSession = async (model, level) => {
  try {
    const buf = await (await fetch('/models/' + model)).arrayBuffer()
    const opts = { executionProviders: ['wasm'] }
    if (level) opts.graphOptimizationLevel = level
    const s = await ort.InferenceSession.create(buf, opts)
    return { ok: true, inputs: s.inputNames.length, outputs: s.outputNames.length }
  } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 400) } }
}
window.__ready = true
</script></body>`

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0]
  if (url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML); return }
  let base = null, rel = null
  if (url.startsWith('/ort/')) { base = ORT; rel = url.slice('/ort/'.length) }
  else if (url.startsWith('/models/')) { base = MODELS; rel = url.slice('/models/'.length) }
  if (!base) { res.writeHead(404); res.end(); return }
  fs.readFile(path.join(base, decodeURIComponent(rel)), (e, buf) => {
    if (e) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': ctype(rel) }); res.end(buf)
  })
})

const { chromium } = await import('@playwright/test')

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${server.address().port}`

let failed = false
const fail = (m) => { failed = true; console.error(`[voice:verify] FAIL: ${m}`) }

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto(`${baseUrl}/`)
  await page.waitForFunction('window.__ready === true', { timeout: 60000 })

  for (const [name, model] of [['decoder', DECODER], ['encoder', ENCODER]]) {
    const r = await page.evaluate(({ model, level }) => window.createSession(model, level), { model, level: LEVEL })
    console.log(`[voice:verify] ${name} @ '${LEVEL}': ${JSON.stringify(r)}`)
    if (!r.ok) fail(`${name} failed to load at shipped level '${LEVEL}': ${r.error}`)
  }

  // Non-fatal signal: is the workaround still needed? Default should still crash.
  const def = await page.evaluate(({ model }) => window.createSession(model, undefined), { model: DECODER })
  if (def.ok) console.log('[voice:verify] NOTE: decoder now loads at DEFAULT optimization — the MatMulNBits workaround may no longer be necessary.')
  else console.log(`[voice:verify] confirmed default optimization still crashes (workaround still required): ${def.error.slice(0, 140)}`)
} catch (e) {
  fail(`verifier error: ${(e && e.message) || e}`)
} finally {
  await browser.close()
  server.close()
}

if (failed) process.exit(1)
console.log(`[voice:verify] OK — bundled whisper model loads in onnxruntime-web at graphOptimizationLevel='${LEVEL}'`)
