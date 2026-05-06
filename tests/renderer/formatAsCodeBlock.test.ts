import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  reflowSoftWraps,
  formatAsCodeBlock,
  formatAsCodeBlockHtml,
  formatAsPlainText,
  stripAnsi,
  writeCodeBlockToClipboard,
  extractSelectionWithLogicalNewlines,
  formatAsCodeBlockFromTerm,
  formatAsCodeBlockHtmlFromTerm,
  formatAsPlainTextFromTerm,
  writeCodeBlockToClipboardFromTerm,
  type TerminalLike,
} from '../../src/renderer/src/lib/exportTerminal'

// Tiny fake terminal builder for the buffer-aware extractor. Each row is
// either a string (logical line, or part of one if isWrapped is set on the
// next row) or a tuple [text, isWrapped]. The fake honors slicing by
// startColumn/endColumn the same way xterm.js does.
function makeFakeTerm(rows: Array<string | [string, boolean]>, opts?: {
  cols?: number
  selectFrom?: { x: number; y: number }
  selectTo?: { x: number; y: number }
}): TerminalLike {
  const cols = opts?.cols ?? 80
  const lines = rows.map(r => {
    const [text, isWrapped] = Array.isArray(r) ? r : [r, false]
    return {
      isWrapped,
      translateToString(trimRight?: boolean, startColumn = 0, endColumn = cols): string {
        let s = text.slice(startColumn, endColumn)
        if (trimRight) s = s.replace(/\s+$/, '')
        return s
      },
    }
  })
  const range = opts?.selectFrom && opts?.selectTo
    ? { start: opts.selectFrom, end: opts.selectTo }
    : { start: { x: 0, y: 0 }, end: { x: cols, y: rows.length - 1 } }
  return {
    cols,
    getSelection: () => 'fallback',
    getSelectionPosition: () => range,
    buffer: { active: { getLine: (y: number) => lines[y] } },
  }
}

describe('reflowSoftWraps', () => {
  it('joins lines that exactly fill the terminal width (treated as soft-wrap)', () => {
    const cols = 20
    const physical = 'a'.repeat(20) + '\n' + 'b'.repeat(6)
    expect(reflowSoftWraps(physical, cols)).toBe('a'.repeat(20) + 'b'.repeat(6))
  })

  it('preserves logical newlines (lines shorter than cols)', () => {
    const cols = 20
    const text = 'short\nline\nhere'
    expect(reflowSoftWraps(text, cols)).toBe('short\nline\nhere')
  })

  it('handles a mix of soft and hard wraps', () => {
    const cols = 20
    // First physical line: 20 chars (soft wrap), continuation, hard newline,
    // then another short line.
    const physical = 'a'.repeat(20) + '\n' + 'rest!' + '\n' + 'next'
    expect(reflowSoftWraps(physical, cols)).toBe('a'.repeat(20) + 'rest!\nnext')
  })

  it('returns input untouched when cols is invalid or below threshold', () => {
    expect(reflowSoftWraps('abc\ndef', 0)).toBe('abc\ndef')
    expect(reflowSoftWraps('abc\ndef', 5)).toBe('abc\ndef') // < 20 threshold
    expect(reflowSoftWraps('abc\ndef', 19)).toBe('abc\ndef')
  })

  it('preserves trailing buffer when input ends mid-soft-wrap', () => {
    const cols = 20
    const physical = 'a'.repeat(20) + '\n' + 'tail'
    expect(reflowSoftWraps(physical, cols)).toBe('a'.repeat(20) + 'tail')
  })
})

describe('formatAsCodeBlock', () => {
  it('strips ANSI, reflows soft-wraps, and wraps in triple backticks with text language hint', () => {
    const cols = 20
    const ansi = '\x1b[31m' + 'a'.repeat(20) + '\x1b[0m\nrest'
    const out = formatAsCodeBlock(ansi, cols)
    expect(out).toBe('```text\n' + 'a'.repeat(20) + 'rest\n```')
  })

  it('trims leading/trailing blank lines inside the fence', () => {
    const cols = 80
    const text = '\n\nhello\n\n'
    const out = formatAsCodeBlock(text, cols)
    expect(out).toBe('```text\nhello\n```')
  })

  it('strips trailing whitespace per line (xterm padding)', () => {
    const cols = 80
    const text = 'hello   \nworld\t\t'
    const out = formatAsCodeBlock(text, cols)
    expect(out).toBe('```text\nhello\nworld\n```')
  })

  it('handles empty input gracefully', () => {
    expect(formatAsCodeBlock('', 80)).toBe('```text\n\n```')
  })

  it('uses the text language hint to suppress Teams/Slack auto-detect', () => {
    expect(formatAsCodeBlock('SELECT 1', 80).startsWith('```text')).toBe(true)
  })
})

