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
} from '../../src/renderer/src/lib/mouseMode'

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
