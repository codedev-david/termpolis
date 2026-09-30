// Auto-dismiss AI agent onboarding/trust prompts.
//
// When the user launches Claude Code / Codex / Gemini, each tool shows
// one or more blocking prompts on first run that Termpolis should answer
// automatically so users don't have to remember which key dismisses which
// tool's safety dialog.
//
// Patterns covered (per-tool):
//   Folder trust — answered ONLY when the caller passes allowFolderTrust: true
//   (the user connected the agents, and neither the folder nor its git root is
//   the home folder or a drive root). Otherwise the prompt is the user's, and no
//   later pattern may answer it either.
//     - Claude Code "Do you trust the files in this folder?", Codex "Do you
//       trust the contents of this directory?" and Gemini CLI "Do you trust this
//       folder?" -> arrow to the row that trusts THIS folder (Yes / Trust folder),
//       then Enter. Never a bare Enter: Claude Code 2.1.x opens this dialog
//       focused on "No, exit", so Enter alone quits the session.
//     - Still left to the user: a dialog whose rows can't be read, one saying the
//       folder brings its own permissions, and one whose Enter does more than
//       trust ("Press enter to continue and create a sandbox").
//   Onboarding screens that decide nothing
//     - "Claude Code may make mistakes..." splash, "Press Enter to continue"
//       -> Enter. Never "Press Enter to continue and <do something>", and never
//       while a menu or a live session is on screen.
//     - theme picker, login-method picker                -> Enter (default)
//     - Gemini "Accept the terms" / "Authenticate with"  -> Enter (default)
//
// Never answered: a tool-permission or approval prompt, an MCP-server approval
// (servers in a project's .mcp.json come with the repo), a [Y/n] question, or any
// other numbered choice. Those decide what an agent may do, so they belong to the
// user — and one on screen stops every pattern here, so stale text further up the
// buffer can't answer it either. The pollers in App.tsx run for the whole life of
// an agent terminal, which is why a pattern here must only ever match a screen
// that decides nothing.
//
// This module is pure: no IPC, no state. Callers decide when to poll and how
// to track "already dismissed" so the same prompt isn't re-answered on every
// tick.

export interface DismissContext {
  agentName: string
  /** True only when Termpolis may answer a folder-trust prompt for this terminal's folder
   *  (main's `agents:folder-trust-allowed`). Missing or false leaves the prompt to the user. */
  allowFolderTrust?: boolean
}

/** Terminal key sequences that move an Ink select cursor. */
const KEY_DOWN = '\x1b[B'
const KEY_UP = '\x1b[A'

/**
 * Prompts that approve something an agent is about to do, or grant it a standing
 * permission. One of these ANYWHERE in the tail stops every pattern below: a stale
 * "Press Enter to continue" further up would otherwise press Enter on it.
 */