describe('formatAsCodeBlockHtml', () => {
  it('wraps cleaned content in <pre><code> with monospace styling', () => {
    const html = formatAsCodeBlockHtml('hello\nworld', 80)
    expect(html).toContain('<pre')
    expect(html).toContain('<code>hello\nworld</code>')
    expect(html).toContain('white-space:pre')
    expect(html).toContain('font-family:Consolas')
  })

  it('escapes HTML special characters', () => {
    const html = formatAsCodeBlockHtml('<script>&"', 80)
    expect(html).toContain('&lt;script&gt;&amp;"')
    expect(html).not.toContain('<script>')
  })

  it('strips ANSI before escaping', () => {
    const html = formatAsCodeBlockHtml('\x1b[31mfoo\x1b[0m', 80)
    expect(html).toContain('<code>foo</code>')
    expect(html).not.toContain('\x1b')
  })
})

describe('writeCodeBlockToClipboard', () => {
  const originalClipboard = navigator.clipboard
  const originalClipboardItem = (window as unknown as { ClipboardItem?: unknown }).ClipboardItem

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: vi.fn().mockResolvedValue(undefined), writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
    ;(window as unknown as { ClipboardItem?: unknown }).ClipboardItem = originalClipboardItem
  })

  it('writes both text/html and text/plain when ClipboardItem is available', async () => {
    class FakeClipboardItem {
      constructor(public readonly types: Record<string, Blob>) {}
    }
    ;(window as unknown as { ClipboardItem: typeof FakeClipboardItem }).ClipboardItem = FakeClipboardItem
    await writeCodeBlockToClipboard('hello', 80)
    const writeMock = navigator.clipboard.write as unknown as ReturnType<typeof vi.fn>
    expect(writeMock).toHaveBeenCalledTimes(1)
    const items = writeMock.mock.calls[0][0] as FakeClipboardItem[]
    expect(Object.keys(items[0].types).sort()).toEqual(['text/html', 'text/plain'])
  })

  it('falls back to writeText when ClipboardItem is missing', async () => {
    delete (window as unknown as { ClipboardItem?: unknown }).ClipboardItem
    await writeCodeBlockToClipboard('hello', 80)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('```text\nhello\n```')
  })

  it('falls back to writeText when clipboard.write rejects', async () => {
    class FakeClipboardItem {
      constructor(public readonly types: Record<string, Blob>) {}
    }
    ;(window as unknown as { ClipboardItem: typeof FakeClipboardItem }).ClipboardItem = FakeClipboardItem
    ;(navigator.clipboard.write as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('blocked'))
    await writeCodeBlockToClipboard('hello', 80)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('```text\nhello\n```')
  })

  it('HTML blob contains <pre><code> with monospace styling so Teams/Outlook render a real code box', async () => {
    class FakeClipboardItem {
      constructor(public readonly types: Record<string, Blob>) {}
    }
    ;(window as unknown as { ClipboardItem: typeof FakeClipboardItem }).ClipboardItem = FakeClipboardItem
    await writeCodeBlockToClipboard('echo hello\nworld', 80)
    const writeMock = navigator.clipboard.write as unknown as ReturnType<typeof vi.fn>
    const item = writeMock.mock.calls[0][0][0] as FakeClipboardItem
    const htmlBlob = item.types['text/html']
    const html = await htmlBlob.text()
    expect(html).toContain('<pre')
    expect(html).toContain('<code>')
    expect(html).toContain('Consolas')
    expect(html).toContain('white-space:pre')
    expect(html).toContain('echo hello')
    expect(html).toContain('world')
  })

  it('plain blob uses ```text fence (not bare ```) so Teams skips SQL auto-detect', async () => {
    class FakeClipboardItem {
      constructor(public readonly types: Record<string, Blob>) {}
    }
    ;(window as unknown as { ClipboardItem: typeof FakeClipboardItem }).ClipboardItem = FakeClipboardItem
    await writeCodeBlockToClipboard('SELECT * FROM x', 80)
    const writeMock = navigator.clipboard.write as unknown as ReturnType<typeof vi.fn>
    const item = writeMock.mock.calls[0][0][0] as FakeClipboardItem
    const plainBlob = item.types['text/plain']
    const plain = await plainBlob.text()
    expect(plain.startsWith('```text\n')).toBe(true)
    expect(plain.endsWith('\n```')).toBe(true)
    expect(plain).toContain('SELECT * FROM x')
  })

  it('escapes <, >, & in HTML so terminal output containing tags renders as text', async () => {
    class FakeClipboardItem {
      constructor(public readonly types: Record<string, Blob>) {}
    }
    ;(window as unknown as { ClipboardItem: typeof FakeClipboardItem }).ClipboardItem = FakeClipboardItem
    await writeCodeBlockToClipboard('<script>alert("xss")</script> & co', 80)
    const writeMock = navigator.clipboard.write as unknown as ReturnType<typeof vi.fn>
    const item = writeMock.mock.calls[0][0][0] as FakeClipboardItem
    const html = await (item.types['text/html']).text()
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
    expect(html).not.toContain('<script>alert')
  })
})

