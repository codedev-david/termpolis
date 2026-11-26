// A Lumopolis dialog is modal inside the pane, not over the whole window (A11Y Y4): it takes the focus as it opens, Tab
// and Shift+Tab go round its own controls, a focus moved to the pane behind it (a click on the map) comes back to it,
// and closed it gives the focus back to the control that opened it, or to the pane. The terminal beside the pane can
// still take the focus. Esc is the pane's (WorldView's one listener), which closes the dialog on top and only it.
import type { RefObject } from 'react'
import { useFocusTrap } from '../../hooks/useFocusTrap'

const paneOf = (el: HTMLElement): HTMLElement | null => el.closest<HTMLElement>('[data-testid="world-view"]')

/** `restore` false: the caller gives the focus back itself on close (the home, the clone dialog under the token one). */
export function usePaneDialog(ref: RefObject<HTMLElement | null>, restore = true): void {
  useFocusTrap(ref, { within: paneOf, restore })
}
