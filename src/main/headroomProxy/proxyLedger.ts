import { readFileSync } from 'fs'
import { join } from 'path'
import { offMainFiles } from '../offMainFiles'
import { ccrPut } from '../headroom/ccrStore'
import { recordDepthSample } from '../headroom/sessionDepth'
import type { ProxyResultMsg } from './proxySupervisor'
import { recordProxyOutput } from '../headroom/outputEconomyStore'
import { W_CACHE_READ, W_CACHE_WRITE, W_INPUT, W_OUTPUT } from '../headroom/effectiveUnits'
import { recordArmRequest, settleArmHop, armState, loadArmState, resetArmLedger, type LedgerArm } from '../headroom/armLedger'
import { recordRedemption, resetElisionLedger } from '../headroom/elisionLedger'
import { loadElisionFromDisk, saveElisionToDisk } from '../headroom/elisionStore'
import type { ElisionMeta } from '../headroom/elisionMeta'

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
   * Requests that ran the `late` first-sight policy are left out of all three: it removes less tool
   * text on purpose and makes no such promise (see lateTextOrigTokens).
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
  /**
   * Turns whose only tool calls were retrieve_full, and what they cost in effective units: the
   * cached prefix they re-read (0.1x) plus the output they wrote (5x). `givebackTokens` prices the
   * text that came back; this prices the TURN that fetched it, which is an order of magnitude
   * more. Mixed turns add nothing here: their other tool calls are work the session wanted anyway.
   */
  retrievalTurns: number
  retrievalTurnUnits: number
  /**
   * Asks that needed a second turn: the model had to load retrieve_full through ToolSearch before
   * it could call it. `retrievalTurns` counts the ask once, however many turns it took, and its
   * `retrievalTurnUnits` hold both turns; this is how many of them held a ToolSearch turn too.
   */
  retrievalHops: number
  /**
   * Tokens a request kept off the wire whose stub its own conversation had already fetched back with
   * retrieve_full. The fetched text is on the wire again, so for as long as the request carries both the
   * stub saves nothing; `textSavedTokens` still counts it (it is what the compressor removed), and the
   * receipt takes this out of the net. Only the share of a request's credit it can be: never more than
   * that request was credited with.
   */
  askedBackTokens: number
  /** Responses whose shape was read, the denominator of the retrieval-turn share. `requests` has
   *  counted every response since v1.29 and `retrievalTurns` only those since v1.55, so dividing one
   *  by the other would be the category error unifiedReceipt's prefix-head note describes. */
  turnRequests: number
  /**
   * Of the responses counted in `turnRequests` that completed, how many came from a request on which
   * the model could ask for elided text back: retrieve_full was in its tools list (`offerDirect`),
   * or a ToolSearch tool was, to load it through (`offerDeferred`), or neither (`offerAbsent`). An ask
   * rate is a share of the requests that could ask; a request with no way to ask says nothing about
   * whether the model would have.
   */
  offerDirect: number
  offerDeferred: number
  offerAbsent: number
  /**
   * What the tool results in each forwarded request were, by what was done to them (see
   * forwardedKinds.ts), summed over requests. A stub that stays in a conversation is counted by
   * every request that carries it, the way `textSavedTokens` credits an elided token. `stubAgedEarly`
   * is the aged-out stubs in a body too short for the decay pass to have made them, and
   * `stubAgedEarlyRequests` the requests that carried at least one: the unexplained case.
   */
  stubPlain: number
  stubCompact: number
  stubDedup: number
  stubDiff: number
  stubAged: number
  stubAgedEarly: number
  stubAgedEarlyRequests: number
  /**
   * The tool-result text of the requests that ran the `late` first-sight policy, counted as the
   * lifetime figures above count it (a subset of `textOrigTokens` and `textSavedTokens`). `late`
   * removes less tool text by design, and the savings-floor controller reads the share removed, so it
   * has to be able to leave these requests out: see `floorSavedPct`.
   */
  lateTextOrigTokens: number
  lateTextSavedTokens: number
}

/** The ledger's tally of what the forwarded requests' tool results were, named for the receipt and
 *  the card (`agedEarlyRequests` is the requests that carried at least one early aged-out stub). */
export interface StubKinds {
  plain: number
  compact: number
  dedup: number
  diff: number
  aged: number
  agedEarly: number
  agedEarlyRequests: number
}

