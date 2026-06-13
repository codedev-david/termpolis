// Geometry for the autocomplete/completion dropdown. Kept pure (no DOM) so the
// "stay inside the terminal pane" rule is unit-tested. The dropdown renders
// position:fixed in viewport coordinates, so without clamping it can spill over
// the sidebar on the left or a docked panel / the window edge on the right —
// which is exactly the "the box extends too far over the sidebar" report.

export interface PaneRect { left: number; top: number; right: number; bottom: number }
export interface BoxSize { width: number; height: number }

/**
 * Clamp a desired dropdown origin (viewport coords) so the whole box stays inside
 * the pane on every side, leaving `margin` px of breathing room. Conservative box
 * dimensions are passed in so even a max-width / many-row list cannot overflow.
 * When the pane is narrower/shorter than the box, the top-left margin wins (the
 * box is pinned just inside the pane rather than pushed off the opposite edge).
 * Pure.
 */
export function clampDropdownPosition(
  desired: { x: number; y: number },
  pane: PaneRect,
  box: BoxSize,
  margin = 8,
): { x: number; y: number } {
  const minX = pane.left + margin
  const maxX = Math.max(minX, pane.right - box.width - margin)
  const minY = pane.top + margin
  const maxY = Math.max(minY, pane.bottom - box.height - margin)
  return {
    x: Math.min(Math.max(desired.x, minX), maxX),
    y: Math.min(Math.max(desired.y, minY), maxY),
  }
}
