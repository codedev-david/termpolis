import { describe, it, expect } from 'vitest'
import { clampDropdownPosition } from '../../src/renderer/src/lib/dropdownPosition'

// The terminal pane sits to the right of a 240px sidebar; the pane spans x=240..1200.
const pane = { left: 240, top: 60, right: 1200, bottom: 800 }
const box = { width: 360, height: 220 }

describe('clampDropdownPosition', () => {
  it('leaves a normal in-pane anchor unchanged', () => {
    expect(clampDropdownPosition({ x: 260, y: 100 }, pane, box)).toEqual({ x: 260, y: 100 })
  })

  it('never lets the box cross into the left sidebar', () => {
    const { x } = clampDropdownPosition({ x: 100, y: 100 }, pane, box, 8)
    expect(x).toBe(pane.left + 8)
    expect(x).toBeGreaterThanOrEqual(pane.left)
  })

  it('never lets the box spill past the right edge of the pane', () => {
    const { x } = clampDropdownPosition({ x: 1190, y: 100 }, pane, box, 8)
    expect(x + box.width).toBeLessThanOrEqual(pane.right)
    expect(x).toBe(pane.right - box.width - 8)
  })

  it('clamps vertically within the pane as well', () => {
    const { y } = clampDropdownPosition({ x: 260, y: 10_000 }, pane, box, 8)
    expect(y).toBe(pane.bottom - box.height - 8)
  })

  it('on a pane narrower than the box, pins to the left margin (never pushed off the far edge)', () => {
    const narrow = { left: 240, top: 60, right: 300, bottom: 800 }
    const { x } = clampDropdownPosition({ x: 260, y: 100 }, narrow, box, 8)
    expect(x).toBe(narrow.left + 8)
  })
})
