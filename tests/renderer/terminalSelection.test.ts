import { describe, it, expect } from 'vitest'
import {
  clampPos,
  wordBoundary,
  lineEndCol,
  moveCaret,
  orderPositions,
  toLinearSelection,
  selectionKeyAction,
  isAnchorSelectClick,
  cellFromOffsets,
  type GridCtx,
  type SelKeyEvent,
  type SelMouseEvent,
} from '../../src/renderer/src/lib/terminalSelection'

function key(k: string, mods: Partial<SelKeyEvent> = {}): SelKeyEvent {
  return { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }
}

// A tiny grid fixture: 10 columns, 3 lines of text.
const LINES = ['git commit -m', '  hello world', '']
function ctx(over: Partial<GridCtx> = {}): GridCtx {
  return {
    cols: 10,
    lineCount: LINES.length,
    getLineText: (y: number) => LINES[y] ?? '',
    ...over,
  }
}

describe('terminalSelection (pure logic)', () => {
  describe('clampPos', () => {
    it('clamps x into [0, cols-1] and y into [0, lineCount-1]', () => {
      expect(clampPos({ x: -5, y: -2 }, ctx())).toEqual({ x: 0, y: 0 })
      expect(clampPos({ x: 99, y: 99 }, ctx())).toEqual({ x: 9, y: 2 })
      expect(clampPos({ x: 4, y: 1 }, ctx())).toEqual({ x: 4, y: 1 })
    })
  })

  describe('wordBoundary', () => {
    const t = 'git commit -m'
    it('moves right to the start of the next word', () => {
      expect(wordBoundary(t, 0, 'right')).toBe(4) // 'git ' -> 'commit'
      expect(wordBoundary(t, 4, 'right')).toBe(11) // 'commit ' -> '-m'
    })
    it('right from inside a word skips the rest of the word then spaces', () => {
      expect(wordBoundary(t, 1, 'right')).toBe(4)
    })
    it('right at/after the last word returns end of text', () => {
      expect(wordBoundary(t, 11, 'right')).toBe(t.length)
    })
    it('moves left to the start of the current/previous word', () => {
      expect(wordBoundary(t, 6, 'left')).toBe(4) // inside 'commit' -> its start
      expect(wordBoundary(t, 4, 'left')).toBe(0) // start of 'commit' -> start of 'git'
    })
    it('left from leading spaces lands on the prior word start', () => {
      expect(wordBoundary('  hello world', 8, 'left')).toBe(2) // inside 'hello'... start
    })
    it('handles empty text', () => {
      expect(wordBoundary('', 0, 'right')).toBe(0)
      expect(wordBoundary('', 0, 'left')).toBe(0)
    })
  })

  describe('lineEndCol', () => {
    it('returns the index just past the last non-space char', () => {
      expect(lineEndCol('git commit -m')).toBe(13)
      expect(lineEndCol('  hello world  ')).toBe(13)
      expect(lineEndCol('')).toBe(0)
      expect(lineEndCol('   ')).toBe(0)
    })
  })

  describe('moveCaret', () => {
    it('left/right within a row', () => {
      expect(moveCaret({ x: 3, y: 0 }, 'left', ctx())).toEqual({ x: 2, y: 0 })
      expect(moveCaret({ x: 3, y: 0 }, 'right', ctx())).toEqual({ x: 4, y: 0 })
    })
    it('right at the last column wraps to the next row start', () => {
      expect(moveCaret({ x: 9, y: 0 }, 'right', ctx())).toEqual({ x: 0, y: 1 })
    })
    it('left at column 0 wraps to the previous row end', () => {
      expect(moveCaret({ x: 0, y: 1 }, 'left', ctx())).toEqual({ x: 9, y: 0 })
    })
    it('does not wrap past the very start or very end', () => {
      expect(moveCaret({ x: 0, y: 0 }, 'left', ctx())).toEqual({ x: 0, y: 0 })
      expect(moveCaret({ x: 9, y: 2 }, 'right', ctx())).toEqual({ x: 9, y: 2 })
    })
    it('up/down clamp at the top and bottom rows', () => {
      expect(moveCaret({ x: 4, y: 1 }, 'up', ctx())).toEqual({ x: 4, y: 0 })
      expect(moveCaret({ x: 4, y: 0 }, 'up', ctx())).toEqual({ x: 4, y: 0 })
      expect(moveCaret({ x: 4, y: 1 }, 'down', ctx())).toEqual({ x: 4, y: 2 })
      expect(moveCaret({ x: 4, y: 2 }, 'down', ctx())).toEqual({ x: 4, y: 2 })
    })
    it('home/end move to start and end-of-text of the row', () => {
      expect(moveCaret({ x: 5, y: 0 }, 'home', ctx())).toEqual({ x: 0, y: 0 })
      expect(moveCaret({ x: 0, y: 0 }, 'end', ctx())).toEqual({ x: 9, y: 0 }) // text end (13) clamped to cols-1 (9)
    })
    it('top/bottom jump to the first and last rows', () => {
      expect(moveCaret({ x: 2, y: 1 }, 'top', ctx())).toEqual({ x: 2, y: 0 })
      expect(moveCaret({ x: 2, y: 1 }, 'bottom', ctx())).toEqual({ x: 2, y: 2 })
    })
    it('wordRight/wordLeft use the row text', () => {
      expect(moveCaret({ x: 0, y: 0 }, 'wordRight', ctx())).toEqual({ x: 4, y: 0 })
      expect(moveCaret({ x: 6, y: 0 }, 'wordLeft', ctx())).toEqual({ x: 4, y: 0 })
    })
  })

  describe('orderPositions', () => {
    it('orders by row then column', () => {
      expect(orderPositions({ x: 5, y: 1 }, { x: 2, y: 0 })).toEqual({ start: { x: 2, y: 0 }, end: { x: 5, y: 1 } })
      expect(orderPositions({ x: 2, y: 0 }, { x: 7, y: 0 })).toEqual({ start: { x: 2, y: 0 }, end: { x: 7, y: 0 } })
      expect(orderPositions({ x: 7, y: 0 }, { x: 2, y: 0 })).toEqual({ start: { x: 2, y: 0 }, end: { x: 7, y: 0 } })
    })
  })

  describe('toLinearSelection', () => {
    it('computes an inclusive single-row selection', () => {
      // cols=10, from (2,0) to (5,0) inclusive -> 4 cells
      expect(toLinearSelection({ x: 2, y: 0 }, { x: 5, y: 0 }, 10)).toEqual({ column: 2, row: 0, length: 4 })
    })
    it('computes a multi-row selection spanning the wrap', () => {
      // (8,0) -> (1,1): cells = (1*10+1) - (0*10+8) + 1 = 11-8+1 = 4
      expect(toLinearSelection({ x: 8, y: 0 }, { x: 1, y: 1 }, 10)).toEqual({ column: 8, row: 0, length: 4 })
    })
    it('orders anchor/caret regardless of direction', () => {
      expect(toLinearSelection({ x: 5, y: 0 }, { x: 2, y: 0 }, 10)).toEqual({ column: 2, row: 0, length: 4 })
    })
    it('a single cell has length 1', () => {
      expect(toLinearSelection({ x: 3, y: 1 }, { x: 3, y: 1 }, 10)).toEqual({ column: 3, row: 1, length: 1 })
    })
  })

  describe('selectionKeyAction', () => {
    it('enters copy mode only on Ctrl+Shift+Space when not already in mode', () => {
      expect(selectionKeyAction(key(' ', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'enter' })
      expect(selectionKeyAction(key(' ', { ctrlKey: true }), false)).toBeNull() // plain Ctrl+Space = autocomplete
      expect(selectionKeyAction(key('ArrowRight'), false)).toBeNull() // arrows pass through to shell
    })

    it('exits on Escape or q', () => {
      expect(selectionKeyAction(key('Escape'), true)).toEqual({ kind: 'exit' })
      expect(selectionKeyAction(key('q'), true)).toEqual({ kind: 'exit' })
    })

    it('copies on Enter, y, or Ctrl+C', () => {
      expect(selectionKeyAction(key('Enter'), true)).toEqual({ kind: 'copy' })
      expect(selectionKeyAction(key('y'), true)).toEqual({ kind: 'copy' })
      expect(selectionKeyAction(key('c', { ctrlKey: true }), true)).toEqual({ kind: 'copy' })
    })

    it('selects all on a or Ctrl+A', () => {
      expect(selectionKeyAction(key('a'), true)).toEqual({ kind: 'selectAll' })
      expect(selectionKeyAction(key('a', { ctrlKey: true }), true)).toEqual({ kind: 'selectAll' })
    })

    it('arrows move; Shift extends; Ctrl makes word/edge motions', () => {
      expect(selectionKeyAction(key('ArrowRight'), true)).toEqual({ kind: 'move', motion: 'right' })
      expect(selectionKeyAction(key('ArrowRight', { shiftKey: true }), true)).toEqual({ kind: 'extend', motion: 'right' })
      expect(selectionKeyAction(key('ArrowRight', { ctrlKey: true }), true)).toEqual({ kind: 'move', motion: 'wordRight' })
      expect(selectionKeyAction(key('ArrowLeft', { ctrlKey: true, shiftKey: true }), true)).toEqual({ kind: 'extend', motion: 'wordLeft' })
      expect(selectionKeyAction(key('ArrowUp'), true)).toEqual({ kind: 'move', motion: 'up' })
      expect(selectionKeyAction(key('ArrowDown', { shiftKey: true }), true)).toEqual({ kind: 'extend', motion: 'down' })
    })

    it('Home/End move to line edges; Ctrl jumps to top/bottom', () => {
      expect(selectionKeyAction(key('Home'), true)).toEqual({ kind: 'move', motion: 'home' })
      expect(selectionKeyAction(key('End', { shiftKey: true }), true)).toEqual({ kind: 'extend', motion: 'end' })
      expect(selectionKeyAction(key('Home', { ctrlKey: true }), true)).toEqual({ kind: 'move', motion: 'top' })
      expect(selectionKeyAction(key('End', { ctrlKey: true }), true)).toEqual({ kind: 'move', motion: 'bottom' })
    })

    it('swallows unmapped keys while in mode (returns null, no shell leak)', () => {
      expect(selectionKeyAction(key('z'), true)).toBeNull()
      expect(selectionKeyAction(key('5'), true)).toBeNull()
    })
  })
})

// Click-to-anchor: Alt+Shift+Click a start, scroll, Alt+Shift+Click an end → select + copy between.
describe('click-to-anchor selection', () => {
  const click = (mods: Partial<SelMouseEvent> = {}): SelMouseEvent =>
    ({ button: 0, altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, ...mods })

  describe('isAnchorSelectClick — the chord must not steal existing gestures', () => {
    it('accepts Alt+Shift+left-click', () => {
      expect(isAnchorSelectClick(click())).toBe(true)
    })
    it('rejects a plain left click — ordinary drag-select must still work', () => {
      expect(isAnchorSelectClick(click({ altKey: false, shiftKey: false }))).toBe(false)
    })
    it("rejects Alt without Shift — that is xterm's own alt-click (moves the readline cursor)", () => {
      expect(isAnchorSelectClick(click({ shiftKey: false }))).toBe(false)
    })
    it('rejects Shift without Alt', () => {
      expect(isAnchorSelectClick(click({ altKey: false }))).toBe(false)
    })
    it('rejects Ctrl/Cmd — those are the copy/paste modifiers', () => {
      expect(isAnchorSelectClick(click({ ctrlKey: true }))).toBe(false)
      expect(isAnchorSelectClick(click({ metaKey: true }))).toBe(false)
    })
    it('rejects middle/right buttons (right-click opens the context menu)', () => {
      expect(isAnchorSelectClick(click({ button: 1 }))).toBe(false)
      expect(isAnchorSelectClick(click({ button: 2 }))).toBe(false)
    })
  })

  describe('cellFromOffsets — pixels to an ABSOLUTE buffer cell', () => {
    const ctx: GridCtx = { cols: 80, lineCount: 500, getLineText: () => '' }
    const m = { cellWidth: 10, cellHeight: 20, viewportY: 0 }

    it('maps a pixel offset to the cell containing it', () => {
      expect(cellFromOffsets(0, 0, m, ctx)).toEqual({ x: 0, y: 0 })
      expect(cellFromOffsets(25, 45, m, ctx)).toEqual({ x: 2, y: 2 })
      expect(cellFromOffsets(9, 19, m, ctx)).toEqual({ x: 0, y: 0 }) // still inside cell 0
    })

    // THE point of the feature: the anchor must keep pointing at the same text while you scroll to
    // the other end, so the row is viewportY + rowOnScreen, not the on-screen row.
    it('adds viewportY so the position survives scrolling between the two clicks', () => {
      expect(cellFromOffsets(0, 40, { ...m, viewportY: 300 }, ctx)).toEqual({ x: 0, y: 302 })
    })

    it('clamps past the last column/line instead of running off the grid', () => {
      expect(cellFromOffsets(10_000, 0, m, ctx)).toEqual({ x: 79, y: 0 })
      expect(cellFromOffsets(0, 10_000, m, ctx)).toEqual({ x: 0, y: 499 })
    })

    it('clamps negative offsets (click dragged above/left of the screen)', () => {
      expect(cellFromOffsets(-5, -5, m, ctx)).toEqual({ x: 0, y: 0 })
    })

    // A hidden/unmeasured pane measures 0×0. NaN/Infinity would sail through clampPos's Math.min/max
    // (Math.min(NaN, x) === NaN) and poison the selection with a non-finite row.
    it('never yields NaN/Infinity for a degenerate cell size', () => {
      for (const bad of [0, NaN, -1]) {
        const p = cellFromOffsets(50, 50, { cellWidth: bad, cellHeight: bad, viewportY: 0 }, ctx)
        expect(Number.isFinite(p.x)).toBe(true)
        expect(Number.isFinite(p.y)).toBe(true)
        expect(p).toEqual({ x: 0, y: 0 })
      }
    })

    it('tolerates a non-finite viewportY', () => {
      const p = cellFromOffsets(0, 40, { ...m, viewportY: NaN }, ctx)
      expect(p).toEqual({ x: 0, y: 2 })
    })
  })

  // The two clicks feed the SAME toLinearSelection the keyboard copy-mode uses, so the span is
  // already order-independent: clicking the end before the start selects the identical text.
  it('selects the same span whichever end is clicked first', () => {
    const a = { x: 5, y: 10 }
    const b = { x: 2, y: 12 }
    expect(toLinearSelection(a, b, 80)).toEqual(toLinearSelection(b, a, 80))
    expect(toLinearSelection(a, b, 80)).toEqual({ column: 5, row: 10, length: 158 }) // (12*80+2)-(10*80+5)+1
  })

  it('a single-cell anchor→end selects exactly one cell', () => {
    expect(toLinearSelection({ x: 3, y: 7 }, { x: 3, y: 7 }, 80)).toEqual({ column: 3, row: 7, length: 1 })
  })
})