const APPROVAL_PROMPTS: RegExp[] = [
  // Claude Code tool permissions, Gemini CLI confirmations
  /\bdo\s+you\s+want\s+to\s+(?:proceed|make\s+th(?:is|ese)\s+edits?|create|allow|run|apply|delete|overwrite|execute|use\s+this)\b/i,
  // Codex approvals, Claude Code's plan-mode exit
  /\bwould\s+you\s+like\s+to\s+(?:proceed|run|make|grant|send|allow|apply|execute|continue)\b/i,
  // Rows that grant a standing permission, or turn one down with instructions
  /\bdon['’]?t\s+ask\s+again\b/i,
  /\bwhat\s+to\s+do\s+differently\b/i,
  /\ballow\s+(?:codex|claude|gemini)\b/i,
  /\ballow\s+(?:once|always|execution|all\s+edits|for\s+this\s+session|this\s+(?:command|edit|action|request))\b/i,
  /\bapply\s+this\s+change\b/i,
  /\b(?:requires|needs|awaiting)\s+(?:your\s+)?(?:approval|permission)\b/i,
  /\bbypass\s+permissions\b/i,
  // MCP servers, including the ones a repo brings along in .mcp.json
  /\bnew\s+mcp\s+servers?\s+found\b/i,
  /\bmcp\s+servers?\s+(?:are\s+)?configured\s+but\s+not\s+trusted\b/i,
  /\b(?:approve|enable|use|trust)\s+(?:the\s+|these\s+|this\s+)?(?:and\s+all\s+future\s+)?mcp\b/i,
  // Claude Code's offer to rewrite the terminal's own settings
  /\bterminal\s+setup\?/i,
  // Any yes/no question
  /[[(]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[\])]/i,
]

const FOLDER_TRUST = /do\s+you\s+trust\s+the\s+(?:files|authors|contents)|trust\s+this\s+(?:folder|workspace|directory)|trust\s+the\s+files|would\s+you\s+like\s+to\s+trust|trust\s+workspace\s+folder/i

/** "Press enter to continue and create a sandbox": Enter would do more than trust the folder. */
const ENTER_DOES_MORE = /\b(?:press|hit)\s+(?:enter|return)\s+to\s+\w+\s+and\b/i

/** Claude Code's "No, continue without these permissions": the folder brings its own
 *  permissions (a repo's .claude/settings.json), and trusting it would accept them. */
const FOLDER_BRINGS_PERMISSIONS = /\bthese\s+permissions\b/i

const PRESS_ENTER = /\b(?:press|hit)\s+(?:enter|return)\s+to\s+(?:continue|proceed|dismiss|begin|start)\b(?!\s+(?:and|with)\b)|\bpress\s+any\s+key\s+to\s+continue\b/i

/** How far from the end of the tail a splash that is still on screen may sit. */
const RECENT_LINES = 8
/** Non-blank lines a dialog that is still on screen may be followed by (its key hints). */
const MAX_LINES_AFTER_DIALOG = 4

/**
 * A line that opens with a selection cursor or radio (❯ Claude Code, › Codex,
 * ● ○ Gemini CLI), a session prompt (>) or a transcript bullet (⏺ ● Claude Code,
 * ✦ Gemini CLI). Near the end of the tail it means Enter would pick a menu row or
 * send the user's draft rather than dismiss anything.
 */
const MARKED_LINE = /^[❯›>▶●◉○◯⏺✦](?:\s|$)/

/** The row that trusts THIS folder: Claude's and Codex's "Yes…", Gemini's "Trust folder". */
const AFFIRMATIVE = /^(?:yes\b|trust\s+(?:this\s+)?folder\b)/i

interface OptionRow {
  /** Index of the line this row was rendered on. */
  line: number
  /** Label with the box frame, the cursor marker and any "N." index removed. */
  label: string
  /** True when this row carries the cursor. */
  selected: boolean
}

/** A line without the box frame an Ink dialog may be drawn in. */
function unframed(raw: string): string {
  return raw.replace(/^[\s│┃|╎┆]+/, '').replace(/[\s│┃|╎┆]+$/, '')
}

/**
 * Pull the option rows of a trust dialog out of rendered TUI output.
 *
 * Rows are recognised by their LABEL — "Yes…"/"No…", or Gemini's "Trust folder",
 * "Trust parent folder" and "Don't trust", possibly behind a "1." index — rather
 * than by indentation. That matters because the question line ("Do you trust the
 * files in this folder?") also mentions trusting a folder, and must never be
 * mistaken for a selectable option.
 */
export function trustOptionRows(lines: string[]): OptionRow[] {
  const rows: OptionRow[] = []
  lines.forEach((raw, line) => {
    // ❯ is Claude Code's cursor, › Codex's, ● Gemini CLI's selected radio and ○ an unselected one.
    const m = /^([❯›>▶●◉○◯]?)\s*(?:\d+[.)]\s*)?((?:yes|no|trust\s+(?:this\s+|parent\s+)?folder|don['’]?t\s+trust)\b.*)$/i.exec(unframed(raw))
    if (!m) return
    rows.push({ line, label: m[2].trim(), selected: m[1] !== '' && !/[○◯]/.test(m[1]) })
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
 * Keys that land on the row trusting this folder and accept it — or null when
 * the layout can't be read, in which case answering NOTHING is the correct move.
 *
 * Claude Code 2.1.x renders this dialog with `cancelFirst: true`,
 * `focus: "cancel"` and `hideIndexes: true`: the cursor opens on "No, exit" and
 * the numeric indexes are gone. A bare Enter therefore QUITS the session, which
 * is exactly what made a launch look "cut off". So read which row the cursor is
 * actually on and walk to the affirmative row instead of assuming a position.
 */
export function trustDialogReply(tail: string): string | null {
  const lines = tail.split('\n')
  const frame = lastDialogFrame(trustOptionRows(lines))
  if (frame.length === 0) return null
  // A dialog still on screen was drawn last, followed at most by its key hints.
  // More output after it, the session's own prompt, or a lone cursor from a
  // partial redraw all mean the keys would land somewhere this frame doesn't show.
  const after = lines.slice(frame[frame.length - 1].line + 1).map(unframed).filter(Boolean)
  if (after.length > MAX_LINES_AFTER_DIALOG || after.some(l => MARKED_LINE.test(l))) return null
  const cursor = frame.findIndex(r => r.selected)
  const yes = frame.findIndex(r => AFFIRMATIVE.test(r.label))
  if (yes < 0) return null
  if (yes === cursor) return '\r'
  return (yes > cursor ? KEY_DOWN : KEY_UP).repeat(Math.abs(yes - cursor)) + '\r'
}

// Strip ANSI escape codes (CSI/SGR/OSC) and normalize CRLF so regex patterns
// can match terminal output reliably. Without this, sequences like
// "\x1b[33mDo you trust\x1b[0m" silently fail to match "Do you trust".
function normalize(s: string): string {
  return s
    // A cursor jump to another row starts a new line, and a jump right is a gap.
    // TUIs that paint by position (Codex's ratatui, ConPTY repainting a Windows
    // console) send no newline or space at all, so deleting these would glue rows
    // and words together.
    .replace(/\x1b\[[0-9;]*[Hf]|\x1b\[[0-9]*[dEF]/g, '\n')
    .replace(/\x1b\[[0-9]*C/g, ' ')
    // Other CSI/SGR/cursor-control: ESC[ ... letter
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
  const isGemini = /gemini/.test((ctx.agentName || '').toLowerCase())

  // 0. An approval or permission prompt belongs to the user, wherever it sits.
  if (APPROVAL_PROMPTS.some(p => p.test(tail))) return null

  // 1. Folder trust prompts (all tools)
  //    Claude: "Do you trust the files in this folder?" / "Yes, I trust this folder"
  //    Codex:  "Do you trust the contents of this directory?"
  //    Gemini: "Do you trust this folder?"
  //    Newer Claude variants: "Would you like to trust", "Trust this workspace?"
  //    The rows are read rather than assumed: since 2.1.x Claude's dialog opens
  //    focused on "No, exit", so the Enter this used to return quit the session
  //    instead of trusting the folder. The branch always RETURNS — falling through
  //    would let the "Press Enter" pattern below answer a trust screen by its
  //    footer. Trust is normally seeded in Claude's own config before launch
  //    (src/main/claudeTrust.ts), so an unreadable layout costs nothing.
  if (FOLDER_TRUST.test(tail)) {
    if (ctx.allowFolderTrust !== true) return null
    if (ENTER_DOES_MORE.test(tail) || FOLDER_BRINGS_PERMISSIONS.test(tail)) return null
    return trustDialogReply(tail)
  }

  // 2. Onboarding splash / acknowledgement screens — "Press Enter to continue"
  //    Claude's "Claude Code may make mistakes" notice, Gemini's welcome, etc.
  //    Only while it is the last thing drawn and no menu or session prompt is:
  //    Enter there would pick a row or send the user's draft.
  const recent = tail.split('\n').map(unframed).filter(Boolean).slice(-RECENT_LINES)
  if (PRESS_ENTER.test(recent.join('\n')) && !recent.some(l => MARKED_LINE.test(l))) {
    return '\r'
  }

  // 3. Onboarding theme/style picker (Claude Code, Gemini). Claude Code asks
  //    "Choose the text style that looks best with your terminal" before the
  //    main prompt — accept the highlighted default with Enter.
  if (/choose\s+(?:a\s+|the\s+)?(?:color\s+|text\s+)?(?:theme|style)|select\s+(?:your\s+|a\s+)?(?:theme|style|color)|pick\s+(?:a\s+)?theme/i.test(tail)) {
    return '\r'
  }

  // 4. Onboarding login flow / auth method picker
  //    These all default to a sensible option — Enter accepts.
  if (/how\s+would\s+you\s+like\s+to\s+(?:login|sign\s+in|authenticate)|select.*(?:login|sign[\s-]?in|auth)\s+method|preferred\s+(?:login|auth)\s+method/i.test(tail)) {
    return '\r'
  }

  // 5. Gemini-specific — onboarding auth menu
  if (isGemini && /accept\s+(?:the\s+)?terms|authenticate\s+with/i.test(tail)) {
    return '\r'
  }

  return null
}

/**
 * detectDismissChar for a live terminal. `mayTrustFolder` is asked only when the
 * answer turns on it — a folder-trust dialog is what's on screen — and anything
 * short of a plain yes (a no, an error, a missing API) leaves the dialog to the user.
 */
export async function dismissReply(
  tail: string,
  agentName: string,
  mayTrustFolder: () => Promise<boolean>,
): Promise<string | null> {
  const reply = detectDismissChar(tail, { agentName })
  const trusting = detectDismissChar(tail, { agentName, allowFolderTrust: true })
  if (trusting === reply) return reply
  const allowed = await Promise.resolve().then(mayTrustFolder).catch(() => false)
  return allowed === true ? trusting : reply
}

/** What a poller remembers a screen by, so it judges each one once: its last 200 chars. */
export function screenKey(output: string): string {
  return (output ?? '').slice(-200)
}

/**
 * The keys a poller should send for the screen `output` ends on, or null. The consent
 * lookup is async, so before answering the screen is read again and must be unchanged:
 * if the user answered the dialog in the meantime, the reply would land in their
 * composer, where the Enter could submit what they had started typing.
 */
export async function replyToScreen(
  output: string,
  agentName: string,
  mayTrustFolder: () => Promise<boolean>,
  readScreen: () => Promise<string | null>,
): Promise<string | null> {
  const reply = await dismissReply(tailSlice((output ?? '').slice(-3000)), agentName, mayTrustFolder)
  if (!reply) return null
  const now = await Promise.resolve().then(readScreen).catch(() => null)
  return typeof now === 'string' && screenKey(now) === screenKey(output) ? reply : null
}

/**
 * True while the tail shows something waiting for the user's answer: an approval or
 * permission prompt, a folder-trust dialog, a Yes/No list with a cursor on it, or a
 * screen the pollers would press Enter on. Code that types into an agent on its own
 * (the memory pointer, which goes in with an Enter) checks this first, because that
 * Enter would answer the prompt. Errs toward true — a false alarm only holds a paste back.
 */
export function isAwaitingAnswer(rawTail: string): boolean {
  if (!rawTail) return false
  const tail = normalize(rawTail)
  if (APPROVAL_PROMPTS.some(p => p.test(tail)) || FOLDER_TRUST.test(tail)) return true
  // Two or more rows: a reply line that starts with "No", or Codex echoing a message the
  // user began with "yes", is one row, and neither is a dialog.
  if (lastDialogFrame(trustOptionRows(tail.split('\n').slice(-RECENT_LINES))).length > 1) return true
  // Anything the pollers would answer themselves is waiting for an answer too — asked as
  // Gemini so its onboarding screens count as well.
  return detectDismissChar(rawTail, { agentName: 'gemini', allowFolderTrust: true }) !== null
}

// Helper: pick the last N chars of a string, which is the slice most likely
// to contain a live prompt (older output has scrolled past it).
export function tailSlice(output: string, size = 1500): string {
  if (!output) return ''
  if (output.length <= size) return output
  return output.slice(-size)
}
