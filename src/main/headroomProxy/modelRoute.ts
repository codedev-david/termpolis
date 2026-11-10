// v1.56.0 per-message routing, the proxy's half: run one message on the model the router picked, in the
// request itself, without touching Claude Code's settings. Typing `/model` into a session would also
// work, and it would write the pick into the shared ~/.claude/settings.json as every account's default.
//
// Each Claude session Termpolis starts carries its terminal's id in a header (ANTHROPIC_CUSTOM_HEADERS,
// shapingEnv.withRouteHeader). Main sets a route per terminal when the user submits a message; the
// proxy then rewrites the `model` of that session's main requests until the next message. What it
// leaves alone:
//   * requests with no tools: Claude Code's own small calls (titles, summaries) on its fast model;
//   * fable, and anything it does not recognise.
// A rewritten request the API refuses (400/404: the model is not on this account, a beta it lacks) is
// sent again as it came, and that model is not tried again for that terminal.
//
// The body is never re-serialized: one substring swap at the top-level `model` key, which Claude Code
// writes first. A JSON round trip could corrupt integers above 2^53 (see wireCompress).
//
// v1.57.0 adds three things, each still a substring edit of the body as it came:
//   * effort: the route carries an effort too, written into the top-level `output_config.effort` (the
//     last top-level key Claude Code writes). A model's default level is the same as none.
//   * subagents: wireCompress already parses each body once; it hands this file the conversation's key
//     (a hash of its first user message), so a subagent on the session's own model is told apart from
//     the main conversation. A subagent's first request asks main (the local classifier) to route its
//     task, waits a moment for the answer, and every later request of that subagent follows it.
//   * struggling: when tool calls keep failing since the user's last message, the effort goes up a
//     level (two after a longer run) for the rest of that message. Never the model: a model switch in
//     the middle of a tool loop would leave the earlier thinking behind.

import { modelFamily, type ModelFamily } from '../headroom/effectiveUnits'
import { armOf } from '../headroom/elisionPolicy'
import type { RouteFamily } from '../../shared/switchEconomics'
import { bumpEffort, effortOrDefault, effortRank, isEffort, type EffortLevel } from '../../shared/effortLevels'

export const ROUTE_HEADER = 'x-termpolis-terminal'
const SESSION_HEADER = 'x-claude-code-session-id'
const TERMINAL_RE = /^[\w-]{1,128}$/
// The top-level key comes first; a `"model"` further in is inside a message.
const MODEL_AT_TOP = /^\s*\{\s*"model"\s*:\s*"([^"\\]{1,120})"/
const EFFORT_IN = /"effort"\s*:\s*"([a-z]{1,10})"/
/** The top-level `output_config` sits at the end of the body; one further in belongs to something else. */
const OUTPUT_CONFIG_TAIL = 4_000
/** How long a subagent's first request waits for main to route its task. Later answers still apply. */
export const AGENT_WAIT_MS = 300
/** Tool turns in a row with a failed call, since the user's last message, before the effort goes up one
 *  level; STRUGGLE_TWO for a second. */
export const STRUGGLE_ONE = 2
export const STRUGGLE_TWO = 4
/** Raising the effort re-reads the conversation at the cache-write price: not past this size of body. */
export const ESCALATE_MAX_BODY = 600_000
/** The highest level struggling raises a message to. */
export const ESCALATE_CAP: EffortLevel = 'xhigh'
/** The first message of a conversation Claude Code compacted: the main conversation under a new key. */
const CONTINUED = 'This session is being continued from a previous conversation'
const MAX_TRACKED = 500

/** Ids used until the session's own traffic shows the ones this account has. */
export const DEFAULT_MODEL_IDS: Readonly<Record<RouteFamily, string>> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

const ROUTE_FAMILIES: readonly ModelFamily[] = ['opus', 'sonnet', 'haiku']

/** What a terminal's (or a subagent's) requests run on. null fields leave the request's own. */
export interface RouteTarget { family: RouteFamily | null; effort: EffortLevel | null }
type AgentTarget = RouteTarget & { off?: boolean }

/** A subagent's task, for main to route. */
export interface AgentAsk { terminal: string; key: number; task: string; asked: RouteFamily; effort: EffortLevel | null }

/** What one parsed body says about its conversation (readConversation). */
export interface ConvInfo {
  /** Hash of the first user message (elisionPolicy.armOf); 0 = nothing to hash. */
  key: number
  /** The first user message's last text that is not a system reminder: a subagent's task. */
  task: string
  /** The first message is a compaction summary. */
  continued: boolean
  /** The longest run of tool turns with a failed call since the user's last typed message. */
  struggle: number
  /** Index of that typed message in `messages`. */
  human: number
}

