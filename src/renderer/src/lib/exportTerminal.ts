export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')       // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b[()][0-9A-B]/g, '')                   // Character set selection
    .replace(/\x1b[\x20-\x2f]*[\x40-\x7e]/g, '')       // Other escape sequences
}

export function extractBuffer(terminal: { buffer: { active: { length: number; getLine: (i: number) => { translateToString: (trim?: boolean) => string } | undefined } } }): string {
  const buf = terminal.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    if (line) lines.push(line.translateToString(true))
  }
  return stripAnsi(lines.join('\n'))
}

export function generateFilename(terminalName: string): string {
  const date = new Date()
  const ts = date.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safe = terminalName.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${safe}_${ts}.txt`
}

// Reflow soft-wrapped lines: xterm wraps at the terminal column width, but a
// line that wraps physically at exactly `cols` characters is almost always one
// logical line that the user wants preserved when pasting into Slack/Teams.
// Pure logical newlines come through as their own line, shorter than `cols`.
//
// NOTE: This is a heuristic fallback. xterm trims trailing whitespace before
// returning a selection, so a wrapped line that ended in spaces shows up as
// fewer than `cols` chars and slips through as a hard break — pasting into
// Teams/Slack then produces "hard returns in weird places". Prefer
// `extractSelectionWithLogicalNewlines(term)` below, which uses
// `BufferLine.isWrapped` to know exactly which newlines were physical.
export function reflowSoftWraps(text: string, cols: number): string {
  if (!cols || cols < 20) return text
  const lines = text.split('\n')
  const out: string[] = []
  let buf = ''
  for (const line of lines) {
    buf += line
    // If the line filled the terminal exactly, it's almost certainly soft-wrap
    // and continues on the next line — keep buffering. Trailing spaces in the
    // raw extract are real (xterm pads), so trimEnd before measuring wouldn't
    // be safe.
    if (line.length === cols) continue
    out.push(buf)
    buf = ''
  }
  if (buf) out.push(buf)
  return out.join('\n')
}

// Minimal subset of the xterm.js Terminal interface we need to walk the buffer
// and recover logical newlines for a user selection. Defined here (rather than
// importing xterm types) so this module stays a pure utility we can unit-test
// with a fake terminal — no jsdom or DOM required.
export interface TerminalBufferLineLike {
  isWrapped: boolean
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}
export interface TerminalLike {
  cols: number
  getSelection(): string
  getSelectionPosition?(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined
  buffer: { active: { getLine(y: number): TerminalBufferLineLike | undefined } }
}

// Walk the xterm buffer using `BufferLine.isWrapped` to rebuild the selection
// with ONLY logical newlines. A line whose successor reports `isWrapped: true`
// is a physical/soft wrap and gets joined to the next line; everything else is
// a real \n the user typed. This is the fix for the "Teams paste introduces
// hard returns at random places" symptom — we no longer have to guess from
// line length whether a break was soft or hard.
//
// Trailing whitespace handling: when a line WILL wrap into the next, we keep
// trailing whitespace because that whitespace IS the inter-word boundary
// ("abcd efgh " wraps to "ijkl" → joined "abcd efgh ijkl", not "abcd efghijkl").
// When a line stands alone (no wrap continuation), trailing whitespace is
// padding from xterm and gets trimmed.
export function extractSelectionWithLogicalNewlines(term: TerminalLike): string {
  const range = term.getSelectionPosition?.()
  const fallback = term.getSelection() ?? ''
  if (!range) return fallback
  const buf = term.buffer?.active
  if (!buf) return fallback
  const parts: string[] = []
  let cur = ''
  for (let y = range.start.y; y <= range.end.y; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    const startX = y === range.start.y ? range.start.x : 0
    const endX = y === range.end.y ? range.end.x : term.cols
    const willWrap = y < range.end.y && !!buf.getLine(y + 1)?.isWrapped
    cur += line.translateToString(!willWrap, startX, endX)
    if (willWrap) continue
    parts.push(cur)
    cur = ''
  }
  if (cur) parts.push(cur)
  return parts.join('\n')
}

// Cleaned plain-text body shared by all formatters: strip ANSI, reflow
// soft wraps, drop trailing whitespace per line, and trim outer blank lines.
function cleanForExport(text: string, cols: number): string {
  return reflowSoftWraps(stripAnsi(text), cols)
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '')
}

// Buffer-aware variant: skips the cols-length heuristic because the extractor
// has already produced one string per logical line.
function cleanForExportFromTerm(term: TerminalLike): string {
  return stripAnsi(extractSelectionWithLogicalNewlines(term))
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '')
}

// Format terminal selection for pasting into Slack / Teams / GitHub. Strips
// ANSI, reflows soft wraps, trims trailing blank lines, and wraps in a
// triple-backtick fence so the destination chat client renders it as code.
// Adds an explicit `text` language hint to stop Teams' aggressive
// language-auto-detection (it loves picking SQL otherwise).
export function formatAsCodeBlock(text: string, cols: number): string {
  return '```text\n' + cleanForExport(text, cols) + '\n```'
}

// HTML form of the code block. Teams, Outlook, Word, and most rich-text
// editors honor a pasted <pre><code> block and render it as a real code box
// with newlines preserved — bypassing both the SQL auto-detect and the
// "every \n is a paragraph break" problem you hit with markdown-in-plaintext.
export function formatAsCodeBlockHtml(text: string, cols: number): string {
  const escaped = cleanForExport(text, cols)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return (
    '<pre style="font-family:Consolas,Menlo,Monaco,\'Courier New\',monospace;'
    + 'background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:6px;'
    + 'white-space:pre;line-height:1.4;font-size:13px;'
    + 'border:1px solid #3c3c3c;overflow-x:auto;">'
    + '<code>' + escaped + '</code></pre>'
  )
}

// Format terminal selection as plain text — strip ANSI and reflow soft wraps,
// but no fencing. Use for paste targets that don't render markdown.
export function formatAsPlainText(text: string, cols: number): string {
  return cleanForExport(text, cols)
}

// =====================================================
// Buffer-aware variants — use these when you have the xterm Terminal handle.
// They use BufferLine.isWrapped to recover logical newlines exactly, which
// fixes the Teams/Slack "hard returns in weird places" symptom that the
// cols-length heuristic in cleanForExport can't always nail.
// =====================================================

export function formatAsCodeBlockFromTerm(term: TerminalLike): string {
  return '```text\n' + cleanForExportFromTerm(term) + '\n```'
}

export function formatAsCodeBlockHtmlFromTerm(term: TerminalLike): string {
  const escaped = cleanForExportFromTerm(term)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return (
    '<pre style="font-family:Consolas,Menlo,Monaco,\'Courier New\',monospace;'
    + 'background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:6px;'
    + 'white-space:pre;line-height:1.4;font-size:13px;'
    + 'border:1px solid #3c3c3c;overflow-x:auto;">'
    + '<code>' + escaped + '</code></pre>'
  )
}

export function formatAsPlainTextFromTerm(term: TerminalLike): string {
  return cleanForExportFromTerm(term)
}

// =====================================================
// Message form — for pasting into a Teams/Slack *message*, NOT a code box.
// The three prior attempts all shipped a <pre><code> code box; that is not what
// a chat message wants. This form pastes as normal message text: emojis render,
// line breaks stay tight (no big paragraph gaps), indentation/columns are
// preserved, and it is NOT a grey code box. Validated by real paste into Teams
// and Slack before shipping.
//
// The recipe — this is the exact part every prior attempt got wrong:
//   - newlines                     -> <br>     (tight breaks; never <p>/<div>,
//                                               which are what caused the big gaps)
//   - leading spaces + runs of 2+  -> &nbsp;   (survives chat clients that collapse
//                                               whitespace; single interior spaces
//                                               stay breakable so long lines wrap)
//   - NO <pre>, NO <code>          (so neither Teams nor Slack turns it into a box)
//   - unboxed monospace span       (alignment where the target honors the font;
//                                    degrades gracefully otherwise)
//   - emojis pass through as literal unicode
// The font-family lives ONLY inside this clipboard payload — it does not touch
// the terminal font, the text/plain half, or any other copy action.
// =====================================================

const MESSAGE_HTML_FONT = "Consolas,Menlo,Monaco,'Courier New',monospace"

// A line that begins a new structural block (list item, ordered item, markdown
// heading) always starts its own logical line — it is never a wrap-continuation
// of the line above, even when that line ran to the wrap edge.
function startsStructuralBlock(line: string): boolean {
  return /^\s*([-*•‣◦·]|\d+[.)]|#{1,6}\s)/.test(line)
}

function firstWordLength(line: string): number {
  const m = /^\s*(\S+)/.exec(line)
  return m ? m[1].length : 0
}

// Un-wrap an agent's own word-wrapping so a copied selection pastes as flowing
// text instead of hard returns mid-sentence.
//
// WHY THIS EXISTS: agent CLIs (Claude Code, Codex, Gemini — all Ink-based
// TUIs) wrap their output to the pane width THEMSELVES and commit each visual
// line with a real newline. xterm therefore never sets `isWrapped` on the
// continuation rows, so `extractSelectionWithLogicalNewlines` (which trusts
// `isWrapped`) can't rejoin them — every wrap becomes a hard break on paste.
// Ordinary shell output that FLOWS past the margin is soft-wrapped by the
// terminal, gets `isWrapped=true`, and is already handled; this is only for the
// agent-TUI case, which is what users actually copy.
//
// THE TEST (word-boundary, width-aware): row B is a wrap-continuation of row A
// only if B's first word could NOT have fit on the end of A —
// `len(A) + 1 + len(firstWord(B)) > cols`. If it WOULD have fit, A ended
// deliberately short, so the break is real and kept. This self-corrects for the
// ragged right edge of word wrap and, crucially, leaves genuinely short lines
// alone: code, table rows, and short list items never reach the wrap width, so
// they are never joined. Blank lines and new list/heading markers always break.
export function reflowForMessage(lines: string[], cols: number): string[] {
  const wrapWidth = cols && cols >= 20 ? cols : 80
  const out: string[] = []
  let cur = ''
  let lastRowLen = 0 // display width of the last PHYSICAL row folded into `cur`
  const flush = (): void => {
    if (cur !== '') {
      out.push(cur)
      cur = ''
    }
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '') // keep leading indent, drop trailing pad
    if (line.trim() === '') {
      flush()
      out.push('')
      continue
    }
    if (cur === '' || startsStructuralBlock(line)) {
      flush()
      cur = line
      lastRowLen = line.length
      continue
    }
    if (lastRowLen + 1 + firstWordLength(line) > wrapWidth) {
      // The next word wouldn't have fit on the previous row → it was wrapped.
      cur = cur + ' ' + line.replace(/^\s+/, '')
      lastRowLen = line.length
    } else {
      // The previous row ended short → a real line break the user wants kept.
      flush()
      cur = line
      lastRowLen = line.length
    }
  }
  flush()
  return out
}

// Message-form plain text: the buffer-aware logical-line extract, then reflowed
// to undo the agent's word-wrapping (see reflowForMessage). Collapses 3+ blank
// lines to a single paragraph gap.
function messageTextFromTerm(term: TerminalLike): string {
  const lines = cleanForExportFromTerm(term).split('\n')
  return reflowForMessage(lines, term.cols).join('\n').replace(/\n{3,}/g, '\n\n')
}

// Encode significant whitespace on a single (already HTML-escaped) line: leading
// spaces, and any run of 2+ interior spaces, become &nbsp; so the destination
// chat client can't collapse them. Single interior spaces are left as ordinary
// breakable spaces so long prose lines still wrap instead of overflowing.
function encodeSignificantSpaces(escapedLine: string): string {
  const leadLen = escapedLine.length - escapedLine.replace(/^ +/, '').length
  const lead = '&nbsp;'.repeat(leadLen)
  const rest = escapedLine.slice(leadLen).replace(/ {2,}/g, (run) => '&nbsp;'.repeat(run.length))
  return lead + rest
}

// Turn cleaned plain text into message-form HTML (see section header). Exported
// so it can be unit-tested without a Terminal handle.
export function toMessageHtml(text: string): string {
  const body = text
    .replace(/\t/g, '    ')
    .split('\n')
    .map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .map(encodeSignificantSpaces)
    .join('<br>')
  return `<span style="font-family:${MESSAGE_HTML_FONT}">${body}</span>`
}

// Buffer-aware message-form plain text for a live selection — reflowed so an
// agent's wrapped output pastes as flowing lines. Use this as the text/plain
// half of the message copy (Slack reads it), paired with the HTML below.
export function formatAsMessagePlainTextFromTerm(term: TerminalLike): string {
  return messageTextFromTerm(term)
}

// Buffer-aware message-form HTML for a live selection. Reflows the agent's
// word-wrapping (see reflowForMessage) so paragraphs paste as one <br>-free
// flowing line each. Pair with formatAsMessagePlainTextFromTerm(term) as the
// text/plain half so Slack (plain) and Teams (html) each get flowing text.
export function formatAsMessageHtmlFromTerm(term: TerminalLike): string {
  return toMessageHtml(messageTextFromTerm(term))
}

// Write a code block to the clipboard in BOTH text/html and text/plain so
// rich-text targets (Teams, Outlook) get a real code box and plain-text
// targets (Slack compose, GitHub MD source, terminals) get the markdown
// fence. Falls back to plain-text-only when ClipboardItem isn't available
// (e.g. older browsers / jsdom test envs).
export async function writeCodeBlockToClipboard(text: string, cols: number): Promise<void> {
  const plain = formatAsCodeBlock(text, cols)
  const html = formatAsCodeBlockHtml(text, cols)
  await writeBothClipboardForms(plain, html)
}

// Buffer-aware variant — use when you have the Terminal handle. Uses
// `isWrapped` for accurate logical newlines.
export async function writeCodeBlockToClipboardFromTerm(term: TerminalLike): Promise<void> {
  const plain = formatAsCodeBlockFromTerm(term)
  const html = formatAsCodeBlockHtmlFromTerm(term)
  await writeBothClipboardForms(plain, html)
}

async function writeBothClipboardForms(plain: string, html: string): Promise<void> {
  const w = typeof window !== 'undefined' ? (window as unknown as { ClipboardItem?: typeof ClipboardItem }) : undefined
  if (w?.ClipboardItem && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new w.ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        }),
      ])
      return
    } catch {
      // fall through to plain-text writer
    }
  }
  await navigator.clipboard.writeText(plain)
}
