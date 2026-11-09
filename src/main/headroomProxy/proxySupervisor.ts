import * as net from 'net'
import type { WireStats } from './wireCompress'
import type { Usage, TurnShape } from './usageParse'
import type { StashEntry } from '../headroom/elisionMeta'
import { isFirstSightPolicy, type FirstSightPolicy } from '../headroom/elisionPolicy'
import { killUtility } from '../utilityKill'
import { createShedGate, type ShedGate } from '../loopGovernor'

export interface ProxyResultMsg {
  kind: 'result'
  changed: boolean
  stats: WireStats
  usage: Usage
  /** Always sent (proxyMain.resultFrame builds the message, and the compiler holds it to this). The
   *  ledger still reads an absent or malformed one as "not pure", for a child older than the app. */
  turn: TurnShape
  stashes: StashEntry[]
  status: number
  /** The request's model family and effort (proxyMain.requestModelAndEffort); absent from a child older than the app. */
  model?: string
  effort?: string
  /** v1.56.0 routing (proxyMain.routeFields): the terminal, main request, hour cache, a refused routed model. */
  terminal?: string
  main?: boolean
  ttl1h?: boolean
  refused?: string
}

/** Originals committed on the REQUEST path, ahead of the response the token rides back in — the
 *  result message carries them too, but by then Claude may already have called retrieve_full. */
export interface ProxyStashMsg {
  kind: 'stash'
  stashes: StashEntry[]
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
// Prefix decay. The SETTING ships on as of v1.36.0, but this local seed stays false on purpose: it
// is the value the child runs with if reading settings throws, and a failure to read config must
// never be what turns a cache-breaking transform on. index.ts pushes the real value at boot.
let proxyDecay = false
// The first-sight elision policy (elisionPolicy.ts). Like the seed above it is `legacy` until the
// main process says otherwise, and for the same reason: a failure to read settings must never be
// what changes what the model is shown. It is resolved ONCE per run (see setProxyFirstSight).
let proxyFirstSight: FirstSightPolicy = 'legacy'
let firstSightResolved = false
let upstream = 'api.anthropic.com'
let proxyEnabled = true
let started = false
let restartTimes: number[] = []
let stopped = false
// Set by stopProxy, which only the app's quit calls, and never cleared: once the app is going,
// nothing may start a proxy it will not be around to stop.
let shutDown = false
let cooldownTimer: ReturnType<typeof setTimeout> | null = null
// While the event loop is struggling (loopGovernor SHED) the cooldown restart, which forks on main, waits another
// cooldown instead. An ordinary crash restart is NOT gated: a dead proxy breaks every live Claude session on its port.
let cooldownGate: ShedGate | null = null
let resultCb: ((r: ProxyResultMsg) => void) | null = null
let stashCb: ((s: ProxyStashMsg) => void) | null = null
// v1.56.0: the model each routed terminal's next requests run on. Kept here, so a respawned child gets
// them all back with its init instead of quietly sending every session on its own model.
const routes = new Map<string, string>()

export function setProxySpawner(fn: Spawner | null): void { spawner = fn }
export function onProxyResult(cb: ((r: ProxyResultMsg) => void) | null): void { resultCb = cb }
export function onProxyStash(cb: ((s: ProxyStashMsg) => void) | null): void { stashCb = cb }
/** Push the wire compression mode to the child: applied live if a transport is up, and re-sent
 *  on the next (re)spawn's init. Best-effort — a failed post just means the aggressive default
 *  holds in the child, so savings never silently drop. */
export function setProxyMode(m: string): void {
  proxyMode = m
  try { transport?.postMessage(configMessage()) } catch { /* best effort */ }
}

/** Route a terminal's main requests to a model family (modelRoute.ts), or stop routing it (null). */
export function setProxyRoute(terminal: string, family: string | null): void {
  if (family) routes.set(terminal, family)
  else routes.delete(terminal)
  try { transport?.postMessage({ kind: 'route', terminal, family }) } catch { /* best effort: the session runs on its own model */ }
}

/** Every frame carries all of the config, so no frame can undo what another set. */
function configMessage(): { kind: 'config'; mode: string; thinkingCap: number; decay: boolean; firstSight: FirstSightPolicy } {
  return { kind: 'config', mode: proxyMode, thinkingCap: proxyThinkingCap, decay: proxyDecay, firstSight: proxyFirstSight }
}

/** The tier the child runs — floor control may have raised it above the Settings selector. */
export function getProxyMode(): string {
  return proxyMode
}
/** Push the extended-thinking budget ceiling (0 = off) on the same channel as the mode, so a
 *  respawned child re-adopts it from init and can't quietly revert to the user's full budget. */
export function setProxyThinkingCap(n: number): void {
  proxyThinkingCap = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  try { transport?.postMessage(configMessage()) } catch { /* best effort */ }
}
/** Push the prefix-decay flag on the same channel, so a respawned child re-adopts it from init
 *  rather than reverting to the default and silently changing the transform mid-conversation. */
export function setProxyDecay(on: boolean): void {
  proxyDecay = on === true
  try { transport?.postMessage(configMessage()) } catch { /* best effort */ }
}
/**
 * Push the first-sight elision policy. It is taken ONCE per run, from the first usable value, and
 * the child does the same: the proxy serves every Claude session of an app run, and changing which
 * tool results are shortened while they are live would rewrite each cached prefix. A Settings change
 * therefore takes effect when Termpolis next starts; until then this keeps saying what is in force.
 * A value that is not a policy is ignored and spends nothing.
 */
export function setProxyFirstSight(v: unknown): void {
  if (firstSightResolved || !isFirstSightPolicy(v)) return
  proxyFirstSight = v
  firstSightResolved = true
  try { transport?.postMessage(configMessage()) } catch { /* best effort */ }
}
/** The policy the proxy runs, which Settings may have since been changed away from. */
export function getProxyFirstSight(): FirstSightPolicy { return proxyFirstSight }
export function isProxyHealthy(): boolean { return healthy && port > 0 }
export function getProxyPort(): number { return port }

/** The user's master switch (HeadroomSettings.wireProxy). Off = new Claude launches go direct. */
export function setProxyEnabled(on: boolean): void { proxyEnabled = on !== false }
export function isProxyEnabled(): boolean { return proxyEnabled }

/**
 * Variables that mean the user ALREADY routes Anthropic traffic somewhere of their own.
 *
 * The launch env used to be spread over the user's, so a corporate gateway or a LiteLLM
 * ANTHROPIC_BASE_URL was silently replaced by 127.0.0.1 and the proxy then forwarded straight to
 * api.anthropic.com — past the gateway the user had configured. An outbound HTTP(S) proxy has the
 * same shape of problem from the other side: Claude Code honours it, the proxy child does not, so
 * behind one every compressed request would fail upstream. In both cases the only correct move is
 * to step aside and let Claude Code do what the user told it to.
 */
export const USER_ROUTING_ENV: readonly string[] = [
  'ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
]
/** Claude Code's cloud-provider switches. With one on, Claude never talks to api.anthropic.com and
 *  ignores ANTHROPIC_BASE_URL, so the proxy URL would be inert and reporting the session as
 *  compressed would be false. */
export const PROVIDER_SWITCH_ENV: readonly string[] = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
]
/** Marks the base URL as ours, so a Termpolis started from inside a Termpolis terminal isn't fooled
 *  into stepping aside by the parent's proxy URL it inherited. */
