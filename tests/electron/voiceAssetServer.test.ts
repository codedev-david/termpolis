import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createVoiceAssetHandler } from '../../src/main/voiceAssetServer'

// Spin up the read-only asset handler against a temp dir and exercise it over a
// real socket — proving the renderer worker can fetch the bundled model + wasm,
// and that traversal / wrong-method / missing-file are all refused.
let server: http.Server
let base: string
let tmp: string

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-assets-'))
  fs.mkdirSync(path.join(tmp, 'models', 'whisper-base', 'onnx'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'voice-runtime', 'ort'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'models', 'whisper-base', 'config.json'), '{"model_type":"whisper"}')
  fs.writeFileSync(path.join(tmp, 'models', 'whisper-base', 'onnx', 'encoder_model_quantized.onnx'), Buffer.from([1, 2, 3, 4]))
  fs.writeFileSync(path.join(tmp, 'voice-runtime', 'ort', 'ort-wasm-simd-threaded.wasm'), Buffer.from([0, 1, 2]))
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'TOP SECRET') // outside both roots

  const handler = createVoiceAssetHandler({
    models: path.join(tmp, 'models'),
    voiceRuntime: path.join(tmp, 'voice-runtime'),
  })
  server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(() => {
  server?.close()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('voiceAssetServer', () => {
  it('serves a model config with a JSON content-type and CORS', async () => {
    const res = await fetch(`${base}/models/whisper-base/config.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.json()).toEqual({ model_type: 'whisper' })
  })

  it('serves an onnx model as octet-stream', async () => {
    const res = await fetch(`${base}/models/whisper-base/onnx/encoder_model_quantized.onnx`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('serves the ORT wasm with the application/wasm content-type', async () => {
    const res = await fetch(`${base}/voice-runtime/ort/ort-wasm-simd-threaded.wasm`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/wasm')
  })

  it('refuses path traversal out of the root', async () => {
    const res = await fetch(`${base}/models/%2e%2e%2f%2e%2e%2fsecret.txt`)
    expect(res.status).toBe(403)
  })

  it('404s an unknown prefix and a missing file', async () => {
    expect((await fetch(`${base}/nope/x`)).status).toBe(404)
    expect((await fetch(`${base}/models/whisper-base/missing.json`)).status).toBe(404)
  })

  it('rejects non-GET methods', async () => {
    const res = await fetch(`${base}/models/whisper-base/config.json`, { method: 'POST' })
    expect(res.status).toBe(405)
  })

  it('answers CORS preflight', async () => {
    const res = await fetch(`${base}/models/whisper-base/config.json`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toContain('GET')
  })
})