/** The `stubKinds` of a set of totals, session or cumulative. */
export function stubKindsOf(t: ProxyTotals): StubKinds {
  return {
    plain: t.stubPlain, compact: t.stubCompact, dedup: t.stubDedup, diff: t.stubDiff,
    aged: t.stubAged, agedEarly: t.stubAgedEarly, agedEarlyRequests: t.stubAgedEarlyRequests,
  }
}

/** The floor this release is held to, as a percentage of compressible wire text. */
export const FLOOR_PCT = 50
/** Requests carrying less than this much compressible text are excluded from floor stats: a turn
 *  with one 200-char tool result can't reach 50% and would smear the evidence without informing it. */
const FLOOR_MIN_ORIG_TOKENS = 250
/** The totals with their saved share. `floorSavedPct` is that share over the requests that did NOT run
 *  the `late` first-sight policy: the evidence the savings-floor controller reads. */
export type ProxyTotalsWithPct = ProxyTotals & { savedPct: number; floorSavedPct: number }
export interface ProxyReceipt {
  session: ProxyTotalsWithPct
  cumulative: ProxyTotalsWithPct
}

function empty(): ProxyTotals {
  // worstSavedPct starts at 100 and only ever ratchets DOWN, so an untouched ledger never claims
  // a floor breach it never saw.
  return { requests: 0, textOrigTokens: 0, textSavedTokens: 0, images: 0, imageOrigBytes: 0, imageSavedBytes: 0, cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0, outputTokens: 0, retrieves: 0, givebackTokens: 0, toolUseOrigTokens: 0, toolUseSavedTokens: 0, worstSavedPct: 100, belowFloorRequests: 0, floorEligibleRequests: 0, sysChars: 0, toolsChars: 0, tpToolsChars: 0, maxToolCount: 0, steeredRequests: 0, steeredOutputTokens: 0, unsteeredRequests: 0, unsteeredOutputTokens: 0, retrievalTurns: 0, retrievalTurnUnits: 0, retrievalHops: 0, askedBackTokens: 0, turnRequests: 0, offerDirect: 0, offerDeferred: 0, offerAbsent: 0, stubPlain: 0, stubCompact: 0, stubDedup: 0, stubDiff: 0, stubAged: 0, stubAgedEarly: 0, stubAgedEarlyRequests: 0, lateTextOrigTokens: 0, lateTextSavedTokens: 0 }
}

let session = empty()
let base = empty() // cumulative baseline loaded from disk
let flush: (() => void) | null = null

export function setProxyLedgerFlush(fn: (() => void) | null): void { flush = fn }

/**
 * ToolSearch turns that loaded retrieve_full and are waiting to see whether the conversation's next
 * turn is the retrieve_full call they were for (R1 criterion 9). One slot per conversation, kept in
 * memory only: a hop pending at quit is simply never charged. Bounded, oldest out, so a long run of
 * conversations that hop and never ask cannot grow it.
 */
const PENDING_HOP_MAX = 256
interface PendingHop {
  /** What the hop turn cost as part of the ask: the prefix it re-read plus the call it wrote. */
  units: number
  /** The arm the arm ledger counted the hop request under, or null when it counted none. */
  arm: LedgerArm | null
  cluster: number
}
const pendingHops = new Map<number, PendingHop>()

/** The hop this conversation left waiting, removed: whatever its next request is, the wait is over. */
function takeHop(key: number): PendingHop | undefined {
  const h = pendingHops.get(key)
  if (h) pendingHops.delete(key)
  return h
}

/** Leave a hop waiting for its conversation's next turn, the newest at the back of the line. The
 *  caller has just taken any older hop of this conversation (takeHop), so setting it appends. */
function rememberHop(key: number, h: PendingHop): void {
  pendingHops.set(key, h)
  if (pendingHops.size > PENDING_HOP_MAX) pendingHops.delete(pendingHops.keys().next().value as number)
}

/** A counter read back from disk: a finite number above zero, else zero. */
function counter(n: unknown): number { return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0 }

/** The counters added after v1.54. */
const NEWER_COUNTERS = [
  'retrievalTurns', 'retrievalTurnUnits', 'retrievalHops', 'askedBackTokens', 'turnRequests', 'offerDirect', 'offerDeferred', 'offerAbsent',
  'stubPlain', 'stubCompact', 'stubDedup', 'stubDiff', 'stubAged', 'stubAgedEarly', 'stubAgedEarlyRequests',
  'lateTextOrigTokens', 'lateTextSavedTokens',
] as const

