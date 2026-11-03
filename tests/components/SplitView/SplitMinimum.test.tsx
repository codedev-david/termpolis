import React, { createRef } from 'react'
import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SplitDivider } from '../../../src/renderer/src/components/SplitView/SplitDivider'
import { PaneRenderer } from '../../../src/renderer/src/components/SplitView/PaneRenderer'
import { MIN_PANE_WIDTH_PX, MIN_PANE_HEIGHT_PX } from '../../../src/renderer/src/lib/splitRatio'
import type { PaneNode } from '../../../src/renderer/src/types'

// The split minimum (1.54.5, plan package P3): a drag cannot leave a pane narrower than a usable
// terminal. NEGATIVE CONTROLS: without `minPx` the divider is the 1.54.4 one (10%..90%), and with the
// kill switch off PaneRenderer passes none.

vi.mock('../../../src/renderer/src/components/TerminalPane/TerminalPane', () => ({
  TerminalPane: ({ terminalId }: { terminalId: string }) => <div data-testid={`pane-${terminalId}`} />,
}))
vi.mock('../../../src/renderer/src/store/terminalStore', () => {
  const state = {
    terminals: [
      { id: 't1', name: 'one', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'mono' },
      { id: 't2', name: 'two', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'mono' },
    ],
    activeTerminalId: 't1',
    setActiveTerminal: vi.fn(),
    removeTerminal: vi.fn(),
    splitTerminal: vi.fn(),
  }
  const hook = vi.fn((selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state))
  return { useTerminalStore: Object.assign(hook, { getState: () => state, setState: vi.fn() }) }
})

const rectOf = (width: number, height: number) => () => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => undefined })

describe('SplitDivider with a minimum', () => {
  beforeEach(() => { document.body.style.cursor = ''; document.body.style.userSelect = '' })

  function drag(direction: 'horizontal' | 'vertical', to: { x: number; y: number }, minPx?: number, rect = rectOf(1000, 1000)): ReturnType<typeof vi.fn> {
    const parentRef = createRef<HTMLDivElement>()
    const onDrag = vi.fn()
    const { container, unmount } = render(
      <div ref={parentRef}>
        <SplitDivider direction={direction} onDrag={onDrag} parentRef={parentRef} minPx={minPx} />
      </div>,
    )
    ;(container.firstChild as HTMLElement).getBoundingClientRect = vi.fn(rect)
    fireEvent.mouseDown(container.querySelector('.shrink-0') as HTMLElement)
    fireEvent(document, new MouseEvent('mousemove', { clientX: to.x, clientY: to.y, bubbles: true }))
    fireEvent(document, new MouseEvent('mouseup', { bubbles: true }))
    unmount()
    return onDrag
  }

  it('a side-by-side split cannot be dragged under the width minimum (x = 30 of 1000 px)', () => {
    const onDrag = drag('vertical', { x: 30, y: 500 }, 200)
    expect(onDrag).toHaveBeenCalledTimes(1)
    expect(onDrag.mock.calls[0][0]).toBeCloseTo(0.2, 10)
  })

  it('...nor from the other side (x = 990)', () => {
    expect(drag('vertical', { x: 990, y: 500 }, 200).mock.calls[0][0]).toBeCloseTo(0.8, 10)
  })

  it('a stacked split cannot be dragged under the height minimum (y = 20 of 1000 px)', () => {
    expect(drag('horizontal', { x: 500, y: 20 }, 150).mock.calls[0][0]).toBeCloseTo(0.15, 10)
  })

  it('a drag inside the allowed range is passed on as it is', () => {
    expect(drag('vertical', { x: 640, y: 0 }, 200).mock.calls[0][0]).toBeCloseTo(0.64, 10)
  })

  it('NEGATIVE CONTROL: without a minimum the very same drag lands on the 1.54.4 clamp, a 100 px pane', () => {
    expect(drag('vertical', { x: 30, y: 500 }).mock.calls[0][0]).toBe(0.1)
    expect(drag('vertical', { x: 990, y: 500 }).mock.calls[0][0]).toBe(0.9)
  })

  it('a parent too small for two panes of the minimum keeps the plain clamp (jsdom\'s zero-size rect, a tiny window)', () => {
    expect(drag('vertical', { x: 5, y: 0 }, 200, rectOf(300, 300)).mock.calls[0][0]).toBe(0.1)
    // jsdom has no layout: every rect is 0 x 0. x / 0 is Infinity (clamped to 0.9) and 0 / 0 is NaN, exactly as the old clamp had it.
    expect(drag('vertical', { x: 5, y: 0 }, 200, rectOf(0, 0)).mock.calls[0][0]).toBe(0.9)
    expect(Number.isNaN(drag('vertical', { x: 0, y: 0 }, 200, rectOf(0, 0)).mock.calls[0][0])).toBe(true)
  })
})

describe('PaneRenderer passes the minimum to its divider', () => {
  afterEach(() => window.localStorage.clear())

  const node = (direction: 'horizontal' | 'vertical'): PaneNode => ({
    type: 'split',
    direction,
    ratio: 0.5,
    children: [
      { type: 'terminal', terminalId: 't1' },
      { type: 'terminal', terminalId: 't2' },
    ],
  })

  function dragThrough(direction: 'horizontal' | 'vertical'): number {
    const onSplitRatioChange = vi.fn()
    const { container, unmount } = render(<PaneRenderer node={node(direction)} onSplitRatioChange={onSplitRatioChange} path={[]} />)
    // the split container is the divider's parent
    const divider = container.querySelector(direction === 'vertical' ? '.cursor-col-resize' : '.cursor-row-resize') as HTMLElement
    ;(divider.parentElement as HTMLElement).getBoundingClientRect = vi.fn(rectOf(1000, 1000))
    fireEvent.mouseDown(divider)
    fireEvent(document, new MouseEvent('mousemove', { clientX: 5, clientY: 5, bubbles: true }))
    fireEvent(document, new MouseEvent('mouseup', { bubbles: true }))
    unmount()
    expect(onSplitRatioChange).toHaveBeenCalledTimes(1)
    expect(onSplitRatioChange.mock.calls[0][0]).toEqual([])
    return onSplitRatioChange.mock.calls[0][1] as number
  }

  it('side by side: at least MIN_PANE_WIDTH_PX', () => {
    expect(dragThrough('vertical') * 1000).toBeCloseTo(MIN_PANE_WIDTH_PX, 6)
  })

  it('stacked: at least MIN_PANE_HEIGHT_PX', () => {
    expect(dragThrough('horizontal') * 1000).toBeCloseTo(MIN_PANE_HEIGHT_PX, 6)
  })

  it('NEGATIVE CONTROL: with the resize kill switch off the divider is the 1.54.4 one', () => {
    window.localStorage.setItem('termpolis.resizeOrder', '0')
    expect(dragThrough('vertical')).toBe(0.1)
    expect(dragThrough('horizontal')).toBe(0.1)
  })
})
