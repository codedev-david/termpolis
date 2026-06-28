import type { ITerminalOptions } from '@xterm/xterm'

/**
 * Windows PTY backend info handed to xterm.js via its `windowsPty` option. On
 * Windows the emulator must know whether it's driving ConPTY (and which OS
 * build) so its reflow + scrollback behavior matches the pty; otherwise a
 * heavy-redraw TUI like Claude Code's Ink UI desyncs and overlaps the prompt.
 * Sourced from the main process (see computeWindowsPty in terminalManager.ts)
 * via window.termpolis.platformInfo.
 */
export interface WindowsPtyInfo {
  backend: 'conpty' | 'winpty'
  buildNumber: number
}

export interface TerminalOptionsInput {
  theme: ITerminalOptions['theme']
  fontFamily: string
  fontSize: number
  scrollback: number
  /** null/undefined off Windows — leave xterm on its native Unix-pty reflow. */
  windowsPty?: WindowsPtyInfo | null
}

/**
 * Build the xterm.js Terminal constructor options. Kept pure (no DOM, no real
 * Terminal) so the windowsPty wiring — the fix for TUI output overlapping the
 * prompt on Windows — is unit-testable in isolation.
 */
export function buildTerminalOptions(input: TerminalOptionsInput): ITerminalOptions {
  const opts: ITerminalOptions = {
    theme: input.theme,
    fontFamily: input.fontFamily,
    fontSize: input.fontSize,
    cursorBlink: false,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    scrollback: input.scrollback,
  }
  // Windows only. Passing the ConPTY backend + build lets modern ConPTY
  // (Win11 >= 21376) use native wrap sequences for correct reflow, and turns on
  // xterm's scrollback heuristic that stops rows being replaced/lost on resize.
  // Left unset elsewhere so Unix ptys keep xterm's standard reflow.
  if (input.windowsPty) opts.windowsPty = input.windowsPty
  return opts
}
