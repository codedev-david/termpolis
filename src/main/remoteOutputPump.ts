// Moves terminal output from main's rolling buffers into the bridge process,
// for the terminals a phone is actually watching and no others.
//
// Two jobs, and both are about not doing work:
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
  /** Hand one slice to the bridge. */
  send(terminalId: string, slice: OutputSlice): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  intervalMs?: number
}

export interface OutputPump {
  /** Replace the watched set. Terminals leaving it are flushed once more. */
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
   *  never advancing would resend the same chunk forever. */
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
   *  A slice with no text but a non-zero `missed` still travels: dropped output
   *  is the one failure mode of this design the user cannot detect for
   *  themselves, and the gap notice is the only thing that tells them. */
  function sendOne(terminalId: string): void {
    let slice: OutputSlice
    try {
      slice = deps.read(terminalId, offsets.get(terminalId) ?? 0)
    } catch {
      // The pump runs on a timer, so there is no caller to catch for it. One
      // terminal in a bad state must not stop the others from being pumped.
      return
    }
    offsets.set(terminalId, slice.nextOffset)
    if (slice.output === '' && slice.missed === 0) return
    deps.send(terminalId, slice)
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
      // Terminals leaving the set get one final read. Output written between the
      // last tick and the unsubscribe was asked for; dropping it silently
      // truncates the phone's transcript at an arbitrary point.
      for (const id of subscribed) {
        if (!next.has(id)) sendOne(id)
      }
      subscribed.clear()
      for (const id of next) subscribed.add(id)
    },

    markDirty(terminalId) {
      if (stopped) return
      dirty.add(terminalId)
      schedule()
    },

    dropTerminal(terminalId) {
      // The offset is what has to go: ids can be reused, and a stale one would
      // make the next terminal's first read start mid-stream, hiding its
      // opening output.
      //
      // The SUBSCRIPTION deliberately stays. That set belongs to the bridge --
      // it is mirrored down, not decided here -- and dropping the id locally
      // would leave the two out of step with no message that puts them back:
      // the bridge only announces when its own set CHANGES, so a phone still
      // subscribed to a reused id would never be re-added here, and its screen
      // would go quiet with nothing to explain it. A dead id costs one empty
      // read on a tick it can no longer be marked dirty for.
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
