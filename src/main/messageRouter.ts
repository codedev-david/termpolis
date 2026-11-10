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
//
// v1.57.0: the route carries an effort as well, a subagent's task is routed when its first request
// reaches the proxy (routeAgentTask), and the proxy's raise of the effort while tool calls keep failing
// is shown on the pane (reason 'struggling').
//
// v1.58.0: a Codex terminal's new typed message reaches the proxy as a request (codexRoute.ts), which
// asks routeCodexTurn for the effort the turn runs at. Codex keeps its model; only the effort moves.

import { routeMessage, routeSubagent, type RouteEvent } from '../shared/smartRoute'
import { decideSwitch, emptyEconomy, warmKey, TTL_1H, TTL_5M, type Economy, type RouteFamily } from '../shared/switchEconomics'
import { effortOrDefault, isEffort, type EffortLevel } from '../shared/effortLevels'
import type { ClassifyResult } from './routerModel'
import type { RouterTuning } from '../shared/taskRouter'
import type { CodexEffort } from '../shared/smartRoute'

export type RouterMode = 'auto-panes' | 'all' | 'off'
export const ROUTER_MODES: readonly RouterMode[] = ['auto-panes', 'all', 'off']
export const DEFAULT_BUDGET_MS = 350
/** A session's first message moves off its launch model only from this sure. */
export const FIRST_MIN_CONFIDENCE = 0.5
/** A subagent's vote may take this long: its first request waits only briefly, but a later answer
 *  still routes the rest of that subagent's requests. */
export const AGENT_BUDGET_MS = 1500
const TERMINAL_RE = /^[\w-]{1,128}$/
const RANK: Readonly<Record<RouteFamily, number>> = { haiku: 0, sonnet: 1, opus: 2 }
const BY_RANK: readonly RouteFamily[] = ['haiku', 'sonnet', 'opus']

export type { RouteEvent }

/** What a terminal's (or a subagent's) requests run on; a null field leaves the request's own. */
export interface RoutePick { family: RouteFamily | null; effort: EffortLevel | null }

export interface RouterDeps {
  classify: (text: string) => Promise<ClassifyResult>
  /** null stops routing the terminal; a pick with both fields null keeps it routed with nothing to change. */
  setRoute: (terminal: string, pick: RoutePick | null) => void
  /** A subagent's route (null = leave it alone). Without it subagents are not routed. */
  setAgentRoute?: (terminal: string, key: number, pick: RoutePick | null) => void
  /** v1.58.0: a Codex turn's effort (null = as Codex asked). Without it Codex terminals are not routed. */
  setCodexRoute?: (terminal: string, key: number, effort: CodexEffort | null) => void
  /** A routed Codex terminal closed: the proxy drops what it kept for it. */
  forgetCodex?: (terminal: string) => void
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
  /** v1.57.0: the effort the main requests last ran at; null = the model's default. */
  effort: EffortLevel | null
  /** A route has been sent since the pane was last unrouted. */
  sent: boolean
  /** Levels the proxy has raised the effort of the current message by. */
  escalated: number
  /** The last message's event, the base of a 'struggling' one. */
  last: RouteEvent | null
  /** v1.58.0: a Codex terminal (its turns come through routeCodexTurn). */
  codex: boolean
  /** The effort the Codex terminal's last routed turn ran at; a confirmation keeps it. */
  codexEffort: CodexEffort | null
}

/** Codex's efforts for the router's: it has no max, so max asks for its highest. */
export const CODEX_EFFORT_OF: Readonly<Record<EffortLevel, CodexEffort>> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' }
const CODEX_ASKED = new Set<string>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

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
  if (mode === 'off' && deps) for (const [id, s] of terminals) { s.sent = false; deps.setRoute(id, null) }
  return mode
}

export function getRouterMode(): RouterMode { return mode }

function isFamily(v: unknown): v is RouteFamily {
  return v === 'opus' || v === 'sonnet' || v === 'haiku'
}

function stateOf(id: string): TerminalState {
  let s = terminals.get(id)
  if (!s) {
    s = { economy: emptyEconomy(), current: null, refused: new Set(), auto: false, pinned: false, effort: null, sent: false, escalated: 0, last: null, codex: false, codexEffort: null }
    terminals.set(id, s)
  }
  return s
}

/** A terminal was created; auto = it was launched on Auto (the router may route it in 'auto-panes' mode).
 *  codex = a Codex terminal pointed at the proxy (v1.58.0): its turns' effort is routed. */
export function registerTerminal(id: unknown, auto: boolean, codex = false): void {
  if (typeof id !== 'string' || !TERMINAL_RE.test(id)) return
  const s = stateOf(id)
  s.auto = auto
  s.pinned = false
  s.codex = codex
  s.codexEffort = null
}