describe('formatAsPlainText', () => {
  it('strips ANSI and reflows without fencing', () => {
    const cols = 80
    const text = '\x1b[32mhello world\x1b[0m'
    expect(formatAsPlainText(text, cols)).toBe('hello world')
  })

  it('does not produce backticks', () => {
    const out = formatAsPlainText('a\nb', 80)
    expect(out).not.toContain('```')
  })
})

describe('stripAnsi (sanity)', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\x1b[31mfoo\x1b[0m')).toBe('foo')
  })
  it('removes OSC sequences with BEL terminator', () => {
    expect(stripAnsi('\x1b]0;title\x07hi')).toBe('hi')
  })
})

// =====================================================
// Buffer-aware variants — the real Teams paste fix lives here.
// reflowSoftWraps' cols-length heuristic misfires whenever xterm trims
// trailing whitespace off a wrapped line; these tests use the wrap flag
// directly the way xterm exposes it on each BufferLine.
// =====================================================

describe('extractSelectionWithLogicalNewlines', () => {
  it('joins physically-wrapped lines into one logical line (the Teams fix)', () => {
    // Three terminal rows that real xterm would produce for one logical
    // command on a 30-column terminal. Row 0 fills exactly cols chars; rows
    // 1 and 2 are flagged isWrapped because they continue from row 0.
    const term = makeFakeTerm([
      'echo this is a long command t', // 29 chars then a space → 30
      ['hat wraps across the terminal', true],
      [' width', true],
    ], {
      cols: 30,
      selectFrom: { x: 0, y: 0 },
      selectTo: { x: 30, y: 2 },
    })
    const out = extractSelectionWithLogicalNewlines(term)
    expect(out.split('\n').length).toBe(1)
    expect(out).toContain('echo this is a long command')
    expect(out).toContain('terminal')
  })

  it('preserves logical newlines (lines whose successor is not wrapped)', () => {
    const term = makeFakeTerm([
      'first line',
      'second line',
      'third line',
    ], {
      cols: 80,
      selectFrom: { x: 0, y: 0 },
      selectTo: { x: 80, y: 2 },
    })
    const out = extractSelectionWithLogicalNewlines(term)
    expect(out.split('\n')).toEqual(['first line', 'second line', 'third line'])
  })

  it('preserves the inter-word space at a soft-wrap boundary (no smushed words)', () => {
    // Real xterm symptom: a wrap boundary that lands on a space gets that
    // trailing space stripped by translateToString(true). The extractor
    // disables trim on lines whose successor isWrapped, so words don't fuse.
    const term = makeFakeTerm([
      'abcd efgh ', // 10 chars, last is a space — cols-filled
      ['ijklmnop', true],
    ], {
      cols: 10,
      selectFrom: { x: 0, y: 0 },
      selectTo: { x: 10, y: 1 },
    })
    expect(extractSelectionWithLogicalNewlines(term)).toBe('abcd efgh ijklmnop')
  })

  it('handles a mix of soft and hard wraps without misclassifying', () => {
    const term = makeFakeTerm([
      'aaabbbcccd',           // 10 chars, no continuation
      'eee fff ggg',          // exactly cols chars but next not wrapped
      'partone is ',          // soft-wrap, continues below
      ['parttwo', true],
      'standalone',
    ], {
      cols: 11,
      selectFrom: { x: 0, y: 0 },
      selectTo: { x: 11, y: 4 },
    })
    const out = extractSelectionWithLogicalNewlines(term)
    expect(out.split('\n')).toEqual([
      'aaabbbcccd',
      'eee fff ggg',
      'partone is parttwo',
      'standalone',
    ])
  })

  it('honors x bounds on the first and last selection rows', () => {
    // end.x is exclusive (xterm.js convention), so end x=3 means the first
    // 3 chars of the last row are included.
    const term = makeFakeTerm([
      'aaabbbccc',
      'dddeeefff',
    ], {
      cols: 80,
      selectFrom: { x: 3, y: 0 },
      selectTo: { x: 3, y: 1 },
    })
    expect(extractSelectionWithLogicalNewlines(term)).toBe('bbbccc\nddd')
  })

  it('falls back to getSelection() when the terminal has no range', () => {
    const term: TerminalLike = {
      cols: 80,
      getSelection: () => 'fallback text',
      getSelectionPosition: () => undefined,
      buffer: { active: { getLine: () => undefined } },
    }
    expect(extractSelectionWithLogicalNewlines(term)).toBe('fallback text')
  })

  it('does not split a logical line that happens to be exactly cols long', () => {
    // Cols-heuristic in reflowSoftWraps would have merged the next line into
    // this one — the buffer-aware extractor relies on isWrapped, so a
    // standalone cols-length line stays intact.
    const term = makeFakeTerm([
      'x'.repeat(20), // len === cols, but next line not wrapped
      'next',
    ], {
      cols: 20,
      selectFrom: { x: 0, y: 0 },
      selectTo: { x: 20, y: 1 },
    })
    expect(extractSelectionWithLogicalNewlines(term)).toBe('x'.repeat(20) + '\nnext')
  })
})

