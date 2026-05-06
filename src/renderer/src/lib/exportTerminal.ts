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

// Cleaned plain-text body shared by all formatters: strip ANSI, reflow
// soft wraps, drop trailing whitespace per line, and trim outer blank lines.
function cleanForExport(text: string, cols: number): string {
  return reflowSoftWraps(stripAnsi(text), cols)
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

// Write a code block to the clipboard in BOTH text/html and text/plain so
// rich-text targets (Teams, Outlook) get a real code box and plain-text
// targets (Slack compose, GitHub MD source, terminals) get the markdown
// fence. Falls back to plain-text-only when ClipboardItem isn't available
// (e.g. older browsers / jsdom test envs).
export async function writeCodeBlockToClipboard(text: string, cols: number): Promise<void> {
  const plain = formatAsCodeBlock(text, cols)
  const html = formatAsCodeBlockHtml(text, cols)
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
