import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import {
  ASK_BOTTOM_PX, ASK_SLOT_WIDTH, askReserve, CARD_FREE_SHARE, CARD_INSET_PX, CARD_MIN_FREE_PX, CARD_MIN_HEIGHT_PX, CARD_WIDTH_PX, cardMaxHeight, cardMeetsLegend, cardReserve, clampWorldPaneWidth, loadWorldPaneWidth, saveWorldPaneWidth, worldPaneOverlays, worldPaneStyle, useWorldPaneWidth,
  UiScaleContext, useUiScale, useUiZoom,
  WORLD_PANE_MIN_PX, TERMINAL_MIN_PX, WORLD_PANE_DEFAULT_FRACTION,
} from '../../../src/renderer/src/components/World/worldPane'
import { freeArea, MIN_FREE_PX } from '../../../src/renderer/src/world/engine/viewMath'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('clampWorldPaneWidth', () => {
  it('keeps the terminals at TERMINAL_MIN_PX and the pane at its minimum', () => {
    expect(WORLD_PANE_MIN_PX).toBe(360)
    expect(TERMINAL_MIN_PX).toBe(320)
    expect(WORLD_PANE_DEFAULT_FRACTION).toBe(0.4)
    expect(clampWorldPaneWidth(900, 1000)).toBe(676) // 1000 less the terminals' 320 and the divider's 4
    expect(clampWorldPaneWidth(100, 1000)).toBe(360)
    expect(clampWorldPaneWidth(500, 800)).toBe(476)
  })
  it('lies over the terminals at the full row when the row cannot hold the pane at 360 beside the terminals at 320', () => {
    expect(worldPaneOverlays(684)).toBe(false) // 360 + 4 + 320: both fit exactly
    expect(clampWorldPaneWidth(500, 684)).toBe(360)
    expect(worldPaneOverlays(683)).toBe(true)
    expect(clampWorldPaneWidth(500, 600)).toBe(600)
    expect(clampWorldPaneWidth(100, 100)).toBe(100)
    expect(clampWorldPaneWidth(500, -5)).toBe(0)
  })
})

describe('worldPaneStyle', () => {
  it('is a flex sibling beside the terminals', () => {
    const s = worldPaneStyle('#03050a', 500)
    expect(s).toMatchObject({ position: 'relative', flex: '0 0 auto', width: 500, minWidth: 500, background: '#03050a' })
    expect(s.zIndex).toBeUndefined()
    expect(s.top).toBeUndefined()
  })
  it('lies over the terminals column, above xterm and under the dialogs, when it overlays', () => {
    const s = worldPaneStyle('#03050a', 528, { left: 240 })
    expect(s).toMatchObject({ position: 'absolute', top: 0, bottom: 0, left: 240, width: 528, zIndex: 30, background: '#03050a', overflow: 'hidden' })
    expect(s.flex).toBeUndefined()
  })
})

describe('the saved width', () => {
  it('round-trips, and rounds to whole pixels', () => {
    expect(loadWorldPaneWidth()).toBeNull()
    saveWorldPaneWidth(512.6)
    expect(localStorage.getItem('termpolis.world.paneWidth')).toBe('513')
    expect(loadWorldPaneWidth()).toBe(513)
  })
  it('a corrupt value gives null', () => {
    for (const bad of ['abc', '0', '-5', 'Infinity']) {
      localStorage.setItem('termpolis.world.paneWidth', bad)
      expect(loadWorldPaneWidth()).toBeNull()
    }
  })
  it('a throwing localStorage gives null and never throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(loadWorldPaneWidth()).toBeNull()
    expect(() => saveWorldPaneWidth(500)).not.toThrow()
  })
})

