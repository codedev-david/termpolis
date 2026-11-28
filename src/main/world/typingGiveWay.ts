// typingGiveWay.ts
//
// The world host's compile gives way to the keyboard (TYPEFLAKE). Main's own background work stands aside for typing
// (typingQuiet.ts), but a world compile runs in its own process, and on a small, busy machine (macOS CI: 3 cores, the
// whole machine near 280% of 300%) the compile's reads and scans took close to a core, the page's timers ran up to
// 64 ms late with no long task of its own, and a keystroke's echo with them.
//
// Main tells the host when someone types (worldClient.noteTyping, at most every few hundred ms). For GIVE_WAY_QUIET_MS
// after that, the host's file reads go in slices: GIVE_WAY_SLICE_MS of work, then GIVE_WAY_REST_MS in which no read
// starts, so the compile takes about a quarter of what it would. It is never stopped: a line that never goes quiet
// only slows it. With nobody typing a wait costs one clock read: no timer, no rest.
//
// It only ever delays and fails open: with no clock or a sleep that throws, the work goes ahead.

/** As typingQuiet's QUIET_MS: how long after a keystroke the compile keeps giving way. */
export const GIVE_WAY_QUIET_MS = 500
/** Work allowed in one slice while someone types. */
export const GIVE_WAY_SLICE_MS = 10
/** The rest after each slice, in which no read starts. */
export const GIVE_WAY_REST_MS = 30

export interface GiveWay {
  /** Someone typed (main said so). */
  typed(): void
  /**
   * When a read may start: null for now (nobody typed lately, or the slice has time left), else the rest to wait out.
   * Null rather than a resolved promise, so a caller with nothing to wait for calls straight through, in this turn.
   */
  turn(): Promise<void> | null
}

export interface GiveWayOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createGiveWay(opts: GiveWayOptions = {}): GiveWay {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? realSleep
  let typedAt = Number.NEGATIVE_INFINITY
  /** When the slice under way started; null: none (the next wait while typing starts one). */
  let sliceAt: number | null = null
  /** The rest every waiter shares once a slice is used up. */
  let resting: Promise<void> | null = null

  const rest = (): Promise<void> | null => {
    const over = (): void => {
      resting = null
      sliceAt = null
    }
    try {
      resting = sleep(GIVE_WAY_REST_MS).then(over, over)
    } catch {
      over()
      return null
    }
    return resting
  }

  return {
    typed() {
      try {
        typedAt = now()
      } catch {
        // no clock: the compile never gives way
      }
    },
    turn() {
      if (resting) return resting
      let t: number
      try {
        t = now()
      } catch {
        return null
      }
      if (t - typedAt >= GIVE_WAY_QUIET_MS) {
        sliceAt = null
        return null
      }
      if (sliceAt === null) sliceAt = t
      if (t - sliceAt < GIVE_WAY_SLICE_MS) return null
      return rest()
    }
  }
}
