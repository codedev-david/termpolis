// Keeping a phone's copy of a terminal right when nothing tells the desktop it is wrong.
//
// The wire has no sequence number and no ack, and the app in people's hands (1.1.0) cannot be changed from
// here, so the desktop never learns that a frame did not arrive, that a phone went away holding an old copy,
// or that a phone fell behind. Three rules stand in for the missing ack, and every one of them sends only
// chunks the shipped app already applies -- no new field, no new request, PROTOCOL_VERSION untouched:
//
//   attach  A device that comes back is sent ONE screen per terminal it watches and none of the edits it
//           missed (`OutputFanout.reseed`, called from `onRoomState` in entry.ts). It used to be sent the
//           whole backlog, up to 262,144 chars of whole-region edits for a 2.5 KB screen.
//   lag     A device queue that passes COLLAPSE_AFTER_CHUNKS chunks of one terminal is replaced by ONE screen
//           instead of evicting its head (`OutputFanout`).
//   quiet   A watched terminal that has printed nothing for QUIET_MS gets ONE rewrite of its live region
//           (`QuietWatch` here, the rewrite itself in entry.ts), so a divergence confined to the live region
//           heals instead of staying until something repaints that row.
//
// Honest limits, documented where they bite:
//   - A re-attached phone keeps no history beyond the screen's tail (32 KB): the same as a phone opening a
//     terminal somebody already watches today. The copy it held before is replaced, not patched.
//   - The quiet rewrite heals what the live region holds. A copy whose SETTLED text lost a frame stays
//     wrong until the next attach: settled rows are permanent by design and are never re-sent.
//   - A rewrite is never sent to a copy that holds a gap notice it would cut or mis-align (see
//     `safeToRewriteLive`), so the notice stays visible and the copy is no worse than before.
//   - A lost frame that changed the LENGTH of the stream (a row grew, rows were added) leaves the phone's text
//     shorter than its end mark says, and every edit after it -- the rewrite included -- cuts that much too
//     early. The live region is put right all the same (the seeded scenarios in remoteBridgeEntry.test.ts find
//     none left wrong, where without the rewrite about half stay wrong even after the agent draws again), but
//     the hole above it, as many chars as the lost frame added, stays until the next attach replaces the copy.
//     It is the hole the next edit would have cut anyway; the rewrite only brings it forward.

/** Environment switch for everything in this file's header: attach, lag and quiet. Any value but empty, `0`
 *  or `false` puts the bridge back to exactly what it did before them (the whole backlog on attach, the
 *  head evicted past the ceiling, nothing sent for a quiet terminal). The bridge is forked with main's
 *  environment, so setting it where Termpolis starts reaches it; it is read once, when the bridge core is
 *  built. Parsed like TERMPOLIS_DISABLE_RESIZE_FLUSH and TERMPOLIS_DISABLE_FLATTENER_PARITY. */
export const PHONE_RESYNC_DISABLE_FLAG = 'TERMPOLIS_DISABLE_PHONE_RESYNC'

export function phoneResyncDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[PHONE_RESYNC_DISABLE_FLAG]
  return !!v && v !== '0' && v.toLowerCase() !== 'false'
}

/** How long a watched terminal prints nothing before its live region is rewritten once. */
export const QUIET_MS = 2_000

/** How often the quiet watch looks. A pending terminal is rewritten between QUIET_MS and QUIET_MS plus one
 *  tick after its last output; nothing at all runs while no terminal is pending. */
export const QUIET_TICK_MS = 500

/** What the quiet watch needs of time. Injected so a test moves it by hand: the bridge's emulator finishes
 *  its writes off real timers, so faking the global ones would leave a feed waiting for ever. */
export interface Clock {
  /** Milliseconds from any fixed point: only differences are read. */
  now(): number
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/** The clock the bridge runs on: monotonic, so a wall-clock change never makes a terminal look quiet (or
 *  busy) for hours; and unreferenced, so it can never be what keeps a process alive. */
export const systemClock: Clock = {
  now: () => performance.now(),
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/** Calls back once for each terminal that has been quiet for `quietMs`, and then not again until the terminal
 *  prints again. One interval runs while at least one terminal is pending and none otherwise, so an idle
 *  bridge pays nothing and the cost under load is one Map write per output slice. */
export class QuietWatch {
  private readonly lastOutput = new Map<string, number>()
  private armed = false
  private handle: unknown = undefined

  constructor(
    private readonly clock: Clock,
    private readonly onQuiet: (terminalId: string) => void,
    private readonly quietMs: number = QUIET_MS,
    private readonly tickMs: number = QUIET_TICK_MS,
  ) {}

  /** The terminal just printed: its quiet period starts over. */
  touch(terminalId: string): void {
    this.lastOutput.set(terminalId, this.clock.now())
    if (this.armed) return
    // Armed only once the clock has given an interval: a clock that throws leaves the watch free to ask
    // again at the next output, not believing in an interval that was never made.
    this.handle = this.clock.setInterval(() => this.tick(), this.tickMs)
    this.armed = true
  }

  /** Forget everything pending and stop looking. */
  stop(): void {
    this.lastOutput.clear()
    this.disarm()
  }

  private tick(): void {
    const now = this.clock.now()
    // A copy: a callback is free to touch the terminal it was told about.
    for (const [terminalId, at] of [...this.lastOutput]) {
      if (now - at < this.quietMs) continue
      this.lastOutput.delete(terminalId)
      try {
        this.onQuiet(terminalId)
      } catch {
        // A rewrite that failed costs nothing: the phone keeps the copy it has, which is what it
        // would have had without this. And a throw here is a throw out of a timer, which ends the bridge.
      }
    }
    if (this.lastOutput.size === 0) this.disarm()
  }

  private disarm(): void {
    if (!this.armed) return
    this.armed = false
    this.clock.clearInterval(this.handle)
    this.handle = undefined
  }
}

/** Whether the live region may be rewritten for a copy that holds a gap notice at `gapAt`.
 *
 *  A notice sits in the phone's copy but not in its end mark, which every anchor counts back from. An edit
 *  anchored BEFORE the notice therefore keeps a notice's worth of the old text it meant to cut, and an edit
 *  anchored AT it keeps the notice and nothing else. So a rewrite at `liveFrom` is safe for a notice that
 *  starts at or before it, and not for one inside the region it replaces. A notice whose place is unknown
 *  (`Infinity`) is not safe, and neither is any notice when `liveFrom` is 0: a screen from 0 is sent behind a
 *  forget, which would wipe the notice the user has not read yet. No notice at all is always safe.
 *
 *  Saying no is the base behaviour: the notice stays, and the copy heals as the live region scrolls past it. */
export function safeToRewriteLive(gapAt: number | null, liveFrom: number): boolean {
  return gapAt === null || (liveFrom > 0 && gapAt <= liveFrom)
}
