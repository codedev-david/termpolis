import * as net from 'net'
import type { WireStats } from './wireCompress'
import type { Usage } from './usageParse'

export interface ProxyResultMsg {
  kind: 'result'
  changed: boolean
  stats: WireStats
  usage: Usage
  stashes: Array<{ token: string; original: string }>
  status: number
}

/** Minimal transport over the child — abstracted so the supervisor is unit-testable without Electron. */
export interface ProxyTransport {
  postMessage: (m: unknown) => void
  onMessage: (cb: (m: unknown) => void) => void
  onExit: (cb: (code: number) => void) => void
  kill: () => void
  readonly pid: number | undefined
}
type Spawner = () => ProxyTransport

const MAX_RESTARTS = 4
const RESTART_WINDOW_MS = 60_000

let spawner: Spawner | null = null
let transport: ProxyTransport | null = null
let healthy = false
let port = 0
let upstream = 'api.anthropic.com'
let restartTimes: number[] = []
let resultCb: ((r: ProxyResultMsg) => void) | null = null

export function setProxySpawner(fn: Spawner | null): void { spawner = fn }
export function onProxyResult(cb: ((r: ProxyResultMsg) => void) | null): void { resultCb = cb }

type ImageCompressorFn = (imgs: Array<{ data: string; mediaType: string }>) => Array<{ data: string; mediaType: string; changed: boolean }>
let imageCompressor: ImageCompressorFn | null = null
/** Register the (main-side, nativeImage-backed) image compressor the child delegates to. */
export function setImageCompressor(fn: ImageCompressorFn | null): void { imageCompressor = fn }
export function isProxyHealthy(): boolean { return healthy && port > 0 }
export function getProxyPort(): number { return port }

/** The env a Claude launch should inherit — or null when the proxy isn't healthy (→ launch direct). */
export function getProxyEnv(): Record<string, string> | null {
  if (!isProxyHealthy()) return null
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: '1',
    ENABLE_TOOL_SEARCH: 'true',
  }
}

export function startProxy(opts: { port: number; upstreamHost?: string }): void {
  port = opts.port
  upstream = opts.upstreamHost || 'api.anthropic.com'
  restartTimes = []
  spawnOnce()
}

function spawnOnce(): void {
  if (!spawner) { healthy = false; return }
  try {
    transport = spawner()
  } catch { healthy = false; transport = null; return }
  transport.onMessage((m) => {
    const msg = m as { kind?: string; port?: number; reqId?: number; images?: Array<{ data: string; mediaType: string }> }
    if (!msg) return
    if (msg.kind === 'ready') { healthy = true; if (msg.port) port = msg.port }
    else if (msg.kind === 'error') { healthy = false }
    else if (msg.kind === 'result' && resultCb) { try { resultCb(m as ProxyResultMsg) } catch { /* best effort */ } }
    else if (msg.kind === 'compressImages' && typeof msg.reqId === 'number') {
      const imgs = msg.images || []
      let results: Array<{ data: string; mediaType: string; changed: boolean }>
      try { results = imageCompressor ? imageCompressor(imgs) : imgs.map((i) => ({ ...i, changed: false })) } catch { results = imgs.map((i) => ({ ...i, changed: false })) }
      try { transport?.postMessage({ kind: 'imagesResult', reqId: msg.reqId, results }) } catch { /* ignore */ }
    }
  })
  transport.onExit(() => { healthy = false; transport = null; maybeRestart() })
  try { transport.postMessage({ kind: 'init', port, upstreamHost: upstream }) } catch { healthy = false }
}

function maybeRestart(): void {
  const now = Date.now()
  restartTimes = restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
  restartTimes.push(now)
  if (restartTimes.length > MAX_RESTARTS) { healthy = false; return } // flapping → give up, Claude launches direct
  spawnOnce()
}

export function stopProxy(): void {
  try { transport?.kill() } catch { /* ignore */ }
  transport = null
  healthy = false
}

/** Real Electron transport — lazy require so this module imports cleanly in tests (no Electron). */
export function createProxyTransport(entryPath: string): ProxyTransport {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { utilityProcess } = require('electron') as typeof import('electron')
  const child = utilityProcess.fork(entryPath, [], { serviceName: 'termpolis-headroom' })
  return {
    postMessage: (m: unknown) => child.postMessage(m),
    onMessage: (cb) => child.on('message', (m: unknown) => cb(m)), // parent gets `m` directly
    onExit: (cb) => child.on('exit', (code: number) => cb(code)),
    kill: () => { try { child.kill() } catch { /* ignore */ } },
    get pid() { return child.pid },
  }
}

/** Find an OS-assigned free TCP port on loopback (resolves 0 on failure). */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.on('error', () => resolve(0))
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address()
      const p = a && typeof a === 'object' ? a.port : 0
      srv.close(() => resolve(p))
    })
  })
}

export function _resetProxyForTest(): void {
  transport = null; healthy = false; port = 0; restartTimes = []; resultCb = null; imageCompressor = null; spawner = null; upstream = 'api.anthropic.com'
}
