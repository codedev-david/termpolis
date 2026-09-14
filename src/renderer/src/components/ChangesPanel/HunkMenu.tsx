// The right-click menu on a diff hunk.
//
// Written here rather than pulled from a library because the app has no generic menu
// to reuse: TabPopover looks like one from the outside but is a bespoke tab-rename
// form with no notion of items. Kept deliberately small — items in, one click out.
// No submenus, no checkable rows, no icons-only mode.
//
// It renders through a portal onto document.body because its parent is the diff
// modal, which has `overflow: auto` on the scroller: a child positioned there would
// be clipped by the scroll box at exactly the moment the menu needs to escape it.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface HunkMenuItem {
  key: string
  label: string
  /** Font Awesome class, e.g. `fa-rotate-left`. */
  icon?: string
  /** Greyed and unclickable. `title` should then say why. */
  disabled?: boolean
  /** Tooltip — the reason an item is disabled, or extra context when it is not. */
  title?: string
  /** Renders in red: the item mutates the repo. */
  danger?: boolean
  onSelect: () => void
}

export interface HunkMenuProps {
  /** Viewport coordinates of the click that opened the menu. */
  x: number
  y: number
  items: HunkMenuItem[]
  onClose: () => void
}

export const MENU_WIDTH = 200
/** Per-item height plus the container's vertical padding, used only for clamping. */
export const MENU_ITEM_HEIGHT = 26
export const MENU_VERTICAL_PADDING = 8
/** Keep the menu this far from the viewport edge so it never sits flush against it. */
export const VIEWPORT_MARGIN = 6

/**
 * Keep the menu fully on screen.
 *
 * Flips rather than merely clamping: a menu opened near the right edge reads better
 * hanging to the LEFT of the cursor than pinned to the edge with the cursor on top of
 * it. Clamping is still applied afterwards, because a viewport narrower than the menu
 * has no side that fits and the menu must still be reachable.
 */
export function clampToViewport(
  x: number,
  y: number,
  itemCount: number,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  const height = itemCount * MENU_ITEM_HEIGHT + MENU_VERTICAL_PADDING
  let left = x
  let top = y
  if (left + MENU_WIDTH > viewportWidth - VIEWPORT_MARGIN) left = x - MENU_WIDTH
  if (top + height > viewportHeight - VIEWPORT_MARGIN) top = y - height
  // A viewport smaller than the menu leaves neither side fitting; pin to the margin
  // so the first item is always clickable.
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN
  if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN
  return { left, top }
}

export function HunkMenu({ x, y, items, onClose }: HunkMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // Index of the keyboard-focused item. -1 means "none yet", so the first ArrowDown
  // lands on item 0 rather than skipping it.
  const [active, setActive] = useState(-1)

  const [pos, setPos] = useState(() =>
    clampToViewport(x, y, items.length, window.innerWidth, window.innerHeight),
  )

  // Re-clamp against the element's REAL height once it exists: the estimate above is
  // built from a constant, and a long label that wraps would push the last item off
  // the bottom of the screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const h = el.offsetHeight
    // offsetHeight is 0 in a layout-less host; the estimate is the better answer there.
    if (h <= 0) return
    const next = clampToViewport(x, y, Math.ceil(h / MENU_ITEM_HEIGHT), window.innerWidth, window.innerHeight)
    setPos(p => (p.left === next.left && p.top === next.top ? p : next))
  }, [x, y, items.length])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
      closeRef.current()
    }
    // Scrolling the diff under a menu anchored to viewport coordinates would leave it
    // pointing at a different line than the one it was opened on.
    const onScroll = () => closeRef.current()
    const onBlur = () => closeRef.current()
    // `true` — capture, so the menu closes even if something downstream stops the event.
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter(i => i >= 0)
    const step = (dir: 1 | -1) => {
      if (enabled.length === 0) return
      setActive(cur => {
        const at = enabled.indexOf(cur)
        if (at < 0) return dir === 1 ? enabled[0] : enabled[enabled.length - 1]
        return enabled[(at + dir + enabled.length) % enabled.length]
      })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // The diff modal also closes on Escape. Without this the menu and the modal
        // would both go on one press, which reads as the app losing your place.
        e.stopPropagation()
        e.preventDefault()
        closeRef.current()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        step(1)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        step(-1)
        return
      }
      if (e.key === 'Enter' || e.key === ' ') {
        setActive(cur => {
          const item = cur >= 0 ? items[cur] : undefined
          if (item && !item.disabled) {
            e.preventDefault()
            e.stopPropagation()
            item.onSelect()
            closeRef.current()
          }
          return cur
        })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [items])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Hunk actions"
      data-testid="hunk-menu"
      className="fixed z-[200] py-1 rounded border border-[#3c3c3c] bg-[#252526] shadow-2xl text-[12px]"
      style={{ left: pos.left, top: pos.top, width: MENU_WIDTH }}
      // The menu is opened BY a right-click; a second one inside it should not open the
      // host browser menu on top of it.
      onContextMenu={e => e.preventDefault()}
      // A portal escapes the DOM tree but NOT the React tree: synthetic events still
      // bubble to whatever rendered this. The diff modal renders it inside a backdrop
      // whose onClick closes the modal, so without this every menu click would shut the
      // window the menu was acting on. Contained here rather than at the call site —
      // no caller should have to know that portalled clicks resurface in its own tree.
      onClick={e => e.stopPropagation()}
    >
      {items.map((it, i) => (
        <button
          key={it.key}
          role="menuitem"
          type="button"
          disabled={it.disabled}
          title={it.title}
          data-testid={`hunk-menu-${it.key}`}
          // No disabled guard here: React does not deliver mouse events to a disabled
          // control, the highlight style below is applied only on the enabled arm, and
          // the Enter handler re-checks `disabled` before selecting. Three reasons the
          // pointer cannot arm a disabled item.
          onMouseEnter={() => setActive(i)}
          onClick={() => {
            if (it.disabled) return
            it.onSelect()
            closeRef.current()
          }}
          className={`flex items-center gap-2 w-full px-3 py-1 text-left ${
            it.disabled
              ? 'text-[#5a5f6a] cursor-default'
              : `cursor-pointer ${it.danger ? 'text-[#e06c75]' : 'text-[#d4d4d4]'} ${
                  active === i ? 'bg-[#2a2d2e]' : ''
                } hover:bg-[#2a2d2e]`
          }`}
        >
          {it.icon && <i className={`fa-solid ${it.icon} w-3 text-[10px] flex-shrink-0`}></i>}
          <span className="truncate">{it.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
