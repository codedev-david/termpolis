import * as http from 'http'
import * as https from 'https'
import { rewriteMessagesBody, setWireWindow, windowForMode, setThinkingCap, setFirstSightPolicy, type WireStats } from './wireCompress'
import { parseUsageFromSse, parseTurnShapeFromSse, decodeBody, type Usage, type TurnShape } from './usageParse'
import { compressImage } from './imageCodec'
import type { StashEntry } from '../headroom/elisionMeta'
import type { ProxyResultMsg, ProxyStashMsg } from './proxySupervisor'

/**
 * Prefix decay, opt-in. Module scope rather than a closure because the HTTP server is built once
 * and the flag arrives later on the config channel; `=== true` means an absent or garbled field
 * leaves it OFF rather than flipping the transform on a partially-formed message.
 */
let decayEnabled = false
export function setPrefixDecay(on: unknown): void { decayEnabled = on === true }

/**
 * Apply a config frame from the main process (on init, again on every respawn, and live on a
 * Settings change). Each field is validated where it lands: an unknown tier leaves the window as it
 * is, so a garbled frame can never downgrade it, a cap that is not a number leaves the ceiling in
 * place, and the first-sight policy is taken from the first frame that carries a usable one and then
 * frozen (wireCompress.setFirstSightPolicy). Total: a frame that is not an object changes nothing.
 */
export function applyProxyConfig(msg: unknown): void {
  if (!msg || typeof msg !== 'object') return
  const m = msg as { mode?: unknown; thinkingCap?: unknown; decay?: unknown; firstSight?: unknown }
  // Translate a mode string to the wire window; unknown or garbled gives null, setWireWindow no-ops
  // on it, and the aggressive default holds (never downgrades on a bad message).
  if (typeof m.mode === 'string') setWireWindow(windowForMode(m.mode))
  // The thinking cap rides the same message as the mode; setThinkingCap validates, so a garbled
  // or absent value simply leaves the current ceiling in place.
  setThinkingCap(m.thinkingCap)
  setPrefixDecay(m.decay)
  setFirstSightPolicy(m.firstSight)
}

export interface ProxyResult {
  changed: boolean
  stats: WireStats
  usage: Usage
  /** Which tools the answer called, so a turn spent only on retrieve_full can be charged. */
  turn: TurnShape
  stashes: StashEntry[]
  status: number
}
export interface ProxyOpts {
  upstreamHost: string
  upstreamPort?: number
  useHttps?: boolean
  onResult?: (r: ProxyResult) => void
  onStash?: (stashes: StashEntry[]) => void
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
      let rewritten: { changed: boolean; stats: WireStats; stashes: StashEntry[] } | null = null
      if (isMessages) {
        try {
          const r = rewriteMessagesBody(body.toString('utf8'), { compressImage, decay: decayEnabled })
          if (r.changed) body = Buffer.from(r.body, 'utf8')
          rewritten = { changed: r.changed, stats: r.stats, stashes: r.stashes }
        } catch { /* fail-open: forward original */ }
      }
      // Commit the originals BEFORE the rewritten body leaves: the retrieve_full token is already
      // IN that body, and with fine-grained tool streaming Claude calls the tool while the response
      // is still open — so committing on onResult loses the race outright on the first turn and
      // every miss costs more than the elision saved.
      if (rewritten && rewritten.stashes.length > 0 && opts.onStash) {
        try { opts.onStash(rewritten.stashes) } catch { /* best effort — a bad consumer must not fail the request */ }
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
                  // The shape of the turn is bookkeeping for the retrieval charge. If reading it ever
                  // failed, the usage must still arrive, as it did before the turn was read at all.
                  let turn: TurnShape = { toolCalls: 0, retrieveCalls: 0, pure: false }
                  try { turn = parseTurnShapeFromSse(sse) } catch { /* the usage still counts */ }
                  opts.onResult({ changed: rewritten.changed, stats: rewritten.stats, usage, turn, stashes: rewritten.stashes, status: up.statusCode || 0 })
                } catch { /* best effort */ }
              }
            })
            // An answer the upstream breaks off must reach the client as a broken connection, the way
            // it would without the proxy. Ending the response instead makes the cut-short body look
            // finished, and that body is usually gzip-encoded, so Claude Code fails it as
            // "Decompression error: ZlibError" rather than as a connection error it retries.
            up.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
          },
        )
      } catch (e) {
        if (!res.headersSent) { try { res.writeHead(502, { 'content-type': 'text/plain' }) } catch { /* ignore */ } }
        try { res.end('headroom proxy request error: ' + (e as Error).message) } catch { /* ignore */ }
        return
      }
      // A client that hangs up before the answer is done (Esc in Claude Code) ends the turn: stop the
      // upstream request too, as a direct connection would. Otherwise the model goes on generating,
      // and counting against the user's usage, an answer nobody reads.
      res.on('close', () => { if (!res.writableFinished) { try { upReq.destroy() } catch { /* ignore */ } } })
      upReq.on('error', (e) => {
        // Once the answer has started, nothing may follow it: its body may be gzip-encoded, and text
        // written now would land inside the compressed stream. Break the connection instead.
        if (res.headersSent) { try { res.destroy() } catch { /* ignore */ } return }
        try { res.writeHead(502, { 'content-type': 'text/plain' }) } catch { /* ignore */ }
        try { res.end('headroom proxy upstream error: ' + (e as Error).message) } catch { /* ignore */ }
      })
      upReq.end(body)
    }
  })
}