const routes = new Map<string, RouteTarget>()
const mains = new Map<string, { session: string | null; family: ModelFamily; key: number }>()
const seenIds = new Map<RouteFamily, string>()
const refused = new Set<string>()
const refusedEffort = new Set<string>()
const agents = new Map<string, AgentTarget | 'pending'>()
const waiters = new Map<string, Array<() => void>>()
const escalations = new Map<string, { human: number; level: number }>()
let asker: ((q: AgentAsk) => void) | null = null

export function _resetModelRouteForTests(): void {
  routes.clear(); mains.clear(); seenIds.clear(); refused.clear(); refusedEffort.clear()
  agents.clear(); waiters.clear(); escalations.clear(); asker = null
}

export function isRouteFamily(v: unknown): v is RouteFamily {
  return typeof v === 'string' && (ROUTE_FAMILIES as readonly string[]).includes(v)
}

function capped<K, V>(m: Map<K, V>, k: K, v: V): void {
  m.delete(k)
  m.set(k, v)
  if (m.size > MAX_TRACKED) m.delete(m.keys().next().value as K)
}

/** Route a terminal's main requests to `family` and `effort` until told otherwise. Both null with `on`
 *  keeps the terminal routed with nothing to change (struggling can still raise its effort, its
 *  subagents are still routed); both null without it stops routing the terminal. */
export function setRoute(terminal: unknown, family: unknown, effort?: unknown, on?: unknown): void {
  if (typeof terminal !== 'string' || !TERMINAL_RE.test(terminal)) return
  const f = isRouteFamily(family) ? family : null
  const e = isEffort(effort) ? effort : null
  if (f || e || on === true) routes.set(terminal, { family: f, effort: e })
  else routes.delete(terminal)
}

export function routeOf(terminal: string): RouteFamily | undefined {
  return routes.get(terminal)?.family ?? undefined
}

export function routeTargetOf(terminal: string): RouteTarget | undefined {
  return routes.get(terminal)
}

/** Who asks main to route a subagent's task (proxyMain posts it to the parent). */
export function setAgentAsker(fn: ((q: AgentAsk) => void) | null): void { asker = fn }

/** Main's answer for a subagent. `on` false = leave that subagent alone. */
export function setAgentRoute(terminal: unknown, key: unknown, family: unknown, effort: unknown, on: unknown = true): void {
  if (typeof terminal !== 'string' || !TERMINAL_RE.test(terminal) || typeof key !== 'number' || !Number.isInteger(key) || key <= 0) return
  const id = `${terminal}:${key}`
  const target: AgentTarget = on === false
    ? { family: null, effort: null, off: true }
    : { family: isRouteFamily(family) ? family : null, effort: isEffort(effort) ? effort : null }
  capped(agents, id, target)
  const w = waiters.get(id)
  waiters.delete(id)
  if (w) for (const done of w) done()
}

/** Main's answer for that subagent, as last set; 'pending' while it is being asked. */
export function agentRouteOf(terminal: string, key: number): AgentTarget | 'pending' | undefined {
  return agents.get(`${terminal}:${key}`)
}

/** Resolves when main has answered for that subagent, or after `ms`, whichever is first. */
export function waitAgentRoute(ask: AgentAsk, ms = AGENT_WAIT_MS): Promise<void> {
  const id = `${ask.terminal}:${ask.key}`
  if (agents.get(id) !== 'pending') return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms)
    const list = waiters.get(id) ?? []
    list.push(() => { clearTimeout(timer); resolve() })
    waiters.set(id, list)
  })
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = headers[name]
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' ? s.trim() : null
}

/** The terminal a request came from, when its session carries the header. */
export function terminalOf(headers: Record<string, string | string[] | undefined>): string | null {
  const t = header(headers, ROUTE_HEADER)
  return t && TERMINAL_RE.test(t) ? t : null
}

type Block = { type?: unknown; text?: unknown; is_error?: unknown }

function blocksOf(m: { content?: unknown }): Block[] | string | null {
  const c = m.content
  if (typeof c === 'string') return c
  return Array.isArray(c) ? (c.filter((b) => b !== null && typeof b === 'object') as Block[]) : null
}

