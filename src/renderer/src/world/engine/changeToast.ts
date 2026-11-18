// The Lumopolis change toast ("+3 parts, 2 changed"): a small polite live region inside the viewer's
// container, shown for TOAST_MS after a load that changed something. It shows with reduced motion too.
// It sits just above the ask bar and is centred in the part of the view the legend leaves free
// (place), so neither panel ever covers it.
import type { Theme } from './themes'

export const TOAST_MS = 3000
/** Its gap to the bottom edge when no ask bar is there. */
const TOAST_EDGE_PX = 16
/**
 * Above the building and district names: the label layer numbers each label's z-index up from zero in
 * the same stacking context, so a small one put the toast under the names.
 */
const TOAST_Z = '1000000'

export interface ChangeToast {
  /** Shows the text for TOAST_MS, replacing any toast still up; '' hides it. */
  show(text: string, theme: Theme): void
  /**
   * The strips at the bottom (the ask bar's reserve, its clearance included) and on the right (the
   * legend's) it keeps out of: it sits above the one and is centred in what the other leaves free.
   */
  place(bottom: number, right: number): void
  dispose(): void
}

export function createChangeToast(container: HTMLElement): ChangeToast {
  let el: HTMLDivElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let low = 0
  let side = 0

  function position(r: HTMLDivElement): void {
    r.style.bottom = `${Math.max(TOAST_EDGE_PX, low)}px`
    r.style.left = `calc(50% - ${side / 2}px)`
    r.style.maxWidth = `calc(100% - ${side + 2 * 12}px)`
  }

  function hide(): void {
    clearTimeout(timer)
    timer = undefined
    if (!el) return
    el.hidden = true
    el.textContent = ''
  }

  function region(): HTMLDivElement {
    if (!el) {
      el = document.createElement('div')
      el.className = 'lw-toast'
      el.setAttribute('role', 'status')
      el.setAttribute('aria-live', 'polite')
      // The building-label look (.lw-bldg in threeRenderer.ts), centred along the bottom edge.
      Object.assign(el.style, {
        position: 'absolute', transform: 'translateX(-50%)', zIndex: TOAST_Z, pointerEvents: 'none',
        fontFamily: 'system-ui, sans-serif', fontSize: '13px', padding: '6px 14px', borderRadius: '99px',
        background: 'rgba(3, 7, 18, 0.85)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        boxSizing: 'border-box',
      })
      position(el)
    }
    // The 2D list replaces the container's contents on every draw: put the region back.
    if (el.parentNode !== container) container.appendChild(el)
    return el
  }

  return {
    show(text, theme) {
      hide()
      if (text === '') return
      const r = region()
      r.style.color = theme.text
      r.style.border = `1px solid ${theme.glow}`
      r.textContent = text
      r.hidden = false
      timer = setTimeout(hide, TOAST_MS)
    },
    place(bottom, right) {
      low = bottom
      side = right
      if (el) position(el)
    },
    dispose() {
      hide()
      el?.remove()
      el = null
    },
  }
}
