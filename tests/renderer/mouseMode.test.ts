import { describe, it, expect } from 'vitest'
import {
  suppressesMouseTracking,
  MOUSE_TRACKING_MODES,
  requestsSgrMouseEncoding,
  requestsMouseTracking,
  disablesMouseTracking,
  exitsAltScreen,
  wheelNotchLines,
  buildWheelSequence,
  isTapGesture,
  cellFromPoint,
  buildClickSequence,
  CLICK_MAX_MOVE_PX,
  CLICK_MAX_DURATION_MS,
} from '../../src/renderer/src/lib/mouseMode'
import type { ViewportCell } from '../../src/renderer/src/lib/mouseMode'

describe('suppressesMouseTracking', () => {
  it('swallows each mouse-tracking enable mode (1000-1003)', () => {
    for (const mode of [1000, 1001, 1002, 1003]) {
      expect(suppressesMouseTracking([mode])).toBe(true)
    }
  })

  it('swallows a combined all-mouse DECSET sequence', () => {
    expect(suppressesMouseTracking([1002, 1003])).toBe(true)
  })

  it('does NOT swallow unrelated DEC private modes (so they still apply)', () => {
    expect(suppressesMouseTracking([25])).toBe(false)    // cursor visibility
    expect(suppressesMouseTracking([1049])).toBe(false)  // alternate screen buffer
    expect(suppressesMouseTracking([2004])).toBe(false)  // bracketed paste
    expect(suppressesMouseTracking([1004])).toBe(false)  // focus reporting — not tracking
    expect(suppressesMouseTracking([1006])).toBe(false)  // SGR encoding only — harmless without a tracker
  })

  it('leaves a MIXED sequence (mouse + non-mouse) to xterm', () => {
    expect(suppressesMouseTracking([1002, 25])).toBe(false)
  })

  it('does not swallow an empty params list', () => {
    expect(suppressesMouseTracking([])).toBe(false)
  })

  it('reads the leading value of subparam arrays', () => {
    expect(suppressesMouseTracking([[1002, 5]])).toBe(true)
    expect(suppressesMouseTracking([[25, 0]])).toBe(false)
  })

  it('exposes the tracking-mode set', () => {
    expect(MOUSE_TRACKING_MODES.has(1002)).toBe(true)
    expect(MOUSE_TRACKING_MODES.has(1006)).toBe(false)
  })
})

describe('requestsSgrMouseEncoding', () => {
  it('detects SGR encoding modes (1006, 1016)', () => {
    expect(requestsSgrMouseEncoding([1006])).toBe(true)
    expect(requestsSgrMouseEncoding([1016])).toBe(true)
  })

  it('is true when SGR appears alongside a tracker', () => {
    expect(requestsSgrMouseEncoding([1000, 1006])).toBe(true)
  })

  it('is false for non-SGR modes (trackers, utf8, urxvt)', () => {
    expect(requestsSgrMouseEncoding([1002])).toBe(false)
    expect(requestsSgrMouseEncoding([1005])).toBe(false) // utf8 encoding, not SGR
    expect(requestsSgrMouseEncoding([1015])).toBe(false) // urxvt encoding, not SGR
    expect(requestsSgrMouseEncoding([])).toBe(false)
  })

  it('reads the leading value of subparam arrays', () => {
    expect(requestsSgrMouseEncoding([[1006, 0]])).toBe(true)
  })
})

describe('requestsMouseTracking', () => {
  it('is true for each tracking-enable mode (1000-1003)', () => {
    for (const mode of [1000, 1001, 1002, 1003]) {
      expect(requestsMouseTracking([mode])).toBe(true)
    }
  })

  it('is true when a tracker is BUNDLED with its encoding (1002;1006)', () => {
    // The case suppressesMouseTracking (every-param) misses: a real app commonly
    // sends its tracker and SGR encoding in one DECSET. We must still treat this as
    // "wants the mouse" so the enable is swallowed (selection) and the wheel forwards.
    expect(requestsMouseTracking([1002, 1006])).toBe(true)
    expect(suppressesMouseTracking([1002, 1006])).toBe(false) // contrast: strict variant misses it
  })

  it('is false when no tracker is present', () => {
    expect(requestsMouseTracking([1006])).toBe(false) // SGR encoding only
    expect(requestsMouseTracking([25])).toBe(false)   // cursor visibility
    expect(requestsMouseTracking([1049])).toBe(false) // alternate screen
    expect(requestsMouseTracking([])).toBe(false)
  })

  it('reads the leading value of subparam arrays', () => {
    expect(requestsMouseTracking([[1002, 5]])).toBe(true)
    expect(requestsMouseTracking([[25, 0]])).toBe(false)
  })
})

