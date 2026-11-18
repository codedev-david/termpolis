// The small markdown subset a Lumopolis answer may use: paragraphs, bullet and numbered lists, bold,
// italic, inline code and headings (shown as a bold line). It returns a tree of plain strings that the
// answer panel renders as React nodes; nothing here, nor there, is ever parsed as HTML.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  /** An [E<n>] evidence marker: `v` is the label, `E<n>`. */
  | { t: 'marker'; v: string }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }

export type Block = { type: 'p'; lines: Inline[][] } | { type: 'ul' | 'ol'; items: Inline[][] }

const CODE = /`([^`\n]+)`/g
// A marker, **bold**, __bold__, *italic* or _italic_. Italic text neither starts nor ends with a space
// (so `2 * 3` stays as it is), and underscores inside a word (snake_case) are not italic.
const SPAN = /\[(E\d+)\]|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\s](?:[^*\n]*?[^*\s])?)\*|(?<!\w)_([^_\s](?:[^_\n]*?[^_\s])?)_(?!\w)/g
const UL = /^\s*[-*+]\s+(.*)$/
const OL = /^\s*\d+[.)]\s+(.*)$/
const HEADING = /^#{1,6}\s+(.*)$/

function spans(s: string): Inline[] {
  const out: Inline[] = []
  let at = 0
  for (const m of s.matchAll(SPAN)) {
    const i = m.index as number
    if (i > at) out.push({ t: 'text', v: s.slice(at, i) })
    const bold = m[2] ?? m[3]
    if (m[1] !== undefined) out.push({ t: 'marker', v: m[1] })
    else if (bold !== undefined) out.push({ t: 'b', c: spans(bold) })
    else out.push({ t: 'i', c: spans(m[4] ?? m[5]) })
    at = i + m[0].length
  }
  if (at < s.length) out.push({ t: 'text', v: s.slice(at) })
  return out
}

/** One line's inline nodes. Code spans come first, so nothing inside backticks is bold or italic. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  let at = 0
  for (const m of s.matchAll(CODE)) {
    const i = m.index as number
    out.push(...spans(s.slice(at, i)), { t: 'code', v: m[1] })
    at = i + m[0].length
  }
  out.push(...spans(s.slice(at)))
  return out
}

/** The answer text as blocks. A blank line ends a block; an indented line after a list item continues it. */
export function parseAnswerMarkdown(text: string): Block[] {
  const blocks: Block[] = []
  let cur: Block | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line.trim() === '') {
      cur = null
      continue
    }
    const ul = UL.exec(line)
    const item = ul ?? OL.exec(line)
    if (item) {
      const type = ul ? 'ul' : 'ol'
      if (cur === null || cur.type !== type) {
        cur = { type, items: [] }
        blocks.push(cur)
      }
      ;(cur as { items: Inline[][] }).items.push(parseInline(item[1]))
      continue
    }
    if (cur !== null && cur.type !== 'p' && /^\s/.test(line)) {
      cur.items[cur.items.length - 1].push({ t: 'text', v: ' ' }, ...parseInline(line.trim()))
      continue
    }
    const heading = HEADING.exec(line)
    const inline: Inline[] = heading ? [{ t: 'b', c: parseInline(heading[1]) }] : parseInline(line.trim())
    if (cur === null || cur.type !== 'p') {
      cur = { type: 'p', lines: [] }
      blocks.push(cur)
    }
    cur.lines.push(inline)
  }
  return blocks
}