/** What a parsed request body says about its conversation. null when it has no messages. Reads only. */
export function readConversation(obj: unknown): ConvInfo | null {
  const messages = (obj !== null && typeof obj === 'object') ? (obj as { messages?: unknown }).messages : undefined
  if (!Array.isArray(messages)) return null
  let first: Block[] | string | null | undefined
  let human = -1
  let run = 0
  let struggle = 0
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null
    if (!m || typeof m !== 'object' || m.role !== 'user') continue
    const blocks = blocksOf(m)
    if (first === undefined) first = blocks
    const results = Array.isArray(blocks) ? blocks.filter((b) => b.type === 'tool_result') : []
    if (results.length === 0) { human = i; run = 0; struggle = 0; continue }
    run = results.some((b) => b.is_error === true) ? run + 1 : 0
    if (run > struggle) struggle = run
  }
  const texts = typeof first === 'string' ? [first]
    : (first ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string)
  const own = texts.filter((t) => !t.trimStart().startsWith('<system-reminder>'))
  const task = (own.length > 0 ? own[own.length - 1] : '').trim().slice(0, 2000)
  return { key: armOf(obj).key, task, continued: texts.some((t) => t.includes(CONTINUED)), struggle, human }
}

export interface RoutePlan {
  /** The body to send: rewritten, or the original when nothing changes. */
  body: string
  terminal: string | null
  /** The family the request asked for. */
  asked: ModelFamily | null
  /** The family it is sent on (asked, unless rewritten). */
  used: ModelFamily | null
  /** The request is one of the session's main ones (has tools, in the session's main conversation). */
  main: boolean
  /** Set when the body was rewritten: the request as it came, for a retry. */
  original?: string
  /** v1.57.0: the effort the request names, and the one it is sent with (each when known). */
  askedEffort?: EffortLevel
  effort?: EffortLevel
  modelChanged?: boolean
  effortChanged?: boolean
  /** A subagent's request (with tools, another conversation in the same session). */
  agent?: boolean
  /** Levels struggling raised the effort by. */
  escalated?: number
  /** Set on a subagent's first request: main has been asked to route it (waitAgentRoute, then plan again). */
  ask?: AgentAsk
}

function hasTools(body: string): boolean {
  const at = body.indexOf('"tools":[')
  return at >= 0 && body[at + 9] !== ']'
}

/** The request's own effort: in the top-level `output_config`, the last key Claude Code writes. */
export function bodyEffort(body: string): EffortLevel | undefined {
  const at = body.lastIndexOf('"output_config"')
  if (at < 0 || at < body.length - OUTPUT_CONFIG_TAIL) return undefined
  const e = EFFORT_IN.exec(body.slice(at, at + 400))
  return e && isEffort(e[1]) ? e[1] : undefined
}

/** The body with its top-level effort set to `effort`, by substring; null when that cannot be done
 *  safely (an `output_config` that is not at the end, or an effort in it too far in to find). */