describe('disablesMouseTracking', () => {
  it('is true when any param is a tracking mode (DECRST)', () => {
    expect(disablesMouseTracking([1000])).toBe(true)
    expect(disablesMouseTracking([1002])).toBe(true)
    expect(disablesMouseTracking([1002, 25])).toBe(true) // mixed still counts
  })

  it('is false when no tracking mode present', () => {
    expect(disablesMouseTracking([25])).toBe(false)
    expect(disablesMouseTracking([1006])).toBe(false)
    expect(disablesMouseTracking([])).toBe(false)
  })

  it('reads the leading value of subparam arrays', () => {
    expect(disablesMouseTracking([[1003, 0]])).toBe(true)
  })
})

describe('exitsAltScreen', () => {
  it('is true for alternate-screen exit DECRST modes (47, 1047, 1049)', () => {
    expect(exitsAltScreen([1049])).toBe(true)
    expect(exitsAltScreen([1047])).toBe(true)
    expect(exitsAltScreen([47])).toBe(true)
  })

  it('is false for non-alt modes (trackers, cursor, encoding)', () => {
    expect(exitsAltScreen([1002])).toBe(false)
    expect(exitsAltScreen([25])).toBe(false)
    expect(exitsAltScreen([1006])).toBe(false)
    expect(exitsAltScreen([])).toBe(false)
  })

  it('reads the leading value of subparam arrays', () => {
    expect(exitsAltScreen([[1049, 0]])).toBe(true)
  })
})

describe('wheelNotchLines', () => {
  it('uses the line count directly in DOM_DELTA_LINE mode', () => {
    expect(wheelNotchLines(3, 1, 16, 40)).toBe(3)
    expect(wheelNotchLines(-3, 1, 16, 40)).toBe(3) // magnitude, not sign
  })

  it('converts pixels to lines via cell height in DOM_DELTA_PIXEL mode', () => {
    expect(wheelNotchLines(48, 0, 16, 40)).toBe(3)
    expect(wheelNotchLines(5, 0, 16, 40)).toBe(1) // always at least one line
  })

  it('falls back to a 16px cell when cell height is unknown', () => {
    expect(wheelNotchLines(32, 0, 0, 40)).toBe(2)
  })

  it('scrolls a full screen per notch in DOM_DELTA_PAGE mode', () => {
    expect(wheelNotchLines(1, 2, 16, 40)).toBe(40)
  })

  it('returns 0 for no movement', () => {
    expect(wheelNotchLines(0, 1, 16, 40)).toBe(0)
  })

  it('caps the line count at the viewport height', () => {
    expect(wheelNotchLines(1000, 1, 16, 40)).toBe(40)
  })

  it('never returns more than 1 when rows is degenerate', () => {
    expect(wheelNotchLines(3, 1, 16, 0)).toBe(1)
  })
})

describe('buildWheelSequence', () => {
  it('builds an SGR wheel-up report (button 64)', () => {
    expect(buildWheelSequence({ direction: 'up', lines: 1, encoding: 'sgr', col: 5, row: 10 })).toBe('\x1b[<64;5;10M')
  })

  it('builds an SGR wheel-down report (button 65)', () => {
    expect(buildWheelSequence({ direction: 'down', lines: 1, encoding: 'sgr', col: 5, row: 10 })).toBe('\x1b[<65;5;10M')
  })

  it('repeats the report once per line', () => {
    expect(buildWheelSequence({ direction: 'up', lines: 3, encoding: 'sgr', col: 5, row: 10 })).toBe('\x1b[<64;5;10M'.repeat(3))
  })

  it('builds a legacy X10 wheel-up report (CSI M Cb Cx Cy, +32 offset)', () => {
    // button 64 -> 96 ('`'), col 1 -> 33 ('!'), row 1 -> 33 ('!')
    expect(buildWheelSequence({ direction: 'up', lines: 1, encoding: 'x10', col: 1, row: 1 })).toBe('\x1b[M`!!')
  })

  it('builds a legacy X10 wheel-down report', () => {
    // button 65 -> 97 ('a')
    expect(buildWheelSequence({ direction: 'down', lines: 1, encoding: 'x10', col: 1, row: 1 })).toBe('\x1b[Ma!!')
  })

  it('returns empty string for zero lines', () => {
    expect(buildWheelSequence({ direction: 'up', lines: 0, encoding: 'sgr', col: 1, row: 1 })).toBe('')
  })

  it('clamps col/row to a minimum of 1', () => {
    expect(buildWheelSequence({ direction: 'up', lines: 1, encoding: 'sgr', col: 0, row: 0 })).toBe('\x1b[<64;1;1M')
  })

  it('clamps legacy X10 bytes to 255 to avoid overflow', () => {
    const seq = buildWheelSequence({ direction: 'up', lines: 1, encoding: 'x10', col: 250, row: 1 })
    // '\x1b[M' (3 chars) then Cb, Cx, Cy. Cx = 32 + 250 = 282 -> clamped to 255.
    expect(seq.charCodeAt(4)).toBe(255)
  })
})

