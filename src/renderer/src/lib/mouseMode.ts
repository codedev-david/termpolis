// Mouse-tracking control for terminals.
//
// When a TUI app (Claude Code, vim, lazygit, htop…) sends a `CSI ? Pm h` DECSET for a
// mouse-tracking mode, xterm starts forwarding click/drag/scroll to the app — which
// means a normal click-drag no longer SELECTS text, so right-click → Copy has nothing
// to copy. For a tool built around reading AI output that's a bad default, so Termpolis
// can swallow those enables (keeping the mouse free for selection) behind a setting.
//
// 1000 = VT200 click, 1001 = highlight, 1002 = button/drag, 1003 = any-motion. The
// encoding modes (1005/1006/1015/1016) only change how an already-tracked event is
// reported and 1004 is focus in/out — none of those capture the mouse on their own, so
// suppressing the four trackers below is both necessary and sufficient.
export const MOUSE_TRACKING_MODES: ReadonlySet<number> = new Set([1000, 1001, 1002, 1003])

/**
 * Decide whether a `CSI ? … h` DECSET sequence should be swallowed to keep the mouse
 * free for text selection. Returns true only when EVERY mode in the sequence is a
 * mouse-tracking mode — a mixed sequence (e.g. a mouse mode alongside cursor
 * visibility) is left for xterm so the unrelated modes still apply.
 *
 * @param params the numeric DEC private mode params from xterm's CSI handler; a param
 *   may itself be a subparam array, in which case its leading value identifies the mode.
 */
export function suppressesMouseTracking(params: (number | number[])[]): boolean {
  if (params.length === 0) return false
  return params.every((p) => MOUSE_TRACKING_MODES.has(typeof p === 'number' ? p : p[0]))
}

// --- Wheel-scroll forwarding -------------------------------------------------
//
// When we swallow a TUI app's mouse-tracking enable (above) to keep the mouse
// free for selection, the app also stops receiving the WHEEL — and because such
// apps (Claude Code, vim, lazygit) run on the alternate screen, which has no
// scrollback, the wheel then does nothing and the user "can't scroll up". The
// fix: keep swallowing click/drag tracking for selection, but synthesize wheel
// reports back to the app so it scrolls its own content. These pure helpers
// build those reports; the wiring in TerminalPane decides when to send them.

/** SGR-family mouse encodings (1006, 1016). 1005 = utf8 and 1015 = urxvt are
 *  other encodings we don't emit — they fall back to legacy X10. */
export const SGR_MOUSE_MODES: ReadonlySet<number> = new Set([1006, 1016])

export type MouseEncoding = 'sgr' | 'x10'
export type WheelDirection = 'up' | 'down'

const leadingMode = (p: number | number[]): number => (typeof p === 'number' ? p : p[0])

/** True if the DECSET sequence enables an SGR mouse encoding (so we should emit
 *  SGR-encoded wheel reports rather than legacy X10). */
export function requestsSgrMouseEncoding(params: (number | number[])[]): boolean {
  return params.some((p) => SGR_MOUSE_MODES.has(leadingMode(p)))
}

/**
 * True if a `CSI ? … h` DECSET enables ANY mouse-tracking mode (1000-1003), even
 * when bundled with other modes (e.g. `1002;1006`). Used to decide BOTH that the
 * app wants the mouse — so the wheel handler forwards scroll to it — AND that the
 * enable should be swallowed so a click-drag keeps selecting text.
 *
 * This is intentionally broader than {@link suppressesMouseTracking}, which only
 * matches a PURE all-tracker sequence: a real app commonly bundles its tracker
 * with its encoding (`CSI ? 1002 ; 1006 h`). Treating that bundle as "wants the
 * mouse" (and swallowing it) keeps selection working AND lets the wheel forward —
 * whereas the strict every-param test would let xterm capture the mouse (breaking
 * selection) and never set the wheel-forward flag.
 */
export function requestsMouseTracking(params: (number | number[])[]): boolean {
  return params.some((p) => MOUSE_TRACKING_MODES.has(leadingMode(p)))
}

/** True if a `CSI ? … l` DECRST disables a mouse-tracking mode — i.e. the app no
 *  longer wants the mouse, so we should stop forwarding the wheel to it. */
export function disablesMouseTracking(params: (number | number[])[]): boolean {
  return params.some((p) => MOUSE_TRACKING_MODES.has(leadingMode(p)))
}

/** Alternate-screen-buffer modes (47 legacy, 1047, 1049). */
export const ALT_SCREEN_MODES: ReadonlySet<number> = new Set([47, 1047, 1049])

/** True if a `CSI ? … l` DECRST leaves the alternate screen — the full-screen app's
 *  session is ending, so any mouse-wheel forwarding state should be cleared. This
 *  guards against a mouse app that exits WITHOUT a tracking-disable (crash, or it
 *  simply never sends `CSI ? 1002 l`): without it the stale "app wanted the mouse"
 *  flag would make the next non-mouse pager (less, man, git) on the alt screen
 *  receive synthesized wheel reports as garbage input instead of scrolling. */
export function exitsAltScreen(params: (number | number[])[]): boolean {
  return params.some((p) => ALT_SCREEN_MODES.has(leadingMode(p)))
}

/**
 * Translate one browser wheel event into a number of line-reports to forward to
 * the app, mirroring how a terminal turns a wheel notch into scroll lines.
 *
 * @param deltaY     WheelEvent.deltaY (sign ignored; magnitude used)
 * @param deltaMode  WheelEvent.deltaMode: 0 = pixel, 1 = line, 2 = page
 * @param cellHeight measured row height in px (for pixel mode); <=0 falls back to 16
 * @param rows       terminal rows — used for page mode and as an upper clamp
 */
export function wheelNotchLines(deltaY: number, deltaMode: number, cellHeight: number, rows: number): number {
  if (deltaY === 0) return 0
  const mag = Math.abs(deltaY)
  let lines: number
  if (deltaMode === 1) lines = Math.round(mag) // DOM_DELTA_LINE
  else if (deltaMode === 2) lines = Math.round(mag) * rows // DOM_DELTA_PAGE
  else lines = Math.round(mag / (cellHeight > 0 ? cellHeight : 16)) // DOM_DELTA_PIXEL
  if (lines < 1) lines = 1
  return Math.min(lines, Math.max(1, rows))
}

/**
 * Build a mouse wheel report to write to the pty so the app scrolls. Wheel up is
 * button 64, wheel down 65 (no release event for wheels). SGR form is
 * `CSI < b ; col ; row M`; legacy X10 is `CSI M Cb Cx Cy` with each byte offset
 * by 32 and clamped to 255. The single report is repeated once per line.
 */
export function buildWheelSequence(opts: {
  direction: WheelDirection
  lines: number
  encoding: MouseEncoding
  col: number
  row: number
}): string {
  const lines = Math.max(0, Math.floor(opts.lines))
  if (lines === 0) return ''
  const button = opts.direction === 'up' ? 64 : 65
  const col = Math.max(1, Math.floor(opts.col))
  const row = Math.max(1, Math.floor(opts.row))
  let one: string
  if (opts.encoding === 'sgr') {
    one = `\x1b[<${button};${col};${row}M`
  } else {
    const cb = String.fromCharCode(Math.min(255, 32 + button))
    const cx = String.fromCharCode(Math.min(255, 32 + col))
    const cy = String.fromCharCode(Math.min(255, 32 + row))
    one = `\x1b[M${cb}${cx}${cy}`
  }
  return one.repeat(lines)
}
