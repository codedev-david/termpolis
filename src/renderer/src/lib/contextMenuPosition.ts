// Viewport-aware placement for the terminal right-click context menu.
//
// The menu used to render with its top-left corner pinned to the click point
// and grow strictly down/right, with no collision handling. Right-clicking on
// the bottom input line (the common case) pushed the lower half of the ~16-item
// menu past the viewport, so Paste and everything below it were clipped and
// unreachable — which also made selection-copy feel broken, because the user
// would click back into the terminal to retry and clear the xterm selection.
//
// This computes a placement that flips the menu UP when it won't fit below the
// cursor and LEFT when it won't fit to the right, then clamps so it never
// leaves the viewport. Kept as a pure function (no DOM) so it unit-tests
// cleanly; the component measures the rendered menu and feeds the numbers in.
export interface MenuPosition {
  left: number
  top: number
}

export function computeMenuPosition(
  clickX: number,
  clickY: number,
  menuW: number,
  menuH: number,
  viewportW: number,
  viewportH: number,
  margin = 4
): MenuPosition {
  // Horizontal: prefer opening to the right of the cursor; flip left if that
  // would overflow the right edge, then clamp into [margin, viewportW - menuW].
  let left = clickX
  if (left + menuW + margin > viewportW) left = clickX - menuW
  if (left + menuW + margin > viewportW) left = viewportW - menuW - margin
  if (left < margin) left = margin

  // Vertical: prefer opening below the cursor; flip up (bottom edge anchored at
  // the cursor) if that would overflow the bottom, then clamp. The final
  // top-margin clamp wins, so a menu taller than the viewport pins to the top
  // and its first items (Copy, …) stay visible rather than its tail.
  let top = clickY
  if (top + menuH + margin > viewportH) top = clickY - menuH
  if (top + menuH + margin > viewportH) top = viewportH - menuH - margin
  if (top < margin) top = margin

  return { left, top }
}
