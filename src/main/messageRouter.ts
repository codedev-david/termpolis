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
// the session's first request asks for) and only steps down from it, to a cheaper model by list price,
// when the message is surely simple; the next message that is not goes straight back home. Fable is
// ranked like the others: from a Fable home a message the classifier puts in its top class (Opus) stays
// on Fable. A home the router cannot rank by price (a model it does not know) is not routed at all.
//
// A Codex terminal whose command sets its own reasoning effort is routed the same way: that effort is its
// home, and a turn's effort only steps down from it.

import { routeMessage, routeSubagent, fromHome, clampEffort, DOWN_MIN_CONFIDENCE, TOP_LABEL, type RouteEvent } from '../shared/smartRoute'
import { decideSwitch, emptyEconomy, warmKey, cheaper, priceRank, BY_PRICE, TTL_1H, TTL_5M, type Economy, type RouteFamily } from '../shared/switchEconomics'
import { modelFamily } from './headroom/effectiveUnits'
import { effortOrDefault, effortRank, isEffort, type EffortLevel } from '../shared/effortLevels'
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
/** `home` (a subagent's pick): it is a home pane's, so struggling raises it no higher than the pane's own
 *  effort. */
export interface RoutePick { family: RouteFamily | null; effort: EffortLevel | null; down?: true; home?: true }

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
  /** The home was picked (the launch model, the Model menu), not learned: requests never change it. */
  explicit: boolean
  /** Its home is a model the router cannot rank by price (its name): it is not routed. */
  unplaced: string | null
  /** The cheaper model it has been stepped down to, while it is. */
  routed: RouteFamily | null
  /** What the session's own requests last asked for (a /model typed in it moves this, not the home):
   *  what a message left alone runs on. null = not seen since the home was set. */
  asks: RouteFamily | null
}

/** Codex's efforts for the router's: it has no max, so max asks for its highest. */
export const CODEX_EFFORT_OF: Readonly<Record<EffortLevel, CodexEffort>> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' }
/** Codex's efforts, lightest first. */
const CODEX_EFFORTS: readonly CodexEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
const isCodexEffort = (v: unknown): v is CodexEffort => typeof v === 'string' && (CODEX_EFFORTS as readonly string[]).includes(v)
const lighterCodex = (a: CodexEffort, b: CodexEffort): boolean => CODEX_EFFORTS.indexOf(a) < CODEX_EFFORTS.indexOf(b)

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
  return typeof v === 'string' && (BY_PRICE as readonly string[]).includes(v)
}

function stateOf(id: string): TerminalState {
  let s = terminals.get(id)
  if (!s) {
    s = { economy: emptyEconomy(), current: null, refused: new Set(), auto: false, effort: null, sent: false, escalated: 0, last: null, codex: false, codexEffort: null, home: null, explicit: false, unplaced: null, routed: null, asks: null }
    terminals.set(id, s)
  }
  return s
}

/** A terminal was created; auto = it was launched on Auto (the router routes it freely); otherwise it
 *  routes from its home model (MODELHOME). codex = a Codex terminal pointed at the proxy (v1.58.0): its
 *  turns' effort is routed: freely on Auto, down from the command's own effort otherwise. */
export function registerTerminal(id: unknown, auto: boolean, codex = false): void {
  if (typeof id !== 'string' || !TERMINAL_RE.test(id)) return
  const s = stateOf(id)
  s.auto = auto
  s.codex = codex
  s.codexEffort = null
  s.home = null
  s.explicit = false
  s.unplaced = null
  s.routed = null
  s.asks = null
}

/** A model name as a home: a family the router ranks by price, or the name it shows for one it cannot. */
function placeOf(model: string): { home: RouteFamily } | { unplaced: string } {
  const f = modelFamily(model)
  if (isFamily(f)) return { home: f }
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
 * 'claude-sonnet-5-5', 'opusplan', which is an Opus home); '' = the agent's own default, learned from the
 * session's first request. A picked home stays until the next pick: what the session's requests ask for
 * later never moves it. Routing carries on from the new home: a step down in force ends.
 */
