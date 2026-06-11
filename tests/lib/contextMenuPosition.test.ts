import { describe, it, expect } from 'vitest'
import { computeMenuPosition } from '../../src/renderer/src/lib/contextMenuPosition'

// Viewport used across the simple cases: 1000 wide x 800 tall.
const VW = 1000
const VH = 800

describe('computeMenuPosition', () => {
  it('keeps the menu at the click point when it fits below and to the right', () => {
    // Click in the upper-left; a 200x300 menu fits comfortably down-right.
    const pos = computeMenuPosition(100, 100, 200, 300, VW, VH)
    expect(pos).toEqual({ left: 100, top: 100 })
  })

  it('flips the menu UP when there is not enough room below (the terminal-line case)', () => {
    // Right-click on the bottom input line: clickY near the viewport bottom,
    // tall menu. It must open upward so its bottom sits at the click point.
    const menuH = 400
    const clickY = 760 // 760 + 400 = 1160 > 800 → overflow below
    const pos = computeMenuPosition(100, clickY, 200, menuH, VW, VH)
    expect(pos.top).toBe(clickY - menuH) // 360 — bottom edge anchored at the cursor
    expect(pos.top).toBeLessThan(clickY) // grows up, not down
  })

  it('flips the menu LEFT when it would overflow the right edge', () => {
    const menuW = 200
    const clickX = 950 // 950 + 200 = 1150 > 1000 → overflow right
    const pos = computeMenuPosition(clickX, 100, menuW, 300, VW, VH)
    expect(pos.left).toBe(clickX - menuW) // 750 — right edge anchored at the cursor
  })

  it('flips both axes when clicking the bottom-right corner', () => {
    const pos = computeMenuPosition(950, 760, 200, 400, VW, VH)
    expect(pos.left).toBe(750)
    expect(pos.top).toBe(360)
  })

  it('clamps to the top margin when the menu is taller than the viewport (top items stay visible)', () => {
    // A menu taller than the whole viewport must pin to the top so the first
    // items (Copy, etc.) remain on-screen rather than the bottom being shown.
    const pos = computeMenuPosition(100, 700, 200, 900, VW, VH)
    expect(pos.top).toBe(4) // default margin, pinned to top
  })

  it('never positions the menu off the left or top edge', () => {
    const pos = computeMenuPosition(2, 2, 200, 300, VW, VH)
    expect(pos.left).toBeGreaterThanOrEqual(4)
    expect(pos.top).toBeGreaterThanOrEqual(4)
  })

  it('respects a custom margin', () => {
    const pos = computeMenuPosition(100, 700, 200, 900, VW, VH, 10)
    expect(pos.top).toBe(10)
  })
})