describe('useWorldPaneWidth', () => {
  const main = (clientWidth: number) => ({ current: { clientWidth } as HTMLElement })

  it('starts at 40% of the room, from the window until it is measured', () => {
    const el = main(0)
    const { result } = renderHook(() => useWorldPaneWidth(el, false))
    expect(result.current.width).toBe(clampWorldPaneWidth(Math.round(window.innerWidth * 0.4), window.innerWidth))
  })

  it('measures the room as the terminals plus the pane and divider, and re-clamps on resize', () => {
    const el = main(1000)
    const { result } = renderHook(() => useWorldPaneWidth(el, true))
    // The window's 1024 gave 410; the measured room is 1000 + 410 + 4, 40% of it 566.
    expect(result.current.width).toBe(566)
    act(() => { el.current.clientWidth = 700; window.dispatchEvent(new Event('resize')) })
    expect(result.current.width).toBe(508) // room 700 + 566 + 4, 40% of it
    expect(result.current.overlay).toBeNull()
    act(() => { el.current.clientWidth = 100; window.dispatchEvent(new Event('resize')) })
    // The room 100 + 508 + 4 = 612 cannot hold the pane at 360 beside the terminals at 320: it lies over them
    // at the full room, and from then on the terminals' column alone is the room.
    expect(result.current.width).toBe(612)
    expect(result.current.overlay).toEqual({ left: 0 })
  })

  it('in an overlay measures the column alone, at its left edge, and goes back beside the terminals when the row grows', () => {
    const el = { current: { clientWidth: 500, offsetLeft: 240 } as HTMLElement }
    const { result } = renderHook(() => useWorldPaneWidth(el, true))
    // 500 + 410 + 4 = 914 first; 40% of it, 366, sits beside the terminals.
    expect(result.current.overlay).toBeNull()
    act(() => { (el.current as { clientWidth: number }).clientWidth = 200; window.dispatchEvent(new Event('resize')) })
    // 200 + 366 + 4 = 570: too narrow, so the pane covers the column, whose width (now the whole room) is 570.
    act(() => { (el.current as { clientWidth: number }).clientWidth = 570; window.dispatchEvent(new Event('resize')) })
    expect(result.current.overlay).toEqual({ left: 240 })
    expect(result.current.width).toBe(570)
    // The divider is gone; a stray drag changes nothing.
    act(() => result.current.onDrag(-50))
    expect(result.current.width).toBe(570)
    expect(loadWorldPaneWidth()).toBeNull()
    act(() => { (el.current as { clientWidth: number }).clientWidth = 1000; window.dispatchEvent(new Event('resize')) })
    expect(result.current.overlay).toBeNull()
    expect(result.current.width).toBe(400) // 40% of the room 1000, back beside the terminals
  })

  it('counts only the part of a pane inside the row when the window shrinks under it', () => {
    const row = { scrollWidth: 1414, clientWidth: 1414 }
    const el = { current: { clientWidth: 1000, offsetLeft: 0, parentElement: row } as unknown as HTMLElement }
    const { result } = renderHook(() => useWorldPaneWidth(el, true))
    expect(result.current.width).toBe(566) // 40% of 1000 + 410 + 4
    // The window shrinks to a 400 px row: the column is squeezed to 0 and the pane and divider (570) run 170 past its edge.
    act(() => {
      Object.assign(el.current as unknown as Record<string, unknown>, { clientWidth: 0 })
      Object.assign(row, { scrollWidth: 570, clientWidth: 400 })
      window.dispatchEvent(new Event('resize'))
    })
    // The room is 0 + 566 + 4 - 170 = 400, the row's own width: too narrow for both, so the pane covers it.
    expect(result.current.overlay).toEqual({ left: 0 })
    expect(result.current.width).toBe(400)
  })

  it('re-clamps when the terminals column changes size on its own (the Changes panel, the sidebar)', () => {
    let notify: () => void = () => {}
    const disconnect = vi.fn()
    const observe = vi.fn()
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { notify = cb } observe = observe; disconnect = disconnect })
    saveWorldPaneWidth(700)
    const el = main(1000)
    const { result, unmount } = renderHook(() => useWorldPaneWidth(el, true))
    expect(observe).toHaveBeenCalledWith(el.current)
    expect(result.current.width).toBe(700)
    // Changes opens beside it: the column is 300 px, the room 300 + 700 + 4. The pane gives way, so
    // the column grows back to the terminals' 320.
    act(() => { el.current.clientWidth = 300; notify() })
    expect(result.current.width).toBe(680)
    unmount()
    expect(disconnect).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('exposes the width limits for the divider', () => {
    const el = main(1000)
    const { result } = renderHook(() => useWorldPaneWidth(el, true))
    // room 1000 + 410 + 4 = 1414
    expect(result.current.min).toBe(360)
    expect(result.current.max).toBe(1414 - 320 - 4)
  })

  it('stops listening when it is not active, and when it unmounts', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const el = main(900)
    renderHook(() => useWorldPaneWidth(el, false))
    expect(add).not.toHaveBeenCalledWith('resize', expect.anything())
    const on = renderHook(() => useWorldPaneWidth(el, true))
    expect(add).toHaveBeenCalledWith('resize', expect.anything())
    on.unmount()
    expect(remove).toHaveBeenCalledWith('resize', expect.anything())
  })

  it('dragging the divider by -100 px widens the pane by 100 px and saves it', () => {
    saveWorldPaneWidth(400)
    const el = main(1400)
    const { result } = renderHook(() => useWorldPaneWidth(el, true))
    expect(result.current.width).toBe(400)
    act(() => result.current.onDrag(-100))
    expect(result.current.width).toBe(500)
    expect(loadWorldPaneWidth()).toBe(500)
    // Two moves before a render add up; both are clamped.
    act(() => { result.current.onDrag(40); result.current.onDrag(40) })
    expect(result.current.width).toBe(420)
    act(() => result.current.onDrag(-5000))
    expect(result.current.width).toBe(1480) // the room 1400 + 400 + 4, less the terminals' 320 and the divider's 4
  })
})

