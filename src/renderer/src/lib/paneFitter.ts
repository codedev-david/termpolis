import { resizeInStreamOrder, type ResizeHandle, type StreamOrderDeps } from './resizeInStreamOrder'
import { reportFailure } from './reportFailure'

/**
 * A pane's doFit (1.54.5, plan package P3): WHEN a pane may fit to its container, and what a fit does.
 *
 * It fits only when the pane may:
 *   - not while the mount's replay is being parsed at the pty's size (`isHeld`): the replay's release asks again;
 *   - not while the pane is hidden: every mounted pane used to refit on every window resize, hidden ones
 *     too (5 to 69 ms of reflow each, a conhost repaint and an agent redraw). `needsFit` remembers that
 *     one is owed; the visibility effect asks again when the pane is shown;
 *   - not while a selection is active (fit reflows the buffer and xterm does not remap a selection across
 *     it), for at most SELECTION_DEFER_CAP_MS: it used to wait for ever, and output was held that whole time;
 *   - not to a grid under the floor: FitAddon answers 2 x 1 for a collapsed container and the pty was
 *     told, so a TUI repainted at 2 columns into the scrollback and the retained window. The last good
 *     size is kept instead.
 * and when it does, it does it in stream order (resizeInStreamOrder), with the pty told the size xterm
 * ended up with even if fit() throws.
 *
 * It does NOT skip a resize because the size is unchanged. conhost repaints the whole viewport on every
 * resize, including to the same size (measured: 1,752 chars on build 26200), and that repaint is the
 * only thing that heals a remounted pane's viewport.
 */

/** Below this many columns or rows a proposed grid is not a layout, it is a collapsed container. */
export const MIN_FIT_COLS = 20
export const MIN_FIT_ROWS = 5
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

  const clearRetry = (): void => {
    clearTimeout(retry)
    retry = undefined
  }

  /** The resize itself, once the output ahead of it has been parsed. Runs inside xterm's write callback: it must not throw. */
  const finish = (forced: boolean): void => {
    wait = undefined
    // The world may have changed while the resize waited in line.
    if (deps.isDisposed() || deps.isHeld()) return
    if (!deps.isVisible()) {
      needsFit = true
      return
    }
    if (!forced && deps.isSelectionActive()) {
      attempt() // a selection began meanwhile: defer again (a retry; it cannot come straight back here)
      return
    }
    const proposal = deps.addon.proposeDimensions?.()
    if (proposal && (proposal.cols < MIN_FIT_COLS || proposal.rows < MIN_FIT_ROWS)) return // keep the last good size
    needsFit = false
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
    if (!deps.isVisible()) {
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
