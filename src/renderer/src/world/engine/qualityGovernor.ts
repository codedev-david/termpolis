// The 3D map's quality governor (look spec §5.1, plan Task 3): which tier, High, Low or Flat, the map draws at, from
// the frame times the renderer's sampler gives it in windows. Pure: no clock, no WebGL. A window carries the time its
// counted frames cover, so a pause or an idle city (whose frames are not counted) never reads as time at a tier.
//
// The rule:
//   - Drop: High to Low after DROP_WINDOWS windows in a row with a p95 over DROP_P95_MS.high (18.5 ms: the 16.7 ms
//     budget plus 10%); Low to Flat after as many over DROP_P95_MS.low (33 ms). One step at a time.
//   - Rise: one step, after RISE_HOLD_MS of windows whose p95 is under RISE_P95_MS (60% of the higher tier's budget:
//     10 ms to rise to High, 20 to Low), at most MAX_RISES times a session.
//   - No flapping: a tier dropped from LOCKOUT_DROPS times is never entered again in auto mode.
//   - A window of fewer than MIN_WINDOW_FRAMES frames is too few to judge (a window cut short), unless its frames
//     cover SLOW_WINDOW_MS: then they are few because they are slow (High drawn in software runs at 3 to 6 frames a
//     second, and a minimum of 30 frames would keep it at High for good).
//   - A tier the person chose is never changed by the frame times. A lost context's restore and the first-frame
//     watchdog's step are failures, not frame times: they step down in either mode.
import type { FrameStats } from './frameSampler'
import type { TierName } from './tierBudget'

/** A window's p95 over this, at the tier named, is over its budget. */
export const DROP_P95_MS = { high: 18.5, low: 33 } as const
/** A window's p95 under this, at the tier named, is fast enough to count toward a rise from it. */
export const RISE_P95_MS = { low: 10, flat: 20 } as const
/** Windows over budget in a row that drop a tier. */
export const DROP_WINDOWS = 2
/** The counted time of fast windows in a row a rise needs. */
export const RISE_HOLD_MS = 10_000
/** Rises a session may take. */
export const MAX_RISES = 1
/** Drops from one tier that lock it out of auto mode for the session. */
export const LOCKOUT_DROPS = 2
/** The fewest frames a window is judged on, unless they cover SLOW_WINDOW_MS. */
export const MIN_WINDOW_FRAMES = 30
/** A window ends after this many counted frames, or WINDOW_MS after it began, whichever comes first (the renderer cuts it). */
export const WINDOW_FRAMES = 120
export const WINDOW_MS = 2000
/** A window of fewer than MIN_WINDOW_FRAMES frames is still judged when they cover this much time. */
export const SLOW_WINDOW_MS = 1000

const DOWN: Record<TierName, TierName | null> = { high: 'low', low: 'flat', flat: null }
const UP: Record<TierName, TierName | null> = { high: null, low: 'high', flat: 'low' }

export interface Governor {
  /**
   * A window of frame times at the tier drawn now, its counted frames covering `spanMs`. Returns the tier to draw at
   * from now on when it changes, else null.
   */
  onWindow(stats: FrameStats, spanMs: number): TierName | null
  /** The lost context came back: one tier lower than before (Flat stays Flat). Counts as a drop from the tier left. */
  onContextRestored(): TierName
  /** The first-frame watchdog asks for less: one tier lower, or null at Flat (the viewer then shows the 2D map). */
  stepDown(): TierName | null
  /**
   * The person picked a tier (it is drawn, and the frame times never change it) or Auto (auto mode goes on from the
   * tier drawn now, below it when that one is locked out). Returns the tier to draw at.
   */
  choose(q: TierName | 'auto'): TierName
  tier(): TierName
  /** Whether the governor picks the tier (Auto), not the person. */
  auto(): boolean
  /** Tiers dropped this session, by the frame times, a restore or the watchdog. */
  drops(): number
}

export function createGovernor(o: { start: TierName; mode: 'auto' | 'user' }): Governor {
  let tier = o.start
  let auto = o.mode === 'auto'
  /** Windows over budget in a row, and the counted time of fast windows in a row, at this tier. */
  let over = 0
  let fastMs = 0
  let rises = 0
  let drops = 0
  const droppedFrom: Record<TierName, number> = { high: 0, low: 0, flat: 0 }
  const locked = (t: TierName): boolean => droppedFrom[t] >= LOCKOUT_DROPS
  const enter = (t: TierName): TierName => {
    tier = t
    over = 0
    fastMs = 0
    return t
  }
  const drop = (): TierName | null => {
    const down = DOWN[tier]
    if (down === null) return null
    droppedFrom[tier]++
    drops++
    return enter(down)
  }
  return {
    onWindow(stats, spanMs) {
      if (!auto) return null
      if (stats.frames < MIN_WINDOW_FRAMES && spanMs < SLOW_WINDOW_MS) return null
      const budget = tier === 'flat' ? Infinity : DROP_P95_MS[tier]
      if (stats.p95 > budget) {
        fastMs = 0
        return ++over >= DROP_WINDOWS ? drop() : null
      }
      over = 0
      const up = UP[tier]
      if (up === null || !(stats.p95 < RISE_P95_MS[tier as 'low' | 'flat'])) {
        fastMs = 0
        return null
      }
      fastMs += spanMs
      if (fastMs < RISE_HOLD_MS || rises >= MAX_RISES || locked(up)) return null
      rises++
      return enter(up)
    },
    onContextRestored: () => drop() ?? enter(tier),
    stepDown: drop,
    choose(q) {
      if (q !== 'auto') {
        auto = false
        return enter(q)
      }
      auto = true
      let t = tier
      while (locked(t) && DOWN[t] !== null) t = DOWN[t] as TierName
      return enter(t)
    },
    tier: () => tier,
    auto: () => auto,
    drops: () => drops,
  }
}