/**
 * The two messages the child posts to the main process. They are built here, in the open, and not
 * inline in the child entry below, because that entry is excluded from coverage and a field dropped
 * from either one would silently zero a whole class of the ledger: the retrieval-turn charge rides on
 * `turn`, the stub-kind tally and the first-sight arms on `stats`, and the stash metadata on `stashes`.
 * Typed against the receiving side's own message types, so a field the ledger reads cannot go missing
 * without the compiler saying so.
 */
export function resultFrame(r: ProxyResult): ProxyResultMsg {
  return { kind: 'result', changed: r.changed, stats: r.stats, usage: r.usage, turn: r.turn, stashes: r.stashes, status: r.status }
}
export function stashFrame(stashes: StashEntry[]): ProxyStashMsg {
  return { kind: 'stash', stashes }
}

/* v8 ignore start -- utilityProcess child entry: exercised at runtime in the fork, not unit-testable */
const parentPort = (process as unknown as { parentPort?: { on: (ev: string, cb: (e: { data: unknown }) => void) => void; postMessage: (m: unknown) => void } }).parentPort
if (parentPort) {
  // No lowerHostPriority() here (EDR-2): this child carries every model reply an agent streams, which is what
  // someone is waiting on, so it stays at normal priority. Only the memory and proc hosts lower themselves.
  // Keep the child ALIVE on any unexpected error. A crash would break every live Claude session
  // pinned to this port (a running PTY can't re-resolve ANTHROPIC_BASE_URL to direct mid-session).
  // One request may be lost; the child survives to serve the rest.
  process.on('uncaughtException', (err) => { try { parentPort.postMessage({ kind: 'error', message: 'uncaught: ' + String((err as Error)?.message ?? err) }) } catch { /* ignore */ } })
  process.on('unhandledRejection', (err) => { try { parentPort.postMessage({ kind: 'error', message: 'rejection: ' + String(err) }) } catch { /* ignore */ } })

  let server: http.Server | null = null
  parentPort.on('message', (e) => {
    const msg = e && (e.data as { kind?: string; port?: number; upstreamHost?: string })
    if (!msg) return
    if (msg.kind === 'config') { applyProxyConfig(msg); return } // live mode/cap change (Settings → supervisor)
    if (msg.kind !== 'init' || server) return
    applyProxyConfig(msg) // honor the config carried on init — and re-applied on every respawn
    const targetPort = msg.port || 0
    let attempts = 0
    const start = (): void => {
      const s = createProxyServer({
        upstreamHost: msg.upstreamHost || 'api.anthropic.com',
        useHttps: true,
        // Request-path commit — the main process must be able to answer retrieve_full for a token
        // that is already on the wire, not only once the response has finished streaming.
        onStash: (stashes) => {
          try { parentPort.postMessage(stashFrame(stashes)) } catch (err) {
            // The tokens for these originals are ALREADY in the body heading upstream. If the
            // commit cannot cross to MAIN, every one of them is a handle nothing can ever redeem —
            // the only way this proxy can mint an unredeemable token. It still must not fail the
            // request, but swallowing it turned a proxy fault into phantom retrieve_full misses
            // with no trace on either side; the existing error channel gives it one.
            try {
              parentPort.postMessage({ kind: 'error', message: `stash commit dropped (${stashes.length} originals): ${String((err as Error)?.message ?? err)}` })
            } catch { /* parent is gone; the supervisor's exit path takes over */ }
          }
        },
        // Still carried on the result as an idempotent backstop: ccrPut is content-hash keyed, so
        // a re-put of the same original is a no-op.
        onResult: (r) => { try { parentPort.postMessage(resultFrame(r)) } catch { /* ignore */ } },
      })
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
