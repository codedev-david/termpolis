import { readXtermPending } from './xtermPending'
import { reportFailure } from './reportFailure'

/**
 * Resize a terminal in the order of its output (1.54.5, plan package P3).
 *
 * THE BUG: doFit ran fitAddon.fit() (xterm resizes at once) and then told the pty. xterm's write()
 * only QUEUES: it parses later, in slices of at most 12 ms. So whatever sat in the output throttle, in
 * the selection hold or in xterm's own queue when the fit ran had been drawn for the OLD size and was
 * parsed at the NEW one. ConPTY repaints the viewport after every resize and heals the visible screen;
 * the scrollback, a cursor-relative TUI's ghost rows and every non-ConPTY pty are left as they fell.
 * With a backlog of seconds (the lag this release is about) that is seconds of output at the wrong size.
 *
 * THE ORDER: (1) let go of output held back by a selection, so it joins the queue ahead of the resize;
 * (2) wait for the pane's writer to hand its backlog to xterm; (3) write an EMPTY string behind everything
 * xterm holds and resize in its callback, the one moment at which every byte before the resize has been
 * parsed at the size it was drawn for. `apply` is the resize itself: fit, then tell the pty.
 *
 * The writer in (2) is the pane's output (paneOutput.ts): the renderer's write scheduler by default, whose
 * `whenDrained` is `scheduler.drained(id)` (every char pushed before the call has been handed to xterm, and
 * what xterm holds is bounded by the terminal's in-flight cap, so the barrier in (3) waits for a fraction
 * of a second at worst), or the output throttle's `whenDrained` behind the kill switch. Both keep the same
 * contract, so this module knows neither.
 *
 * Fast path: when nothing is queued anywhere (or xterm's queue cannot be read) `apply` runs at once,
 * with no timer and no write, which is exactly the timing of 1.54.4. The barrier only waits behind a
 * backlog it can SEE.
 *
 * Never stuck: the whole wait is capped. If the throttle never drains (a stalled renderer, a refusing
 * writer) or xterm never calls back (torn down under it) `apply` runs when the cap passes, which is the
 * old behaviour a little late, never no resize at all. `apply` runs exactly once.
 *
 * Never throws into xterm: xterm runs a write callback BEFORE it moves past that chunk, so one that
 * throws leaves the chunk at the head of the queue and the write loop stopped for good. `apply` is
 * called inside such a callback; whatever it throws is reported (crash reporting still sees it), not
 * propagated.
 *
 * NOT fixed here, and not fixable here: bytes ConPTY has already put in its pipe when the pty is told
 * the new size are drawn for the old one (there is no in-band marker), and conhost's own repaint heals
 * the viewport but not the scrollback. The same goes for output that ARRIVES while the resize waits in
 * line: the pty has not been told yet, so it is drawn for the old size, but it queues behind the
 * resize and is parsed at the new one. Waiting for it too would never end under a flood; the cap
 * bounds the wait instead, and the redraw the pty makes once it is told puts the screen right.
 */

/** How long a resize waits, in all, for the output ahead of it to be parsed before it goes ahead anyway. */
export const RESIZE_DRAIN_CAP_MS = 3000

export interface StreamOrderDeps {
  /** Let go of output held back by a selection: it goes into the throttle, in order, ahead of the resize. */
  flushHold: () => void
  /**
   * The pane's output writer: how much it holds (`pending()`) and its drain hook (`whenDrained`), which for a
   * scheduled pane is the write scheduler's `drained(id)`. Either may be missing.
   */
  throttle?: {
    pending?: () => number
    whenDrained?: (cb: () => void, maxWaitMs: number) => () => void
  }
  /** xterm's write(): an empty write with a callback is the barrier. */
  term: { write: (data: string, cb?: () => void) => void }
  /** Chars in xterm's own queue, or null when unknown. Default: the installed xterm's private counter. */
  xtermPending?: () => number | null
  /** The resize: fit the grid, tell the pty. */
  apply: () => void
  /** Override RESIZE_DRAIN_CAP_MS. */
  capMs?: number
  /** Told about whatever flushHold or apply throws. Default: reportError, else the console. */
  onError?: (error: unknown) => void
}

export interface ResizeHandle {
  /** Stop waiting: `apply` will not run. A no-op once it has. */
  cancel: () => void
  /** True once `apply` has run, or the resize was cancelled. */
  readonly settled: boolean
}

export function resizeInStreamOrder(deps: StreamOrderDeps): ResizeHandle {
  const cap = deps.capMs ?? RESIZE_DRAIN_CAP_MS
  const onError = deps.onError ?? ((error: unknown) => reportFailure(error, 'resize'))
  let settled = false
  let capTimer: ReturnType<typeof setTimeout> | undefined
  let cancelDrain: (() => void) | undefined

  const report = (error: unknown): void => {
    try {
      onError(error)
    } catch {
      // a reporter that throws must not take the resize down with it
    }
  }

  const stop = (): void => {
    settled = true
    clearTimeout(capTimer)
    capTimer = undefined
    const c = cancelDrain
    cancelDrain = undefined
    c?.()
  }

  /** Run the resize, once. */
  const go = (): void => {
    if (settled) return
    stop()
    try {
      deps.apply()
    } catch (error) {
      report(error)
    }
  }

  /** The throttle is empty (or was not waited on): look at xterm's queue. */
  const afterThrottle = (): void => {
    if (settled) return
    cancelDrain = undefined // the throttle has run its callback: nothing left to cancel
    const queued = (deps.xtermPending ?? (() => readXtermPending(deps.term)))()
    if (queued === null || queued <= 0) {
      go()
      return
    }
    armCap()
    try {
      deps.term.write('', go)
    } catch {
      go() // xterm will not take it (over its watermark, torn down): resize now rather than never
    }
  }

  const armCap = (): void => {
    if (capTimer === undefined) capTimer = setTimeout(go, cap)
  }

  try {
    deps.flushHold()
  } catch (error) {
    report(error)
  }

  const throttle = deps.throttle
  const backlog = typeof throttle?.pending === 'function' ? throttle.pending() : 0
  if (backlog > 0 && typeof throttle?.whenDrained === 'function') {
    armCap()
    try {
      cancelDrain = throttle.whenDrained(afterThrottle, cap)
    } catch {
      afterThrottle() // the throttle will not take a wait: do not hang on it
    }
  } else {
    afterThrottle()
  }

  return {
    cancel: stop,
    get settled() {
      return settled
    },
  }
}
