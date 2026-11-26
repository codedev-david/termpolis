// Keeps the keyboard inside a modal sheet while it is open, and gives the focus back where it was
// when it closes: Tab and Shift+Tab go round the sheet's own controls, so no key reaches the
// terminal under it. The sheet's first control takes the focus, or the one marked data-autofocus.
// When the control that had the focus goes away at a step change, the focus comes back into the sheet
// (so Esc and Tab keep working), and when the sheet closes it goes to the control that opened it, or to
// the active terminal when that control went with the menu it was in.
import { useEffect, useRef } from 'react'
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

/** How a dialog that is modal inside a pane, not over the whole window, holds the focus (Lumopolis, A11Y Y4). */
export interface FocusTrapOptions {
  /** The pane the dialog is modal in, found from the dialog as it opens. The focus moved anywhere else in it (a click
   *  on the map, a screen reader's cursor) comes back to the dialog, unless a dialog opened over or beside it takes
   *  it (a pane's dialogs are no aria-modal ones: the pane makes what is behind them inert, A11Y fix round 1); outside the pane (the terminal beside it) it is left alone. On close, with the control that opened the dialog
   *  gone (a menu item), the pane takes the focus instead of the terminal. */
  within?: (el: HTMLElement) => HTMLElement | null
  /** false: the focus is not moved on close, as the caller gives it back itself (the Lumopolis home does). */
  restore?: boolean
}

export function useFocusTrap(ref: RefObject<HTMLElement | null>, options: FocusTrapOptions = {}): void {
  // Read once, as the dialog opens: what the trap does is fixed for as long as it is up.
  const { within, restore = true } = options
  // The control that opened the sheet, read as the sheet first renders: the commit that shows it may grey that control
  // (a toolbar button while its dialog is up), and a browser then moves the focus off it before any effect runs.
  const opener = useRef<HTMLElement | null | undefined>(undefined)
  if (opener.current === undefined) opener.current = document.activeElement as HTMLElement | null
  useEffect(() => {
    // Set by the time the effect runs: the sheet renders the element the ref is on.
    const el = ref.current as HTMLElement
    const before = opener.current
    const pane = within ? within(el) : null
    const first = el.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(el)[0] ?? el
    first.focus()
    const onKey = (e: KeyboardEvent): void => {
      // A trap nested in this one (a dialog over it) or another handler took this Tab already: one step only.
      if (e.key !== 'Tab' || e.defaultPrevented) return
      e.preventDefault()
      stepFocus(el, e.shiftKey)
    }
    el.addEventListener('keydown', onKey)
    // The control in the dialog that had the focus last, where a focus moved out to the pane behind comes back to.
    let last: HTMLElement = first
    const onFocusIn = (e: FocusEvent): void => {
      const to = e.target as HTMLElement
      if (el.contains(to)) { last = to; return }
      if (!(pane as HTMLElement).contains(to) || to.closest('[role="dialog"], [role="alertdialog"]') !== null) return
      ;(last.isConnected && el.contains(last) ? last : el).focus()
    }
    if (pane) document.addEventListener('focusin', onFocusIn)
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
      document.removeEventListener('focusin', onFocusIn)
      if (!restore) return
      // Back where it was: the control that opened the sheet; else the pane it is modal in, or the terminal the sheet
      // opened over.
      if (before && before !== document.body && document.contains(before)) before.focus()
      else if (pane && pane.isConnected) pane.focus()
      else {
        const id = useTerminalStore.getState().activeTerminalId
        if (id) focusTerminal(id)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the options are read once, as the dialog opens
  }, [ref])
}
