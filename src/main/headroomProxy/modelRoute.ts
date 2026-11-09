// v1.56.0 per-message routing, the proxy's half: run one message on the model the router picked, in the
// request itself, without touching Claude Code's settings. Typing `/model` into a session would also
// work, and it would write the pick into the shared ~/.claude/settings.json as every account's default.
//
// Each Claude session Termpolis starts carries its terminal's id in a header (ANTHROPIC_CUSTOM_HEADERS,
// shapingEnv.withRouteHeader). Main sets a route per terminal when the user submits a message; the
// proxy then rewrites the `model` of that session's main requests until the next message. What it
// leaves alone:
//   * requests with no tools: Claude Code's own small calls (titles, summaries) on its fast model;
//   * requests on another model than the session's main one: subagents launched on their own model;
//   * fable, and anything it does not recognise.
// A rewritten request the API refuses (400/404: the model is not on this account, a beta it lacks) is
// sent again as it came, and that model is not tried again for that terminal.
//
// The body is never parsed: one substring swap at the top-level `model` key, which Claude Code writes
// first. A JSON round trip could corrupt integers above 2^53 (see wireCompress).

import { modelFamily, type ModelFamily } from '../headroom/effectiveUnits'
import type { RouteFamily } from '../../shared/switchEconomics'

export const ROUTE_HEADER = 'x-termpolis-terminal'
const SESSION_HEADER = 'x-claude-code-session-id'
const TERMINAL_RE = /^[\w-]{1,128}$/
// The top-level key comes first; a `"model"` further in is inside a message.
const MODEL_AT_TOP = /^\s*\{\s*"model"\s*:\s*"([^"\\]{1,120})"/

/** Ids used until the session's own traffic shows the ones this account has. */
export const DEFAULT_MODEL_IDS: Readonly<Record<RouteFamily, string>> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

const ROUTE_FAMILIES: readonly ModelFamily[] = ['opus', 'sonnet', 'haiku']

const routes = new Map<string, RouteFamily>()
const mains = new Map<string, { session: string | null; family: ModelFamily }>()
const seenIds = new Map<RouteFamily, string>()
const refused = new Set<string>()

export function _resetModelRouteForTests(): void {
  routes.clear(); mains.clear(); seenIds.clear(); refused.clear()
}

export function isRouteFamily(v: unknown): v is RouteFamily {
  return typeof v === 'string' && (ROUTE_FAMILIES as readonly string[]).includes(v)
}

/** Route a terminal's main requests to `family` until told otherwise; null stops routing it. */
export function setRoute(terminal: unknown, family: unknown): void {
  if (typeof terminal !== 'string' || !TERMINAL_RE.test(terminal)) return
  if (isRouteFamily(family)) routes.set(terminal, family)
  else routes.delete(terminal)
}

export function routeOf(terminal: string): RouteFamily | undefined {
  return routes.get(terminal)
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

export interface RoutePlan {
  /** The body to send: rewritten, or the original when nothing changes. */
  body: string
  terminal: string | null
  /** The family the request asked for. */
  asked: ModelFamily | null
  /** The family it is sent on (asked, unless rewritten). */
  used: ModelFamily | null
  /** The request is one of the session's main ones (has tools, on the session's model). */
  main: boolean
  /** Set when the model was rewritten: the request as it came, for a retry. */
  original?: string
}

function hasTools(body: string): boolean {
  const at = body.indexOf('"tools":[')
  return at >= 0 && body[at + 9] !== ']'
}

/** What to send for one /v1/messages request. Total: anything unexpected sends the body as it came. */
export function planRequest(body: string, headers: Record<string, string | string[] | undefined>): RoutePlan {
  const terminal = terminalOf(headers)
  const m = MODEL_AT_TOP.exec(body)
  const asked = m ? modelFamily(m[1]) : null
  if (m && isRouteFamily(asked)) seenIds.set(asked, m[1])
  const plain: RoutePlan = { body, terminal, asked, used: asked, main: false }
  if (!terminal || !m || !asked || !hasTools(body)) return plain
  // The first request with tools in a session is the main conversation: subagents start later.
  const session = header(headers, SESSION_HEADER)
  const known = mains.get(terminal)
  if (!known || (session && known.session !== session)) mains.set(terminal, { session, family: asked })
  const main = mains.get(terminal)!.family === asked
  const target = routes.get(terminal)
  if (!main || !target || target === asked || !isRouteFamily(asked) || refused.has(`${terminal}:${target}`)) return { ...plain, main }
  const id = seenIds.get(target) ?? DEFAULT_MODEL_IDS[target]
  const idStart = m.index + m[0].length - 1 - m[1].length // m[0] ends with the id and its closing quote
  const rewritten = body.slice(0, idStart) + id + body.slice(idStart + m[1].length)
  return { body: rewritten, terminal, asked, used: target, main, original: body }
}

/** The API refused a rewritten request: send it as it came, and stop routing this terminal to that model. */
export function noteRefused(terminal: string | null, family: ModelFamily | null): void {
  if (!terminal || !isRouteFamily(family)) return
  refused.add(`${terminal}:${family}`)
  if (routes.get(terminal) === family) routes.delete(terminal)
}

/** A status that means the API would not take the rewritten model. */
export function isRefusal(status: number | undefined): boolean {
  return status === 400 || status === 404
}

/** Does the request ask for the hour-long cache? Then a model it left stays warm for an hour. */
export function asksHourCache(body: string): boolean {
  return body.includes('"ttl":"1h"')
}
