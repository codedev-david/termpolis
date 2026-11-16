// The Lumopolis change toast ("+3 parts, 2 changed"): a small polite live region inside the viewer's
// container, shown for TOAST_MS after a load that changed something. It shows with reduced motion too.
import type { Theme } from './themes'

export const TOAST_MS = 3000

export interface ChangeToast {
  /** Shows the text for TOAST_MS, replacing any toast still up; '' hides it. */
  show(text: string, theme: Theme): void
  dispose(): void
}

export function createChangeToast(container: HTMLElement): ChangeToast {
  let el: HTMLDivElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

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
        position: 'absolute', left: '50%', bottom: '16px', transform: 'translateX(-50%)', zIndex: '2', pointerEvents: 'none',
        fontFamily: 'system-ui, sans-serif', fontSize: '13px', padding: '6px 14px', borderRadius: '99px',
        background: 'rgba(3, 7, 18, 0.85)', whiteSpace: 'nowrap',
      })
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
    dispose() {
      hide()
      el?.remove()
      el = null
    },
  }
}
