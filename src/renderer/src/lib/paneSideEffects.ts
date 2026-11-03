/**
 * What a pane does for its terminal's output besides writing it to xterm, once per pass instead of once per chunk
 * (1.54.5, plan package P9).
 *
 * The base ran the whole block for EVERY chunk: the 4 KB window slice, the diff test, two escape strips, the prompt parse,
 * agent detection, the compaction and session controllers, the OSC 633 and error patterns. A streaming terminal sends up
 * 125 chunks a second (main's coalescer ceiling), and every mounted pane did this, hidden or not: 16,384 characters
 * scanned or copied per chunk. The work does not need a chunk's granularity (it reads a window, and a window is the same
 * after the last of ten chunks as after each of them), so it runs on a trailing throttle over everything that arrived
 * since the last pass:
 *
 *   - a pane on screen: at most one pass per 250 ms, so at most 4 a second. The first message after quiet runs at once
 *     (a lone shell prompt is parsed with no delay), and a message inside the window is never dropped: exactly one pass
 *     is scheduled for when the window ends.
 *   - a pane that is not on screen: one pass a second, NOT none. Compaction re-priming, session reflection and agent
 *     detection are all about background agents, whose tabs are exactly the hidden ones. When the pane is shown the
 *     pending pass runs at once (flush), so what the user looks at is current.
 *
 * What a pass receives is everything that arrived since the last one (the newest `maxFrameChars` of it: memory stays
 * bounded under a flood), and how many messages that was (the conversation parser counts messages). This is a throttle,
 * not an incremental parser: the pane still reads its 4 KB window, as it always did.
 *
 * PURE by construction, like trailingThrottle: the clock is injected and the whole thing is tested with a virtual one.
 */

export interface EffectsClock {
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export interface PaneEffectsOptions {
  /** One pass: everything that arrived since the last one, and how many messages that was. */
  run: (frame: string, messages: number) => void
  /** Is the pane on screen? Read whenever a pass is scheduled, so it needs no notification when it changes. */
  isVisible: () => boolean
  /** Window between passes for a pane on screen. Default 250 ms (4 a second). */
  visibleMs?: number
  /** Window between passes for a pane that is not. Default 1000 ms. */
  hiddenMs?: number
  /** The newest this many characters are kept for a pass. Default 65,536. */
  maxFrameChars?: number
  clock?: EffectsClock
}

export interface PaneEffectsStats {
  /** Messages pushed. */
  messages: number
  /** Passes run. */
  passes: number
  /** Passes that threw. */
  failures: number
  /** Characters waiting for the next pass. */
  pendingChars: number
  /** Messages waiting for the next pass. */
  pendingMessages: number
  /** Characters dropped from the front of a frame bigger than maxFrameChars. */
  droppedChars: number
}

export interface PaneEffects {
  /** A message arrived. O(1): the pass is scheduled, not run (except the first after quiet). */
  push: (data: string) => void
  /** Run the pending pass now (the pane was shown). A no-op with nothing pending. */
  flush: () => void
  /** Drop the scheduled pass and whatever is pending (the pane is going away). */
  cancel: () => void
  stats: () => PaneEffectsStats
}

// ---- counters for the e2e specs and the debugger (numbers only) ------------------------------------------------------

const tracked = new Map<string, PaneEffects>()

/** Make a pane's counters readable as window.__termpolis_pane_effects(). Returns the way to stop (a remount takes over the id). */
export function trackPaneEffects(id: string, effects: PaneEffects): () => void {
  tracked.set(id, effects)
  return () => { if (tracked.get(id) === effects) tracked.delete(id) }
}

/** Every tracked pane's counters, by terminal id. */
export function paneEffectsSnapshot(): Record<string, PaneEffectsStats> {
  const out: Record<string, PaneEffectsStats> = {}
  for (const [id, effects] of tracked) out[id] = effects.stats()
  return out
}

export const EFFECTS_VISIBLE_MS = 250
export const EFFECTS_HIDDEN_MS = 1000
export const EFFECTS_MAX_FRAME_CHARS = 65_536

// The globals are looked up at CALL time, not captured here: a test that installs fake timers after this module was
// imported must still be the clock this runs on (the same rule as trailingThrottle).
const globalClock: EffectsClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createPaneEffects(o: PaneEffectsOptions): PaneEffects {
  const clock = o.clock ?? globalClock
  const visibleMs = o.visibleMs ?? EFFECTS_VISIBLE_MS
  const hiddenMs = o.hiddenMs ?? EFFECTS_HIDDEN_MS
  const maxChars = Math.max(1, o.maxFrameChars ?? EFFECTS_MAX_FRAME_CHARS)

  let pending: string[] = []
  /** The consumed prefix of `pending`: chunks dropped off the front are not shifted one at a time. */
  let head = 0
  let pendingChars = 0
  let pendingMessages = 0
  let lastRun = -Infinity
  let timer: unknown = null
  let dueAt = Infinity

  let messages = 0
  let passes = 0
  let failures = 0
  let dropped = 0

  /** Keep the newest maxChars: whole chunks off the front first, then the front of the one that is left. */
  function trim(): void {
    while (pendingChars > maxChars && head < pending.length) {
      const over = pendingChars - maxChars
      const first = pending[head]
      if (first.length <= over) {
        pendingChars -= first.length
        dropped += first.length
        head++
      } else {
        pending[head] = first.slice(over)
        pendingChars -= over
        dropped += over
      }
    }
    // The dropped prefix leaves the array once it is both long and at least half of it (amortised O(1) a push).
    if (head >= 1024 && head * 2 >= pending.length) {
      pending = pending.slice(head)
      head = 0
    }
  }

  function clear(): void {
    pending = []
    head = 0
    pendingChars = 0
    pendingMessages = 0
  }

  function disarm(): void {
    if (timer !== null) clock.clearTimer(timer)
    timer = null
    dueAt = Infinity
  }

  function run(): void {
    // Bookkeeping first, so a throwing pass cannot leave this believing one is still scheduled.
    disarm()
    const live = pending.length - head
    const frame = live === 1 ? pending[head] : (head === 0 ? pending : pending.slice(head)).join('')
    const count = pendingMessages
    clear()
    lastRun = clock.now()
    passes++
    try {
      o.run(frame, count)
    } catch (e) {
      failures++
      throw e
    }
  }

  function request(): void {
    const now = clock.now()
    const target = lastRun + (o.isVisible() ? visibleMs : hiddenMs)
    if (target <= now) {
      run()
      return
    }
    // One pass is scheduled; it moves EARLIER when the pane has been shown since (a visible pane's window is shorter),
    // never later.
    if (timer !== null && dueAt <= target) return
    disarm()
    dueAt = target
    timer = clock.setTimer(run, target - now)
  }

  return {
    push(data) {
      messages++
      pendingMessages++
      pending.push(data)
      pendingChars += data.length
      if (pendingChars > maxChars) trim()
      request()
    },
    flush() {
      if (pendingMessages > 0) run()
    },
    cancel() {
      disarm()
      clear()
    },
    stats: () => ({ messages, passes, failures, pendingChars, pendingMessages, droppedChars: dropped }),
  }
}
