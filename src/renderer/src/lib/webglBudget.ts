// Who gets a GPU context, when there are more terminals than the GPU will allow.
//
// TabView mounts EVERY non-hidden terminal at once, and each pane took a WebGL context
// at mount and held it until the terminal closed. Chromium allows roughly 16 live WebGL
// contexts per process and, past that, silently evicts the oldest — no exception, no
// console warning, nothing to catch. So opening a 17th terminal quietly stopped the
// first one from painting, and the only symptom was a terminal gone blank for no
// visible reason. This is a correctness bug before it is a performance one.
//
// The policy is deliberately NOT "only the visible pane gets a context". Creating a
// context costs real milliseconds, so releasing on every Alt+1..9 would trade a rare
// blank terminal for constant tab-switch jank — and a hidden pane that still holds its
// context costs nothing while the GPU has slots to spare. Instead: visible panes always
// hold one, hidden panes keep theirs until something else actually needs it, and the
// pane you looked at longest ago is the one asked to give it up.

/**
 * Well under Chromium's ~16, on purpose. The probe in webglSupport takes a context of
 * its own, and anything else in the app that wants one has to fit too — budgeting right
 * up to the cap would reintroduce the silent eviction this module exists to prevent.
 */
export const MAX_WEBGL_CONTEXTS = 8

export interface WebglPane {
  /** Attach the GPU renderer. May throw: a driver is free to refuse. */
  acquire: () => void
  /** Give the context back. */
  release: () => void
}

interface Entry {
  pane: WebglPane
  visible: boolean
  held: boolean
  /** Monotonic stamp of when this pane was last visible; higher is more recent. */
  seq: number
}

const panes = new Map<string, Entry>()
let clock = 0

/** Drop all bookkeeping and release every context. Exported for test isolation only. */
export function resetWebglBudget(): void {
  for (const entry of panes.values()) {
    if (entry.held) {
      try { entry.pane.release() } catch { /* going away regardless */ }
      entry.held = false
    }
  }
  panes.clear()
  clock = 0
}

function rebalance(): void {
  const entries = [...panes.values()]

  // Visible panes are being looked at right now; taking a context from one would blank
  // a terminal on screen, which is strictly worse than overshooting the budget. So they
  // are retained unconditionally and the budget applies to whatever room is left.
  const retained = new Set<Entry>()
  for (const e of entries) if (e.visible) retained.add(e)

  const slots = MAX_WEBGL_CONTEXTS - retained.size
  if (slots > 0) {
    // seq > 0 means "has been on screen at least once". Retention exists to stop tab
    // switching from thrashing the GPU, and that only applies to a pane you have
    // actually looked at. A terminal that has never been shown — a background agent, a
    // session restored at launch — costs nothing, so twenty of them starting up cannot
    // fill the budget speculatively and evict each other before you have seen one.
    const warm = entries.filter(e => !e.visible && e.seq > 0).sort((a, b) => b.seq - a.seq)
    for (const e of warm.slice(0, slots)) retained.add(e)
  }

  // Release before acquiring, so a context freed this pass is available to the pane
  // that is about to ask the driver for one.
  for (const e of entries) {
    if (e.held && !retained.has(e)) {
      try { e.pane.release() } catch { /* already gone — nothing to recover */ }
      e.held = false
    }
  }
  for (const e of entries) {
    if (!e.held && retained.has(e)) {
      // A driver that refuses leaves `held` false, so this pane is simply asked again
      // next time round rather than being recorded as owning a context it never got.
      try { e.pane.acquire(); e.held = true } catch { /* no context available */ }
    }
  }
}

/**
 * Put a pane under the budget's control. Registering does NOT grant a context — the
 * pane gets one when it first reports itself visible.
 *
 * Returns an unregister function.
 */
export function registerWebglPane(id: string, pane: WebglPane): () => void {
  panes.set(id, { pane, visible: false, held: false, seq: 0 })
  return () => {
    const entry = panes.get(id)
    if (!entry || entry.pane !== pane) return
    if (entry.held) {
      try { entry.pane.release() } catch { /* tearing down anyway */ }
      entry.held = false
    }
    panes.delete(id)
    rebalance()
  }
}

/** Report whether a pane is on screen. Drives every acquire and release. */
export function setWebglPaneVisible(id: string, visible: boolean): void {
  const entry = panes.get(id)
  if (!entry) return
  // Stamped on the way OUT of visible as well as in, so "least recently visible" means
  // the pane you left longest ago rather than the one you opened earliest.
  if (visible || entry.visible) entry.seq = ++clock
  entry.visible = visible
  rebalance()
}
