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
//
// MODELHOME (2.0): every Claude terminal Termpolis starts is routed. One launched on Auto routes freely,
// as before. Any other starts on its home model (the Default Models pick, the pane's Model menu, or what
// the session itself asks for) and only steps down from it, to a cheaper model by list price, when the
// message is surely simple; the next message that is not goes straight back home. A home the router
// cannot rank by price (Fable, a model it does not know) is not routed at all.

import { routeMessage, routeSubagent, fromHome, clampEffort, type RouteEvent } from '../shared/smartRoute'
import { decideSwitch, emptyEconomy, warmKey, cheaper, priceRank, BY_PRICE, TTL_1H, TTL_5M, type Economy, type RouteFamily } from '../shared/switchEconomics'
import { modelFamily } from './headroom/effectiveUnits'
import { effortOrDefault, isEffort, type EffortLevel } from '../shared/effortLevels'
import type { ClassifyResult } from './routerModel'
import type { RouterTuning } from '../shared/taskRouter'
import type { CodexEffort } from '../shared/smartRoute'

/** MODELHOME: 'every' Claude terminal Termpolis starts (and Codex's on Auto), or 'off'. */
export type RouterMode = 'every' | 'off'
export const ROUTER_MODES: readonly RouterMode[] = ['every', 'off']
/** The modes before 2.0: both now mean 'every'. */
const OLD_MODES = new Set<unknown>(['auto-panes', 'all'])
export const DEFAULT_BUDGET_MS = 350
/** A session's first message moves off its launch model only from this sure. */
export const FIRST_MIN_CONFIDENCE = 0.5
/** A subagent's vote may take this long: its first request waits only briefly, but a later answer
 *  still routes the rest of that subagent's requests. */
export const AGENT_BUDGET_MS = 1500
const TERMINAL_RE = /^[\w-]{1,128}$/
/** A model name the router cannot place, as the pane shows it. */
const NAME_RE = /^[\w.[\]-]{1,64}$/
/** The dearest family: what a terminal whose home is not known yet is measured against. */
const DEAREST: RouteFamily = BY_PRICE[BY_PRICE.length - 1]

export type { RouteEvent }

/** What a terminal's (or a subagent's) requests run on; a null field leaves the request's own. down =
 *  MODELHOME's step down from home: the proxy applies it only to a request that asks for a pricier model. */
export interface RoutePick { family: RouteFamily | null; effort: EffortLevel | null; down?: true }

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
  /** MODELHOME, a terminal not on Auto: the model it starts on and comes back to; null = not known yet. */
  home: RouteFamily | null
  /** Its home is a model the router cannot rank by price (its name): it is not routed. */
  unplaced: string | null
  /** The cheaper model it has been stepped down to, while it is. */
  routed: RouteFamily | null
}

/** Codex's efforts for the router's: it has no max, so max asks for its highest. */
export const CODEX_EFFORT_OF: Readonly<Record<EffortLevel, CodexEffort>> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' }
const CODEX_ASKED = new Set<string>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

let deps: RouterDeps | null = null
let mode: RouterMode = 'every'
const terminals = new Map<string, TerminalState>()

export function _resetMessageRouterForTests(): void {
  deps = null; mode = 'every'; terminals.clear()
}

export function configureRouter(d: RouterDeps): void { deps = d }

export function isRouterMode(v: unknown): v is RouterMode {
  return typeof v === 'string' && (ROUTER_MODES as readonly string[]).includes(v)
}

export function setRouterMode(m: unknown): RouterMode {
  if (isRouterMode(m)) mode = m
  else if (OLD_MODES.has(m)) mode = 'every'
  if (mode === 'off' && deps) for (const [id, s] of terminals) { s.sent = false; s.routed = null; deps.setRoute(id, null) }
  return mode
}

export function getRouterMode(): RouterMode { return mode }

function isFamily(v: unknown): v is RouteFamily {
  return v === 'opus' || v === 'sonnet' || v === 'haiku'
}

function stateOf(id: string): TerminalState {
  let s = terminals.get(id)
  if (!s) {
    s = { economy: emptyEconomy(), current: null, refused: new Set(), auto: false, pinned: false, effort: null, sent: false, escalated: 0, last: null, codex: false, codexEffort: null, home: null, unplaced: null, routed: null }
    terminals.set(id, s)
  }
  return s
}

/** A terminal was created; auto = it was launched on Auto (the router routes it freely); otherwise it
 *  routes from its home model (MODELHOME). codex = a Codex terminal pointed at the proxy (v1.58.0): its
 *  turns' effort is routed, on Auto only. */
