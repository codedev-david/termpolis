// Mouse-tracking control for terminals.
//
// When a TUI app (Claude Code, vim, lazygit, htop…) sends a `CSI ? Pm h` DECSET for a
// mouse-tracking mode, xterm starts forwarding click/drag/scroll to the app — which
// means a normal click-drag no longer SELECTS text, so right-click → Copy has nothing
// to copy. For a tool built around reading AI output that's a bad default, so Termpolis
// can swallow those enables (keeping the mouse free for selection) behind a setting.
//
// 1000 = VT200 click, 1001 = highlight, 1002 = button/drag, 1003 = any-motion. The
// encoding modes (1005/1006/1015/1016) only change how an already-tracked event is
// reported and 1004 is focus in/out — none of those capture the mouse on their own, so
// suppressing the four trackers below is both necessary and sufficient.
export const MOUSE_TRACKING_MODES: ReadonlySet<number> = new Set([1000, 1001, 1002, 1003])

/**
 * Decide whether a `CSI ? … h` DECSET sequence should be swallowed to keep the mouse
 * free for text selection. Returns true only when EVERY mode in the sequence is a
 * mouse-tracking mode — a mixed sequence (e.g. a mouse mode alongside cursor
 * visibility) is left for xterm so the unrelated modes still apply.
 *
 * @param params the numeric DEC private mode params from xterm's CSI handler; a param
 *   may itself be a subparam array, in which case its leading value identifies the mode.
 */
export function suppressesMouseTracking(params: (number | number[])[]): boolean {
  if (params.length === 0) return false
  return params.every((p) => MOUSE_TRACKING_MODES.has(typeof p === 'number' ? p : p[0]))
}
