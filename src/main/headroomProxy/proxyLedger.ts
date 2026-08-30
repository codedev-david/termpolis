import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ccrPut } from '../headroom/ccrStore'
import { recordDepthSample } from '../headroom/sessionDepth'
import type { ProxyResultMsg } from './proxySupervisor'
import { recordProxyOutput } from '../headroom/outputEconomyStore'

export interface ProxyTotals {
  requests: number
  textOrigTokens: number
  textSavedTokens: number
  images: number
  imageOrigBytes: number
  imageSavedBytes: number
  cacheReadTokens: number
  cacheCreationTokens: number
  inputTokens: number
  outputTokens: number
  /** Reversal cost: `retrieve_full` calls redeeming tokens THIS layer issued, and what they cost. */
  retrieves: number
  givebackTokens: number
  /**
   * tool_use input — the agent's OWN output riding in the prefix — tracked apart from
   * tool_result. Generation is billed at output rates and nothing here can change that; what
   * these counters measure is the RE-READ cost, which used to be paid at full size on every
   * later turn because the wire compressor walked straight past tool_use blocks.
   */
  toolUseOrigTokens: number
  toolUseSavedTokens: number
  /**
   * Per-request floor evidence. A lifetime AVERAGE of 50% says nothing about whether any single
   * turn held 50% — roughly half the mass sits below the mean. These two make the claim falsifiable:
   * `worstSavedPct` is the least-compressed request that carried real content, and
   * `belowFloorRequests` counts how many of `floorEligibleRequests` came in under FLOOR_PCT.
   */
  worstSavedPct: number
  belowFloorRequests: number
  floorEligibleRequests: number
  /**
   * The prefix head — `system` and `tools` — which no compression layer touches and which every
   * request re-sends. It is what a cache WRITE pays 1.25x for. Summed as chars, not tokens,
   * because that is what the wire actually sees; divide by ~4 for a token estimate.
   * `tpToolsChars` is the slice Termpolis emits and is therefore the only slice we may shrink.
   * `maxToolCount` is a high-water mark rather than a sum — tool count is a property of a
   * session, and adding it up across requests would produce a number that means nothing.
   */
  sysChars: number
  toolsChars: number
  tpToolsChars: number
  maxToolCount: number
  /**
   * Output steering, measured instead of assumed. Output bills at 5x input and is the single
   * largest slice of this install's effective spend; steering is the only lever pointed at it,
   * and it shipped with nothing recording what it earned. Splitting requests by whether the
   * directive was present turns the claim into an observation: mean output tokens, steered vs
   * not. It is observational, not a controlled trial — a user who turns steering on may also be
   * asking different questions — so it is reported as a comparison, never as a saving.
   */
  steeredRequests: number
  steeredOutputTokens: number
  unsteeredRequests: number
  unsteeredOutputTokens: number
}

/** The floor this release is held to, as a percentage of compressible wire text. */
export const FLOOR_PCT = 50
/** Requests carrying less than this much compressible text are excluded from floor stats: a turn
 *  with one 200-char tool result can't reach 50% and would smear the evidence without informing it. */
const FLOOR_MIN_ORIG_TOKENS = 250
export interface ProxyReceipt {
  session: ProxyTotals & { savedPct: number }
  cumulative: ProxyTotals & { savedPct: number }
}

function empty(): ProxyTotals {
  // worstSavedPct starts at 100 and only ever ratchets DOWN, so an untouched ledger never claims
  // a floor breach it never saw.
  return { requests: 0, textOrigTokens: 0, textSavedTokens: 0, images: 0, imageOrigBytes: 0, imageSavedBytes: 0, cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0, outputTokens: 0, retrieves: 0, givebackTokens: 0, toolUseOrigTokens: 0, toolUseSavedTokens: 0, worstSavedPct: 100, belowFloorRequests: 0, floorEligibleRequests: 0, sysChars: 0, toolsChars: 0, tpToolsChars: 0, maxToolCount: 0, steeredRequests: 0, steeredOutputTokens: 0, unsteeredRequests: 0, unsteeredOutputTokens: 0 }
}

let session = empty()
let base = empty() // cumulative baseline loaded from disk
let flush: (() => void) | null = null

export function setProxyLedgerFlush(fn: (() => void) | null): void { flush = fn }
export function loadProxyBase(b: Partial<ProxyTotals>): void { base = { ...empty(), ...b } }

/**
 * Fold one request into the floor evidence. Requests with too little compressible text to reach
 * the floor at all are counted in neither numerator nor denominator — a turn whose only content
 * is a 200-char tool result is not a floor breach, it is a turn with nothing to compress.
 */
function recordFloorSample(origTokens: number, savedTokens: number): void {
  if (origTokens < FLOOR_MIN_ORIG_TOKENS) return
  const pct = Math.round((savedTokens / origTokens) * 100)
  session.floorEligibleRequests += 1
  if (pct < FLOOR_PCT) session.belowFloorRequests += 1
  if (pct < session.worstSavedPct) session.worstSavedPct = pct
}

/** Record one proxy /v1/messages result: accumulate real savings + usage, and make
 *  compressed originals retrievable via the retrieve_full MCP tool. Best-effort. */
