import { describe, it, expect } from 'vitest'
import {
  clampPos,
  wordBoundary,
  lineEndCol,
  moveCaret,
  orderPositions,
  toLinearSelection,
  selectionKeyAction,
  type GridCtx,
  type SelKeyEvent,
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
