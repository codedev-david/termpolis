import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  clampWorldPaneWidth, loadWorldPaneWidth, saveWorldPaneWidth, worldPaneStyle, useWorldPaneWidth,
  WORLD_PANE_MIN_PX, TERMINAL_MIN_PX, WORLD_PANE_DEFAULT_FRACTION,
} from '../../../src/renderer/src/components/World/worldPane'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('clampWorldPaneWidth', () => {
  it('keeps the terminals at TERMINAL_MIN_PX and the pane at its minimum', () => {
    expect(WORLD_PANE_MIN_PX).toBe(360)
    expect(TERMINAL_MIN_PX).toBe(320)
    expect(WORLD_PANE_DEFAULT_FRACTION).toBe(0.5)
    expect(clampWorldPaneWidth(900, 1000)).toBe(680)
    expect(clampWorldPaneWidth(100, 1000)).toBe(360)
    expect(clampWorldPaneWidth(500, 800)).toBe(480)
  })
  it('lets the terminal minimum win when the row cannot hold both (Ruling P12)', () => {
    expect(clampWorldPaneWidth(500, 600)).toBe(280)
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

  it('starts at half the room, from the window until it is measured', () => {
    const el = main(0)
    const { result } = renderHook(() => useWorldPaneWidth(el, false))
    expect(result.current.width).toBe(clampWorldPaneWidth(window.innerWidth * 0.5, window.innerWidth))
  })

  it('measures the room as the terminals plus the pane and divider, and re-clamps on resize', () => {
    const el = main(1000)
    const { result } = renderHook(() => useWorldPaneWidth(el, true))
    // The window's 1024 gave 512; the measured room is 1000 + 512 + 4, half of it 758.
    expect(result.current.width).toBe(758)
    act(() => { el.current.clientWidth = 700; window.dispatchEvent(new Event('resize')) })
    expect(result.current.width).toBe(731) // room 700 + 758 + 4
    act(() => { el.current.clientWidth = 100; window.dispatchEvent(new Event('resize')) })
    expect(result.current.width).toBe(418) // half of 100 + 731 + 4, rounded: it follows the window until it is dragged
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
    expect(result.current.width).toBe(1484) // the room 1400 + 400 + 4, less the terminals' 320
  })
})
