import { createChunkQueue, type ChunkQueue } from './chunkQueue'
import { MAX_WRITE_RETRIES, retryDelayMs, type ThrottleErrorInfo } from './writeRetry'
import { reportFailure } from './reportFailure'

/**
 * The renderer's write scheduler (1.54.5, plan package P8): ONE per renderer, every terminal pane registers.
 *
 * THE PROBLEM. The renderer has one thread. It parses, lays out, paints and runs the per-message handlers for
 * EVERY terminal, hidden ones included. Each pane used to own an output throttle that handed xterm up to 64 KB
 * per frame whatever xterm had already been given, and every terminal's xterm then drained its own FIFO in
 * 12 ms slices re-queued with setTimeout(0): busy terminals take turns, so the focused one got about 1/N of the
 * thread. Nothing bounded what was already handed over, and a FIFO cannot be reordered once it has the data:
 * the echo of a key typed into a terminal waited behind everything that terminal had been handed, and the
 * terminal's slices waited behind everybody else's. Under load (80 to 90% CPU, five workflows printing) that
 * was seconds.
 *
 * THE FIX, in five rules. The data stays HERE, in a chunk list per terminal, until xterm may have it:
 *   1. In flight: at most a cap of chars per terminal is with xterm (handed, not yet parsed), counted from the
 *      callback of term.write. Whatever is not handed yet can still be ordered.
 *   2. Priority: one pass per frame serves the focused terminal first, then the other visible panes, then the
 *      hidden ones. The focused terminal is bounded by its own cap only.
 *   3. The pool: what the others are handed is the leftover of two budgets, the chars in flight in ALL terminals
 *      (the pool: what the focused terminal has in flight comes off it, so the more it has ahead of its next
 *      slices the less anybody else may add in front of them) and the chars one frame may hand over. Nothing
 *      is timed: a slow thread shows up as acks that come late, the pool stays full, and the others wait.
 *      (A focused terminal that is only waiting out a refusal's back-off has little in flight and rations
 *      nobody: a stuck terminal must not punish the others.)
 *   4. Typing: while a key was typed in the last 300 ms the slices, caps, pool and frame budget all shrink (the
 *      focused terminal hands over 16 KB at a time, so xterm yields often) and the focused terminal refills the
 *      moment xterm acks. A terminal with data waiting is still handed a starvation slice at least every
 *      500 ms, so a hidden one is never left unparsed for long.
 *   5. Order: inside one terminal bytes are never reordered, split, merged out of order or lost; a chunk xterm
 *      refuses is kept and offered again (the same policy as the output throttle, writeRetry.ts).
 *
 * WHAT IT DOES NOT DO. It cannot slow a producer: output keeps arriving from main whether anyone reads it
 * (that is credit flow control, a separate package). While a terminal is rationed its backlog grows in
 * strings here, so a terminal whose backlog passes `holdCapChars` is no longer rationed. It cannot preempt a
 * slice xterm is already parsing, and a keystroke's journey through main is outside it.
 *
 * KEPT FROM THE THROTTLE. The user-input fast path: a small write that finds nothing queued goes to xterm at
 * once (xterm then parses it synchronously when a key was just typed and its own queue is empty); while a key
 * is going in only the terminal it went into has it. And rAF + a 100 ms timer as the two clocks of a pass, so a
 * covered window keeps draining (its passes are 100 ms apart, and what they hand over is scaled to match).
 *
 * FAILS OPEN. A refused chunk is kept and retried. An ack that never comes (xterm torn down, a wedged write
 * loop) is given up on after `ackTimeoutMs` and the credit is returned. An exception in the scheduler's own
 * code switches it to pass-through: queued data is flushed in order and every later write goes straight to
 * xterm, which is the behaviour of a renderer without any throttle. The kill switch (localStorage
 * 'termpolis.writeScheduler' = '0', read by paneOutput.ts when a pane mounts) puts the output throttle back.
 */

export type PaneClass = 'focused' | 'visible' | 'hidden'

