export interface CompactTextOpts { headLines: number; tailLines: number; maxChars: number }

export function compactText(s: string, opts: CompactTextOpts): { text: string; elided: boolean } {
  let elided = false

  // 1) Collapse runs of identical consecutive lines (log spam).
  const rawLines = s.split('\n')
  const collapsed: string[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]
    let run = 1
    while (i + 1 < rawLines.length && rawLines[i + 1] === line) { run++; i++ }
    collapsed.push(line)
    if (run > 1) { collapsed.push(`… (×${run - 1} identical lines)`); elided = true }
  }

  // 2) Head/tail window if still over budget (by line count or chars).
  const overLines = collapsed.length > opts.headLines + opts.tailLines
  const joined = collapsed.join('\n')
  if (!overLines && joined.length <= opts.maxChars) {
    return { text: joined, elided }
  }
  const head = collapsed.slice(0, opts.headLines)
  const tail = collapsed.slice(collapsed.length - opts.tailLines)
  const elidedCount = collapsed.length - head.length - tail.length
  const windowed = [...head, `… [${Math.max(0, elidedCount)} lines elided] …`, ...tail].join('\n')
  return { text: windowed, elided: true }
}