export const PROXY_MARKER_ENV = 'TERMPOLIS_HEADROOM_PROXY'

/**
 * Claude Code also takes env vars from the `env` block of its own settings.json, and applies them
 * over the environment it was launched with. Main registers a reader for that block at boot (see
 * setAgentEnvReader); a route set only there must make the proxy step aside just the same.
 */
let agentEnvReader: (() => Record<string, unknown> | null) | null = null
export function setAgentEnvReader(read: (() => Record<string, unknown> | null) | null): void {
  agentEnvReader = read
}

/** An `env` block's string values; empty when it is absent or not an object. */
function stringValues(block: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!block || typeof block !== 'object') return out
  for (const [k, v] of Object.entries(block)) if (typeof v === 'string') out[k] = v
  return out
}

/** The settings.json `env` block, as string values only; empty when unreadable or absent. */
function agentSettingsEnv(): Record<string, string> {
  let block: Record<string, unknown> | null = null
  try { block = agentEnvReader ? agentEnvReader() : null } catch { /* unreadable: nothing set there */ }
  return stringValues(block)
}

/** The first variable that routes the user's Anthropic traffic elsewhere, or null if none does.
 *  `settingsEnv` is the `env` block of the profile the launch runs on: an account's own
 *  settings.json (null when it has none) instead of the default profile's. */