export interface SchedulerLimits {
  /** Chars a terminal may have in flight (handed to xterm, not yet parsed), by class, while nobody is typing. */
  inflight: Record<PaneClass, number>
  /** ...and while a key was typed in the last `typingWindowMs`. */
  inflightTyping: Record<PaneClass, number>
  /** The biggest single hand-over (one term.write), by class. xterm checks its 12 ms budget only BETWEEN chunks. */
  slice: Record<PaneClass, number>
  sliceTyping: Record<PaneClass, number>
  /**
   * The most chars that may be in flight in ALL terminals together when the terminals that are NOT focused are
   * handed more (the focused terminal is bounded by its own cap only). What the focused terminal already has in
   * flight counts against it.
   */
  pool: number
  poolTyping: number
  /** Chars the terminals that are NOT focused may be handed in one pass, all together; the focused terminal's hand-over counts against it. */
  frameBudget: number
  frameBudgetTyping: number
  /** A key was "just typed" for this long. */
  typingWindowMs: number
  /** A terminal with data waiting is handed a starvation slice at least this often, whatever else is going on. */
  starvationMs: number
  starveSlice: number
  /** A write this small to the focused terminal, with nothing queued, skips the frame (the echo path). */
  smallWrite: number
  /** In flight this long without an ack: give the credit back (xterm never called back). */
  ackTimeoutMs: number
  /**
   * A terminal (that is not the focused one) whose backlog passes this is not rationed by the pool and not held to
   * its in-flight cap: it is handed one slice a pass whatever is in flight, which is what the output throttle did
   * (64 KB a frame). Held-back output is strings, so the hold must not grow faster than it did.
   */
  holdCapChars: number
  /** The timer half of a tick: fires when no animation frame does (a covered or minimised window). */
  watchdogMs: number
}

export const DEFAULT_LIMITS: Readonly<SchedulerLimits> = Object.freeze({
  // 128 KB = two 64 KB slices: xterm always has the next one while it parses the first. A visible pane in a
  // split and a hidden one get 64 KB: the same per pass as the output throttle every pane had (64 KB a frame),
  // so a terminal nobody looks at drains no slower than before (a covered window has no frames, and its passes
  // are 100 ms apart). What bounds the others in aggregate is the pool, not these caps; what bounds one block of
  // the thread is the slice, which stays at 32 KB for a hidden pane.
  inflight: Object.freeze({ focused: 131_072, visible: 65_536, hidden: 65_536 }),
  // While typing: the focused terminal keeps 64 KB (10 to 20 ms of parse) ahead of the echo at most; the others
  // one or two small slices.
  inflightTyping: Object.freeze({ focused: 65_536, visible: 16_384, hidden: 8_192 }),
  slice: Object.freeze({ focused: 65_536, visible: 65_536, hidden: 32_768 }),
  sliceTyping: Object.freeze({ focused: 16_384, visible: 8_192, hidden: 8_192 }),
  // The focused terminal's own cap: with the focused terminal saturated (everything it may have in flight IS in
  // flight) the others get nothing but their starvation slices; with it idle they share the whole of it. Any
  // more and the others' parse takes turns with the focused terminal's slices on the one thread: measured in
  // the model of the lag, a pool a quarter bigger gives the others a third of the thread at 4x load and the
  // focused terminal, which needs two thirds, no slack at all.
  pool: 131_072,
  poolTyping: 65_536,
  frameBudget: 262_144,
  // About 6 ms of parse for everybody but the focused terminal, which is what is left of a 16 ms frame once a
  // key's handler, the echo and the paint have had theirs.
  frameBudgetTyping: 32_768,
  typingWindowMs: 300,
  starvationMs: 500,
  starveSlice: 8_192,
  smallWrite: 8_192,
  ackTimeoutMs: 2_000,
  holdCapChars: 4_194_304,
  watchdogMs: 100,
})