export function registerTerminal(id: unknown, auto: boolean, codex = false): void {
  if (typeof id !== 'string' || !TERMINAL_RE.test(id)) return
  const s = stateOf(id)
  s.auto = auto
  s.pinned = false
  s.codex = codex
  s.codexEffort = null
  s.home = null
  s.unplaced = null
  s.routed = null
}

/** A model name as a home: a family the router ranks by price, or the name it shows for one it cannot. */
function placeOf(model: string): { home: RouteFamily } | { unplaced: string } {
  const f = modelFamily(model)
  if (isFamily(f)) return { home: f }
  if (f === 'fable') return { unplaced: 'fable' }
  return { unplaced: NAME_RE.test(model) ? model : 'other' }
}

/** Stop routing a terminal whose home the router cannot place. */
function unroute(id: string, s: TerminalState, always: boolean): void {
  s.routed = null
  if (s.sent || always) { s.sent = false; deps?.setRoute(id, null) }
}

/**
 * MODELHOME: the model this Claude terminal starts on and comes back to, set when it launches on a model
 * of the user's choosing or the user picks one in the pane's Model menu. A model id or alias ('opus',
 * 'claude-sonnet-5-5', 'opusplan'); '' = the agent's own default, learned from the session's first
 * request. Routing carries on from the new home: a step down in force ends.
 */
export function setTerminalHome(id: unknown, model: unknown): void {
  if (typeof id !== 'string' || !TERMINAL_RE.test(id) || typeof model !== 'string') return
  const s = terminals.get(id)
  if (!s) return
  s.auto = false
  s.pinned = false
  const name = model.trim()
  if (!name) { s.home = null; s.unplaced = null }
  else {
    const p = placeOf(name)
    if ('unplaced' in p) { s.home = null; s.unplaced = p.unplaced; unroute(id, s, true); return }
    s.home = p.home; s.unplaced = null
  }
  if (s.routed) { s.routed = null; s.sent = true; deps?.setRoute(id, { family: null, effort: null }) }
}

/** What a home terminal's own request says it asked for: that is its home from now on. */
function learnHome(id: string, s: TerminalState, asked: unknown): void {
  if (typeof asked !== 'string' || !asked) return
  const p = placeOf(asked)
  if ('unplaced' in p) { s.home = null; s.unplaced = p.unplaced; unroute(id, s, false); return }
  s.home = p.home
  s.unplaced = null
  // A step down the proxy will not apply (the session asks for that model or a cheaper one) is not one.
  if (s.routed && !cheaper(s.routed, p.home)) s.routed = null
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
  if (pinned) { s.sent = false; s.routed = null; deps?.setRoute(id, null) }
}

export interface ProxyResultLike {
  terminal?: string
  main?: boolean
  model?: string
  /** MODELHOME: the family the request asked for, when routing sent it on another. */
  asked?: string
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
  if (isFamily(r.refused)) {
    s.refused.add(r.refused)
    if (s.routed === r.refused) s.routed = null
  }
  // MODELHOME: a home terminal's home is what its own requests ask for.
  if (!r.agent && r.main && !s.auto && !s.codex) learnHome(id, s, r.asked ?? r.model)
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
  // A Codex terminal is registered auto unless its command sets its own effort (aiProfiles.ts): that one
  // is left as it is. Every other terminal is routed: freely on Auto, from its home otherwise.
  return s.auto || !s.codex
}

