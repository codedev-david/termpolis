// Auto-dismiss AI agent onboarding/trust prompts.
//
// When the user launches Claude Code / Codex / Gemini, each tool shows
// one or more blocking prompts on first run that Termpolis should answer
// automatically so users don't have to remember which key dismisses which
// tool's safety dialog.
//
// Patterns covered (per-tool):
//   Claude Code
//     - "Do you trust the files in this folder?"         -> arrow to the ❯ row
//       that says Yes, then Enter. NOT a bare Enter: Claude Code 2.1.x opens
//       this dialog focused on "No, exit", so Enter alone quits the session.
//     - MCP server trust — since Termpolis ships its own MCP server, first
//       launch always shows "Do you want to enable these MCP servers?"
//       With Termpolis we always want Yes -> Enter.
//     - "Claude Code may make mistakes..." onboard splash -> Enter
//     - generic "Press Enter to continue"                -> Enter
//   OpenAI Codex
//     - "Do you trust the files..."                      -> "1"  (Codex: 1 = Yes)
//     - "Select an option" / "Type 1 to..."              -> "1"
//   Gemini CLI
//     - "Accept the terms" / "Authenticate with"         -> Enter (default)
//
// This module is pure: no IPC, no state. Callers decide when to poll and how
// to track "already dismissed" so the same prompt isn't re-answered on every
// tick.

export interface DismissContext {
  agentName: string
}

/** Terminal key sequences that move an Ink select cursor. */
const KEY_DOWN = '\x1b[B'
const KEY_UP = '\x1b[A'

interface OptionRow {
  /** Index of the line this row was rendered on. */
  line: number
  /** Label with the box frame, the cursor marker and any "N." index removed. */
  label: string
  /** True when this row carries the ❯ cursor. */
  selected: boolean
}

/**
 * Pull the Yes/No rows of a trust dialog out of rendered TUI output.
 *
 * Rows are recognised by their LABEL — they start with "Yes" or "No", possibly
 * behind a "1." index — rather than by indentation. That matters because the
 * question line ("Do you trust the files in this folder?") also mentions
 * trusting a folder, and must never be mistaken for a selectable option.
 */
export function trustOptionRows(lines: string[]): OptionRow[] {
  const rows: OptionRow[] = []
  lines.forEach((raw, line) => {
    const framed = raw.replace(/^[\s│┃|╎┆]+/, '').replace(/[\s│┃|╎┆]+$/, '')
    const m = /^([❯>▶]?)\s*(?:\d+[.)]\s*)?((?:yes|no)\b.*)$/i.exec(framed)
    if (!m) return
    rows.push({ line, label: m[2].trim(), selected: m[1] !== '' })
  })
  return rows
}

/**
 * The most recent dialog frame in `rows`. Ink redraws the whole dialog on every
 * keystroke, so the tail can hold several frames whose cursor sat elsewhere;
 * only the last one that still shows a cursor describes what is on screen.
 *
 * A frame is a run of rows on CONSECUTIVE lines — that is how a select renders
 * its options. Anything looser merges an older frame into the current one and
 * makes the cursor position meaningless, and a misread cursor is the failure
 * this whole module exists to avoid.
 */
function lastDialogFrame(rows: OptionRow[]): OptionRow[] {
  const frames: OptionRow[][] = []
  for (const r of rows) {
    const cur = frames[frames.length - 1]
    if (cur && r.line - cur[cur.length - 1].line === 1) cur.push(r)
    else frames.push([r])
  }
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].some(r => r.selected)) return frames[i]
  }
  return []
}

/**
 * Keys that land on "Yes, I trust this folder" and accept it — or null when the
 * layout can't be read, in which case answering NOTHING is the correct move.
 *
 * Claude Code 2.1.x renders this dialog with `cancelFirst: true`,
 * `focus: "cancel"` and `hideIndexes: true`: the cursor opens on "No, exit" and
 * the numeric indexes are gone. A bare Enter therefore QUITS the session, which
 * is exactly what made a launch look "cut off". So read which row the ❯ is
 * actually on and walk to the affirmative row instead of assuming a position.
 */
export function trustDialogReply(tail: string): string | null {
  const frame = lastDialogFrame(trustOptionRows(tail.split('\n')))
  if (frame.length === 0) return null
  const cursor = frame.findIndex(r => r.selected)
  const yes = frame.findIndex(r => /^yes\b/i.test(r.label))
  if (cursor < 0 || yes < 0) return null
  if (yes === cursor) return '\r'
  return (yes > cursor ? KEY_DOWN : KEY_UP).repeat(Math.abs(yes - cursor)) + '\r'
}

