import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  reflowSoftWraps,
  formatAsCodeBlock,
  formatAsCodeBlockHtml,
  formatAsPlainText,
  stripAnsi,
  writeCodeBlockToClipboard,
} from '../../src/renderer/src/lib/exportTerminal'

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