/** The first model up from `f` the API has not refused this pane; f itself when it is fine. */
function allowed(f: RouteFamily, refused: Set<RouteFamily>): RouteFamily | null {
  for (let r = priceRank(f); r < BY_PRICE.length; r++) if (!refused.has(BY_PRICE[r])) return BY_PRICE[r]
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
  if (!s.auto && s.unplaced) return unplacedEvent(id, s, s.unplaced, prompt)
  const started = (deps.now ?? Date.now)()
  const res = await classifyWithin(prompt, deps.budgetMs ?? DEFAULT_BUDGET_MS)
  // Settings may have changed, the pane been pinned or closed, while the vote ran.
  if (!eligible(s) || terminals.get(id) !== s) return null
  const now = (deps.now ?? Date.now)()
  if (!s.auto) return routeFromHome(deps, id, s, prompt, res, started, now)
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

/** A home terminal's home is a model the router cannot place: the message runs on it, and the pane says
 *  why nothing is routed. */
function unplacedEvent(id: string, s: TerminalState, unplaced: string, prompt: string): RouteEvent {
  const e: RouteEvent = {
    terminalId: id, prompt: prompt.slice(0, 2000), model: DEAREST, from: s.current, effort: null, switched: false,
    reason: 'unplaced', unplaced, label: 'keep', source: 'rules', confidence: 0, ms: 0, saving: 0,
  }
  deps?.notify(e)
  return e
}

/** MODELHOME: one message on a terminal with a home model. A surely simple one steps down to the cheaper
 *  model it fits (the first message of a session freely, later ones only when the switch pays for its
 *  re-read, decideSwitch); anything else runs on home, and a step down in force ends at once. Never above
 *  home. Going back home has no cost gate: the user chose home, and a step down was only taken when it
 *  paid. Gating the way back would keep a long conversation whose home cache went cold on the cheaper
 *  model for good. */
function routeFromHome(d: RouterDeps, id: string, s: TerminalState, prompt: string, res: ClassifyResult | null, started: number, now: number): RouteEvent | null {
  if (s.unplaced) return unplacedEvent(id, s, s.unplaced, prompt)
  const home = s.home ?? DEAREST
  const raw = routeMessage(prompt, res?.cls ?? null, d.tuning?.())
  const route = fromHome(raw, home)
  const ms = Math.max(res?.ms ?? 0, now - started)
  s.escalated = 0
  const base = { terminalId: id, prompt: prompt.slice(0, 2000), from: s.current, fromEffort: s.effort, label: raw.label, source: raw.source, confidence: raw.confidence, ms }
  const stay = (): void => { if (!s.sent) { s.sent = true; d.setRoute(id, { family: null, effort: null }) } }
  const done = (e: RouteEvent): RouteEvent => { s.last = e; d.notify(e); return e }
  if (route.label === 'keep') {
    stay()
    if (!s.current) return null
    return done({ ...base, model: s.current, effort: s.effort, switched: false, reason: 'keep', saving: 0 })
  }
  const back = (reason: string, switched: boolean, saving = 0): RouteEvent | null => {
    if (s.routed) { s.routed = null; s.sent = true; d.setRoute(id, { family: null, effort: null }) } else stay()
    // Home not known yet: the message runs on what the session asks for, and there is nothing to say.
    if (!s.home) return null
    return done({ ...base, model: home, effort: null, switched, reason, saving })
  }
  let want = route.label === home ? null : allowed(route.label, s.refused)
  if (want && !cheaper(want, home)) want = null
  if (!want) return back(s.routed ? 'home' : 'at-home', s.routed !== null)
  let model: RouteFamily
  let effort: EffortLevel | null
  let switched = true
  let reason: string
  let saving = 0
  if (!s.current) {
    // The session's first message: nothing is cached yet, so any model starts as cheaply as another.
    model = want; effort = route.effort; reason = 'first'
  } else if (cheaper(s.current, want)) {
    // Up from one step down to a stronger one still under home: the message needs it.
    model = want; effort = route.effort; reason = 'needs-stronger'
  } else {
    const dec = decideSwitch({ current: s.current, want, confidence: route.confidence, economy: s.economy, now, currentEffort: s.effort, wantEffort: route.effort })
    model = dec.model; effort = dec.effort; switched = dec.switched; reason = dec.reason; saving = dec.saving
  }
  if (!cheaper(model, home)) return back(reason, s.current !== home, saving)
  s.sent = true
  s.routed = model
  d.setRoute(id, { family: model, effort, down: true })
  return done({ ...base, model, effort, switched, reason, saving })
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
  if (!eligible(s) || !isFamily(asked) || !task || (!s.auto && s.unplaced)) { set(id, key, null); return null }
  const started = (deps.now ?? Date.now)()
  const res = await classifyWithin(task, Math.max(deps.budgetMs ?? DEFAULT_BUDGET_MS, AGENT_BUDGET_MS))
  if (!eligible(s) || terminals.get(id) !== s || (!s.auto && s.unplaced)) { set(id, key, null); return null }
  const route = routeSubagent(task, res?.cls ?? null, asked, deps.tuning?.())
  if (route.label === 'keep') { set(id, key, { family: null, effort: null }); return null }
  let model = allowed(route.label, s.refused) ?? asked
  const askedEffort = isEffort(q.effort) ? q.effort : null
  let effort = route.effort
  // MODELHOME: a home terminal's subagent never runs above its home, or above what it asked for.
  const cap = !s.auto && s.home && cheaper(asked, s.home) ? s.home : asked
  if (!s.auto && cheaper(cap, model)) { model = cap; effort = clampEffort(cap, effort) }
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
