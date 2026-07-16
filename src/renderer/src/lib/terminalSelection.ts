// Pure geometry/text helpers for keyboard-only text selection ("copy mode") in
// the terminal. Kept free of xterm/DOM so the motion + selection math is unit
// testable in isolation; TerminalPane wires these to term.select(...) and the
// xterm buffer. A grid position is { x: column (0-based), y: absolute buffer
// line (0-based) }.

export interface GridPos {
  x: number
  y: number
}

export type SelMotion =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'wordLeft'
  | 'wordRight'
  | 'home'
  | 'end'
  | 'top'
  | 'bottom'

export interface GridCtx {
  /** Number of columns in the terminal. */
  cols: number
  /** Total number of lines in the buffer (buffer.active.length). */
  lineCount: number
  /** Plain text of an absolute buffer line (buffer.active.getLine(y).translateToString()). */
  getLineText: (y: number) => string
}

/** Clamp a position into the valid grid bounds. */
export function clampPos(pos: GridPos, ctx: GridCtx): GridPos {
  const maxX = Math.max(0, ctx.cols - 1)
  const maxY = Math.max(0, ctx.lineCount - 1)
  return {
    x: Math.min(Math.max(0, pos.x), maxX),
    y: Math.min(Math.max(0, pos.y), maxY),
  }
}

const isSpace = (ch: string): boolean => ch === undefined || /\s/.test(ch)
const isWord = (ch: string): boolean => ch !== undefined && /\S/.test(ch)

/**
 * Index of the next word boundary in `text` from `col`. 'right' skips the rest
 * of the current word then the following whitespace (landing on the next word's
 * start, or text end); 'left' skips immediate whitespace then the word to its
 * start. Returns an index in [0, text.length].
 */
export function wordBoundary(text: string, col: number, dir: 'left' | 'right'): number {
  const n = text.length
  let i = Math.min(Math.max(0, col), n)
  if (dir === 'right') {
    while (i < n && isWord(text[i])) i++
    while (i < n && isSpace(text[i])) i++
    return i
  }
  while (i > 0 && isSpace(text[i - 1])) i--
  while (i > 0 && isWord(text[i - 1])) i--
  return i
}

/** Column just past the last non-space char (where the typed text ends). */
export function lineEndCol(text: string): number {
  let i = text.length
  while (i > 0 && isSpace(text[i - 1])) i--
  return i
}

/** Move the caret by one motion, clamped to the grid. */
export function moveCaret(pos: GridPos, motion: SelMotion, ctx: GridCtx): GridPos {
  const { cols, lineCount } = ctx
  let next: GridPos
  switch (motion) {
    case 'left':
      if (pos.x > 0) next = { x: pos.x - 1, y: pos.y }
      else if (pos.y > 0) next = { x: cols - 1, y: pos.y - 1 }
      else next = { x: 0, y: 0 }
      break
    case 'right':
      if (pos.x < cols - 1) next = { x: pos.x + 1, y: pos.y }
      else if (pos.y < lineCount - 1) next = { x: 0, y: pos.y + 1 }
      else next = { x: cols - 1, y: pos.y }
      break
    case 'up':
      next = { x: pos.x, y: pos.y - 1 }
      break
    case 'down':
      next = { x: pos.x, y: pos.y + 1 }
      break
    case 'home':
      next = { x: 0, y: pos.y }
      break
    case 'end':
      next = { x: lineEndCol(ctx.getLineText(pos.y)), y: pos.y }
      break
    case 'top':
      next = { x: pos.x, y: 0 }
      break
    case 'bottom':
      next = { x: pos.x, y: lineCount - 1 }
      break
    case 'wordLeft':
      next = { x: wordBoundary(ctx.getLineText(pos.y), pos.x, 'left'), y: pos.y }
      break
    case 'wordRight':
      next = { x: wordBoundary(ctx.getLineText(pos.y), pos.x, 'right'), y: pos.y }
      break
    default:
      next = pos
  }
  return clampPos(next, ctx)
}

/** Order two positions so start <= end (by row, then column). */
export function orderPositions(a: GridPos, b: GridPos): { start: GridPos; end: GridPos } {
  if (a.y < b.y || (a.y === b.y && a.x <= b.x)) return { start: a, end: b }
  return { start: b, end: a }
}

/** A minimal key event shape (so this stays testable without a real DOM event). */
export interface SelKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export type SelectionAction =
  | { kind: 'enter' }
  | { kind: 'move'; motion: SelMotion }
  | { kind: 'extend'; motion: SelMotion }
  | { kind: 'selectAll' }
  | { kind: 'copy' }
  | { kind: 'exit' }
  | null

