import { describe, it, expect } from 'vitest'
import { buildTerminalOptions } from '../../src/renderer/src/lib/terminalOptions'

// buildTerminalOptions is the pure seam that wires the Windows `windowsPty`
// option into the xterm.js Terminal. windowsPty is what stops a heavy-redraw TUI
// (Claude Code's Ink UI) from desyncing and overlapping the prompt on Windows,
// where ConPTY wraps lines and repaints differently than a Unix pty.
describe('buildTerminalOptions', () => {
  const base = {
    theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
    fontFamily: 'monospace',
    fontSize: 14,
    scrollback: 10000,
  }

  it('carries the core xterm options through unchanged', () => {
    const opts = buildTerminalOptions(base)
    expect(opts).toMatchObject({
      theme: base.theme,
      fontFamily: 'monospace',
      fontSize: 14,
      scrollback: 10000,
      cursorBlink: false,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
    })
  })

  it('enables allowProposedApi so the in-terminal find bar works', () => {
    // @xterm/addon-search highlights matches via term.registerDecoration(), which
    // xterm gates behind allowProposedApi. Without it findNext() throws, the search
    // handlers swallow it, and typing in the find bar silently does nothing.
    expect(buildTerminalOptions(base).allowProposedApi).toBe(true)
  })

  it('omits windowsPty when none is supplied (Unix / unknown platform)', () => {
    expect('windowsPty' in buildTerminalOptions(base)).toBe(false)
    expect('windowsPty' in buildTerminalOptions({ ...base, windowsPty: null })).toBe(false)
  })

  it('sets windowsPty when supplied so xterm matches ConPTY reflow + scrollback', () => {
    const opts = buildTerminalOptions({ ...base, windowsPty: { backend: 'conpty', buildNumber: 22631 } })
    expect(opts.windowsPty).toEqual({ backend: 'conpty', buildNumber: 22631 })
  })
})
