/**
 * Session depth — what a conversation costs to KEEP, measured against what the same turn costs
 * in a fresh one.
 *
 * Every other Token Headroom control shrinks the BODY of a request. This one measures the thing
 * no compressor can reach: a long conversation re-reads its whole history on every turn, and
 * that re-read is the largest line on the bill. Cache-read bills at 0.1x, which reads as free
 * right up until you notice a 320,000-token prefix being read three hundred more times.
 *
 * Measured over 24,163 real requests across 89 sessions. The app refits this from the user's own
 * traffic and never uses these numbers directly — they are here to justify the feature existing:
 *
 *     depth    reqs   meanRead   meanWrite   units/turn
 *      <10      777     33,463      17,862       25,674
 *    10-25    1,062     67,328      10,155       19,426
 *   50-100    3,229    157,455       6,373       23,712
 *  200-400    8,361    319,691       7,556       41,415
 *
 * The comparison is made on units/turn INCLUDING the cache write, not on read alone. That is
 * what removes the need for a fudged "cost of restarting" constant: the price of establishing a
 * fresh prefix is already inside the shallow band's own figure, because those are exactly the
 * requests that paid it. Whether a restart is worth it becomes subtraction.
 *
 * Two limits worth stating on the same page as the number:
 *
 * 1. The shallow band spreads one prefix write across ~10 requests, so the comparison holds only
 *    if a restarted session runs at least that long. On measured traffic a session that reaches
 *    100 messages runs a median of 320 more requests, so the margin is not close.
 * 2. Deep sessions may be deep BECAUSE the work is bigger. Band means cannot separate that from
 *    the mechanical cost of depth, so this is a correlation and is labelled as one.
 *
 * What the arithmetic cannot prove is the thing it depends on: that the work PARTITIONS — that a
 * fresh session handed the memory brain's context does the same job. That is a claim about
 * answer quality, not about tokens. So this module only ever ADVISES. It never ends a session,
 * and it is deliberately not wired to anything that could.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { W_CACHE_READ, W_CACHE_WRITE } from './effectiveUnits'

/** Exclusive upper edge of each depth band, in messages on the request. */
export const DEPTH_BAND_EDGES = [10, 25, 50, 100, 200, 400, Number.POSITIVE_INFINITY]

/**
 * Below this a band's mean is one session's accident rather than this user's curve, and advice
 * drawn from it would be noise wearing a number. Reporting nothing is the correct output here.
 */
export const MIN_BAND_SAMPLES = 40

/**
 * A band's index is only offered as the "fresh" comparison if it is genuinely shallow. Comparing
 * depth 400 against depth 200 would technically show a saving and would be useless advice.
 */
export const FRESH_BAND_LIMIT = 2

export interface DepthBand {
  requests: number
  readTokens: number
  writeTokens: number
}

export interface DepthCurve {
  bands: DepthBand[]
  /** Messages on the most recent request, so advice can name the depth the user is actually at. */
  lastMessages: number
}

export interface DepthAdvice {
  /** Messages on the most recent request. */
  messages: number
  /** Which band that depth falls in. */
  bandIndex: number
  /** Effective units this conversation spends per turn at its current depth. */
  unitsPerTurnNow: number
  /** What the same user's own shallow sessions spend per turn, cache write included. */
  unitsPerTurnFresh: number
  /** unitsPerTurnNow - unitsPerTurnFresh. Positive means depth is costing something. */
  savingPerTurn: number
  /** savingPerTurn as a share of unitsPerTurnNow, 0-100. */
  savingPct: number
  requestsNow: number
  requestsFresh: number
}

function emptyCurve(): DepthCurve {
  return { bands: DEPTH_BAND_EDGES.map(() => ({ requests: 0, readTokens: 0, writeTokens: 0 })), lastMessages: 0 }
}

let curve: DepthCurve = emptyCurve()
let flush: (() => void) | null = null

export function setDepthCurveFlush(fn: (() => void) | null): void { flush = fn }

export function bandFor(messages: number): number {
  const i = DEPTH_BAND_EDGES.findIndex((e) => messages < e)
  return i < 0 ? DEPTH_BAND_EDGES.length - 1 : i
}

/**
 * One request's contribution. Called from the proxy ledger, which sees the message count the
 * wire carried and the usage the provider reported for it — the two halves have to come from the
 * same request or the curve is comparing one turn's depth against another turn's bill.
 */