describe('formatAsCodeBlockFromTerm / formatAsPlainTextFromTerm', () => {
  it('produces a fenced markdown block with logical newlines preserved', () => {
    // Row 0 fills exactly cols (30 chars) ending in a space — that trailing
    // space IS the inter-word boundary at the wrap point and must survive
    // the join. Row 2 stands alone and produces a hard newline in the output.
    const term = makeFakeTerm([
      'echo this is the soft-wrapped ', // 30 chars ending in space
      ['command goes here', true],
      'next prompt',
    ], { cols: 30, selectFrom: { x: 0, y: 0 }, selectTo: { x: 30, y: 2 } })
    const out = formatAsCodeBlockFromTerm(term)
    expect(out.startsWith('```text\n')).toBe(true)
    expect(out.endsWith('\n```')).toBe(true)
    // Soft-wrap collapsed; hard newline preserved.
    expect(out.split('\n')).toEqual([
      '```text',
      'echo this is the soft-wrapped command goes here',
      'next prompt',
      '```',
    ])
  })

  it('escapes HTML metacharacters in the rich-text form', () => {
    const term = makeFakeTerm([
      '<script>alert(1)</script>',
    ], { cols: 80 })
    const html = formatAsCodeBlockHtmlFromTerm(term)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert')
  })

  it('plain-text form has no markdown fence', () => {
    const term = makeFakeTerm(['hello world'], { cols: 80 })
    expect(formatAsPlainTextFromTerm(term)).toBe('hello world')
    expect(formatAsPlainTextFromTerm(term)).not.toContain('```')
  })
})

describe('writeCodeBlockToClipboardFromTerm', () => {
  const originalClipboard = navigator.clipboard
  const originalClipboardItem = (window as unknown as { ClipboardItem?: unknown }).ClipboardItem

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: vi.fn().mockResolvedValue(undefined), writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
    ;(window as unknown as { ClipboardItem?: unknown }).ClipboardItem = originalClipboardItem
  })

  it('writes BOTH text/html and text/plain when ClipboardItem is available', async () => {
    class FakeClipboardItem {
      constructor(public readonly types: Record<string, Blob>) {}
    }
    ;(window as unknown as { ClipboardItem: typeof FakeClipboardItem }).ClipboardItem = FakeClipboardItem

    const term = makeFakeTerm([
      'soft wrap ',
      ['continues here', true],
    ], { cols: 30, selectFrom: { x: 0, y: 0 }, selectTo: { x: 30, y: 1 } })

    await writeCodeBlockToClipboardFromTerm(term)
    const writeMock = navigator.clipboard.write as unknown as ReturnType<typeof vi.fn>
    expect(writeMock).toHaveBeenCalledTimes(1)
    const item = writeMock.mock.calls[0][0][0] as FakeClipboardItem
    expect(Object.keys(item.types).sort()).toEqual(['text/html', 'text/plain'])
    const html = await item.types['text/html'].text()
    const plain = await item.types['text/plain'].text()
    expect(html).toContain('soft wrap continues here')
    expect(plain).toContain('soft wrap continues here')
    expect(plain.startsWith('```text\n')).toBe(true)
  })

  it('falls back to plain-text writeText when ClipboardItem is missing', async () => {
    const term = makeFakeTerm(['hello'], { cols: 80 })
    await writeCodeBlockToClipboardFromTerm(term)
    const wt = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>
    expect(wt).toHaveBeenCalledTimes(1)
    expect((wt.mock.calls[0][0] as string).startsWith('```text\nhello')).toBe(true)
  })
})
