import { describe, it, expect, afterEach } from 'vitest'
import {
  clampSplitRatio,
  paneMinPx,
  MIN_PANE_WIDTH_PX,
  MIN_PANE_HEIGHT_PX,
  SPLIT_RATIO_MIN,
  SPLIT_RATIO_MAX,
} from '../../src/renderer/src/lib/splitRatio'
import { MIN_FIT_COLS, MIN_FIT_ROWS } from '../../src/renderer/src/lib/paneFitter'

// A minimum for a split pane, in terminal cells (1.54.5, plan package P3). The divider used to clamp the
// ratio to 10%..90% only: a 10% pane of a 1200 px window is ~12 columns, and a TUI repainted at that
// width writes a long, narrow frame into the scrollback. The pane's fit already declines a grid under
// MIN_FIT_COLS x MIN_FIT_ROWS; the divider now stops a drag from making one in the first place.

describe('clampSplitRatio', () => {
  describe('without a minimum: the 1.54.4 clamp, unchanged', () => {
    it.each([
      [0.5, 0.5], [0.1, 0.1], [0.9, 0.9], [0, 0.1], [-3, 0.1], [0.05, 0.1], [0.95, 0.9], [7, 0.9],
    ])('ratio %f of 1000 px is %f', (ratio, want) => {
      expect(clampSplitRatio(ratio, 1000)).toBe(want)
      expect(clampSplitRatio(ratio, 1000, undefined)).toBe(want)
      expect(clampSplitRatio(ratio, 1000, 0)).toBe(want)
    })

    it('hands NaN through exactly as the old clamp did (a zero-size rect, as in jsdom): nothing new is invented', () => {
      expect(Number.isNaN(clampSplitRatio(Number.NaN, 0, 200))).toBe(true)
      expect(Number.isNaN(clampSplitRatio(Number.NaN, 0))).toBe(true)
    })
  })

  describe('with a minimum', () => {
    it('keeps each side at least minPx wide: 200 px of 1000 is 0.2 .. 0.8', () => {
      expect(clampSplitRatio(0.05, 1000, 200)).toBeCloseTo(0.2, 10)
      expect(clampSplitRatio(0.15, 1000, 200)).toBeCloseTo(0.2, 10)
      expect(clampSplitRatio(0.5, 1000, 200)).toBe(0.5)
      expect(clampSplitRatio(0.85, 1000, 200)).toBeCloseTo(0.8, 10)
      expect(clampSplitRatio(0.99, 1000, 200)).toBeCloseTo(0.8, 10)
    })

    it('a minimum below 10% changes nothing: the 10%..90% clamp is still the outer bound', () => {
      expect(clampSplitRatio(0.01, 4000, 200)).toBe(SPLIT_RATIO_MIN) // 200 px is 5% of 4000
      expect(clampSplitRatio(0.99, 4000, 200)).toBe(SPLIT_RATIO_MAX)
      expect(clampSplitRatio(0.5, 4000, 200)).toBe(0.5)
    })

    it('when two minimums do not fit (the window is too small), there is nothing to protect: the plain clamp applies', () => {
      expect(clampSplitRatio(0.05, 300, 200)).toBe(SPLIT_RATIO_MIN)
      expect(clampSplitRatio(0.5, 300, 200)).toBe(0.5)
      expect(clampSplitRatio(0.95, 300, 200)).toBe(SPLIT_RATIO_MAX)
      expect(clampSplitRatio(0.05, 400, 200)).toBe(SPLIT_RATIO_MIN) // exactly two minimums: lo == hi == 0.5 would pin the divider; leave it free
    })

    it('a size it cannot use (0, negative, NaN) falls back to the plain clamp', () => {
      for (const size of [0, -50, Number.NaN]) expect(clampSplitRatio(0.05, size, 200)).toBe(SPLIT_RATIO_MIN)
    })

    it('NEGATIVE CONTROL: with no minimum the same drag leaves a pane under the floor, with one it cannot', () => {
      const size = 1200
      const dragTo = 0.05
      const paneWithout = clampSplitRatio(dragTo, size) * size
      const paneWith = clampSplitRatio(dragTo, size, MIN_PANE_WIDTH_PX) * size
      expect(paneWithout).toBeLessThan(MIN_PANE_WIDTH_PX) // 120 px: about 12 columns
      expect(paneWith).toBeGreaterThanOrEqual(MIN_PANE_WIDTH_PX - 1e-9)
    })
  })
})

describe('the minimums are in cells, at the default font', () => {
  it('a pane of MIN_PANE_WIDTH_PX holds at least MIN_FIT_COLS columns, and one of MIN_PANE_HEIGHT_PX at least MIN_FIT_ROWS rows', () => {
    // The default terminal font is 14 px: a cell is about 8.5 x 17 px. The pane keeps 4 px of padding
    // on each side and reserves 14 px for xterm's scrollbar; a split pane also has a 28 px header bar.
    const cellW = 8.5
    const cellH = 17
    const padding = 8
    const scrollbar = 14
    const header = 28
    expect(Math.floor((MIN_PANE_WIDTH_PX - padding - scrollbar) / cellW)).toBeGreaterThanOrEqual(MIN_FIT_COLS)
    expect(Math.floor((MIN_PANE_HEIGHT_PX - header - padding) / cellH)).toBeGreaterThanOrEqual(MIN_FIT_ROWS)
  })
})

describe('paneMinPx', () => {
  afterEach(() => window.localStorage.clear())

  it('is the width minimum for a vertical split (side by side) and the height minimum for a horizontal one (stacked)', () => {
    expect(paneMinPx('vertical')).toBe(MIN_PANE_WIDTH_PX)
    expect(paneMinPx('horizontal')).toBe(MIN_PANE_HEIGHT_PX)
  })

  it('NEGATIVE CONTROL: the kill switch (termpolis.resizeOrder = 0) takes it away, and the divider is the 1.54.4 one', () => {
    window.localStorage.setItem('termpolis.resizeOrder', '0')
    expect(paneMinPx('vertical')).toBeUndefined()
    expect(paneMinPx('horizontal')).toBeUndefined()
  })
})