describe('askReserve', () => {
  it('keeps the ask bar, its gap to the bottom and a little clearance out of the fit; nothing while it is not there', () => {
    expect(ASK_BOTTOM_PX).toBe(16)
    expect(ASK_SLOT_WIDTH).toBe('min(34rem, calc(100% - 24px))')
    expect(askReserve(126)).toBe(150)
    expect(askReserve(125.2)).toBe(150)
    expect(askReserve(0)).toBe(0)
    expect(askReserve(-3)).toBe(0)
  })
})

describe('cardReserve', () => {
  it('keeps the card, its gap to the edges and a little clearance out of the close-ups, in 8 px steps; nothing while closed', () => {
    expect(CARD_INSET_PX).toBe(12)
    // 330 + 12 + 8 = 350 -> 352; 225 + 20 = 245 -> 248.
    expect(cardReserve(330, 225)).toEqual([352, 248])
    // A pixel more or less in the card's content does not move the camera.
    expect(cardReserve(330, 226)).toEqual([352, 248])
    expect(cardReserve(330, 228)).toEqual([352, 248])
    expect(cardReserve(330, 229)).toEqual([352, 256])
    expect(cardReserve(0, 0)).toEqual([0, 0])
    expect(cardReserve(330, 0)).toEqual([0, 0])
    expect(cardReserve(0, 225)).toEqual([0, 0])
  })
})

