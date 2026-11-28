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
  /** Resolves when a read may start: at once unless someone typed lately and the slice is used up. */
  wait(): Promise<void>
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

  const rest = (): Promise<void> => {
    const over = (): void => {
      resting = null
      sliceAt = null
    }
    try {
      resting = sleep(GIVE_WAY_REST_MS).then(over, over)
    } catch {
      over()
      return Promise.resolve()
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
    wait() {
      if (resting) return resting
      let t: number
      try {
        t = now()
      } catch {
        return Promise.resolve()
      }
      if (t - typedAt >= GIVE_WAY_QUIET_MS) {
        sliceAt = null
        return Promise.resolve()
      }
      if (sliceAt === null) sliceAt = t
      if (t - sliceAt < GIVE_WAY_SLICE_MS) return Promise.resolve()
      return rest()
    }
  }
}
