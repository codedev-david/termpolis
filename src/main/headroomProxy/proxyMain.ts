import * as http from 'http'
import * as https from 'https'
import { rewriteMessagesBody, type WireStats } from './wireCompress'
import { parseUsageFromSse, decodeBody, type Usage } from './usageParse'
import { compressImage } from './imageCodec'

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
}

/**
 * Build the compression proxy HTTP server. Exported (not auto-listening) so it can be
 * unit-tested against a local stub upstream. Only POST /v1/messages bodies (NOT
 * /v1/messages/count_tokens) are rewritten (text: fail-open); everything else is a
 * transparent pass-through. The response streams back UNCHANGED; a decoded copy is parsed
 * for real token usage. Every path is wrapped so a bad edge forwards/ends rather than throws —
 * a crash would break every live Claude session pinned to this port.
 *
 * Image compression runs here too (v1.29.1): a pure-JS, deterministic, memoized PNG downscale
 * in this CHILD process (off the main thread) — no nativeImage, no timeout, no cross-process
 * delegation — so identical images compress to identical bytes every turn (cache-safe).
 */
export function createProxyServer(opts: ProxyOpts): http.Server {
  const useHttps = opts.useHttps !== false
  const upstreamPort = opts.upstreamPort ?? (useHttps ? 443 : 80)
  const agentMod = useHttps ? https : http

  return http.createServer((req, res) => {
    const url = req.url || ''
    const isMessages = url.startsWith('/v1/messages') && !url.startsWith('/v1/messages/count_tokens') && req.method === 'POST'
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
    req.on('end', () => { void handle().catch(() => { try { if (!res.headersSent) res.writeHead(502); res.end() } catch { /* ignore */ } }) })

    async function handle(): Promise<void> {
      let body = Buffer.concat(chunks)
      let rewritten: { changed: boolean; stats: WireStats; stashes: Array<{ token: string; original: string }> } | null = null
      if (isMessages) {
        try {
          const r = rewriteMessagesBody(body.toString('utf8'), { compressImage })
          if (r.changed) body = Buffer.from(r.body, 'utf8')
          rewritten = { changed: r.changed, stats: r.stats, stashes: r.stashes }
        } catch { /* fail-open: forward original */ }
      }
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: opts.upstreamHost }
      headers['content-length'] = Buffer.byteLength(body)
      let upReq: http.ClientRequest
      try {
        upReq = agentMod.request(
          { hostname: opts.upstreamHost, port: upstreamPort, path: req.url, method: req.method, headers },
          (up) => {
            try { res.writeHead(up.statusCode || 502, up.headers) } catch { try { res.destroy() } catch { /* ignore */ } return }
            const respChunks: Buffer[] = []
            up.on('data', (c) => { respChunks.push(c); try { res.write(c) } catch { /* client gone */ } })
            up.on('end', () => {
              try { res.end() } catch { /* ignore */ }
              if (isMessages && rewritten && opts.onResult) {
                try {
                  const sse = decodeBody(Buffer.concat(respChunks), String(up.headers['content-encoding'] || ''))
                  const usage = parseUsageFromSse(sse)
                  opts.onResult({ changed: rewritten.changed, stats: rewritten.stats, usage, stashes: rewritten.stashes, status: up.statusCode || 0 })
                } catch { /* best effort */ }
              }
            })
            up.on('error', () => { try { res.end() } catch { /* ignore */ } })
          },
        )
      } catch (e) {
        if (!res.headersSent) { try { res.writeHead(502, { 'content-type': 'text/plain' }) } catch { /* ignore */ } }
        try { res.end('headroom proxy request error: ' + (e as Error).message) } catch { /* ignore */ }
        return
      }
      upReq.on('error', (e) => {
        if (!res.headersSent) { try { res.writeHead(502, { 'content-type': 'text/plain' }) } catch { /* ignore */ } }
        try { res.end('headroom proxy upstream error: ' + (e as Error).message) } catch { /* ignore */ }
      })
      upReq.end(body)
    }
  })
}

/* v8 ignore start -- utilityProcess child entry: exercised at runtime in the fork, not unit-testable */
const parentPort = (process as unknown as { parentPort?: { on: (ev: string, cb: (e: { data: unknown }) => void) => void; postMessage: (m: unknown) => void } }).parentPort
if (parentPort) {
  // Keep the child ALIVE on any unexpected error. A crash would break every live Claude session
  // pinned to this port (a running PTY can't re-resolve ANTHROPIC_BASE_URL to direct mid-session).
  // One request may be lost; the child survives to serve the rest.
  process.on('uncaughtException', (err) => { try { parentPort.postMessage({ kind: 'error', message: 'uncaught: ' + String((err as Error)?.message ?? err) }) } catch { /* ignore */ } })
  process.on('unhandledRejection', (err) => { try { parentPort.postMessage({ kind: 'error', message: 'rejection: ' + String(err) }) } catch { /* ignore */ } })

  let server: http.Server | null = null
  parentPort.on('message', (e) => {
    const msg = e && (e.data as { kind?: string; port?: number; upstreamHost?: string })
    if (!msg || msg.kind !== 'init' || server) return
    const targetPort = msg.port || 0
    let attempts = 0
    const start = (): void => {
      const s = createProxyServer({ upstreamHost: msg.upstreamHost || 'api.anthropic.com', useHttps: true, onResult: (r) => { try { parentPort.postMessage({ kind: 'result', changed: r.changed, stats: r.stats, usage: r.usage, stashes: r.stashes, status: r.status }) } catch { /* ignore */ } } })
      server = s
      s.on('error', () => {
        // Port not yet released during a fast restart — retry a few times, else exit so the
        // supervisor's onExit → respawn path runs instead of lingering bound to nothing.
        try { s.close() } catch { /* ignore */ }
        server = null
        if (attempts++ < 5) setTimeout(start, 400)
        else { try { parentPort.postMessage({ kind: 'error', message: 'listen failed' }) } catch { /* ignore */ } process.exit(1) }
      })
      s.listen(targetPort, '127.0.0.1', () => {
        const addr = s.address()
        const port = addr && typeof addr === 'object' ? addr.port : targetPort
        try { parentPort.postMessage({ kind: 'ready', port }) } catch { /* ignore */ }
      })
    }
    try { start() } catch (err) { try { parentPort.postMessage({ kind: 'error', message: String((err as Error).message) }) } catch { /* ignore */ } }
  })
}
/* v8 ignore stop */
