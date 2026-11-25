/**
 * Effective-unit accounting — the honest denominator.
 *
 * Every savings figure Termpolis printed before v1.36.0 was `saved / compressible`: a truthful
 * statement about the slice of the wire the compressor is allowed to touch, and a badly misleading
 * one about the invoice. Tool text is not what you pay for. On a real 117k-request sample the bill
 * split into cache reads 47.8%, output 33.2%, cache creation 18.5%, fresh input 0.54% of effective
 * units — so a "51% saving" on tool text was moving a rounding error and reporting a landslide.
 *
 * The fix is not to compress harder, it is to quote the right ratio. These weights are Anthropic's
 * published per-token multipliers relative to one fresh input token, and every number this module
 * produces is denominated in those units rather than in raw tokens.
 */

import { PRICE, ratesAt, type RouteFamily } from '../../shared/switchEconomics'

/** Cache reads, as a share of a fresh input token, for a bill whose model is not known: Haiku's 0.1x, the
 *  dearest share any family has. Opus and Sonnet read at 0.05x and Fable at 0.025x (Anthropic published
 *  first-party rates, 2026-11-03, in switchEconomics.PRICE); modelUnits uses the family's own. */
export const W_CACHE_READ = 0.1
/** Writing a cache entry bills at 1.25x — you pay a quarter extra now to pay a tenth later. */
export const W_CACHE_WRITE = 1.25
/** Fresh (uncached) input is the unit itself. */
export const W_INPUT = 1
/** Output is the expensive one, and it is the bucket compression cannot reach directly. */
export const W_OUTPUT = 5

/** The four lines an Anthropic invoice is made of. */
export type BillBucket = 'cacheRead' | 'cacheCreation' | 'input' | 'output'

/** The four billed token counters, as the proxy ledger records them. */
export interface BillableTokens {
  cacheReadTokens: number
  cacheCreationTokens: number
  inputTokens: number
  outputTokens: number
  /**
   * Effective units the turns that only fetched elided text cost (the proxy ledger's
   * `retrievalTurnUnits`). Already inside the four counters above, because those turns were billed;
   * it is named here so the saving can be netted of what eliding made the session spend. Absent
   * reads as none, which is every ledger written before v1.55.
   */
  retrievalTurnUnits?: number
}

export interface BillBreakdown {
  /** Effective units actually billed, per bucket. */
  cacheRead: number
  cacheCreation: number
  input: number
  output: number
  /** Sum of the four buckets — what the invoice would say, in units. */
  total: number
  /** Each bucket's share of `total`, as a percentage to one decimal. */
  cacheReadPct: number
  cacheCreationPct: number
  inputPct: number
  outputPct: number
  /**
   * Blended cost of one prefix token, derived from the observed read/create mix. This is the
   * empirical amortization: a token kept out of the prefix is paid for once at create weight and
   * then re-read at read weight on every later turn, and the ratio the sample already exhibits is
   * the best available estimate of how many times "later" happens.
   */
  prefixTokenWeight: number
  /** Effective units the compressor kept off the invoice, valued at `prefixTokenWeight`, BEFORE the
   *  cost of the turns that fetched elided text. `netSavedTokens` already carries the text that
   *  came back, but not the turn that asked for it. */
  grossAvoided: number
  /** Effective units those turns cost: the cached prefix they re-read and the call they wrote. */
  retrievalTurnUnits: number
  /** `grossAvoided - retrievalTurnUnits`: billed units avoided, net of the retrieval turns. This is
   *  the headline, and it can be negative: the turns can cost more than the eliding saved. */
  avoided: number
  /**
   * `avoided / (total + avoided)` — the share of the counterfactual bill that never arrived.
   * The invoice already contains the retrieval turns, so what the bill would have been without
   * eliding is `total + avoided`, with `avoided` net of them.
   * This is the only savings figure in the codebase whose denominator is the whole invoice.
   */
  totalBillSavedPct: number
}

function pct(part: number, whole: number): number {
  if (!(whole > 0)) return 0
  return Math.round((part / whole) * 1000) / 10
}

/**
 * @param t      billed token counters
 * @param netSavedTokens  tokens removed from the wire, already net of retrieve_full givebacks.
 *                        Negative is legal and is reported as a negative saving: a ledger that
 *                        clamps at zero is the same lie in a smaller font.
 */
