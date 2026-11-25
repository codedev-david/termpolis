// Keeps the keyboard inside a modal sheet while it is open, and gives the focus back where it was
// when it closes: Tab and Shift+Tab go round the sheet's own controls, so no key reaches the
// terminal under it. The sheet's first control takes the focus, or the one marked data-autofocus.
// When the control that had the focus goes away at a step change, the focus comes back into the sheet
// (so Esc and Tab keep working), and when the sheet closes it goes to the control that opened it, or to
// the active terminal when that control went with the menu it was in.
import { useEffect } from 'react'
import type { RefObject } from 'react'
import { focusTerminal } from '../lib/accountMenu'
import { useTerminalStore } from '../store/terminalStore'

const FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'

/** Is `x` inside a closed <details>, other than as that details' own summary? A browser renders none
 *  of it, so it can take no focus. */
function hiddenByDetails(x: HTMLElement, root: HTMLElement): boolean {
  for (let d = x.closest('details'); d && root.contains(d); d = d.parentElement?.closest('details') ?? null) {
    if (!d.open && !(x.tagName === 'SUMMARY' && x.parentElement === d)) return true
  }
  return false
}

/** Is `x` inert, or inside something that is (a dialog under another dialog)? It then takes no focus. The property
 *  is checked as well as the attribute: React sets it as a property. */
function underInert(x: HTMLElement): boolean {
  for (let n: HTMLElement | null = x; n; n = n.parentElement) if (n.inert === true || n.hasAttribute('inert')) return true
  return false
}

/** The controls the keyboard can reach in `el`, in order: none that is disabled, inert or hidden. */
export function focusables(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((x) => !x.hasAttribute('disabled') && x.getAttribute('tabindex') !== '-1' && !hiddenByDetails(x, el) && !underInert(x))
}

/** One Tab (or Shift+Tab, `back`) inside `el`: the next control round, never one outside. A control the browser won't
 *  focus is passed over, so the trap never stalls on it; with none at all, `el` itself keeps the focus. */
export function stepFocus(el: HTMLElement, back: boolean): void {
  const list = focusables(el)
  if (list.length === 0) return el.focus()
  const at = list.indexOf(document.activeElement as HTMLElement)
  const step = back ? -1 : 1
  let i = at < 0 ? (back ? list.length - 1 : 0) : (at + step + list.length) % list.length
  for (let tried = 0; tried < list.length; tried++, i = (i + step + list.length) % list.length) {
    list[i].focus()
    if (document.activeElement === list[i]) return
  }
}

/** The focus was on a control in `el` that has just gone grey (a pressed button, a field while its work runs), or it
 *  has fallen to <body>: `el` (with tabIndex -1) takes it, so Tab and Esc still reach that dialog. */
export function holdFocus(el: HTMLElement): void {
  const at = document.activeElement as Element
  if (at === document.body || (el.contains(at) && at.matches(':disabled'))) el.focus()
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
      stepFocus(el, e.shiftKey)
    }
    el.addEventListener('keydown', onKey)
    // The control that had the focus is gone (a step changed): <body> has it now, where Esc and Tab
    // reach nothing of the sheet. It comes back to the step's own control, or the sheet itself.
    const observer = new MutationObserver(() => {
      const at = document.activeElement
      if (at && at !== document.body && at !== el) return
      ;(el.querySelector<HTMLElement>('[data-autofocus]') ?? el).focus()
    })
    observer.observe(el, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('keydown', onKey)
      // Back where it was: the control that opened the sheet; else the terminal the sheet opened over.
      if (before && before !== document.body && document.contains(before)) before.focus()
      else {
        const id = useTerminalStore.getState().activeTerminalId
        if (id) focusTerminal(id)
      }
    }
  }, [ref])
}
