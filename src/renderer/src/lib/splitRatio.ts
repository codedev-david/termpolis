import { switchEnabled, SWITCH_RESIZE_ORDER } from './paneSwitches'

/**
 * The size of a split pane, in terminal cells (1.54.5, plan package P3).
 *
 * The divider only ever clamped its ratio to 10%..90%: a 10% pane of a 1200 px window is about 12
 * columns, and a TUI repainted at that width writes a long, narrow frame into the scrollback and the
 * retained window. The pane's own fit already declines a grid under MIN_FIT_COLS x MIN_FIT_ROWS (see
 * paneFitter.ts); this stops a drag from making one.
 *
 * In pixels, at the default 14 px font (a cell is about 8.5 x 17 px): 20 columns plus the pane's 4 px
 * padding on each side and xterm's 14 px scrollbar reserve is about 192, and a split pane's 28 px header
 * bar plus 5 rows plus padding is about 121; both get a little room on top. The font can be larger than
 * that; then a pane can still end up under the floor, and its fit is declined (the pty keeps its last
 * good size, the pane is clipped).
 */
export const MIN_PANE_WIDTH_PX = 210
export const MIN_PANE_HEIGHT_PX = 135

/** The 1.54.4 clamp: neither side smaller than a tenth. */
export const SPLIT_RATIO_MIN = 0.1
export const SPLIT_RATIO_MAX = 0.9

/**
 * Clamp a dragged split ratio. With `minPx` (and a usable `sizePx`, the parent's size along the drag)
 * each side keeps at least that many pixels, inside the 10%..90% bounds. When two minimums do not fit
 * in the parent, or the size is unknown, there is nothing to protect and the plain 10%..90% clamp
 * applies, as it always did.
 */
export function clampSplitRatio(ratio: number, sizePx: number, minPx?: number): number {
  const plain = Math.max(SPLIT_RATIO_MIN, Math.min(SPLIT_RATIO_MAX, ratio))
  if (!(typeof minPx === 'number' && minPx > 0) || !(sizePx > 0)) return plain
  const lo = Math.max(SPLIT_RATIO_MIN, minPx / sizePx)
  const hi = Math.min(SPLIT_RATIO_MAX, 1 - minPx / sizePx)
  if (!(lo < hi)) return plain // no room for two panes of the minimum
  return Math.max(lo, Math.min(hi, ratio))
}

/** The minimum for a split in this direction, or undefined with the kill switch off (the 1.54.4 divider). */
export function paneMinPx(direction: 'horizontal' | 'vertical'): number | undefined {
  if (!switchEnabled(SWITCH_RESIZE_ORDER)) return undefined
  return direction === 'horizontal' ? MIN_PANE_HEIGHT_PX : MIN_PANE_WIDTH_PX
}
