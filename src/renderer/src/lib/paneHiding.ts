import type { CSSProperties } from 'react'

/**
 * The style of a pane's root (1.54.5, plan package P9).
 *
 * An inactive pane stays MOUNTED, so its terminal keeps parsing output (alt screen, modes, scrollback) and a tab switch is
 * instant. 1.54.4 hid it with `visibility: hidden` alone, which xterm does not treat as hidden: xterm pauses its renderer
 * only when its IntersectionObserver reports the screen as not intersecting, and `visibility: hidden` leaves it
 * intersecting. Measured in headless Chromium 148 (Electron 43's line) with six stacked panes and 90 frames written to each:
 * the hidden pane got 75 render events and painted 1,800 rows, the same as the visible one; `display: none`,
 * `content-visibility: hidden` and translating it off screen got 0.
 *
 * `content-visibility: hidden` skips rendering the pane's contents but KEEPS its box (size containment; the root is
 * `absolute inset-0`, so its size never came from its contents), so nothing about layout changes and no resize is
 * triggered. xterm fully refreshes when the screen intersects again. `visibility: hidden` stays too: it is what keeps a
 * hidden pane out of focus order and what `checkVisibility({ visibilityProperty: true })` (the e2e text hook) reads.
 *
 * `skipRender` is the kill switch ('termpolis.hiddenPanes' = '0', read when the pane mounts): off = 1.54.4's style.
 */
export function paneRootStyle(visible: boolean, skipRender: boolean): CSSProperties {
  if (visible) return { visibility: 'visible' }
  return skipRender ? { visibility: 'hidden', contentVisibility: 'hidden' } : { visibility: 'hidden' }
}
