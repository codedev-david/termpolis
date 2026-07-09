import { describe, it, expect } from 'vitest'
import {
  toMessageHtml,
  formatAsMessageHtmlFromTerm,
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
