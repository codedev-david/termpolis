import { describe, it, expect } from 'vitest'
import {
  toMessageHtml,
  formatAsMessageHtmlFromTerm,
  formatAsMessagePlainTextFromTerm,
  reflowForMessage,
  type TerminalLike,
} from '../../src/renderer/src/lib/exportTerminal'

// The "Copy for Teams/Slack" message form. The three prior attempts shipped a
// <pre><code> code box; these tests pin the behavior that actually makes a chat
// message paste correctly: unboxed monospace, <br> newlines, &nbsp; for
// significant whitespace, emojis intact, and NO code-box markup.
describe('toMessageHtml — Teams/Slack message form', () => {
  it('wraps output in an unboxed monospace span (never a code box)', () => {
    const html = toMessageHtml('hello')
    expect(html).toBe(
      '<span style="font-family:Consolas,Menlo,Monaco,\'Courier New\',monospace">hello</span>',
    )
    expect(html).not.toContain('<pre')
    expect(html).not.toContain('<code')
    expect(html).not.toContain('background')
    expect(html).not.toContain('border')
  })

  it('turns newlines into <br>, never <p>/<div> paragraph tags (the "hard returns" bug)', () => {
    const html = toMessageHtml('a\nb\nc')
    expect(html).toContain('a<br>b<br>c')
    expect(html).not.toContain('<p>')
    expect(html).not.toContain('<div>')
  })

  it('preserves an internal blank line as an empty <br> segment', () => {
    expect(toMessageHtml('a\n\nb')).toContain('a<br><br>b')
  })

  it('encodes leading indentation as &nbsp;', () => {
    expect(toMessageHtml('  indented')).toContain('&nbsp;&nbsp;indented')
  })

  it('encodes runs of 2+ interior spaces as &nbsp; (column gaps) but keeps single spaces breakable', () => {
    const html = toMessageHtml('col1    col2 word')
    expect(html).toContain('col1&nbsp;&nbsp;&nbsp;&nbsp;col2') // 4-space gap preserved
    expect(html).toContain('col2 word') // single space stays a normal (wrappable) space
  })

  it('HTML-escapes &, <, > and never double-escapes an inserted &nbsp;', () => {
    const html = toMessageHtml('  a & b <c>')
    expect(html).toContain('&nbsp;&nbsp;a &amp; b &lt;c&gt;')
    expect(html).not.toContain('&amp;nbsp;')
  })

  it('passes emojis through as literal unicode', () => {
    const html = toMessageHtml('deploy ✅ done 🚀')
    expect(html).toContain('✅')
    expect(html).toContain('🚀')
  })

  it('expands tabs to spaces so alignment survives', () => {
    // tab -> 4 spaces -> a run of 4 -> 4 &nbsp;
    expect(toMessageHtml('a\tb')).toContain('a&nbsp;&nbsp;&nbsp;&nbsp;b')
  })
})

describe('formatAsMessageHtmlFromTerm', () => {
  // Minimal fake: no selection range, so the extractor falls back to
  // getSelection() — enough to exercise ANSI stripping + message HTML.
  function fakeTerm(text: string): TerminalLike {
    return {
      cols: 80,
      getSelection: () => text,
      getSelectionPosition: () => undefined,
      buffer: { active: { getLine: () => undefined } },
    }
  }

  it('produces message-form HTML from a live selection with ANSI stripped', () => {
    const html = formatAsMessageHtmlFromTerm(fakeTerm('\x1b[32mgreen\x1b[0m ✅'))
    expect(html).toContain('green ✅')
    expect(html).not.toContain('\x1b')
    expect(html).not.toContain('<pre')
    expect(html.startsWith('<span style="font-family:')).toBe(true)
  })
})