export function setTerminalHome(id: unknown, model: unknown): void {
  if (typeof id !== 'string' || !TERMINAL_RE.test(id) || typeof model !== 'string') return
  const s = terminals.get(id)
  if (!s) return
  s.auto = false
  s.asks = null
  const name = model.trim()
  s.explicit = name !== ''
  if (!name) { s.home = null; s.unplaced = null }
  else {
    const p = placeOf(name)
    if ('unplaced' in p) { s.home = null; s.unplaced = p.unplaced; unroute(id, s, true); return }
    s.home = p.home; s.unplaced = null
  }
  if (s.routed) { s.routed = null; s.sent = true; deps?.setRoute(id, { family: null, effort: null }) }
}

/** What a home terminal's own request asked for. The first one is an "Agent's own default" home; a
 *  picked home, or one learned already, stays. Either way a step down the proxy will not apply (the
 *  session asks for that model or a cheaper one) is not one. */
function learnHome(id: string, s: TerminalState, asked: unknown): void {
  if (typeof asked !== 'string' || !asked) return
  const p = placeOf(asked)
  const learned = !s.explicit && s.home === null && s.unplaced === null
  if (learned) {
    if ('unplaced' in p) { s.unplaced = p.unplaced; unroute(id, s, false); return }
    s.home = p.home
  }
  if ('home' in p && s.routed && !cheaper(s.routed, p.home)) {
    s.routed = null
    // The message routed before the home was known picked a model not under it, so the proxy ran it on
    // what the session asked for: its chip is put right (review M-1).
    const last = s.last
    if (learned && last?.switched && deps) {
      const e: RouteEvent = { ...last, model: p.home, effort: null, switched: false, saving: 0,
        reason: stayReason(last.label, last.confidence, p.home) }
      s.last = e
      deps.notify(e)
    }
  }
}

/** Why a message that is not stepped down stays home. Only a vote sure enough to step down, naming no
 *  model above home, has a reason other than at-home ("not surely simple"): nothing-cheaper when home is
 *  the cheapest model there is, same when the message fits what runs (home, or the cheaper model the
 *  session asks for: `top`), refused when the cheaper models it fits were refused by the API in this
 *  terminal (review R2-M2). */
function stayReason(label: 'keep' | RouteFamily, confidence: number, home: RouteFamily, top: RouteFamily = home): string {
  if (label === 'keep' || label === TOP_LABEL || confidence < DOWN_MIN_CONFIDENCE || cheaper(home, label)) return 'at-home'
  if (priceRank(home) === 0) return 'nothing-cheaper'
  return cheaper(label, top) ? 'refused' : 'same'
}