export function withEffort(body: string, effort: EffortLevel): string | null {
  const at = body.lastIndexOf('"output_config"')
  if (at >= 0) {
    if (at < body.length - OUTPUT_CONFIG_TAIL) return null
    const e = EFFORT_IN.exec(body.slice(at, at + 400))
    if (e) {
      const start = at + e.index + e[0].length - 1 - e[1].length
      return body.slice(0, start) + effort + body.slice(start + e[1].length)
    }
    if (body.indexOf('"effort"', at) >= 0) return null
    const open = /^"output_config"\s*:\s*\{\s*/.exec(body.slice(at, at + 200))
    if (!open) return null
    const after = at + open[0].length
    return body.slice(0, after) + `"effort":"${effort}"` + (body[after] === '}' ? '' : ',') + body.slice(after)
  }
  const end = body.trimEnd()
  if (!end.endsWith('}')) return null
  const close = end.length - 1
  const empty = /\{\s*$/.test(end.slice(0, close))
  return body.slice(0, close) + `${empty ? '' : ','}"output_config":{"effort":"${effort}"}` + body.slice(close)
}

/** Levels the effort goes up for a conversation whose tool calls keep failing. Once raised it stays
 *  raised until the user's next message, so a run that ends (or a body that grows past the limit) does
 *  not flip it back and empty the cache a second time. */
function escalation(terminal: string, conv: ConvInfo | null | undefined, bodyLength: number): number {
  if (!conv || !conv.key) return 0
  const id = `${terminal}:${conv.key}`
  const prev = escalations.get(id)
  const kept = prev && prev.human === conv.human ? prev.level : 0
  const want = conv.struggle >= STRUGGLE_TWO ? 2 : conv.struggle >= STRUGGLE_ONE ? 1 : 0
  const level = want > kept && bodyLength <= ESCALATE_MAX_BODY ? want : kept
  if (level > 0 || prev) capped(escalations, id, { human: conv.human, level })
  return level
}

/** Is this request the session's main conversation? Updates what is known of it. */
function isMain(terminal: string, session: string | null, asked: ModelFamily, key: number, continued: boolean): boolean {
  const known = mains.get(terminal)
  // The first request with tools in a session is the main conversation: subagents start later.
  if (!known || (session && known.session !== session)) {
    mains.set(terminal, { session, family: asked, key })
    return true
  }
  if (known.key && key) {
    if (key === known.key) return true
    // Compaction starts the main conversation again under a new first message.
    if (continued && asked === known.family) { known.key = key; return true }
    return false
  }
  // No key to tell them apart (a body too big to parse): a different model is a subagent.
  const main = known.family === asked
  if (main && key) known.key = key
  return main
}

/** What to send for one /v1/messages request. Total: anything unexpected sends the body as it came.
 *  `conv` is what wireCompress's parse of the same body found (readConversation); without it a
 *  subagent on the session's own model counts as main, and struggling is not seen. */
export function planRequest(body: string, headers: Record<string, string | string[] | undefined>, conv?: ConvInfo | null): RoutePlan {
  const terminal = terminalOf(headers)
  const m = MODEL_AT_TOP.exec(body)
  const asked = m ? modelFamily(m[1]) : null
  if (m && isRouteFamily(asked)) seenIds.set(asked, m[1])
  const askedEffort = bodyEffort(body)
  const plain: RoutePlan = { body, terminal, asked, used: asked, main: false, ...(askedEffort ? { askedEffort, effort: askedEffort } : {}) }
  if (!terminal || !m || !asked || !hasTools(body)) return plain
  const key = conv?.key ?? 0
  const main = isMain(terminal, header(headers, SESSION_HEADER), asked, key, conv?.continued === true)
  if (!isRouteFamily(asked)) return { ...plain, main }
  let target: RouteTarget | undefined
  const agent = !main && key > 0
  if (main) target = routes.get(terminal)
  else if (agent) {
    const id = `${terminal}:${key}`
    const a = agents.get(id)
    if (a === undefined && asker && conv?.task && routes.has(terminal)) {
      const ask: AgentAsk = { terminal, key, task: conv.task, asked, effort: askedEffort ?? null }
      capped(agents, id, 'pending')
      try { asker(ask) } catch { /* nothing routes it: it runs as it asked */ }
      return { ...plain, main, agent, ask }
    }
    if (a && a !== 'pending' && !a.off && routes.has(terminal)) target = a
  }
  if (!target) return agent ? { ...plain, main, agent } : { ...plain, main }
  // The model.
  let out = body
  let used: RouteFamily = asked
  const family = target.family
  if (family && family !== asked && !refused.has(`${terminal}:${family}`)) {
    const id = seenIds.get(family) ?? DEFAULT_MODEL_IDS[family]
    const idStart = m.index + m[0].length - 1 - m[1].length // m[0] ends with the id and its closing quote
    out = body.slice(0, idStart) + id + body.slice(idStart + m[1].length)
    used = family
  }
  // The effort: the route's, raised while tool calls keep failing; nothing to write when it is the level
  // the request runs at anyway.
  const level = escalation(terminal, conv, body.length)
  const have = effortOrDefault(used, askedEffort)
  const base: EffortLevel = target.effort ?? (used === asked ? have : effortOrDefault(used, null))
  const want = level > 0 ? bumpEffort(base, level, ESCALATE_CAP) : base
  let effortChanged = false
  if (want !== have && !refusedEffort.has(terminal)) {
    const next = withEffort(out, want)
    if (next !== null) { out = next; effortChanged = true }
  }
  const modelChanged = used !== asked
  const sentEffort = effortChanged ? want : askedEffort
  const res: RoutePlan = { body: out, terminal, asked, used, main }
  if (askedEffort) res.askedEffort = askedEffort
  if (sentEffort) res.effort = sentEffort
  if (agent) res.agent = true
  // Raised above the route's level: reported whether it took a write or the request already ran there.
  if ((effortChanged || want === have) && effortRank(want) > effortRank(base)) res.escalated = effortRank(want) - effortRank(base)
  if (modelChanged || effortChanged) Object.assign(res, { original: body, modelChanged, effortChanged })
  return res
}

/** The API refused a rewritten request: send it as it came, and stop routing this terminal to that
 *  model (and, when the effort was changed too, stop changing its effort). */
export function noteRefused(terminal: string | null, family: ModelFamily | null, effort = false): void {
  if (!terminal) return
  if (effort) refusedEffort.add(terminal)
  if (!isRouteFamily(family)) return
  refused.add(`${terminal}:${family}`)
  const r = routes.get(terminal)
  if (r?.family === family) routes.set(terminal, { family: null, effort: r.effort })
}

/** A status that means the API would not take the rewritten request. */
export function isRefusal(status: number | undefined): boolean {
  return status === 400 || status === 404
}

/** Does the request ask for the hour-long cache? Then a model it left stays warm for an hour. */
export function asksHourCache(body: string): boolean {
  return body.includes('"ttl":"1h"')
}