export function userRoutingVar(env: Record<string, string | undefined> = process.env, settingsEnv?: Record<string, unknown> | null): string | null {
  // settings.json wins over the launch env, the way Claude Code applies it.
  env = { ...env, ...(settingsEnv === undefined ? agentSettingsEnv() : stringValues(settingsEnv)) }
  for (const k of USER_ROUTING_ENV) {
    const v = env[k]
    if (typeof v !== 'string' || v.trim() === '') continue
    if (k === 'ANTHROPIC_BASE_URL' && env[PROXY_MARKER_ENV] === v) continue
    return k
  }
  for (const k of PROVIDER_SWITCH_ENV) {
    const v = (env[k] ?? '').trim().toLowerCase()
    if (v !== '' && v !== '0' && v !== 'false') return k
  }
  return null
}

/** The env a Claude launch should inherit — or null to launch direct: the switch is off, the proxy
 *  isn't healthy, or the user's environment already routes Anthropic traffic. `settingsEnv`: as
 *  for userRoutingVar, for a launch on an account's profile. */
export function getProxyEnv(env: Record<string, string | undefined> = process.env, settingsEnv?: Record<string, unknown> | null): Record<string, string> | null {
  if (!proxyEnabled || !isProxyHealthy() || userRoutingVar(env, settingsEnv)) return null
  const url = `http://127.0.0.1:${port}`
  return {
    ANTHROPIC_BASE_URL: url,
    [PROXY_MARKER_ENV]: url,
    CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: '1',
    ENABLE_TOOL_SEARCH: 'true',
  }
}

/** Whether startProxy has been called since the last stop — lets a Settings flip start it lazily. */
export function isProxyStarted(): boolean { return started }

export function startProxy(opts: { port: number; upstreamHost?: string }): void {
  if (shutDown) return
  port = opts.port
  upstream = opts.upstreamHost || 'api.anthropic.com'
  restartTimes = []
  stopped = false
  started = true
  spawnOnce()
}

function spawnOnce(): void {
  if (shutDown) return
  if (!spawner) { healthy = false; return }
  let t: ProxyTransport
  try {
    t = spawner()
  } catch { healthy = false; transport = null; return }
  transport = t
  t.onMessage((m) => {
    const msg = m as { kind?: string; port?: number }
    if (!msg) return
    // Health is the CURRENT child's. A replaced one's last words describe nothing that serves.
    if (msg.kind === 'ready') { if (transport === t) { healthy = true; if (msg.port) port = msg.port } }
    else if (msg.kind === 'error') { if (transport === t) healthy = false }
    else if (msg.kind === 'result' && resultCb) { try { resultCb(m as ProxyResultMsg) } catch { /* best effort */ } }
    else if (msg.kind === 'stash' && stashCb) { try { stashCb(m as ProxyStashMsg) } catch { /* best effort */ } }
  })
  // Only the current child's exit counts. A replaced one dying late used to null out the
  // transport of the child that replaced it -- leaving that one running where stopProxy can't
  // reach it -- and then spawn yet another.
  t.onExit(() => { if (transport !== t) return; healthy = false; transport = null; maybeRestart() })
  try {
    t.postMessage({ kind: 'init', port, upstreamHost: upstream, mode: proxyMode, thinkingCap: proxyThinkingCap, decay: proxyDecay, firstSight: proxyFirstSight })
    // The child freezes what its first init carries, so from here this is the policy for the run.
    firstSightResolved = true
    for (const [terminal, family] of routes) t.postMessage({ kind: 'route', terminal, family })
  } catch { healthy = false }
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
    armCooldown()
    return
  }
  spawnOnce()
}

const COOLDOWN_MS = 30_000

function armCooldown(): void {
  if (cooldownTimer) clearTimeout(cooldownTimer)
  cooldownGate ??= createShedGate('headroomProxy.cooldownRestart')
  cooldownTimer = setTimeout(() => {
    cooldownTimer = null
    if (stopped || healthy) return
    if (cooldownGate?.skip()) { armCooldown(); return } // a fork now would only add to the stall: wait it out
    restartTimes = []
    spawnOnce()
  }, COOLDOWN_MS)
}

function disposeCooldown(): void {
  if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null }
  cooldownGate?.dispose()
  cooldownGate = null
}

export function stopProxy(): void {
  shutDown = true
  stopped = true
  started = false
  disposeCooldown()
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
    kill: () => killUtility(child),
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
  agentEnvReader = null
  disposeCooldown()
  transport = null; healthy = false; port = 0; restartTimes = []; stopped = false; shutDown = false; resultCb = null; stashCb = null; spawner = null; upstream = 'api.anthropic.com'; proxyMode = 'aggressive'; proxyEnabled = true; started = false
  proxyFirstSight = 'legacy'; firstSightResolved = false
  routes.clear()
}