export function forgetTerminal(id: unknown): void {
  if (typeof id !== 'string') return
  const s = terminals.get(id)
  if (!s) return
  terminals.delete(id)
  deps?.setRoute(id, null)
  if (s.codex) deps?.forgetCodex?.(id)
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
  if (!r.agent && r.main && !s.auto && !s.codex) {
    const asked = r.asked ?? r.model
    learnHome(id, s, asked)
    s.asks = isFamily(asked) ? asked : null
  }
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

/** Every terminal is routed while the router is on: freely on Auto, from its home otherwise (a Codex
 *  terminal whose command sets its own effort is registered as a home one, aiProfiles.ts). */
function eligible(s: TerminalState | undefined): s is TerminalState {
  return !!s && mode !== 'off'
}

/** The first model up from `f` (no higher than `ceiling`) the API has not refused this pane; f itself
 *  when it is fine. A climb past a refused model never reaches above the ceiling: an Auto pane's is Opus,
 *  the classifier's top class, so nothing is ever routed up to Fable. */
function allowed(f: RouteFamily, refused: Set<RouteFamily>, ceiling: RouteFamily): RouteFamily | null {
  for (let r = Math.min(priceRank(f), priceRank(ceiling)); r <= priceRank(ceiling); r++) if (!refused.has(BY_PRICE[r])) return BY_PRICE[r]
  return null
}

/** A home pane's last resort once the climb to its ceiling is refused: the first model down from the
 *  ceiling the API has not refused this pane. null when every one at or below it is. */
function allowedBelow(ceiling: RouteFamily, refused: Set<RouteFamily>): RouteFamily | null {
  for (let r = priceRank(ceiling); r >= 0; r--) if (!refused.has(BY_PRICE[r])) return BY_PRICE[r]
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
  // Settings may have changed, or the pane been closed, while the vote ran.
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
  const want = allowed(route.label, s.refused, TOP_LABEL)
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
    // Left alone, the message runs on what the session asks for. A /model typed in it (which Termpolis
    // does not see) or opusplan outside plan mode asks for another model than home: the chip names that
    // one, with the home beside it.
    const runs = s.asks ?? home
    return done({ ...base, model: runs, effort: null, switched, reason, saving, ...(runs !== home ? { home } : {}) })
  }
  // A step down must be under what the message would run on left alone: home, or a cheaper model the
  // session itself asks for (a /model typed in it). The proxy never moves a request up, so a target above
  // that would name a switch that is not made (review R2-M1).
  const top = s.asks && cheaper(s.asks, home) ? s.asks : home
  let want = route.label === home ? null : allowed(route.label, s.refused, home)
  if (want && !cheaper(want, top)) want = null
  if (!want) return back(s.routed ? 'home' : stayReason(raw.label, raw.confidence, home, top), s.routed !== null)
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
  if (!cheaper(model, top)) return back(reason, s.current !== home, saving)
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
  if (route.label === 'keep') { set(id, key, { family: null, effort: null, ...(s.auto ? {} : { home: true as const }) }); return null }
  // MODELHOME: a home terminal's subagent never runs above its home, or above what it asked for: the
  // ceiling is the cheaper of the two. An Auto pane's may go up, as far as Opus (or Fable, if it asked
  // for Fable). Past a refused model, a home pane's looks down from the ceiling before it gives up and
  // runs as it asked.
  const ceiling = s.auto ? (cheaper(asked, TOP_LABEL) ? TOP_LABEL : asked) : (s.home && cheaper(s.home, asked) ? s.home : asked)
  const model = allowed(route.label, s.refused, ceiling) ?? (s.auto ? null : allowedBelow(ceiling, s.refused)) ?? asked
  const askedEffort = isEffort(q.effort) ? q.effort : null
  let effort = model === route.label ? route.effort : clampEffort(model, route.effort)
  // Nor does it think harder than it asked (its model's default when it named no effort).
  if (!s.auto) {
    const cap = effortOrDefault(model, askedEffort)
    if (effortRank(effort) > effortRank(cap)) effort = cap
  }
  set(id, key, { family: model, effort, ...(s.auto ? {} : { home: true as const }) })
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
 * MODELHOME: a terminal whose command sets its own effort has that effort as its home; a turn only steps
 * down from it, and only when the classifier is sure (DOWN_MIN_CONFIDENCE), as a Claude home does.
 */
export async function routeCodexTurn(q: { terminal?: unknown; key?: unknown; task?: unknown; asked?: unknown }): Promise<RouteEvent | null> {
  const id = q?.terminal
  const key = q?.key
  if (!deps?.setCodexRoute || typeof id !== 'string' || typeof key !== 'number') return null
  const set = deps.setCodexRoute
  const task = typeof q.task === 'string' ? q.task.trim() : ''
  const s = terminals.get(id)
  const asked = isCodexEffort(q.asked) ? q.asked : null
  // A home effort the router cannot read: nothing to measure a step down against.
  if (!eligible(s) || !s.codex || !task || (!s.auto && !asked)) { set(id, key, null); return null }
  const started = (deps.now ?? Date.now)()
  const res = await classifyWithin(task, deps.budgetMs ?? DEFAULT_BUDGET_MS)
  if (!eligible(s) || terminals.get(id) !== s) { set(id, key, null); return null }
  const route = routeMessage(task, res?.cls ?? null, deps.tuning?.())
  let effort: CodexEffort | null
  let reason: string
  const home = s.auto ? null : asked
  // The effort the message would run at on Auto.
  const routed = (): CodexEffort => (route.label === 'haiku' ? 'low' : CODEX_EFFORT_OF[route.effort])
  if (route.label === 'keep') {
    // A confirmation carries on at the effort the work was running at, never above home.
    effort = s.codexEffort && home && !lighterCodex(s.codexEffort, home) ? home : s.codexEffort; reason = 'keep'
  } else if (home) {
    const down = routed()
    effort = route.confidence >= DOWN_MIN_CONFIDENCE && lighterCodex(down, home) ? down : home
    reason = effort === home ? 'at-home' : 'codex'
  } else if (route.confidence < FIRST_MIN_CONFIDENCE) {
    effort = null; reason = 'not-sure-enough'
  } else {
    effort = routed()
    reason = 'codex'
  }
  // A home terminal at its home effort: the request goes as Codex sent it.
  set(id, key, home && effort === home ? null : effort)
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
