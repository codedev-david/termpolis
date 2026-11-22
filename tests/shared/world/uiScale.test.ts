import { describe, expect, it } from 'vitest'
import {
  UI_SCALE_FLOOR_SHARE, UI_SCALE_MAX, UI_SCALE_ROOM_MIN_PX, UI_SCALE_ROOM_PX, UI_SCALE_STEP, uiScale
} from '../../../src/shared/world/uiScale'
import { WORLD_PANE_MIN_PX } from '../../../src/renderer/src/components/World/worldPane'
import { buildDocumentation } from '../../../src/shared/world/documentation'
import { renderDocumentation } from '../../../src/shared/world/documentationHtml'
import { labelledWorld } from '../../fixtures/world/docWorlds'

describe('uiScale', () => {
  it('is 1 up to a 1920x1080 window: a tablet, a laptop, a 1080p monitor', () => {
    for (const [w, h] of [[768, 1024], [1024, 768], [1280, 800], [1366, 768], [1920, 1080]]) expect(uiScale(w, h), `${w}x${h}`).toBe(1)
  })

  it('grows by half the window past 1080p, by its smaller growth (an ultrawide by its height), rounded down to a step', () => {
    expect(uiScale(2560, 1440)).toBe(1.15)
    expect(uiScale(3440, 1440)).toBe(1.15)
    expect(uiScale(3840, 2160)).toBe(1.5)
    expect(uiScale(5120, 2880)).toBe(1.8)
  })

  it('stops at UI_SCALE_MAX', () => {
    expect(uiScale(20000, 20000)).toBe(UI_SCALE_MAX)
  })

  it('moves only in UI_SCALE_STEP steps, so a divider drag re-lays the panels only when it crosses one', () => {
    expect(UI_SCALE_STEP).toBe(0.05)
    const seen = new Set<number>()
    for (let room = 360; room <= 2400; room++) {
      const s = uiScale(5120, 2880, room)
      expect(Math.abs(s / UI_SCALE_STEP - Math.round(s / UI_SCALE_STEP)), `room ${room}: ${s}`).toBeLessThan(1e-9)
      seen.add(s)
    }
    // 2040 pixels of drag take one of the 17 steps from 1 to 1.8, not 2040 values.
    expect(seen.size).toBeLessThanOrEqual(17)
    for (let w = 1920; w <= 5120; w += 7) {
      const s = uiScale(w, w * 0.5625)
      expect(Math.round(s * 1000) % 50, `${w}: ${s}`).toBe(0)
    }
  })

  it('keeps UI_SCALE_ROOM_PX of laptop-sized text in a room where it can, and never goes under 1', () => {
    expect(uiScale(3840, 2160, 3840)).toBe(1.5)
    expect(uiScale(3840, 2160, UI_SCALE_ROOM_PX * 1.2)).toBe(1.2)
    expect(uiScale(1280, 800, 2000)).toBe(1)
    expect(uiScale(1920, 1080, 360)).toBe(1)
  })

  it('gives a narrow split on a big screen a floor: a share of the window scale, while the room keeps the pane minimum', () => {
    expect(UI_SCALE_FLOOR_SHARE).toBe(0.75)
    // The floor never leaves less room than the narrowest pane the app allows at scale 1.
    expect(UI_SCALE_ROOM_MIN_PX).toBe(WORLD_PANE_MIN_PX)
    expect(uiScale(5120, 2880, 480)).toBe(1.3)
    expect(uiScale(5120, 2880, 640)).toBe(1.35)
    expect(uiScale(3840, 2160, 480)).toBe(1.1)
    expect(uiScale(3840, 2160, 640)).toBe(1.1)
    for (const [w, h] of [[2560, 1440], [3440, 1440], [3840, 2160], [5120, 2880], [7680, 4320]]) {
      for (let room = WORLD_PANE_MIN_PX; room <= 1200; room += 10) {
        const s = uiScale(w, h, room)
        expect(room / s, `${w}x${h} room ${room}: ${s}`).toBeGreaterThanOrEqual(UI_SCALE_ROOM_MIN_PX - 1e-6)
        expect(s, `${w}x${h} room ${room}`).toBeGreaterThanOrEqual(Math.min(uiScale(w, h) * UI_SCALE_FLOOR_SHARE, room / UI_SCALE_ROOM_MIN_PX) - UI_SCALE_STEP)
        expect(s).toBeLessThanOrEqual(uiScale(w, h))
      }
    }
  })

  it('reads a size it cannot measure as 1', () => {
    expect(uiScale(Number.NaN, 1080)).toBe(1)
    expect(uiScale(3840, 2160, Number.NaN)).toBe(1.5)
    expect(uiScale(Infinity, Infinity)).toBe(1)
  })

  it('matches the documentation page, whose root size is uiScale rule in CSS (a clamp), to within a step', () => {
    const html = renderDocumentation(buildDocumentation(labelledWorld(), { title: 'T', picture: false, generatedOn: '2026-11-21' }), labelledWorld())
    const [, lo, base, vw, vh, hi] = (/font-size: clamp\(([0-9.]+)px, calc\(([0-9.]+)px \+ min\(([0-9.]+)vw, ([0-9.]+)vh\)\), ([0-9.]+)px\)/.exec(html) as RegExpExecArray).map(Number)
    const cssScale = (w: number, h: number): number => Math.min(hi, Math.max(lo, base + Math.min((vw * w) / 100, (vh * h) / 100))) / 16
    for (const [w, h] of [[768, 1024], [1280, 800], [1920, 1080], [2560, 1440], [3440, 1440], [3840, 2160], [5120, 2880], [9000, 6000]]) {
      const css = cssScale(w, h)
      const s = uiScale(w, h)
      expect(s, `${w}x${h}: uiScale ${s}, CSS ${css}`).toBeLessThanOrEqual(css + 0.005)
      expect(css - s, `${w}x${h}`).toBeLessThan(UI_SCALE_STEP + 0.005)
    }
  })
})
