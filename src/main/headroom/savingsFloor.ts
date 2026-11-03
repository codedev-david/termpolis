import { FLOOR_PCT } from '../headroomProxy/proxyLedger'
import type { Mode } from './config'
import type { FirstSightPolicy } from './elisionPolicy'

/**
 * The savings-floor controller.
 *
 * Under the `legacy` first-sight policy (v1.34 to v1.54, and the Settings kill switch since)
 * Token Headroom's promise is a FLOOR — "at least half the compressible text goes away" — and a
 * fixed compression tier cannot make that promise, because how much a tier removes depends
 * entirely on what the traffic looks like. A session of small tool results simply has less to
 * give than a session of 3,000-line file reads. So the tier is not fixed: this module reads the
 * measured ledger and escalates when the floor is not actually being held.
 *
 * The `late` policy (the default since v1.55) makes no such promise and this controller plays no
 * part in it: the model asks for about two thirds of the results that are shortened at first sight,
 * each ask is a whole extra turn, and the policy therefore removes less tool text on purpose (see
 * elisionPolicy.ts). The share of text removed is the wrong measure for it; the bill is the right
 * one, and the Elision health card reports that.
 *
 * Two things make this safe (under `legacy`, the only policy this controller serves):
 *
 * 1. **It decides ONCE, at launch.** Anthropic prompt caching bills a re-read prefix at a tenth
 *    of rate, and the compressed history sits inside that prefix — so changing the tier
 *    mid-conversation rewrites already-cached blocks and busts the cache. On measured lifetime
 *    traffic (~68k cache-read tokens per request) a single bust costs roughly 78,000 effective
 *    units, against the ~140 units a tier bump earns per request: break-even is ~550 requests in
 *    the SAME session. A per-turn controller would therefore lose money on every session that
 *    isn't enormous. This one runs before the first request and then never moves.
 *
 * 2. **It only ever escalates.** The configured mode is a lower bound on compression, never an
 *    upper one, so a user who chose Conservative for more inline context can still be pushed up
 *    to hold the floor they were promised — but a controller bug can never silently weaken
 *    compression below what they asked for.
 *
 * Flapping between launches is not a real risk: the ledger is CUMULATIVE, so one session's
 * results barely move a lifetime percentage. The controller converges rather than oscillates.
 */

/**
 * Below this many floor-eligible requests a lifetime percentage is noise, and the configured
 * mode stands. Requests carrying too little compressible text to reach the floor at all are
 * already excluded upstream (see FLOOR_MIN_ORIG_TOKENS), so these are all substantial ones.
 */
export const FLOOR_MIN_REQUESTS = 30

/**
 * Fraction of substantial requests allowed to land under the floor before the tier is raised.
 * Not zero: an occasional request whose payload is a single incompressible blob is a property of
 * the traffic, not a compression failure, and chasing it would push everyone to 'max' forever.
 */
export const FLOOR_MISS_TOLERANCE = 0.2

/** Past this miss rate the shortfall is systemic rather than incidental → go straight to the top. */
const SEVERE_MISS_RATE = 0.5
/** ...as is a lifetime average this far under the floor, in percentage points. */
const SEVERE_PCT_GAP = 10

const LADDER: Mode[] = ['conservative', 'balanced', 'aggressive', 'max']

export interface FloorEvidence {
  /** Lifetime saved share of compressible wire text, 0-100. */
  savedPct: number
  /**
   * The same share over the requests that ran the `legacy` first-sight policy only. Under `late` the
   * share is low on purpose, and a run on `late` followed by a switch back to `legacy` must not read
   * that as a floor the old policy failed to hold. Absent on evidence that predates the policy, in
   * which case `savedPct` is used.
   */
  floorSavedPct?: number
  belowFloorRequests: number
  floorEligibleRequests: number
}

/**
 * Pick the wire compression tier for THIS launch from what the ledger actually measured.
 * Returns `configured` unchanged whenever the evidence is thin, garbled, or already good enough.
 *
 * Under the `late` first-sight policy it always returns `configured`. The controller's measure is
 * the share of tool text removed, `late` removes less of it by design (a result under 40,000
 * characters is left whole), and the measure would read that as a shortfall on every launch and
 * climb the ladder to `max`, whose floor is 600 characters: the opposite of what `late` is for.
 */
export function resolveWireMode(configured: Mode, ev: FloorEvidence, policy: FirstSightPolicy = 'legacy'): Mode {
  if (policy === 'late') return configured
  const idx = LADDER.indexOf(configured)
  if (idx < 0) return configured // unknown mode — leave it exactly as found
  const eligible = ev.floorEligibleRequests
  const below = ev.belowFloorRequests
  const pct = typeof ev.floorSavedPct === 'number' && Number.isFinite(ev.floorSavedPct) ? ev.floorSavedPct : ev.savedPct
  if (!Number.isFinite(eligible) || !Number.isFinite(below) || !Number.isFinite(pct)) return configured
  if (eligible < FLOOR_MIN_REQUESTS) return configured

  const missRate = below / eligible
  // Both conditions must be satisfied to stand pat: a healthy average hides a bad tail, and a
  // healthy tail with a poor average means the bulk is escaping compression somewhere else.
  if (missRate <= FLOOR_MISS_TOLERANCE && pct >= FLOOR_PCT) return configured

  const target = missRate > SEVERE_MISS_RATE || pct < FLOOR_PCT - SEVERE_PCT_GAP
    ? LADDER.length - 1
    : idx + 1
  return LADDER[Math.min(LADDER.length - 1, Math.max(idx, target))]
}
