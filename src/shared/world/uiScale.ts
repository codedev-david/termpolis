/**
 * How much bigger Lumopolis draws its text and controls on a big screen, so a 4K or 5K monitor at
 * DPR 1 reads at about the size a 1080p laptop does: 1 up to a 1920x1080 window, then half the
 * window's growth past it (the smaller of its growth across and down, so an ultrawide grows by its
 * height), at most UI_SCALE_MAX. A window at 3840x2160 gets 1.5, one at 5120x2880 1.8. A screen with
 * a high DPR already draws CSS pixels bigger: its CSS size is what is passed in.
 *
 * `room`, when given, is the width the text has (a Lumopolis pane split narrow beside the terminals).
 * The scale keeps UI_SCALE_ROOM_PX of laptop-sized text in that room where it can, but a narrow split
 * on a big screen never drops all the way to 1: it keeps at least UI_SCALE_FLOOR_SHARE of the window's
 * own scale, as long as the room still holds UI_SCALE_ROOM_MIN_PX of laptop-sized text (the narrowest
 * pane the app allows at scale 1, which every panel is laid out to fit). A 480px split on a 5K screen
 * gets 1.3 (369 laptop pixels), not 1.
 *
 * The scale moves in steps of UI_SCALE_STEP (rounded down, so a step never breaks the room rules):
 * dragging the divider re-lays the panels and resizes the map's labels only when a step is crossed,
 * not on every pixel of the drag.
 *
 * One scale, three ways it is applied, each where the thing drawn can take it:
 *   - the pane's panels (toolbar, legend, card, ask bar, dialogs, home): CSS `zoom` on each panel
 *     (useUiZoom / UiScaleContext in worldPane.tsx), never on the map's canvas, whose WebGL buffer must
 *     stay at device pixels; screenRect.ts turns a zoomed panel's box into screen pixels on every Chromium;
 *   - the map's labels: the CSS2D label layer's `--lw-s` (threeRenderer setLabelScale), since a zoom on
 *     the layer would also move each label off its projected point;
 *   - the exported pages: the world page (keyword or smart ask) sets its root font size to BASE_PX (13)
 *     times this scale in script, as the window changes size (src/world-export/controls.ts); the
 *     documentation page runs no script, so it has the same rule as a CSS clamp on its root font size,
 *     matched to this function within a step (tests/shared/world/uiScale.test.ts ties the two).
 */
export const UI_SCALE_MAX = 2
/** The width (CSS px at scale 1) a pane keeps for its text whatever the scale: a laptop's default pane. */
export const UI_SCALE_ROOM_PX = 760
/** The least width (CSS px at scale 1) the floor leaves a narrow split: the pane's own minimum (WORLD_PANE_MIN_PX). */
export const UI_SCALE_ROOM_MIN_PX = 360
/** The share of the window's scale a narrow split keeps, while the room allows it. */
export const UI_SCALE_FLOOR_SHARE = 0.75
/** The step the scale moves in. */
export const UI_SCALE_STEP = 0.05

export function uiScale(width: number, height: number, room?: number): number {
  const m = Math.min(width / 1920, height / 1080)
  const full = Number.isFinite(m) ? Math.min(UI_SCALE_MAX, Math.max(1, 1 + (m - 1) * 0.5)) : 1
  let s = full
  if (room !== undefined && Number.isFinite(room)) {
    const cap = room / UI_SCALE_ROOM_PX
    const floor = Math.min(full * UI_SCALE_FLOOR_SHARE, room / UI_SCALE_ROOM_MIN_PX)
    s = Math.max(1, Math.min(full, Math.max(cap, floor)))
  }
  // Rounded down to a step; the 1e-9 keeps an exact step (1.5) from falling to the one below by float error.
  return Math.round(Math.floor(s / UI_SCALE_STEP + 1e-9) * UI_SCALE_STEP * 1000) / 1000
}
