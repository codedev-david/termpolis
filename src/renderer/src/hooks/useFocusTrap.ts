// Keeps the keyboard inside a modal sheet while it is open, and gives the focus back where it was
// when it closes: Tab and Shift+Tab go round the sheet's own controls, so no key reaches the
// terminal under it. The sheet's first control takes the focus, or the one marked data-autofocus.
import { useEffect } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** The controls the keyboard can reach in `el`, in order. */
export function focusables(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => !x.hasAttribute('disabled') && x.tabIndex !== -1)
}

export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    // Set by the time the effect runs: the sheet renders the element the ref is on.
    const el = ref.current as HTMLElement
    const before = document.activeElement as HTMLElement | null
    const first = el.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(el)[0] ?? el
    first.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      e.preventDefault()
      const list = focusables(el)
      if (list.length === 0) return el.focus()
      const at = list.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (at <= 0 ? list[list.length - 1] : list[at - 1]) : (at < 0 || at === list.length - 1 ? list[0] : list[at + 1])
      next.focus()
    }
    el.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('keydown', onKey)
      // Back where it was: the terminal the sheet opened over, most often.
      if (before && document.contains(before)) before.focus()
    }
  }, [ref])
}