/**
 * Map a key event to a copy-mode action. The default enter trigger is
 * Ctrl/Cmd+Shift+Space. While `inMode`, arrows (Shift = extend, Ctrl = word /
 * top / bottom) move the caret; a/Ctrl+A select all; Enter/y/Ctrl+C copy;
 * Esc/q exit. Returns null for keys that should be swallowed without effect
 * (so they never leak to the shell while copy-mode is active).
 */
export function selectionKeyAction(e: SelKeyEvent, inMode: boolean): SelectionAction {
  const ctrl = e.ctrlKey || e.metaKey
  if (!inMode) {
    if (ctrl && e.shiftKey && e.key === ' ') return { kind: 'enter' }
    return null
  }
  if (e.key === 'Escape' || (e.key === 'q' && !ctrl && !e.altKey)) return { kind: 'exit' }
  if (e.key === 'Enter' || (e.key.toLowerCase() === 'y' && !ctrl && !e.altKey) || (ctrl && e.key.toLowerCase() === 'c')) {
    return { kind: 'copy' }
  }
  if ((ctrl && e.key.toLowerCase() === 'a') || (e.key.toLowerCase() === 'a' && !e.altKey)) return { kind: 'selectAll' }
  const kind = e.shiftKey ? 'extend' : 'move'
  switch (e.key) {
    case 'ArrowLeft':
      return { kind, motion: ctrl ? 'wordLeft' : 'left' }
    case 'ArrowRight':
      return { kind, motion: ctrl ? 'wordRight' : 'right' }
    case 'ArrowUp':
      return { kind, motion: 'up' }
    case 'ArrowDown':
      return { kind, motion: 'down' }
    case 'Home':
      return { kind, motion: ctrl ? 'top' : 'home' }
    case 'End':
      return { kind, motion: ctrl ? 'bottom' : 'end' }
    default:
      return null
  }
}

/**
 * Convert an (anchor, caret) selection into xterm's linear select() args:
 * a starting cell and an inclusive cell count that wraps across rows.
 */
export function toLinearSelection(
  anchor: GridPos,
  caret: GridPos,
  cols: number,
): { column: number; row: number; length: number } {
  const { start, end } = orderPositions(anchor, caret)
  const startIdx = start.y * cols + start.x
  const endIdx = end.y * cols + end.x
  return { column: start.x, row: start.y, length: endIdx - startIdx + 1 }
}

// --- Click-to-anchor selection ------------------------------------------------------------------
// Alt+Shift+Click a start, scroll anywhere, Alt+Shift+Click an end → everything between is selected
// and copied. This exists because DRAG-select cannot comfortably span scrollback: you must hold the
// button and fight auto-scroll across hundreds of lines. Anchoring decouples the two ends, so the
// positions below are ABSOLUTE buffer lines (never viewport rows) — that is what lets the anchor keep
// pointing at the same text while the user scrolls between the two clicks.

/** A minimal mouse event shape, so the chord test stays a pure unit (no DOM event needed). */
export interface SelMouseEvent {
  button: number
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

/**
 * The chord: Alt+Shift+left-click. Alt ALONE is xterm's own alt-click (moves the readline cursor)
 * and Ctrl/Cmd are the copy/paste modifiers, so Alt+Shift is the free combination — and unlike the
 * Ctrl-vs-Cmd split it is the same physical keys everywhere (Option+Shift on mac). Deliberately
 * strict: a plain left click must still start an ordinary drag-select.
 */
export function isAnchorSelectClick(e: SelMouseEvent): boolean {
  return e.button === 0 && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey
}

/** Rendered cell geometry + where the viewport currently sits in the scrollback. */
export interface CellMetrics {
  cellWidth: number
  cellHeight: number
  /** buffer.active.viewportY — the absolute buffer line drawn at the top of the viewport. */
  viewportY: number
}

/**
 * Map a pixel offset inside the terminal screen to an ABSOLUTE buffer position, clamped to the grid.
 *
 * A degenerate cell size (0 / NaN — a hidden or not-yet-measured pane) resolves to 0 rather than
 * Infinity/NaN: those would sail straight through clampPos's Math.min/Math.max (Math.min(NaN, x) is
 * NaN) and poison the selection with a non-finite row. Hence Number.isFinite, never a truthiness test.
 */
export function cellFromOffsets(px: number, py: number, m: CellMetrics, ctx: GridCtx): GridPos {
  const cells = (v: number, size: number): number =>
    Number.isFinite(v) && Number.isFinite(size) && size > 0 ? Math.floor(v / size) : 0
  const top = Number.isFinite(m.viewportY) ? m.viewportY : 0
  return clampPos({ x: cells(px, m.cellWidth), y: top + cells(py, m.cellHeight) }, ctx)
}
