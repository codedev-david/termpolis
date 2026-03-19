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
