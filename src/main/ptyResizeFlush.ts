// ptyResizeFlush.ts
//
// What a terminal does with the output it is still holding when its pty changes size.
//
// WHY: output waits in two places between the pty and everything that reads it. The first is the 8 ms
// coalescer (ptyCoalescer.ts), after which it is in main's rolling buffer and on its way to the renderer.
// The second is the remote pump's 50 ms tick (remoteOutputPump.ts), after which it is on its way to a
// phone. Both hand bytes on with the size the terminal reports WHEN THEY ARE READ (the phone pump asks
// getTerminalSize as it sends), and resizeTerminal records the new size at once. A repaint the TUI drew
// for 120 columns that is still waiting when the pane shrinks to 80 is therefore emulated at 80: its
// cursor moves land on the wrong cells and the live region, the bottom quarter of the screen, comes out
// garbled. The phone harness measured it: 5 resize phases in 10 for a TUI that repaints every 100 ms and
// every phase for one that repaints every 50 ms (perf155 E1), and 0 in 10 once everything held was
// handed on first.
//
// So before the size changes, everything held is handed on: the terminal's own coalescer first (it emits
// into the rolling buffer and marks the terminal for the remote pump), then every reader registered here
// (the remote host reads its pump now, at the size the bytes were drawn for). The order matters: a reader
// can only read what the coalescer has already put in the buffer.
//
// This is a leaf on purpose. terminalManager must not import the remote host (that would drag the bridge
// supervisor and Electron's utility process into every terminal test), and the remote host must not
// import terminalManager (node-pty). They meet here.
//
// FAIL OPEN. Nothing in here may stop a resize. A flush or a hook that throws is swallowed and the resize
// goes ahead exactly as it did before this module existed, and TERMPOLIS_DISABLE_RESIZE_FLUSH=1 skips the
// whole step (today's order: record the new size, resize, flush nothing).

/** Set to 1 (or anything but 0 / false) to restore the order from before this module: no flush ahead of a
 *  resize, no hook run. Read on every resize, so it can be flipped without a restart in a test. */
export const DISABLE_FLAG = 'TERMPOLIS_DISABLE_RESIZE_FLUSH'

export function resizeFlushDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[DISABLE_FLAG]
  return !!v && v !== '0' && v.toLowerCase() !== 'false'
}

/** Read whatever is waiting for this terminal NOW. Called with the terminal's size still the old one. */
export type BeforeResizeHook = (terminalId: string) => void

const hooks = new Set<BeforeResizeHook>()

/** Register a reader to be run, at the terminal's old size, before any of its resizes. Returns the
 *  function that removes it. Registering the same function twice is one registration. */
export function onBeforeResize(hook: BeforeResizeHook): () => void {
  hooks.add(hook)
  return () => {
    hooks.delete(hook)
  }
}

/** Hand on everything held for a terminal whose size is about to change: `flushHeld` (its own coalescer)
 *  first, then every registered hook. Never throws, and does nothing at all when the kill switch is on. */
export function flushBeforeResize(terminalId: string, flushHeld: () => void): void {
  if (resizeFlushDisabled()) return
  try {
    flushHeld()
  } catch {
    // A consumer of the output threw (a closed window, say). The resize is not its business.
  }
  // A copy: a hook may remove itself, or add another, while the pass runs.
  for (const hook of [...hooks]) {
    try {
      hook(terminalId)
    } catch {
      // One reader's fault is not the next reader's, and not the resize's.
    }
  }
}
