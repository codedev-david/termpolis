import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  ASK_BOTTOM_PX, ASK_SLOT_WIDTH, askReserve, clampWorldPaneWidth, loadWorldPaneWidth, saveWorldPaneWidth, worldPaneStyle, useWorldPaneWidth,
  WORLD_PANE_MIN_PX, TERMINAL_MIN_PX, WORLD_PANE_DEFAULT_FRACTION,
} from '../../../src/renderer/src/components/World/worldPane'

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
  it('lets the terminal minimum win when the row cannot hold both (Ruling P12)', () => {
    expect(clampWorldPaneWidth(500, 600)).toBe(276)
    expect(clampWorldPaneWidth(500, 100)).toBe(0)
  })
})

describe('worldPaneStyle', () => {
  it('is a flex sibling, never an overlay', () => {
    const s = worldPaneStyle('#03050a', 500)
    expect(s).toMatchObject({ position: 'relative', flex: '0 0 auto', width: 500, minWidth: 500, background: '#03050a' })
    expect(s.zIndex).toBeUndefined()
    expect(s.top).toBeUndefined()
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
    act(() => { el.current.clientWidth = 100; window.dispatchEvent(new Event('resize')) })
    expect(result.current.width).toBe(288) // the room 612 leaves the terminals 320 and the divider 4: the pane gives way under its own minimum
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
