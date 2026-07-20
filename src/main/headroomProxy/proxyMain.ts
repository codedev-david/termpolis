import * as http from 'http'
import * as https from 'https'
import { rewriteMessagesBody, type WireStats } from './wireCompress'
import { parseUsageFromSse, decodeBody, type Usage } from './usageParse'
import { compressImagesInBody, type AsyncImgCompressor } from './imagePass'

export interface ProxyResult {
  changed: boolean
  stats: WireStats
  usage: Usage
  stashes: Array<{ token: string; original: string }>
  status: number
}
export interface ProxyOpts {
  upstreamHost: string
  upstreamPort?: number
  useHttps?: boolean
  onResult?: (r: ProxyResult) => void
  compressImagesAsync?: AsyncImgCompressor
}

/**
 * Build the compression proxy HTTP server. Exported (not auto-listening) so it can be
 * unit-tested against a local stub upstream. Only POST /v1/messages bodies are rewritten
 * (text: sync + fail-open; images: bounded async delegate + fail-open). Everything else is
 * a transparent pass-through. The response streams back UNCHANGED; a decoded copy is parsed
 * for real token usage.
 */
export function createProxyServer(opts: ProxyOpts): http.Server {
  const useHttps = opts.useHttps !== false
  const upstreamPort = opts.upstreamPort ?? (useHttps ? 443 : 80)
  const agentMod = useHttps ? https : http

  return http.createServer((req, res) => {
    const isMessages = (req.url || '').startsWith('/v1/messages') && req.method === 'POST'
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
    req.on('end', () => { void handle() })

    async function handle(): Promise<void> {
      let body = Buffer.concat(chunks)
      let stats: WireStats | null = null
      let stashes: Array<{ token: string; original: string }> = []
      let changed = false
      if (isMessages) {
        try {
          const r = rewriteMessagesBody(body.toString('utf8'))
          if (r.changed) body = Buffer.from(r.body, 'utf8')
          stats = r.stats; stashes = r.stashes; changed = r.changed
        } catch { /* fail-open: original body */ }
        if (opts.compressImagesAsync) {
          try {
            const ip = await compressImagesInBody(body.toString('utf8'), opts.compressImagesAsync)
            if (ip.stats.images > 0) {
              body = Buffer.from(ip.body, 'utf8'); changed = true
              if (stats) { stats.images += ip.stats.images; stats.imgOrigBytes += ip.stats.imgOrigBytes; stats.imgCompBytes += ip.stats.imgCompBytes }
              else stats = { trBlocks: 0, trOrigChars: 0, trCompChars: 0, ...ip.stats }
            }
          } catch { /* fail-open: keep body */ }
        }
      }
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: opts.upstreamHost }
      headers['content-length'] = Buffer.byteLength(body)
      const upReq = agentMod.request(
        { hostname: opts.upstreamHost, port: upstreamPort, path: req.url, method: req.method, headers },
        (up) => {
          res.writeHead(up.statusCode || 502, up.headers)
          const respChunks: Buffer[] = []
          up.on('data', (c) => { respChunks.push(c); try { res.write(c) } catch { /* client gone */ } })
          up.on('end', () => {
            try { res.end() } catch { /* ignore */ }
            if (isMessages && stats && opts.onResult) {
              try {
                const sse = decodeBody(Buffer.concat(respChunks), String(up.headers['content-encoding'] || ''))
                const usage = parseUsageFromSse(sse)
                opts.onResult({ changed, stats, usage, stashes, status: up.statusCode || 0 })
              } catch { /* best effort */ }
            }
          })
          up.on('error', () => { try { res.end() } catch { /* ignore */ } })
        },
      )
      upReq.on('error', (e) => {
        if (!res.headersSent) { try { res.writeHead(502, { 'content-type': 'text/plain' }) } catch { /* ignore */ } }
        try { res.end('headroom proxy upstream error: ' + (e as Error).message) } catch { /* ignore */ }
      })
      upReq.end(body)
    }
  })
}

// ── utilityProcess bootstrap (only runs inside the forked child) ──────────────
// Guarded on process.parentPort so importing this module in tests/main is inert.
// Per the memory-brain gotcha: the child receives messages as `e.data`. Image
// compression is delegated to main (nativeImage lives there); bounded + fail-open.
const parentPort = (process as unknown as { parentPort?: { on: (ev: string, cb: (e: { data: unknown }) => void) => void; postMessage: (m: unknown) => void } }).parentPort
if (parentPort) {
  let server: http.Server | null = null
  let reqCounter = 0
  const pendingImg = new Map<number, (r: unknown) => void>()
  const delegateImages: AsyncImgCompressor = (images) => new Promise((resolve) => {
    const reqId = ++reqCounter
    const finish = (r: unknown): void => {
      if (!pendingImg.has(reqId)) return
      pendingImg.delete(reqId)
      resolve(Array.isArray(r) ? (r as Array<{ data: string; mediaType: string; changed: boolean }>) : images.map((i) => ({ ...i, changed: false })))
    }
    pendingImg.set(reqId, finish)
    setTimeout(() => finish(null), 3000) // hard cleanup so the pending map can't leak
    try { parentPort.postMessage({ kind: 'compressImages', reqId, images }) } catch { finish(null) }
  })
  parentPort.on('message', (e) => {
    const msg = e && (e.data as { kind?: string; port?: number; upstreamHost?: string; reqId?: number; results?: unknown })
    if (!msg) return
    if (msg.kind === 'imagesResult' && typeof msg.reqId === 'number') { const f = pendingImg.get(msg.reqId); if (f) f(msg.results); return }
    if (msg.kind !== 'init' || server) return
    try {
      server = createProxyServer({
        upstreamHost: msg.upstreamHost || 'api.anthropic.com',
        useHttps: true,
        compressImagesAsync: delegateImages,
        onResult: (r) => { try { parentPort.postMessage({ kind: 'result', changed: r.changed, stats: r.stats, usage: r.usage, stashes: r.stashes, status: r.status }) } catch { /* ignore */ } },
      })
      server.on('error', (err) => { try { parentPort.postMessage({ kind: 'error', message: String((err as Error).message) }) } catch { /* ignore */ } })
      server.listen(msg.port || 0, '127.0.0.1', () => {
        const addr = server!.address()
        const port = addr && typeof addr === 'object' ? addr.port : msg.port
        try { parentPort.postMessage({ kind: 'ready', port }) } catch { /* ignore */ }
      })
    } catch (err) {
      try { parentPort.postMessage({ kind: 'error', message: String((err as Error).message) }) } catch { /* ignore */ }
    }
  })
}