export function recordDepthSample(messages: number, readTokens: number, writeTokens: number): void {
  if (!(messages > 0)) return
  // No `if (!b)` guard: bandFor clamps into range and the band array is fixed at the edge count,
  // so an undefined band here would be a broken invariant, not a case to swallow silently.
  const b = curve.bands[bandFor(messages)]
  b.requests += 1
  b.readTokens += Math.max(0, readTokens || 0)
  b.writeTokens += Math.max(0, writeTokens || 0)
  curve.lastMessages = messages
  if (flush) { try { flush() } catch { /* best effort */ } }
}

/**
 * No divide-by-zero guard, deliberately: both call sites reject a band before this, and they do it
 * against MIN_BAND_SAMPLES rather than against zero. A guard here would quietly return 0 for a band
 * that should never have reached it, and 0 units/turn is the one wrong answer that looks like good
 * news. Let the invariant live where it is enforced.
 */
function unitsPerTurn(b: DepthBand): number {
  return (b.readTokens / b.requests) * W_CACHE_READ + (b.writeTokens / b.requests) * W_CACHE_WRITE
}

/**
 * The cheapest sufficiently-sampled SHALLOW band. Cheapest rather than band 0 on purpose: band 0
 * carries the whole prefix write across very few requests, so on some traffic it is dearer per
 * turn than band 1. Advice should quote the rate a restarted session would actually settle at.
 */
function freshBandIndex(): number {
  let best = -1
  for (let i = 0; i <= FRESH_BAND_LIMIT && i < curve.bands.length; i++) {
    const b = curve.bands[i]
    if (b.requests < MIN_BAND_SAMPLES) continue
    if (best < 0 || unitsPerTurn(b) < unitsPerTurn(curve.bands[best])) best = i
  }
  return best
}

/**
 * Returns null rather than a hedged number whenever the evidence is thin — no samples, not deep
 * enough to have a shallow band to compare against, or depth is not currently costing anything.
 * A receipt that prints a figure in those cases teaches the reader to ignore it.
 */
export function depthAdvice(): DepthAdvice | null {
  const messages = curve.lastMessages
  if (!(messages > 0)) return null
  const nowIdx = bandFor(messages)
  const freshIdx = freshBandIndex()
  if (freshIdx < 0 || nowIdx <= freshIdx) return null
  const now = curve.bands[nowIdx]
  const fresh = curve.bands[freshIdx]
  if (now.requests < MIN_BAND_SAMPLES) return null
  const unitsPerTurnNow = unitsPerTurn(now)
  const unitsPerTurnFresh = unitsPerTurn(fresh)
  const savingPerTurn = unitsPerTurnNow - unitsPerTurnFresh
  if (!(savingPerTurn > 0)) return null
  return {
    messages,
    bandIndex: nowIdx,
    unitsPerTurnNow: Math.round(unitsPerTurnNow),
    unitsPerTurnFresh: Math.round(unitsPerTurnFresh),
    savingPerTurn: Math.round(savingPerTurn),
    savingPct: Math.round((savingPerTurn / unitsPerTurnNow) * 100),
    requestsNow: now.requests,
    requestsFresh: fresh.requests,
  }
}

export function currentDepthCurve(): DepthCurve {
  return { bands: curve.bands.map((b) => ({ ...b })), lastMessages: curve.lastMessages }
}

/**
 * Band edges are part of the stored shape. A build that changes them cannot merge its bands with
 * the old file's, so a length mismatch discards rather than mixes — a wrong curve is worse than
 * no curve, and the curve refills within a session or two.
 */
export function loadDepthCurve(raw: unknown): void {
  const r = raw as Partial<DepthCurve> | null
  if (!r || !Array.isArray(r.bands) || r.bands.length !== DEPTH_BAND_EDGES.length) return
  const bands = r.bands.map((b) => ({
    requests: Math.max(0, Number((b as DepthBand)?.requests) || 0),
    readTokens: Math.max(0, Number((b as DepthBand)?.readTokens) || 0),
    writeTokens: Math.max(0, Number((b as DepthBand)?.writeTokens) || 0),
  }))
  curve = { bands, lastMessages: Math.max(0, Number(r.lastMessages) || 0) }
}

export function loadDepthCurveFromDisk(dir: string): void {
  try { loadDepthCurve(JSON.parse(readFileSync(join(dir, 'depth-curve.json'), 'utf8'))) } catch { /* start at zero */ }
}

export function saveDepthCurveToDisk(dir: string): void {
  try { writeFileSync(join(dir, 'depth-curve.json'), JSON.stringify(curve), 'utf8') } catch { /* best effort */ }
}

export function resetDepthCurve(): void { curve = emptyCurve() }

/** Test seam: drops the flush wiring too, so a suite cannot leave a writer attached. */
export function resetDepthCurveAll(): void { curve = emptyCurve(); flush = null }