export function billBreakdown(t: BillableTokens, netSavedTokens: number): BillBreakdown {
  const cacheRead = t.cacheReadTokens * W_CACHE_READ
  const cacheCreation = t.cacheCreationTokens * W_CACHE_WRITE
  const input = t.inputTokens * W_INPUT
  const output = t.outputTokens * W_OUTPUT
  const total = cacheRead + cacheCreation + input + output

  const prefixTokens = t.cacheReadTokens + t.cacheCreationTokens
  // With no cache activity observed there is no blend to infer, and an uncached token bills as
  // fresh input by definition — so W_INPUT is the answer, not a fallback.
  const prefixTokenWeight = prefixTokens > 0 ? (cacheRead + cacheCreation) / prefixTokens : W_INPUT
  const grossAvoided = netSavedTokens * prefixTokenWeight
  const retrievalTurnUnits = t.retrievalTurnUnits ?? 0
  const avoided = grossAvoided - retrievalTurnUnits

  const counterfactual = total + avoided
  return {
    cacheRead, cacheCreation, input, output, total,
    cacheReadPct: pct(cacheRead, total),
    cacheCreationPct: pct(cacheCreation, total),
    inputPct: pct(input, total),
    outputPct: pct(output, total),
    prefixTokenWeight,
    grossAvoided,
    retrievalTurnUnits,
    avoided,
    totalBillSavedPct: counterfactual > 0 ? Math.round((avoided / counterfactual) * 1000) / 10 : 0,
  }
}

/** The bucket carrying the largest share of the bill — what any next optimisation should target. */
export function dominantBucket(b: BillBreakdown): BillBucket {
  const pairs: [BillBucket, number][] = [
    ['cacheRead', b.cacheRead], ['cacheCreation', b.cacheCreation],
    ['input', b.input], ['output', b.output],
  ]
  let best = pairs[0]
  for (const p of pairs) if (p[1] > best[1]) best = p
  return best[0]
}

/** The Claude model families a request is told by. Only the family word is ever kept (no build ids), so nothing
 *  identifying a model version reaches the ledger file or telemetry. */
export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other'

/** The family a model id belongs to: `claude-opus-5-5` is opus, `opusplan` is opus, anything unrecognised is other. */
export function modelFamily(id: unknown): ModelFamily {
  if (typeof id !== 'string') return 'other'
  const s = id.toLowerCase()
  if (s.includes('opus')) return 'opus'
  if (s.includes('sonnet')) return 'sonnet'
  if (s.includes('haiku')) return 'haiku'
  if (s.includes('fable')) return 'fable'
  return 'other'
}

/** The price card a family bills at; an unknown one is billed as Opus. */
function cardOf(f: ModelFamily): (typeof PRICE)[RouteFamily] {
  return f === 'other' ? PRICE.opus : PRICE[f]
}

/** Per-family weight against opus: its input rate over Opus's, read from the router's one price list
 *  (switchEconomics.PRICE), so a price change moves both. Anthropic publishes no subscription weights, so
 *  wherever these are shown they carry MODEL_WEIGHT_NOTE. Unknown families weigh as opus: never under-count. */
export const MODEL_WEIGHTS: Readonly<Record<ModelFamily, number>> = {
  opus: 1,
  sonnet: PRICE.sonnet.in / PRICE.opus.in,
  haiku: PRICE.haiku.in / PRICE.opus.in,
  fable: PRICE.fable.in / PRICE.opus.in,
  other: 1,
}
export const MODEL_WEIGHT_NOTE = 'API-price weighting; subscription weights unpublished'

/** Effective units of a set of billed tokens, weighted for the model family that billed them. `prompt` is
 *  the request's prompt size (input, cache reads and writes), when the bill is one request's: above a
 *  family's long-prompt line (Haiku's 100K) it weighs at that tier's rate (ratesAt), as it is billed.
 *  Without it (a bill summed over requests) the family's base rate stands. */
export function modelUnits(t: BillableTokens, model: string, prompt?: number): number {
  const f: ModelFamily = Object.prototype.hasOwnProperty.call(MODEL_WEIGHTS, model) ? (model as ModelFamily) : modelFamily(model)
  const units = t.cacheReadTokens * cardOf(f).cacheRead + t.cacheCreationTokens * W_CACHE_WRITE + t.inputTokens * W_INPUT + t.outputTokens * W_OUTPUT
  const weight = f !== 'other' && prompt !== undefined ? ratesAt(f, prompt).in / PRICE.opus.in : MODEL_WEIGHTS[f]
  return units * weight
}
