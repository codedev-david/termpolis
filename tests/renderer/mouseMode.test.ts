import { describe, it, expect } from 'vitest'
import { suppressesMouseTracking, MOUSE_TRACKING_MODES } from '../../src/renderer/src/lib/mouseMode'

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