export function loadProxyBase(b: Partial<ProxyTotals>): void {
  base = { ...empty(), ...b }
  // A file written before them has none, and one damaged in the new fields must read as zero
  // rather than turn every later sum into NaN.
  for (const k of NEWER_COUNTERS) base[k] = counter(base[k])
}

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
  const credited = Math.max(0, Math.ceil(((s.trOrigChars || 0) - (s.trCompChars || 0)) / 4))
  session.textSavedTokens += credited
  // The part of that credit whose text the conversation had already fetched back: withdrawn at the receipt.
  if (typeof s.askedBackChars === 'number' && s.askedBackChars > 0) session.askedBackTokens += Math.min(credited, Math.ceil(s.askedBackChars / 4))
  session.toolUseOrigTokens += Math.ceil((s.tuOrigChars || 0) / 4)
  session.toolUseSavedTokens += Math.max(0, Math.ceil(((s.tuOrigChars || 0) - (s.tuCompChars || 0)) / 4))
  if (s.arm === 'late') {
    // A request on the late policy removes less tool text on purpose. It is not evidence about the
    // 50% floor, and counting it as one would make the controller chase a shortfall it designed in,
    // here or in a later run switched back to legacy. Its text is kept apart so that the share the
    // controller reads (floorSavedPct) can leave it out.
    session.lateTextOrigTokens += Math.ceil((s.trOrigChars || 0) / 4)
    session.lateTextSavedTokens += Math.max(0, Math.ceil(((s.trOrigChars || 0) - (s.trCompChars || 0)) / 4))
  } else {
    recordFloorSample(
      Math.ceil(((s.trOrigChars || 0) + (s.tuOrigChars || 0)) / 4),
      Math.max(0, Math.ceil((((s.trOrigChars || 0) - (s.trCompChars || 0)) + ((s.tuOrigChars || 0) - (s.tuCompChars || 0))) / 4)),
    )
  }
  session.images += s.images || 0
  session.imageOrigBytes += s.imgOrigBytes || 0
  session.imageSavedBytes += Math.max(0, (s.imgOrigBytes || 0) - (s.imgCompBytes || 0))
  session.cacheReadTokens += u.cache_read_input_tokens || 0
  session.cacheCreationTokens += u.cache_creation_input_tokens || 0
  session.inputTokens += u.input_tokens || 0
  session.outputTokens += u.output_tokens || 0
  // A turn spent only on retrieve_full. What it added is the whole cached prefix read again and the
  // call it wrote. Its fresh input and cache write are the request's new content, which the session
  // sends anyway, and the text it fetched is priced by givebackTokens when it re-enters the prefix.
  const ok = r.status >= 200 && r.status < 300
  const turnCost = W_CACHE_READ * (u.cache_read_input_tokens || 0) + W_OUTPUT * (u.output_tokens || 0)
  // Charged on an answer only: the arm ledger, the offer tallies and the hop pairing all wait for a 2xx too.
  const pure = ok && !!r.turn && r.turn.pure === true
  // The ToolSearch turn this conversation left waiting, taken now whatever this request turns out to be:
  // either this is the ask it was the first half of, or it was no ask and is forgotten uncharged.
  const key = Number.isInteger(s.convKey) && s.convKey > 0 ? s.convKey : 0
  const hop = ok && key !== 0 ? takeHop(key) : undefined
  if (r.turn && typeof r.turn.pure === 'boolean') {
    session.turnRequests += 1
    // Requests that could not ask are tallied apart, so a rate is taken over the ones that could.
    if (ok) {
      if (s.retrieveOffer === 'direct') session.offerDirect += 1
      else if (s.retrieveOffer === 'deferred') session.offerDeferred += 1
      else if (s.retrieveOffer === 'absent') session.offerAbsent += 1
    }
  }
  if (pure) {
    session.retrievalTurns += 1
    session.retrievalTurnUnits += turnCost
    // One ask, two turns: the ToolSearch turn that loaded the tool is part of what the ask cost.
    if (hop) {
      session.retrievalHops += 1
      session.retrievalTurnUnits += hop.units
      if (hop.arm) settleArmHop(hop.arm, hop.cluster, hop.units)
    }
  }
  // What this request cost, by the first-sight arm it ran under: the comparison of the two policies
  // reads these. A result from a child that predates the arm, or one the API refused, adds nothing.
  let armCounted: LedgerArm | null = null
  if ((s.arm === 'late' || s.arm === 'holdout' || s.arm === 'legacy') && ok) {
    const read = u.cache_read_input_tokens || 0
    const out = u.output_tokens || 0
    if (recordArmRequest(s.arm, s.armCluster, {
      units: W_INPUT * (u.input_tokens || 0) + W_CACHE_READ * read + W_CACHE_WRITE * (u.cache_creation_input_tokens || 0) + W_OUTPUT * out,
      pureTurn: pure,
      turnUnits: pure ? W_CACHE_READ * read + W_OUTPUT * out : 0,
    })) armCounted = s.arm
  }
  // A turn that only loaded retrieve_full is counted as work for now. If the retrieve_full turn comes
  // next it becomes the first half of an ask (above), and if anything else comes it stays work.
  if (ok && key !== 0 && !pure && r.turn && r.turn.hop === true) {
    rememberHop(key, { units: turnCost, arm: armCounted, cluster: s.armCluster })
  }
  // What the forwarded body's tool results were. A tally from a child that predates it, or a damaged
  // one, adds nothing.
  const kinds = s.kinds
  if (kinds && typeof kinds === 'object') {
    session.stubPlain += counter(kinds.plain)
    session.stubCompact += counter(kinds.compact)
    session.stubDedup += counter(kinds.dedup)
    session.stubDiff += counter(kinds.diff)
    session.stubAged += counter(kinds.aged)
    session.stubAgedEarly += counter(kinds.agedEarly)
    if (counter(kinds.agedEarly) > 0) session.stubAgedEarlyRequests += 1
  }
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
  if (Array.isArray(r.stashes)) for (const st of r.stashes) { try { ccrPut(st.token, st.original, 'proxy', st.meta) } catch { /* best effort */ } }
  try { flush?.() } catch { /* best effort */ }
}

