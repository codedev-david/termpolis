// v1.56.0 per-message routing, the renderer's half: the setting (which Claude terminals main routes),
// the chip text a routed message shows in its pane's header, and the "should have been" correction
// that teaches the local classifier. The decision itself is made in main (messageRouter.ts).
import { routerTuning } from './autoModel'
import type { RouteEvent } from '../../../shared/smartRoute'
import { effortOrDefault } from '../../../shared/effortLevels'

// MODELHOME (2.0): one mode routes every Claude terminal Termpolis starts. One on Auto routes freely; any
// other starts on its own model (its home) and the router only moves simple messages down to cheaper ones.
export type RouterMode = 'every' | 'off'
export type RouteLabel = 'keep' | 'haiku' | 'sonnet' | 'opus'
export type RouteModel = 'haiku' | 'sonnet' | 'opus'

/** What main sends on 'router:message'. */
export type { RouteEvent }

export const ROUTER_MODE_KEY = 'termpolis.agent.messageRouting'
export const DEFAULT_ROUTER_MODE: RouterMode = 'every'
export const ROUTER_MODES: ReadonlyArray<{ value: RouterMode; label: string }> = [
  { value: 'every', label: 'Every Claude terminal (steps down from its start model) and Codex' },
  { value: 'off', label: 'Off' },
]
/** The modes saved before 2.0 ('auto-panes', 'all'): both are the one default now. */
const OLD_MODES = ['auto-panes', 'all']

const MODEL_NAME: Readonly<Record<RouteModel, string>> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

function isMode(v: unknown): v is RouterMode {
  return v === 'every' || v === 'off'
}

export function getRouterMode(): RouterMode {
  try {
    const v = localStorage.getItem(ROUTER_MODE_KEY)
    if (v !== null && OLD_MODES.indexOf(v) >= 0) {
      try { localStorage.setItem(ROUTER_MODE_KEY, DEFAULT_ROUTER_MODE) } catch { /* read as the default anyway */ }
      return DEFAULT_ROUTER_MODE
    }
    return isMode(v) ? v : DEFAULT_ROUTER_MODE
  } catch {
    return DEFAULT_ROUTER_MODE
  }
}

/** Tell main which terminals to route and the user's rule tuning. Best effort: main keeps its last. */
export function applyRouterSettings(mode: RouterMode = getRouterMode()): void {
  try {
    void window.termpolis.routerConfigure?.({ mode, tuning: routerTuning() })?.catch(() => { /* main keeps its mode */ })
  } catch { /* API unavailable (tests, an old preload) */ }
}

export function setRouterMode(mode: RouterMode): RouterMode {
  const m = isMode(mode) ? mode : DEFAULT_ROUTER_MODE
  try { localStorage.setItem(ROUTER_MODE_KEY, m) } catch { /* the choice still applies until restart */ }
  applyRouterSettings(m)
  return m
}

export function modelName(m: RouteModel): string {
  return MODEL_NAME[m]
}

/** The chip: the model (and v1.57.0: the effort) this message runs on, an arrow on what moved, and how
 *  long deciding took. A subagent's task says so; a raise for failing tool calls says that instead of a time. */
export function routeChipText(e: RouteEvent): string {
  // MODELHOME: a terminal whose model the router cannot rank by price is not routed.
  if (e.reason === 'unplaced') return `${unplacedName(e.unplaced)} · not routed`
  // v1.58.0: a Codex turn keeps its model; only the effort moves.
  if (e.codex) {
    const effort = e.switched && e.codex.from && e.codex.from !== e.codex.effort ? `${e.codex.from} → ${e.codex.effort}` : e.codex.effort
    return `Codex · ${effort} · ${Math.max(0, Math.round(e.ms))} ms`
  }
  const tail = e.reason === 'struggling' ? 'more thought' : `${Math.max(0, Math.round(e.ms))} ms`
  const model = e.switched && e.from && e.from !== e.model ? `${modelName(e.from)} → ${modelName(e.model)}` : modelName(e.model)
  let effort = ''
  if (e.effort) {
    const before = e.from ? effortOrDefault(e.from, e.fromEffort) : null
    effort = e.switched && before && before !== e.effort && (!e.from || e.from === e.model) ? ` · ${before} → ${e.effort}` : ` · ${e.effort}`
  }
  return `${e.agent ? 'Subagent: ' : ''}${model}${effort} · ${tail}`
}