// --- Click forwarding --------------------------------------------------------
//
// Termpolis swallows a TUI's mouse-tracking DECSET so click-drag still SELECTS text
// for copying. The cost of that trade is that the TUI's own clickable UI goes dead:
// Claude Code's diff-panel close button never receives the button-press report, so
// the panel "won't close". These three helpers synthesize the click back to the pty,
// but ONLY for a plain, stationary, short left press — anything looser and a
// mid-selection drag would start firing TUI controls the user never aimed at.

describe('isTapGesture', () => {
  it('exports the tuned click budget the pane wiring reads', () => {
    // The numbers themselves are the policy: 4px absorbs hand-shake while staying
    // inside one cell, 700ms separates "pressed a button" from "started selecting".
    // Pinning them here means a retune is a deliberate edit, not a silent drift.
    expect(CLICK_MAX_MOVE_PX).toBe(4)
    expect(CLICK_MAX_DURATION_MS).toBe(700)
  })

  it('accepts a dead-still instant click — the one gesture we exist to forward', () => {
    expect(isTapGesture(0, 0, 0)).toBe(true)
  })

  it('accepts movement of EXACTLY the move limit on either axis, either direction', () => {
    // The bound is inclusive on purpose. A real click on a real mouse rarely lands on
    // the same pixel it started on, so an exclusive `<` here is the difference between
    // a working close button and one that only works for a perfectly steady hand.
    expect(isTapGesture(CLICK_MAX_MOVE_PX, 0, 10)).toBe(true)
    expect(isTapGesture(0, CLICK_MAX_MOVE_PX, 10)).toBe(true)
    expect(isTapGesture(-CLICK_MAX_MOVE_PX, 0, 10)).toBe(true)
    expect(isTapGesture(0, -CLICK_MAX_MOVE_PX, 10)).toBe(true)
    expect(isTapGesture(CLICK_MAX_MOVE_PX, CLICK_MAX_MOVE_PX, 10)).toBe(true)
  })

  it('rejects one pixel past the move limit on either axis, either direction', () => {
    // Past the budget the user was dragging, and a drag is a text selection. Both axes
    // are checked independently so a purely vertical drag is not read as a click.
    expect(isTapGesture(CLICK_MAX_MOVE_PX + 1, 0, 10)).toBe(false)
    expect(isTapGesture(0, CLICK_MAX_MOVE_PX + 1, 10)).toBe(false)
    expect(isTapGesture(-(CLICK_MAX_MOVE_PX + 1), 0, 10)).toBe(false)
    expect(isTapGesture(0, -(CLICK_MAX_MOVE_PX + 1), 10)).toBe(false)
  })

  it('accepts a press held exactly the duration limit and rejects one ms longer', () => {
    // Same inclusive-boundary reasoning as the move limit, on the other axis of the
    // gesture: 700ms is still a click, 701ms is someone holding while they think.
    expect(isTapGesture(0, 0, CLICK_MAX_DURATION_MS)).toBe(true)
    expect(isTapGesture(0, 0, CLICK_MAX_DURATION_MS + 1)).toBe(false)
  })

  it('rejects a long press that never moved', () => {
    // Both bounds must hold, not either: a motionless 5-second hold is a user parked
    // on the mouse, and forwarding it would fire a control they never meant to press.
    expect(isTapGesture(0, 0, 5000)).toBe(false)
  })

  it('rejects a NEGATIVE duration — a clock that ran backwards is not a measurement', () => {
    // performance.now() vs Date.now() mix-ups, or a timer resumed from sleep, can hand
    // us a release that reads as earlier than its press. Refusing beats guessing.
    expect(isTapGesture(0, 0, -1)).toBe(false)
    expect(isTapGesture(0, 0, -1000)).toBe(false)
  })

  it('rejects a non-finite measurement on ANY of the three inputs', () => {
    // Asymmetric costs: a false negative is one dead click the user retries, a false
    // positive fires a TUI control mid-selection. So an unmeasurable rect (NaN) or a
    // missing timestamp answers "not a click" rather than falling through the bounds.
    expect(isTapGesture(NaN, 0, 10)).toBe(false)
    expect(isTapGesture(0, NaN, 10)).toBe(false)
    expect(isTapGesture(0, 0, NaN)).toBe(false)
    expect(isTapGesture(Infinity, 0, 10)).toBe(false)
    expect(isTapGesture(0, -Infinity, 10)).toBe(false)
    expect(isTapGesture(0, 0, Infinity)).toBe(false)
  })
})