/** Charge one `retrieve_full` give-back to THIS layer — the wire proxy issues the vast majority
 *  of tokens agents actually redeem, and before v1.34.0 every one of them was billed to the
 *  tool-layer ledger instead, which is what made the receipt read negative.
 *
 *  `redeemed` names the token and what its stash recorded, so the elision ledger counts the same
 *  redemption by class. It is counted here, in the same call as the retrieve it belongs to, so the
 *  two ledgers cannot drift apart: a give-back with no token is a legacy redemption. */
export function recordProxyGiveback(tokens: number, redeemed?: { token: string; meta?: ElisionMeta }): void {
  session.retrieves += 1
  session.givebackTokens += Math.max(0, tokens)
  recordRedemption(redeemed?.token, redeemed?.meta)
  try { flush?.() } catch { /* best effort */ }
}

function withPct(t: ProxyTotals): ProxyTotalsWithPct {
  // Both compressible surfaces share one denominator: quoting tool_result alone was accurate
  // about a slice while implying it described the wire.
  const orig = t.textOrigTokens + t.toolUseOrigTokens
  const saved = t.textSavedTokens + t.toolUseSavedTokens
  const pct = orig > 0 ? Math.round((saved / orig) * 100) : 0
  // The same share without the requests that ran the late policy, which remove less on purpose.
  const floorOrig = orig - t.lateTextOrigTokens
  const floorSaved = saved - t.lateTextSavedTokens
  const floorPct = floorOrig > 0 ? Math.round((floorSaved / floorOrig) * 100) : 0
  return { ...t, savedPct: pct, floorSavedPct: floorPct }
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
// The elision ledger's counts (redemptions especially) are the proxy ledger's `retrieves` told by
// class, so they live and die with it: loaded with the totals, saved with them, zeroed with them.
export function loadProxyBaseFromDisk(dir: string): void {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'proxy-totals.json'), 'utf8'))
    loadProxyBase(raw)
    // The first-sight arms ride in the same file: they change as often as the totals do, so they
    // cost no write of their own. A file without them (v1.54) reads as empty.
    loadArmState(raw?.arms)
  } catch { /* start at zero */ }
  loadElisionFromDisk(dir)
}
export function saveProxyTotalsToDisk(dir: string): void {
  try { void offMainFiles.write(join(dir, 'proxy-totals.json'), JSON.stringify({ ...currentProxyTotals(), arms: armState() })).catch(() => { /* best effort */ }) } catch { /* best effort */ }
  saveElisionToDisk(dir)
}
/** Zero the lifetime meter (session + on-disk base) WITHOUT dropping the flush wiring, so the
 *  ledger keeps persisting afterward. Used for a live "reset lifetime savings" (e.g. after a
 *  compression-methodology change) — unlike resetProxyLedger(), which also nulls flush for tests. */
export function resetProxyCounters(): void { session = empty(); base = empty(); pendingHops.clear(); resetElisionLedger(); resetArmLedger() }
export function resetProxyLedger(): void { session = empty(); base = empty(); flush = null; pendingHops.clear(); resetElisionLedger(); resetArmLedger() }