/** What the scheduler needs of the clock; the defaults are performance.now, requestAnimationFrame and setTimeout. */
export interface SchedulerClock {
  now(): number
  /** Like requestAnimationFrame; null when there is no frame clock (the timer alone then drives the tick). */
  requestFrame(cb: () => void): unknown
  cancelFrame(handle: unknown): void
  setTimer(cb: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface SchedulerOptions {
  clock?: Partial<SchedulerClock>
  limits?: Partial<SchedulerLimits>
  /** Told about the scheduler's own failures (never about a refused write: that is `PaneDeps.onError`). Default: reportError, else the console. */
  onInternalError?: (error: unknown) => void
}

export interface PaneDeps {
  /**
   * Hand `data` to xterm: `term.write(data, ack)`. `ack` must be called once the parser has consumed it (xterm's
   * write callback). May throw: the chunk is then kept and offered again.
   */
  write: (data: string, ack: () => void) => void
  /** What this pane is right now; read whenever the scheduler decides, so it needs no notification when it changes. */
  classify: () => PaneClass
  /** Told about a refused chunk: the FIRST refusal of an episode, and the drop. Default: reportError, else the console. */
  onError?: (error: unknown, info: ThrottleErrorInfo) => void
  /** The queue the pane's backlog lives in (default: a chunk list). */
  queue?: ChunkQueue
}

/**
 * What a pane writes through. The call shape of the output throttle (so the echo trace and the resize barrier
 * take it as they took the throttle), plus what the scheduler adds.
 */
export type PaneWriter = ((data: string) => void) & {
  readonly id: string
  /** Chars queued here, not yet handed to xterm (the throttle's `pending()`). */
  pending: () => number
  /** Chars handed to xterm and not yet parsed. */
  inflight: () => number
  /** `scheduler.drained(id, ...)`. */
  whenDrained: (cb: () => void, maxWaitMs: number) => () => void
  /** The user typed `data` into this terminal (input that is a terminal's own report does not count). */
  typed: (data?: string) => void
  /** The pane is gone: its queue is dropped and nothing more is handed to its terminal. */
  detach: () => void
}

export interface SchedulerStats {
  /** Panes attached now. */
  panes: number
  /** Passes (frame or watchdog) made, and how many of them the watchdog timer made (no frame came). */
  ticks: number
  timerTicks: number
  /** term.write calls made on behalf of panes. */
  handoffs: number
  handedChars: number
  ackedChars: number
  /** Small writes that went to xterm at once (the echo path). */
  fastPath: number
  /** Passes in which a terminal with data waiting was handed nothing because the pool or the frame's budget was used up. */
  rationedPasses: number
  /** Starvation slices handed over. */
  starveServes: number
  /** Acks given up on. */
  ackTimeouts: number
  /** Chunks xterm refused, and chunks dropped after MAX_WRITE_RETRIES refusals. */
  refusals: number
  drops: number
  /** Keystrokes noted. */
  keys: number
  /** Chars queued here now, and chars in flight now. */
  queuedChars: number
  inflightChars: number
  /** The most chars any one terminal has had in flight, by the class it had when it was handed them. */
  maxInflight: Record<PaneClass, number>
  /** True once the scheduler failed and went to pass-through. */
  bypassed: boolean
}

export interface WriteScheduler {
  attach(id: string, deps: PaneDeps): PaneWriter
  /**
   * Call `cb` once every char pushed to `id` BEFORE this call has been handed to xterm (chars that arrive later
   * do not hold it back), or after `maxWaitMs`, whichever comes first, exactly once; at once when nothing is
   * queued or `id` is unknown. Returns a function that cancels the wait. A resize waits on it, so the grid never
   * changes under output that was drawn for the old one.
   */
  drained(id: string, cb: () => void, maxWaitMs: number): () => void
  /** Chars queued for `id`, not yet handed to xterm (0 when unknown). */
  pending(id: string): number
  /** A key was typed into `id`. */
  noteKey(id: string, data?: string): void
  stats(): SchedulerStats
  /** Detach every pane and stop the clocks (tests; the renderer never needs it). */
  dispose(): void
}

/**
 * Is `data` something the USER typed (or pasted, or a mouse report: they asked for a repaint), as opposed to
 * what xterm itself sends back in answer to what the program printed? Focus reports and device, status and
 * cursor-position replies come with output; counting them as typing would keep the typing rules on for as long
 * as a program asks questions.
 */
export function isUserInput(data: string): boolean {
  if (data.length === 0) return false
  if (data.charCodeAt(0) !== 0x1b) return true
  return !TERMINAL_REPLY.test(data)
}

// ESC [ I and ESC [ O focus reports; ESC [ ? / > / = ... device attribute and mode replies; ESC [ n ; m R cursor
// position and ESC [ n n status replies; OSC and DCS replies, which end in BEL or ST. A key (Alt+] is ESC ]) or a
// paste never ends this way.
const TERMINAL_REPLY = /^\u001b(?:\[[IO]$|\[[?>=][\d;:$"' ]*[A-Za-z~]$|\[\d+(?:;\d+)*[Rn]$|\][\s\S]*(?:\u0007|\u001b\\)$|P[\s\S]*\u001b\\$)/

interface Waiter {
  target: number
  cb: () => void
  timer: unknown
}

interface PaneState {
  readonly id: string
  readonly seq: number
  readonly deps: PaneDeps
  readonly queue: ChunkQueue
  detached: boolean
  /** True while this pane's hand-over loop runs: an ack that arrives inside it must not start another. */
  serving: boolean
  /** Chars ever accepted / ever handed on or dropped: a wait's target is a point on this line. */
  pushed: number
  handed: number
  /** Chars handed to xterm and not yet acked. */
  inflight: number
  peak: number
  /** Bumped when in-flight credit is given up on or the pane detaches: acks of the old epoch are stale. */
  epoch: number
  /** When in-flight last went up from nothing, or an ack last came. */
  progressAt: number
  /** Since when data has been waiting here without a hand-over (0: nothing is). */
  waitingSince: number
  /** Last hand-over (rotation among equals: least recently served first). */
  servedAt: number
  /** Consecutive refusals of the chunk at the head of the queue, and when it may be offered again. */
  failures: number
  retryAt: number
  waiters: Waiter[]
}

const defaultClock: SchedulerClock = {
  now: () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()),
  requestFrame: (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : null),
  cancelFrame: (handle) => {
    if (handle !== null && handle !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle as number)
  },
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** In bypass, queued data goes to xterm in writes of this size (the throttle's 64 KB). */
const BYPASS_WRITE = 65_536

const noop = (): void => undefined

/** A frame at 60 Hz, in ms: the pass interval the budgets are written for. */
const FRAME_MS = 16

const byLeastRecentlyServed = (a: PaneState, b: PaneState): number => a.servedAt - b.servedAt || a.seq - b.seq

export function createWriteScheduler(options: SchedulerOptions = {}): WriteScheduler {
  const clock: SchedulerClock = { ...defaultClock, ...options.clock }
  const limits: SchedulerLimits = { ...DEFAULT_LIMITS, ...options.limits }
  const reportInternal = (error: unknown): void => {
    try {
      ;(options.onInternalError ?? ((e: unknown) => reportFailure(e, 'write scheduler')))(error)
    } catch {
      // a reporter that throws must not take the scheduler down with it
    }
  }

  const panes = new Map<string, PaneState>()
  let seq = 0
  let lastKeyAt = Number.NEGATIVE_INFINITY
  let typedId: string | undefined
  let armed = false
  let frameHandle: unknown = null
  let timerHandle: unknown
  let bypass = false

  const counters = {
    ticks: 0, handoffs: 0, handedChars: 0, ackedChars: 0, fastPath: 0, rationedPasses: 0, timerTicks: 0, starveServes: 0,
    ackTimeouts: 0, refusals: 0, drops: 0, keys: 0,
  }
  const maxInflight: Record<PaneClass, number> = { focused: 0, visible: 0, hidden: 0 }

  // Reused by every pass: a pass runs up to 60 times a second and allocates nothing but what it hands over.
  const focusedList: PaneState[] = []
  const visibleList: PaneState[] = []
  const hiddenList: PaneState[] = []

  // A clock that went backwards (a test's fake timers restarting, a timer source swapped) must not leave "typing" on.
  const isTyping = (now: number): boolean => {
    const since = now - lastKeyAt
    return since >= 0 && since < limits.typingWindowMs
  }

  function classOf(p: PaneState, typing: boolean): PaneClass {
    let c: PaneClass
    try {
      const v = p.deps.classify()
      c = v === 'focused' || v === 'hidden' ? v : 'visible'
    } catch {
      c = 'visible'
    }
    // The terminal a key is going into is the focused one, whatever the store has caught up with. Never a hidden
    // one: nobody types into a pane that is not on screen, so a hidden pane is not promoted, whatever its xterm sends.
    return typing && typedId === p.id && c !== 'hidden' ? 'focused' : c
  }

  // ---- the clocks -------------------------------------------------------------------------------------------

  function disarm(): void {
    if (!armed) return
    armed = false
    try {
      clock.cancelFrame(frameHandle)
    } finally {
      frameHandle = null
      clock.clearTimer(timerHandle)
      timerHandle = undefined
    }
  }

  /** Arm both clocks; whichever fires first cancels the other. */
  function ensureTick(): void {
    if (armed || bypass) return
    armed = true
    frameHandle = clock.requestFrame(() => onTick(false))
    timerHandle = clock.setTimer(() => onTick(true), limits.watchdogMs)
  }

  /**
   * One pass. `viaTimer`: the timer got here first, which is what a covered or minimised window looks like (no
   * frames): passes are then `watchdogMs` apart instead of 16 ms, and what the others may be handed per pass
   * is scaled up to match, so a window nobody is looking at does not drain a tenth as fast as one that is.
   */
  function onTick(viaTimer: boolean): void {
    try {
      disarm()
      counters.ticks++
      if (viaTimer) counters.timerTicks++
      serveAll(clock.now(), viaTimer)
      if (anyQueued()) ensureTick()
    } catch (error) {
      failOpen(error)
    }
  }

  function anyQueued(): boolean {
    for (const p of panes.values()) if (p.queue.length > 0) return true
    return false
  }

  // ---- waits ------------------------------------------------------------------------------------------------

  function runWaiter(p: PaneState, w: Waiter): void {
    const i = p.waiters.indexOf(w)
    if (i < 0) return // already served, or cancelled
    p.waiters.splice(i, 1)
    clock.clearTimer(w.timer)
    try {
      w.cb()
    } catch (error) {
      reportFailure(error, 'write scheduler wait')
    }
  }

  /** Serve every wait whose target has been handed to xterm (or dropped). */
  function settle(p: PaneState): void {
    if (p.waiters.length === 0) return
    for (const w of p.waiters.slice()) if (w.target <= p.handed) runWaiter(p, w)
  }

  function drainedPane(p: PaneState, cb: () => void, maxWaitMs: number): () => void {
    const target = p.pushed
    if (p.detached || bypass || p.handed >= target) {
      cb()
      return noop
    }
    const w: Waiter = { target, cb, timer: undefined }
    w.timer = clock.setTimer(() => runWaiter(p, w), Math.max(0, maxWaitMs || 0))
    p.waiters.push(w)
    return () => {
      const i = p.waiters.indexOf(w)
      if (i >= 0) p.waiters.splice(i, 1)
      clock.clearTimer(w.timer)
    }
  }

  // ---- handing data to xterm --------------------------------------------------------------------------------

  function notify(p: PaneState, error: unknown, info: ThrottleErrorInfo): void {
    try {
      ;(p.deps.onError ?? ((e: unknown) => reportFailure(e, 'output throttle')))(error, info) // the label the throttle it replaces used
    } catch {
      // a reporter that throws must not take the scheduler down with it
    }
  }

  /** xterm refused `out` (it was taken from the queue, or never queued): keep it, or drop it after too many refusals. Returns false: stop for now. */
  function refuse(p: PaneState, out: string, error: unknown, now: number): boolean {
    counters.refusals++
    p.failures++
    const dropped = p.failures > MAX_WRITE_RETRIES
    if (p.failures === 1 || dropped) notify(p, error, { attempt: p.failures, dropped, chars: out.length })
    if (!dropped) {
      p.queue.restore(out) // the chunk stays at the head, in front of anything that arrived since
      p.retryAt = now + retryDelayMs(p.failures)
      if (p.waitingSince === 0) p.waitingSince = now
      return false
    }
    p.failures = 0
    p.retryAt = 0
    counters.drops++
    p.handed += out.length // gone, and a resize waiting on it must not wait for ever
    settle(p)
    return false // the next chunk is offered on the next pass, not in a tight loop behind a dead terminal
  }

  /** The one place a terminal's xterm is written to. True when xterm took `out`. */
  function handOver(p: PaneState, out: string, now: number): boolean {
    const len = out.length
    if (p.inflight === 0) p.progressAt = now
    p.inflight += len
    if (p.inflight > p.peak) p.peak = p.inflight
    const epoch = p.epoch
    let settled = false
    // Never throws: xterm runs a write callback BEFORE it moves past that chunk, so one that throws leaves the
    // chunk at the head of its queue and its write loop stopped for good.
    const ack = (): void => {
      if (settled) return
      settled = true
      try {
        onAck(p, epoch, len)
      } catch (error) {
        failOpen(error)
      }
    }
    try {
      p.deps.write(out, ack) // may call `ack` before it returns: in-flight was counted first
    } catch (error) {
      settled = true // a refused write is never acked
      if (p.epoch === epoch) p.inflight = Math.max(0, p.inflight - len)
      return refuse(p, out, error, now)
    }
    counters.handoffs++
    counters.handedChars += len
    p.failures = 0
    p.retryAt = 0
    p.handed += len
    p.servedAt = now
    p.waitingSince = p.queue.length > 0 ? now : 0
    settle(p)
    return true
  }

  function onAck(p: PaneState, epoch: number, len: number): void {
    if (p.detached || p.epoch !== epoch) return // given up on already (or the pane is gone): the credit was returned
    p.inflight = Math.max(0, p.inflight - len)
    counters.ackedChars += len
    const now = clock.now()
    p.progressAt = now
    if (p.queue.length === 0 || p.serving || bypass) return
    // The focused terminal refills the moment xterm has room, inside xterm's own write loop, so the loop never
    // runs dry between frames. Everybody else waits for the pass that orders them.
    const typing = isTyping(now)
    if (classOf(p, typing) === 'focused') servePane(p, 'focused', typing, Number.POSITIVE_INFINITY)
    else ensureTick()
  }

  /** Give the credit back for chars that were never acked (xterm will not call back). */
  function giveUpOnAcks(p: PaneState): void {
    p.epoch++
    p.inflight = 0
    counters.ackTimeouts++
  }

  /**
   * Hand `p` up to `limit` chars, as far as its in-flight room goes. Returns the chars handed. `overCap`: the pane's
   * backlog is past holdCapChars, so it has no in-flight cap and is handed one slice.
   */
  function servePane(p: PaneState, cls: PaneClass, typing: boolean, limit: number, overCap = false): number {
    if (p.serving) return 0 // re-entrant: a write handler pushed to its own pane while this hand-over runs; the loop below picks it up
    const now = clock.now()
    if (p.retryAt > now) return 0
    const cap = overCap ? Number.POSITIVE_INFINITY : (typing ? limits.inflightTyping : limits.inflight)[cls]
    const slice = (typing ? limits.sliceTyping : limits.slice)[cls]
    if (overCap) limit = Math.min(limit, slice)
    p.serving = true
    let total = 0
    try {
      while (total < limit && p.queue.length > 0) {
        if (p.inflight >= cap && p.inflight > 0 && now - p.progressAt >= limits.ackTimeoutMs) giveUpOnAcks(p)
        const room = cap - p.inflight
        const n = Math.min(slice, room, limit - total, p.queue.length)
        if (!(n > 0)) break // no room (or a limit that allows nothing): wait for acks
        const out = p.queue.take(n)
        if (!handOver(p, out, now)) break
        total += out.length
        if (p.inflight > maxInflight[cls]) maxInflight[cls] = p.inflight
      }
    } finally {
      p.serving = false
    }
    return total
  }

  /**
   * One pass: the focused terminal first, then the visible panes, then the hidden ones, the last two from what
   * is left of the pool and of the frame's budget.
   */
  function serveAll(now: number, viaTimer: boolean): void {
    if (bypass) return
    const typing = isTyping(now)
    // Nobody is typing (a key means a visible window, so a frame clock): the passes are watchdogMs apart.
    const scale = viaTimer && !typing ? Math.max(1, Math.round(limits.watchdogMs / FRAME_MS)) : 1
    focusedList.length = 0
    visibleList.length = 0
    hiddenList.length = 0
    let inflightTotal = 0
    for (const p of panes.values()) {
      inflightTotal += p.inflight
      if (p.queue.length === 0) continue
      const cls = classOf(p, typing)
      if (cls === 'focused') focusedList.push(p)
      else (cls === 'visible' ? visibleList : hiddenList).push(p)
    }

    let handedFocused = 0
    for (const p of focusedList) handedFocused += servePane(p, 'focused', typing, Number.POSITIVE_INFINITY)

    if (visibleList.length === 0 && hiddenList.length === 0) return
    visibleList.sort(byLeastRecentlyServed)
    hiddenList.sort(byLeastRecentlyServed)
    // What the others may be handed: the chars one frame may hand over (the focused terminal's come off it), and
    // what is left of the pool once everything already in flight, the focused terminal's included, is counted.
    // (An ack that lands during the pass only makes `inflightTotal` an over-estimate.)
    let budget = Math.max(0, (typing ? limits.frameBudgetTyping : limits.frameBudget) * scale - handedFocused)
    let pool = Math.max(0, (typing ? limits.poolTyping : limits.pool) * scale - inflightTotal - handedFocused)
    let rationed = false
    for (let k = 0; k < 2; k++) {
      const list = k === 0 ? visibleList : hiddenList
      const cls: PaneClass = k === 0 ? 'visible' : 'hidden'
      for (const p of list) {
        // A pane with a resize waiting on it, or a backlog so big that rationing it is a memory problem, is
        // not rationed by the pool; the second is not held to its in-flight cap either (see holdCapChars).
        const overCap = p.queue.length > limits.holdCapChars
        const exempt = p.waiters.length > 0 || overCap
        let allowance = Math.min(budget, exempt ? Number.POSITIVE_INFINITY : pool)
        const starved = p.waitingSince > 0 && now - p.waitingSince >= limits.starvationMs
        if (allowance < limits.starveSlice && starved) {
          // Whatever the budgets say, a terminal that has waited this long is handed a slice.
          allowance = limits.starveSlice
          const n = servePane(p, cls, typing, allowance, overCap)
          if (n > 0) counters.starveServes++
          budget = Math.max(0, budget - n)
          pool = Math.max(0, pool - n)
          continue
        }
        if (allowance <= 0) {
          rationed = true
          continue
        }
        const n = servePane(p, cls, typing, allowance, overCap)
        budget = Math.max(0, budget - n)
        pool = Math.max(0, pool - n)
      }
    }
    if (rationed) counters.rationedPasses++
  }

  // ---- panes ------------------------------------------------------------------------------------------------

  /** Writes while the scheduler is bypassed: queued data first, in order, then this, straight to xterm. */
  function flushRaw(p: PaneState): void {
    const now = clock.now()
    while (p.queue.length > 0) {
      const out = p.queue.take(BYPASS_WRITE)
      try {
        p.deps.write(out, noop)
      } catch (error) {
        p.queue.restore(out)
        notify(p, error, { attempt: 1, dropped: false, chars: out.length })
        return
      }
      p.handed += out.length
      p.servedAt = now
    }
    p.waitingSince = 0
    p.inflight = 0
    p.handed = Math.max(p.handed, p.pushed - p.queue.length)
    for (const w of p.waiters.slice()) runWaiter(p, w)
  }

  /** The scheduler's own code failed: stop scheduling, flush in order, pass everything through from now on. */
  function failOpen(error: unknown): void {
    if (bypass) return
    bypass = true
    reportInternal(error)
    try {
      disarm()
    } catch {
      // the clocks are the thing that may have failed: nothing more to do about them
    }
    for (const p of Array.from(panes.values())) {
      try {
        flushRaw(p)
      } catch (flushError) {
        reportInternal(flushError)
      }
    }
  }

  function push(p: PaneState, data: string): void {
    if (p.detached || data.length === 0) return
    if (bypass) {
      p.pushed += data.length
      p.queue.push(data)
      flushRaw(p)
      return
    }
    p.pushed += data.length
    let accounted = false
    try {
      const now = clock.now()
      const typing = isTyping(now)
      const cls = classOf(p, typing)
      // The keystroke-echo path. The PTY echoes each typed char straight back, and an echo that waits for the
      // next frame is felt as lag. Any pane has it while nobody is typing (it is what the output throttle gave
      // every pane); while a key is going in only the terminal it went into does, because what another pane is
      // handed then is thread time the echo would have had. The room check keeps in-flight at the cap plus this
      // one small write at most, so a stalled xterm cannot be fed small writes for ever.
      if (
        (cls === 'focused' || !typing) && p.queue.length === 0 && p.failures === 0 && data.length <= limits.smallWrite &&
        p.inflight + data.length <= (typing ? limits.inflightTyping : limits.inflight)[cls] + limits.smallWrite
      ) {
        accounted = true
        if (handOver(p, data, now)) {
          counters.fastPath++
          if (p.inflight > maxInflight[cls]) maxInflight[cls] = p.inflight
        } else {
          ensureTick()
        }
        return
      }
      const wasEmpty = p.queue.length === 0
      p.queue.push(data)
      accounted = true
      if (wasEmpty) p.waitingSince = now
      // A key is going into this terminal: its output does not wait for the frame.
      if (typing && cls === 'focused') servePane(p, cls, typing, Number.POSITIVE_INFINITY)
      if (p.queue.length > 0) ensureTick()
    } catch (error) {
      if (!accounted) p.queue.push(data)
      failOpen(error)
    }
  }

  function detachPane(p: PaneState): void {
    if (p.detached) return
    p.detached = true
    p.epoch++
    p.inflight = 0
    p.queue.clear()
    for (const w of p.waiters) clock.clearTimer(w.timer)
    p.waiters.length = 0
    panes.delete(p.id) // a pane is replaced by detaching it first (attach), so the entry is this pane's
    if (typedId === p.id) typedId = undefined
  }

  function noteKey(id: string, data?: string): void {
    if (data !== undefined && !isUserInput(data)) return
    // Nobody types into a pane that is not on screen: what its xterm sends is the terminal talking (a reply the
    // classifier above does not know), and it must neither start the typing rules nor stand in for the user.
    const pane = panes.get(id)
    if (pane && classOf(pane, false) === 'hidden') return
    lastKeyAt = clock.now()
    typedId = id
    counters.keys++
  }

  function attach(id: string, deps: PaneDeps): PaneWriter {
    const old = panes.get(id)
    if (old) detachPane(old) // a pane that remounts under the same id takes over from the one it replaces
    const p: PaneState = {
      id, seq: seq++, deps, queue: deps.queue ?? createChunkQueue(), detached: false, serving: false,
      pushed: 0, handed: 0, inflight: 0, peak: 0, epoch: 0, progressAt: 0, waitingSince: 0, servedAt: 0,
      failures: 0, retryAt: 0, waiters: [],
    }
    panes.set(id, p)
    return Object.assign((data: string): void => push(p, data), {
      id,
      pending: (): number => p.queue.length,
      inflight: (): number => p.inflight,
      whenDrained: (cb: () => void, maxWaitMs: number): (() => void) => drainedPane(p, cb, maxWaitMs),
      typed: (data?: string): void => noteKey(id, data),
      detach: (): void => detachPane(p),
    })
  }

  return {
    attach,
    drained: (id, cb, maxWaitMs) => {
      const p = panes.get(id)
      if (!p) {
        cb()
        return noop
      }
      return drainedPane(p, cb, maxWaitMs)
    },
    pending: (id) => panes.get(id)?.queue.length ?? 0,
    noteKey,
    stats: () => {
      let queuedChars = 0
      let inflightChars = 0
      for (const p of panes.values()) {
        queuedChars += p.queue.length
        inflightChars += p.inflight
      }
      return {
        panes: panes.size,
        ...counters,
        queuedChars,
        inflightChars,
        maxInflight: { ...maxInflight },
        bypassed: bypass,
      }
    },
    dispose: () => {
      for (const p of Array.from(panes.values())) detachPane(p)
      try {
        disarm()
      } catch {
        // nothing left to cancel
      }
    },
  }
}

let shared: WriteScheduler | null = null

/** The renderer's scheduler: created on first use. */
export function getWriteScheduler(): WriteScheduler {
  if (!shared) shared = createWriteScheduler()
  return shared
}

/** Tests: drop the shared scheduler so the next getWriteScheduler() starts clean. */
export function resetWriteScheduler(): void {
  shared?.dispose()
  shared = null
}
