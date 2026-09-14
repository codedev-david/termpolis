import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  HunkMenu,
  clampToViewport,
  MENU_WIDTH,
  MENU_ITEM_HEIGHT,
  MENU_VERTICAL_PADDING,
  VIEWPORT_MARGIN,
  type HunkMenuItem,
} from '../../../src/renderer/src/components/ChangesPanel/HunkMenu'

const onClose = vi.fn()
const onExplain = vi.fn()
const onRevert = vi.fn()

beforeEach(() => vi.clearAllMocks())

const items = (patch: Partial<HunkMenuItem>[] = []): HunkMenuItem[] => {
  const base: HunkMenuItem[] = [
    { key: 'explain', label: 'Explain this hunk', icon: 'fa-lightbulb', onSelect: onExplain },
    { key: 'revert', label: 'Revert this hunk', danger: true, onSelect: onRevert },
  ]
  return base.map((b, i) => ({ ...b, ...(patch[i] ?? {}) }))
}

const mount = (props: Partial<React.ComponentProps<typeof HunkMenu>> = {}) =>
  render(<HunkMenu x={10} y={10} items={items()} onClose={onClose} {...props} />)

describe('clampToViewport', () => {
  const H = (n: number) => n * MENU_ITEM_HEIGHT + MENU_VERTICAL_PADDING

  it('leaves a menu with room alone', () => {
    expect(clampToViewport(10, 10, 3, 1000, 800)).toEqual({ left: 10, top: 10 })
  })

  it('flips to the LEFT of the cursor near the right edge', () => {
    // Flipping reads better than pinning to the edge with the cursor on top of it.
    expect(clampToViewport(900, 10, 3, 1000, 800)).toEqual({ left: 900 - MENU_WIDTH, top: 10 })
  })

  it('flips ABOVE the cursor near the bottom edge', () => {
    expect(clampToViewport(10, 750, 3, 1000, 800)).toEqual({ left: 10, top: 750 - H(3) })
  })

  it('flips on both axes at once in a bottom-right corner', () => {
    expect(clampToViewport(900, 750, 3, 1000, 800))
      .toEqual({ left: 900 - MENU_WIDTH, top: 750 - H(3) })
  })

  it('clamps to the margin when a flip would go off the left edge', () => {
    // A viewport narrower than the menu has no side that fits; the first item must
    // still be clickable.
    expect(clampToViewport(100, 50, 3, 250, 800)).toEqual({ left: VIEWPORT_MARGIN, top: 50 })
  })

  it('clamps to the margin when a flip would go off the top edge', () => {
    expect(clampToViewport(10, 50, 3, 1000, 100)).toEqual({ left: 10, top: VIEWPORT_MARGIN })
  })

  it('grows the reserved height with the item count', () => {
    const two = clampToViewport(10, 750, 2, 1000, 800)
    const five = clampToViewport(10, 750, 5, 1000, 800)
    expect(five.top).toBeLessThan(two.top)
  })
})

describe('HunkMenu — rendering', () => {
  it('renders onto document.body, escaping the diff modal\'s overflow box', () => {
    mount()
    const menu = screen.getByTestId('hunk-menu')
    expect(menu).toBeInTheDocument()
    // Portalled: its ancestor chain reaches body without passing the RTL container.
    expect(document.body.contains(menu)).toBe(true)
  })

  it('renders one item per entry, keyed by the item key', () => {
    mount()
    expect(screen.getByTestId('hunk-menu-explain')).toHaveTextContent('Explain this hunk')
    expect(screen.getByTestId('hunk-menu-revert')).toHaveTextContent('Revert this hunk')
  })

  it('is announced as a menu of menuitems', () => {
    mount()
    expect(screen.getByRole('menu')).toHaveAttribute('aria-label', 'Hunk actions')
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
  })

  it('positions itself at the click', () => {
    mount({ x: 40, y: 60 })
    expect(screen.getByTestId('hunk-menu')).toHaveStyle({ left: '40px', top: '60px' })
  })

  it('renders an icon only where one was given', () => {
    const { container } = mount()
    expect(screen.getByTestId('hunk-menu-explain').querySelector('i')).toBeTruthy()
    expect(screen.getByTestId('hunk-menu-revert').querySelector('i')).toBeNull()
    expect(container).toBeTruthy()
  })

  it('carries the tooltip explaining a disabled item', () => {
    mount({ items: items([{}, { disabled: true, title: 'This file is untracked' }]) })
    expect(screen.getByTestId('hunk-menu-revert')).toHaveAttribute('title', 'This file is untracked')
    expect(screen.getByTestId('hunk-menu-revert')).toBeDisabled()
  })

  it('swallows a right-click inside itself rather than stacking the host menu on top', () => {
    mount()
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    screen.getByTestId('hunk-menu').dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })
})

