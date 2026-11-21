import { describe, expect, it } from 'vitest'
import { UI_SCALE_MAX, UI_SCALE_ROOM_PX, uiScale } from '../../../src/shared/world/uiScale'

describe('uiScale', () => {
  it('is 1 up to a 1920x1080 window: a tablet, a laptop, a 1080p monitor', () => {
    for (const [w, h] of [[768, 1024], [1024, 768], [1280, 800], [1366, 768], [1920, 1080]]) expect(uiScale(w, h), `${w}x${h}`).toBe(1)
  })

  it('grows by half the window past 1080p, by its smaller growth (an ultrawide by its height)', () => {
    expect(uiScale(2560, 1440)).toBe(1.167)
    expect(uiScale(3440, 1440)).toBe(1.167)
    expect(uiScale(3840, 2160)).toBe(1.5)
    expect(uiScale(5120, 2880)).toBe(1.833)
  })

  it('stops at UI_SCALE_MAX', () => {
    expect(uiScale(20000, 20000)).toBe(UI_SCALE_MAX)
  })

  it('never makes a narrow room hold less than UI_SCALE_ROOM_PX of laptop-sized text, and never goes under 1', () => {
    expect(uiScale(3840, 2160, 3840)).toBe(1.5)
    expect(uiScale(3840, 2160, UI_SCALE_ROOM_PX * 1.2)).toBe(1.2)
    expect(uiScale(3840, 2160, 480)).toBe(1)
    expect(uiScale(1280, 800, 2000)).toBe(1)
  })

  it('reads a size it cannot measure as 1', () => {
    expect(uiScale(Number.NaN, 1080)).toBe(1)
    expect(uiScale(3840, 2160, Number.NaN)).toBe(1.5)
    expect(uiScale(Infinity, Infinity)).toBe(1)
  })
})