// Strip ANSI escape codes (CSI/SGR/OSC) and normalize CRLF so regex patterns
// can match terminal output reliably. Without this, sequences like
// "\x1b[33mDo you trust\x1b[0m" silently fail to match "Do you trust".
function normalize(s: string): string {
  if (!s) return ''
  return s
    // CSI/SGR/cursor-control: ESC[ ... letter
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // OSC: ESC] ... BEL or ESC\
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Other ESC sequences with intermediate bytes
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\r\n/g, '\n')
}

export function detectDismissChar(rawTail: string, ctx: DismissContext): string | null {
  if (!rawTail) return null
  const tail = normalize(rawTail)
  if (!tail) return null
  const name = (ctx.agentName || '').toLowerCase()
  const isCodex = /codex/.test(name)
  const isGemini = /gemini/.test(name)
  const isClaude = /claude/.test(name)

  // 1. Folder trust prompts (all tools)
  //    Claude: "Do you trust the files in this folder?"
  //    Codex:  "Do you trust the files in this folder?"
  //    Gemini: sometimes shows "trust this folder" variant
  //    Newer Claude variants: "Would you like to trust", "Trust this workspace?"
  //    Claude is handled by reading the cursor rather than by a fixed key: since
  //    2.1.x its dialog opens focused on "No, exit", so the Enter this used to
  //    return quit the session instead of trusting the folder. The branch always
  //    RETURNS — falling through to the generic pattern 8 below would re-introduce
  //    that blind Enter. Trust is normally seeded in Claude's own config before
  //    launch (src/main/claudeTrust.ts), so an unreadable layout costs nothing.
  if (/do you trust the (?:files|authors)|trust this folder|trust the files|trust this workspace|would you like to trust|trust workspace folder/i.test(tail)) {
    if (isCodex) return '1\r'
    if (isClaude) return trustDialogReply(tail)
    return '\r'
  }

  // 2. MCP-server trust (Claude Code). Termpolis auto-registers its own MCP
  //    server, so Claude shows this prompt on first launch. Always answer Yes.
  //    Variants observed across Claude Code versions:
  //      "The following MCP servers are configured but not trusted"
  //      "Do you want to enable these MCP servers"
  //      "Approve MCP server" / "Trust the MCP server"
  //      "Enable MCP server"
  //      "Use this MCP server"
  if (/(?:approve|trust|enable|use)\s+(?:the\s+|these\s+|this\s+)?mcp(?:\s+server)?/i.test(tail)
    || /mcp servers? (?:are\s+)?configured but not trusted/i.test(tail)
    || /enable these mcp servers?/i.test(tail)) {
    return '\r' // default selection is "Yes"
  }

  // 3. Onboarding splash / acknowledgement screens — "Press Enter to continue"
  //    Claude's "Claude Code may make mistakes" notice, Gemini's welcome, etc.
  if (/press\s+(?:enter|return)\s+to\s+(?:continue|proceed|dismiss|begin|start)/i.test(tail)
    || /press any key to continue/i.test(tail)
    || /hit\s+(?:enter|return)\s+to/i.test(tail)) {
    return '\r'
  }

  // 4. Onboarding theme/style picker (Claude Code, Gemini). Newer Claude
  //    Code installs ask "Choose a color theme" / "Select your style" before
  //    the main prompt — accept the highlighted default with Enter.
  if (/choose\s+(?:a\s+)?(?:color\s+)?theme|select\s+(?:your\s+|a\s+)?(?:theme|style|color)|pick\s+(?:a\s+)?theme/i.test(tail)) {
    return '\r'
  }

  // 5. Onboarding "tell us about yourself" / login flow / auth method picker
  //    These all default to a sensible option — Enter accepts.
  if (/how would you like to (?:login|sign in|authenticate)|select.*(?:login|sign[\s-]?in|auth)\s+method|preferred (?:login|auth) method/i.test(tail)) {
    return '\r'
  }

  // 6. Generic Y/n prompt — pick Yes.
  if (/\[Y\/n\]|\(Y\/n\)/i.test(tail)) {
    return 'y\r'
  }

  // 7. Codex-specific — numbered option prompts (Codex uses "1" instead of Enter)
  if (isCodex && /select\s+(?:a[n]?\s+)?(?:option|choice)|type\s+1\s+to/i.test(tail)) {
    return '1\r'
  }

  // 8. Claude-specific — numbered "Select" with arrow indicator. Default
  //    selection (highlighted with ❯) is what we want; just press Enter.
  if (isClaude && /❯\s*\d+\.\s/.test(tail)) {
    return '\r'
  }

  // 9. Gemini-specific — onboarding auth menu
  if (isGemini && /accept\s+(?:the\s+)?terms|authenticate\s+with/i.test(tail)) {
    return '\r'
  }

  return null
}

// Helper: pick the last N chars of a string, which is the slice most likely
// to contain a live prompt (older output has scrolled past it).
export function tailSlice(output: string, size = 1500): string {
  if (!output) return ''
  if (output.length <= size) return output
  return output.slice(-size)
}