describe('HunkMenu — selecting', () => {
  it('runs the item and then closes', () => {
    mount()
    fireEvent.click(screen.getByTestId('hunk-menu-explain'))
    expect(onExplain).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does nothing at all for a disabled item', () => {
    mount({ items: items([{}, { disabled: true }]) })
    fireEvent.click(screen.getByTestId('hunk-menu-revert'))
    expect(onRevert).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('HunkMenu — dismissal', () => {
  it('closes on a mousedown outside itself', () => {
    mount()
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open on a mousedown inside itself', () => {
    mount()
    fireEvent.mouseDown(screen.getByTestId('hunk-menu'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on scroll, which would otherwise leave it pointing at a different line', () => {
    mount()
    fireEvent.scroll(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when the window loses focus', () => {
    mount()
    fireEvent.blur(window)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', () => {
    mount()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stops Escape reaching the diff modal behind it', () => {
    // The modal listens for Escape on window in the BUBBLE phase; the menu listens in
    // CAPTURE. Stopping propagation there is what keeps one press from closing both.
    const modalClose = vi.fn()
    window.addEventListener('keydown', modalClose)
    try {
      mount()
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(modalClose).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', modalClose)
    }
  })

  it('stops listening once unmounted', () => {
    const { unmount } = mount()
    unmount()
    fireEvent.mouseDown(document.body)
    fireEvent.scroll(document.body)
    fireEvent.blur(window)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('HunkMenu — keyboard', () => {
  it('lands on the first item from a cold start', () => {
    mount()
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(onExplain).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('walks down the list', () => {
    mount()
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(onRevert).toHaveBeenCalledTimes(1)
  })

  it('ArrowUp from a cold start lands on the LAST item', () => {
    mount()
    fireEvent.keyDown(document.body, { key: 'ArrowUp' })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(onRevert).toHaveBeenCalledTimes(1)
  })

  it('wraps around the ends', () => {
    mount()
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(onExplain).toHaveBeenCalledTimes(1)
  })

  it('skips disabled items entirely', () => {
    mount({ items: items([{}, { disabled: true }]) })
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    // Two ArrowDowns with one enabled item still sits on that item, never the disabled one.
    expect(onExplain).toHaveBeenCalledTimes(1)
    expect(onRevert).not.toHaveBeenCalled()
  })

  it('does nothing when every item is disabled', () => {
    mount({ items: items([{ disabled: true }, { disabled: true }]) })
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(onExplain).not.toHaveBeenCalled()
    expect(onRevert).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('selects with Space as well as Enter', () => {
    mount()
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    fireEvent.keyDown(document.body, { key: ' ' })
    expect(onExplain).toHaveBeenCalledTimes(1)
  })

  it('does nothing on Enter before anything is highlighted', () => {
    mount()
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(onExplain).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('ignores unrelated keys', () => {
    mount()
    fireEvent.keyDown(document.body, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    expect(onExplain).not.toHaveBeenCalled()
  })

  it('highlights what the mouse is over, so Enter follows the pointer', () => {
    mount()
    fireEvent.mouseEnter(screen.getByTestId('hunk-menu-revert'))
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(onRevert).toHaveBeenCalledTimes(1)
  })

  it('never arms a disabled item, even with the pointer over it', () => {
    mount({ items: items([{}, { disabled: true }]) })
    fireEvent.mouseEnter(screen.getByTestId('hunk-menu-explain'))
    // React does not deliver mouse events to a disabled control, so the highlight
    // stays where it was — and Enter re-checks `disabled` before selecting anyway.
    fireEvent.mouseEnter(screen.getByTestId('hunk-menu-revert'))
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(onRevert).not.toHaveBeenCalled()
    expect(onExplain).toHaveBeenCalledTimes(1)
  })
})