export function forgetTerminal(id: unknown): void {
  if (typeof id !== 'string') return
  const s = terminals.get(id)
  if (!s) return
  terminals.delete(id)
  deps?.setRoute(id, null)
  if (s.codex) deps?.forgetCodex?.(id)
}

/** The user picked a model by hand for this pane: stop routing it until it is unpinned. */
export function pinTerminal(id: unknown, pinned = true): void {
  if (typeof id !== 'string' || !TERMINAL_RE.test(id)) return
  const s = stateOf(id)
  s.pinned = pinned
  if (pinned) { s.sent = false; deps?.setRoute(id, null) }
}

export interface ProxyResultLike {
  terminal?: string
  main?: boolean
  model?: string
  ttl1h?: boolean
  refused?: string
  effort?: string
  agent?: boolean
  escalated?: number
  usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** What the proxy saw of one request: keeps each routed pane's context size and warm caches current. */
export function noteProxyResult(r: ProxyResultLike, now = Date.now()): void {
  const id = r?.terminal
  if (typeof id !== 'string' || !TERMINAL_RE.test(id)) return
  const s = stateOf(id)
  if (isFamily(r.refused)) s.refused.add(r.refused)
  // A subagent's context is its own: it says nothing of the session's size or warm caches.
  if (r.agent || !r.main || !isFamily(r.model)) return
  const u = r.usage ?? {}
  const ctx = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
  if (ctx > 0) s.economy.ctx = ctx
  const effort = isEffort(r.effort) ? r.effort : null
  s.economy.warm[warmKey(r.model, effort)] = now
  s.economy.ttlMs = r.ttl1h ? TTL_1H : TTL_5M
  const fromEffort = s.effort
  s.current = r.model
  s.effort = effort
  const level = n(r.escalated)
  if (level > s.escalated) {
    s.escalated = level
    if (deps && eligible(s)) {
      const last = s.last
      deps.notify({
        terminalId: id, prompt: last?.prompt ?? '', model: r.model, from: r.model, effort, fromEffort,
        switched: true, reason: 'struggling', label: last?.label ?? r.model, source: last?.source ?? 'rules',
        confidence: last?.confidence ?? 1, ms: 0, saving: 0,
      })
    }
  }
}

function eligible(s: TerminalState | undefined): s is TerminalState {
  if (!s || s.pinned || mode === 'off') return false
  // A Codex terminal is registered auto unless its command sets its own effort (aiProfiles.ts).
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
  // A Codex terminal's messages reach the router from its proxy (routeCodexTurn), never from here.
  if (!eligible(s) || s.codex) return null
  const started = (deps.now ?? Date.now)()
  const res = await classifyWithin(prompt, deps.budgetMs ?? DEFAULT_BUDGET_MS)
  // Settings may have changed, the pane been pinned or closed, while the vote ran.
  if (!eligible(s) || terminals.get(id) !== s) return null
  const now = (deps.now ?? Date.now)()
  const route = routeMessage(prompt, res?.cls ?? null, deps.tuning?.())
  const ms = Math.max(res?.ms ?? 0, now - started)
  s.escalated = 0 // a new message: the proxy raises its effort afresh if its tool calls keep failing
  const base = { terminalId: id, prompt: prompt.slice(0, 2000), from: s.current, fromEffort: s.effort, label: route.label, source: route.source, confidence: route.confidence, ms }
  // Nothing to change: the pane stays routed (or becomes so), so its subagents are still routed and a
  // struggling message can still get more thought.
  const stay = (): void => { if (!s.sent) { s.sent = true; deps?.setRoute(id, { family: null, effort: null }) } }
  if (route.label === 'keep') {
    stay()
    if (!s.current) return null
    const e: RouteEvent = { ...base, model: s.current, effort: s.effort, switched: false, reason: 'keep', saving: 0 }
    s.last = e
    deps.notify(e)
    return e
  }
  const want = allowed(route.label, s.refused)
  // A first message the rules alone call "probably sonnet" stays on the model the pane launched with.
  if (!want || (!s.current && route.confidence < FIRST_MIN_CONFIDENCE)) { stay(); return null }
  let model: RouteFamily
  let effort: EffortLevel | null
  let switched: boolean
  let reason: string
  let saving = 0
  if (!s.current) {
    // The session's first message: nothing is cached yet, so any model and effort start as cheaply as another.
    model = want; effort = route.effort; switched = true; reason = 'first'
  } else {
    const d = decideSwitch({ current: s.current, want, confidence: route.confidence, economy: s.economy, now, currentEffort: s.effort, wantEffort: route.effort })
    model = d.model; effort = d.effort; switched = d.switched; reason = d.reason; saving = d.saving
  }
  s.sent = true
  deps.setRoute(id, { family: model, effort })
  const e: RouteEvent = { ...base, model, effort, switched, reason, saving }
  s.last = e
  deps.notify(e)
  return e
}

/** A subagent's first request reached the proxy: route its task, on its own. Its conversation is new,
 *  so nothing is cached that a switch would lose. null when it is left as it asked. */
export async function routeAgentTask(q: { terminal?: unknown; key?: unknown; task?: unknown; asked?: unknown; effort?: unknown }): Promise<RouteEvent | null> {
  const id = q?.terminal
  const key = q?.key
  if (!deps?.setAgentRoute || typeof id !== 'string' || typeof key !== 'number') return null
  const set = deps.setAgentRoute
  const task = typeof q.task === 'string' ? q.task.trim() : ''
  const s = terminals.get(id)
  const asked = q.asked
  if (!eligible(s) || !isFamily(asked) || !task) { set(id, key, null); return null }
  const started = (deps.now ?? Date.now)()
  const res = await classifyWithin(task, Math.max(deps.budgetMs ?? DEFAULT_BUDGET_MS, AGENT_BUDGET_MS))
  if (!eligible(s) || terminals.get(id) !== s) { set(id, key, null); return null }
  const route = routeSubagent(task, res?.cls ?? null, asked, deps.tuning?.())
  if (route.label === 'keep') { set(id, key, { family: null, effort: null }); return null }
  const model = allowed(route.label, s.refused) ?? asked
  const askedEffort = isEffort(q.effort) ? q.effort : null
  const effort = route.effort
  set(id, key, { family: model, effort })
  const e: RouteEvent = {
    terminalId: id, prompt: task.slice(0, 2000), model, from: asked, effort, fromEffort: askedEffort, agent: true,
    switched: model !== asked || effort !== effortOrDefault(asked, askedEffort), reason: 'agent',
    label: route.label, source: route.source, confidence: route.confidence,
    ms: Math.max(res?.ms ?? 0, (deps.now ?? Date.now)() - started), saving: 0,
  }
  deps.notify(e)
  return e
}

/**
 * v1.58.0: a Codex terminal's user typed a new message, and its first request is waiting at the proxy:
 * the effort the turn runs at. Always answers (null = as Codex asked). There is no cost gate: OpenAI's
 * prompt cache is keyed on the input, so an effort change re-reads nothing, and the model never changes.
 */
export async function routeCodexTurn(q: { terminal?: unknown; key?: unknown; task?: unknown; asked?: unknown }): Promise<RouteEvent | null> {
  const id = q?.terminal
  const key = q?.key
  if (!deps?.setCodexRoute || typeof id !== 'string' || typeof key !== 'number') return null
  const set = deps.setCodexRoute
  const task = typeof q.task === 'string' ? q.task.trim() : ''
  const s = terminals.get(id)
  if (!eligible(s) || !s.codex || !task) { set(id, key, null); return null }
  const asked = typeof q.asked === 'string' && CODEX_ASKED.has(q.asked) ? q.asked : null
  const started = (deps.now ?? Date.now)()
  const res = await classifyWithin(task, deps.budgetMs ?? DEFAULT_BUDGET_MS)
  if (!eligible(s) || terminals.get(id) !== s) { set(id, key, null); return null }
  const route = routeMessage(task, res?.cls ?? null, deps.tuning?.())
  let effort: CodexEffort | null
  let reason: string
  if (route.label === 'keep') {
    // A confirmation carries on at the effort the work was running at.
    effort = s.codexEffort; reason = 'keep'
  } else if (route.confidence < FIRST_MIN_CONFIDENCE) {
    effort = null; reason = 'not-sure-enough'
  } else {
    effort = route.label === 'haiku' ? 'low' : CODEX_EFFORT_OF[route.effort]
    reason = 'codex'
  }
  set(id, key, effort)
  if (!effort) return null
  const from = s.codexEffort ?? asked
  s.codexEffort = effort
  const e: RouteEvent = {
    terminalId: id, prompt: task.slice(0, 2000), model: route.label === 'keep' ? 'sonnet' : route.label, from: null,
    codex: { effort, from }, switched: effort !== asked, reason,
    label: route.label, source: route.source, confidence: route.confidence,
    ms: Math.max(res?.ms ?? 0, (deps.now ?? Date.now)() - started), saving: 0,
  }
  s.last = e
  deps.notify(e)
  return e
}
