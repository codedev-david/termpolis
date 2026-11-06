import { resizeInStreamOrder, type ResizeHandle, type StreamOrderDeps } from './resizeInStreamOrder'
import { reportFailure } from './reportFailure'

/**
 * A pane's doFit (1.54.5, plan package P3): WHEN a pane may fit to its container, and what a fit does.
 *
 * It fits only when the pane may:
 *   - not while the mount's replay is being parsed at the pty's size (`isHeld`): the replay's release asks again;
 *   - not while the pane is hidden: every mounted pane used to refit on every window resize, hidden ones
 *     too (5 to 69 ms of reflow each, a conhost repaint and an agent redraw). `needsFit` remembers that
 *     one is owed; the visibility effect asks again when the pane is shown. The one exception is a pane
 *     whose pty has never been told a size (one mounted hidden, a background tab at start-up): it is
 *     fitted once while hidden (a hidden pane keeps its box), as 1.54.4 did, or its agent would draw at
 *     the spawn size of 80 x 24 until the tab is first opened;
 *   - not while a selection is active (fit reflows the buffer and xterm does not remap a selection across
 *     it), for at most SELECTION_DEFER_CAP_MS: it used to wait for ever, and output was held that whole time;
 *   - not to a degenerate grid: FitAddon answers 2 x 1 (its own minimum) for a 0 px container and the
 *     pty was told, so a TUI repainted at 2 columns into the scrollback and the retained window. The last
 *     good size is kept instead. Only that grid is declined: a small pane (a 10% split, 4 visible rows)
 *     is a real layout and is fitted, or its prompt sits below what the user can see. `floor: false`
 *     (the termpolis.fitFloor switch) declines nothing;
 *   - not before xterm can measure: proposeDimensions() answers undefined while the cell size is still 0
 *     (just after a content-visibility show). That is retried on the next frames (at most
 *     UNMEASURED_RETRY_FRAMES) with the fit still owed; it used to clear `needsFit` and tell the pty the
 *     stale size.
 * and when it does, it does it in stream order (resizeInStreamOrder), with the pty told the size xterm
 * ended up with even if fit() throws.
 *
 * It does NOT skip a resize because the size is unchanged. conhost repaints the whole viewport on every
 * resize, including to the same size (measured: 1,752 chars on build 26200), and that repaint is the
 * only thing that heals a remounted pane's viewport.
 */

/** The smallest pane the split divider makes (splitRatio.ts). The fit itself declines only a degenerate grid. */
export const MIN_FIT_COLS = 20
export const MIN_FIT_ROWS = 5
/** A proposed grid this small (FitAddon's own minimum, 2 x 1) is a 0 px container, not a layout. */
export const DEGENERATE_COLS = 2
export const DEGENERATE_ROWS = 1
/** How many frames an unmeasurable proposal is retried for while the pane is visible. */
export const UNMEASURED_RETRY_FRAMES = 10
/** Ask again this often while a selection is active (what doFit always did). */
export const SELECTION_RETRY_MS = 150
/** ...for at most this long, counted from the first request: then fit once, selection or not. */
export const SELECTION_DEFER_CAP_MS = 1000

export interface PaneFitterDeps {
  isDisposed: () => boolean
  /** The mount's replay is being parsed at the pty's size: fits wait for its release. */
  isHeld: () => boolean
  isVisible: () => boolean
  isSelectionActive: () => boolean
  /** Called when a fit is about to be tried, before anything is flushed or waited on (the echo trace's queue reading). */
  onFit?: () => void
  /** Let go of output held back by a selection (see resizeInStreamOrder). */
  flushHold: () => void
  throttle?: StreamOrderDeps['throttle']
  term: { cols: number; rows: number; write: (data: string, cb?: () => void) => void }
  addon: { fit: () => void; proposeDimensions?: () => { cols: number; rows: number } | undefined }
  /** Tell the pty: resizeTerminal(id, cols, rows). */
  send: (cols: number, rows: number) => void
  xtermPending?: () => number | null
  /** Override the drain cap. */
  capMs?: number
  /** Told about whatever fit() or a hook throws. Default: reportError, else the console. */
  onError?: (error: unknown) => void
  /** Decline a degenerate (0 px container) grid. Default true; false is the termpolis.fitFloor switch. */
  floor?: boolean
  /** Run cb on the next frame; returns a canceller. Default: requestAnimationFrame. */
  nextFrame?: (cb: () => void) => () => void
}

const defaultNextFrame = (cb: () => void): (() => void) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(cb)
    return () => cancelAnimationFrame(id)
  }
  const t = setTimeout(cb, 16)
  return () => clearTimeout(t)
}

