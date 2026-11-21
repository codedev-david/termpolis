/**
 * How much bigger Lumopolis draws its text and controls on a big screen, so a 4K or 5K monitor at
 * DPR 1 reads at about the size a 1080p laptop does: 1 up to a 1920x1080 window, then half the
 * window's growth past it (the smaller of its growth across and down, so an ultrawide grows by its
 * height), at most UI_SCALE_MAX. A window at 3840x2160 gets 1.5, one at 5120x2880 about 1.83. A
 * screen with a high DPR already draws CSS pixels bigger: its CSS size is what is passed in.
 *
 * `room`, when given, is the width the text has (a Lumopolis pane split narrow beside the terminals):
 * the scale never makes that room narrower than UI_SCALE_ROOM_PX of laptop-sized text.
 */
export const UI_SCALE_MAX = 2
/** The width (CSS px at scale 1) a pane keeps for its text whatever the scale: a laptop's default pane. */
export const UI_SCALE_ROOM_PX = 760

export function uiScale(width: number, height: number, room?: number): number {
  const m = Math.min(width / 1920, height / 1080)
  let s = Number.isFinite(m) ? Math.min(UI_SCALE_MAX, Math.max(1, 1 + (m - 1) * 0.5)) : 1
  if (room !== undefined && Number.isFinite(room)) s = Math.max(1, Math.min(s, room / UI_SCALE_ROOM_PX))
  return Math.round(s * 1000) / 1000
}