export function recordProxyResult(r: ProxyResultMsg): void {
  const s = r.stats || ({} as ProxyResultMsg['stats'])
  const u = r.usage || ({} as ProxyResultMsg['usage'])
  session.requests += 1
  session.textOrigTokens += Math.ceil((s.trOrigChars || 0) / 4)
  session.textSavedTokens += Math.max(0, Math.ceil(((s.trOrigChars || 0) - (s.trCompChars || 0)) / 4))
  session.toolUseOrigTokens += Math.ceil((s.tuOrigChars || 0) / 4)
  session.toolUseSavedTokens += Math.max(0, Math.ceil(((s.tuOrigChars || 0) - (s.tuCompChars || 0)) / 4))
  recordFloorSample(
    Math.ceil(((s.trOrigChars || 0) + (s.tuOrigChars || 0)) / 4),
    Math.max(0, Math.ceil((((s.trOrigChars || 0) - (s.trCompChars || 0)) + ((s.tuOrigChars || 0) - (s.tuCompChars || 0))) / 4)),
  )
  session.images += s.images || 0
  session.imageOrigBytes += s.imgOrigBytes || 0
  session.imageSavedBytes += Math.max(0, (s.imgOrigBytes || 0) - (s.imgCompBytes || 0))
  session.cacheReadTokens += u.cache_read_input_tokens || 0
  session.cacheCreationTokens += u.cache_creation_input_tokens || 0
  session.inputTokens += u.input_tokens || 0
  session.outputTokens += u.output_tokens || 0
  // Depth curve. Recorded here rather than at the caller so the two meters cannot drift: every
  // request that moves the token ledger moves the curve, or neither does.
  recordDepthSample(s.msgCount || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0)
  // Prefix head. Chars, summed per request, so the cache-write bucket finally has a denominator
  // that can be attributed rather than just observed as a total on the invoice.
  session.sysChars += s.sysChars || 0
  session.toolsChars += s.toolsChars || 0
  session.tpToolsChars += s.tpToolsChars || 0
  if ((s.toolCount || 0) > session.maxToolCount) session.maxToolCount = s.toolCount || 0
  // Split BEFORE the output tokens are added anywhere else, so the two arms always sum to
  // `outputTokens` and a drift between them is immediately visible as a bug rather than noise.
  if (s.steered) { session.steeredRequests += 1; session.steeredOutputTokens += u.output_tokens || 0 }
  else { session.unsteeredRequests += 1; session.unsteeredOutputTokens += u.output_tokens || 0 }
  // The randomized-holdout experiment and the thinking-budget bands. Fed from the same
  // request the ledger just counted, so the experiment can never sample a different
  // population than the invoice does. `s.steered` is what actually reached the model.
  try { recordProxyOutput(!!s.steered, u.output_tokens || 0, s.thinkBudget || 0, s.msgCount || 0, u.cache_read_input_tokens || 0) } catch { /* never fail a request over a stat */ }
  if (Array.isArray(r.stashes)) for (const st of r.stashes) { try { ccrPut(st.token, st.original, 'proxy') } catch { /* best effort */ } }
  try { flush?.() } catch { /* best effort */ }
}

/** Charge one `retrieve_full` give-back to THIS layer — the wire proxy issues the vast majority
 *  of tokens agents actually redeem, and before v1.34.0 every one of them was billed to the
 *  tool-layer ledger instead, which is what made the receipt read negative. */
export function recordProxyGiveback(tokens: number): void {
  session.retrieves += 1
  session.givebackTokens += Math.max(0, tokens)
  try { flush?.() } catch { /* best effort */ }
}

function withPct(t: ProxyTotals): ProxyTotals & { savedPct: number } {
  // Both compressible surfaces share one denominator: quoting tool_result alone was accurate
  // about a slice while implying it described the wire.
  const orig = t.textOrigTokens + t.toolUseOrigTokens
  const saved = t.textSavedTokens + t.toolUseSavedTokens
  const pct = orig > 0 ? Math.round((saved / orig) * 100) : 0
  return { ...t, savedPct: pct }
}
function sumWithBase(): ProxyTotals {
  const cum = empty()
  for (const k of Object.keys(cum) as (keyof ProxyTotals)[]) cum[k] = base[k] + session[k]
  // worstSavedPct is a floor over all requests, not a quantity: summing two 100s would report 200%.
  cum.worstSavedPct = Math.min(base.worstSavedPct, session.worstSavedPct)
  // Same class of mistake in the other direction: maxToolCount is a high-water mark. Two sessions
  // that each saw 30 tools saw 30 tools, not 60.
  cum.maxToolCount = Math.max(base.maxToolCount, session.maxToolCount)
  return cum
}

export function summarizeProxySavings(): ProxyReceipt {
  return { session: withPct(session), cumulative: withPct(sumWithBase()) }
}
export function currentProxyTotals(): ProxyTotals { return sumWithBase() }
export function loadProxyBaseFromDisk(dir: string): void {
  try { loadProxyBase(JSON.parse(readFileSync(join(dir, 'proxy-totals.json'), 'utf8'))) } catch { /* start at zero */ }
}
export function saveProxyTotalsToDisk(dir: string): void {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'proxy-totals.json'), JSON.stringify(currentProxyTotals()), 'utf8') } catch { /* best effort */ }
}
/** Zero the lifetime meter (session + on-disk base) WITHOUT dropping the flush wiring, so the
 *  ledger keeps persisting afterward. Used for a live "reset lifetime savings" (e.g. after a
 *  compression-methodology change) — unlike resetProxyLedger(), which also nulls flush for tests. */
export function resetProxyCounters(): void { session = empty(); base = empty() }
export function resetProxyLedger(): void { session = empty(); base = empty(); flush = null }
