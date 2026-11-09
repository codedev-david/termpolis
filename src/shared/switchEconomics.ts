// v1.56.0 per-message routing: is switching model for this one message worth it? Pure.
//
// A switch is not free. Anthropic's prompt cache is kept per model, so the first request on a model the
// session has not used lately reads the whole conversation again at the cache-WRITE price (1.25x)
// instead of the cache-READ price (0.1x). On a 100k-token conversation that one re-read costs more than
// Sonnet saves over Opus on a small answer. So a cheaper model only wins when its price gap pays for the
// re-read, and the gate prices both sides of that trade for the message's likely shape.

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
  /** When each model last answered this session, epoch ms. */
  warm: Partial<Record<RouteFamily, number>>
  /** How long the cache lives: TTL_5M, or TTL_1H when the session asks for the hour. */
  ttlMs: number
}

export function emptyEconomy(): Economy {
  return { ctx: 0, warm: {}, ttlMs: TTL_5M }
}

export function isWarm(e: Economy, f: RouteFamily, now: number): boolean {
  const at = e.warm[f]
  return typeof at === 'number' && now - at < e.ttlMs
}

/** Dollars one message is expected to cost on `model`: the first call reads `cached` tokens from cache
 *  and writes the rest, every later call re-reads the context from cache, the context it adds is
 *  written once, and the output is paid at the output price. */
export function messageCost(model: RouteFamily, ctx: number, cached: number, p: MessageProfile): number {
  const c = Math.max(0, ctx)
  const hit = Math.min(Math.max(0, cached), c)
  const input = hit * CACHE_READ + (c - hit) * CACHE_WRITE + Math.max(0, p.turns - 1) * c * CACHE_READ + p.grow * CACHE_WRITE
  return (PRICE[model].in * input + PRICE[model].out * p.out) / 1e6
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
}

export interface SwitchDecision {
  /** The model this message runs on. */
  model: RouteFamily
  switched: boolean
  /** same, cheaper, switch-costs-more, needs-stronger, not-sure-enough, context-too-big, too-big-for-haiku. */
  reason: string
  /** Dollars the pick is expected to save over staying (negative = it costs more, for a stronger model). */
  saving: number
}

/** Stay or switch for one message. A move down must pay for the cache re-read it causes; a move up
 *  needs a sure classifier and a context small enough (or a cache warm enough) to re-read. */
export function decideSwitch(i: SwitchInput): SwitchDecision {
  const { current, confidence, economy: e, now } = i
  let want = i.want
  const stay = (reason: string): SwitchDecision => ({ model: current, switched: false, reason, saving: 0 })
  if (want === 'haiku' && e.ctx > HAIKU_MAX_CTX) {
    if (current !== 'haiku') return stay('too-big-for-haiku')
    want = 'sonnet'
  }
  if (want === current) return stay('same')
  const profile = PROFILES[want]
  const cached = (f: RouteFamily): number => (isWarm(e, f, now) ? e.ctx : 0)
  const costNow = messageCost(current, e.ctx, cached(current), profile)
  const costWant = messageCost(want, e.ctx, cached(want), profile)
  const saving = costNow - costWant
  if (RANK[want] < RANK[current]) {
    return costWant <= costNow * (1 - DOWN_MIN_SAVING)
      ? { model: want, switched: true, reason: 'cheaper', saving }
      : stay('switch-costs-more')
  }
  if (confidence < UP_MIN_CONFIDENCE) return stay('not-sure-enough')
  if (e.ctx > UP_SWITCH_MAX_COLD_CTX && !isWarm(e, want, now)) return stay('context-too-big')
  return { model: want, switched: true, reason: 'needs-stronger', saving }
}