// =====================================================
// reflowForMessage — un-wrap an AGENT'S own word-wrapping.
// Agent TUIs (Claude Code, Codex, Gemini — all Ink-based) wrap their
// output to the pane width themselves, committing each visual line with a real
// newline, so xterm never flags the continuation `isWrapped` and the extractor
// can't rejoin them. Pasting into a Teams/Slack MESSAGE then shows a hard break
// mid-sentence. This reflow un-wraps prose back into one logical line per
// paragraph, using a word-boundary test (would the next row's first word have
// fit on the previous row?) so genuinely short lines — code, table rows, lists —
// are left alone. The user copies 100% agent output, so this is the common case.
// =====================================================
describe('reflowForMessage', () => {
  it('rejoins a width-wrapped agent paragraph into one logical line', () => {
    // Three rows the way Claude Code paints one sentence at a 70-col pane: the
    // first two run to the wrap edge, the third ends short.
    const lines = [
      '- If what you paste is one clean line but Teams still breaks',
      '  it then the payload is fine and the fix is a completely',
      '  different one (and I would stop touching exportTerminal.ts).',
    ]
    const out = reflowForMessage(lines, 62)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('exportTerminal.ts')
    expect(out[0]).not.toMatch(/\S {2,}\S/) // no interior indent leaked into the join
    expect(out[0].startsWith('- ')).toBe(true) // bullet marker kept
  })

  it('leaves genuinely short separate lines alone (no over-joining)', () => {
    // e.g. a short list an agent printed — each line ends well short of the pane,
    // so the next line was NOT a wrap of it.
    const lines = ['file1.txt', 'file2.txt', 'file3.txt']
    expect(reflowForMessage(lines, 80)).toEqual(['file1.txt', 'file2.txt', 'file3.txt'])
  })

  it('preserves blank-line paragraph breaks', () => {
    const lines = [
      'This first paragraph is wrapped by the agent right up to the',
      'edge of the pane and continues here.',
      '',
      'Second paragraph.',
    ]
    const out = reflowForMessage(lines, 60)
    expect(out).toEqual([
      'This first paragraph is wrapped by the agent right up to the edge of the pane and continues here.',
      '',
      'Second paragraph.',
    ])
  })

  it('starts a new line at a list item even when the previous row was full', () => {
    const lines = [
      '- first bullet that runs right up to the wrapping edge here',
      '- second bullet',
    ]
    const out = reflowForMessage(lines, 60)
    expect(out).toHaveLength(2)
    expect(out[1]).toBe('- second bullet')
  })

  it('preserves an agent code block (short lines are not reflowed away)', () => {
    const lines = ['Here is the fix:', '    const x = reflow(lines)', '    return x']
    expect(reflowForMessage(lines, 100)).toEqual([
      'Here is the fix:',
      '    const x = reflow(lines)',
      '    return x',
    ])
  })
})

// End-to-end through the message formatters with a fake TUI buffer (isWrapped
// false on every row — exactly what an agent produces).
describe('message formatters reflow agent output end-to-end', () => {
  function tuiTerm(rows: string[], cols: number): TerminalLike {
    return {
      cols,
      getSelection: () => rows.join('\n'),
      getSelectionPosition: () => ({ start: { x: 0, y: 0 }, end: { x: cols, y: rows.length - 1 } }),
      buffer: {
        active: {
          getLine: (y: number) =>
            rows[y] === undefined
              ? undefined
              : {
                  isWrapped: false, // agent TUI: continuation rows are NOT flagged
                  translateToString: (_trim?: boolean, start = 0, end = cols) => rows[y].slice(start, end),
                },
        },
      },
    }
  }

  const wrapped = [
    'The scroll fix shipped in v1.22.6 and now the copy for Teams',
    'stops adding hard returns in the middle of a wrapped sentence.',
  ]

  it('formatAsMessagePlainTextFromTerm joins the wrapped rows into one line', () => {
    const out = formatAsMessagePlainTextFromTerm(tuiTerm(wrapped, 60))
    expect(out.split('\n')).toHaveLength(1)
    expect(out).toContain('v1.22.6 and now the copy for Teams stops adding')
  })

  it('formatAsMessageHtmlFromTerm emits no <br> inside a single reflowed paragraph', () => {
    const html = formatAsMessageHtmlFromTerm(tuiTerm(wrapped, 60))
    expect(html).not.toContain('<br>')
    expect(html).toContain('stops adding hard returns')
  })
})
