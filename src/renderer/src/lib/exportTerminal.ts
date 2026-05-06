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

// Format terminal selection for pasting into Slack / Teams / GitHub. Strips
// ANSI, reflows soft wraps, trims trailing blank lines, and wraps in a
// triple-backtick fence so the destination chat client renders it as code.
export function formatAsCodeBlock(text: string, cols: number): string {
  const cleaned = reflowSoftWraps(stripAnsi(text), cols).replace(/[ \t]+$/gm, '')
  const trimmed = cleaned.replace(/^\n+|\n+$/g, '')
  return '```\n' + trimmed + '\n```'
}

// Format terminal selection as plain text — strip ANSI and reflow soft wraps,
// but no fencing. Use for paste targets that don't render markdown.
export function formatAsPlainText(text: string, cols: number): string {
  return reflowSoftWraps(stripAnsi(text), cols).replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '')
}