/** The name of a model the router cannot place, as the chip shows it. */
function unplacedName(name: string | undefined): string {
  if (!name || name === 'other') return 'This model'
  return name === 'fable' ? 'Fable' : name
}

const REASON: Readonly<Record<string, string>> = {
  first: 'the first message picks the model the conversation starts on',
  keep: 'a confirmation stays on the model doing the work',
  same: 'this message fits the model already running',
  cheaper: 'a cheaper model fits, and it costs less even after re-reading the conversation',
  'switch-costs-more': 'a cheaper model fits, but re-reading the conversation on it would cost more than it saves',
  'needs-stronger': 'this message needs a stronger model',
  'not-sure-enough': 'a stronger model might fit, but not surely enough to pay for the switch',
  'context-too-big': 'a stronger model might fit, but re-reading this long a conversation costs too much',
  'too-big-for-haiku': 'Haiku would fit, but the conversation is too long for it',
  lighter: 'this message needs less thought, and the lower effort costs less even after re-reading the conversation',
  'more-thought': 'this message needs more thought on the same model',
  agent: "a subagent's task, routed on its own: its conversation is new, so nothing cached is lost",
  struggling: 'its tool calls kept failing, so it gets more thought until your next message',
  codex: 'this message fits this effort; Codex keeps its model',
  home: 'this message is not surely simple, so it goes back to the model this terminal started on',
  'at-home': 'this message is not surely simple, so it stays on the model this terminal started on',
}

/** The chip's tooltip: why, who decided, and what it is expected to save. */
export function routeChipTitle(e: RouteEvent): string {
  if (e.reason === 'unplaced') {
    return `${unplacedName(e.unplaced)} is not one the router can rank by price, so this terminal's messages all run on it. Pick another model in the Model menu to have simple messages moved to cheaper ones.`
  }
  const why = REASON[e.reason] ?? e.reason
  const who = e.source === 'rules' ? 'the word rules' : e.source === 'both' ? 'the local model and the word rules' : 'the local model'
  const pct = Math.round(Math.max(0, Math.min(1, e.confidence)) * 100)
  const money = e.saving > 0.0005 ? ` Expected saving on this message: $${e.saving.toFixed(3)}.` : ''
  const what = e.agent ? 'This subagent runs' : 'This message runs'
  const effort = e.effort ? ` at ${e.effort} effort` : ''
  const where = e.codex ? `at ${e.codex.effort} effort in Codex` : `on ${modelName(e.model)}${effort}`
  return `${what} ${where}: ${why}. Decided on this computer by ${who} (${pct}% sure).${money} Pick what it should have been to teach the router.`
}

/** The user says the message should have gone to `label`: the classifier keeps it as an example. */
export function teachRoute(e: RouteEvent, label: RouteLabel): void {
  try {
    void window.termpolis.routerLearn?.({ prompt: e.prompt, label })?.catch(() => { /* a lost example */ })
  } catch { /* API unavailable */ }
}

/** MODELHOME: the model this Claude terminal starts on and comes back to: its launch model, or the one the
 *  user picked in its Model menu. Routing carries on from it. */
export function setRouteHome(terminalId: string, model: string): void {
  try {
    void window.termpolis.routerHome?.({ terminalId, model })?.catch(() => { /* main learns it from the session */ })
  } catch { /* API unavailable */ }
}

/** The user picked this pane's model by hand: the router leaves it alone from now on. */
export function pinRoute(terminalId: string): void {
  try {
    void window.termpolis.routerPin?.({ terminalId, pinned: true })?.catch(() => { /* main routes on */ })
  } catch { /* API unavailable */ }
}
