// Moves terminal output from main's rolling buffers into the bridge process,
// for the terminals a phone is actually watching and no others.
//
// Three jobs. The first two are about not doing work:
//
//   1. SCOPE. The bridge knows which terminals are subscribed; main does not.
//      Without that set main would either serialise every terminal's PTY output
//      across the process boundary -- the cost this design exists to avoid --
//      or send none and the phone would show a dead screen.
//
//   2. RATE. A held key produces one PTY write per character. Sending on each
//      would put a structured-clone and a wake-up on the main thread per
//      keystroke, which is exactly the typing lag this app has fought before.
//      `markDirty` schedules a flush only when none is pending, so a burst of
//      any size costs one message per interval.
//
//   3. THE OPENING READ. A terminal that joins the watched set is read at once,
//      from the start of the window, whether or not it is dirty. Dirt only ever
//      comes from the PTY writing, and the terminal a phone opens is very often
//      one that has stopped: an agent's TUI parked at its prompt prints nothing
//      until somebody types. Waiting for dirt left the phone blank until the
//      user typed into it -- the echo was what finally made the terminal dirty,
//      and only then did its screen cross. The opening read is sent as a
//      `reset`, because it is the whole window again rather than the next part
//      of a stream the bridge already holds.
//
// Every timer is injected. A pump on real timers makes each test a race, and
// the assertions that matter here are about WHEN it sends.
import type { OutputSlice } from './remoteBridge/protocol'

/** How long a burst is allowed to accumulate before it is sent.
 *
 *  50 ms is under the ~100 ms at which a remote round trip stops feeling
 *  immediate, and long enough that a fast `cat` collapses into a handful of
 *  messages instead of thousands. */
const DEFAULT_INTERVAL_MS = 50

export interface OutputPumpDeps {
  /** Read a terminal from `fromOffset`. Main's `readOutputFrom`, injected. */
  read(terminalId: string, fromOffset: number): OutputSlice
  /** Hand one slice to the bridge.
   *
   *  `reset` is true for a terminal's opening read: the slice is the whole
   *  window, from its start, and the bridge has to rebuild the screen from it
   *  rather than draw it on top of whatever it was holding. */
  send(terminalId: string, slice: OutputSlice, reset: boolean): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  intervalMs?: number
}

export interface OutputPump {
  /** Replace the watched set. Terminals joining it are read at once, in full;
   *  terminals leaving it are forgotten. */
  setSubscriptions(terminalIds: string[]): void
  /** Note that a terminal has new output, and schedule a flush if none is due. */
  markDirty(terminalId: string): void
  /** Forget a terminal entirely -- it closed. */
  dropTerminal(terminalId: string): void
  /** Flush now instead of at the next tick. */
  flushNow(): void
  /** Stop for good: cancel the pending timer and ignore everything after. */
  stop(): void
}

export function createOutputPump(deps: OutputPumpDeps): OutputPump {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  /** Where each terminal's stream has been read to. This is the pump's only
   *  memory: re-reading from 0 would resend the whole window every tick, and
   *  never advancing would resend the same chunk forever.
   *
   *  A watched terminal with NO entry has not been read since it joined, which
   *  is what makes its next read the opening one. */
  const offsets = new Map<string, number>()
  const subscribed = new Set<string>()
  const dirty = new Set<string>()

  let timer: unknown = null
  let stopped = false

  function schedule(): void {
    if (stopped || timer !== null) return
    timer = deps.setTimer(() => {
      timer = null
      flush()
    }, intervalMs)
  }

  function cancel(): void {
    if (timer === null) return
    deps.clearTimer(timer)
    timer = null
  }

  /** Read one terminal from its stored offset and send whatever came back.
   *
   *  With no stored offset this is the opening read. It starts at 0, and it is
   *  sent even when it comes back empty: an empty terminal is a screen too, and
   *  the phone may be holding an older one that has to be cleared. Its `missed`
   *  is zeroed. A read from 0 always "misses" whatever scrolled out of the
   *  window before anyone asked, and passed on, that count becomes a
   *  "--- 1.2 MB of output skipped (terminal outran this device) ---" notice
   *  every time a busy terminal is opened. Nothing outran the phone; it was not
   *  watching yet.
   *
   *  After that, a slice with no text but a non-zero `missed` still travels:
   *  dropped output is the one failure mode of this design the user cannot
   *  detect for themselves, and the gap notice is the only thing that tells
   *  them. */
  function sendOne(terminalId: string): void {
    const from = offsets.get(terminalId)
    let slice: OutputSlice
    try {
      slice = deps.read(terminalId, from ?? 0)
    } catch {
      // The pump runs on a timer, so there is no caller to catch for it. One
      // terminal in a bad state must not stop the others from being pumped.
      // Nothing is stored, so its next read is still the opening one.
      return
    }
    offsets.set(terminalId, slice.nextOffset)
    if (from === undefined) {
      deps.send(terminalId, { ...slice, missed: 0 }, true)
      return
    }
    if (slice.output === '' && slice.missed === 0) return
    deps.send(terminalId, slice, false)
  }

  function flush(): void {
    if (stopped) return
    const ids = [...dirty]
    dirty.clear()
    for (const id of ids) {
      if (subscribed.has(id)) sendOne(id)
    }
  }

  return {
    setSubscriptions(terminalIds) {
      if (stopped) return
      const next = new Set(terminalIds)
      // A terminal leaving the set is forgotten, not flushed. By the time this
      // message reaches main, the bridge has already dropped the subscription
      // and the screen it was keeping for it, so a last read has nowhere to go.
      // It used to be sent anyway, and it planted a new screen in the bridge
      // holding one stray slice -- the one the next phone to open that terminal
      // was then sent edits against. Dropping the offset is also what makes a
      // later re-join start over from the whole window, instead of resuming a
      // stream the phone stopped following in between.
      for (const id of subscribed) {
        if (next.has(id)) continue
        offsets.delete(id)
        dirty.delete(id)
      }
      const joined = [...next].filter((id) => !subscribed.has(id))
      subscribed.clear()
      for (const id of next) subscribed.add(id)
      // The opening read: now, not at the next tick. An idle terminal has no
      // next tick -- see the header.
      for (const id of joined) sendOne(id)
    },

    markDirty(terminalId) {
      if (stopped) return
      dirty.add(terminalId)
      schedule()
    },

    dropTerminal(terminalId) {
      // The offset is what has to go: ids can be reused, and a stale one would
      // make the next terminal's first read start mid-stream, hiding its
      // opening output. With it gone, that first read is an opening read, so
      // the bridge rebuilds the screen rather than drawing the new terminal
      // over what the old one left behind.
      //
      // The SUBSCRIPTION deliberately stays. That set belongs to the bridge --
      // it is mirrored down, not decided here -- and dropping the id locally
      // would leave the two out of step with no message that puts them back:
      // the bridge only announces when its own set CHANGES, so a phone still
      // subscribed to a reused id would never be re-added here, and its screen
      // would go quiet with nothing to explain it. A dead id costs nothing: it
      // is read only when it is marked dirty, and a closed terminal never is.
      offsets.delete(terminalId)
      dirty.delete(terminalId)
    },

    flushNow() {
      cancel()
      flush()
    },

    stop() {
      stopped = true
      cancel()
      dirty.clear()
    },
  }
}
