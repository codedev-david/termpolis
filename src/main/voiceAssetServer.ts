// Tiny read-only localhost file server for the bundled voice model + ORT wasm.
//
// WHY THIS EXISTS: the Whisper transcriber runs in a renderer Web Worker, under
// the app's strict CSP. That CSP (correctly) forbids fetching models from
// huggingface.co, and the renderer can't read arbitrary file:// paths. But the
// CSP already allows http://127.0.0.1:* (for the MCP server), so we serve the
// LOCALLY-BUNDLED model + the version-matched onnxruntime-web wasm from a
// 127.0.0.1 port. Transformers.js fetches them like any http model — fully
// offline, audio never leaves the box, no connect-src change needed.
//
// Hardening: 127.0.0.1 only, GET only, two fixed roots, path-traversal guarded,
// started lazily (port stays closed until voice is actually used).

import http from 'http'
import fs from 'fs'
import path from 'path'

let server: http.Server | null = null
let boundPort: number | null = null
let starting: Promise<number> | null = null

export interface VoiceAssetRoots {
  /** Dir holding model folders, e.g. <root>/whisper-base/onnx/...  (served at /models/) */
  models: string
  /** Dir holding the ORT wasm, e.g. <root>/ort/*.wasm  (served at /voice-runtime/) */
  voiceRuntime: string
}

// Mirror localEmbedder.resolveAssetDir: packaged (extraResources) first, then
// the repo-relative source used in dev + CI's package-verify job.
function resolveDefaultRoots(): VoiceAssetRoots {
  const pick = (packagedSub: string, devSub: string): string => {
    const cands: string[] = []
    if (process.resourcesPath) cands.push(path.join(process.resourcesPath, packagedSub))
    cands.push(path.join(process.cwd(), devSub))
    for (const c of cands) {
      try { if (fs.existsSync(c)) return c } catch { /* ignore */ }
    }
    // Return the dev candidate even if missing, so a 404 names a real path.
    return cands[cands.length - 1]
  }
  return {
    models: pick('models', path.join('resources', 'models')),
    voiceRuntime: pick('voice-runtime', path.join('resources', 'voice-runtime')),
  }
}

function contentType(file: string): string {
  if (file.endsWith('.wasm')) return 'application/wasm'
  if (file.endsWith('.json')) return 'application/json; charset=utf-8'
  if (file.endsWith('.txt')) return 'text/plain; charset=utf-8'
  if (file.endsWith('.mjs') || file.endsWith('.js')) return 'text/javascript; charset=utf-8'
  // .onnx, .bin and everything else — opaque bytes.
  return 'application/octet-stream'
}

// Exported for unit testing without binding a socket.
export function createVoiceAssetHandler(roots: VoiceAssetRoots) {
  const prefixes: Array<{ prefix: string; root: string }> = [
    { prefix: '/models/', root: roots.models },
    { prefix: '/voice-runtime/', root: roots.voiceRuntime },
  ]
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    // Read-only model assets, no secrets — a wildcard origin lets the renderer
    // (file:// → "null" origin) fetch them. GET/OPTIONS only.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end('method not allowed'); return
    }

    const url = (req.url || '').split('?')[0]
    const match = prefixes.find((p) => url.startsWith(p.prefix))
    if (!match) { res.writeHead(404); res.end('not found'); return }

    let rel: string
    try { rel = decodeURIComponent(url.slice(match.prefix.length)) } catch { res.writeHead(400); res.end('bad path'); return }

    const rootAbs = path.resolve(match.root)
    const full = path.resolve(rootAbs, rel)
    // Traversal guard: the resolved path must stay inside the root.
    if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) {
      res.writeHead(403); res.end('forbidden'); return
    }

    fs.stat(full, (statErr, stat) => {
      if (statErr || !stat.isFile()) { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'Content-Type': contentType(full), 'Content-Length': String(stat.size) })
      if (req.method === 'HEAD') { res.end(); return }
      const stream = fs.createReadStream(full)
      stream.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
      stream.pipe(res)
    })
  }
}

/**
 * Lazily start the asset server on 127.0.0.1 (ephemeral port) and resolve its
 * base URL, e.g. "http://127.0.0.1:54231". Safe to call repeatedly.
 */
export function ensureVoiceAssetServer(rootsOverride?: VoiceAssetRoots): Promise<string> {
  if (boundPort !== null) return Promise.resolve(`http://127.0.0.1:${boundPort}`)
  if (starting) return starting.then((p) => `http://127.0.0.1:${p}`)
  const roots = rootsOverride ?? resolveDefaultRoots()
  starting = new Promise<number>((resolve, reject) => {
    const s = http.createServer(createVoiceAssetHandler(roots))
    s.on('error', (e) => { starting = null; reject(e) })
    // Port 0 → OS assigns a free ephemeral port (no conflict-retry loop needed).
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server = s
      boundPort = port
      resolve(port)
    })
  })
  return starting.then((p) => `http://127.0.0.1:${p}`)
}

export function getVoiceAssetBaseUrl(): string | null {
  return boundPort === null ? null : `http://127.0.0.1:${boundPort}`
}

export function stopVoiceAssetServer(): void {
  try { server?.close() } catch { /* ignore */ }
  server = null
  boundPort = null
  starting = null
}