export interface PaneFitter {
  /** Ask for a fit. Safe to call as often as the ResizeObserver does. */
  request: () => void
  /** Drop a waiting resize and a pending retry. */
  cancel: () => void
  /** A fit was asked for while the pane was hidden and has not been done since. */
  readonly needsFit: boolean
  /** A resize is waiting for the output ahead of it. */
  readonly waiting: boolean
}

export function createPaneFitter(deps: PaneFitterDeps): PaneFitter {
  const report = (error: unknown): void => {
    try {
      ;(deps.onError ?? ((e: unknown) => reportFailure(e, 'pane fit')))(error)
    } catch {
      // a reporter that throws must not take the fit down with it
    }
  }

  let needsFit = false
  let retry: ReturnType<typeof setTimeout> | undefined
  /** When the current selection deferral began (null: none in progress). */
  let deferStart: number | null = null
  let wait: ResizeHandle | undefined
  /** The pty has been told a size by this pane (until then a hidden pane is still fitted, once). */
  let sized = false
  /** Frames spent waiting for xterm to be able to measure, and the pending frame's canceller. */
  let unmeasured = 0
  let frame: (() => void) | undefined
  const floor = deps.floor !== false
  const nextFrame = deps.nextFrame ?? defaultNextFrame

  const clearRetry = (): void => {
    clearTimeout(retry)
    retry = undefined
    const f = frame
    frame = undefined
    f?.()
  }
  /** Hidden, and the pty already has a size from this pane: the fit waits for the show. */
  const skipHidden = (): boolean => sized && !deps.isVisible()

  /** The resize itself, once the output ahead of it has been parsed. Runs inside xterm's write callback: it must not throw. */
  const finish = (forced: boolean): void => {
    wait = undefined
    // The world may have changed while the resize waited in line.
    if (deps.isDisposed() || deps.isHeld()) return
    if (skipHidden()) {
      needsFit = true
      return
    }
    if (!forced && deps.isSelectionActive()) {
      attempt() // a selection began meanwhile: defer again (a retry; it cannot come straight back here)
      return
    }
    const propose = deps.addon.proposeDimensions
    const proposal = propose ? propose.call(deps.addon) : undefined
    if (propose && proposal === undefined) {
      // xterm cannot measure yet (cell size 0 just after a content-visibility show): the fit stays owed.
      needsFit = true
      if (deps.isVisible() && unmeasured < UNMEASURED_RETRY_FRAMES) {
        unmeasured++
        frame = nextFrame(() => {
          frame = undefined
          attempt()
        })
      }
      return
    }
    unmeasured = 0
    if (floor && proposal && (proposal.cols <= DEGENERATE_COLS || proposal.rows <= DEGENERATE_ROWS)) return // keep the last good size
    needsFit = false
    sized = true
    try {
      deps.addon.fit()
    } catch (error) {
      report(error) // the pty is still told what xterm has: a half-done fit must not leave the two apart
    }
    deps.send(deps.term.cols, deps.term.rows)
  }

  /** The gates, then the barrier. */
  function attempt(): void {
    clearRetry()
    if (deps.isDisposed() || deps.isHeld()) {
      deferStart = null
      return
    }
    if (skipHidden()) {
      deferStart = null
      needsFit = true
      return
    }
    let forced = false
    if (deps.isSelectionActive()) {
      const now = Date.now()
      if (deferStart === null) deferStart = now
      if (now - deferStart < SELECTION_DEFER_CAP_MS) {
        retry = setTimeout(attempt, SELECTION_RETRY_MS)
        return
      }
      forced = true // the allowance is spent: fit with the selection still active
    }
    deferStart = null
    deps.onFit?.()
    const handle = resizeInStreamOrder({
      flushHold: deps.flushHold,
      throttle: deps.throttle,
      term: deps.term,
      xtermPending: deps.xtermPending,
      capMs: deps.capMs,
      apply: () => finish(forced),
      onError: report,
    })
    wait = handle.settled ? undefined : handle
  }

  return {
    request: () => {
      if (wait) return // folded into the resize already waiting: fit() measures the container when it runs
      unmeasured = 0 // a new request (a resize, a show) gets the whole frame allowance again
      attempt()
    },
    cancel: () => {
      clearRetry()
      deferStart = null
      const w = wait
      wait = undefined
      w?.cancel()
    },
    get needsFit() {
      return needsFit
    },
    get waiting() {
      return wait !== undefined
    },
  }
}
