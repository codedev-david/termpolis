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

/** Cache reads bill at 0.1x a fresh input token. */
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
  /** Effective units the compressor kept off the invoice, valued at `prefixTokenWeight`. */
  avoided: number
  /**
   * `avoided / (total + avoided)` — the share of the counterfactual bill that never arrived.
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
  const avoided = netSavedTokens * prefixTokenWeight

  const counterfactual = total + avoided
  return {
    cacheRead, cacheCreation, input, output, total,
    cacheReadPct: pct(cacheRead, total),
    cacheCreationPct: pct(cacheCreation, total),
    inputPct: pct(input, total),
    outputPct: pct(output, total),
    prefixTokenWeight,
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
