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

/**
 * Write scheduler: '0' gives every pane its own output throttle again (the chunk-list one of 1.54.5) instead of
 * the renderer's one write scheduler, which serves the focused terminal first, bounds what xterm holds per
 * terminal and holds the others back while a key is going in. With the output switch above off the scheduler
 * is off as well: that switch is the whole 1.54.4 output path.
 */
export const SWITCH_WRITE_SCHEDULER = 'termpolis.writeScheduler'

/**
 * Hidden panes: '0' leaves an inactive pane with `visibility: hidden` alone, as 1.54.4 did, instead of also skipping its
 * rendering with `content-visibility: hidden`. xterm does not treat a `visibility: hidden` pane as hidden, so such a pane
 * painted every row as if it were the one on screen.
 */
export const SWITCH_HIDDEN_PANES = 'termpolis.hiddenPanes'

/**
 * Output routing: '0' gives every pane its own all-terminal output listener again (one `ipcRenderer.on` per pane, each
 * dropping the chunks of the other terminals after the context bridge) instead of one shared listener that hands a chunk to
 * the pane of its terminal. Main then sends the pane's terminal output as it did; the all-terminal API is untouched.
 */
export const SWITCH_DATA_ROUTING = 'termpolis.dataRouting'

/**
 * Per-pass side effects: '0' runs the whole per-chunk block (window slice, diff test, escape strips, prompt parse, agent
 * detection, compaction and session controllers, OSC 633, error pattern) for every chunk, as 1.54.4 did, instead of once per
 * pass over everything that arrived since the last one.
 */
export const SWITCH_PANE_EFFECTS = 'termpolis.paneEffects'

export function switchEnabled(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== '0'
  } catch {
    return true
  }
}