describe('cardMaxHeight', () => {
  it('keeps its constants in step with the card and the free area', () => {
    expect(CARD_WIDTH_PX).toBe(330)
    expect(CARD_MIN_FREE_PX).toBe(MIN_FREE_PX)
    expect(CARD_FREE_SHARE).toBe(0.45)
  })

  it('in a wide pane only keeps the card above the ask bar, and leaves it uncapped with no bar or no stage', () => {
    // 586 - 164 of ask bar - 12 of inset - 8 of clearance.
    expect(cardMaxHeight(1000, 586, 0, 164)).toBe(402)
    // An answer makes the bar taller: the card stops higher, down to its shortest.
    expect(cardMaxHeight(1000, 586, 0, 360)).toBe(206)
    expect(cardMaxHeight(1000, 586, 0, 560)).toBe(CARD_MIN_HEIGHT_PX)
    expect(cardMaxHeight(1000, 586, 0, 0)).toBeNull()
    // The card's 352 px reserve and 120 px of city beside it: wide from 472 px.
    expect(cardMaxHeight(472, 586, 0, 164)).toBe(402)
    expect(cardMaxHeight(471, 586, 0, 164)).toBe(132)
    // The legend's strip counts against the room beside the card.
    expect(cardMaxHeight(700, 586, 200, 164)).toBe(402)
    expect(cardMaxHeight(600, 586, 200, 164)).toBe(132)
    expect(cardMaxHeight(0, 586, 0, 164)).toBeNull()
    expect(cardMaxHeight(416, 0, 0, 164)).toBeNull()
  })

  it('tells when the open card would reach the legend', () => {
    // A 180 px pane: the card fills it, so the 108 px legend chip would sit on it.
    expect(cardMeetsLegend(180, 108)).toBe(true)
    // 480 px: card to 350 (12 + 330 + 8), chip from 372.
    expect(cardMeetsLegend(480, 108)).toBe(false)
    // ...but the expanded legend (244 px) starts at 236.
    expect(cardMeetsLegend(480, 244)).toBe(true)
    expect(cardMeetsLegend(594, 244)).toBe(false)
    expect(cardMeetsLegend(593, 244)).toBe(true)
    // A stage not measured yet keeps the legend.
    expect(cardMeetsLegend(0, 108)).toBe(false)
  })

  it('caps a card in a narrow pane so 45% of the height stays free above the ask bar (the CI pane)', () => {
    // 416 x 586, ask bar reserve 164: 586 - 164 - 264 = 158 px for the card's reserve, 152 on a step,
    // less its 12 px inset and 8 px clearance.
    expect(cardMaxHeight(416, 586, 0, 164)).toBe(132)
    expect(cardReserve(CARD_WIDTH_PX, 132)).toEqual([352, 152])
    // A tall card (m12's, about 410 px) is held at the cap; the city is then framed below it.
    const area = freeArea(416, 586, 0, 164, cardReserve(CARD_WIDTH_PX, Math.min(410, 132)))
    expect(area.top).toBe(152)
    expect(586 - area.top - area.bottom).toBeGreaterThanOrEqual(586 * CARD_FREE_SHARE)
    // A short card is never stretched: the cap is a ceiling, so its reserve follows its own height.
    expect(cardReserve(CARD_WIDTH_PX, Math.min(100, 132))).toEqual([352, 120])
  })

  it('always leaves the share free when there is room for a usable card, and never goes under its minimum', () => {
    for (let h = 300; h <= 1400; h += 7) {
      for (const ask of [0, 80, 164]) {
        const cap = cardMaxHeight(416, h, 0, ask) as number
        expect(cap).toBeGreaterThanOrEqual(CARD_MIN_HEIGHT_PX)
        if (cap > CARD_MIN_HEIGHT_PX) expect(h - ask - cardReserve(CARD_WIDTH_PX, cap)[1]).toBeGreaterThanOrEqual(h * CARD_FREE_SHARE)
      }
    }
    // A stage too short for both keeps the card's title row and a few lines.
    expect(cardMaxHeight(416, 300, 0, 164)).toBe(CARD_MIN_HEIGHT_PX)
  })
})

describe('the pane scale', () => {
  const windowSize = (w: number, h: number): void => {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: h, configurable: true })
  }
  afterEach(() => windowSize(1024, 768))

  it('is 1 up to a 1080p window, grows on a big monitor, keeps a narrow pane its room, and follows the window', () => {
    windowSize(1920, 1080)
    const { result, rerender, unmount } = renderHook(({ w }) => useUiScale(w), { initialProps: { w: 1600 } })
    expect(result.current).toBe(1)
    act(() => { windowSize(3840, 2160); window.dispatchEvent(new Event('resize')) })
    expect(result.current).toBe(1.5)
    rerender({ w: 912 }) // a pane split narrow: 912 / 760
    expect(result.current).toBe(1.2)
    rerender({ w: 480 }) // narrower: the floor, 75% of 1.5 rounded down to a step
    expect(result.current).toBe(1.1)
    const off = vi.spyOn(window, 'removeEventListener')
    unmount()
    expect(off).toHaveBeenCalledWith('resize', expect.any(Function))
  })

  it('zooms a panel by the scale the pane provides, and leaves it alone at 1', () => {
    expect(renderHook(() => useUiZoom()).result.current).toEqual({})
    const at = (s: number) => ({ children }: { children: ReactNode }) => createElement(UiScaleContext.Provider, { value: s }, children)
    expect(renderHook(() => useUiZoom(), { wrapper: at(1) }).result.current).toEqual({})
    expect(renderHook(() => useUiZoom(), { wrapper: at(1.5) }).result.current).toEqual({ zoom: 1.5 })
  })
})
