/**
 * Holds a hidden pane's selection repaints until the pane is shown (1.54.5, hidden-pane suppression).
 *
 * `content-visibility: hidden` (paneHiding.ts) pauses xterm's renderer, and that stops the repaints that go through
 * `RenderService.refreshRows`. One path does not: xterm's SelectionService queues a refresh on EVERY scroll, selection
 * or not (Terminal: `onScroll -> selectionService.refresh()`), its frame fires `onRedrawRequest`, and
 * `RenderService.handleSelectionChanged` hands that straight to the renderer without checking `_isPaused`. The DOM
 * renderer answers with `renderRows(0, rows - 1)`. So a hidden pane taking output repainted its whole viewport once per
 * frame of writes. Measured in headless Chromium 148 with xterm 5.5 (a 24-row pane, 66 writes while hidden): 0 render
 * events, `_isPaused` true, and still 1,584 row mutations (24 x 66), every one from this call.
 *
 * While the pane is hidden this keeps only the LATEST selection change and replays it when the pane is shown, so the
 * selection state the renderer draws with is current before xterm's own full refresh on resume.
 *
 * xterm internals, read defensively like xtermPending.ts: an xterm without them gets no hold (null), never a throw.
 */
type SelectionArgs = [start: [number, number] | undefined, end: [number, number] | undefined, columnSelectMode: boolean]
type SelectionHandler = (...args: SelectionArgs) => void

export interface HiddenSelectionHold {
  /** Hidden: hold selection repaints. Shown: replay the last one held, if any. */
  setHidden(hidden: boolean): void
  /** Puts xterm's own handler back. Nothing held is replayed: the terminal is going away. */
  dispose(): void
}

export function holdHiddenSelectionRepaints(term: unknown): HiddenSelectionHold | null {
  const renderService = (term as { _core?: { _renderService?: { handleSelectionChanged?: unknown } } } | null | undefined)
    ?._core?._renderService
  if (!renderService || typeof renderService.handleSelectionChanged !== 'function') return null
  const service = renderService as { handleSelectionChanged: SelectionHandler }
  const original = service.handleSelectionChanged
  let hidden = false
  let held: SelectionArgs | null = null
  const wrapper: SelectionHandler = (...args) => {
    if (hidden) { held = args; return }
    original.apply(service, args)
  }
  service.handleSelectionChanged = wrapper
  return {
    setHidden(next) {
      hidden = next
      if (next || !held) return
      const args = held
      held = null
      original.apply(service, args)
    },
    dispose() {
      held = null
      hidden = false
      if (service.handleSelectionChanged === wrapper) service.handleSelectionChanged = original
    },
  }
}