describe('cellFromPoint', () => {
  // 800x400 screen rect offset inside the window, 80x20 grid => exactly 10x20px cells.
  const rect = { left: 100, top: 50, width: 800, height: 400 }

  it('maps a point in the middle of the grid to a 1-BASED col/row', () => {
    // x = 100 + 10 whole cells + 5px into the 11th; y = 50 + 3 rows + 5px into the 4th.
    // Mouse reports are 1-based, so that 11th cell is col 11 — an off-by-one here aims
    // the synthesized click one cell left of whatever the user actually pointed at.
    const cell: ViewportCell = cellFromPoint(205, 115, rect, 80, 20)
    expect(cell).toEqual({ col: 11, row: 4 })
  })

  it('maps the exact top-left corner to cell 1,1 rather than 0,0', () => {
    expect(cellFromPoint(100, 50, rect, 80, 20)).toEqual({ col: 1, row: 1 })
  })

  it('maps the last pixel inside the rect to the last cell', () => {
    expect(cellFromPoint(899, 449, rect, 80, 20)).toEqual({ col: 80, row: 20 })
  })

  it('clamps a point outside the rect on each side rather than going 0, negative or past the end', () => {
    // A pointer-capture drag that ends outside the terminal still has to name a real
    // cell: a col of 0 or 81 encodes to a byte the app reads as a different cell (or,
    // in X10, as a control character), so the range is closed at both ends.
    expect(cellFromPoint(0, 115, rect, 80, 20).col).toBe(1) // left of the rect
    expect(cellFromPoint(205, 0, rect, 80, 20).row).toBe(1) // above the rect
    expect(cellFromPoint(5000, 115, rect, 80, 20).col).toBe(80) // right of the rect
    expect(cellFromPoint(205, 5000, rect, 80, 20).row).toBe(20) // below the rect
    // The far edge sits one pixel past the last cell and must not become col 81.
    expect(cellFromPoint(900, 450, rect, 80, 20)).toEqual({ col: 80, row: 20 })
  })

  it('falls back to 1/1 on a degenerate rect instead of dividing by zero', () => {
    // A hidden pane, or a measurement taken before layout, reports a zero-size rect.
    // Each axis degrades on its own, so a zero-WIDTH rect still yields a real row.
    expect(cellFromPoint(205, 115, { left: 100, top: 50, width: 0, height: 400 }, 80, 20)).toEqual({ col: 1, row: 4 })
    expect(cellFromPoint(205, 115, { left: 100, top: 50, width: 800, height: 0 }, 80, 20)).toEqual({ col: 11, row: 1 })
    expect(cellFromPoint(205, 115, { left: 100, top: 50, width: 0, height: 0 }, 80, 20)).toEqual({ col: 1, row: 1 })
    // A negative extent is nonsense from any real rect, but it must not produce a
    // negative cell size and therefore an inverted coordinate.
    expect(cellFromPoint(205, 115, { left: 100, top: 50, width: -800, height: -400 }, 80, 20)).toEqual({ col: 1, row: 1 })
  })

  it('coerces a zero, NaN or fractional cols/rows count to at least one cell', () => {
    // cols/rows come straight off the terminal object; before the first fit they can be
    // 0 or absent. Anything under one whole cell collapses that axis to a single cell
    // rather than dividing by zero or clamping into an empty range.
    for (const badCols of [0, NaN, 0.5, -5]) {
      expect(cellFromPoint(205, 115, rect, badCols, 20)).toEqual({ col: 1, row: 4 })
    }
    for (const badRows of [0, NaN, 0.5, -3]) {
      expect(cellFromPoint(205, 115, rect, 80, badRows)).toEqual({ col: 11, row: 1 })
    }
    // A fractional count at or above 1 keeps its whole part — 80.9 cols is 80 cells.
    expect(cellFromPoint(205, 115, rect, 80.9, 20.9)).toEqual({ col: 11, row: 4 })
  })

  it('falls back to 1 on whichever axis has an unmeasurable coordinate', () => {
    // Not reachable from a real MouseEvent, but this is the guard that stops an
    // arithmetic NaN escaping as a cell number pasted into an escape sequence.
    expect(cellFromPoint(NaN, 115, rect, 80, 20)).toEqual({ col: 1, row: 4 })
    expect(cellFromPoint(205, NaN, rect, 80, 20)).toEqual({ col: 11, row: 1 })
    expect(cellFromPoint(Infinity, -Infinity, rect, 80, 20)).toEqual({ col: 1, row: 1 })
  })
})

