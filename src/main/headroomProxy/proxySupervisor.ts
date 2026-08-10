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
let proxyMode = 'aggressive' // wire compression mode pushed to the child; default = max savings
let proxyThinkingCap = 0 // extended-thinking budget ceiling pushed to the child; 0 = off (default)
let proxyDecay = false // prefix decay; OFF by default — see prefixDecay.ts for why the bet only pays in long sessions
let upstream = 'api.anthropic.com'
let restartTimes: number[] = []
let stopped = false
let cooldownTimer: ReturnType<typeof setTimeout> | null = null
let resultCb: ((r: ProxyResultMsg) => void) | null = null

export function setProxySpawner(fn: Spawner | null): void { spawner = fn }
export function onProxyResult(cb: ((r: ProxyResultMsg) => void) | null): void { resultCb = cb }
/** Push the wire compression mode to the child: applied live if a transport is up, and re-sent
 *  on the next (re)spawn's init. Best-effort — a failed post just means the aggressive default
 *  holds in the child, so savings never silently drop. */
export function setProxyMode(m: string): void {
  proxyMode = m
  try { transport?.postMessage({ kind: 'config', mode: m, thinkingCap: proxyThinkingCap, decay: proxyDecay }) } catch { /* best effort */ }
}
/** Push the extended-thinking budget ceiling (0 = off) on the same channel as the mode, so a
 *  respawned child re-adopts it from init and can't quietly revert to the user's full budget. */
export function setProxyThinkingCap(n: number): void {
  proxyThinkingCap = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  try { transport?.postMessage({ kind: 'config', mode: proxyMode, thinkingCap: proxyThinkingCap, decay: proxyDecay }) } catch { /* best effort */ }
}
/** Push the prefix-decay flag on the same channel, so a respawned child re-adopts it from init
 *  rather than reverting to the default and silently changing the transform mid-conversation. */
export function setProxyDecay(on: boolean): void {
  proxyDecay = on === true
  try { transport?.postMessage({ kind: 'config', mode: proxyMode, thinkingCap: proxyThinkingCap, decay: proxyDecay }) } catch { /* best effort */ }
}
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
  stopped = false
  spawnOnce()
}

function spawnOnce(): void {
  if (!spawner) { healthy = false; return }
  try {
    transport = spawner()
  } catch { healthy = false; transport = null; return }
  transport.onMessage((m) => {
    const msg = m as { kind?: string; port?: number }
    if (!msg) return
    if (msg.kind === 'ready') { healthy = true; if (msg.port) port = msg.port }
    else if (msg.kind === 'error') { healthy = false }
    else if (msg.kind === 'result' && resultCb) { try { resultCb(m as ProxyResultMsg) } catch { /* best effort */ } }
  })
  transport.onExit(() => { healthy = false; transport = null; maybeRestart() })
  try { transport.postMessage({ kind: 'init', port, upstreamHost: upstream, mode: proxyMode, thinkingCap: proxyThinkingCap, decay: proxyDecay }) } catch { healthy = false }
}

function maybeRestart(): void {
  const now = Date.now()
  restartTimes = restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
  restartTimes.push(now)
  if (stopped) return
  if (restartTimes.length > MAX_RESTARTS) {
    healthy = false // flapping → back off; new Claude launches go direct (safe) meanwhile
    // Don't give up FOREVER — after a cooldown, reset and try again so the proxy self-heals and
    // any live session pinned to the port recovers on the next successful bind.
    if (cooldownTimer) clearTimeout(cooldownTimer)
    cooldownTimer = setTimeout(() => { cooldownTimer = null; if (!stopped && !healthy) { restartTimes = []; spawnOnce() } }, 30_000)
    return
  }
  spawnOnce()
}

export function stopProxy(): void {
  stopped = true
  if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null }
  try { transport?.kill() } catch { /* ignore */ }
  transport = null
  healthy = false
}

/* v8 ignore start -- thin Electron utilityProcess wrapper; needs a real Electron runtime */
/** Real Electron transport — lazy require so this module imports cleanly in tests (no Electron). */
export function createProxyTransport(entryPath: string): ProxyTransport {
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
/* v8 ignore stop */

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
  if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null }
  transport = null; healthy = false; port = 0; restartTimes = []; stopped = false; resultCb = null; spawner = null; upstream = 'api.anthropic.com'; proxyMode = 'aggressive'
}
