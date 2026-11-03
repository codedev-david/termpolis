/**
 * Kill switches for the 1.54.5 typing fixes. Each is a localStorage key; the value '0' turns the fix off
 * and the pane then behaves the way 1.54.4 did. Anything else, a missing key, or storage that cannot be
 * read (a private window, blocked site data) leaves the fix ON: a switch is for turning a fix off on
 * purpose, never something a storage failure may do by accident.
 *
 * From the DevTools console of the renderer:  localStorage.setItem('termpolis.resizeOrder', '0')  then
 * reload (or open a new terminal: every pane reads its switches when it mounts).
 */

/** Output queue: the 1.54.4 string buffer instead of the chunk list, and the 1,000,000-char selection hold. */
export const SWITCH_OUTPUT_CHUNKS = 'termpolis.outputChunks'

/** Resize: fit and tell the pty at once, as 1.54.4 did (no drain barrier, no mount hold, no visible-only fits, no floors). */
export const SWITCH_RESIZE_ORDER = 'termpolis.resizeOrder'

export function switchEnabled(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== '0'
  } catch {
    return true
  }
}