describe('buildClickSequence', () => {
  it('emits an SGR press immediately followed by its release', () => {
    // Left button is 0; SGR distinguishes press from release by the final byte (M vs
    // m), which is the whole reason SGR exists. Both go out together because a TUI
    // that acts on release would otherwise see the button held down forever.
    expect(buildClickSequence({ encoding: 'sgr', col: 12, row: 7 })).toBe('\x1b[<0;12;7M\x1b[<0;12;7m')
  })

  it('reports the SAME cell for press and release so the app sees a click, not a drag', () => {
    const seq = buildClickSequence({ encoding: 'sgr', col: 40, row: 3 })
    const [press, release] = seq.split('\x1b[<').filter(Boolean)
    expect(press).toBe('0;40;3M')
    expect(release).toBe('0;40;3m')
  })

  it('emits a legacy X10 press (button 0) and a button-3 release', () => {
    // X10 packs button and coordinates into single bytes offset by 32, and has no
    // per-button release — button 3 IS "some button came up". Getting that wrong
    // leaves the app believing the left button is still held down.
    const expected =
      '\x1b[M' +
      String.fromCharCode(32) +
      String.fromCharCode(32 + 5) +
      String.fromCharCode(32 + 9) +
      '\x1b[M' +
      String.fromCharCode(35) +
      String.fromCharCode(32 + 5) +
      String.fromCharCode(32 + 9)
    const seq = buildClickSequence({ encoding: 'x10', col: 5, row: 9 })
    expect(seq).toBe(expected)
    expect(seq.charCodeAt(3)).toBe(32) // press: button 0, +32
    expect(seq.charCodeAt(4)).toBe(37) // col 5, +32
    expect(seq.charCodeAt(5)).toBe(41) // row 9, +32
    expect(seq.charCodeAt(9)).toBe(35) // release: button 3, +32
  })

  it('clamps a col/row below 1 up to 1 in both encodings', () => {
    // Col 0 encodes to byte 32 in X10, a coordinate no real terminal emits, and a
    // negative col in SGR is simply malformed — either way the app misreads the click.
    expect(buildClickSequence({ encoding: 'sgr', col: 0, row: 0 })).toBe('\x1b[<0;1;1M\x1b[<0;1;1m')
    expect(buildClickSequence({ encoding: 'sgr', col: -3, row: -9 })).toBe('\x1b[<0;1;1M\x1b[<0;1;1m')
    expect(buildClickSequence({ encoding: 'sgr', col: NaN, row: NaN })).toBe('\x1b[<0;1;1M\x1b[<0;1;1m')
    const x10 = buildClickSequence({ encoding: 'x10', col: 0, row: -2 })
    expect(x10.charCodeAt(4)).toBe(33) // col clamped to 1 -> 33
    expect(x10.charCodeAt(5)).toBe(33) // row clamped to 1 -> 33
  })

  it('floors a fractional coordinate', () => {
    // The caller divides pixels by cell size, so fractions arrive routinely; a cell
    // number has to be whole before it is pasted into an escape sequence.
    expect(buildClickSequence({ encoding: 'sgr', col: 12.9, row: 7.4 })).toBe('\x1b[<0;12;7M\x1b[<0;12;7m')
    // Flooring to 0 then falls through the same min-1 clamp as an explicit 0.
    expect(buildClickSequence({ encoding: 'sgr', col: 0.9, row: 0.1 })).toBe('\x1b[<0;1;1M\x1b[<0;1;1m')
  })

  it('clamps an X10 coordinate past the 255-byte ceiling instead of overflowing', () => {
    // X10 has one byte per coordinate, so a wide window simply cannot be addressed past
    // col 223. Clamping pins the report to the edge; wrapping would hand the app a
    // click at a wildly wrong cell, which is worse than an inaccurate one.
    const seq = buildClickSequence({ encoding: 'x10', col: 250, row: 300 })
    expect(seq.charCodeAt(4)).toBe(255) // 32 + 250 = 282 -> 255
    expect(seq.charCodeAt(5)).toBe(255) // 32 + 300 = 332 -> 255
    expect(seq.charCodeAt(10)).toBe(255) // release carries the same clamped cell
    expect(seq.charCodeAt(11)).toBe(255)
    expect([...seq].every((ch) => ch.charCodeAt(0) <= 255)).toBe(true)
  })
})
