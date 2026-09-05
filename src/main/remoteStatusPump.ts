// Turns terminal output into "what is the agent doing", for the terminals a
// phone is actually watching, and pushes it to the bridge when the answer
// changes.
//
// Separate from the output pump on purpose, even though the two are fed by the
// same signal. They are different jobs with different failure modes:
//
//   - The output pump moves BYTES, at 50 ms, exactly once each, tracking an
//     offset per terminal. Missing a byte is a hole in the transcript.
//   - This moves an ANSWER, at 1 s, only when it differs from the last one, over
//     a window rather than an increment. Missing a tick costs nothing, because
//     the next one re-derives the same state from the same buffer.
//
// Folding them together would put a regex sweep on a 20 Hz timer and give one
// file two state machines. The cost of keeping them apart is one extra
// subscription mirror, which is a set of strings.
import type { AgentStatus, AgentStatusResult } from '../shared/agentStatusDetector'

/** One second, and deliberately not the output pump's 50 ms.
 *
 *  Status is a label under a terminal's name, not a stream: a phone that learns
 *  half a second late that Claude started thinking is indistinguishable from one
 *  that learned instantly. What a shorter interval WOULD buy is twenty regex
 *  sweeps a second over a 32 KB window per watched terminal, on the main thread
 *  that also pumps every PTY in the window. */
const DEFAULT_INTERVAL_MS = 1000

/** What main hands over for one terminal.
 *
 *  The name travels with the output because the detector keys several of its
 *  rules off it -- "please restart claude" is `blocked` for Claude and ordinary
 *  output for anything else -- and because reading it costs main a session
 *  lookup that is worth doing once per detection rather than once per tick. */
export interface TerminalSnapshot {
  output: string
  name: string
}

export interface StatusPumpDeps {
  /** The rolling window and name for a terminal, or null when it has neither. */
  read(terminalId: string): TerminalSnapshot | null
  /** Injected so a test can drive the pump without the real rule set, and so the
   *  detector stays a pure function this file does not own. */
  detect(output: string, name: string, previous: AgentStatus): AgentStatusResult
  send(terminalId: string, result: AgentStatusResult): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  intervalMs?: number
}

export interface StatusPump {
  /** Replace the watched set. Terminals joining it are detected at once. */
  setSubscriptions(terminalIds: string[]): void
  /** Note that a terminal has new output, and schedule a detection if none is due. */
  markDirty(terminalId: string): void
  /** Forget a terminal's remembered status -- it closed. */
  dropTerminal(terminalId: string): void
  /** Detect everything pending now, cancelling the scheduled pass. */
  flushNow(): void
  stop(): void
}

export function createStatusPump(deps: StatusPumpDeps): StatusPump {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const subscribed = new Set<string>()
  const dirty = new Set<string>()
  /** The last answer SENT, per terminal. The dedup is against what the phone was
   *  told, not against what was last computed, so a send that never happened is
   *  never mistaken for one that did. */
  const last = new Map<string, { status: AgentStatus; summary: string }>()
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

  /** Detect one terminal and send if the answer moved.
   *
   *  `force` is for a terminal that has just been subscribed to: its answer has
   *  not changed, but the phone that just opened its screen has never been told
   *  what it is, and would otherwise sit on a blank label until the agent's state
   *  happened to move. */
  function detectOne(terminalId: string, force: boolean): void {
    const snapshot = deps.read(terminalId)
    // No buffer means the terminal is gone or has produced nothing yet. Reporting
    // `starting` off an empty string would be a guess presented as a reading.
    if (!snapshot) return

    const previous = last.get(terminalId)
    const result = deps.detect(snapshot.output, snapshot.name, previous?.status ?? 'starting')
    if (!force && previous && previous.status === result.status && previous.summary === result.summary) {
      return
    }
    last.set(terminalId, { status: result.status, summary: result.summary })
    deps.send(terminalId, result)
  }

  function flush(): void {
    if (stopped) return
    const ids = [...dirty]
    dirty.clear()
    for (const id of ids) {
      if (subscribed.has(id)) detectOne(id, false)
    }
  }

  return {
    setSubscriptions(terminalIds) {
      if (stopped) return
      const next = new Set(terminalIds)
      // Leaving the set forgets the remembered answer. The phone that comes back
      // to this terminal is a screen with nothing on it -- possibly a different
      // phone entirely -- so the next detection has to be allowed to send even
      // though it computes the same state as the one before it.
      for (const id of subscribed) {
        if (!next.has(id)) {
          last.delete(id)
          dirty.delete(id)
        }
      }
      const added = [...next].filter((id) => !subscribed.has(id))
      subscribed.clear()
      for (const id of next) subscribed.add(id)
      // Immediately, not on the next tick: this runs when a phone opens a
      // terminal, and a second of "unknown" on a screen the user just tapped
      // reads as the feature not working.
      for (const id of added) detectOne(id, true)
    },

    markDirty(terminalId) {
      if (stopped) return
      // Unwatched terminals are dropped here rather than filtered at flush time,
      // so an idle window with fifty terminals in it and one phone attached does
      // not grow a dirty set of fifty.
      if (!subscribed.has(terminalId)) return
      dirty.add(terminalId)
      schedule()
    },

    dropTerminal(terminalId) {
      // Ids are reused. A remembered answer under a reused id would suppress the
      // new terminal's first status as a duplicate of the dead one's last.
      //
      // The SUBSCRIPTION stays, for the same reason it stays in the output pump:
      // that set is mirrored down from the bridge, and dropping it here would
      // leave the two out of step with no message that puts them back.
      last.delete(terminalId)
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
      last.clear()
    },
  }
}
