// v1.56.0 per-message routing: is switching model for this one message worth it? Pure.
//
// A switch is not free. Anthropic's prompt cache is kept per model, so the first request on a model the
// session has not used lately reads the whole conversation again at the cache-WRITE price (1.25x)
// instead of the cache-READ price (0.1x). On a 100k-token conversation that one re-read costs more than
// Sonnet saves over Opus on a small answer. So a cheaper model only wins when its price gap pays for the
// re-read, and the gate prices both sides of that trade for the message's likely shape.
//
// v1.57.0: the same holds for effort. Changing `output_config.effort` between requests empties the
// messages cache just as a model switch does, so the cache is warm per model AND effort, and a move to a
// lighter effort must pay for its re-read too. A missing effort is the model's default (effortLevels).

import { effortOrDefault, effortRank, EFFORT_OUT, type EffortLevel } from './effortLevels'

export type RouteFamily = 'opus' | 'sonnet' | 'haiku'

/** List prices, dollars per million tokens. */
export const PRICE: Readonly<Record<RouteFamily, { in: number; out: number }>> = {
  opus: { in: 5, out: 25 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 1, out: 5 },
}

export const CACHE_READ = 0.1
export const CACHE_WRITE = 1.25

/** The likely shape of a message the classifier put in a class: model calls it takes, output tokens it
 *  writes, and context it adds. A Haiku-class message is a quick answer; the others run a tool loop. */
export interface MessageProfile { turns: number; out: number; grow: number }
export const PROFILES: Readonly<Record<RouteFamily, MessageProfile>> = {
  haiku: { turns: 2, out: 800, grow: 1_500 },
  sonnet: { turns: 8, out: 4_000, grow: 12_000 },
  opus: { turns: 8, out: 5_000, grow: 12_000 },
}

/** Past this much context Haiku is never picked: its window is the smallest, and a re-read this big
 *  never pays for itself on a quick answer. */
export const HAIKU_MAX_CTX = 180_000
/** A move UP to a stronger model re-reads the conversation too; past this size it needs the stronger
 *  model's cache to be warm already. */
export const UP_SWITCH_MAX_COLD_CTX = 150_000
/** A move down must save at least this share of the message's cost. */
export const DOWN_MIN_SAVING = 0.1
/** A move up needs the classifier at least this sure. */
export const UP_MIN_CONFIDENCE = 0.6
/** Anthropic's default cache lifetime; one hour when the session asks for it. */
export const TTL_5M = 5 * 60_000
export const TTL_1H = 60 * 60_000

const RANK: Readonly<Record<RouteFamily, number>> = { haiku: 0, sonnet: 1, opus: 2 }

/** What the proxy has seen of one session's traffic. */
export interface Economy {
  /** Tokens in the conversation's last main request (input + cache read + cache write). */
  ctx: number
  /** When each model and effort last answered this session, epoch ms, keyed by warmKey. */
  warm: Partial<Record<string, number>>
  /** How long the cache lives: TTL_5M, or TTL_1H when the session asks for the hour. */
  ttlMs: number
}

export function emptyEconomy(): Economy {
  return { ctx: 0, warm: {}, ttlMs: TTL_5M }
}

/** The cache a request writes to: one per model and effort. */
export function warmKey(f: RouteFamily, effort?: EffortLevel | null): string {
  return `${f}:${effortOrDefault(f, effort)}`
}

export function isWarm(e: Economy, f: RouteFamily, now: number, effort?: EffortLevel | null): boolean {
  const at = e.warm[warmKey(f, effort)]
  return typeof at === 'number' && now - at < e.ttlMs
}

/** Dollars one message is expected to cost on `model`: the first call reads `cached` tokens from cache
 *  and writes the rest, every later call re-reads the context from cache, the context it adds is
 *  written once, and the output is paid at the output price. The profile's output is at high effort;
 *  another `effort` scales it (EFFORT_OUT). */
export function messageCost(model: RouteFamily, ctx: number, cached: number, p: MessageProfile, effort?: EffortLevel | null): number {
  const c = Math.max(0, ctx)
  const hit = Math.min(Math.max(0, cached), c)
  const input = hit * CACHE_READ + (c - hit) * CACHE_WRITE + Math.max(0, p.turns - 1) * c * CACHE_READ + p.grow * CACHE_WRITE
  const out = p.out * (effort ? EFFORT_OUT[effort] : 1)
  return (PRICE[model].in * input + PRICE[model].out * out) / 1e6
}

export interface SwitchInput {
  /** The model the session is on now. */
  current: RouteFamily
  /** The model the classifier wants for this message. */
  want: RouteFamily
  /** 0..1, how sure the classifier is. */
  confidence: number
  economy: Economy
  now: number
  /** v1.57.0: the effort the session runs at now; null/absent = the model's default. */
  currentEffort?: EffortLevel | null
  /** The effort the message wants; null/absent = leave the effort as it is. */
  wantEffort?: EffortLevel | null
}

export interface SwitchDecision {
  /** The model this message runs on. */
  model: RouteFamily
  /** The effort it runs at; null = whatever the session sends (nothing to change). */
  effort: EffortLevel | null
  switched: boolean
  /** same, cheaper, lighter, switch-costs-more, needs-stronger, more-thought, not-sure-enough,
   *  context-too-big, too-big-for-haiku. */
  reason: string
  /** Dollars the pick is expected to save over staying (negative = it costs more, for a stronger model). */
  saving: number
}

/** Stay or switch for one message, model and effort together. A move down (a cheaper model, or the same
 *  model at a lighter effort) must pay for the cache re-read it causes; a move up (a stronger model, or
 *  more effort on the same one) needs a sure classifier and a context small enough, or a cache warm
 *  enough, to re-read. */
export function decideSwitch(i: SwitchInput): SwitchDecision {
  const { current, confidence, economy: e, now } = i
  const have = i.currentEffort ?? null
  let want = i.want
  const stay = (reason: string): SwitchDecision => ({ model: current, effort: have, switched: false, reason, saving: 0 })
  if (want === 'haiku' && e.ctx > HAIKU_MAX_CTX) {
    if (current !== 'haiku') return stay('too-big-for-haiku')
    want = 'sonnet'
  }
  const ce = effortOrDefault(current, have)
  // No effort asked for: the same one on the same model, the target's default on another.
  const we = i.wantEffort ?? (want === current ? ce : effortOrDefault(want, null))
  if (want === current && we === ce) return stay('same')
  const profile = PROFILES[want]
  const cached = (f: RouteFamily, eff: EffortLevel): number => (isWarm(e, f, now, eff) ? e.ctx : 0)
  const costNow = messageCost(current, e.ctx, cached(current, ce), profile, ce)
  const costWant = messageCost(want, e.ctx, cached(want, we), profile, we)
  const saving = costNow - costWant
  const sameModel = want === current
  const go = (reason: string): SwitchDecision => ({ model: want, effort: we, switched: true, reason, saving })
  if (RANK[want] < RANK[current] || (sameModel && effortRank(we) < effortRank(ce))) {
    return costWant <= costNow * (1 - DOWN_MIN_SAVING) ? go(sameModel ? 'lighter' : 'cheaper') : stay('switch-costs-more')
  }
  if (confidence < UP_MIN_CONFIDENCE) return stay('not-sure-enough')
  if (e.ctx > UP_SWITCH_MAX_COLD_CTX && !isWarm(e, want, now, we)) return stay('context-too-big')
  return go(sameModel ? 'more-thought' : 'needs-stronger')
}
