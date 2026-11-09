// v1.56.0 per-message routing, main's half: when the user submits a message in a Claude pane, pick the
// model it runs on and tell the proxy (modelRoute.ts), before Claude Code sends the request.
//
// The submit hook (memory-primer-hook.cjs) already calls memory_primer for every typed prompt; the
// prompt branch calls routePrompt here first. The local classifier (routerModel.ts, in the memory
// host) votes in a few milliseconds; the decision is capped at budgetMs, and a vote that comes later
// (the host still loading its model) is dropped: the message runs where the session already is.
//
// The cost gate (switchEconomics.ts) uses what the proxy saw of the session: the context size, which
// models answered it recently (their cache is warm), and whether it asks for the hour-long cache.

import { routeMessage, type RouteEvent } from '../shared/smartRoute'
import { decideSwitch, emptyEconomy, TTL_1H, TTL_5M, type Economy, type RouteFamily } from '../shared/switchEconomics'
import type { ClassifyResult } from './routerModel'
import type { RouterTuning } from '../shared/taskRouter'

export type RouterMode = 'auto-panes' | 'all' | 'off'
export const ROUTER_MODES: readonly RouterMode[] = ['auto-panes', 'all', 'off']
export const DEFAULT_BUDGET_MS = 350
/** A session's first message moves off its launch model only from this sure. */
export const FIRST_MIN_CONFIDENCE = 0.5
const TERMINAL_RE = /^[\w-]{1,128}$/
const RANK: Readonly<Record<RouteFamily, number>> = { haiku: 0, sonnet: 1, opus: 2 }
const BY_RANK: readonly RouteFamily[] = ['haiku', 'sonnet', 'opus']

export type { RouteEvent }

export interface RouterDeps {
  classify: (text: string) => Promise<ClassifyResult>
  setRoute: (terminal: string, family: RouteFamily | null) => void
  notify: (e: RouteEvent) => void
  now?: () => number
  budgetMs?: number
  tuning?: () => RouterTuning | undefined
}

interface TerminalState {
  economy: Economy
  current: RouteFamily | null
  refused: Set<RouteFamily>
  auto: boolean
  pinned: boolean
}

let deps: RouterDeps | null = null
let mode: RouterMode = 'auto-panes'
const terminals = new Map<string, TerminalState>()

export function _resetMessageRouterForTests(): void {
  deps = null; mode = 'auto-panes'; terminals.clear()
}

export function configureRouter(d: RouterDeps): void { deps = d }

export function isRouterMode(v: unknown): v is RouterMode {
  return typeof v === 'string' && (ROUTER_MODES as readonly string[]).includes(v)
}

export function setRouterMode(m: unknown): RouterMode {
  if (isRouterMode(m)) mode = m
  if (mode === 'off' && deps) for (const id of terminals.keys()) deps.setRoute(id, null)
  return mode
}

export function getRouterMode(): RouterMode { return mode }

function isFamily(v: unknown): v is RouteFamily {
  return v === 'opus' || v === 'sonnet' || v === 'haiku'
}

function stateOf(id: string): TerminalState {
  let s = terminals.get(id)
  if (!s) {
    s = { economy: emptyEconomy(), current: null, refused: new Set(), auto: false, pinned: false }
    terminals.set(id, s)
  }
  return s
}

/** A terminal was created; auto = it was launched on Auto (the router may route it in 'auto-panes' mode). */
export function registerTerminal(id: unknown, auto: boolean): void {
  if (typeof id !== 'string' || !TERMINAL_RE.test(id)) return
  const s = stateOf(id)
  s.auto = auto
  s.pinned = false
}

export function forgetTerminal(id: unknown): void {
  if (typeof id !== 'string') return
  if (terminals.delete(id)) deps?.setRoute(id, null)
}

/** The user picked a model by hand for this pane: stop routing it until it is unpinned. */
export function pinTerminal(id: unknown, pinned = true): void {
  if (typeof id !== 'string' || !TERMINAL_RE.test(id)) return
  stateOf(id).pinned = pinned
  if (pinned) deps?.setRoute(id, null)
}

export interface ProxyResultLike {
  terminal?: string
  main?: boolean
  model?: string
  ttl1h?: boolean
  refused?: string
  usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** What the proxy saw of one request: keeps each routed pane's context size and warm caches current. */
export function noteProxyResult(r: ProxyResultLike, now = Date.now()): void {
  const id = r?.terminal
  if (typeof id !== 'string' || !TERMINAL_RE.test(id)) return
  const s = stateOf(id)
  if (isFamily(r.refused)) s.refused.add(r.refused)
  if (!r.main || !isFamily(r.model)) return
  const u = r.usage ?? {}
  const ctx = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
  if (ctx > 0) s.economy.ctx = ctx
  s.economy.warm[r.model] = now
  s.economy.ttlMs = r.ttl1h ? TTL_1H : TTL_5M
  s.current = r.model
}

function eligible(s: TerminalState | undefined): s is TerminalState {
  if (!s || s.pinned || mode === 'off') return false
  return mode === 'all' || s.auto
}

/** The first model up from `f` the API has not refused this pane; f itself when it is fine. */
function allowed(f: RouteFamily, refused: Set<RouteFamily>): RouteFamily | null {
  for (let r = RANK[f]; r < BY_RANK.length; r++) if (!refused.has(BY_RANK[r])) return BY_RANK[r]
  return null
}

async function classifyWithin(text: string, budget: number): Promise<ClassifyResult | null> {
  if (!deps) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budget) })
  try {
    return await Promise.race([deps.classify(text).catch(() => null), late])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Route one submitted message. null when the pane is not routed (or the router is off). */
export async function routePrompt(input: { terminalId?: unknown; prompt?: unknown }): Promise<RouteEvent | null> {
  const id = input?.terminalId
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : ''
  if (!deps || typeof id !== 'string' || !prompt) return null
  const s = terminals.get(id)
  if (!eligible(s)) return null
  const started = (deps.now ?? Date.now)()
  const res = await classifyWithin(prompt, deps.budgetMs ?? DEFAULT_BUDGET_MS)
  // Settings may have changed, the pane been pinned or closed, while the vote ran.
  if (!eligible(s) || terminals.get(id) !== s) return null
  const now = (deps.now ?? Date.now)()
  const route = routeMessage(prompt, res?.cls ?? null, deps.tuning?.())
  const ms = Math.max(res?.ms ?? 0, now - started)
  const base = { terminalId: id, prompt: prompt.slice(0, 2000), from: s.current, label: route.label, source: route.source, confidence: route.confidence, ms }
  if (route.label === 'keep') {
    if (!s.current) return null
    const e: RouteEvent = { ...base, model: s.current, switched: false, reason: 'keep', saving: 0 }
    deps.notify(e)
    return e
  }
  const want = allowed(route.label, s.refused)
  if (!want) return null
  let model: RouteFamily
  let switched: boolean
  let reason: string
  let saving = 0
  // A first message the rules alone call "probably sonnet" stays on the model the pane launched with.
  if (!s.current && route.confidence < FIRST_MIN_CONFIDENCE) return null
  if (!s.current) {
    // The session's first message: nothing is cached yet, so any model starts as cheaply as another.
    model = want; switched = true; reason = 'first'
  } else {
    const d = decideSwitch({ current: s.current, want, confidence: route.confidence, economy: s.economy, now })
    model = d.model; switched = d.switched; reason = d.reason; saving = d.saving
  }
  deps.setRoute(id, model)
  const e: RouteEvent = { ...base, model, switched, reason, saving }
  deps.notify(e)
  return e
}
